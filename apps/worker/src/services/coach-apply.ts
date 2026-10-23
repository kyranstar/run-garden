import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  calendarEventSuppressions,
  coachPlanWeeks,
  coachPlans,
  coachProposals,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
  scheduleOverrides,
} from "@rg/database";
import {
  addDays,
  addOpDates,
  appAuthoredRow,
  sessionSummaryLine,
  newId,
  humanizeWorkoutTitle,
  nowInstant,
  paceBandFor,
  sessionExercises,
  sessionSport,
  startOfIsoWeek,
  todayInZone,
  watchAddressOf,
  isRunWatchSession,
  RUN_WATCH_MAX_STEPS,
  runWatchStepCount,
  runWatchSteps,
  type CoachOp,
  type CoachSession,
  type RunWatchSession,
  type RunWire,
  type UserPreferences,
  type WeightUnit,
  type WorkoutDoc,
} from "@rg/domain";
import { runBlockRoles } from "@rg/coros";
import { chunkIds, chunkedInsert, insertBatches, runAtomically, type Db } from "./db.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { coachStamp, recordedStampFor, stampName, takenStampsOn, takenStampsOnDays } from "./coros-stamp.js";
import { applyMove } from "./jobs.js";
import { openIntentFor, recordIntent } from "./sync-intents.js";
import { takesWatchCopy, unmarkedFingerprint, watchCopyBase } from "./watch-copy-marker.js";
import {
  enqueueUnpushIfOurs,
  unpushInsertIfOurs,
  removeFromPlan,
  settleWatchJobsOnArchive,
  settleWatchJobsOnArchiveStatements,
  unskipWorkout,
} from "./plan-mutations.js";
import { resolveRaceConflict } from "./race-conflict.js";
import type { RetimeExpectation, RetimeWrite } from "./adjust-retime.js";
import { isLoosePlan } from "./coach-plans.js";
import {
  docForCoachSession,
  docWithStatedLength,
  newRowDocColumns,
  revisionInsert,
  revisionInserts,
  updateDocColumns,
  withStageTargets,
} from "./workout-doc-store.js";

/**
 * Approval → deterministic mutations (spec §7). No LLM here, ever. All row
 * ids derive from the proposal id, so re-applying (crash, retry, double
 * click) is idempotent. Watch mirroring stays honest: rows the coach
 * creates/rewrites are `calendar_only` until a push lane verifies them
 * (writes-OFF era default; the push generalization rides Task A10+).
 */

/** The applier's words for a length whose card the session no longer matches (its re-time, run again at the tap, finds
 * other steps): the designer's approve refuses it as `changed_since_suggested` (review-L minor 5). */
export const RETIME_CHANGED = "a session it re-times has changed since it was suggested, so it is as it was";

/** The applier's words for a length alone on a session taking the watch's version (review L1): the next read takes the
 * watch's copy whole, its length with it, so a length set now would be undone without a word. The designer's
 * `adjust_plan` refuses it in the same words before it is proposed. */
export const FOLLOWS_WATCH_VERSION = "this session follows the watch's version until the next sync — change it after that";

export interface ApplyResult {
  created: string[];
  updated: string[];
  archived: string[];
  /**
   * Ops that promised a mutation and performed NONE — in the athlete's words,
   * for the receipt (2026-08-17).
   *
   * The last silent failure in this pipeline lived here: `retirePlan` against
   * a plan id with no `coach_plans` row returned `{created:[],updated:[],
   * archived:[]}` with no throw and no violation, so the athlete tapped
   * approve and was handed a success receipt for nothing. The guardrails
   * cannot catch it — they read the plan ids that existed at WAKE time, and
   * the row can go between the wake and the tap — so the truth has to travel
   * out of the apply itself.
   *
   * Not a throw: the other ops in the proposal have already been performed by
   * then, and a 500 would tell the athlete nothing happened when most of it
   * did. Empty on every ordinary apply.
   */
  missed: string[];
  /**
   * The earliest date <= today that an op resolved, archived or restored — the
   * caller resimulates the garden from here. Null when no op reached back.
   */
  resimFrom: string | null;
}

function fingerprint(v: unknown): string {
  const s = JSON.stringify(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `coach-${(h >>> 0).toString(16)}`;
}

/**
 * THE STORED SUMMARY IS THE MANIFEST'S OWN STRING (2026-08-17).
 *
 * This used to be its own renderer, and it was the third of three: the approval
 * card's `describeOps`, this, and `summarizeStages` for the session sheet — three
 * functions a person could see within one tap of each other. Its private distance
 * formatter, `(m/1000).toFixed(1) + "km"`, is why a 400 m rep was STORED as
 * "0.4km" and therefore read that way on Today, in the week list, and in the
 * `contains:` line the coach's dossier quotes back to the model, while the sheet
 * one tap below said "400 m".
 *
 * `sessionSummaryLine` is now that one renderer (@rg/domain), and the manifest is
 * literally the same call — byte-identical by construction rather than by two
 * formatters being kept in step. The empty-body fallback to the title lives there
 * too, for the same reason it lived here: an empty exercise list and an absent one
 * parse alike, so they must read alike.
 */
function stageSummary(s: CoachSession): string {
  return sessionSummaryLine(s);
}

/**
 * Meters this session PRESCRIBES — only when it says so. Duration blocks state
 * no distance, so a session built of them has none, and `null` is the honest
 * answer rather than the distance of whatever the row used to hold.
 *
 * Not cosmetic: `providers/matching.ts` scores a finished activity against this
 * number. A 35-minute easy run still carrying the 11 km of the interval session
 * it replaced fails its own completion match by a factor of two.
 */
function plannedDistanceMeters(session: CoachSession): number | null {
  if (!session.run) return null;
  const meters = session.run.blocks
    .filter((b) => b.kind === "distance")
    .reduce((sum, b) => sum + b.value, 0);
  return meters > 0 ? meters : null;
}

/**
 * EVERY `planned_workouts` column a `CoachSession` determines — the one place
 * that answers "what does this session make the row say".
 *
 * It exists because `ease` and `add` used to answer it separately. `add`
 * inserted a whole row; `ease` updated a hand-written list of seven columns and
 * left the rest holding the PREVIOUS session's facts. On a live row that read
 * as: title "Easy first run back", stage_summary "35min easy", block 35min —
 * beside seven untouched stage rows prescribing 6 × 643 m at 4:49/km, an
 * `expected_distance_meters` of 11104.52 and a `source_estimated_duration_
 * seconds` of 4509. The session sheet showed the intervals (it prefers the
 * summary derived from stage rows), the plan card said 75 minutes, and Google
 * Calendar booked 100. The ease relabelled the session without changing it.
 *
 * One writer, so a column added for one caller cannot be missed by the other.
 * Callers add only what a session CANNOT know: its id, its date, its plan.
 *
 * The nulls are deliberate, not omissions:
 *
 *  - `qualitySubtype` — the coach vocabulary has no subtype field, so any value
 *    here is a classification of the workout this row USED to hold.
 *    `humanizeWorkoutTitle` re-titles a code-titled `quality` row from it, so a
 *    surviving "tempo" can rename an eased session all by itself.
 *  - `sourceEstimatedDurationSeconds` — COROS's estimate for the old body.
 *    Every duration consumer reads `source ?? fallback`, so leaving it set is
 *    what made the calendar block and the plan card ignore the ease entirely.
 *  - `durationEstimate` — the estimator's own output. There is none here: the
 *    coach's stated duration IS the estimate (audit#2 #15), and the DTO's
 *    `estimateSource` should say nothing rather than name a run of the
 *    estimator that described different content.
 *
 * `sourceVersion` is deliberately NOT in this list. It records the version of
 * COROS's copy, which a local ease does not change, and `jobs.ts` uses it as a
 * move job's optimistic-concurrency check. Clearing it would blind that check.
 *
 * NEITHER IS `sourceContentFingerprint`, AND FOR THE SAME REASON — which took
 * the imported-convergence work to notice (2026-08-17). That column means "the
 * UPSTREAM copy as the app last observed it": import writes it from the
 * snapshot, and the write consumer re-stamps it with the wire's own fingerprint
 * after a verified push. An `ease` changes the APP's copy and by definition not
 * COROS's, so writing `fingerprint(session)` here put a hash of the local edit
 * into a column that is a statement about the remote one.
 *
 * That was not cosmetic. It is the fact the second ownership proof re-reads
 * (`ownershipProofFor`), so every eased imported row destroyed its own evidence
 * at the moment it created the need for it — the two live rows of 17 and 22 Aug
 * hold a `coach-…` hash of the eased session where the import's wire fingerprint
 * should be. It also made import rule 7's drift test permanently true for eased
 * rows, which only ever went unnoticed because the content-intent exception is
 * checked first.
 *
 * `insertSession` still seeds the column (it is NOT NULL and a brand-new row has
 * no upstream copy yet); the create's verify replaces the seed with the wire's
 * own fingerprint the moment one exists.
 */
export function sessionColumns(session: CoachSession) {
  const body = session.lift ?? session.mobility;
  return {
    title: session.title,
    category: session.category,
    qualitySubtype: null,
    sport: sessionSport(session),
    sourceEstimatedDurationSeconds: null,
    // The coach's own stated duration IS the estimate — without this every
    // consumer fell back to a fictitious 45 minutes (audit#2 #15).
    fallbackEstimatedDurationSeconds: session.durationMinutes * 60,
    calendarBlockDurationSeconds: session.durationMinutes * 60,
    durationEstimate: null,
    expectedDistanceMeters: plannedDistanceMeters(session),
    stageSummary: stageSummary(session),
    // Lift/mobility structure survives apply (rework spec §5): the exercises
    // array is what lets plan-detail graph a coached progression AND what
    // tells the session sheet which movements the watch's catalog doesn't
    // know; the flattened stageSummary above stays as the display string.
    // `rounds` rides along so a circuit still reads as a circuit after a round
    // trip.
    //
    // `null` for a run or a bodyless session is the load-bearing half: the DTO
    // renders `exercises` in PREFERENCE to `stageSummary`, so a lift eased into
    // a jog kept showing the lift's movement list as its prescription.
    structuredJson: body
      ? {
          exercises: sessionExercises(session),
          ...(body.rounds ? { rounds: body.rounds } : {}),
        }
      : null,
    corosSyncState: "calendar_only",
  };
}

/**
 * The session's stage rows, replacing whatever the row held before.
 *
 * The delete is UNCONDITIONAL, and that is the point. Stages are the body of
 * the session, so a run eased into a lift — or into nothing — must lose the
 * run's intervals; leaving them is how `routes/plan.ts` came to render the
 * pre-ease prescription (it passes `summarizeStageRows(stages)` whenever stage
 * rows exist, and that derived string beats the stored `stageSummary`).
 *
 * Stage ids derive from the workout id, so re-applying is idempotent.
 */
export async function writeStages(
  db: Db,
  workoutId: string,
  session: CoachSession,
  thresholdPaceSecPerKm?: number,
): Promise<void> {
  await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, workoutId));
  const stageRows = coachStageRows(workoutId, session, thresholdPaceSecPerKm);
  if (stageRows.length === 0) return;
  await chunkedInsert(stageRows, (batch) => db.insert(plannedWorkoutStages).values(batch));
}

/**
 * The stage rows `writeStages` writes for a session — none for a body, or for a run with no blocks. Pure, so the
 * session's workout document can be made from exactly these rows (their pace bands) before they are written.
 */
export function coachStageRows(workoutId: string, session: CoachSession, thresholdPaceSecPerKm?: number) {
  const blocks = session.run?.blocks ?? [];
  // Structured stages so the app's session detail shows the prescription
  // (incl. pace bands) immediately — a later COROS re-import replaces these
  // with the wire's own truth, which matches because pace round-trips
  // exactly (2026-08-14).
  // ONE DERIVATION FOR WHAT A BLOCK IS, shared with the wire (`runBlockRoles`,
  // create-executor.ts). This used to be its own rule — `i === 0 &&
  // blocks.length >= 2 ? "warmup" : "work"` — which is the positional rule the
  // wire replaced in d52833e, and keeping a second copy of it here meant one
  // session read warm-up/work/recovery/cool-down on the watch and
  // warm-up/work/work/work in its own stage rows. Live effect, all four
  // mislabels: the opening rep of a VO2 session called "Warm up", a walk-back
  // called work, a closing easy block called work, and a single-block session
  // whose one block was work while the same block in a two-block session was a
  // warm-up. The wire's rule reads each block's own intensity, so the app's
  // stage list and the watch's step list cannot disagree — the intent
  // harness's `store_stage_role_is_positional` ledger entry was this bug, and
  // deleting it was the point.
  //
  // ONE EXCEPTION, the app's alone (audit D4, 2026-10-23): an easy FLOAT — the jog between two reps — is stored a
  // recovery. The coach's "recovery", "jog" and "float" all fold onto `easy`, and the wire's rule calls such a block
  // work; an 11-stage quality session stored its four jogs as work, so the coach's plan context read nine work stages
  // and the sheet's Full structure "work — 2 min (easy)". The watch keeps it a "Run" step: a role-4 step would drop the
  // jog's easy band, and no reader of the wire is wrong for it.
  const roles = runBlockRoles(blocks);
  const rows = blocks.map((b, i) => {
    const band = paceBandFor(b.intensity, thresholdPaceSecPerKm);
    return {
      id: `${workoutId}:${i}`,
      workoutId,
      parentStageId: null,
      ord: i,
      kind: roles[i]!,
      repeatCount: null,
      durationType: b.kind === "duration" ? "time" : "distance",
      // A duration block's `value` is MINUTES and no longer has to be whole —
      // "45s" stores as 0.75 so the unit could stay minutes for the three
      // consumers that multiply by 60 (domain/coach.ts). `seconds / 60` is
      // binary-exact for whole minutes and every 5-second step under one, but
      // ~4% of whole seconds (125, 245, 485…) come back 2.3e-13 off. Every
      // reader of this column formats or rounds that away, so nothing is broken
      // — but this is the column, so it is stored exact rather than
      // exact-by-luck-of-the-formatter.
      durationSeconds: b.kind === "duration" ? Math.round(b.value * 60) : null,
      distanceMeters: b.kind === "distance" ? b.value : null,
      targetType: band ? "pace" : "none",
      targetLow: band?.fastSecPerKm ?? null,
      targetHigh: band?.slowSecPerKm ?? null,
      paceZone: null,
      hrZone: null,
      label: b.intensity ?? null,
    };
  });
  const floats = easyFloats(rows);
  return rows.map((r, i) => (r.kind === "work" && floats[i] ? { ...r, kind: "recovery" as const } : r));
}

/** What `easyFloats` reads of a thread-coach run's stage: its label (the block's intensity) and its measure. */
export type FloatStageFields = { label: string | null; durationType: string; durationSeconds: number | null; distanceMeters: number | null };

/**
 * Which of a thread-coach run's stages are EASY FLOATS — the recoveries its words cannot name (review-L minor 3): an
 * easy stage between two pickups (stages neither easy nor rest), and one after a pickup as long as such a float (the
 * last of a written-out set). One rule for the stored kinds (`coachStageRows`) and the re-time's roles (adjust-retime.ts).
 */
