import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  calendarEventSuppressions,
  coachPlanWeeks,
  coachPlans,
  coachProposals,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  addOpDates,
  sessionSummaryLine,
  newId,
  humanizeWorkoutTitle,
  nowInstant,
  paceBandFor,
  sessionExercises,
  sessionSport,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import { runBlockRoles } from "@rg/coros";
import { chunkIds, chunkedInsert, type Db } from "./db.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { recordedStampFor, stampName } from "./coros-stamp.js";
import { applyMove } from "./jobs.js";
import { openIntentFor, recordIntent } from "./sync-intents.js";
import { resolveRaceConflict } from "./race-conflict.js";
import { isLoosePlan } from "./coach-plans.js";

/**
 * Approval → deterministic mutations (spec §7). No LLM here, ever. All row
 * ids derive from the proposal id, so re-applying (crash, retry, double
 * click) is idempotent. Watch mirroring stays honest: rows the coach
 * creates/rewrites are `calendar_only` until a push lane verifies them
 * (writes-OFF era default; the push generalization rides Task A10+).
 */

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
  const blocks = session.run?.blocks ?? [];
  if (blocks.length === 0) return;
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
  const roles = runBlockRoles(blocks);
  const stageRows = blocks.map((b, i) => {
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
  await chunkedInsert(stageRows, (batch) => db.insert(plannedWorkoutStages).values(batch));
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
export function watchPushable(session: CoachSession): boolean {
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

async function insertSession(
  db: Db,
  userId: string,
  planId: string,
  id: string,
  date: string,
  session: CoachSession,
  now: string,
  opts: { corosWritesEnabled?: boolean; prefs?: UserPreferences; thresholdPaceSecPerKm?: number } = {},
): Promise<void> {
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
  await db
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
    })
    .onConflictDoNothing();

  await writeStages(db, id, session, opts.thresholdPaceSecPerKm);

  // Coach adds reach the WATCH (user requirement 2026-08-12): duration-block
  // run sessions ride the same verified create pipeline as studio pushes.
  // The stored state stays calendar_only until the executor verifies; the
  // pending job already renders as "syncing" through deriveWorkoutSync.
  if (opts.corosWritesEnabled) {
    await enqueueWatchCreate(db, userId, id, date, session, now, opts.thresholdPaceSecPerKm);
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
  session: CoachSession,
  now: string,
  thresholdPaceSecPerKm?: number,
  /** A human is asking again — retry a job of this id that previously failed.
   *  Set only by `POST /api/sync/push-absent`; the live add path must not
   *  re-drive a write that already refused. Same reasoning as
   *  `enqueueContentConvergence`'s `reviveFailed`. */
  reviveFailed = false,
): Promise<string | null> {
  if (!watchPushable(session)) return null;
  const jobId = `${id}-push`;
  {
    const insert = db
      .insert(corosWriteJobs)
      .values({
        id: jobId,
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
          name: stampName(session.title, date),
          session,
          ...(thresholdPaceSecPerKm ? { thresholdPaceSecPerKm } : {}),
        },
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      });
    // Re-applying an approve must be idempotent (audit#2 #13) — the
    // deterministic id makes skip-on-conflict exactly right.
    await (reviveFailed
      ? insert.onConflictDoUpdate({
          target: corosWriteJobs.id,
          setWhere: eq(corosWriteJobs.status, "failed"),
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
              name: stampName(session.title, date),
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

// ── Convergence: keeping the watch's copy equal to the app's ────────────────

/**
 * The address COROS is holding a session at, when the row can prove one.
 *
 * Every field is a CLAIM the executor re-proves; this function's whole job is to
 * refuse to produce a half-address. `sourceWorkoutId` is `${corosPlanId}:${idInPlan}`
 * for a wire row and the row's own uuid for an app-authored one, so the shape
 * test is what separates "COROS has this" from "the app made this up".
 *
 * `lastVerifiedCorosDate` is required and is the interesting half: `""` means
 * COROS has never confirmed this row (audit#2 #1), and a rewrite addressed at a
 * day COROS never put the session on is a rewrite aimed at nothing.
 */
export interface WatchAddress {
  corosPlanId: string;
  idInPlan: string;
  programId: string;
  happenDay: string;
}

export function watchAddressOf(w: {
  sourceWorkoutId: string | null;
  sourceIdInPlan: string | null;
  sourceProgramId: string | null;
  lastVerifiedCorosDate: string;
}): WatchAddress | null {
  if (!w.sourceWorkoutId || !/^\d+:\d+$/.test(w.sourceWorkoutId)) return null;
  if (!w.sourceIdInPlan || !w.sourceProgramId) return null;
  if (!w.lastVerifiedCorosDate) return null;
  return {
    corosPlanId: w.sourceWorkoutId.split(":")[0]!,
    idInPlan: w.sourceIdInPlan,
    programId: w.sourceProgramId,
    happenDay: w.lastVerifiedCorosDate,
  };
}

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
    /** What the app now prescribes. */
    session: CoachSession;
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
    now: string;
    corosWritesEnabled: boolean;
    thresholdPaceSecPerKm?: number;
  },
): Promise<ConvergeOutcome> {
  if (!v.corosWritesEnabled) return { refused: "writes_disabled" };
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

  if (!watchPushable(v.session)) {
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

  const jobId = `${v.workout.id}-content-${from}-${to}`;
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
        name:
          proof.kind === "stamp"
            ? stampName(v.session.title, address.happenDay)
            : v.session.title,
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
        // Only a FAILED row is revived. A queued job is already going to run and
        // resetting it would drop an in-flight claim; a verified one is done and
        // re-running it would rewrite the watch with nobody asking.
        setWhere: eq(corosWriteJobs.status, "failed"),
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
    if (!prefs.corosWritesEnabled) continue;
    // ADDRESS, NOT SYNC STATE. This gate used to read `corosSyncState !==
    // "synced"`, and that column is not a statement about whether COROS holds
    // the row — it is a statement about whether the two agree. An eased session
    // is `calendar_only` (correctly: COROS has the OLD body) while still sitting
    // on the athlete's watch, so archiving one skipped the unpush and left the
    // pre-ease intervals scheduled on the watch permanently, inside the very
    // code path that exists to stop exactly that (audit#3 D2). `content_stale`
    // and `sync_issue` had the same hole. The address is the durable fact.
    const address = watchAddressOf(w);
    if (!address) continue;
    // The delete triple's stamp is the exact program name we last wrote, which
    // is never persisted on the row — read it back off this account's own
    // settled write jobs (a rewrite renames, so the newest one wins).
    const stamp = await recordedStampFor(db, userId, w.id);
    if (!stamp) continue;
    const [createJob] = await db
      .select({ expectedContentFingerprint: corosWriteJobs.expectedContentFingerprint })
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.id, `${w.id}-push`))
      .limit(1);
    await db
      .insert(corosWriteJobs)
      .values({
        id: `${w.id}-unpush`,
        userId,
        workoutId: w.id,
        kind: "coach_delete_workout",
        expectedContentFingerprint: createJob?.expectedContentFingerprint ?? "",
        originalDate: w.effectiveDate,
        destinationDate: w.effectiveDate,
        payload: {
          workoutId: w.id,
          happenDay: address.happenDay,
          name: stamp,
          idInPlan: address.idInPlan,
          programId: address.programId,
          corosPlanId: address.corosPlanId,
        },
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      })
      .onConflictDoNothing();
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

/**
 * WHICH OPS CAN LEAVE COROS HOLDING SOMETHING THE APP NO LONGER PRESCRIBES —
 * audited op by op (2026-08-17), because "ease is the one that bit" is a
 * finding about one bug, not a statement about the vocabulary.
 *
 *  · `ease` — YES, and it is the only in-place content rewrite in the file. It
 *    updates an existing row's every session-decided column. Converged above.
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
): Promise<ApplyResult> {
  const now = nowInstant();
  const today = todayInZone(prefs.timezone);
  // One read for the whole proposal: the athlete's latest COROS threshold
  // anchors every pace band this apply writes (2026-08-14).
  const [thresholdRow] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  const thresholdPaceSecPerKm = thresholdRow?.v ?? undefined;
  const out: ApplyResult = { created: [], updated: [], archived: [], missed: [] };

  // ── Before-state snapshot (manifest 0019) ────────────────────────────
  // "What it did" must keep its true befores after the plan moves on: the
  // settled card used to recompute them from the post-apply plan, which
  // rendered every applied ease as X → X. Captured BEFORE any op touches a
  // row, written to the proposal so history can never drift again.
  const touchedIds = [
    ...new Set(
      ops.flatMap((o) =>
        o.kind === "ease" || o.kind === "move" || o.kind === "skip" ? [o.workoutId] : [],
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
      .set({ appliedRefs })
      .where(and(eq(coachProposals.id, proposalId), eq(coachProposals.userId, userId)));
  }
  /** Every day this apply put a session on, changed the length of, or moved one
   * to. Handed to `separateDayCollisions` at the end so the athlete never
   * approves a proposal that books two appointments at the same hour. */
  const touchedDates = new Set<string>();

  for (let i = 0; i < ops.length; i++) {
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
        const [target] = await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)))
          .limit(1);
        if (!target) {
          // Same class of silent failure `missed` was invented for: the row
          // can go between the wake that proposed the ease and the tap that
          // approves it, and an update matching nothing returned a success
          // receipt for a session that was never changed.
          out.missed.push("the session it eases isn't on the calendar any more, so nothing was changed");
          break;
        }
        // An ease REPLACES the session, so it writes exactly what a fresh
        // insert writes — one writer, no parallel column list to fall behind.
        await db
          .update(plannedWorkouts)
          .set({ ...sessionColumns(op.session), updatedAt: now })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
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
        const [w] = await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)))
          .limit(1);
        if (w && w.effectiveDate !== op.toDate) {
          await applyMove(db, {
            userId,
            workoutId: op.workoutId,
            toDate: op.toDate,
            toTime: w.effectiveTime,
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
        // Coach-sanctioned: the garden treats it as agreed rest (spec §1).
        await db
          .update(plannedWorkouts)
          .set({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach", updatedAt: now })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
        out.updated.push(op.workoutId);
        break;
      }
      case "add": {
        // A recurring piece is ONE op carrying N dates (2026-08-17), and it
        // expands HERE — one real planned_workouts row per date, each with
        // its own id, its own calendar block and its own watch write. The
        // vocabulary is what got cheaper; the sessions the athlete approves
        // are exactly the sessions they would have got from N separate adds.
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
          await insertSession(db, userId, planId, id, date, op.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          touchedDates.add(date);
          out.created.push(id);
        }
        break;
      }
      case "reshapeWeek": {
        out.archived.push(...(await archiveWeek(db, userId, op.planId, op.weekStart, now, prefs)));
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          touchedDates.add(s.date);
          out.created.push(id);
        }
        break;
      }
      case "firmUp": {
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          touchedDates.add(s.date);
          out.created.push(id);
        }
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
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          touchedDates.add(s.date);
          out.created.push(id);
        }
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
        for (const [n, s] of op.firmSessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          touchedDates.add(s.date);
          out.created.push(id);
        }
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
