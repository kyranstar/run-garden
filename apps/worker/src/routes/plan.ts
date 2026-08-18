import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  calendarEventLinks,
  calendarEventSuppressions,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  corosWriteJobs,
  dailyHealth,
  gardenState,
  plannedWorkoutStages,
  plannedWorkouts,
  providerConnections,
  scheduleOverrides,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import { computeConsistency } from "@rg/analytics";
import {
  addDays,
  coachExerciseSchema,
  exerciseCuesAsText,
  formatExercise,
  humanizeWorkoutTitle,
  isAdventureSport,
  looksLikeCodeTitle,
  newId,
  nowInstant,
  sportLabel,
  startOfIsoWeek,
  syncAction,
  todayInZone,
  watchCoverage,
  type LocalDate,
  type PlannedWorkout,
  type SyncAction,
  type UserPreferences,
  type WatchCoverageView,
  type WatchSessionShape,
  type WorkoutSyncView,
  type WriteLane,
} from "@rg/domain";
import { conditionWord, DEFAULT_GARDEN_CONFIG, type GardenSnapshot } from "@rg/garden-engine";
import { proposeReschedules, summarizeStageRows } from "@rg/scheduling";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { googleCalendarClient } from "../services/google-calendar.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { loadPreferences, restoreCalendarEvent, savePreferences, syncCalendar } from "../services/calendar-sync.js";
import { chunkIds, type Db } from "../services/db.js";
import { applyMove } from "../services/jobs.js";
import { recentGardenEvents, resimulateFrom } from "../services/garden-sync.js";
import {
  openContentIntentTargets,
  openIntentFor,
  openMoveIntents,
  recordIntent,
  resolveIntent,
} from "../services/sync-intents.js";
import { findRaceConflict, resolveRaceConflict } from "../services/race-conflict.js";
import { buildRaceHub } from "../services/race-hub.js";
import { cloudPresence, deriveWorkoutSync, type CloudPresence } from "../services/sync-status.js";
import { exerciseNameMap, resolveCodesInText } from "../services/exercise-catalog.js";
import { buildReadiness } from "../services/readiness.js";
import { isLoosePlan } from "../services/coach-plans.js";
import { repairPlannedWorkoutFidelity } from "../services/plan-repair.js";
import { executeCloudJobs } from "../services/coros-write-cloud.js";

export const planRoutes = new Hono<AppContext>();
planRoutes.use("*", requireUser);

/** `corosWriteJobs.status` values that mean "a write is in flight" — same set
 * `jobs.ts`/`sync-status.ts` already use, duplicated locally the same way
 * those files each already do (no shared export exists for it). */
const IN_FLIGHT_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * A write job that TAKES A SESSION OFF the watch, as opposed to putting one on
 * it — the one distinction the athlete-facing action layer needs from the job
 * lane, and the reason it reads kinds rather than counting rows.
 *
 * Deliberately a RULE about the kind's meaning and not a registry lookup: the
 * lane grows kinds (a content rewrite landed on 2026-08-17), and every new one
 * either adds a session to the watch or removes one. Getting this wrong in the
 * "sending" direction would tell an athlete their watch is being updated while
 * their session is being deleted from it, which is a lie in the reassuring
 * direction — so the test is on the removal side.
 */
function isUnpushKind(kind: string): boolean {
  return kind.includes("delete") || kind.includes("remove");
}

/** Everything a workout's DTO needs that its own row cannot answer: where
 * COROS stands on it, how much of it the wire can carry, and what anyone is
 * supposed to do about the difference. */
interface WorkoutView {
  corosSyncView: WorkoutSyncView;
  /** Omitted when coverage is `full` — see `watchCoverageOfRow`. Silence is
   * the correct render for a session with nothing to disclose. */
  watchCoverage?: WatchCoverageView;
  /**
   * WHAT TO DO ABOUT IT (`@rg/domain` sync-action.ts) — absent when the answer
   * is "nothing, it's fine", which is every fully-synced session.
   *
   * The two fields above say THAT something is off. This one says whether the
   * app is fixing it, whether the athlete has to, or whether nothing can be —
   * which is the difference between a state that reads as a warning and a state
   * that reads as a receipt.
   */
  syncAction?: SyncAction;
}

/**
 * Is this row's content Run Garden's own claim, or COROS's?
 *
 * The coverage disclosure is about the gap between what the app holds and what
 * the wire can carry, so it is meaningless — and would be a lie — for a
 * session that CAME FROM the wire: an imported COROS strength workout is on
 * the watch by definition, and telling its owner "your watch won't show this"
 * because it is a lift would be spectacularly wrong.
 *
 * Three signals, any of which means Run Garden wrote the content:
 *
 *  1. `structuredJson` — only `coach-apply.ts`'s `sessionColumns` writes it,
 *     for a lift or mobility body (`add` and `ease` both).
 *  2. `sourceIdInPlan === null` — never existed in a COROS plan. Import sets
 *     it from the wire; a verified create stamps it (coros-write-cloud.ts).
 *     So a coach run that has been pushed drops out here, which is right:
 *     the watch has it, and its coverage is `full` anyway.
 *  3. an open `content` intent — an approved ease rewrote a row COROS still
 *     holds in its old form. The row keeps its wire id; the content is ours.
 */
function authoredHere(w: typeof plannedWorkouts.$inferSelect, contentRewritten: boolean): boolean {
  return w.structuredJson !== null || w.sourceIdInPlan === null || contentRewritten;
}

/** Rows whose coverage question needs the stage rows to answer: an authored
 * RUN, where "is every block timed" and "which steps have no pace band" are
 * facts only `planned_workout_stages` holds. Lift/mobility answer from
 * `structuredJson`, and rest days are not sessions anyone expects on a watch. */
function needsRunStages(w: typeof plannedWorkouts.$inferSelect, contentRewritten: boolean): boolean {
  return authoredHere(w, contentRewritten) && w.category !== "rest" && w.sport === "run";
}

/**
 * A stored row in the wire's own terms — the row-side twin of
 * `watchSessionShape`, which does the same job for a `CoachSession` the
 * proposal manifest holds before anything is stored. `watch-coverage.test.ts`
 * drives one session through `sessionColumns` + `writeStages` and asserts both
 * adapters land on the same verdict.
 *
 * `null` = nothing to say: the content is COROS's own, or it is a rest day.
 */