export function easyFloats(stages: readonly FloatStageFields[]): boolean[] {
  const n = stages.length;
  const easy = (i: number) => stages[i]?.label === "easy";
  const pickup = (i: number) => i >= 0 && i < n && stages[i]!.label !== "easy" && stages[i]!.label !== "rest";
  const lengthOf = (s: FloatStageFields) => `${s.durationType}:${s.durationSeconds ?? s.distanceMeters}`;
  const float = stages.map((_, i) => easy(i) && pickup(i - 1) && pickup(i + 1));
  const floatLengths = new Set(stages.filter((_, i) => float[i]).map(lengthOf));
  stages.forEach((s, i) => {
    if (easy(i) && pickup(i - 1) && floatLengths.has(lengthOf(s))) float[i] = true;
  });
  return float;
}

/**
 * A session the create executor can put on the watch today.
 *
 *  · A RUN whose blocks are all DURATION-based. Distance targets have not been
 *    spike-verified on this wire and `buildRunProgram` refuses them outright, so
 *    one distance block makes the whole session app-only. Both layers agree.
 *  · A LIFT OR MOBILITY session with a body, every movement of which resolved to
 *    a COROS catalog `originId`.
 *
 * LIFT AND MOBILITY USED TO BE REFUSED HERE, and the stated reason was false.
 * This comment claimed the executor "builds a structured RUN program and nothing
 * else"; `createWorkout` has always dispatched a non-run session to
 * `buildStrengthProgram`, `coros-write-cloud.ts` resolves the ~382-row COROS
 * catalog specifically for that case, and the intent harness pushed all nine
 * lift/mobility fixtures through the real executor and read every one back. The
 * gate was a product decision wearing a protocol limit's clothes — which is
 * worse than either, because the app then told the athlete their strength work
 * *could not* reach the watch.
 *
 * EVERY MOVEMENT, OR NONE. A session where only some movements resolve is a real
 * case and it is refused whole, for two reasons that agree:
 *
 *  1. `buildStrengthProgram` THROWS on the first unresolved `originId` — it will
 *     not write a program the server would reject — so a partial push is not
 *     something the wire offers.
 *  2. It should not. A three-of-five push puts a DIFFERENT session on the watch,
 *     with no way for the watch to say what is missing, and the athlete does 60%
 *     of the prescription believing it whole. That is a silent
 *     under-prescription, the same failure mode as emitting one step for per-side
 *     work — and the app already has an honest, actionable thing to say instead:
 *     `offCatalogExercises` names the movements, and the athlete can rename them
 *     into their COROS library.
 *
 * MOBILITY CROSSES, filed as Strength. COROS's program namespace is 1 Run /
 * 2 Bike / 3 Swim / 4 Strength — there is no mobility or yoga program sport — so
 * `buildStrengthProgram` files a mobility session under Strength on the watch and
 * `wire_mobility_files_as_strength` has declared that as a structural loss since
 * the harness was written. Filing it coarsely and SAYING SO beats suppressing it:
 * the alternative leaves the athlete's mobility work existing nowhere but the app,
 * which is the complaint, not the fix. The app keeps the honest discipline
 * (`sessionSport` → "yoga"); only the watch's own filing is coarse, and
 * `watch-coverage.ts` is where that gets disclosed.
 */
export function watchPushable(session: CoachSession | RunWatchSession, thresholdPaceSecPerKm?: number | null, runWire: RunWire = "v1"): boolean {
  // A DESIGNED RUN (§8 §3): the wire in use can hold its steps (§8 phase 2: v1 writes the repeats out, v2 a group), and
  // every step has what it runs by — on v1 its time, a distance timed at its band's middle, which needs a pace (the
  // threshold's, or one the athlete asked for); on v2 a distance runs as a distance. The same `runWatchSteps` the wire
  // builds from.
  if (isRunWatchSession(session)) {
    if (runWatchStepCount(session.segments, runWire) > RUN_WATCH_MAX_STEPS) return false;
    const r = runWatchSteps(session, thresholdPaceSecPerKm ?? null, runWire);
    return r.steps.length > 0 && r.unresolved === 0;
  }
  if (session.run) {
    return session.run.blocks.length > 0 && session.run.blocks.every((b) => b.kind === "duration");
  }
  const body = session.lift ?? session.mobility;
  if (!body || body.exercises.length === 0) return false;
  return body.exercises.every((e) => !!e.originId);
}

/** `coach_plans.discipline` for the bucket a session belongs in. Mobility
 * gets its own bucket rather than stretching the running plan's dates —
 * `routes/coach.ts` only special-cases "lift", so a mobility plan reads as
 * a generic block (no lift progressions), which is the honest render. */
function planDisciplineOf(session: CoachSession): "run" | "lift" | "mobility" {
  if (session.lift) return "lift";
  if (session.mobility) return "mobility";
  return "run";
}

/** A coach session an op puts on the calendar: its row's id, plan and day. */
interface NewSession {
  id: string;
  planId: string;
  date: string;
  session: CoachSession;
}

/**
 * A session's workout document, with the targets of the very stage rows `writeStages` writes for it (a run's pace
 * bands from the athlete's threshold) — `withStageTargets`, the helper the backfill uses, so a coach run's document is
 * the same whichever wrote it. Never fails the write: the conversion answers null (logged by code), and lending the
 * targets, should it throw, leaves the document as converted.
 */
export function sessionDoc(workoutId: string, session: CoachSession, weightUnit: WeightUnit | undefined, thresholdPaceSecPerKm?: number): WorkoutDoc | null {
  const doc = docForCoachSession(session, { weightUnit });
  try {
    return withStageTargets(doc, coachStageRows(workoutId, session, thresholdPaceSecPerKm));
  } catch {
    return doc;
  }
}

/**
 * A new session's `planned_workouts` row — its insert, skipped on a conflict — and its workout document: the one shape
 * every coach insert writes (`insertSessions`, and a plan's chunk of sessions, §8 §4).
 */
function sessionRowInsert(
  db: Db,
  userId: string,
  { id, planId, date, session }: NewSession,
  now: string,
  opts: { prefs?: UserPreferences; thresholdPaceSecPerKm?: number },
) {
  // Land in the athlete's own slot, not a hardcoded dawn (audit#2 #15) — and
  // in the SAME slot the importer would have chosen, from the one shared
  // window function (`day-placement.ts`), rather than a second hand-rolled copy
  // of the rule. Whether this session can keep that slot, or has to queue up
  // behind what already occupies the day, is settled by `separateDayCollisions`
  // once the whole apply has landed: a coach add on top of a plan session is
  // now the ordinary case, and two 09:00 appointments is not a day.
  const effectiveTime = opts.prefs
    ? windowTimeFor({ category: session.category, date }, opts.prefs)
    : "07:00";
  const doc = sessionDoc(id, session, opts.prefs?.weightUnit, opts.thresholdPaceSecPerKm);
  const insert = db
    .insert(plannedWorkouts)
    .values({
      id,
      userId,
      planId,
      sourceWorkoutId: id,
      originalPlanDate: date,
      // "" = COROS has never verified this row (audit#2 #1): the absence
      // sweep must skip it and the sync pill must not read "synced". The
      // create's verify stamps the real date.
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime,
      completionState: "scheduled",
      createdAt: now,
      updatedAt: now,
      // Everything the SESSION decides — the same writer `ease` uses.
      ...sessionColumns(session),
      // The SEED for a column that is otherwise only ever written by something
      // that has observed COROS. A brand-new row has no upstream copy, so the
      // app's own hash is the only honest placeholder; the create's verify
      // replaces it with the wire's fingerprint as soon as there is one.
      sourceContentFingerprint: fingerprint(session),
      ...newRowDocColumns(doc),
    })
    .onConflictDoNothing();
  return { id, doc, insert };
}

/**
 * The op's new sessions: every row, with its workout document at revision 1, and the revisions of those documents —
 * ONE batch, so the op costs one revision statement however many sessions it adds (Stage 1 dual-write; a rest day has
 * no document, and a conversion that fails is NULL — never a failed apply). A re-apply inserts nothing, so it revises
 * nothing: a revision's id is its row's own. Then each session's stages and its watch write, in order.
 */
async function insertSessions(
  db: Db,
  userId: string,
  sessions: readonly NewSession[],
  now: string,
  opts: { corosWritesEnabled?: boolean; prefs?: UserPreferences; thresholdPaceSecPerKm?: number; proposalId?: string } = {},
): Promise<void> {
  if (sessions.length === 0) return;
  const rows = sessions.map((s) => sessionRowInsert(db, userId, s, now, opts));
  await runAtomically(db, [
    ...rows.map((r) => r.insert),
    ...revisionInserts(db, {
      userId,
      workoutIds: rows.filter((r) => r.doc !== null).map((r) => r.id),
      sourceKind: "coach",
      sourceRef: opts.proposalId ?? null,
      now,
    }),
  ]);

  for (const { id, date, session } of sessions) {
    await writeStages(db, id, session, opts.thresholdPaceSecPerKm);
    // Coach adds reach the WATCH (user requirement 2026-08-12): duration-block
    // run sessions ride the same verified create pipeline as studio pushes.
    // The stored state stays calendar_only until the executor verifies; the
    // pending job already renders as "syncing" through deriveWorkoutSync.
    if (opts.corosWritesEnabled) {
      await enqueueWatchCreate(db, userId, id, date, session, now, opts.thresholdPaceSecPerKm);
    }
  }
}

/**
 * PUT A COACH SESSION ON THE WATCH — the one enqueue, shared by the live add
 * and by `POST /api/sync/push-absent`.
 *
 * Extracted because the two must not drift, and because the reason the backfill
 * exists is that this predicate CHANGED. Until `a8b1f04` (2026-08-17 15:39)
 * `watchPushable` admitted runs only; a lift or mobility session approved before
 * that — the athlete's were applied 14 hours earlier — took the `false` branch,
 * queued nothing, and was never reconsidered. Nothing in the system retries a
 * session that becomes pushable later, so the capability shipped and the
 * sessions that needed it stayed off the watch.
 *
 * Returns the job id when it queued one, `null` when the session cannot ride the
 * wire. Idempotent by deterministic id, so calling it on a session that already
 * has a job is a no-op rather than a duplicate create.
 */
export async function enqueueWatchCreate(
  db: Db,
  userId: string,
  id: string,
  date: string,
  /** A coach session, or a designed run's (§8 §3). */
  session: CoachSession | RunWatchSession,
  now: string,
  thresholdPaceSecPerKm?: number,
  /** A human is asking again — retry a job of this id that previously failed.
   *  Set only by `POST /api/sync/push-absent`; the live add path must not
   *  re-drive a write that already refused. Same reasoning as
   *  `enqueueContentConvergence`'s `reviveFailed`. */
  reviveFailed = false,
  /** The run wire in force (§8 phase 2): what a designed run needs to go. v1 when absent. */
  runWire: RunWire = "v1",
): Promise<string | null> {
  if (!watchPushable(session, thresholdPaceSecPerKm, runWire)) return null;
  const jobId = `${id}-push`;
  // The stamp is unique per day across both lanes (ruling 3-R12): a second session of this title on this day — a
  // coach add or a sent program session — already holds the base, so this one gets " (2)".
  const name = coachStamp(session.title, date, await takenStampsOn(db, userId, date, { jobId }));
  {
    const insert = db.insert(corosWriteJobs).values(watchCreateValues(userId, id, date, session, now, name, thresholdPaceSecPerKm));
    // Re-applying an approve must be idempotent (audit#2 #13) — the
    // deterministic id makes skip-on-conflict exactly right.
    await (reviveFailed
      ? insert.onConflictDoUpdate({
          target: corosWriteJobs.id,
          setWhere: inArray(corosWriteJobs.status, ["failed", "restored"]),
          set: {
            status: "queued",
            claimedByDeviceId: null,
            claimedAt: null,
            lastErrorCategory: null,
            lastErrorDetail: null,
            completedAt: null,
            // The attempt counter lives in the payload, so reviving must reset
            // it too — otherwise a job that exhausted its three tries fails
            // again immediately and the re-run looks like it did nothing.
            payload: {
              workoutId: id,
              happenDay: date,
              name,
              session,
              ...(thresholdPaceSecPerKm ? { thresholdPaceSecPerKm } : {}),
            },
            requestedAt: now,
            updatedAt: now,
          },
        })
      : insert.onConflictDoNothing());
  }
  return jobId;
}

/** A coach session's create job (`${id}-push`), queued, under the stamp `name` — `enqueueWatchCreate`'s, and a plan's
 * chunk of sessions' (§8 §4), which reads every day's stamps at once and writes its jobs in its batch. */
function watchCreateValues(
  userId: string,
  id: string,
  date: string,
  session: CoachSession | RunWatchSession,
  now: string,
  name: string,
  thresholdPaceSecPerKm?: number,
) {
  return {
    id: `${id}-push`,
    userId,
    workoutId: id,
    kind: "coach_create_workout",
    expectedContentFingerprint: fingerprint(session),
    originalDate: date,
    destinationDate: date,
    // The name is the OWNERSHIP STAMP on COROS and must be unique per
    // plan — raw titles ("Long Run" ×6) refuse every create after the
    // first (audit#2 #7). Machine plumbing that happens to be legible:
    // `coros-stamp.ts` strips it back off on the way in, so the stamp
    // never becomes the athlete's session name.
    payload: {
      workoutId: id,
      happenDay: date,
      name,
      session,
      ...(thresholdPaceSecPerKm ? { thresholdPaceSecPerKm } : {}),
    },
    requestedAt: now,
    status: "queued",
    updatedAt: now,
  } satisfies typeof corosWriteJobs.$inferInsert;
}

// ── Convergence: keeping the watch's copy equal to the app's ────────────────
//
// `watchAddressOf` — "the address COROS is holding a session at, when the row
// can prove one" — lives in @rg/domain (watch-address.ts) since audit 1 (coach
// finding 6), so the manifest's `hasWatchAddress` and every write gate here
// read one predicate instead of two that had drifted.

/** Why no convergence job was queued, in the vocabulary the caller reports in. */
export type ConvergeRefusal =
  /** Watch writes are off in Settings. Nothing is wrong; nothing is queued. */
  | "writes_disabled"
  /** The row has no proven COROS address, so the watch is not holding this
   *  session at all and there is nothing to converge. */
  | "not_on_the_watch"
  /** COROS holds it, and NEITHER ownership proof is available: no program-name
   *  stamp this account wrote, and no recorded import fingerprint to re-read
   *  against. Ownership cannot be re-proven, and nothing is written on a maybe. */
  | "no_ownership_proof"
  /** An imported row with no OPEN CONTENT INTENT. COROS authored this session
   *  and the athlete has not approved a change to it, so there is nothing the
   *  app is entitled to write over it — see `ownershipProofFor`. */
  | "not_athlete_approved"
  /** An imported row whose new content cannot cross the wire. The rewrite is
   *  impossible and the unpush is worse than the divergence — see
   *  `ownershipProofFor`. */
  | "cannot_unpush_imported"
  /** A programme or on-demand row (ruling 3-R13): built by its programme, its watch copy changes only by the
   *  athlete's Send and Take off — never by a coach rewrite, nor by a coach unpush of a body that cannot cross. */
  | "app_authored"
  /** An imported row whose `source_content_fingerprint` is a LOCAL hash rather
   *  than an observation of COROS — the state every ease left behind until
   *  `sessionColumns` stopped writing that column. One COROS read repairs it
   *  (import rule 7's content-intent branch); nothing is written until it does. */
  | "stale_local_fingerprint";

