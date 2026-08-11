import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  activityLaps,
  auditEvents,
  calendarEventLinks,
  computedMetrics,
  corosWriteJobs,
  dailyHealth,
  desktopDevices,
  dismissedInsights,
  gardenEvents,
  gardenState,
  llmUsage,
  plannedWorkouts,
  providerConnections,
  sleepRecords,
  syncErrors,
  syncRuns,
  trainingPlans,
  userPreferences,
  users,
  weeklyReviews,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  DEFAULT_CALENDAR_NAME,
  humanizeWorkoutTitle,
  looksLikeCodeTitle,
  newId,
  nowInstant,
  sportLabel,
  startOfIsoWeek,
  todayInZone,
  userPreferencesSchema,
  type ActivityLap,
  type PlannedWorkout,
  type WorkoutCategory,
} from "@rg/domain";
import {
  computeAerobicEfficiency,
  computeConsistency,
  computeDecoupling,
  computeEasyDiscipline,
  computeHardDayStacking,
  computeHrvTrend,
  computeLoadRatio,
  computeLowIntensityShare,
  computeMonotony,
  computePacing,
  computeRamp,
  computeRecords,
  computeRestingHr,
  computeWeeklyTraining,
  easyCeiling,
  estimateHrMax,
  interpret,
  isEasyHr,
  mergeRecords,
  pickEvidenceCard,
  stableHash,
  usableHrMaxReadings,
  DISCIPLINES,
  disciplineOf,
  sessionNoun,
  supportsMetric,
  type Discipline,
  type InterpretedMetric,
  type IntensityRunInput,
  type MetricDetail,
  type MetricRunDetail,
  type StoredRecord,
  type TimeOfDayPair,
} from "@rg/analytics";
import { SIMULATION_VERSION } from "@rg/garden-engine";
import { NORMALIZER_VERSION } from "@rg/providers";
import { ESTIMATOR_VERSION } from "@rg/scheduling";
import type { AppContext } from "../auth/middleware.js";
import { chunkIds, type Db } from "../services/db.js";
import { requireUser } from "../auth/middleware.js";
import { googleCalendarClient } from "../services/google-calendar.js";
import { loadPreferences, savePreferences, syncCalendar } from "../services/calendar-sync.js";
import { emitPendingWork } from "../services/jobs.js";
import { llmBudgetStatus, LLM_BUDGET } from "../services/llm.js";
import {
  ingestActivities,
  repairDurations,
  repairTimestamps,
  rowToNormalized,
} from "../services/completion.js";
import { resimulateFrom } from "../services/garden-sync.js";
import { enqueueBackfill } from "../services/backfill.js";

// ── Calendar management ──────────────────────────────────────────────────────

export const calendarRoutes = new Hono<AppContext>();
calendarRoutes.use("*", requireUser);

calendarRoutes.get("/calendars", async (c) => {
  const client = await googleCalendarClient(c.get("db"), c.env, c.get("userId"));
  if (!client) return c.json({ error: "google_not_connected" }, 412);
  return c.json({ calendars: await client.listCalendars() });
});

calendarRoutes.post("/choose", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { calendarId, createNew } = await c.req.json<{ calendarId?: string; createNew?: boolean }>();
  const prefs = await loadPreferences(db, userId);
  const client = await googleCalendarClient(db, c.env, userId);
  if (!client) return c.json({ error: "google_not_connected" }, 412);

  // Adopt the timezone from the user's primary Google Calendar (best effort).
  let timezone = prefs.timezone;
  try {
    const cals = await client.listCalendars();
    const primaryTz = cals.find((cal) => cal.primary)?.timeZone;
    if (primaryTz) timezone = primaryTz;
  } catch {
    /* keep the existing timezone */
  }

  let chosen = calendarId;
  if (createNew) {
    const created = await client.createCalendar(DEFAULT_CALENDAR_NAME, timezone);
    chosen = created.id;
  }
  if (!chosen) return c.json({ error: "no_calendar" }, 400);
  await savePreferences(db, userId, { ...prefs, calendarId: chosen, timezone });
  const stats = await syncCalendar(db, c.env, userId, { fullResync: true });
  return c.json({ ok: true, calendarId: chosen, stats });
});

calendarRoutes.post("/sync", async (c) => {
  const stats = await syncCalendar(c.get("db"), c.env, c.get("userId"), {
    fullResync: c.req.query("full") === "1",
  });
  return c.json(stats);
});

/** Preview of the exact next 7 days (onboarding step 7). */
calendarRoutes.get("/preview", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, today),
        lte(plannedWorkouts.effectiveDate, addDays(today, 7)),
        isNull(plannedWorkouts.archivedAt),
      ),
    )
    .orderBy(plannedWorkouts.effectiveDate, plannedWorkouts.effectiveTime);
  return c.json({
    days: rows.map((w) => ({
      id: w.id,
      title: humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype),
      category: w.category,
      date: w.effectiveDate,
      time: w.effectiveTime,
      workoutSeconds: w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds,
      calendarSeconds: w.calendarBlockDurationSeconds,
      corosSyncState: w.corosSyncState,
      morning: w.effectiveTime < "12:00",
      eveningReminderTime: prefs.eveningReminderTime,
      preRunReminderMinutes:
        w.effectiveTime < "12:00" ? prefs.preRunReminderMinutes : prefs.eveningPreRunReminderMinutes,
    })),
    eventCount: rows.filter((w) => w.category !== "rest").length,
  });
});

// COROS structured names are frequently opaque codes ("T1004") — the DTO
// boundary hands the UI human words instead; the sport is the honest
// fallback for an activity, the category for a planned workout.
function activityDisplayTitle(title: string | null, sport: string): string {
  return title && !looksLikeCodeTitle(title) ? title : sportLabel(sport);
}

// ── Activities ───────────────────────────────────────────────────────────────

export const activityRoutes = new Hono<AppContext>();
activityRoutes.use("*", requireUser);

activityRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30)));
  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.userId, userId))
    .orderBy(desc(activities.startTime))
    .limit(limit);

  // Attach the planned workout each activity completed (if any), so the UI can
  // distinguish plan runs from unplanned ("bonus") runs.
  const matchIds = rows.map((r) => r.completionMatchId).filter((x): x is string => !!x);
  const matches = matchIds.length
    ? await db.select().from(workoutCompletionMatches).where(inArray(workoutCompletionMatches.id, matchIds))
    : [];
  const woIds = matches.map((m) => m.workoutId);
  const wos = woIds.length
    ? await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.id, woIds))
    : [];
  const woById = new Map(wos.map((w) => [w.id, w]));
  const matchById = new Map(matches.map((m) => [m.id, m]));

  // Compact lap profiles for the list's pace-shape micro chart: seconds +
  // pace per lap, in lap order. One chunked query for the whole page.
  const lapChunks = await Promise.all(
    chunkIds(rows.map((r) => r.id)).map((ids) =>
      db
        .select({
          activityId: activityLaps.activityId,
          lapIndex: activityLaps.lapIndex,
          durationSeconds: activityLaps.durationSeconds,
          avgPaceSecPerKm: activityLaps.avgPaceSecPerKm,
        })
        .from(activityLaps)
        .where(inArray(activityLaps.activityId, ids)),
    ),
  );
  const lapsByActivity = new Map<string, Array<{ lapIndex: number; s: number; p: number | null }>>();
  for (const l of lapChunks.flat()) {
    const list = lapsByActivity.get(l.activityId) ?? [];
    list.push({ lapIndex: l.lapIndex, s: l.durationSeconds, p: l.avgPaceSecPerKm });
    lapsByActivity.set(l.activityId, list);
  }

  return c.json({
    activities: rows.map((a) => {
      const match = a.completionMatchId ? matchById.get(a.completionMatchId) : undefined;
      const wo = match ? woById.get(match.workoutId) : undefined;
      const laps = (lapsByActivity.get(a.id) ?? [])
        .sort((x, y) => x.lapIndex - y.lapIndex)
        .slice(0, 40)
        .map((l) => ({ s: Math.round(l.s), p: l.p }));
      return {
        id: a.id,
        startTime: a.startTime,
        startTimeLocal: a.startTimeLocal,
        date: (a.startTimeLocal ?? a.startTime).slice(0, 10),
        title: activityDisplayTitle(a.title, a.sport),
        sport: a.sport,
        durationSeconds: a.durationSeconds,
        distanceMeters: a.distanceMeters,
        avgPaceSecPerKm: a.avgPaceSecPerKm,
        trainingLoad: a.trainingLoad,
        feel: a.telemetry?.feelRating ?? null,
        laps: laps.length > 1 ? laps : null,
        matched: wo
          ? {
              workoutId: wo.id,
              title: humanizeWorkoutTitle(wo.title, wo.category, wo.qualitySubtype),
              category: wo.category,
              date: wo.effectiveDate,
            }
          : null,
      };
    }),
  });
});

/**
 * Backfill: queue a deep walk of COROS history — every run, lift, and yoga
 * session the account holds, not just the rolling 14-day window. The walk
 * itself runs on the desktop bridge, one 90-day chunk per job.
 */
activityRoutes.post("/backfill", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Self-heal stored data first (centisecond durations/timestamps, stuck
  // provisional matches) — independent of whether a device is available.
  await repairDurations(db, userId);
  const repairedDates = await repairTimestamps(db, userId);
  const prefs = await loadPreferences(db, userId);
  if (repairedDates.length > 0) {
    await resimulateFrom(db, userId, repairedDates[0]!, prefs).catch(() => undefined);
  }

  const result = await enqueueBackfill(db, userId, todayInZone(prefs.timezone));
  return c.json({
    ok: true,
    enqueued: result.enqueued,
    reason: result.reason,
  });
});

/** Unmatched run activities that could complete an open workout. */
activityRoutes.get("/unmatched", async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(activities)
    .where(and(eq(activities.userId, c.get("userId")), isNull(activities.completionMatchId)))
    .orderBy(desc(activities.startTime))
    .limit(20);
  return c.json({
    activities: rows
      .filter((a) => a.sport === "run" || a.sport === "strength" || a.sport === "yoga")
      .map((a) => ({ ...a, title: activityDisplayTitle(a.title, a.sport) })),
  });
});

// ── Insights ─────────────────────────────────────────────────────────────────

export const insightRoutes = new Hono<AppContext>();
insightRoutes.use("*", requireUser);

/**
 * `computed_metrics.metric_key` under which the never-regressing record set
 * lives, one key per discipline. The pre-discipline `records:v1` row is left
 * in place, inert — its bare-id records still resolve through evidence.ts's
 * `findRecord`, but nothing writes it any more.
 */
const recordsMetricKey = (d: Discipline): string => `records:v2:${d}`;
/**
 * The pre-discipline key. Nothing writes it any more, but its records — earned
 * when every record was implicitly a running one — still seed the run
 * discipline, so the never-regress guarantee survives the key change.
 */
const LEGACY_RECORDS_KEY = "records:v1";
/** Categories whose pace is steady enough to compare halves of. */
const STEADY_CATEGORIES: ReadonlySet<WorkoutCategory> = new Set(["easy", "long", "recovery"]);
/** A run this long is a hard day on its own, whatever it was matched to. */
const LONG_RUN_HARD_SECONDS = 6000;
/** Fraction of window duration that must carry COROS training load before load (not minutes) is the basis. */
const LOAD_COVERAGE_THRESHOLD = 0.9;
/** A recovery reading older than this date-stamps the card and drops its band. */
const RECOVERY_STALE_DAYS = 2;
/** Trailing window (inclusive of today) behind the low-intensity headline: 4 weeks. */
const INTENSITY_HEADLINE_DAYS = 27;
/** Usable max-HR readings needed in the 26-week window before the ceiling is quoted without a caveat. */
const MIN_HRMAX_RUNS = 10;

function rowToLap(row: typeof activityLaps.$inferSelect): ActivityLap {
  return {
    id: row.id,
    activityId: row.activityId,
    lapIndex: row.lapIndex,
    durationSeconds: row.durationSeconds,
    distanceMeters: row.distanceMeters ?? undefined,
    avgHeartRate: row.avgHeartRate ?? undefined,
    avgPaceSecPerKm: row.avgPaceSecPerKm ?? undefined,
    splitType: row.splitType ?? undefined,
  };
}

function rowToPlannedWorkout(row: typeof plannedWorkouts.$inferSelect): PlannedWorkout {
  return {
    id: row.id,
    sourceProvider: "coros",
    sourcePlanId: row.planId,
    sourceWorkoutId: row.sourceWorkoutId,
    sourceProgramId: row.sourceProgramId ?? undefined,
    sourceIdInPlan: row.sourceIdInPlan ?? undefined,
    title: row.title,
    category: row.category as WorkoutCategory,
    qualitySubtype: (row.qualitySubtype ?? undefined) as PlannedWorkout["qualitySubtype"],
    sport: row.sport,
    originalPlanDate: row.originalPlanDate,
    lastVerifiedCorosDate: row.lastVerifiedCorosDate,
    effectiveDate: row.effectiveDate,
    effectiveTime: row.effectiveTime,
    sourceContentFingerprint: row.sourceContentFingerprint,
    sourceVersion: row.sourceVersion ?? undefined,
    sourceEstimatedDurationSeconds: row.sourceEstimatedDurationSeconds ?? undefined,
    fallbackEstimatedDurationSeconds: row.fallbackEstimatedDurationSeconds ?? undefined,
    calendarBlockDurationSeconds: row.calendarBlockDurationSeconds,
    durationEstimate: (row.durationEstimate ?? undefined) as PlannedWorkout["durationEstimate"],
    expectedDistanceMeters: row.expectedDistanceMeters ?? undefined,
    stageSummary: row.stageSummary ?? undefined,
    stages: [],
    calendarSyncState: row.calendarSyncState as PlannedWorkout["calendarSyncState"],
    corosSyncState: row.corosSyncState as PlannedWorkout["corosSyncState"],
    completionState: row.completionState as PlannedWorkout["completionState"],
    archivedAt: row.archivedAt,
  };
}

/**
 * Records as they were last persisted. Defensive rather than trusting: this
 * JSON outlives every deploy, so a row written by an older shape must degrade
 * to "no stored record" instead of throwing a 500 at a user who just wanted
 * to look at their week.
 */