function watchShapeOfRow(
  w: typeof plannedWorkouts.$inferSelect,
  contentRewritten: boolean,
  /** This row's stage rows, when loaded (see `needsRunStages`). */
  stages: ReadonlyArray<{ durationType: string; targetType: string | null; label: string | null }>,
): WatchSessionShape | null {
  if (!authoredHere(w, contentRewritten) || w.category === "rest") return null;
  const discipline = w.sport === "strength" ? "lift" : w.sport === "yoga" ? "mobility" : "run";
  if (discipline !== "run") {
    const raw = Array.isArray(w.structuredJson?.exercises) ? w.structuredJson.exercises : [];
    return {
      discipline,
      runBlocks: [],
      paceTargetsOwed: 0,
      exercises: raw.flatMap((e) => {
        const parsed = coachExerciseSchema.safeParse(e);
        if (!parsed.success) {
          const name = (e as { name?: unknown })?.name;
          // Same tolerance `exercisesDto` shows an odd legacy row: an
          // unparseable movement has no `originId`, so it is off-catalog.
          return typeof name === "string" ? [{ name, onWatch: false }] : [];
        }
        return [
          {
            name: parsed.data.name,
            onWatch: !!parsed.data.originId,
            // The per-side/tempo half of the disclosure, from the same test the
            // manifest's adapter uses — otherwise the sheet and the approval
            // card would answer "how much of this crosses" differently for the
            // same session.
            ...(exerciseCuesAsText(parsed.data) ? { cuesAsText: true } : {}),
          },
        ];
      }),
    };
  }
  return {
    discipline,
    runBlocks: stages.map((s) => (s.durationType === "distance" ? "distance" : "duration")),
    // The create executor's own `missingPaceTargets` rule, read off the rows
    // `writeStages` wrote from the same threshold pace the push would use:
    // a block that named an intensity but got no band. `rest` never gets one
    // and never will, so it is not owed.
    paceTargetsOwed: stages.filter(
      (s) => s.label != null && s.label !== "rest" && s.targetType !== "pace",
    ).length,
    exercises: [],
  };
}

/** The DTO's coverage field, or `undefined` when there is nothing to say.
 * Full coverage is rendered as silence — a normal synced run must not become
 * noisier than it was. */
function watchCoverageOfRow(
  w: typeof plannedWorkouts.$inferSelect,
  contentRewritten: boolean,
  stages: ReadonlyArray<{ durationType: string; targetType: string | null; label: string | null }>,
): WatchCoverageView | undefined {
  const shape = watchShapeOfRow(w, contentRewritten, stages);
  if (!shape) return undefined;
  const view = watchCoverage(shape);
  return view.coverage === "full" ? undefined : view;
}

/**
 * Bulk-loads what `deriveWorkoutSync` and `watchCoverageOfRow` need for every
 * workout in `workouts` in a small, fixed number of queries (chunked with
 * `chunkIds` for D1's bound-variable cap) rather than one round-trip per
 * workout. `presence` is a single shared computation — device liveness
 * doesn't vary per workout.
 */
async function loadWorkoutViews(
  db: Db,
  userId: string,
  workouts: Array<typeof plannedWorkouts.$inferSelect>,
  prefs: UserPreferences,
  /** Callers that already computed presence for their own payload pass it in
   * so the providerConnections read isn't repeated (it never varies within a
   * request). Omitted → computed here, same as before. */
  precomputedPresence?: CloudPresence,
  /** The athlete's today, for the one question the row cannot answer on its
   * own: is there still anything to send? A session whose day has gone asks
   * nothing of anyone (`SyncSituation.settled`). Omitted → derived from prefs,
   * which is the same answer one string comparison later. */
  todayLocal?: string,
): Promise<Map<string, WorkoutView>> {
  const map = new Map<string, WorkoutView>();
  if (workouts.length === 0) return map;

  const ids = workouts.map((w) => w.id);
  // All three lookups are independent — one D1 round-trip wave, not three
  // (cross-region D1 makes every sequential await a full round trip).
  //
  // The MOVE-intent read that used to be in this wave is gone. It fed
  // `deriveWorkoutSync`'s `hasOpenIntent` parameter, which the derivation
  // accepted and never read — a full D1 round trip, on every Today, week and
  // plan render, whose result was discarded. The content intents below are
  // the ones the derivation actually consults.
  const [presence, contentStale, jobChunks] = await Promise.all([
    precomputedPresence ?? cloudPresence(db, userId),
    openContentIntentTargets(db, userId),
    Promise.all(
      chunkIds(ids).map((chunk) =>
        db
          .select({
            workoutId: corosWriteJobs.workoutId,
            status: corosWriteJobs.status,
            // The kind is read for ONE question: does this job put the session
            // on the watch or take it off (`isUnpushKind`). The sync view itself
            // is kind-blind and stays that way.
            kind: corosWriteJobs.kind,
          })
          .from(corosWriteJobs)
          .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.workoutId, chunk))),
      ),
    ),
  ]);

  // Second wave, and only for the rows whose coverage answer lives in stage
  // rows — a coach-authored run. Typically a handful per week; an imported
  // COROS plan contributes none, so the common page pays nothing at all.
  const stageIds = workouts.filter((w) => needsRunStages(w, contentStale.has(w.id))).map((w) => w.id);
  const stageChunks =
    stageIds.length > 0
      ? await Promise.all(
          chunkIds(stageIds).map((chunk) =>
            db
              .select({
                workoutId: plannedWorkoutStages.workoutId,
                durationType: plannedWorkoutStages.durationType,
                targetType: plannedWorkoutStages.targetType,
                label: plannedWorkoutStages.label,
              })
              .from(plannedWorkoutStages)
              .where(inArray(plannedWorkoutStages.workoutId, chunk)),
          ),
        )
      : [];
  const stagesByWorkout = new Map<string, Array<{ durationType: string; targetType: string | null; label: string | null }>>();
  for (const rows of stageChunks) {
    for (const s of rows) {
      const list = stagesByWorkout.get(s.workoutId) ?? [];
      list.push({ durationType: s.durationType, targetType: s.targetType, label: s.label });
      stagesByWorkout.set(s.workoutId, list);
    }
  }

  const pendingIds = new Set<string>();
  const failedIds = new Set<string>();
  // What the lane is DOING about each row, in the action layer's own three
  // words. In flight outranks failed (a superseded failure has been replaced by
  // a live attempt), and an unpush is distinguished from a send because the two
  // promise opposite things to the athlete.
  const lanes = new Map<string, WriteLane>();
  for (const jobs of jobChunks) {
    for (const j of jobs) {
      if ((IN_FLIGHT_JOB_STATUSES as readonly string[]).includes(j.status)) {
        pendingIds.add(j.workoutId);
        if (lanes.get(j.workoutId) !== "sending") {
          lanes.set(j.workoutId, isUnpushKind(j.kind) ? "unpushing" : "sending");
        }
      } else if (j.status === "failed") {
        failedIds.add(j.workoutId);
        if (!lanes.has(j.workoutId)) lanes.set(j.workoutId, "failed");
      }
    }
  }

  const today = todayLocal ?? todayInZone(prefs.timezone);
  for (const w of workouts) {
    const contentRewritten = contentStale.has(w.id);
    const coverage = watchCoverageOfRow(w, contentRewritten, stagesByWorkout.get(w.id) ?? []);
    const corosSyncView = deriveWorkoutSync({
      effectiveDate: w.effectiveDate,
      lastVerifiedCorosDate: w.lastVerifiedCorosDate,
      hasOpenContentIntent: contentRewritten,
      hasPendingJob: pendingIds.has(w.id),
      hasFailedJob: failedIds.has(w.id),
      presence,
      writesEnabled: prefs.corosWritesEnabled,
    });
    // A row whose in-flight job was superseded still shows `failed` here while
    // the lane holds nothing — `deriveWorkoutSync` and the action must read the
    // same lane, so the fallback is the same derivation, not a second one.
    const write: WriteLane = lanes.get(w.id) ?? "none";
    const action = syncAction({
      view: corosSyncView,
      ...(coverage ? { coverage } : {}),
      connected: presence.online,
      writesEnabled: prefs.corosWritesEnabled,
      write,
      // Completed, skipped, missed, or simply past: its watch copy is history
      // and nothing is going to be sent for it. Same rule the content
      // convergence backfill applies when it picks rows.
      settled: w.completionState !== "scheduled" || w.effectiveDate < today,
    });
    map.set(w.id, {
      corosSyncView,
      ...(coverage ? { watchCoverage: coverage } : {}),
      ...(action ? { syncAction: action } : {}),
    });
  }
  return map;
}