/**
 * Is this recorded fingerprint an OBSERVATION OF COROS, or a local hash?
 *
 * `corosProgramFingerprint` runs its input through `@rg/domain`'s `fingerprint`,
 * which emits exactly sixteen lowercase hex characters. This module's own
 * `fingerprint` helper prefixes `coach-`, and that is what an ease used to write
 * into `source_content_fingerprint` — so the shape is a structural, not
 * cosmetic, test of where the value came from.
 *
 * It is written as a POSITIVE test of the wire's format rather than a negative
 * test of ours on purpose: it stays correct if the local prefix ever changes,
 * and it refuses anything it cannot recognise, which is the safe direction.
 *
 * It matters because the second ownership proof compares this value against the
 * wire. A local hash can never match, so a row carrying one cannot converge —
 * and the census must SAY that rather than promise a rewrite that will come back
 * `stamp_mismatch`.
 */
export function isUpstreamFingerprint(fp: string): boolean {
  return /^[0-9a-f]{16}$/.test(fp);
}

/**
 * HOW THIS ROW PROVES THE WORKOUT AT ITS ADDRESS IS STILL ITS WORKOUT.
 *
 * Two proofs, and the second one is why the athlete's plan can converge at all.
 *
 *  · BY STAMP — a verified coach create (or a previous rewrite) carrying the
 *    exact program name we put on the wire. Authorship. Available only for the
 *    sessions THIS APP created.
 *
 *  · BY RE-READ — the address, the day and `source_content_fingerprint` the
 *    import recorded. Available for the sessions COROS authored, which is most
 *    of the athlete's plan: the coach eases those, it never creates them, so
 *    they have no stamp and `no_recorded_stamp` refused every single one of
 *    them. The rewrite that fixed today's session could not reach the other six
 *    days of the week. The executor re-reads the address before writing and
 *    refuses if what is there is not what we imported; see `content-executor.ts`
 *    THE SECOND PROOF for why that is as safe as the stamp.
 *
 * THE STAMP IS TRIED FIRST and its absence is what opens the second door, so a
 * coach-created row's proof never changes. Nothing about the stamp discipline is
 * relaxed: this adds a proof, it does not weaken one.
 *
 * AN IMPORTED ROW NEEDS ONE MORE THING THAT A COACH ROW DOES NOT: an OPEN
 * `content` INTENT. A coach-created session is ours by construction — the app is
 * the only thing that has ever written it, so re-pushing it is only ever
 * re-asserting what the app already said. A COROS-authored session is not, and
 * the only thing that entitles the app to overwrite one is the athlete having
 * approved a change to it. `ease` writes that intent before it enqueues, and the
 * backfill selects on it; requiring it here means no future caller can converge
 * an imported session the athlete never touched, however it gets wired up.
 */
export type OwnershipProof =
  | { kind: "stamp"; recordedName: string }
  | { kind: "imported"; importedProgramId: string; importedFingerprint: string };

export async function ownershipProofFor(
  db: Db,
  userId: string,
  workout: { id: string; sourceProgramId: string | null; sourceContentFingerprint: string },
): Promise<OwnershipProof | ConvergeRefusal> {
  const recordedName = await recordedStampFor(db, userId, workout.id);
  if (recordedName) return { kind: "stamp", recordedName };
  // Both halves or neither. `source_program_id` is COROS's own `program.id` for
  // an imported row — the identity — and the fingerprint is what the app last
  // observed there. A row missing either cannot make the second proof, and a
  // half-proof is not a proof.
  if (!workout.sourceProgramId || !workout.sourceContentFingerprint) return "no_ownership_proof";
  if (!isUpstreamFingerprint(workout.sourceContentFingerprint)) return "stale_local_fingerprint";
  const intent = await openIntentFor(db, userId, workout.id, "content");
  if (!intent) return "not_athlete_approved";
  return {
    kind: "imported",
    importedProgramId: workout.sourceProgramId,
    importedFingerprint: workout.sourceContentFingerprint,
  };
}

/** What a convergence attempt did. `kind` names the job actually queued: a
 * rewrite when the new content can cross the wire, an UNPUSH when it cannot. */
export interface ConvergeOutcome {
  jobId?: string;
  kind?: "coach_update_workout" | "coach_delete_workout";
  refused?: ConvergeRefusal;
}

/**
 * MAKE COROS SAY WHAT THE APP NOW SAYS about one already-pushed session.
 *
 * This is the enqueue half of the content-write kind (`jobs.ts`
 * `coachUpdateWorkoutJobSchema`). It is called from every path that rewrites a
 * pushed session's content in place — today that is `ease` and the one-shot
 * backfill; see the audit note on `applyOps` for why the other session-carrying
 * ops cannot reach this state.
 *
 * TWO DIRECTIONS, because "converge" is not always "rewrite":
 *
 *  · the new content CAN cross the wire → `coach_update_workout`, which re-proves
 *    ownership by stamp and replaces the program.
 *  · it CANNOT (an ease into a distance-block run, a bodyless "forty by feel", a
 *    lift with a movement COROS has never heard of) → `coach_delete_workout`.
 *    The watch stops holding a prescription the app has withdrawn. Leaving it is
 *    the one option that is not defensible: the athlete has been told their
 *    session is now 35 easy minutes, and their watch would still be offering
 *    6 × 643 m at 10K pace for them to go and run.
 *
 * IDEMPOTENT ON RE-APPLY, and the id is how. `${from}-${to}` fingerprints mean a
 * re-applied approve collapses onto the same row (audit#2 #13) while an
 * A → B → A round trip does not — its second leg is a genuinely different
 * rewrite, and a fingerprint-of-destination alone would have skipped it and left
 * the watch holding B forever.
 */
export async function enqueueContentConvergence(
  db: Db,
  v: {
    userId: string;
    /** The row as it stood BEFORE the rewrite: its fingerprint and address are
     *  what COROS is still holding. */
    workout: typeof plannedWorkouts.$inferSelect;
    /** What the app now prescribes: a coach session, or a designed run's (§8 §3: its Undo rewrites it back). */
    session: CoachSession | RunWatchSession;
    /**
     * A HUMAN IS ASKING AGAIN — revive a job of this id that previously failed.
     *
     * Job ids are content-derived, so a re-request for an unchanged session
     * collides with the existing row and `onConflictDoNothing` makes the second
     * call a silent no-op. That is right for the automatic path: a wake must not
     * re-drive a write that already refused, or a permanently-refusing job would
     * be retried on every page visit forever.
     *
     * It is wrong for `POST /api/sync/converge-content`, which runs only because
     * an operator asked for it, and where the no-op reports "1 rewrite queued"
     * while the drain then executes nothing — the exact confusion this ends. Set
     * only there.
     */
    reviveFailed?: boolean;
    /** With `reviveFailed`: a SUPERSEDED row of this id is revived too — the athlete's own Send, which runs only with no
     *  rewrite of the row in flight (watch-version-send.ts; review-S I1). */
    reviveSuperseded?: boolean;
    now: string;
    corosWritesEnabled: boolean;
    thresholdPaceSecPerKm?: number;
    /** The run wire in force (§8 phase 2): what a designed run needs to go. v1 when absent. */
    runWire?: RunWire;
    /**
     * Appended to the rewrite's job id: a rewrite whose CONTENT is unchanged (the pace heal re-sends the same session
     * so the wire gains the new encoding) has the same `from`/`to` as an earlier rewrite of that content, and would
     * collide with that VERIFIED row — a no-op that reports a job queued while nothing runs, forever.
     */
    idTag?: string;
  },
): Promise<ConvergeOutcome> {
  if (!v.corosWritesEnabled) return { refused: "writes_disabled" };
  // The row as the caller read it may still carry the "keep the watch's version" mark that its own write has just
  // lifted: its proof and its claim are on what the watch holds (watch-copy-marker.ts).
  v = { ...v, workout: { ...v.workout, sourceContentFingerprint: watchCopyBase(v.workout.sourceContentFingerprint) } };
  // Both directions — the rewrite and the unpush of a body that cannot cross the wire (ruling 3-R13).
  if (appAuthoredRow(v.workout)) return { refused: "app_authored" };
  const address = watchAddressOf(v.workout);
  if (!address) return { refused: "not_on_the_watch" };
  const proof = await ownershipProofFor(db, v.userId, v.workout);
  if (typeof proof === "string") return { refused: proof };

  // A stale rewrite must never outlive the change that replaced it: an ease to B
  // queued behind an ease to C would put B on the watch last. Same supersede
  // `enqueueMoveJob` does, scoped to this kind — a pending CREATE is untouched
  // (superseding one strands the session app-only forever, audit#2 #12) and so
  // is a pending unpush, which is a removal, not a competing content claim.
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: v.now })
    .where(
      and(
        eq(corosWriteJobs.workoutId, v.workout.id),
        eq(corosWriteJobs.kind, "coach_update_workout"),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );

  const from = v.workout.sourceContentFingerprint;
  const to = fingerprint(v.session);
  const common = {
    userId: v.userId,
    workoutId: v.workout.id,
    // What COROS is expected to STILL hold — the optimistic-concurrency claim
    // this column exists for on every other kind.
    expectedContentFingerprint: from,
    originalDate: address.happenDay,
    destinationDate: address.happenDay,
    requestedAt: v.now,
    status: "queued" as const,
    updatedAt: v.now,
  };

  if (!watchPushable(v.session, v.thresholdPaceSecPerKm, v.runWire)) {
    // AN IMPORTED SESSION IS NEVER UNPUSHED, and this is the one place the
    // "leaving the watch prescribing withdrawn work is indefensible" rule loses.
    //
    // Two reasons, and the second is decisive. A `coach_delete_workout` is
    // authorized by the STAMP and an imported row has none, so there is nothing
    // honest to put in the payload. And the outcome would be worse than the
    // divergence: deleting the workout makes it absent from the COROS plan, so
    // import RULE 8 counts two missing reads and ARCHIVES the athlete's own
    // eased session out of the app. They approved a change and the session
    // disappears. The app's copy stays authoritative and visible; the watch
    // keeps COROS's original until the athlete resolves it, and the report says
    // exactly that.
    if (proof.kind === "imported") return { refused: "cannot_unpush_imported" };
    const jobId = `${v.workout.id}-unpush-${to}`;
    await db
      .insert(corosWriteJobs)
      .values({
        ...common,
        id: jobId,
        kind: "coach_delete_workout",
        payload: {
          workoutId: v.workout.id,
          happenDay: address.happenDay,
          name: proof.recordedName,
          idInPlan: address.idInPlan,
          programId: address.programId,
          corosPlanId: address.corosPlanId,
        },
      })
      .onConflictDoNothing();
    return { jobId, kind: "coach_delete_workout" };
  }

  const jobId = `${v.workout.id}-content-${from}-${to}${v.idTag ? `-${v.idTag}` : ""}`;
  // A coach-created session's new stamp comes from the one chooser (ruling 3-R12), its own row's jobs left out: a
  // rewrite that keeps its title keeps the stamp it already carries, " (n)" included.
  let name = v.session.title;
  if (proof.kind === "stamp") {
    const base = stampName(v.session.title, address.happenDay);
    const own = proof.recordedName;
    name =
      own === base || (own.startsWith(base) && /^ \(\d+\)$/.test(own.slice(base.length)))
        ? own
        : coachStamp(v.session.title, address.happenDay, await takenStampsOn(db, v.userId, address.happenDay, { workoutId: v.workout.id }));
  }
  const insert = db
    .insert(corosWriteJobs)
    .values({
      ...common,
      id: jobId,
      kind: "coach_update_workout",
      payload: {
        workoutId: v.workout.id,
        happenDay: address.happenDay,
        // THE NAME THE REWRITE LEAVES, and it is not the same kind of thing in
        // the two cases.
        //
        // Coach-created: the STAMP, derived from the session's current title,
        // because an ease can rename the session and the name is what the
        // athlete reads on the watch. `coros-stamp.ts` knows this kind names a
        // program, so the new stamp is stripped back off on the way in.
        //
        // Imported: the PLAIN TITLE. We do not stamp a session COROS authored —
        // the stamp is an authorship claim we would be making falsely, it would
        // rename the session inside the athlete's own COROS plan, and the next
        // import would have to strip a name it should never have seen. A plain
        // title needs no stripping (`loadOwnProgramNames` records a mapping only
        // when the name genuinely EXTENDS the title, so `name === title` is
        // skipped and `unstampTitle` passes it straight through) and it makes
        // the watch read what the app reads, which is the point.
        name,
        ...(proof.kind === "stamp"
          ? { recordedName: proof.recordedName }
          : {
              importedProgramId: proof.importedProgramId,
              importedFingerprint: proof.importedFingerprint,
            }),
        idInPlan: address.idInPlan,
        programId: address.programId,
        corosPlanId: address.corosPlanId,
        session: v.session,
        ...(v.thresholdPaceSecPerKm ? { thresholdPaceSecPerKm: v.thresholdPaceSecPerKm } : {}),
      },
      requestedAt: v.now,
    });
  await (v.reviveFailed
    ? insert.onConflictDoUpdate({
        target: corosWriteJobs.id,
        // Only a FAILED row is revived — or one a restore switched off
        // ('restored'), which the athlete is now asking for again. A queued job
        // is already going to run and resetting it would drop an in-flight
        // claim; a verified one is done and re-running it would rewrite the
        // watch with nobody asking. A superseded one only when the athlete's
        // own Send asks (`reviveSuperseded`).
        setWhere: inArray(corosWriteJobs.status, v.reviveSuperseded ? ["failed", "restored", "superseded"] : ["failed", "restored"]),
        set: {
          status: "queued",
          claimedByDeviceId: null,
          claimedAt: null,
          lastErrorCategory: null,
          lastErrorDetail: null,
          completedAt: null,
          requestedAt: v.now,
          updatedAt: v.now,
        },
      })
    : insert.onConflictDoNothing());
  return { jobId, kind: "coach_update_workout" };
}

/**
 * A STRUCTURED RUN'S RE-TIME, WRITTEN (the owner's decision, 2026-10-20; adjust-retime.ts). What an ease writes, for
 * the steps the rule made:
 *  - the row: its length (the rule's), its stage summary and distance, `calendar_only` until the watch confirms — a
 *    designed run's own columns, a plan run's a coach session's (`sessionColumns`, as an ease) keeping its name, category
 *    and subtype; "keep the watch's version" lifted (`unmarkedFingerprint`: the newer change stands, review-S3 A1);
 *  - its document's next revision, and its stage rows replaced — in one batch with the row;
 *  - the app's claim on its content (`coach_adjust`), so a COROS read never hands the row back to the older copy;
 *  - a create of it still queued: the new session, so the watch never gets the old one;
 *  - its watch copy rewritten (`enqueueContentConvergence`, on what the watch holds: the row as it was read) — refused
 *    quietly when it isn't on the watch, or writes are off: the session not on the watch just gets its new stages.
 * Statements (design-approve.ts `RETIME_COST`): the batch (row, revision, delete, the inserts), the claim (2), the
 * create (1), the rewrite (at most 4) — after the applier's row and stage reads. Answers how many queued creates it
 * brought up to date (0 or 1).
 */