function parseStoredRecords(value: unknown): StoredRecord[] {
  const raw = (value as { records?: unknown } | null | undefined)?.records;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is StoredRecord => {
    if (r == null || typeof r !== "object") return false;
    const rec = r as Partial<StoredRecord>;
    return (
      typeof rec.id === "string" &&
      typeof rec.title === "string" &&
      typeof rec.value === "string" &&
      typeof rec.achievedOn === "string" &&
      typeof rec.rule === "string" &&
      typeof rec.numeric === "number" &&
      Number.isFinite(rec.numeric)
    );
  });
}

/** Append a disclosure (load basis, excluded time) to a card's sample note. */
function withNote(metric: InterpretedMetric, extra: string): InterpretedMetric {
  return extra ? { ...metric, sampleNote: `${metric.sampleNote} ${extra}` } : metric;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

insightRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // An unrecognized discipline falls back to run rather than erroring — a
  // stale bookmark should show something, not a 400.
  const requested = c.req.query("discipline");
  const discipline: Discipline =
    requested === "strength" || requested === "yoga" || requested === "run" ? requested : "run";
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const twelveWeeksAgo = addDays(startOfIsoWeek(today), -7 * 12);
  const twentySixWeeksAgo = addDays(startOfIsoWeek(today), -7 * 26);
  const range = { start: twelveWeeksAgo, end: today };

  // Every independent query at once. Activities are stored as UTC instants but
  // bucketed by LOCAL date, so the fetch is padded a day on the early side and
  // re-filtered on local date below — without the pad, a late-evening run near
  // the window edge appears or vanishes depending on the user's UTC offset.
  const [workoutRows, actRows, dismissed, healthRows, reviews, storedRows, hrMaxRows] =
    await Promise.all([
    db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          gte(plannedWorkouts.effectiveDate, twelveWeeksAgo),
          isNull(plannedWorkouts.archivedAt),
        ),
      ),
    db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          gte(activities.startTime, `${addDays(twelveWeeksAgo, -1)}T00:00:00Z`),
        ),
      ),
    db.select().from(dismissedInsights).where(eq(dismissedInsights.userId, userId)),
    db
      .select()
      .from(dailyHealth)
      .where(
        and(
          eq(dailyHealth.userId, userId),
          gte(dailyHealth.date, addDays(today, -60)),
          lte(dailyHealth.date, today),
        ),
      ),
    db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.userId, userId))
      .orderBy(desc(weeklyReviews.weekStart))
      .limit(6),
    // Both the per-discipline key and the pre-discipline one. Records are a
    // never-regressing set, so an achievement earned before insights became
    // per-discipline must not disappear the moment the key changed; for the
    // run discipline the legacy row seeds the new one. Filtered below.
    db
      .select()
      .from(computedMetrics)
      .where(
        and(
          eq(computedMetrics.userId, userId),
          inArray(computedMetrics.metricKey, [recordsMetricKey(discipline), LEGACY_RECORDS_KEY]),
        ),
      ),
    // One column, over 26 weeks of runs: the easy ceiling every
    // execution metric is measured against deserves a longer, steadier history
    // than the 12-week display window, and there is no reason to load 26 weeks
    // of full activity rows to read one number off each.
    db
      .select({ maxHeartRate: activities.maxHeartRate })
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          eq(activities.sport, "run"),
          gte(activities.startTime, `${addDays(twentySixWeeksAgo, -1)}T00:00:00Z`),
        ),
      ),
  ]);

  // Laps and matches are scoped BY ID to what was just fetched. The previous
  // full-table scans were both the slowest queries in the app and the only
  // place another account's rows could reach this response. Chunked because an
  // `inArray` binds one variable per id and D1 caps a statement at ~100.
  const [lapChunks, matchChunks] = await Promise.all([
    Promise.all(
      chunkIds(actRows.map((a) => a.id)).map((ids) =>
        db.select().from(activityLaps).where(inArray(activityLaps.activityId, ids)),
      ),
    ),
    Promise.all(
      chunkIds(workoutRows.map((w) => w.id)).map((ids) =>
        db
          .select()
          .from(workoutCompletionMatches)
          .where(
            and(
              inArray(workoutCompletionMatches.workoutId, ids),
              isNull(workoutCompletionMatches.undoneAt),
            ),
          ),
      ),
    ),
  ]);
  const lapRows = lapChunks.flat();
  const matchRows = matchChunks.flat();

  const workouts = workoutRows.map(rowToPlannedWorkout);
  const workoutById = new Map(workouts.map((w) => [w.id, w]));
  const categoryByMatchId = new Map<string, WorkoutCategory>();
  for (const m of matchRows) {
    const category = workoutById.get(m.workoutId)?.category;
    if (category != null) categoryByMatchId.set(m.id, category);
  }
  /**
   * An activity's category, or "unknown". Nothing ever defaults to "easy":
   * guessing that an unmatched run was easy silently fed hard efforts into
   * the easy-run metrics, which is exactly the number a runner would act on.
   * Every category-gated metric rejects "unknown" on its own terms.
   */
  const categoryOf = (a: (typeof actRows)[number]): WorkoutCategory =>
    a.completionMatchId ? (categoryByMatchId.get(a.completionMatchId) ?? "unknown") : "unknown";

  const lapsByActivity = new Map<string, ActivityLap[]>();
  for (const row of lapRows) {
    const lap = rowToLap(row);
    const list = lapsByActivity.get(lap.activityId);
    if (list) list.push(lap);
    else lapsByActivity.set(lap.activityId, [lap]);
  }
  const lapsOf = (activityId: string): ActivityLap[] => lapsByActivity.get(activityId) ?? [];

  const localDate = (a: (typeof actRows)[number]): string =>
    (a.startTimeLocal ?? a.startTime).slice(0, 10);
  const allSport = actRows.filter((a) => {
    const date = localDate(a);
    return date >= twelveWeeksAgo && date <= today;
  });
  // Scoped to the requested discipline for every execution/aerobic/pacing
  // metric and for records; the load signals below deliberately keep all sports
  // (a hard lift is load your legs still have to absorb) and say so in their
  // notes. `runRows` keeps its name because for the run discipline — the
  // default, and the only one with pace-based metrics — that is exactly what it
  // holds.
  const runRows = allSport.filter((a) => a.sport === discipline);
  const runs = runRows.map(rowToNormalized);
  // Only offer a discipline the user could actually look at.
  const availableDisciplines = DISCIPLINES.filter((d) => allSport.some((a) => a.sport === d));
  const isRun = discipline === "run";

  // ── Load basis: one basis for the whole window, never a mix ──
  const totalDuration = allSport.reduce((s, a) => s + a.durationSeconds, 0);
  const coveredDuration = allSport
    .filter((a) => a.trainingLoad != null)
    .reduce((s, a) => s + a.durationSeconds, 0);
  const useTrainingLoad =
    totalDuration > 0 && coveredDuration / totalDuration >= LOAD_COVERAGE_THRESHOLD;
  const loadBasisNote = useTrainingLoad
    ? "Basis: COROS training load, all sports."
    : "Basis: minutes of activity (too little of this window carries COROS training load), all sports.";

  const loadByDay = new Map<string, number>();
  for (const a of allSport) {
    const day = localDate(a);
    const load = useTrainingLoad ? (a.trainingLoad ?? 0) : a.durationSeconds / 60;
    loadByDay.set(day, (loadByDay.get(day) ?? 0) + load);
  }
  const loadsByDay = [...loadByDay.entries()].map(([date, load]) => ({ date, load }));

  const runSecondsByDay = new Map<string, number>();
  for (const a of runRows) {
    const day = localDate(a);
    runSecondsByDay.set(day, (runSecondsByDay.get(day) ?? 0) + a.durationSeconds);
  }
  const secondsByDay = [...runSecondsByDay.entries()].map(([date, seconds]) => ({ date, seconds }));

  // ── Zones ──
  // The ceiling is estimated from 26 weeks of runs, not the 12-week display
  // window: it is the line every execution metric is measured against, so it
  // should move slowly. When too few runs carry heart rate to stand behind it,
  // the estimate is still used — but it says so, on every card that uses it.
  // Counted with the estimator's own filter, not "runs with any heart rate":
  // average-only runs tell you nothing about a maximum, so letting them count
  // would suppress the caveat while the ceiling still rested on two readings.
  const hrMaxSampleCount = usableHrMaxReadings(hrMaxRows).length;
  const hrMaxEstimate = estimateHrMax(hrMaxRows);
  const hrMax = hrMaxEstimate ?? 190;
  const ceiling = easyCeiling(hrMax);
  const ceilingNote =
    hrMaxEstimate == null
      ? "Easy ceiling from a default max heart rate of 190 — no usable max-heart-rate readings in the last 26 weeks."
      : hrMaxSampleCount < MIN_HRMAX_RUNS
        ? `Ceiling estimated from only ${hrMaxSampleCount} run${hrMaxSampleCount === 1 ? "" : "s"} with a usable max heart rate in the last 26 weeks.`
        : "";

  const toIntensityInput = (a: (typeof actRows)[number]): IntensityRunInput => ({
    activityId: a.id,
    durationSeconds: a.durationSeconds,
    avgHeartRate: a.avgHeartRate,
    laps: lapsOf(a.id).map((l) => ({
      avgHeartRate: l.avgHeartRate ?? null,
      durationSeconds: l.durationSeconds,
    })),
  });
  // Two calls, two jobs. The headline the user reads is the last 4 weeks —
  // a 12-week average would let a disciplined block from two months ago hide
  // a month of running everything too hard. The full-window call exists only
  // to give the weekly stacked bars a zone split for every week they draw.
  const intensityHeadlineStart = addDays(today, -INTENSITY_HEADLINE_DAYS);
  const recentIntensity = computeLowIntensityShare(
    runRows.filter((a) => localDate(a) >= intensityHeadlineStart).map(toIntensityInput),
    hrMax,
  );
  const windowIntensity = computeLowIntensityShare(runRows.map(toIntensityInput), hrMax);

  // A day is hard when it carried a matched quality/race session, a run whose
  // category we can't vouch for but whose heart rate was above the easy
  // ceiling, or simply a very long run.
  const hardDates: string[] = [];
  for (const a of runRows) {
    const category = categoryOf(a);
    const hard =
      category === "quality" ||
      category === "race" ||
      a.durationSeconds >= LONG_RUN_HARD_SECONDS ||
      (category === "unknown" && a.avgHeartRate != null && !isEasyHr(a.avgHeartRate, hrMax));
    if (hard) hardDates.push(localDate(a));
  }

  const runSamples = runRows.map((a) => ({
    activity: rowToNormalized(a),
    laps: lapsOf(a.id),
    category: categoryOf(a),
  }));
  const efficiency = computeAerobicEfficiency(runSamples);
  const decoupling = computeDecoupling(runSamples);

  const easyRunRows = runRows.filter((a) => {
    const category = categoryOf(a);
    return (category === "easy" || category === "recovery") && (a.avgHeartRate ?? 0) > 0;
  });
  const easyDiscipline = computeEasyDiscipline(
    easyRunRows.map((a) => ({
      activityId: a.id,
      date: localDate(a),
      avgHr: a.avgHeartRate ?? 0,
    })),
    hrMax,
  );

  // ── Pacing: steady runs only. Comparing halves of an interval session
  // measures the workout's design, not the runner's pacing. ──
  interface SplitRun {
    activityId: string;
    date: string;
    title?: string;
    firstHalfPace: number;
    secondHalfPace: number;
  }
  const splitRuns: SplitRun[] = [];
  for (const a of runRows) {
    if (!STEADY_CATEGORIES.has(categoryOf(a))) continue;
    const laps = lapsOf(a.id)
      .filter((l) => (l.distanceMeters ?? 0) > 0 && l.durationSeconds > 0)
      .sort((x, y) => x.lapIndex - y.lapIndex);
    if (laps.length < 2) continue;
    const totalDistance = laps.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
    // A lap belongs to the half its MIDPOINT falls in — the same rule
    // decoupling.ts uses (see `decouplingPct`). Testing the cumulative
    // distance *before* the lap instead put every lap but the first into the
    // second half whenever the first lap was already past halfway: a 2-lap run
    // of 6km + 4km left the second half empty, `paceOf([])` returned 0, and
    // the `> 0` guard below dropped the run from the metric entirely. Two
    // unequal laps are exactly one lap per half under the midpoint rule.
    const halves: [ActivityLap[], ActivityLap[]] = [[], []];
    let covered = 0;
    for (const lap of laps) {
      const midpoint = covered + (lap.distanceMeters ?? 0) / 2;
      halves[midpoint < totalDistance / 2 ? 0 : 1].push(lap);
      covered += lap.distanceMeters ?? 0;
    }
    const paceOf = (ls: ActivityLap[]): number => {
      const distance = ls.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
      const time = ls.reduce((s, l) => s + l.durationSeconds, 0);
      return distance > 0 ? time / (distance / 1000) : 0;
    };
    const firstHalfPace = paceOf(halves[0]);
    const secondHalfPace = paceOf(halves[1]);
    if (firstHalfPace > 0 && secondHalfPace > 0) {
      splitRuns.push({
        activityId: a.id,
        date: localDate(a),
        title: activityDisplayTitle(a.title, a.sport),
        firstHalfPace,
        secondHalfPace,
      });
    }
  }
  const pacing = computePacing(splitRuns);

  // ── Plan-shaped reports ──
  // Scoped to the discipline like everything else on the page. Unscoped, this
  // card and the strip's adherence headline showed identical plan-wide numbers
  // under all three chips while the grid beside them was per-discipline — one
  // dashboard quietly reporting at two different scopes.
  const disciplineWorkouts = workouts.filter(
    (w) => disciplineOf(w.category, w.sport) === discipline,
  );
  const consistency = computeConsistency(disciplineWorkouts, range, today);

  const categoryRecord: Record<string, WorkoutCategory> = {};
  for (const [matchId, category] of categoryByMatchId) categoryRecord[matchId] = category;
  // Only runs that actually produced zone time. `perActivity` carries a
  // {0, 0} entry for every heart-rate-less run, and weeklyTraining treats the
  // presence of an entry as "zone time known" — so passing those through made
  // HR-less runs contribute their duration to the week's total but nothing to
  // either stack segment, and they silently vanished from the bars.
  const intensityByActivity: Record<string, { lowSeconds: number; highSeconds: number }> = {};
  if (windowIntensity.status === "ok") {
    for (const [activityId, split] of Object.entries(windowIntensity.value.perActivity)) {
      if (split.lowSeconds + split.highSeconds > 0) intensityByActivity[activityId] = split;
    }
  }
  const weekly = computeWeeklyTraining(runs, categoryRecord, { today, intensityByActivity });

  // Prebuilt maps, not `find` inside a loop over every workout.
  const actById = new Map(actRows.map((a) => [a.id, a]));
  const matchByWorkoutId = new Map(matchRows.map((m) => [m.workoutId, m]));
  const timeOfDayPairs: TimeOfDayPair[] = workouts.map((workout) => {
    const match = matchByWorkoutId.get(workout.id);
    const activityRow = match ? actById.get(match.activityId) : undefined;
    return activityRow ? { workout, activity: rowToNormalized(activityRow) } : { workout };
  });

  // ── Records: never regress. The window is 12 weeks, but an achievement
  // doesn't stop having happened when the run that earned it rolls out of it,
  // so the freshly computed set is merged into the persisted one. ──
  const fresh = computeRecords({
    runs: runSamples,
    weeklyAdherence: consistency.weeklyBreakdown.map((wk) => ({
      weekStart: wk.weekStart,
      adherence: wk.adherence,
    })),
    completedRunDates: runRows.map(localDate),
    discipline,
  });
  // Prefer this discipline's own row. Only when it does not exist yet does the
  // legacy pre-discipline row seed it, and only for running — those records
  // were all runs. Their ids are bare; namespacing them here keeps one id
  // space, and evidence.ts's findRecord resolves either form.
  const ownRow = storedRows.find((r) => r.metricKey === recordsMetricKey(discipline));
  const legacyRow = isRun ? storedRows.find((r) => r.metricKey === LEGACY_RECORDS_KEY) : undefined;
  const storedRecords = ownRow
    ? parseStoredRecords(ownRow.value)
    : parseStoredRecords(legacyRow?.value).map((r) => ({
        ...r,
        id: r.id.includes(":") ? r.id : `run:${r.id}`,
      }));
  const records = mergeRecords(fresh, storedRecords);
  if (JSON.stringify(records) !== JSON.stringify(storedRecords)) {
    const persisted = {
      computedAt: nowInstant(),
      inputFingerprint: stableHash(JSON.stringify(fresh)),
      status: "ok",
      sampleSize: records.length,
      value: { records },
    };
    await db
      .insert(computedMetrics)
      .values({
        id: `${recordsMetricKey(discipline)}:${userId}`,
        userId,
        metricKey: recordsMetricKey(discipline),
        ...persisted,
      })
      .onConflictDoUpdate({
        target: [computedMetrics.userId, computedMetrics.metricKey],
        set: persisted,
      });
  }

  const dismissedIds = new Set(dismissed.map((d) => d.cardId));
  const evidence = pickEvidenceCard({ workouts, range, timeOfDayPairs, records }, dismissedIds);

  // ── Interpreted metrics (educational + gentle guidance) ──
  // Disclosures appended to a card's sample note, joined with the metric's own.
  const joinNotes = (...parts: string[]): string => parts.filter(Boolean).join(" ");
  const noHrNote =
    recentIntensity.status === "ok" && recentIntensity.value.noHrSeconds > 0
      ? `${Math.round(recentIntensity.value.noHrSeconds / 60)} min of running had no heart rate and was excluded.`
      : "";

  const interpreted: InterpretedMetric[] = [
    withNote(
      interpret("loadRatio", "Load vs your norm", computeLoadRatio(loadsByDay, today), (v) => ({
        value: `${signed(v.pctVsNorm)}% vs your norm`,
        band: v.ratio > 1.5 ? "high" : v.ratio >= 1.3 ? "watch" : v.ratio < 0.8 ? "low" : "healthy",
        range: "sweet spot 0.8–1.3",
        gauge: { min: 0.5, max: 2, healthyLo: 0.8, healthyHi: 1.3, value: v.ratio },
        series: v.series.map((p) => ({ date: p.date, value: p.ratio })),
        // The baseline IS 1: the ratio is this week against the month behind
        // it, so 1.0 means "this week looks like your norm" by construction —
        // not an estimate that could have come out anywhere else. Emitting it
        // (in the series' own unit, like restingHr's bpm and hrv's ms) is what
        // makes the tile drillable: `hasDrilldown` opens the baseline-band
        // chart for series+baseline, and 56 daily ratios against the 0.8–1.3
        // sweet spot is a real chart — where the number has been all block,
        // not just where it is today.
        baseline: { value: 1, lo: 0.8, hi: 1.3, unit: "× norm" },
        meaning:
          "Your last week of training compared with the month behind it, smoothed so one big day neither " +
          "spikes the number nor abruptly falls out of it. Around 1.0 means this week looks like your norm.",
        suggestion:
          v.ratio > 1.5
            ? "That's a large jump on your recent norm — the range where injuries tend to cluster. A few easier days brings it back."
            : v.ratio >= 1.3
              ? "You're training meaningfully above your norm. Fine as a planned build; worth noticing if it wasn't deliberate."
              : v.ratio < 0.8
                ? "You're below your recent norm — which is exactly right for a down week or a taper."
                : undefined,
      })),
      loadBasisNote,
    ),
    interpret("ramp", "7-day ramp", computeRamp(secondsByDay, today), (v) => ({
      value: `${signed(Math.round(v.deltaSeconds / 60))} min (${signed(v.pct)}%)`,
      band: v.pct > 30 ? "high" : v.pct > 15 ? "watch" : "healthy",
      range: "under ~15%",
      gauge: { min: -50, max: 60, healthyLo: -50, healthyHi: 15, value: v.pct },
      meaning:
        `How much ${discipline === "run" ? "running" : sessionNoun(discipline)} time you did in the last 7 days ` +
        "versus your average week across the 3 weeks before it.",
      suggestion:
        v.pct > 30
          ? "A jump this size is where tissue tends to complain — hold the next week flat and let it catch up."
          : v.pct > 15
            ? "A little above the usual guidance of ~15% a week. Sustainable for a week; less so as a habit."
            : undefined,
    })),
    withNote(
      interpret("monotony", "Load variety", computeMonotony(loadsByDay, today), (v) => ({
        value: v.monotony.toFixed(2),
        band: v.monotony > 2 ? "high" : v.monotony >= 1.5 ? "watch" : "healthy",
        range: "under 1.5",
        gauge: { min: 0.5, max: 3, healthyLo: 0.5, healthyHi: 1.5, value: v.monotony },
        meaning:
          `How alike your last 7 days looked. It rises when every day carries the same load and there are no ` +
          `genuinely easy days between the hard ones. This week totalled ${v.weeklyLoad}, for a strain of ` +
          `${v.strain} (weekly load × monotony).`,
        suggestion:
          v.monotony > 2
            ? "Every day is landing at much the same effort. A real rest day — or one clearly easy one — does more than trimming every day equally."
            : v.monotony >= 1.5
              ? "Your days are looking quite alike. Making the easy ones easier is usually better than making the hard ones harder."
              : undefined,
      })),
      loadBasisNote,
    ),
    interpret(
      "restingHr",
      "Resting heart rate",
      computeRestingHr(
        healthRows.map((h) => ({ date: h.date, restingHeartRate: h.restingHeartRate })),
        today,
      ),
      (v) => {
        const stale = v.staleDays > RECOVERY_STALE_DAYS;
        return {
          value: `${v.current} bpm`,
          band: stale ? undefined : v.deltaBpm >= 5 ? "watch" : "healthy",
          range: `your baseline ${v.baseline} bpm`,
          gauge: stale
            ? undefined
            : {
                min: v.baseline - 10,
                max: v.baseline + 10,
                healthyLo: v.baseline - 10,
                healthyHi: v.baseline + 5,
                value: v.current,
              },
          series: v.series,
          // Band edges in the SERIES' unit (bpm), which the gauge above can't
          // supply: its `min` is a drawn floor (baseline − 10), not a claim
          // that a reading 10 bpm low means anything. ±5 bpm IS the metric's
          // own threshold — `deltaBpm >= 5` is what turns the band to "watch".
          baseline: { value: v.baseline, lo: v.baseline - 5, hi: v.baseline + 5, unit: "bpm" },
          staleNote: stale ? `last reading ${days(v.staleDays)} ago` : undefined,
          meaning:
            "The median of your three most recent resting heart-rate readings — all from the last five days — " +
            "against your 30-day median. " +
            "A sustained rise often shows up before you feel it — fatigue, a cold coming on, a poor stretch of sleep.",
          suggestion:
            !stale && v.deltaBpm >= 5
              ? `${v.deltaBpm} bpm above your baseline. One day means little; if it holds for a few, take the easier option.`
              : undefined,
        };
      },
    ),
    interpret(
      "hrv",
      "HRV trend",
      computeHrvTrend(
        healthRows.map((h) => ({ date: h.date, hrv: h.hrv })),
        today,
      ),
      (v) => {
        const stale = v.staleDays > RECOVERY_STALE_DAYS;
        const below = v.pctVsBaseline <= -v.thresholdPct;
        return {
          value: `${signed(v.pctVsBaseline)}% vs baseline`,
          band: stale ? undefined : below ? "watch" : "healthy",
          range: `within ${v.thresholdPct}% of your ${v.baseline} ms baseline`,
          gauge: stale
            ? undefined
            : { min: -25, max: 25, healthyLo: -v.thresholdPct, healthyHi: 25, value: v.pctVsBaseline },
          series: v.series,
          // In milliseconds, like `series` — the gauge above is drawn in
          // percent-vs-baseline, so its healthy edges are in the wrong unit
          // for a chart of the raw readings. Rounded to whole ms because the
          // readings themselves are integers.
          baseline: {
            value: v.baseline,
            lo: Math.round(v.baseline * (1 - v.thresholdPct / 100)),
            hi: Math.round(v.baseline * (1 + v.thresholdPct / 100)),
            unit: "ms",
          },
          staleNote: stale ? `last reading ${days(v.staleDays)} ago` : undefined,
          meaning:
            "Your recent heart-rate variability against a baseline built from earlier, separate readings. " +
            `Day-to-day HRV wanders, so the line that means anything for you is ±${v.thresholdPct}% — ` +
            "derived from your own variability, not a number from a magazine.",
          suggestion:
            !stale && below
              ? "A drop past your own noise threshold usually means accumulated stress — training, sleep, life. Easy days work here."
              : undefined,
        };
      },
    ),
    withNote(
      interpret("hardStack", "Hard-day stacking", computeHardDayStacking(hardDates, today), (v) => ({
        value: days(v.consecutive),
        band: v.consecutive >= 2 ? "watch" : "healthy",
        range: "one hard day at a time",
        // No gauge: the dashboard draws this one as a strip (7 daily boxes),
        // not a bullet gauge — see signal-tiles.tsx's gauge>sparkline>strip
        // priority, which would otherwise hide the strip behind a gauge.
        strip: v.strip.map((d) => ({ date: d.date, on: d.hard })),
        meaning:
          "Consecutive hard days ending today — or yesterday, if today hasn't happened yet. A day counts as hard " +
          `when it was a matched quality or race session, a ${sessionNoun(discipline)} of ` +
          `${LONG_RUN_HARD_SECONDS / 60} minutes or more, or a ${sessionNoun(discipline)} with no planned session ` +
          "behind it whose heart rate sat above your easy ceiling.",
        suggestion:
          v.consecutive >= 2
            ? "Back-to-back hard days leave less room to absorb the work — the easy day between them is what makes the hard ones count."
            : undefined,
      })),
      // One of hardStack's three "hard day" tests is `avgHeartRate` above the
      // easy ceiling, so when that ceiling rests on a default or on two
      // readings, this card's number does too — same disclosure
      // easyDiscipline and lowIntensityShare already carry.
      ceilingNote,
    ),
    withNote(
      interpret("lowIntensityShare", "Low-intensity share", recentIntensity, (v) => ({
        value: `${v.lowPct}%`,
        band: v.lowPct < 65 ? "high" : v.lowPct < 75 ? "watch" : "healthy",
        range: "aim ≥75%, classic target ~80%",
        gauge: { min: 40, max: 100, healthyLo: 75, healthyHi: 100, value: v.lowPct },
        meaning:
          `Share of your running time over the last 4 weeks spent at or under your easy ceiling of ${ceiling} bpm, ` +
          "measured lap by lap so a hard surge inside an otherwise-easy run still counts as hard. Easy running " +
          "isn't the lesser kind — it's the engine the hard sessions run on.",
        suggestion:
          v.lowPct < 65
            ? "Most of the well-tested approaches keep three quarters or more of running time easy. More easy time, not less, is usually the fix."
            : v.lowPct < 75
              ? "A little intensity-heavy. Slowing the easy runs down costs nothing and pays into everything else."
              : undefined,
      })),
      joinNotes(noHrNote, ceilingNote),
    ),
    withNote(
      interpret("easyDiscipline", "Easy-run discipline", easyDiscipline, (v) => ({
        value: `${v.inEasyPct}%`,
        band: v.inEasyPct < 80 ? "watch" : "healthy",
        range: "≥80%",
        // No gauge: this one draws as a strip (one box per run) on the
        // dashboard — see the hardStack comment above for why.
        strip: v.ticks.map((t) => ({ date: t.date, on: t.easy })),
        meaning:
          `Share of your planned easy and recovery runs whose average heart rate actually stayed at or under ` +
          `your easy ceiling of ${ceiling} bpm.`,
        suggestion:
          v.inEasyPct < 80
            ? "Easy runs drifting hard is the most common way a plan quietly stops working. The fix is slower, not shorter."
            : undefined,
      })),
      ceilingNote,
    ),
    interpret("pacing", "Pacing", pacing, (v) => {
      const delta = Math.round(v.medianDeltaSecPerKm);
      return {
        value: delta === 0 ? "even" : delta > 0 ? `+${delta} s/km late` : `${delta} s/km late`,
        meaning:
          "How your second half typically compares with your first on steady runs — positive means you faded, " +
          `negative means you finished faster. ${v.negativePct}% of those runs finished faster than they started. ` +
          "Descriptive, not a target: a fade on a hilly or hot run says more about the day than about you.",
      };
    }),
  ]
    // Pace-based cards are omitted outright for strength and yoga. Rendering
    // "Easy-run discipline" over a lifting history would not just be empty —
    // it would be wrong.
    .filter((m) => supportsMetric(discipline, m.id));

  // ── Per-run evidence (drilldowns) ──
  // Easy-run discipline: every contributing run with its per-lap HR against the
  // easy ceiling, so "78%" is inspectable down to the exact lap that broke it.
  // `over` uses the same isEasyHr predicate the metric itself used — a
  // drill-down that disagrees with its own headline is worse than none.
  const easyDetailRuns: MetricRunDetail[] = easyRunRows.map((a) => {
    // `over` is decided on the RAW average, exactly as computeEasyDiscipline
    // decided the tick; rounding is for display only. Deciding it on the
    // rounded value made a run at 144.4 bpm against a 144 ceiling show a red
    // tick above a row reading "Stayed easy" — the metric disagreeing with its
    // own evidence is the failure this whole drill-down exists to prevent.
    const rawAvgHr = a.avgHeartRate ?? 0;
    const avgHr = Math.round(rawAvgHr);
    const over = !isEasyHr(rawAvgHr, hrMax);
    const laps = lapsOf(a.id)
      .filter((l) => l.durationSeconds > 0)
      .sort((x, y) => x.lapIndex - y.lapIndex)
      .map((l) => ({
        lapIndex: l.lapIndex,
        avgHr: l.avgHeartRate,
        durationSeconds: l.durationSeconds,
        distanceMeters: l.distanceMeters,
        over: l.avgHeartRate != null ? !isEasyHr(l.avgHeartRate, hrMax) : false,
      }));
    return {
      activityId: a.id,
      date: localDate(a),
      title: activityDisplayTitle(a.title, a.sport),
      value: `avg ${avgHr} bpm`,
      over,
      note: over
        ? `Averaged ${avgHr} bpm — above your easy ceiling of ${ceiling}.`
        : `Stayed easy — averaged ${avgHr} bpm, under your ${ceiling} bpm ceiling.`,
      laps: laps.length >= 2 ? laps : undefined,
    };
  });

  const pacingDetailRuns: MetricRunDetail[] = splitRuns.map((s) => {
    const raw = s.secondHalfPace - s.firstHalfPace; // positive = faded
    // EVERY published field branches on the rounded delta, never the raw one.
    // A raw 0.03 s/km rounds to a published `delta` of 0, and a row that calls
    // that a fade — `over: true`, "faded 0 s/km", "went out a touch hot" —
    // contradicts the 0 sitting next to it, breaks the sign agreement
    // MetricRunDetail.delta promises, and paints itself red for a difference
    // it just told you was nothing.
    const scaled = Math.round(raw * 10);
    // `|| 0` normalizes the -0 a small negative delta produces: it compares
    // equal to 0 with ===, but not with Object.is, which is what serializers
    // and test matchers reach for.
    const delta = (scaled || 0) / 10;
    const abs = Math.abs(delta);
    // Sub-1 s/km keeps its decimal, so a real (if tiny) difference is never
    // rendered as "0 s/km" — the bug this branch exists to avoid, one
    // magnitude up.
    const magnitude = `${abs < 1 ? abs : Math.round(abs)} s/km`;
    return {
      activityId: s.activityId,
      date: s.date,
      title: s.title,
      value:
        delta === 0 ? "even split" : delta < 0 ? `finished ${magnitude} faster` : `faded ${magnitude}`,
      delta,
      over: delta > 0,
      note:
        delta === 0
          ? "First and second half effectively even."
          : delta < 0
            ? "Second half faster — a negative split."
            : "Second half slower — went out a touch hot.",
    };
  });

  const detailByMetric: Record<string, MetricDetail> = {
    easyDiscipline: {
      explain:
        `Measured against your easy ceiling of ${ceiling} bpm — the top of zone 2, estimated from a max ` +
        `heart rate of ${hrMax}. A run counts as disciplined when its average heart rate stays at or under ` +
        `that line. Red laps are where it slipped over.`,
      threshold: { label: "easy ceiling", value: ceiling, unit: "bpm" },
      runs: easyDetailRuns,
    },
    pacing: {
      explain:
        "Each steady run's first-half pace against its second half, from your recorded laps. Interval and " +
        "race sessions are left out — their halves differ by design, which says nothing about pacing.",
      runs: pacingDetailRuns,
    },
  };
  for (const m of interpreted) {
    const detail = detailByMetric[m.id];
    if (detail && m.status === "ok" && detail.runs.length > 0) m.detail = detail;
  }

  // Pace-based cards are ABSENT for strength and yoga, never present-but-empty:
  // an empty card says "your data is missing", when the truth is that the
  // question does not apply to a lift.
  return c.json({
    discipline,
    availableDisciplines,
    consistency,
    weekly,
    ...(isRun ? { efficiency, decoupling } : {}),
    records,
    evidence,
    reviews,
    interpreted,
  });
});