function workoutDto(
  w: typeof plannedWorkouts.$inferSelect,
  view?: WorkoutView,
  catalog?: Map<string, string>,
  /**
   * The summary recomputed from this workout's stage rows — passed by the
   * detail route, which loads them anyway for the "Full structure" list.
   *
   * `stage_summary` is derived text, so a row stored before a formatter fix
   * carries that fix's absence forever: prod's strides session still says
   * "4 × 0 min Training / 1 min Rest" for 15s on / 45s off. Re-deriving where
   * the rows are already in hand costs no query and makes the sheet agree with
   * itself for EVERY row ever written — including archived and long-past ones
   * that no COROS read will ever refresh. Falls back to the stored string for
   * coach-authored sessions, which have no stage rows at all.
   */
  derivedStageSummary?: string,
) {
  // COROS structured names are frequently opaque codes ("T1004") — every UI
  // surface gets the humanized name; the raw one rides along as corosName
  // for cross-referencing the watch. Humanizing HERE (the one DTO boundary)
  // is what keeps Today, the garden dock, and the plan page agreeing.
  const displayTitle = humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype);
  return {
    id: w.id,
    title: displayTitle,
    ...(displayTitle !== w.title ? { corosName: w.title } : {}),
    category: w.category,
    qualitySubtype: w.qualitySubtype,
    sport: w.sport,
    originalPlanDate: w.originalPlanDate,
    lastVerifiedCorosDate: w.lastVerifiedCorosDate,
    effectiveDate: w.effectiveDate,
    effectiveTime: w.effectiveTime,
    workoutSeconds: w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds,
    estimateSource: (w.durationEstimate as { source?: string } | null)?.source,
    calendarSeconds: w.calendarBlockDurationSeconds,
    stageSummary: (() => {
      // The derived one is built from stage rows whose labels this route has
      // already resolved, so it needs no second pass; the stored one still
      // does (its exercise names are raw catalog codes).
      if (derivedStageSummary) return derivedStageSummary;
      return w.stageSummary && catalog ? resolveCodesInText(w.stageSummary, catalog) : w.stageSummary;
    })(),
    calendarSyncState: w.calendarSyncState,
    corosSyncState: w.corosSyncState,
    // Derived per-workout view (sync-transparency Task 10), alongside the
    // legacy stored `corosSyncState` above — not a replacement for it.
    // Optional: routes that don't bulk-load it (or callers that predate this
    // change) simply omit the field, `workoutDto`'s signature stays
    // backward-compatible either way.
    ...(view?.corosSyncView !== undefined ? { corosSyncView: view.corosSyncView } : {}),
    // What the watch will and won't show for this session, computed by the
    // same rules that decide the push (`@rg/domain` watch-coverage.ts).
    // ABSENT when there is nothing to disclose — a fully-carried run stays
    // exactly as quiet as it was before this field existed.
    ...(view?.watchCoverage ? { watchCoverage: view.watchCoverage } : {}),
    // …and WHAT TO DO about it: who has to act, and the one thing they do
    // (`@rg/domain` sync-action.ts). Absent whenever the answer is "nothing" —
    // which keeps a synced session's payload byte-identical to before.
    ...(view?.syncAction ? { syncAction: view.syncAction } : {}),
    completionState: w.completionState,
    archived: !!w.archivedAt,
    // Lift/mobility prescription, formatted once here so the sheet can't
    // invent its own notation, and carrying the ONE fact the flat
    // stageSummary cannot: which movements the watch's own library knows
    // (2026-08-16). `onWatch: false` is why a session is app-only.
    ...exercisesDto(w.structuredJson),
  };
}

/** `structured_json` → the DTO's exercise lines. Tolerant of every historical
 * shape in the column (studio exercises, coach exercises, junk) — a session
 * detail must never fail to render because an old row is shaped oddly. */
function exercisesDto(
  structured: { exercises?: unknown[]; rounds?: number } | null,
): { exercises?: Array<{ name: string; line: string; onWatch: boolean }>; exerciseRounds?: number } {
  const raw = structured?.exercises;
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const exercises = raw.flatMap((e) => {
    const parsed = coachExerciseSchema.safeParse(e);
    if (!parsed.success) {
      const name = (e as { name?: unknown })?.name;
      return typeof name === "string" ? [{ name, line: name, onWatch: false }] : [];
    }
    return [
      { name: parsed.data.name, line: formatExercise(parsed.data), onWatch: !!parsed.data.originId },
    ];
  });
  if (exercises.length === 0) return {};
  return { exercises, ...(structured?.rounds ? { exerciseRounds: structured.rounds } : {}) };
}