export async function writeRetimed(
  db: Db,
  v: {
    userId: string;
    /** The row as read, before this write: its address and fingerprint are what the watch holds. */
    row: typeof plannedWorkouts.$inferSelect;
    minutes: number;
    write: RetimeWrite;
    proposalId: string;
    now: string;
    thresholdPaceSecPerKm?: number;
    prefs: UserPreferences;
    runWire: RunWire;
  },
): Promise<{ createsUpdated: number }> {
  const { row, write: w } = v;
  const pw = plannedWorkouts;
  const seconds = v.minutes * 60;
  const columns =
    w.family === "designed"
      ? {
          calendarBlockDurationSeconds: seconds,
          fallbackEstimatedDurationSeconds: seconds,
          sourceEstimatedDurationSeconds: null,
          durationEstimate: null,
          expectedDistanceMeters: w.expectedDistanceMeters,
          stageSummary: w.stageSummary,
          corosSyncState: "calendar_only",
        }
      : { ...sessionColumns(w.session), title: row.title, category: row.category, qualitySubtype: row.qualitySubtype };
  await runAtomically(db, [
    db
      .update(pw)
      .set({
        ...columns,
        ...updateDocColumns(w.doc),
        sourceContentFingerprint: unmarkedFingerprint(pw.sourceContentFingerprint),
        updatedAt: v.now,
      })
      .where(and(eq(pw.id, row.id), eq(pw.userId, v.userId))),
    ...(w.doc ? [revisionInsert(db, { userId: v.userId, workoutId: row.id, sourceKind: "coach", sourceRef: v.proposalId, now: v.now })] : []),
    db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, row.id)),
    ...insertBatches(w.stages).map((batch) => db.insert(plannedWorkoutStages).values(batch)),
  ]);
  const watch = w.family === "designed" ? w.session : w.watchSession;
  await recordIntent(db, {
    userId: v.userId,
    targetKind: "workout",
    targetId: row.id,
    kind: "content",
    payload: { fingerprint: fingerprint(watch) },
    source: "coach_adjust",
  });
  // A create not yet run carries the session it was queued with: it goes with the new one — ONLY WHILE IT IS STILL
  // `queued` (review-L minor 1; the guard is in the WHERE, and the rows it changed are counted). A create the lane has
  // claimed already carries the old session and lands it; nothing is rewritten behind the athlete's back for it. The
  // fallback is the app's open claim recorded above (`coach_adjust`, this session's fingerprint): a create's verify
  // closes a claim only on the session it carried, and only when it wrote it (coros-write-cloud.ts; review-L re-review
  // I1, review A2), so the create brought up to date answers it, and the claimed one, landing the old session — or a
  // requeued one whose retry finds the old session an earlier attempt landed — leaves it open: the row reads "Older on
  // watch" (`content_stale`) and Send is the athlete's: safer than a rewrite queued after a verify no request is there
  // to see.
  const retargeted = await db
    .update(corosWriteJobs)
    .set({ payload: sql`json_set(${corosWriteJobs.payload}, '$.session', json(${JSON.stringify(watch)}))`, expectedContentFingerprint: fingerprint(watch), updatedAt: v.now })
    .where(
      and(
        eq(corosWriteJobs.id, `${row.id}-push`),
        eq(corosWriteJobs.userId, v.userId),
        eq(corosWriteJobs.kind, "coach_create_workout"),
        eq(corosWriteJobs.status, "queued"),
      ),
    )
    .returning({ id: corosWriteJobs.id });
  await enqueueContentConvergence(db, {
    userId: v.userId,
    workout: row,
    session: watch,
    now: v.now,
    corosWritesEnabled: v.prefs.corosWritesEnabled ?? false,
    ...(v.thresholdPaceSecPerKm !== undefined ? { thresholdPaceSecPerKm: v.thresholdPaceSecPerKm } : {}),
    runWire: v.runWire,
  });
  return { createsUpdated: retargeted.length };
}

/**
 * Archive aftermath (audit#3 D2): every coach-archived row needs the same
 * "user_removed" suppression a hand removal gets — import's presence-healing
 * keys on suppressions, and without one the next 90-day COROS read
 * un-archives the row right next to its replacement. Verified watch-pushed
 * sessions additionally get an unpush job so the watch stops scheduling the
 * retired plan (imported COROS-plan rows are never touched here — archiveWeek
 * and retirePlan operate on coach-authored plans only).
 */
async function suppressAndUnpush(
  db: Db,
  userId: string,
  rows: Array<typeof plannedWorkouts.$inferSelect>,
  now: string,
  prefs: UserPreferences,
): Promise<void> {
  for (const w of rows) {
    await db
      .insert(calendarEventSuppressions)
      .values({ id: newId(), workoutId: w.id, eventId: null, reason: "user_removed", createdAt: now });
    // A queued create/move/rewrite would still put the retired session on the
    // watch — same settle every archive path runs (audit 1, coach finding 1).
    await settleWatchJobsOnArchive(db, userId, w.id, now);
    await enqueueUnpushIfOurs(db, userId, w, now, prefs);
  }
}

/** Archive this plan-week's unstarted sessions (calendar suppression; watch
 * unpush for verified coach-pushed rows — the documented remove contract for
 * imported plans never applies here because planId is coach-authored). */
async function archiveWeek(
  db: Db,
  userId: string,
  planId: string,
  weekStart: string,
  now: string,
  prefs: UserPreferences,
): Promise<string[]> {
  // An LLM-supplied planId must be a plan the coach authored: pointed at the
  // imported COROS plan's id this would bulk-archive imported rows.
  const [plan] = await db
    .select({ id: coachPlans.id })
    .from(coachPlans)
    .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, userId)))
    .limit(1);
  if (!plan) return [];
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, planId),
        gte(plannedWorkouts.effectiveDate, weekStart),
        lte(plannedWorkouts.effectiveDate, addDays(weekStart, 6)),
        eq(plannedWorkouts.completionState, "scheduled"),
        // Re-applying an approved proposal must be a no-op — already-archived
        // rows would otherwise collect a second suppression row.
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  if (rows.length > 0) {
    // Chunked like every other id-list bind: D1 caps a statement at ~100 bound
    // variables. One week of one plan is small today, but the cap is not worth
    // betting an approval on.
    for (const ids of chunkIds(rows.map((r) => r.id))) {
      await db
        .update(plannedWorkouts)
        .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
        .where(inArray(plannedWorkouts.id, ids));
    }
    await suppressAndUnpush(db, userId, rows, now, prefs);
  }
  return rows.map((r) => r.id);
}

/** Why a session an op names can no longer change, in the applier's own words: each completes "a session it <verb> …". */
export const NOT_ACTIONABLE = {
  gone: "isn't on the calendar any more",
  done: "has already been done",
  skipped: "was already skipped",
  missed: "was already missed",
  past: "has already had its day",
} as const;

/**
 * THE ROW AN ID-ADDRESSED OP MAY STILL CHANGE — `applyOps`' own rule, as one function (Stage 3 Task 8b: the coach
 * designer's `adjust_plan` judges a change by it when it is proposed, and its approval before the applier runs). Still
 * on the calendar, still unresolved, its day not yet gone: undefined; otherwise why not, in the applier's words.
 */
export function whyNotActionable(
  row: Pick<typeof plannedWorkouts.$inferSelect, "archivedAt" | "completionState" | "effectiveDate"> | undefined,
  today: string,
): string | undefined {
  if (!row) return NOT_ACTIONABLE.gone;
  if (row.archivedAt) return NOT_ACTIONABLE.gone;
  if (row.completionState === "completed") return NOT_ACTIONABLE.done;
  if (row.completionState === "skipped") return NOT_ACTIONABLE.skipped;
  if (row.completionState === "missed") return NOT_ACTIONABLE.missed;
  if (row.effectiveDate < today || row.completionState === "unresolved") return NOT_ACTIONABLE.past;
  if (row.completionState !== "scheduled" && row.completionState !== "planned") return `is already ${row.completionState}`;
  return undefined;
}

/**
 * WHICH OPS CAN LEAVE COROS HOLDING SOMETHING THE APP NO LONGER PRESCRIBES —
 * audited op by op (2026-08-17), because "ease is the one that bit" is a
 * finding about one bug, not a statement about the vocabulary.
 *
 *  · `ease` — YES, an in-place content rewrite. It updates an existing row's
 *    every session-decided column. Converged above.
 *  · `adjust` of a structured run re-timed by the rule (2026-10-20,
 *    adjust-retime.ts) — YES, the other one: its steps change, so it converges
 *    as an ease does. A length alone (an unstructured run, a lift, the thread
 *    coach's adjust) — NO: no content is written.
 *  · `add`, `firmUp`, `reshapeWeek`, `windDown`, `createPlan` — NO. All five go
 *    through `insertSession`, which INSERTS a row under a fresh proposal-derived
 *    id and `onConflictDoNothing`; a re-apply of the same proposal carries the
 *    same session, so a row's content never changes underneath a push. Where
 *    they displace existing sessions (`reshapeWeek`, `windDown`) the displaced
 *    rows are ARCHIVED and unpushed — a removal, not a divergence — and the
 *    replacements are new rows with their own creates.
 *  · `move`, `swap` — NO. They change the date, which `applyMove`'s
 *    `move_scheduled_workout` already writes, and content is untouched.
 *  · `skip`, `extendPlan`, `retirePlan`, `resolveRaceConflict` — NO session
 *    content is written. (`retirePlan` archives and unpushes, like the above.)
 *
 * THE ARCHIVE PATHS HAD THE SAME BUG IN THE OTHER DIRECTION, and it is fixed in
 * `suppressAndUnpush`: their unpush was gated on `corosSyncState === "synced"`,
 * which an eased row is not, so a session that was eased and then reshaped away
 * stayed on the watch forever. See the comment there.
 *
 * THE STUDIO PUSH PATH already converges and is deliberately left alone:
 * `studio-push.ts` detects a changed session by fingerprint against
 * `studio_plan_pushes.sessionFingerprint` and chains a delete-then-create, with
 * the create enqueued only once the delete reaches a terminal "gone" state. That
 * is the same convergence, expressed in the ledger that owns those rows; giving
 * it a second mechanism would give one push row two state machines.
 */