insightRoutes.post("/dismiss", async (c) => {
  const { cardId } = await c.req.json<{ cardId: string }>();
  await c
    .get("db")
    .insert(dismissedInsights)
    .values({ id: newId(), userId: c.get("userId"), cardId, dismissedAt: nowInstant() })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

// ── Settings & diagnostics ───────────────────────────────────────────────────

export const settingsRoutes = new Hono<AppContext>();
settingsRoutes.use("*", requireUser);

settingsRoutes.get("/", async (c) => {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  const budget = await llmBudgetStatus(c.get("db"), c.get("userId"));
  return c.json({
    prefs,
    llm: {
      spentDollars: budget.spentMicros / 1_000_000,
      warnDollars: LLM_BUDGET.warnMicros / 1_000_000,
      cutoffDollars: LLM_BUDGET.cutoffMicros / 1_000_000,
      maxDollars: LLM_BUDGET.absoluteMaxMicros / 1_000_000,
      warn: budget.warn,
      cutoff: budget.cutoff,
    },
  });
});

settingsRoutes.put("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const body = await c.req.json();
  const current = await loadPreferences(db, userId);
  const parsed = userPreferencesSchema.safeParse({ ...current, ...body });
  if (!parsed.success) return c.json({ error: "invalid_preferences", details: parsed.error.issues }, 400);
  await savePreferences(db, userId, parsed.data);
  // Flipping COROS writes on must heal any moves that queued while writes
  // were off (or no device was paired) — emitPendingWork's only other call
  // site is the bridge-sync route, so without this the toggle silently did
  // nothing until the next bridge sync happened to run.
  if (!current.corosWritesEnabled && parsed.data.corosWritesEnabled) {
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
  }
  // Buffer/time changes flow into the calendar mirror.
  await syncCalendar(db, c.env, userId).catch(() => undefined);
  return c.json({ ok: true, prefs: parsed.data });
});

settingsRoutes.get("/diagnostics", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const devices = await db.select().from(desktopDevices).where(eq(desktopDevices.userId, userId));
  const connections = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.userId, userId));
  const jobs = await db
    .select()
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.userId, userId))
    .orderBy(desc(corosWriteJobs.requestedAt))
    .limit(10);
  const errors = await db.select().from(syncErrors).orderBy(desc(syncErrors.createdAt)).limit(15);
  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(10);
  const garden = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1))[0];
  const budget = await llmBudgetStatus(db, userId);
  const lastCorosRead = runs.find((r) => r.kind === "coros_read");

  return c.json({
    appVersion: "0.1.0",
    fixtureMode: c.env.FIXTURE_MODE === "1",
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      appVersion: d.appVersion,
      bridgeVersion: d.bridgeVersion,
      capabilities: d.capabilities,
      lastSeenAt: d.lastSeenAt,
      bridgePaused: d.bridgePaused,
      revokedAt: d.revokedAt,
    })),
    providers: connections.map((p) => ({
      provider: p.provider,
      status: p.status,
      lastSyncAt: p.lastSyncAt,
      lastErrorCategory: p.lastErrorCategory,
    })),
    coros: {
      lastRead: lastCorosRead?.finishedAt ?? null,
      pendingWriteJobs: jobs.filter((j) => ["queued", "claimed", "in_progress", "verifying"].includes(j.status)).length,
      recentJobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        pathUsed: j.pathUsed,
        degraded: j.degraded,
        attemptCount: j.attemptCount,
        requestedAt: j.requestedAt,
        lastErrorCategory: j.lastErrorCategory,
      })),
    },
    versions: {
      simulation: SIMULATION_VERSION,
      normalizer: NORMALIZER_VERSION,
      estimator: ESTIMATOR_VERSION,
      gardenLastSimulated: garden?.lastSimulatedDate ?? null,
    },
    llmCost7dDollars: budget.spentMicros / 1_000_000,
    recentErrors: errors,
    recentSyncRuns: runs,
  });
});