/** The Today payload: next workout, statuses, readiness, garden preview. */
planRoutes.get("/today", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);

  // Everything below depends only on userId/today (which needs prefs), never
  // on each other — one Promise.all wave instead of ten sequential D1 round
  // trips (house pattern: the insights route). No writes happen in this
  // handler, so read ordering is free.
  const [
    catalog,
    upcoming,
    unresolved,
    attention,
    pendingJobs,
    presence,
    health,
    gardenRows,
    gardenEventsRecent,
    yesterdayDone,
    latestCoachMsg,
    consistencyRows,
  ] = await Promise.all([
    exerciseNameMap(db),
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          gte(plannedWorkouts.effectiveDate, today),
          isNull(plannedWorkouts.archivedAt),
          // Only genuinely upcoming work: a provisionally-completed run is DONE
          // (it's just awaiting its richer COROS record) — showing it as "next
          // workout" right after you ran it reads as the app not noticing.
          eq(plannedWorkouts.completionState, "scheduled"),
        ),
      )
      .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime))
      .limit(8),
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.completionState, "unresolved"),
          // Never ask "did this run happen?" about a date that hasn't happened:
          // a workout can sit unresolved with a future date briefly when it was
          // rescheduled after the question was raised.
          lte(plannedWorkouts.effectiveDate, today),
          isNull(plannedWorkouts.archivedAt),
        ),
      )
      .orderBy(desc(plannedWorkouts.effectiveDate))
      .limit(3),
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.corosSyncState, "needs_attention"),
          isNull(plannedWorkouts.archivedAt),
          // Attention is for things the user can still act on: a conflict on a
          // long-past (or already-resolved) workout must not pin a warning to
          // the Today screen forever.
          gte(plannedWorkouts.effectiveDate, addDays(today, -14)),
          inArray(plannedWorkouts.completionState, ["scheduled", "unresolved"]),
        ),
      )
      .limit(5),
    db
      .select()
      .from(corosWriteJobs)
      .where(
        and(
          eq(corosWriteJobs.userId, userId),
          inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
        ),
      ),
    cloudPresence(db, userId),
    db
      .select()
      .from(dailyHealth)
      .where(and(eq(dailyHealth.userId, userId), lte(dailyHealth.date, today)))
      .orderBy(desc(dailyHealth.date))
      .limit(14),
    db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1),
    recentGardenEvents(db, userId, 6),
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.effectiveDate, addDays(today, -1)),
          inArray(plannedWorkouts.completionState, ["completed"]),
        ),
      )
      .limit(1),
    // The coach's latest message — its `refs.focus` is the one action line
    // the dock quotes (same row and same staleness rule as /week).
    db
      .select()
      .from(coachMessages)
      .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach")))
      .orderBy(desc(coachMessages.at))
      .limit(1)
      .then((r) => r[0]),
    // The streak band's 12 ISO weeks (homeConsistency) — all disciplines,
    // archived rows excluded like every other read here.
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          gte(plannedWorkouts.effectiveDate, addDays(startOfIsoWeek(today), -77)),
          lte(plannedWorkouts.effectiveDate, today),
          isNull(plannedWorkouts.archivedAt),
        ),
      ),
  ]);
  const next = upcoming.find((w) => w.category !== "rest") ?? upcoming[0];
  const snapshot = gardenRows[0]?.snapshot as unknown as GardenSnapshot | undefined;

  // One bulk load covers every workout shown on Today (next is always a
  // member of upcoming, included here via the same dedup-by-id map).
  // Presence was already fetched above — threaded through, not re-queried.
  const syncViewSource = new Map<string, typeof plannedWorkouts.$inferSelect>();
  for (const w of [...upcoming, ...unresolved, ...attention]) syncViewSource.set(w.id, w);
  const syncViews = await loadWorkoutViews(db, userId, [...syncViewSource.values()], prefs, presence, today);

  return c.json({
    today,
    nextWorkout: next ? workoutDto(next, syncViews.get(next.id), catalog) : null,
    upcoming: upcoming.map((w) => workoutDto(w, syncViews.get(w.id), catalog)),
    unresolved: unresolved.map((w) => workoutDto(w, syncViews.get(w.id), catalog)),
    needsAttention: attention.map((w) => workoutDto(w, syncViews.get(w.id), catalog)),
    sync: {
      pendingCorosJobs: pendingJobs.length,
      corosConnected: presence.online,
      corosWritesEnabled: prefs.corosWritesEnabled,
      calendarConnected: !!prefs.calendarId,
      // "connected" | "error" (subscription lapsed / revoked) | undefined (never connected)
    },
    // Same three fields as ever (other surfaces read them), plus the computed
    // `verdict` the garden dock leads with — built by the one shared helper so
    // the dock and the Today card can't disagree about "your baseline".
    readiness: buildReadiness(health),
    // The coach's own weekly action line, gated by the SAME 72h staleness
    // rule /week uses (`deriveFocus`). The dock labels it as the coach's line
    // and dates it — it was written about the week, not about today's
    // readiness, and must never be read as a comment on it.
    focus: deriveFocus(latestCoachMsg),
    // The streak band (System 1): squares + one percentage + the same streak
    // counter the garden's vines grow on.
    consistency: homeConsistency(
      consistencyRows,
      today,
      snapshot?.state.consecutiveConsistentWeeks ?? 0,
    ),
    garden: snapshot
      ? {
          condition: conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG),
          weather: snapshot.state.weatherState,
          plants: snapshot.plants.filter((p) => p.state !== "dead").length,
          recentEvents: gardenEventsRecent,
          wateredYesterday: yesterdayDone.length > 0,
        }
      : null,
  });
});

/** Week view of the plan. */
planRoutes.get("/workouts", async (c) => {
  const db = c.get("db");
  const prefs = await loadPreferences(db, c.get("userId"));
  const today = todayInZone(prefs.timezone);
  const catalog = await exerciseNameMap(db);
  // Look back 8 weeks by default so completed/past runs are browsable; callers
  // can widen with ?start=.
  const start = c.req.query("start") ?? addDays(today, -56);
  const end = c.req.query("end") ?? addDays(today, 7 * prefs.mirrorWeeksAhead);
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, c.get("userId")),
        gte(plannedWorkouts.effectiveDate, start),
        lte(plannedWorkouts.effectiveDate, end),
        isNull(plannedWorkouts.archivedAt),
      ),
    )
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime));
  const plans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, c.get("userId")), eq(trainingPlans.status, "active")));
  // The header names the plan the user actually lives in: with several active
  // plan rows (merged COROS reads create mirrors and a lifting container),
  // an arbitrary plans[0] could surface a synthesized "COROS plan" label.
  const countByPlanId = new Map<string, number>();
  for (const w of rows) {
    if (w.archivedAt) continue;
    countByPlanId.set(w.planId, (countByPlanId.get(w.planId) ?? 0) + 1);
  }
  const primary = [...plans].sort(
    (a, b) => (countByPlanId.get(b.id) ?? 0) - (countByPlanId.get(a.id) ?? 0),
  )[0];
  const syncViews = await loadWorkoutViews(db, c.get("userId"), rows, prefs, undefined, today);
  return c.json({
    today,
    plan: primary ? { name: primary.name, startDate: primary.startDate, endDate: primary.endDate } : null,
    corosWritesEnabled: prefs.corosWritesEnabled,
    workouts: rows.map((w) => workoutDto(w, syncViews.get(w.id), catalog)),
  });
});

/** Deterministic brief-headline state (rework spec §4) — exported pure for
 * the table test. Copy mapping lives client-side (brief-copy). */