export async function applyOps(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  proposalId: string,
  ops: CoachOp[],
  /**
   * `only`: apply just the ops at these indices, each under its own index's ids, as if the others were absent; and
   * `priorRefs`: the before-states the proposal already holds, which this apply never overwrites — a thread proposal
   * that shapes a plan applies its other ops a run at a time, between its structural ops' chunks (§8 §4).
   */
  opts: {
    only?: (i: number) => boolean;
    priorRefs?: Record<string, { date?: string; summary?: string; durationMinutes?: number }> | null;
    /**
     * The re-times the cards showed, by workout id (the coach designer's approve, from each `adjust`'s
     * `PlanAdjustOp.retime`): an `adjust` of a session named here re-times its structured run by the rule
     * (adjust-retime.ts) — only when the rule, run again now, finds what the card said. An `adjust` of a session not
     * named here changes its length alone, as it always has: the thread coach's card says "watch unchanged".
     */
    retimes?: ReadonlyMap<string, RetimeExpectation>;
    /** The run wire in force (§8 phase 2): what a re-timed designed run is made by and goes to the watch on. v1 when absent. */
    runWire?: RunWire;
  } = {},
): Promise<ApplyResult> {
  const inScope = (i: number) => !opts.only || opts.only(i);
  const now = nowInstant();
  const today = todayInZone(prefs.timezone);
  // One read for the whole proposal: the athlete's latest COROS threshold
  // anchors every pace band this apply writes (2026-08-14).
  const thresholdPaceSecPerKm = (await latestThreshold(db, userId)) ?? undefined;
  /** What every new session of this apply is written with. */
  const sessionOpts = { corosWritesEnabled: prefs.corosWritesEnabled, prefs, thresholdPaceSecPerKm, proposalId };
  const out: ApplyResult = { created: [], updated: [], archived: [], missed: [], resimFrom: null };
  const noteResim = (date: string | null | undefined) => {
    if (date && date <= today && (out.resimFrom === null || date < out.resimFrom)) out.resimFrom = date;
  };

  // ── Before-state snapshot (manifest 0019) ────────────────────────────
  // "What it did" must keep its true befores after the plan moves on: the
  // settled card used to recompute them from the post-apply plan, which
  // rendered every applied ease as X → X. Captured BEFORE any op touches a
  // row, written to the proposal so history can never drift again.
  const touchedIds = [
    ...new Set(
      ops.flatMap((o, i) =>
        inScope(i) && (o.kind === "ease" || o.kind === "move" || o.kind === "skip") ? [o.workoutId] : [],
      ),
    ),
  ];
  if (touchedIds.length > 0) {
    const beforeRows: (typeof plannedWorkouts.$inferSelect)[] = [];
    for (const ids of chunkIds(touchedIds)) {
      beforeRows.push(
        ...(await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.userId, userId), inArray(plannedWorkouts.id, ids)))),
      );
    }
    const appliedRefs = Object.fromEntries(
      beforeRows.map((w) => [
        w.id,
        {
          date: w.effectiveDate,
          summary: humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype),
          ...(w.sourceEstimatedDurationSeconds != null || w.fallbackEstimatedDurationSeconds != null
            ? {
                durationMinutes: Math.round(
                  (w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds!) / 60,
                ),
              }
            : {}),
        },
      ]),
    );
    await db
      .update(coachProposals)
      .set({ appliedRefs: { ...appliedRefs, ...(opts.priorRefs ?? {}) } })
      .where(and(eq(coachProposals.id, proposalId), eq(coachProposals.userId, userId)));
  }
  /** Every day this apply put a session on, changed the length of, or moved one
   * to. Handed to `separateDayCollisions` at the end so the athlete never
   * approves a proposal that books two appointments at the same hour. */
  const touchedDates = new Set<string>();

  /**
   * THE ROW AN ID-ADDRESSED OP MAY STILL CHANGE — re-checked at the tap, not
   * trusted from the wake (audit 1, coach finding 2).
   *
   * The wake's fatal `touch_resolved` rule judged the calendar as it stood when
   * the proposal was drafted, and approval can come hours later: "skip today's
   * tempo", approved that evening after the athlete ran it anyway, overwrote the
   * completion and the garden lost the run for good (a remove archived it, with
   * the same result). So every op that names a session re-asks the same
   * question `validateOps` asked — still on the calendar, still unresolved, its
   * day not yet gone — and an op whose answer changed is reported as a
   * shortfall, the way every other op that could not do its job is.
   *
   * `why` completes "a session it <verb> …" in the athlete's words.
   */
  const actionable = async (
    workoutId: string,
  ): Promise<
    | { row: typeof plannedWorkouts.$inferSelect; why?: undefined }
    | { row?: typeof plannedWorkouts.$inferSelect; why: string }
  > => {
    const [row] = await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
      .limit(1);
    // The row rides along with a refusal, so an op can recognise its OWN
    // target state (a re-apply, finding 7) rather than report it as a shortfall.
    const why = whyNotActionable(row, today);
    return why === undefined ? { row: row! } : { row, why };
  };

  for (let i = 0; i < ops.length; i++) {
    if (!inScope(i)) continue;
    const op = ops[i]!;
    const opId = (n: number | string) => `cw-${proposalId}-${i}-${n}`;
    switch (op.kind) {
      case "ease": {
        // Ownership first, because the stage write below is keyed on the
        // workout id alone — `planned_workout_stages` carries no user column,
        // so an id that isn't this athlete's must never reach it.
        // The WHOLE row, because the convergence enqueue below reads the address
        // and the fingerprint COROS is still holding — and `sessionColumns`
        // overwrites the fingerprint two statements from now, so this read is
        // the last moment the pre-ease truth exists.
        const found = await actionable(op.workoutId);
        if (found.why !== undefined) {
          // Same class of silent failure `missed` was invented for: the row
          // can go (or be run, or be skipped) between the wake that proposed
          // the ease and the tap that approves it, and an update matching
          // nothing returned a success receipt for a session never changed.
          out.missed.push(`a session it eases ${found.why}, so nothing was changed`);
          break;
        }
        // A PROGRAMME SESSION IS BUILT BY ITS PROGRAMME (ruling 3-R13): its content is its build's, and its watch
        // copy changes only by the athlete's Send and Take off. `validateOps` refuses this op as
        // `app_built_session`; a proposal stored before that rule is re-checked here, at the tap.
        if (appAuthoredRow(found.row)) {
          out.missed.push("a session it eases is yours to change, so nothing was changed");
          break;
        }
        const target = found.row;
        // An ease REPLACES the session, so it writes exactly what a fresh
        // insert writes — one writer, no parallel column list to fall behind —
        // and its workout document as the row's next revision, in the same
        // batch (Stage 1 dual-write; `updateDocColumns` keeps a row resolved
        // meanwhile as it was).
        const doc = sessionDoc(op.workoutId, op.session, prefs.weightUnit, thresholdPaceSecPerKm);
        await runAtomically(db, [
          db
            .update(plannedWorkouts)
            .set({
              ...sessionColumns(op.session),
              ...updateDocColumns(doc),
              // A new change of the app's after "keep the watch's version": the app's claim is live again, and the
              // fingerprint the mark kept is what the watch holds (watch-copy-marker.ts).
              sourceContentFingerprint: unmarkedFingerprint(plannedWorkouts.sourceContentFingerprint),
              updatedAt: now,
            })
            .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId))),
          ...(doc ? [revisionInsert(db, { userId, workoutId: op.workoutId, sourceKind: "coach", sourceRef: proposalId, now })] : []),
        ]);
        // The body, too: a run eased into a lift loses the run's stage rows,
        // and a lift eased into a run loses the lift's exercise list.
        await writeStages(db, op.workoutId, op.session, thresholdPaceSecPerKm);
        // The approved edit is the app's permanent claim on this session's
        // content — without it, import rule 7 hands the row back to the
        // COROS snapshot within one pull (audit#3 D1).
        await recordIntent(db, {
          userId,
          targetKind: "workout",
          targetId: op.workoutId,
          kind: "content",
          payload: { fingerprint: fingerprint(op.session) },
          source: "coach_ease",
        });
        // …AND THE WATCH IS TOLD (2026-08-17). This is the athlete's own
        // complaint — "my plan for today on the app and in coros completely
        // don't match" — and it was structural, not a slip: `ease` rewrote the
        // app's copy, wrote the content intent that says the two disagree, and
        // then there was no job kind that could write content, so COROS kept the
        // original forever. The intent is closed by the executor on verify, so
        // `content_stale` becomes a transient state instead of a permanent one.
        //
        // A refusal is not an error and is not swallowed: `not_on_the_watch` is
        // the ordinary case (the session was never pushed) and leaves the row
        // exactly as `sessionColumns` wrote it — `calendar_only`, with the intent
        // open, which is the honest report that COROS does not have this.
        await enqueueContentConvergence(db, {
          userId,
          workout: target,
          session: op.session,
          now,
          corosWritesEnabled: prefs.corosWritesEnabled ?? false,
          thresholdPaceSecPerKm,
        });
        // An ease REPLACES the session, so it also replaces how long the day's
        // block is — a 35-minute jog where a 100-minute session was leaves a
        // gap, and a longer one can land on top of its neighbour.
        touchedDates.add(target.effectiveDate);
        out.updated.push(op.workoutId);
        break;
      }
      case "move": {
        const found = await actionable(op.workoutId);
        if (found.why !== undefined) {
          out.missed.push(`a session it moves ${found.why}, so it stayed where it was`);
          break;
        }
        const w = found.row;
        // A move that only changes the time of day is still a move: the
        // date-only test used to drop "same day, but in the afternoon"
        // silently, which is why `toTime` had no expressible form at all.
        const toTime = op.toTime ?? w.effectiveTime ?? "07:00";
        if (w.effectiveDate !== op.toDate || toTime !== w.effectiveTime) {
          await applyMove(db, {
            userId,
            workoutId: op.workoutId,
            toDate: op.toDate,
            toTime,
            source: "app",
            corosWritesEnabled: prefs.corosWritesEnabled ?? false,
          });
        }
        touchedDates.add(op.toDate);
        out.updated.push(op.workoutId);
        break;
      }
      case "swap": {
        const days = await db
          .select()
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.userId, userId),
              inArray(plannedWorkouts.effectiveDate, [op.dayA, op.dayB]),
              eq(plannedWorkouts.completionState, "scheduled"),
              // A removed session keeps its date; trading days must not drag
              // it (and a watch move job for it) back into the plan.
              isNull(plannedWorkouts.archivedAt),
            ),
          );
        for (const w of days) {
          const target = w.effectiveDate === op.dayA ? op.dayB : op.dayA;
          await applyMove(db, {
            userId,
            workoutId: w.id,
            toDate: target,
            toTime: w.effectiveTime,
            source: "app",
            corosWritesEnabled: prefs.corosWritesEnabled ?? false,
          });
          out.updated.push(w.id);
        }
        touchedDates.add(op.dayA);
        touchedDates.add(op.dayB);
        break;
      }
      case "skip": {
        const found = await actionable(op.workoutId);
        if (found.why !== undefined) {
          // ALREADY IN THIS OP'S TARGET STATE — a re-apply after a first
          // attempt that threw later on (audit 1, coach finding 7), or the
          // athlete's own skip since. A silent success: nothing is rewritten,
          // and the resim the first attempt may never have reached still runs.
          if (found.row && !found.row.archivedAt && found.row.completionState === "skipped") {
            noteResim(found.row.resolutionDate ?? today);
            out.updated.push(op.workoutId);
            break;
          }
          out.missed.push(`a session it skips ${found.why}, so it was left as it was`);
          break;
        }
        // Coach-sanctioned: the garden treats it as agreed rest (spec §1).
        await db
          .update(plannedWorkouts)
          .set({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach", updatedAt: now })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
        noteResim(today);
        out.updated.push(op.workoutId);
        break;
      }
      /**
       * REMOVE IS NOT SKIP. A skip resolves the row and the garden reads it as
       * agreed rest; a remove archives it, so the session simply is not on the
       * plan — the same mutation `workouts/:id/remove` performs. Answering
       * "can we get rid of that" with a skip (live, 2026-08-06) told the
       * garden the athlete had rested on a day they never intended to train.
       */
      case "remove": {
        const found = await actionable(op.workoutId);
        if (found.why !== undefined) {
          // ALREADY REMOVED — a re-apply (audit 1, coach finding 7), or the
          // athlete's own remove since. Not a shortfall: the session is off the
          // plan. The idempotent aftermath still runs, because a first attempt
          // that threw between the archive and the unpush left the watch
          // holding the session and the retry is the only thing that can reach
          // it (settle and unpush are both no-ops the second time).
          if (found.row?.archivedAt && found.row.archiveReason === "user_removed") {
            await settleWatchJobsOnArchive(db, userId, found.row.id, now);
            await enqueueUnpushIfOurs(db, userId, found.row, now, prefs);
            noteResim(found.row.effectiveDate);
            out.archived.push(op.workoutId);
            break;
          }
          out.missed.push(`a session it takes off the plan ${found.why}, so nothing was removed`);
          break;
        }
        const row = found.row;
        // The athlete's own remove, verbatim: suppression, intent, move-intent
        // close, queued watch writes settled, and the unpush a session the app
        // pushed needs — one mutation for both sides (Ruling A1).
        await removeFromPlan(db, userId, op.workoutId, { now, source: "coach_remove", prefs });
        noteResim(row.effectiveDate);
        out.archived.push(op.workoutId);
        break;
      }
      case "restore": {
        // Not-archived is a coach-only guard (the manual route never sees
        // archived rows); the mutation itself is the athlete's own unskip.
        const [row] = await db
          .select()
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.id, op.workoutId),
              eq(plannedWorkouts.userId, userId),
              isNull(plannedWorkouts.archivedAt),
            ),
          )
          .limit(1);
        const res = row
          ? await unskipWorkout(db, userId, op.workoutId, { now, source: "coach" })
          : { restored: false, resolvedOn: null };
        if (!res.restored) {
          // ALREADY BACK ON THE PLAN — a re-apply (audit 1, coach finding 7)
          // or the athlete's own un-skip. A silent success, and the garden
          // still forgets the skip: the resim reaches back to where the last
          // restore said the skip had counted, which the first attempt may
          // never have got to.
          if (row && (row.completionState === "scheduled" || row.completionState === "planned")) {
            const [last] = await db
              .select({ fromDate: scheduleOverrides.fromDate })
              .from(scheduleOverrides)
              .where(and(eq(scheduleOverrides.workoutId, row.id), eq(scheduleOverrides.kind, "restore")))
              .orderBy(desc(scheduleOverrides.createdAt))
              .limit(1);
            noteResim(last?.fromDate);
            out.updated.push(op.workoutId);
            break;
          }
          out.missed.push("a session it puts back isn't skipped any more, so nothing was restored");
          break;
        }
        noteResim(res.resolvedOn);
        out.updated.push(op.workoutId);
        break;
      }
      /**
       * A STRUCTURED RUN IS RE-TIMED BY THE RULE (the owner's decision, 2026-10-20). The coach states the new length
       * and the code does the arithmetic (adjust-retime.ts `retimeOfRow`, @rg/domain `retimeRun`): the warm-up and
       * cool-down kept, the reps counted, the main block scaled. A taper still reaches twelve sessions without twelve
       * session bodies — each is re-timed from its own steps. It is done only for a session the card said so of
       * (`opts.retimes`, the designer's approve), and only when the rule, run again on the row as it stands, finds what
       * the card said: else the session changed since, and nothing is written (`missed`). It writes what an ease writes —
       * the row (its name, category and subtype kept), its stage rows, its document's next revision, the app's claim
       * on the content and the rewrite of the watch's copy — and a create still queued for it carries the new session.
       *
       * Otherwise — a session not named, an unstructured run, a lift — duration only, as below. `ease` is the op that
       * rewrites what a session IS; this one changes how long it lasts and touches nothing else.
       *
       * THE LENGTH THE ATHLETE SEES (audit 1, coach finding 4). Every display
       * and placement reader — Plan, Today, the calendar event, day placement,
       * the matcher — reads `sourceEstimatedDurationSeconds ?? fallback`, so an
       * imported session (which always carries COROS's estimate) ignored an
       * adjust that only moved the block and the fallback: the card said 48 and
       * every screen still said 60. The COROS estimate describes COROS's copy,
       * not the app's any more, so it is cleared — exactly as `sessionColumns`
       * and the fidelity repair clear it — and the fallback becomes the length.
       *
       * A later COROS read of the SAME content leaves this alone (rule 7 only
       * writes durations when the wire's content changed). An upstream CONTENT
       * edit does replace it: upstream wins for every field the app holds no
       * claim on, and an adjust records none (see the audit's finding 11).
       */
      case "adjust": {
        const found = await actionable(op.workoutId);
        if (found.why !== undefined) {
          out.missed.push(`a session it re-times ${found.why}, so its length is unchanged`);
          break;
        }
        // Built by its programme (ruling 3-R13): its length is its build's.
        if (appAuthoredRow(found.row)) {
          out.missed.push("a session it re-times is yours to change, so its length is unchanged");
          break;
        }
        const row = found.row;
        const expected = opts.retimes?.get(op.workoutId);
        if (expected) {
          const { retimeOfRow, sameRetime } = await import("./adjust-retime.js");
          const stages = await db
            .select()
            .from(plannedWorkoutStages)
            .where(eq(plannedWorkoutStages.workoutId, op.workoutId))
            .orderBy(asc(plannedWorkoutStages.ord));
          const r = retimeOfRow(row, stages, op.durationMinutes, {
            thresholdSecPerKm: thresholdPaceSecPerKm ?? null,
            runWire: opts.runWire ?? "v1",
            weightUnit: prefs.weightUnit,
          });
          if (r.kind !== "retimed" || !sameRetime(r.expect, expected)) {
            out.missed.push(RETIME_CHANGED);
            break;
          }
          await writeRetimed(db, { userId, row, minutes: r.minutes, write: r.write, proposalId, now, thresholdPaceSecPerKm, prefs, runWire: opts.runWire ?? "v1" });
          touchedDates.add(row.effectiveDate);
          out.updated.push(op.workoutId);
          break;
        }
        // A ROW TAKING THE WATCH'S VERSION (watch-copy-marker.ts) TAKES NO LENGTH ALONE (review L1; A3, A4 before it).
        // The next read takes the watch's copy whole, its own length with it, as the athlete asked when they kept it —
        // so a length written here would be undone without a word, while its card said "only the plan's length
        // changes". Refused until that read, in plain words (a change proposed before the Keep included). Re-claiming
        // is no answer either: it would lift the mark and re-send the app's copy — the version the athlete had just
        // chosen against — built from its stage rows (a designed run read back as a coach session, its tempo as
        // threshold, a repeat as nothing, a distance unpushable and the copy taken off the watch).
        if (takesWatchCopy(row.sourceContentFingerprint)) {
          out.missed.push(FOLLOWS_WATCH_VERSION);
          break;
        }
        // The document states the new length — `setting.targetMinutes`, and
        // nothing else of it — as the row's next revision, in the same batch
        // (Stage 1 dual-write; `updateDocColumns` keeps a row resolved
        // meanwhile as it was). A row with no usable document is left with
        // what it has: the backfill derives one.
        const doc = docWithStatedLength(row.workoutDoc, op.durationMinutes);
        await runAtomically(db, [
          db
            .update(plannedWorkouts)
            .set({
              calendarBlockDurationSeconds: op.durationMinutes * 60,
              // The estimate the load maths falls back on moves with the block,
              // or the two would disagree about how long the session is.
              fallbackEstimatedDurationSeconds: op.durationMinutes * 60,
              // …and nothing ahead of it in `source ?? fallback` may still say
              // the old length.
              sourceEstimatedDurationSeconds: null,
              durationEstimate: null,
              // `corosSyncState` is left alone on purpose: no push job is
              // enqueued here, so flipping it to `calendar_only` stranded the
              // row as "not synced" forever. The watch copy is unchanged.
              ...(doc ? updateDocColumns(doc) : {}),
              updatedAt: now,
            })
            .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId))),
          ...(doc ? [revisionInsert(db, { userId, workoutId: op.workoutId, sourceKind: "coach", sourceRef: proposalId, now })] : []),
        ]);
        // A longer or shorter block can collide with its neighbours.
        touchedDates.add(row.effectiveDate);
        out.updated.push(op.workoutId);
        break;
      }
      case "add": {
        // A recurring piece is ONE op carrying N dates (2026-08-17), and it
        // expands HERE — one real planned_workouts row per date, each with
        // its own id, its own calendar block and its own watch write. The
        // vocabulary is what got cheaper; the sessions the athlete approves
        // are exactly the sessions they would have got from N separate adds.
        const added: NewSession[] = [];
        for (const [n, date] of addOpDates(op).entries()) {
          const planId =
            (await activeCoachPlanId(db, userId, op.session, date)) ??
            (await ensureAdhocPlan(db, userId, op.session, date, now));
          // The bucket's span is its contents, so it grows to hold this date
          // whichever way it was resolved. `ensureAdhocPlan`'s own stretch
          // branch could never run for the second one-off: by then the bucket
          // is itself an active plan of that discipline, so `activeCoachPlanId`
          // returns it and the "existing" path is never reached. A bucket
          // minted in August therefore still claimed to end in August after
          // October's one-offs landed in it.
          if (isLoosePlan({ id: planId })) await widenLoosePlan(db, planId, date, now);
          const id = opId(n);
          added.push({ id, planId, date, session: op.session });
          touchedDates.add(date);
          out.created.push(id);
        }
        await insertSessions(db, userId, added, now, sessionOpts);
        break;
      }
      case "reshapeWeek": {
        out.archived.push(...(await archiveWeek(db, userId, op.planId, op.weekStart, now, prefs)));
        const added: NewSession[] = [];
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          added.push({ id, planId: op.planId, date: s.date, session: s.session });
          touchedDates.add(s.date);
          out.created.push(id);
        }
        await insertSessions(db, userId, added, now, sessionOpts);
        break;
      }
      case "firmUp": {
        const added: NewSession[] = [];
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          added.push({ id, planId: op.planId, date: s.date, session: s.session });
          touchedDates.add(s.date);
          out.created.push(id);
        }
        await insertSessions(db, userId, added, now, sessionOpts);
        await db
          .insert(coachPlanWeeks)
          .values({ id: opId("wk"), planId: op.planId, weekStart: op.weekStart, state: "firm", shape: null })
          .onConflictDoUpdate({
            target: [coachPlanWeeks.planId, coachPlanWeeks.weekStart],
            set: { state: "firm", shape: null },
          });
        break;
      }
      case "extendPlan": {
        for (const wk of op.shapeWeeks) {
          await db
            .insert(coachPlanWeeks)
            .values({
              id: `cw-${proposalId}-${i}-${wk.weekStart}`,
              planId: op.planId,
              weekStart: wk.weekStart,
              state: "shape",
              shape: { volumeTarget: wk.volumeTarget, keySessions: wk.keySessions },
            })
            .onConflictDoNothing();
        }
        const lastEnd = addDays(op.shapeWeeks.map((w) => w.weekStart).sort().at(-1)!, 6);
        const [plan] = await db.select().from(coachPlans).where(eq(coachPlans.id, op.planId)).limit(1);
        if (plan && plan.endDate < lastEnd) {
          await db.update(coachPlans).set({ endDate: lastEnd, updatedAt: now }).where(eq(coachPlans.id, op.planId));
        }
        out.updated.push(op.planId);
        break;
      }
      case "windDown": {
        // Taper: clear the affected weeks' unstarted sessions, then insert
        // the gentler replacements.
        const mondays = [...new Set(op.sessions.map((s) => {
          const dow = (new Date(`${s.date}T12:00:00Z`).getUTCDay() + 6) % 7;
          return addDays(s.date, -dow);
        }))];
        for (const monday of mondays) {
          out.archived.push(...(await archiveWeek(db, userId, op.planId, monday, now, prefs)));
        }
        const added: NewSession[] = [];
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          added.push({ id, planId: op.planId, date: s.date, session: s.session });
          touchedDates.add(s.date);
          out.created.push(id);
        }
        await insertSessions(db, userId, added, now, sessionOpts);
        break;
      }
      case "createPlan": {
        const planId = `cp-${proposalId}-${i}`;
        await db
          .insert(coachPlans)
          .values({
            id: planId,
            userId,
            discipline: op.discipline,
            name: op.name,
            status: "active",
            startDate: op.startDate,
            endDate: op.endDate,
            raceDate: op.raceDate ?? null,
            stampPrefix: op.name,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        const added: NewSession[] = [];
        for (const [n, s] of op.firmSessions.entries()) {
          const id = opId(n);
          added.push({ id, planId, date: s.date, session: s.session });
          touchedDates.add(s.date);
          out.created.push(id);
        }
        await insertSessions(db, userId, added, now, sessionOpts);
        for (const wk of op.shapeWeeks) {
          await db
            .insert(coachPlanWeeks)
            .values({
              id: `cw-${proposalId}-${i}-${wk.weekStart}`,
              planId,
              weekStart: wk.weekStart,
              state: "shape",
              shape: { volumeTarget: wk.volumeTarget, keySessions: wk.keySessions },
            })
            .onConflictDoNothing();
        }
        out.created.push(planId);
        break;
      }
      case "retirePlan": {
        // Same authorship guard as archiveWeek: retiring may only ever
        // target a coach-authored plan.
        const [plan] = await db
          .select({ id: coachPlans.id })
          .from(coachPlans)
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, userId)))
          .limit(1);
        if (!plan) {
          // The plan is gone (retired by hand, or never the athlete's). Say so
          // — the alternative, and what this did until 2026-08-17, is a
          // success receipt for an op that touched nothing.
          out.missed.push("the plan it retires isn't there any more, so nothing was retired");
          break;
        }
        const rows = await db
          .select()
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.userId, userId),
              eq(plannedWorkouts.planId, op.planId),
              gte(plannedWorkouts.effectiveDate, today),
              eq(plannedWorkouts.completionState, "scheduled"),
              isNull(plannedWorkouts.archivedAt),
            ),
          );
        if (rows.length > 0) {
          // Chunked: this is EVERY future scheduled session in the plan — a
          // 20-week block at 6 sessions/week is 120 ids, well past D1's ~100
          // bound-variable cap. Unchunked it would fail at approval time.
          for (const ids of chunkIds(rows.map((r) => r.id))) {
            await db
              .update(plannedWorkouts)
              .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
              .where(inArray(plannedWorkouts.id, ids));
          }
          await suppressAndUnpush(db, userId, rows, now, prefs);
          out.archived.push(...rows.map((r) => r.id));
        }
        await db
          .update(coachPlans)
          .set({ status: "retired", updatedAt: now })
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, userId)));
        out.updated.push(op.planId);
        break;
      }
      case "resolveRaceConflict": {
        const resolved = await resolveRaceConflict(db, userId, prefs, op.keep);
        // Approving a proposal after the banner button already converged the
        // dates is a clean no-op — resolveRaceConflict re-checks the data.
        if (resolved) out.updated.push(resolved.workoutId);
        break;
      }
    }
  }

  // ── Placement, last, over every day this apply touched ─────────────────────
  // The SAME pass the importer runs, so the two cannot disagree about where a
  // session sits: a coach add that lands on a day the plan already owns queues
  // up behind it instead of booking a second appointment at the same hour, and
  // a day whose blocks already clear each other is not touched at all. Not
  // reported in the receipt — the athlete approved sessions, and the time of
  // day a filler ends up at is placement, not a mutation they asked about.
  await separateDayCollisions(db, userId, [...touchedDates], prefs, { from: today, now });

  return out;
}