/** Full personal data export (sanitized: no tokens, no credentials). */
settingsRoutes.get("/export", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const [prefs, workouts, acts, laps, matches, health, sleep, gardenRows, events, reviews, usage] =
    await Promise.all([
      loadPreferences(db, userId),
      db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId)),
      db.select().from(activities).where(eq(activities.userId, userId)),
      db.select().from(activityLaps),
      db.select().from(workoutCompletionMatches),
      db.select().from(dailyHealth).where(eq(dailyHealth.userId, userId)),
      db.select().from(sleepRecords).where(eq(sleepRecords.userId, userId)),
      db.select().from(gardenState).where(eq(gardenState.userId, userId)),
      db.select().from(gardenEvents).where(eq(gardenEvents.userId, userId)),
      db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, userId)),
      db.select().from(llmUsage).where(eq(llmUsage.userId, userId)),
    ]);
  c.header("Content-Disposition", 'attachment; filename="run-garden-export.json"');
  return c.json({
    exportedAt: nowInstant(),
    preferences: prefs,
    plannedWorkouts: workouts,
    activities: acts,
    laps,
    completionMatches: matches,
    dailyHealth: health,
    sleep,
    garden: gardenRows[0]?.snapshot ?? null,
    gardenEvents: events,
    weeklyReviews: reviews,
    llmUsage: usage,
  });
});