export function deriveHeadline(input: {
  adherencePct: number | null;
  loadRatio: number | null;
  raceInDays: number | null;
  deloadWeek: boolean;
}): "on_track" | "behind" | "ahead" | "rebuilding" | "race_week" | "resting" {
  if (input.raceInDays !== null && input.raceInDays >= 0 && input.raceInDays <= 7) return "race_week";
  if (input.deloadWeek) return "resting";
  if (input.adherencePct === null) return "rebuilding";
  if (input.adherencePct >= 95 && (input.loadRatio ?? 0) >= 1.0) return "ahead";
  if (input.adherencePct >= 80) return "on_track";
  if (input.adherencePct >= 60) return "behind";
  return "rebuilding";
}

const FOCUS_STALE_MS = 72 * 3600 * 1000;

/**
 * The coach's one action line, or null.
 *
 * It is THE LATEST briefing's line — never an older message's. A fresh
 * briefing with focus:null must retire the previous line, not let it linger
 * (live case: a phantom "Sunday's 5K" focus outlived the corrected briefing
 * that followed it). And it expires at {@link FOCUS_STALE_MS}: a line written
 * about last week is not advice about this one.
 *
 * Shared by /week (the plan brief) and /today (the garden dock) so there is
 * exactly one staleness rule — the dock must not invent a second one.
 */
function deriveFocus(
  latestCoachMsg: { at: string; refs: unknown } | undefined,
): { text: string; at: string } | null {
  const text = (latestCoachMsg?.refs as { focus?: string } | undefined)?.focus;
  if (!latestCoachMsg || !text) return null;
  if (Date.now() - Date.parse(latestCoachMsg.at) >= FOCUS_STALE_MS) return null;
  return { text, at: latestCoachMsg.at };
}

/** The home page's celebrated metric (System 1 spec §server): 12 ISO weeks
 * of plan adherence as bands, one 12-week percentage, and the garden's own
 * streak counter. */
export interface TodayConsistency {
  /** Exactly 12, oldest first; the last entry is always the current week. */
  weeks: Array<{ weekStart: string; band: "full" | "partial" | "quiet" | "current" }>;
  adherencePct: number | null;
  streakWeeks: number;
}

/**
 * Band rules: the current ISO week is "current" (still being written); a past
 * week is "full" at ≥80% adherence, "partial" above zero, and "quiet"
 * otherwise — including weeks with nothing planned and weeks whose workouts
 * are all unresolved. There is deliberately no "missed" band: the squares
 * celebrate, the garden never accuses.
 *
 * Coach-sanctioned skips leave the ledger entirely — the same mercy /week's
 * adherence chip applies (a trip the coach cleared must not dim a square).
 */
export function homeConsistency(
  rows: Array<{ completionState: string; sanctionedBy?: string | null }>,
  today: LocalDate,
  streakWeeks: number,
): TodayConsistency {
  const asPlanned = rows.filter(
    (w) => !(w.completionState === "skipped" && w.sanctionedBy === "coach"),
  ) as unknown as PlannedWorkout[];
  const currentWeek = startOfIsoWeek(today);
  const start = addDays(currentWeek, -77);
  const report = computeConsistency(asPlanned, { start, end: today }, today);
  const byWeek = new Map(report.weeklyBreakdown.map((w) => [w.weekStart, w]));
  const weeks: TodayConsistency["weeks"] = [];
  for (let ws = start; ws <= currentWeek; ws = addDays(ws, 7)) {
    const wk = byWeek.get(ws);
    weeks.push({
      weekStart: ws,
      band:
        ws === currentWeek
          ? "current"
          : !wk || wk.planned === 0 || wk.adherence <= 0
            ? "quiet"
            : wk.adherence >= 0.8
              ? "full"
              : "partial",
    });
  }
  // Mirrors /week's windowPct: the rate already excludes still-ahead and
  // unresolved work; null (not 0) when nothing has resolved at all.
  const denom = report.planned - report.unresolved;
  return {
    weeks,
    adherencePct: denom > 0 ? Math.round(report.adherenceRate * 100) : null,
    streakWeeks,
  };
}