/** The athlete's latest COROS threshold pace — what every pace band an apply writes is anchored on (2026-08-14). */
async function latestThreshold(db: Db, userId: string): Promise<number | null> {
  const [row] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  return row?.v ?? null;
}

// ── Structural ops in resumable chunks (§8 §4, 2026-10-18) ──────────────────

/**
 * A WHOLE PLAN WITHIN A REQUEST'S BUDGET.
 *
 * `applyOps` applies an op whole, and a plan is too big for that: a seven-session `createPlan` measured 68 statements
 * through the approve route against the free plan's 50 an invocation, so it died part way, and a retry started again
 * from op 0. `applyStructuralChunk` applies ONE structural op a slice at a time, each call within the `budget` it is
 * given, and hands back where it got to (`progress`, JSON the caller stores on the op) until it says `done`:
 *
 *  · `createPlan` — the plan row and its shape weeks; then its sessions, a chunk a call; then a `firm` week row for
 *    each week the sessions fill (`plan_horizon` reads them, coach-triggers.ts).
 *  · `firmUp` — the plan read; the sessions in chunks; the week's `firm` row.
 *  · `reshapeWeek`, `windDown` — the plan read; the week(s)' still-scheduled sessions archived a slice at a time; then
 *    the new sessions in chunks.
 *  · `retirePlan` — the plan read; every future still-scheduled session archived a slice at a time; then the plan's
 *    status.
 *  · `extendPlan`, `resolveRaceConflict` — one step each, as in `applyOps`.
 *
 * A plan another hand removed (or never the athlete's) is `refused` in words, never a success for nothing.
 *
 * RETRIED, IT DOES NOTHING TWICE. Every id is the proposal's and the op's (`cw-<proposal>-<op>-<n>`, `cp-…`, the
 * same ids `applyOps` writes), and a progress the caller failed to store is simply met again:
 *
 *  · a chunk of sessions is ONE batch — the rows, their documents' revisions, their stage rows and their watch
 *    creates — so a row that is there is a whole session, and a chunk re-run skips the sessions it finds (one read
 *    for the rows and their days at once). Nothing is half a row;
 *  · an archive slice RE-READS what is still scheduled, and settles each row in one batch — its suppression, its
 *    queued writes, its watch unpush and its archive — before it counts as archived; its suppression's id is the
 *    op's, so a slice re-run writes none twice. The op's own new sessions are never in its slice.
 *
 * A DAY ALREADY GONE GETS NO SESSION (review-1 I2): a plan finished days after it began leaves out the sessions whose
 * days have passed — no row to turn "missed", no watch create for a day gone — and its summary says how many days.
 *
 * BETWEEN TWO CALLS the plan reads sensibly: the plan row and some of its sessions, each whole; a week half
 * archived; the status last.
 *
 * THE BUDGET is statements, counted as they are spent: a batch is its statements, and the reads and the steps that
 * run their own (the day's collision pass, a watch unpush) are counted at their most. A unit is applied when it fits
 * what is left — except a call's FIRST unit, which always runs, so every call moves on: a caller with a leftover calls
 * only when at least STRUCTURAL_MIN_BUDGET is left. `spent` is what the call spent.
 *
 * The context the appliers need beyond the seam's: the athlete's `prefs` (their zone for today, watch writes, units
 * and day windows). The threshold pace is read once per op and kept on its progress.
 */
export const STRUCTURAL_OP_KINDS = [
  "createPlan",
  "extendPlan",
  "windDown",
  "retirePlan",
  "firmUp",
  "reshapeWeek",
  "resolveRaceConflict",
] as const;
export type StructuralOp = Extract<CoachOp, { kind: (typeof STRUCTURAL_OP_KINDS)[number] }>;
export const isStructuralOp = (op: { kind: string }): op is StructuralOp => (STRUCTURAL_OP_KINDS as readonly string[]).includes(op.kind);

/** Where a structural op got to: JSON, stored on the op by the caller and handed back on the next call. */
export type StructuralProgress = { step: string; done: number; [k: string]: unknown };

export type StructuralChunkResult =
  | { status: "more"; progress: StructuralProgress; spent: number }
  /** `summary`: one plain line ("Added “10K block” with 8 sessions"). */
  | { status: "done"; spent: number; summary: string; /** It found nothing to change, and changed nothing (B6). */ unchanged?: true }
  /** `reason`: in words, a whole sentence. */
  | { status: "refused"; reason: string; spent: number };

export interface StructuralChunkInput {
  userId: string;
  proposalId: string;
  opIndex: number;
  /** A structural op (`isStructuralOp`); any other is refused. */
  op: CoachOp;
  /** Null: not started. */
  progress: StructuralProgress | null;
  /** The statements this call may spend (its first unit runs whatever it costs). */
  budget: number;
  now: Date;
  /** The athlete's preferences: their zone (today), watch writes, units, day windows. */
  prefs: UserPreferences;
  /**
   * A training line's "Stop this plan" retiring one of its phases: a phase whose last day has passed (by the account's
   * today, not the page's — a page left open overnight keeps yesterday's) is left as it is, done with nothing changed.
   * Retired, it would leave Past plans and the garden's credit for finishing it (B2).
   */
  stopping?: boolean;
}

/**
 * The least a caller with a leftover should call with: a chunk taking an op over part way reads its plan again first
 * (`planStoppedOrGone`, one statement — before the first unit, which runs whatever it costs: review L3), then a chunk's
 * reads and one session at its ordinary most (the threshold, the rows and days, the stamps; the row, its revision, two
 * stage statements and its watch create; the collision pass's two reads and two of its day's rows moved).
 */
export const STRUCTURAL_MIN_BUDGET = 1 + 3 + 5 + 4;

/** A chunk's sessions read at once: their ids and days bound well under D1's 100 variables. */
const SESSION_WINDOW = 24;
/** An archive slice's rows at most: two suppression statements. */
const ARCHIVE_SLICE_MAX = 36;
/** A watch unpush at its most (`enqueueUnpushIfOurs`): the stamp read, the create job read, the insert. */
const UNPUSH_COST = 3;
/** A programme slot's way off the watch, at its most — never a coach plan's row, counted for safety. */
const PROGRAMME_UNPUSH_COST = 10;
/** `resolveRaceConflict` at its most: the conflict's read and its write — keep "settings": the row's demotion, its coach plan's read and that plan's race moved (`setCoachPlanRace`'s three). */
const RACE_CONFLICT_COST = 6;

interface Chunk {
  db: Db;
  userId: string;
  proposalId: string;
  opIndex: number;
  now: string;
  today: string;
  prefs: UserPreferences;
  writesOn: boolean;
  budget: number;
  spent: number;
  /** `StructuralChunkInput.stopping`. */
  stopping: boolean;
}

type StepResult = { p: StructuralProgress; stalled?: true } | { refused: string };

/** Whether a unit costing `cost` may run: it fits what is left, or it is the call's first. */
const may = (k: Chunk, cost: number, first: boolean): boolean => first || k.spent + cost <= k.budget;

