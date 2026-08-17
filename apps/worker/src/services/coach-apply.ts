import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  calendarEventSuppressions,
  coachPlanWeeks,
  coachPlans,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  addOpDates,
  formatExerciseBlock,
  formatStageDuration,
  newId,
  nowInstant,
  paceBandFor,
  sessionExercises,
  sessionSport,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import { chunkIds, chunkedInsert, type Db } from "./db.js";
import { stampName } from "./coros-stamp.js";
import { applyMove } from "./jobs.js";
import { recordIntent } from "./sync-intents.js";
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

function stageSummary(s: CoachSession): string {
  if (s.run && s.run.blocks.length > 0) {
    // `formatStageDuration`, like the imported summaries this column also
    // holds: coach rows and COROS rows sit in the same Today card and the same
    // week list, and "40min easy" beside "40 min Training" is two products on
    // one screen. A duration block's `value` is MINUTES on the wire.
    return s.run.blocks
      .map(
        (b) =>
          `${b.kind === "duration" ? formatStageDuration(b.value * 60) : `${(b.value / 1000).toFixed(1)}km`}${b.intensity ? ` ${b.intensity}` : ""}`,
      )
      .join(" · ");
  }
  // One formatter, shared with the session sheet (domain/coach.ts) — a hold
  // must never render as "Wall sit 3×undefined", which is what the old
  // `${e.sets}×${e.reps}` produced the moment reps became optional.
  //
  // An EMPTY body ("strength Friday, movements on the day") falls through to
  // the title, exactly as a bodyless session does: since 2026-08-17 an empty
  // exercise list and an absent one parse alike, so they must also read alike.
  const block = s.lift ?? s.mobility;
  if (block && block.exercises.length > 0) return formatExerciseBlock(block);
  return s.title;
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
 */
function sessionColumns(session: CoachSession) {
  const body = session.lift ?? session.mobility;
  return {
    title: session.title,
    category: session.category,
    qualitySubtype: null,
    sport: sessionSport(session),
    sourceContentFingerprint: fingerprint(session),
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
async function writeStages(
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
  const stageRows = blocks.map((b, i) => {
    const band = paceBandFor(b.intensity, thresholdPaceSecPerKm);
    return {
      id: `${workoutId}:${i}`,
      workoutId,
      parentStageId: null,
      ord: i,
      kind: i === 0 && blocks.length >= 2 ? "warmup" : "work",
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
  await chunkedInsert(stageRows, 15, (batch) => db.insert(plannedWorkoutStages).values(batch));
}

/** A session the create executor can put on the watch today: a run whose
 * blocks are all DURATION-based (distance targets are not spike-verified on
 * the wire — create-executor.ts refuses them).
 *
 * Lift and mobility sessions are app-only regardless of catalog resolution:
 * the coach create executor builds a structured RUN program and nothing
 * else (coros-write-cloud.ts → buildRunProgram). Resolving an exercise to a
 * catalog originId is what would MAKE a strength push possible later; it is
 * not what makes one happen today, and this predicate must not claim
 * otherwise. `offCatalogExercises` carries the per-exercise truth. */
export function watchPushable(session: CoachSession): boolean {
  return (
    !!session.run &&
    session.run.blocks.length > 0 &&
    session.run.blocks.every((b) => b.kind === "duration")
  );
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
  // Land in the athlete's own slot, not a hardcoded dawn (audit#2 #15).
  const window = session.category === "long" || session.category === "race" ? "morning" : (opts.prefs?.defaultWindow ?? "morning");
  const isWeekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const effectiveTime = opts.prefs
    ? window === "evening"
      ? opts.prefs.weekdayEveningTime
      : isWeekend
        ? opts.prefs.weekendMorningTime
        : opts.prefs.weekdayMorningTime
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
    })
    .onConflictDoNothing();

  await writeStages(db, id, session, opts.thresholdPaceSecPerKm);

  // Coach adds reach the WATCH (user requirement 2026-08-12): duration-block
  // run sessions ride the same verified create pipeline as studio pushes.
  // The stored state stays calendar_only until the executor verifies; the
  // pending job already renders as "syncing" through deriveWorkoutSync.
  if (opts.corosWritesEnabled && watchPushable(session)) {
    await db
      .insert(corosWriteJobs)
      .values({
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
          name: stampName(session.title, date),
          session,
          ...(opts.thresholdPaceSecPerKm ? { thresholdPaceSecPerKm: opts.thresholdPaceSecPerKm } : {}),
        },
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      })
      // Re-applying an approve must be idempotent (audit#2 #13) — the
      // deterministic id makes skip-on-conflict exactly right.
      .onConflictDoNothing();
  }
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
    const wire = /^\d+:\d+$/.test(w.sourceWorkoutId ?? "");
    if (!wire || w.corosSyncState !== "synced" || !w.sourceIdInPlan || !w.sourceProgramId) continue;
    // The delete triple's stamp is the create payload's exact name — it was
    // never persisted on the row, so read it back off the verified push job.
    const [createJob] = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.id, `${w.id}-push`))
      .limit(1);
    const stamp = (createJob?.payload as { name?: string } | null)?.name;
    if (!stamp) continue;
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
          happenDay: w.lastVerifiedCorosDate || w.effectiveDate,
          name: stamp,
          idInPlan: w.sourceIdInPlan,
          programId: w.sourceProgramId,
          corosPlanId: w.sourceWorkoutId!.split(":")[0]!,
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

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const opId = (n: number | string) => `cw-${proposalId}-${i}-${n}`;
    switch (op.kind) {
      case "ease": {
        // Ownership first, because the stage write below is keyed on the
        // workout id alone — `planned_workout_stages` carries no user column,
        // so an id that isn't this athlete's must never reach it.
        const [target] = await db
          .select({ id: plannedWorkouts.id })
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