/** The weekly brief + one pickable week in a single call (rework spec §4). */
planRoutes.get("/week", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);

  const startParam = c.req.query("start");
  if (startParam !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startParam) || startOfIsoWeek(startParam) !== startParam) {
      return c.json({ error: "start_must_be_a_monday" }, 400);
    }
  }
  const weekStart = startParam ?? startOfIsoWeek(today);
  const weekEnd = addDays(weekStart, 6);

  // Independent reads (only prefs/today gate them) — one D1 round-trip wave,
  // same batching as /today. `findRaceConflict` needs only prefs;
  // `latestCoachMsg`/`acts`/`historyRows` need only userId/today. No writes
  // happen in this handler, so read ordering is free.
  const [rows, catalog, presence, activePlans, historyRows, acts, latestCoachMsg, raceMismatch] =
    await Promise.all([
      db
        .select()
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            gte(plannedWorkouts.effectiveDate, weekStart),
            lte(plannedWorkouts.effectiveDate, weekEnd),
            isNull(plannedWorkouts.archivedAt),
          ),
        )
        .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime)),
      exerciseNameMap(db),
      cloudPresence(db, userId),
      // Week n of m against the active coach plan covering this week's Monday.
      db
        .select()
        .from(coachPlans)
        .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"))),
      // 4-week adherence source (all disciplines), trend against the 4 prior.
      db
        .select()
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            gte(plannedWorkouts.effectiveDate, addDays(today, -56)),
            lte(plannedWorkouts.effectiveDate, today),
            isNull(plannedWorkouts.archivedAt),
          ),
        ),
      // Acute:chronic load, all sports, from activity trainingLoad.
      db
        .select({
          startTime: activities.startTime,
          startTimeLocal: activities.startTimeLocal,
          trainingLoad: activities.trainingLoad,
          sport: activities.sport,
        })
        .from(activities)
        .where(eq(activities.userId, userId)),
      // The coach's one action line — stale after 3 days (rework spec §6).
      db
        .select()
        .from(coachMessages)
        .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach")))
        .orderBy(desc(coachMessages.at))
        .limit(1)
        .then((r) => r[0]),
      // Two race truths must never coexist silently (audit#2 #3): the imported
      // plan's race row vs the athlete's stated race day.
      findRaceConflict(db, userId, prefs),
    ]);

  // "Week n of m" is a statement about a BLOCK's planned duration, so only a
  // block may answer it — and when two blocks overlap this week, the longest
  // span wins deterministically rather than whichever row D1 returned first.
  //
  // Approving one coach one-off used to mint a single-day "Coach one-offs"
  // bucket, and an unordered `.find()` let that bucket answer for the week: the
  // brief read "Week 1 of 1" on top of a real four-week block, and `deloadWeek`
  // and the plan's race date went with it (a bucket has no `coach_plan_weeks`
  // rows and no race).
  const covering = activePlans
    .filter((p) => !isLoosePlan(p) && p.startDate <= weekEnd && p.endDate >= weekStart)
    .sort(
      (a, b) =>
        Date.parse(b.endDate) - Date.parse(b.startDate) - (Date.parse(a.endDate) - Date.parse(a.startDate)) ||
        a.startDate.localeCompare(b.startDate) ||
        a.id.localeCompare(b.id),
    )[0];

  // Second (final) wave: the two reads gated on wave-one results — per-workout
  // sync views (need `rows`; presence threaded, not re-queried) and this
  // week's coach shape (needs `covering`).
  const [syncViews, coveringWeekShapeRows] = await Promise.all([
    loadWorkoutViews(db, userId, rows, prefs, presence, today),
    covering
      ? db
          .select()
          .from(coachPlanWeeks)
          .where(and(eq(coachPlanWeeks.planId, covering.id), eq(coachPlanWeeks.weekStart, weekStart)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    return {
      date,
      workouts: rows
        .filter((w) => w.effectiveDate === date)
        .map((w) => workoutDto(w, syncViews.get(w.id), catalog)),
    };
  });

  const nonRest = rows.filter((w) => w.category !== "rest");
  const plannedSeconds = nonRest.reduce(
    (sum, w) => sum + (w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 0),
    0,
  );
  const doneCount = nonRest.filter((w) => w.completionState === "completed").length;
  let weekIndex: number | null = null;
  let weekTotal: number | null = null;
  let deloadWeek = false;
  let raceInDays: number | null = null;
  if (covering) {
    const planW1 = startOfIsoWeek(covering.startDate);
    weekIndex = Math.floor((Date.parse(weekStart) - Date.parse(planW1)) / (7 * 86_400_000)) + 1;
    weekTotal = Math.floor((Date.parse(startOfIsoWeek(covering.endDate)) - Date.parse(planW1)) / (7 * 86_400_000)) + 1;
    if (covering.raceDate) {
      raceInDays = Math.round((Date.parse(covering.raceDate) - Date.parse(today)) / 86_400_000);
      if (raceInDays < 0) raceInDays = null;
    }
  }
  // The race-day preference covers users whose plan rows carry no race
  // (imported COROS plans, studio blocks).
  if (raceInDays === null && prefs.raceDate) {
    const d = Math.round((Date.parse(prefs.raceDate) - Date.parse(today)) / 86_400_000);
    if (d >= 0) raceInDays = d;
  }
  if (covering) {
    const [thisWeekShape] = coveringWeekShapeRows;
    const volumeTarget = thisWeekShape?.shape?.volumeTarget?.toLowerCase() ?? "";
    deloadWeek = /deload|recovery|wind.?down|taper/.test(volumeTarget);
  }

  // 4-week adherence (all disciplines) with a trend against the 4 weeks prior
  // (`historyRows` loaded in the batch above).
  // Coach-sanctioned skips leave the adherence denominator entirely (audit
  // finding 13): the brief promised adventure days "never count against you"
  // while docking the very Long Run the coach cleared for the trip — the
  // same mercy coachBlockAdherence already implements.
  const asPlanned = historyRows.filter(
    (w) => !(w.completionState === "skipped" && w.sanctionedBy === "coach"),
  ) as unknown as PlannedWorkout[];
  const windowPct = (start: string, end: string): number | null => {
    const report = computeConsistency(
      asPlanned.filter((w) => w.effectiveDate >= start && w.effectiveDate <= end),
      { start, end },
      today,
    );
    const denom = report.planned - report.unresolved;
    if (denom <= 0) return null;
    return Math.round(report.adherenceRate * 100);
  };
  const recentPct = windowPct(addDays(today, -28), today);
  const priorPct = windowPct(addDays(today, -56), addDays(today, -29));
  const trend: "up" | "flat" | "down" | null =
    recentPct === null || priorPct === null
      ? null
      : recentPct - priorPct > 5
        ? "up"
        : priorPct - recentPct > 5
          ? "down"
          : "flat";

  // Acute:chronic load from `acts` (loaded in the batch above).
  const localDate = (a: { startTime: string; startTimeLocal: string | null }) =>
    (a.startTimeLocal ?? a.startTime).slice(0, 10);
  const loadIn = (start: string, end: string) =>
    acts
      .filter((a) => localDate(a) >= start && localDate(a) <= end)
      .reduce((s, a) => s + (a.trainingLoad ?? 0), 0);
  const acute = loadIn(addDays(today, -6), today);
  const chronic = loadIn(addDays(today, -27), today) / 4;
  const loadRatio = chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null;

  // Adventure days in the adherence window — a backpacking week is a paused
  // plan, not a failed one, and the brief's context line says so.
  const adventureDays = new Set(
    acts
      .filter((a) => isAdventureSport(a.sport) && localDate(a) >= addDays(today, -28) && localDate(a) <= today)
      .map(localDate),
  ).size;

  // `latestCoachMsg` loaded in the batch above; the latest-only + staleness
  // rule lives in `deriveFocus` (shared with /today's dock line).
  const focus = deriveFocus(latestCoachMsg);

  return c.json({
    weekStart,
    days,
    plannedSeconds,
    doneCount,
    sessionCount: nonRest.length,
    weekIndex,
    weekTotal,
    adherence4w: { pct: recentPct, trend },
    loadRatio,
    adventureDays,
    raceMismatch,
    headline: deriveHeadline({ adherencePct: recentPct, loadRatio, raceInDays, deloadWeek }),
    focus,
  });
});

planRoutes.get("/workouts/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  const prefs = await loadPreferences(db, userId);
  const syncViews = await loadWorkoutViews(
    db,
    userId,
    [w],
    prefs,
    undefined,
    todayInZone(prefs.timezone),
  );
  const catalog = await exerciseNameMap(db);
  const stages = (
    await db
      .select()
      .from(plannedWorkoutStages)
      .where(eq(plannedWorkoutStages.workoutId, w.id))
      .orderBy(asc(plannedWorkoutStages.ord))
  ).map((s) => ({
    ...s,
    // Stage labels for imported strength work are catalog codes — resolve.
    label: s.label ? resolveCodesInText(s.label, catalog) : s.label,
  }));
  const match = (
    await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, w.id), isNull(workoutCompletionMatches.undoneAt)))
      .limit(1)
  )[0];
  const activity = match
    ? (await db.select().from(activities).where(eq(activities.id, match.activityId)).limit(1))[0]
    : undefined;
  const link = (
    await db.select().from(calendarEventLinks).where(eq(calendarEventLinks.workoutId, w.id)).limit(1)
  )[0];
  const jobs = await db
    .select()
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.workoutId, w.id))
    .orderBy(desc(corosWriteJobs.requestedAt))
    .limit(3);
  return c.json({
    workout: workoutDto(
      w,
      syncViews.get(w.id),
      catalog,
      stages.length > 0 ? summarizeStageRows(stages) : undefined,
    ),
    durationEstimate: w.durationEstimate,
    stages,
    match: match
      ? {
          ...match,
          activity: activity
            ? {
                ...activity,
                title:
                  activity.title && !looksLikeCodeTitle(activity.title)
                    ? activity.title
                    : sportLabel(activity.sport),
              }
            : activity,
        }
      : null,
    calendarEvent: link ? { eventId: link.eventId, state: link.state } : null,
    recentJobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      originalDate: j.originalDate,
      destinationDate: j.destinationDate,
      pathUsed: j.pathUsed,
      degraded: j.degraded,
      attemptCount: j.attemptCount,
      requestedAt: j.requestedAt,
    })),
  });
});