export async function applyStructuralChunk(db: Db, input: StructuralChunkInput): Promise<StructuralChunkResult> {
  const { op } = input;
  if (!isStructuralOp(op)) return { status: "refused", reason: "This change isn't one that shapes a plan.", spent: 0 };
  const k: Chunk = {
    db,
    userId: input.userId,
    proposalId: input.proposalId,
    opIndex: input.opIndex,
    now: input.now.toISOString(),
    today: todayInZone(input.prefs.timezone, input.now),
    prefs: input.prefs,
    writesOn: input.prefs.corosWritesEnabled ?? false,
    budget: input.budget,
    spent: 0,
    stopping: input.stopping ?? false,
  };
  let p: StructuralProgress = input.progress ? { ...input.progress } : { step: "start", done: 0 };
  // A chunk taking over part way (B3): a plan stopped since its first chunk takes no more of it — the stop archived
  // what it had added, and this would add after it. Its first step reads the plan itself (`checkPlan`, extendPlan's own).
  if (p.step !== "start" && p.step !== "done" && op.kind !== "retirePlan" && op.kind !== "resolveRaceConflict") {
    const why = await planStoppedOrGone(k, op);
    if (why) return { status: "refused", reason: why, spent: k.spent };
  }
  // The read above is not a unit of the op's: the call's first unit still runs whatever it costs, so a small budget
  // still moves the op on.
  const base = k.spent;
  // Bounded: every step either moves on or stalls, and a call's budget ends it long before this.
  for (let steps = 0; steps < 1000; steps++) {
    if (p.step === "done") return { status: "done", spent: k.spent, summary: structuralSummary(op, p), ...(p.unchanged === true ? { unchanged: true as const } : {}) };
    if (k.spent > base && k.spent >= k.budget) break;
    const r = await structuralStep(k, op, p, k.spent === base);
    if ("refused" in r) return { status: "refused", reason: r.refused, spent: k.spent };
    p = r.p;
    if (r.stalled) break;
  }
  return { status: "more", progress: p, spent: k.spent };
}

/** Why an op addressed to a plan did nothing: the plan isn't there (removed by hand, or never the athlete's). */
const PLAN_GONE: Record<Exclude<StructuralOp["kind"], "createPlan" | "resolveRaceConflict">, string> = {
  retirePlan: "That plan isn't there any more, so nothing was retired.",
  extendPlan: "That plan isn't there any more, so it wasn't extended.",
  windDown: "That plan isn't there any more, so nothing was eased down.",
  firmUp: "That plan isn't there any more, so no sessions were added.",
  reshapeWeek: "That plan isn't there any more, so the week was left as it was.",
};

/**
 * Why an op that shapes a plan did nothing to one the athlete stopped (B3, as a retired programme refuses its change):
 * a suggestion made before the Stop, approved after it — or a chunk part way when it ran — would bring sessions back
 * onto a plan the athlete ended. A retire stays idempotent: it is never refused for this.
 */
const PLAN_STOPPED: Record<Exclude<StructuralOp["kind"], "resolveRaceConflict" | "retirePlan">, string> = {
  // A new plan stopped while its sessions were still going in (it is on the Plan from its first chunk).
  createPlan: "That plan was stopped, so no more sessions were added.",
  extendPlan: "That plan was stopped, so it wasn't extended.",
  windDown: "That plan was stopped, so nothing was eased down.",
  firmUp: "That plan was stopped, so no sessions were added.",
  reshapeWeek: "That plan was stopped, so the week was left as it was.",
};

/** A plan's status, as a refusal: stopped (any op but a retire). Null while it may be shaped. */
function planStopped(op: StructuralOp, plan: { status: string }): string | null {
  return plan.status === "retired" && op.kind !== "retirePlan" && op.kind !== "resolveRaceConflict" ? PLAN_STOPPED[op.kind] : null;
}

/**
 * A chunk taking an op over part way: its plan read again (one statement), the refusal when it may no longer be shaped
 * — stopped, or gone (a new plan's own row too). Null for an op that names no plan, a retire, and a plan that may be.
 */
async function planStoppedOrGone(k: Chunk, op: StructuralOp): Promise<string | null> {
  if (op.kind === "retirePlan" || op.kind === "resolveRaceConflict") return null;
  const planId = op.kind === "createPlan" ? `cp-${k.proposalId}-${k.opIndex}` : op.planId;
  const [plan] = await k.db
    .select({ status: coachPlans.status })
    .from(coachPlans)
    .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, k.userId)))
    .limit(1);
  k.spent += 1;
  if (!plan) return op.kind === "createPlan" ? "That plan isn't there any more, so no more sessions were added." : PLAN_GONE[op.kind];
  return planStopped(op, plan);
}

async function structuralStep(k: Chunk, op: StructuralOp, p: StructuralProgress, first: boolean): Promise<StepResult> {
  const sessionIdOf = (n: number) => `cw-${k.proposalId}-${k.opIndex}-${n}`;
  switch (op.kind) {
    case "createPlan": {
      const planId = `cp-${k.proposalId}-${k.opIndex}`;
      if (p.step === "start") {
        const stmts = [
          k.db
            .insert(coachPlans)
            .values({
              id: planId,
              userId: k.userId,
              discipline: op.discipline,
              name: op.name,
              status: "active",
              startDate: op.startDate,
              endDate: op.endDate,
              raceDate: op.raceDate ?? null,
              stampPrefix: op.name,
              createdAt: k.now,
              updatedAt: k.now,
            })
            .onConflictDoNothing(),
          ...shapeWeekStatements(k, planId, op.shapeWeeks),
        ];
        if (!may(k, stmts.length, first)) return { p, stalled: true };
        await runAtomically(k.db, stmts);
        k.spent += stmts.length;
        return { p: { ...p, step: "sessions", done: 0, name: op.name } };
      }
      if (p.step === "sessions") return sessionsStep(k, p, planId, op.firmSessions, sessionIdOf, "firm", first);
      if (p.step === "firm") {
        // The weeks the plan's sessions fill are firm — so `plan_horizon` sees where its detail runs out.
        const stmts = firmWeekStatements(k, planId, op.firmSessions.map((s) => s.date), (monday) => `cw-${k.proposalId}-${k.opIndex}-firm-${monday}`);
        if (!may(k, stmts.length, first)) return { p, stalled: true };
        await runAtomically(k.db, stmts);
        k.spent += stmts.length;
        return { p: { ...p, step: "done", done: 0 } };
      }
      break;
    }
    case "firmUp": {
      if (p.step === "start") return checkPlan(k, op, p, op.planId, "sessions", first);
      if (p.step === "sessions") return sessionsStep(k, p, op.planId, op.sessions, sessionIdOf, "firm", first);
      if (p.step === "firm") {
        const stmts = [
          k.db
            .insert(coachPlanWeeks)
            .values({ id: `cw-${k.proposalId}-${k.opIndex}-wk`, planId: op.planId, weekStart: op.weekStart, state: "firm", shape: null })
            .onConflictDoUpdate({ target: [coachPlanWeeks.planId, coachPlanWeeks.weekStart], set: { state: "firm", shape: null } }),
        ];
        if (!may(k, stmts.length, first)) return { p, stalled: true };
        await runAtomically(k.db, stmts);
        k.spent += stmts.length;
        return { p: { ...p, step: "done", done: 0 } };
      }
      break;
    }
    case "reshapeWeek":
    case "windDown": {
      if (p.step === "start") return checkPlan(k, op, p, op.planId, "archive", first);
      if (p.step === "archive") {
        // Taper or rework: the week(s)' unstarted sessions go first — never this op's own new ones (a re-run after
        // its sessions began must not archive them).
        const weeks =
          op.kind === "reshapeWeek" ? [op.weekStart] : [...new Set(op.sessions.map((s) => startOfIsoWeek(s.date)))];
        const own = op.sessions.map((_, n) => sessionIdOf(n));
        return archiveStep(k, p, op.planId, { weeks }, own, "sessions", first);
      }
      if (p.step === "sessions") return sessionsStep(k, p, op.planId, op.sessions, sessionIdOf, "done", first);
      break;
    }
    case "retirePlan": {
      if (p.step === "start") return checkPlan(k, op, p, op.planId, "archive", first);
      // Every future still-scheduled session of the plan — re-read each slice, so one archived since is not counted.
      if (p.step === "archive") return archiveStep(k, p, op.planId, { from: k.today }, [], "status", first);
      if (p.step === "status") {
        if (!may(k, 1, first)) return { p, stalled: true };
        await k.db
          .update(coachPlans)
          .set({ status: "retired", updatedAt: k.now })
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, k.userId)));
        k.spent += 1;
        return { p: { ...p, step: "done", done: 0 } };
      }
      break;
    }
    case "extendPlan": {
      if (p.step === "start") {
        if (!may(k, 1 + 2 + 1, first)) return { p, stalled: true };
        const [plan] = await k.db
          .select({ name: coachPlans.name, endDate: coachPlans.endDate, status: coachPlans.status })
          .from(coachPlans)
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, k.userId)))
          .limit(1);
        k.spent += 1;
        if (!plan) return { refused: PLAN_GONE.extendPlan };
        const stopped = planStopped(op, plan);
        if (stopped) return { refused: stopped };
        const lastEnd = addDays(op.shapeWeeks.map((w) => w.weekStart).sort().at(-1)!, 6);
        const stmts = [
          ...shapeWeekStatements(k, op.planId, op.shapeWeeks),
          ...(plan.endDate < lastEnd
            ? [
                k.db
                  .update(coachPlans)
                  .set({ endDate: lastEnd, updatedAt: k.now })
                  .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, k.userId))),
              ]
            : []),
        ];
        await runAtomically(k.db, stmts);
        k.spent += stmts.length;
        return { p: { ...p, step: "done", done: 0, name: plan.name } };
      }
      break;
    }
    case "resolveRaceConflict": {
      if (p.step === "start") {
        if (!may(k, RACE_CONFLICT_COST, first)) return { p, stalled: true };
        // Approving after the banner already converged the dates is a clean no-op — it re-checks the data.
        const resolved = await resolveRaceConflict(k.db, k.userId, k.prefs, op.keep);
        k.spent += RACE_CONFLICT_COST;
        return { p: { ...p, step: "done", done: 0, resolved: resolved !== null, ...(resolved === null ? { unchanged: true } : {}) } };
      }
      break;
    }
  }
  // A progress this op never writes: start it over (every step is idempotent).
  return { p: { step: "start", done: 0 } };
}

/**
 * The plan an op names, the athlete's: its name kept for the summary, or the op refused in words — gone, or stopped
 * (any op but a retire, B3). A Stop's retire of a phase that has already ended is done there, nothing changed (B2).
 * One read.
 */
async function checkPlan(
  k: Chunk,
  op: Extract<StructuralOp, { planId: string }>,
  p: StructuralProgress,
  planId: string,
  next: string,
  first: boolean,
): Promise<StepResult> {
  if (!may(k, 1, first)) return { p, stalled: true };
  const [plan] = await k.db
    .select({ name: coachPlans.name, status: coachPlans.status, endDate: coachPlans.endDate })
    .from(coachPlans)
    .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, k.userId)))
    .limit(1);
  k.spent += 1;
  if (!plan) return { refused: PLAN_GONE[op.kind] };
  const stopped = planStopped(op, plan);
  if (stopped) return { refused: stopped };
  if (k.stopping && op.kind === "retirePlan" && plan.endDate < k.today) return { p: { ...p, step: "done", done: 0, name: plan.name, ended: true, unchanged: true } };
  return { p: { ...p, step: next, done: 0, name: plan.name } };
}

/** A plan's shape weeks, as insert statements that skip a week already written (ids the op's own). */
function shapeWeekStatements(k: Chunk, planId: string, weeks: readonly { weekStart: string; volumeTarget: string; keySessions: string[] }[]) {
  const rows = weeks.map((wk) => ({
    id: `cw-${k.proposalId}-${k.opIndex}-${wk.weekStart}`,
    planId,
    weekStart: wk.weekStart,
    state: "shape",
    shape: { volumeTarget: wk.volumeTarget, keySessions: wk.keySessions },
  }));
  return insertBatches(rows).map((batch) => k.db.insert(coachPlanWeeks).values(batch).onConflictDoNothing());
}

/** A `firm` week row for every week these days fall in — a shape row for the week becomes firm. */
function firmWeekStatements(k: Chunk, planId: string, dates: readonly string[], idOf: (monday: string) => string) {
  const mondays = [...new Set(dates.map((d) => startOfIsoWeek(d)))].sort();
  const rows = mondays.map((monday) => ({ id: idOf(monday), planId, weekStart: monday, state: "firm", shape: null }));
  return insertBatches(rows).map((batch) =>
    k.db
      .insert(coachPlanWeeks)
      .values(batch)
      .onConflictDoUpdate({ target: [coachPlanWeeks.planId, coachPlanWeeks.weekStart], set: { state: "firm", shape: null } }),
  );
}

/** A row the day's collision pass places (`separateDayCollisions`' own filter): live, scheduled, not a rest day. */
const placeable = (r: { archivedAt: string | null; completionState: string; category: string; effectiveDate: string }, today: string) =>
  r.archivedAt === null && r.completionState === "scheduled" && r.category !== "rest" && r.effectiveDate >= today;

/** The collision pass over these days at its most: nothing when no day holds two sessions; else its two reads and
 * every session on each such day moved. */
function placementCost(live: ReadonlyMap<string, number>, days: ReadonlySet<string>): number {
  const colliding = [...days].filter((d) => (live.get(d) ?? 0) >= 2);
  return colliding.length === 0 ? 0 : 2 + colliding.reduce((sum, d) => sum + live.get(d)!, 0);
}

/** The statements a session's insert costs in a chunk's batch: its row, its stage rows, its watch create. */
function sessionUnitCost(k: Chunk, session: CoachSession, threshold: number | null): number {
  const stages = insertBatches(coachStageRows("x", session, threshold ?? undefined)).length;
  return 1 + stages + (k.writesOn && watchPushable(session) ? 1 : 0);
}

/**
 * The next chunk of an op's sessions, from `p.done`: ONE batch for the rows, their revisions, their stage rows and
 * their watch creates (each under the next free stamp of its day), then the collision pass over the days it touched.
 * A session whose row is there already (a chunk re-run) is skipped whole.
 */