/**
 * Delete every row belonging to this account. Exported rather than inlined in
 * the route so the table list is directly testable — a table forgotten here
 * leaves the user's data behind after they asked for it to be gone, and a
 * route-shaped test cannot see that.
 */
export async function deleteAllUserData(db: Db, userId: string): Promise<void> {
  const {
    activityLaps,
    activitySourceLinks,
    activityStreamSummaries,
    backfillState,
    calendarEventSuppressions,
    coachLocks,
    coachMemory,
    coachMessages,
    coachPlans,
    coachPlanWeeks,
    coachProposals,
    coachQuestions,
    coachReads,
    coachTriggers,
    corosScheduleSnapshots,
    corosWriteAttempts,
    computedMetrics,
    deviceHandshakes,
    dismissedInsights,
    gardenDayInputs,
    gardenPlants,
    gardenSceneLayouts,
    gardenSeen,
    gardenSnapshots,
    gardenUnlocks,
    gardenVisitors,
    gardenWildlife,
    motivationEvidence,
    oauthStates,
    plannedWorkoutStages,
    providerCursorState,
    scheduleOverrides,
    sessions,
    studioPlanPushes,
    studioPlans,
    syncErrors,
    syncIntents,
    syncNotes,
    syncRuns,
    trainingPlanVersions,
    workoutCompletionMatches,
  } = await import("@rg/database");

  // Child tables keyed by workout/activity/job (not userId) — single-user, so
  // clearing them entirely is correct and leaves no orphans.
  //
  // NOTHING BELONGING TO ANOTHER ACCOUNT MAY GO IN THIS LIST. Every table here
  // is deleted with no WHERE clause, so a table that can hold a second user's
  // rows would be wiped wholesale by one account's deletion. `studioPlanPushes`
  // was briefly here and is not: it is keyed by studio plan, and studio plans
  // are per-user, so it is deleted plan-scoped below instead.
  const childTables = [
    activityLaps,
    activitySourceLinks,
    activityStreamSummaries,
    calendarEventLinks,
    calendarEventSuppressions,
    corosWriteAttempts,
    plannedWorkoutStages,
    scheduleOverrides,
    trainingPlanVersions,
    workoutCompletionMatches,
  ] as const;
  for (const t of childTables) await db.delete(t as any);

  // Push rows carry no userId — they are reached through their studio plan.
  // Scoped to THIS user's plans, and done BEFORE the plans themselves are
  // deleted, or the ids needed to find them would be gone.
  const myStudioPlanIds = (
    await db
      .select({ id: studioPlans.id })
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
  ).map((p) => p.id);
  for (const ids of chunkIds(myStudioPlanIds)) {
    await db.delete(studioPlanPushes).where(inArray(studioPlanPushes.planId, ids));
  }

  // Same shape as studioPlanPushes above: coach_plan_weeks carries no userId,
  // only planId, so it is reached through this account's coach plans and
  // cleared BEFORE coachPlans itself (below, in userTables) removes the ids.
  const myCoachPlanIds = (
    await db.select({ id: coachPlans.id }).from(coachPlans).where(eq(coachPlans.userId, userId))
  ).map((p) => p.id);
  for (const ids of chunkIds(myCoachPlanIds)) {
    await db.delete(coachPlanWeeks).where(inArray(coachPlanWeeks.planId, ids));
  }

  // User-scoped tables.
  const userTables = [
    plannedWorkouts,
    activities,
    dailyHealth,
    sleepRecords,
    gardenEvents,
    gardenState,
    gardenPlants,
    gardenSnapshots,
    gardenDayInputs,
    gardenUnlocks,
    gardenWildlife,
    gardenVisitors,
    gardenSeen,
    gardenSceneLayouts,
    weeklyReviews,
    llmUsage,
    corosWriteJobs,
    corosScheduleSnapshots,
    computedMetrics,
    motivationEvidence,
    dismissedInsights,
    desktopDevices,
    providerConnections,
    providerCursorState,
    userPreferences,
    trainingPlans,
    studioPlans,
    syncErrors,
    syncRuns,
    syncIntents,
    syncNotes,
    auditEvents,
    sessions,
    backfillState,
    coachMemory,
    coachQuestions,
    coachMessages,
    coachProposals,
    coachTriggers,
    coachReads,
    coachLocks,
    coachPlans,
  ] as const;
  for (const t of userTables) {
    const table = t as unknown as { userId: never };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.delete(t as any) as any).where(eq(table.userId, userId as never));
  }
  // Tables without a userId column — single-user, clear entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of [deviceHandshakes, oauthStates] as const) await db.delete(t as any);
  await db.delete(users).where(eq(users.id, userId));
}

/** Full deletion of all cloud data (single-user: every row belongs to them). */
settingsRoutes.post("/delete-all", async (c) => {
  const confirm = (await c.req.json<{ confirm?: string }>()).confirm;
  if (confirm !== "delete everything") return c.json({ error: "confirmation_required" }, 400);
  await deleteAllUserData(c.get("db"), c.get("userId"));
  return c.json({ ok: true });
});