/** Reschedule candidates (never auto-applied). */
planRoutes.get("/workouts/:id/candidates", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);

  const others = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, addDays(w.effectiveDate, -5)),
        lte(plannedWorkouts.effectiveDate, addDays(w.effectiveDate, 5)),
        isNull(plannedWorkouts.archivedAt),
      ),
    );

  // Busy intervals from Google Calendar free/busy — and an HONEST flag when
  // the lookup couldn't run (audit#2 #16): candidates claimed "open morning"
  // with zero busy data through the whole dead-token outage, exactly when
  // the user was re-planning.
  let busy: Array<{ start: string; end: string }> = [];
  let busyChecked = false;
  const client = await googleCalendarClient(db, c.env, userId);
  if (client && prefs.calendarId) {
    try {
      const calendars = await client.listCalendars();
      const ids = calendars.filter((cal) => cal.id !== prefs.calendarId).map((cal) => cal.id);
      busy =
        ids.length > 0
          ? await client.freeBusy(
              ids.slice(0, 8),
              `${addDays(w.effectiveDate, -3)}T00:00:00Z`,
              `${addDays(w.effectiveDate, 4)}T00:00:00Z`,
            )
          : [];
      busyChecked = true;
    } catch {
      busy = [];
      busyChecked = false;
    }
  }

  const result = proposeReschedules({
    workout: {
      id: w.id,
      title: w.title,
      category: w.category as never,
      qualitySubtype: w.qualitySubtype ?? undefined,
      effectiveDate: w.effectiveDate,
      effectiveTime: w.effectiveTime,
      workoutSeconds: w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 2700,
    },
    others: others
      .filter((o) => o.id !== w.id)
      .map((o) => ({
        id: o.id,
        title: o.title,
        category: o.category as never,
        qualitySubtype: o.qualitySubtype ?? undefined,
        effectiveDate: o.effectiveDate,
        effectiveTime: o.effectiveTime,
        workoutSeconds: o.sourceEstimatedDurationSeconds ?? o.fallbackEstimatedDurationSeconds ?? 2700,
      })),
    busy,
    prefs,
    today,
    now: nowInstant(),
  });
  return c.json({ ...result, busyChecked });
});

planRoutes.get("/race", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  return c.json({ race: await buildRaceHub(db, userId, prefs, todayInZone(prefs.timezone)) });
});

const raceChecklistSchema = z.object({
  items: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(120), done: z.boolean() }))
    .max(12),
});

planRoutes.post("/race/checklist", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = raceChecklistSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const prefs = await loadPreferences(db, userId);
  // Coach items are derived, never stored — silently drop any that arrive.
  const items = parsed.data.items.filter((i) => !i.id.startsWith("coach-"));
  await savePreferences(db, userId, { ...prefs, raceChecklist: items });
  return c.json({ ok: true });
});

const raceConflictSchema = z.object({ keep: z.enum(["settings", "plan"]) });

planRoutes.post("/race-conflict/resolve", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = raceConflictSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const prefs = await loadPreferences(db, userId);
  const resolved = await resolveRaceConflict(db, userId, prefs, parsed.data.keep);
  return c.json({ ok: true, resolved: resolved !== null });
});

// ── POST /api/plan/repair-fidelity ───────────────────────────────────────────
//
// A one-shot, human-driven repair of live rows damaged by two now-fixed write
// bugs: an `ease` that relabelled a session without replacing its body, and an
// ownership stamp that round-tripped into the athlete's title. The reasoning,
// the discriminator and everything it refuses to guess at live in
// `services/plan-repair.ts`; this route is validation and nothing else.
//
// Same contract as `POST /api/studio/plans/:id/repair-exercise-ids`: `dryRun` is
// REQUIRED and never defaulted, a live run writes the pre-change rows to
// `audit_events` before touching anything, and the response is a per-row account
// of what changed (or would). It never pushes to COROS or Google Calendar —
// both re-derive from these rows on their next sync.
const fidelityRepairSchema = z
  .object({
    /** Required, never defaulted: a caller that forgot the field must not be
     *  guessed at in the direction that rewrites live sessions. */
    dryRun: z.boolean(),
    /** Optional narrowing. Omitted, every row an approved ease claims is
     *  examined. Named rows still have to carry the damage signature. */
    workoutIds: z.array(z.string().min(1)).min(1).max(200).optional(),
  })
  .strict();

planRoutes.post("/repair-fidelity", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = fidelityRepairSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const report = await repairPlannedWorkoutFidelity(db, userId, parsed.data);
  return c.json({ ok: true, ...report });
});

const moveSchema = z.object({ toDate: z.string(), toTime: z.string() });

planRoutes.post("/workouts/:id/move", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = moveSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const prefs = await loadPreferences(db, userId);
  try {
    const outcome = await applyMove(db, {
      userId,
      workoutId: c.req.param("id"),
      toDate: parsed.data.toDate,
      toTime: parsed.data.toTime,
      source: "app",
      corosWritesEnabled: prefs.corosWritesEnabled,
    });
    // Cloud-direct: the queued write executes now, not when a Mac wakes.
    waitUntilSafe(c, executeCloudJobs(db, c.env, userId, prefs).catch(() => undefined),);
    await syncCalendar(db, c.env, userId).catch(() => undefined);
    return c.json(outcome);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "move_failed";
    return c.json({ error: msg }, msg === "races_cannot_move" ? 422 : 500);
  }
});