async function sessionsStep(
  k: Chunk,
  p: StructuralProgress,
  planId: string,
  sessions: readonly { date: string; session: CoachSession }[],
  idOf: (n: number) => string,
  next: string,
  first: boolean,
): Promise<StepResult> {
  if (p.done >= sessions.length) return { p: { ...p, step: next, done: 0 } };
  let threshold = p.threshold as number | null | undefined;
  if (threshold === undefined) {
    if (!may(k, 1, first)) return { p, stalled: true };
    threshold = await latestThreshold(k.db, k.userId);
    k.spent += 1;
    p = { ...p, threshold };
  }
  const window = sessions.slice(p.done, p.done + SESSION_WINDOW).map((s, n) => ({ ...s, id: idOf(p.done + n) }));
  // The reads, and the first session at its own cost, must fit (a call's first unit aside).
  if (!may(k, 3 + sessionUnitCost(k, window[0]!.session, threshold), first)) return { p, stalled: true };
  const ids = window.map((w) => w.id);
  const days = [...new Set(window.map((w) => w.date))];
  const seen = await k.db
    .select({
      id: plannedWorkouts.id,
      effectiveDate: plannedWorkouts.effectiveDate,
      archivedAt: plannedWorkouts.archivedAt,
      completionState: plannedWorkouts.completionState,
      category: plannedWorkouts.category,
    })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, k.userId), or(inArray(plannedWorkouts.id, ids), inArray(plannedWorkouts.effectiveDate, days))));
  k.spent += 1;
  const there = new Set(seen.map((r) => r.id));
  const live = new Map<string, number>();
  for (const r of seen) {
    if (days.includes(r.effectiveDate) && placeable(r, k.today)) live.set(r.effectiveDate, (live.get(r.effectiveDate) ?? 0) + 1);
  }
  // A day already gone (a plan finished days after it began — review-1 I2) gets no session: a row there would only
  // turn "missed", and its watch create would put a day that has passed on the watch.
  const gone = (w: { id: string; date: string }) => !there.has(w.id) && w.date < k.today;
  const pushDays = [...new Set(window.filter((w) => !there.has(w.id) && !gone(w) && k.writesOn && watchPushable(w.session)).map((w) => w.date))];
  let taken = new Map<string, Set<string>>();
  if (pushDays.length > 0) {
    taken = await takenStampsOnDays(k.db, k.userId, pushDays);
    k.spent += 1;
  }

  const picked: typeof window = [];
  const touched = new Set<string>();
  const passed: string[] = [];
  let units = 0;
  let done = p.done;
  for (const w of window) {
    if (gone(w)) {
      passed.push(w.date);
      done += 1;
      continue;
    }
    const isNew = !there.has(w.id);
    const liveAfter = new Map(live);
    if (isNew && placeable({ archivedAt: null, completionState: "scheduled", category: w.session.category, effectiveDate: w.date }, k.today)) {
      liveAfter.set(w.date, (liveAfter.get(w.date) ?? 0) + 1);
    }
    const unit = isNew ? sessionUnitCost(k, w.session, threshold) : 0;
    const revision = isNew && picked.length === 0 ? 1 : 0;
    const cost = units + unit + revision + (picked.length > 0 ? 1 : 0) + placementCost(liveAfter, new Set([...touched, w.date]));
    // The call's first unit always runs (a day gone is no unit: it costs nothing).
    if (!(first && touched.size === 0) && k.spent + cost > k.budget) break;
    if (isNew) {
      picked.push(w);
      units += unit;
      for (const [d, n] of liveAfter) live.set(d, n);
    }
    touched.add(w.date);
    done += 1;
  }
  if (done === p.done) return { p, stalled: true };
  if (passed.length > 0) p = { ...p, passedDays: [...new Set([...daysPassed(p), ...passed])].sort(), passed: sessionsPassed(p) + passed.length };

  const threshold_ = threshold ?? undefined;
  const rows = picked.map((w) => sessionRowInsert(k.db, k.userId, { id: w.id, planId, date: w.date, session: w.session }, k.now, { prefs: k.prefs, thresholdPaceSecPerKm: threshold_ }));
  const watch = [];
  for (const w of picked) {
    if (!k.writesOn || !watchPushable(w.session)) continue;
    // The stamp is unique per day across both lanes (ruling 3-R12) — this chunk's own sessions of the day included.
    const dayTaken = taken.get(w.date) ?? new Set<string>();
    const name = coachStamp(w.session.title, w.date, dayTaken);
    dayTaken.add(name);
    taken.set(w.date, dayTaken);
    watch.push(k.db.insert(corosWriteJobs).values(watchCreateValues(k.userId, w.id, w.date, w.session, k.now, name, threshold_)).onConflictDoNothing());
  }
  const stmts = [
    ...rows.map((r) => r.insert),
    ...revisionInserts(k.db, {
      userId: k.userId,
      workoutIds: rows.filter((r) => r.doc !== null).map((r) => r.id),
      sourceKind: "coach",
      sourceRef: k.proposalId,
      now: k.now,
    }),
    ...picked.flatMap((w) =>
      insertBatches(coachStageRows(w.id, w.session, threshold_)).map((batch) => k.db.insert(plannedWorkoutStages).values(batch).onConflictDoNothing()),
    ),
    ...watch,
  ];
  if (stmts.length > 0) {
    await runAtomically(k.db, stmts);
    k.spent += stmts.length;
  }
  // Placement, over every day the chunk touched — the same pass the importer runs, so two sessions never share an
  // hour; nothing to do (and nothing read) when no day holds two.
  const placing = placementCost(live, touched);
  if (placing > 0) {
    await separateDayCollisions(k.db, k.userId, [...touched], k.prefs, { from: k.today, now: k.now });
    k.spent += placing;
  }
  return { p: done >= sessions.length ? { ...p, step: next, done: 0 } : { ...p, done } };
}

/** One archive slice, then on to `next` once nothing in scope is still scheduled. */
async function archiveStep(
  k: Chunk,
  p: StructuralProgress,
  planId: string,
  scope: { from: string } | { weeks: readonly string[] },
  exclude: readonly string[],
  next: string,
  first: boolean,
): Promise<StepResult> {
  const r = await archiveSlice(k, planId, scope, exclude, first);
  if (r === "stalled") return { p, stalled: true };
  const archived = (typeof p.archived === "number" ? p.archived : 0) + r.archived;
  return { p: r.more ? { ...p, archived, done: p.done + r.archived } : { ...p, step: next, done: 0, archived } };
}

/**
 * Archive the plan's still-scheduled sessions in scope, as many as the budget holds: re-read each slice. ONE batch —
 * each row's suppression (id the op's own), its queued watch writes settled, its watch unpush (id the row's), the
 * archive — so a slice that dies leaves nothing half-done, and a slice re-run finds the rows it finished gone.
 */
async function archiveSlice(
  k: Chunk,
  planId: string,
  scope: { from: string } | { weeks: readonly string[] },
  exclude: readonly string[],
  first: boolean,
): Promise<{ archived: number; more: boolean } | "stalled"> {
  if ("weeks" in scope && scope.weeks.length === 0) return { archived: 0, more: false };
  if (!may(k, 4, first)) return "stalled";
  const limit = Math.max(1, Math.min(ARCHIVE_SLICE_MAX, k.budget - k.spent - 4));
  const inScope =
    "from" in scope
      ? gte(plannedWorkouts.effectiveDate, scope.from)
      : or(...scope.weeks.map((m) => and(gte(plannedWorkouts.effectiveDate, m), lte(plannedWorkouts.effectiveDate, addDays(m, 6)))));
  const rows = await k.db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, k.userId),
        eq(plannedWorkouts.planId, planId),
        eq(plannedWorkouts.completionState, "scheduled"),
        // A row already archived (a re-run, or the athlete's own remove) is not archived — nor suppressed — twice.
        isNull(plannedWorkouts.archivedAt),
        inScope,
        ...(exclude.length > 0 ? [notInArray(plannedWorkouts.id, [...exclude])] : []),
      ),
    )
    .orderBy(plannedWorkouts.effectiveDate, plannedWorkouts.id)
    .limit(limit + 1);
  k.spent += 1;
  if (rows.length === 0) return { archived: 0, more: false };

  const unpushCost = (w: typeof plannedWorkouts.$inferSelect): number =>
    appAuthoredRow(w) ? PROGRAMME_UNPUSH_COST : k.writesOn && watchAddressOf(w) ? UNPUSH_COST : 0;
  const batchCost = (n: number) => Math.ceil(n / 18) + 2 * Math.ceil(n / 90);
  const picked: (typeof rows)[number][] = [];
  let unpushing = 0;
  for (const w of rows.slice(0, limit)) {
    const cost = batchCost(picked.length + 1) + unpushing + unpushCost(w);
    if (!(first && picked.length === 0) && k.spent + cost > k.budget) break;
    picked.push(w);
    unpushing += unpushCost(w);
  }
  if (picked.length === 0) return "stalled";

  // Each row's watch unpush is a statement IN the archive's batch (review-1): a request that dies before the batch
  // leaves no delete queued for a session still on the plan, and one that dies after leaves none owed. A sent
  // programme slot's own way off (never a coach plan's row) runs its own writes, so it goes first, as before.
  const unpushes = [];
  for (const w of picked) {
    if (unpushCost(w) === 0) continue;
    if (appAuthoredRow(w)) {
      await enqueueUnpushIfOurs(k.db, k.userId, w, k.now, k.prefs);
      continue;
    }
    const unpush = await unpushInsertIfOurs(k.db, k.userId, w, k.now, k.prefs);
    if (unpush) unpushes.push(unpush.insert);
  }
  const ids = picked.map((w) => w.id);
  const suppressions = picked.map((w) => ({
    id: `sup-${k.proposalId}-${k.opIndex}-${w.id}`,
    workoutId: w.id,
    eventId: null,
    reason: "user_removed",
    createdAt: k.now,
  }));
  const stmts = [
    ...insertBatches(suppressions).map((batch) => k.db.insert(calendarEventSuppressions).values(batch).onConflictDoNothing()),
    ...settleWatchJobsOnArchiveStatements(k.db, k.userId, ids, k.now),
    ...unpushes,
    ...chunkIds(ids).map((chunk) =>
      k.db
        .update(plannedWorkouts)
        .set({ archivedAt: k.now, archiveReason: "user_removed", updatedAt: k.now })
        .where(and(eq(plannedWorkouts.userId, k.userId), inArray(plannedWorkouts.id, chunk))),
    ),
  ];
  await runAtomically(k.db, stmts);
  // The batch as run, and the unpushes' reads at their most (their inserts are in the batch).
  k.spent += stmts.length + unpushing - unpushes.length;
  return { archived: picked.length, more: rows.length > picked.length };
}

const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The days a plan's sessions were left out on because they had passed (review-1 I2), and how many sessions. */
const daysPassed = (p: StructuralProgress): string[] => (Array.isArray(p.passedDays) ? (p.passedDays as string[]) : []);
const sessionsPassed = (p: StructuralProgress): number => (typeof p.passed === "number" ? p.passed : 0);
/** What the summary adds for them: " — 3 days had passed and were left out", or nothing. */
function passedNote(p: StructuralProgress): string {
  const days = daysPassed(p).length;
  if (days === 0) return "";
  return ` — ${countOf(days, "day")} had passed and ${days === 1 ? "was" : "were"} left out`;
}

/** What a finished structural op did, in one plain line. */
function structuralSummary(op: StructuralOp, p: StructuralProgress): string {
  const name = `“${typeof p.name === "string" ? p.name : "your plan"}”`;
  const archived = typeof p.archived === "number" ? p.archived : 0;
  /** The sessions it put on the plan: those whose days had passed are not among them. */
  const added = (all: number) => all - sessionsPassed(p);
  switch (op.kind) {
    case "createPlan": {
      const n = added(op.firmSessions.length);
      const parts = [
        n > 0 ? countOf(n, "session") : null,
        op.shapeWeeks.length > 0 ? `${countOf(op.shapeWeeks.length, "week")} sketched out` : null,
      ].filter((x): x is string => x !== null);
      return (parts.length > 0 ? `Added “${op.name}” with ${parts.join(" and ")}` : `Added “${op.name}”`) + passedNote(p);
    }
    case "firmUp":
      return `Added ${countOf(added(op.sessions.length), "session")} to ${name}${passedNote(p)}`;
    case "reshapeWeek": {
      const n = added(op.sessions.length);
      return (n > 0 ? `Reworked a week of ${name} with ${countOf(n, "session")}` : `Cleared a week of ${name}`) + passedNote(p);
    }
    case "windDown": {
      const n = added(op.sessions.length);
      return (n > 0 ? `Eased ${name} down with ${countOf(n, "gentler session")}` : `Eased ${name} down`) + passedNote(p);
    }
    case "retirePlan":
      if (p.ended === true) return `${name} had already ended, so it was left as it was`;
      return archived > 0 ? `Retired ${name} and took ${countOf(archived, "session")} off your plan` : `Retired ${name}`;
    case "extendPlan":
      return `Extended ${name} by ${countOf(op.shapeWeeks.length, "week")}`;
    case "resolveRaceConflict":
      if (p.resolved === false) return "Your race day and your plan already agree";
      return op.keep === "plan" ? "Your race day now follows your plan" : "Your plan now follows your race day";
  }
}

/** A bucket's span is a report on its contents, not a plan: it widens in both
 * directions to cover every one-off filed in it. (Its dates were also only ever
 * pushed forward, so a one-off dated before the bucket's first left the row
 * claiming a start after the session it holds.) */
async function widenLoosePlan(db: Db, planId: string, date: string, now: string): Promise<void> {
  const [p] = await db.select().from(coachPlans).where(eq(coachPlans.id, planId)).limit(1);
  if (!p) return;
  const startDate = date < p.startDate ? date : p.startDate;
  const endDate = date > p.endDate ? date : p.endDate;
  if (startDate === p.startDate && endDate === p.endDate && p.status === "active") return;
  await db
    .update(coachPlans)
    .set({ startDate, endDate, status: "active", updatedAt: now })
    .where(eq(coachPlans.id, planId));
}

/**
 * A REAL plan row for coach adds that land outside any active plan — the old
 * phantom "coach-adhoc" id existed in no table and orphaned every join that
 * resolves plan name/status (audit#3 D8). One bucket per discipline per user;
 * `widenLoosePlan` keeps its span over whatever gets filed in it.
 */
async function ensureAdhocPlan(
  db: Db,
  userId: string,
  session: CoachSession,
  date: string,
  now: string,
): Promise<string> {
  // Plan buckets follow the session's discipline, so a mobility one-off
  // never lands in (and stretches) the running plan.
  const discipline = planDisciplineOf(session);
  const id = `adhoc-${discipline}-${userId.slice(0, 8)}`;
  const [existing] = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.id, id), eq(coachPlans.userId, userId)))
    .limit(1);
  if (existing) {
    if (existing.endDate < date || existing.status !== "active") {
      await db
        .update(coachPlans)
        .set({ endDate: existing.endDate < date ? date : existing.endDate, status: "active", updatedAt: now })
        .where(eq(coachPlans.id, id));
    }
    return id;
  }
  await db
    .insert(coachPlans)
    .values({
      id,
      userId,
      discipline,
      name: "Coach one-offs",
      status: "active",
      startDate: date,
      endDate: date,
      stampPrefix: "Coach one-offs",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return id;
}

/** The active coach BLOCK matching the session's discipline that covers this
 * date, if any — otherwise the caller files the session in the discipline's
 * loose-session bucket.
 *
 * This used to be an unordered `limit 1` over every active plan of the
 * discipline, so once a bucket existed the two rows raced: a session inside a
 * real block's span could be filed in the bucket, and a session months outside
 * every block's span could be filed in a block, purely on row order. A block
 * owns the dates it planned; everything else is loose. */
async function activeCoachPlanId(
  db: Db,
  userId: string,
  session: CoachSession,
  date: string,
): Promise<string | null> {
  // Plan buckets follow the session's discipline, so a mobility one-off
  // never lands in (and stretches) the running plan.
  const discipline = planDisciplineOf(session);
  const plans = await db
    .select({ id: coachPlans.id, startDate: coachPlans.startDate, endDate: coachPlans.endDate })
    .from(coachPlans)
    .where(
      and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"), eq(coachPlans.discipline, discipline)),
    );
  const covering = plans
    .filter((p) => !isLoosePlan(p) && p.startDate <= date && date <= p.endDate)
    .sort(
      (a, b) =>
        Date.parse(b.endDate) - Date.parse(b.startDate) - (Date.parse(a.endDate) - Date.parse(a.startDate)) ||
        a.id.localeCompare(b.id),
    )[0];
  return covering?.id ?? null;
}