planRoutes.post("/workouts/:id/skip", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  await db
    .update(plannedWorkouts)
    .set({ completionState: "skipped", resolutionDate: today, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)));
  await resimulateFrom(db, userId, today, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/**
 * Reverse a skip: only valid while still `skipped` (a completed/matched
 * workout has moved on and isn't "un-skippable"). Back to scheduled, the
 * skip's resolutionDate cleared, and — since that resolutionDate is what fed
 * `missedRuns` into the garden sim (garden-sync.ts's `buildDayInput`) —
 * resimulated from that same date so the garden forgets the miss, mirroring
 * how the skip route itself resimulates from the date it just wrote.
 */
planRoutes.post("/workouts/:id/unskip", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  if (w.completionState !== "skipped") return c.json({ error: "not_skipped" }, 422);
  const now = nowInstant();
  // buildDayInput falls back to effectiveDate when resolutionDate is unset;
  // matching that fallback here keeps the resim target correct either way.
  const resolvedOn = w.resolutionDate ?? w.effectiveDate;
  await db
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", resolutionDate: null, sanctionedBy: null, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, w.id), eq(plannedWorkouts.userId, userId)));
  await db.insert(scheduleOverrides).values({
    id: newId(),
    workoutId: w.id,
    kind: "restore",
    fromDate: resolvedOn,
    source: "app",
    createdAt: now,
  });
  const prefs = await loadPreferences(db, userId);
  await resimulateFrom(db, userId, resolvedOn, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/** "Not yet" on the did-this-run-happen prompt: back to scheduled, and
 * snoozed until tomorrow — otherwise the hourly reconcile re-asked within
 * the hour and the button read as broken. */
planRoutes.post("/workouts/:id/defer", async (c) => {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  const tomorrow = addDays(todayInZone(prefs.timezone), 1);
  await c
    .get("db")
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", snoozedUntil: tomorrow, updatedAt: nowInstant() })
    .where(
      and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, c.get("userId"))),
    );
  return c.json({ ok: true });
});

/** Manually match an activity to a workout. */
planRoutes.post("/workouts/:id/match", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { activityId } = await c.req.json<{ activityId: string }>();
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  const a = (
    await db
      .select()
      .from(activities)
      .where(and(eq(activities.id, activityId), eq(activities.userId, userId)))
      .limit(1)
  )[0];
  if (!w || !a) return c.json({ error: "not_found" }, 404);
  if (a.completionMatchId) return c.json({ error: "activity_already_matched" }, 422);
  const now = nowInstant();
  const matchId = newId();
  await db.insert(workoutCompletionMatches).values({
    id: matchId,
    workoutId: w.id,
    activityId: a.id,
    confidence: 1,
    method: "manual",
    matchedAt: now,
  });
  await db.update(activities).set({ completionMatchId: matchId, updatedAt: now }).where(eq(activities.id, a.id));
  await db
    .update(plannedWorkouts)
    .set({
      completionState: "completed",
      resolutionDate: (a.startTimeLocal ?? a.startTime).slice(0, 10),
      updatedAt: now,
    })
    .where(eq(plannedWorkouts.id, w.id));
  const prefs = await loadPreferences(db, userId);
  await resimulateFrom(db, userId, (a.startTimeLocal ?? a.startTime).slice(0, 10), prefs).catch(
    () => undefined,
  );
  return c.json({ ok: true });
});

/** Undo a match. */
planRoutes.post("/workouts/:id/unmatch", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const now = nowInstant();
  const match = (
    await db
      .select()
      .from(workoutCompletionMatches)
      .where(
        and(
          eq(workoutCompletionMatches.workoutId, c.req.param("id")),
          isNull(workoutCompletionMatches.undoneAt),
        ),
      )
      .limit(1)
  )[0];
  if (!match) return c.json({ error: "not_found" }, 404);
  await db
    .update(workoutCompletionMatches)
    .set({ undoneAt: now })
    .where(eq(workoutCompletionMatches.id, match.id));
  await db
    .update(activities)
    .set({ completionMatchId: null, updatedAt: now })
    .where(eq(activities.id, match.activityId));
  // D5: the match being undone may have credited a PAST day (buildDayInput
  // keys the completion on the workout's effectiveDate), so resimulating from
  // today only would strand that day's garden events as if the run still
  // counted. Mirror the matching path (completion.ts adds
  // workout.effectiveDate to affectedDates): replay from the earlier of the
  // workout's day and today.
  const w = (
    await db
      .select({ effectiveDate: plannedWorkouts.effectiveDate })
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  await db
    .update(plannedWorkouts)
    .set({ completionState: "unresolved", resolutionDate: null, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)));
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const resimFrom = w && w.effectiveDate < today ? w.effectiveDate : today;
  await resimulateFrom(db, userId, resimFrom, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/**
 * Remove a workout from the plan: archived locally, calendar event suppressed.
 * Never touches the COROS calendar — for COROS-sourced workouts the archived
 * row keeps its sourceWorkoutId, so future imports update it in place without
 * resurrecting it into the visible plan.
 */
planRoutes.post("/workouts/:id/remove", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  if (w.archivedAt) return c.json({ ok: true });
  const now = nowInstant();
  const workoutId = w.id;
  await db
    .update(plannedWorkouts)
    .set({ archivedAt: now, updatedAt: now, archiveReason: "user_removed" })
    .where(eq(plannedWorkouts.id, workoutId));
  await db.insert(calendarEventSuppressions).values({
    id: newId(),
    workoutId: workoutId,
    eventId: null,
    // "user_removed" (not the absence-detector's "workout_removed"): a hand
    // removal is a decision, and import's presence-healing must never undo it.
    reason: "user_removed",
    createdAt: now,
  });
  await recordIntent(db, {
    userId,
    targetKind: "workout",
    targetId: workoutId,
    kind: "remove_local",
    source: "remove_from_plan",
  });
  // Close out any open move intent for this workout too — once it's removed
  // from the plan there's nothing left to sync, and leaving the move intent
  // open behind an archived workout would strand a permanent, uncloseable
  // sync_issue (emitPendingWork resolves it too, but this closes the gap
  // immediately rather than waiting for the next bridge sync).
  const openMove = await openIntentFor(db, userId, workoutId, "move");
  if (openMove) await resolveIntent(db, openMove.id, now);
  await syncCalendar(db, c.env, userId).catch(() => undefined);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  // A removed past workout must stop counting against the garden.
  const resimFrom = w.effectiveDate < today ? w.effectiveDate : today;
  await resimulateFrom(db, userId, resimFrom, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

planRoutes.post("/workouts/:id/restore-calendar", async (c) => {
  await restoreCalendarEvent(c.get("db"), c.get("userId"), c.req.param("id"));
  await syncCalendar(c.get("db"), c.env, c.get("userId")).catch(() => undefined);
  return c.json({ ok: true });
});

/** Retry a failed COROS write. */
planRoutes.post("/workouts/:id/retry-coros", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  // A terminally failed job for this workout's current destination blocks
  // emitPendingWork's retry-forever guard (jobs.ts) from ever re-arming
  // future emission for it — superseding it here before applyMove clears
  // that block, so this user-initiated retry actually re-arms emission.
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: nowInstant() })
    .where(and(eq(corosWriteJobs.workoutId, w.id), eq(corosWriteJobs.status, "failed")));
  const outcome = await applyMove(db, {
    userId,
    workoutId: w.id,
    toDate: w.effectiveDate,
    toTime: w.effectiveTime,
    source: "app",
    corosWritesEnabled: prefs.corosWritesEnabled,
  });
  return c.json(outcome);
});
