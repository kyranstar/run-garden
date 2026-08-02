import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  activityLaps,
  auditEvents,
  calendarEventLinks,
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
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  userPreferencesSchema,
} from "@rg/domain";
import {
  computeAcwr,
  computeAerobicEfficiency,
  computeBalance,
  computeConsistency,
  computeEasyDiscipline,
  computeHardDayStacking,
  computeHrDrift,
  computeHrvTrend,
  computeRampRate,
  computeRecords,
  computeRestingHr,
  computeTimeOfDay,
  computeWeeklyTraining,
  estimateHrMax,
  interpret,
  negativeSplit,
  pickEvidenceCard,
  predictRaces,
  type InterpretedMetric,
} from "@rg/analytics";
import { SIMULATION_VERSION } from "@rg/garden-engine";
import { NORMALIZER_VERSION, normalizeStravaActivity } from "@rg/providers";
import { ESTIMATOR_VERSION } from "@rg/scheduling";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { googleCalendarClient } from "../services/google-calendar.js";
import { loadPreferences, savePreferences, syncCalendar } from "../services/calendar-sync.js";
import { llmBudgetStatus, LLM_BUDGET } from "../services/llm.js";
import { stravaClient } from "../services/strava.js";
import {
  ingestActivities,
  promoteProvisionalMatches,
  repairDurations,
  repairTimestamps,
} from "../services/completion.js";
import { resimulateFrom } from "../services/garden-sync.js";

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
      title: w.title,
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

  return c.json({
    activities: rows.map((a) => {
      const match = a.completionMatchId ? matchById.get(a.completionMatchId) : undefined;
      const wo = match ? woById.get(match.workoutId) : undefined;
      return {
        id: a.id,
        startTime: a.startTime,
        startTimeLocal: a.startTimeLocal,
        date: (a.startTimeLocal ?? a.startTime).slice(0, 10),
        title: a.title,
        sport: a.sport,
        durationSeconds: a.durationSeconds,
        distanceMeters: a.distanceMeters,
        avgPaceSecPerKm: a.avgPaceSecPerKm,
        matched: wo
          ? { workoutId: wo.id, title: wo.title, category: wo.category, date: wo.effectiveDate }
          : null,
      };
    }),
  });
});

/** Backfill: pull recent Strava run history and ingest + match it. */
activityRoutes.post("/backfill", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Self-heal stored data first (centisecond durations/timestamps, split
  // COROS/Strava pairs, stuck provisional matches) — even if Strava is offline.
  await repairDurations(db, userId);
  const repairedDates = await repairTimestamps(db, userId);
  const promoted = await promoteProvisionalMatches(db);
  if (repairedDates.length > 0) {
    const prefs = await loadPreferences(db, userId);
    await resimulateFrom(db, userId, repairedDates[0]!, prefs).catch(() => undefined);
  }

  const client = await stravaClient(db, c.env, userId);
  if (!client)
    return c.json({ ok: false, reason: "strava_unavailable", ingested: 0, matched: promoted });
  const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 90)));
  const afterEpoch = Math.floor(Date.parse(nowInstant()) / 1000) - days * 86400;
  let sources;
  try {
    const raws = await client.listActivities(afterEpoch, 100);
    sources = raws.map(normalizeStravaActivity).filter((s) => s.sport === "run");
  } catch {
    return c.json({ ok: false, reason: "strava_error", ingested: 0, matched: promoted });
  }
  if (sources.length === 0) return c.json({ ok: true, ingested: 0, matched: promoted });
  const stats = await ingestActivities(db, { userId, sources });
  if (stats.affectedDates.length > 0) {
    const prefs = await loadPreferences(db, userId);
    await resimulateFrom(db, userId, stats.affectedDates[0]!, prefs).catch(() => undefined);
  }
  return c.json({
    ok: true,
    ingested: stats.newActivities + stats.mergedPairs,
    matched: stats.matchesCreated + promoted,
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
  return c.json({ activities: rows.filter((a) => a.sport === "run") });
});

// ── Insights ─────────────────────────────────────────────────────────────────

export const insightRoutes = new Hono<AppContext>();
insightRoutes.use("*", requireUser);

insightRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const twelveWeeksAgo = addDays(startOfIsoWeek(today), -7 * 12);

  const workouts = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, twelveWeeksAgo),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  const acts = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, `${twelveWeeksAgo}T00:00:00Z`)));
  const matches = await db
    .select()
    .from(workoutCompletionMatches)
    .where(isNull(workoutCompletionMatches.undoneAt));
  const laps = await db.select().from(activityLaps);
  const dismissed = await db
    .select()
    .from(dismissedInsights)
    .where(eq(dismissedInsights.userId, userId));

  const workoutById = new Map(workouts.map((w) => [w.id, w]));
  const categoryByMatchId = new Map(
    matches
      .map((m) => [m.id, workoutById.get(m.workoutId)?.category] as const)
      .filter(([, cat]) => cat != null),
  );
  const lapsByActivity = new Map<string, typeof laps>();
  for (const lap of laps) {
    const list = lapsByActivity.get(lap.activityId) ?? [];
    list.push(lap);
    lapsByActivity.set(lap.activityId, list);
  }

  const workoutsDomain = workouts.map((w) => ({
    ...w,
    sourceProvider: "coros" as const,
    stages: [],
  })) as never[];

  const range = { start: twelveWeeksAgo, end: today };
  const consistency = computeConsistency(workoutsDomain as never, range);

  const categoryRecord: Record<string, string> = {};
  for (const [matchId, cat] of categoryByMatchId) categoryRecord[matchId] = cat as string;
  const weekly = computeWeeklyTraining(acts as never, categoryRecord as never);

  const runSamples = acts.map((a) => ({
    activity: a as never,
    laps: (lapsByActivity.get(a.id) ?? []) as never,
    category: (a.completionMatchId
      ? (categoryByMatchId.get(a.completionMatchId) ?? "easy")
      : "easy") as never,
  }));
  const efficiency = computeAerobicEfficiency(runSamples as never);
  const drift = computeHrDrift(runSamples as never);

  const timeOfDayPairs = (workoutsDomain as Array<{ id: string }>).map((w) => {
    const m = matches.find((mm) => mm.workoutId === w.id);
    return {
      workout: w as never,
      activity: m ? (acts.find((a) => a.id === m.activityId) as never) : undefined,
    };
  });
  const timeOfDay = computeTimeOfDay(timeOfDayPairs as never);

  const records = computeRecords({
    runs: runSamples as never,
    executions: [],
    weeklyAdherence: consistency.weeklyBreakdown.map((wk) => ({
      weekStart: wk.weekStart,
      adherence: wk.adherence,
    })),
    completedRunDates: acts.map((a) => (a.startTimeLocal ?? a.startTime).slice(0, 10)),
  });

  const dismissedIds = new Set(dismissed.map((d) => d.cardId));
  const evidenceRaw = pickEvidenceCard({
    workouts: workoutsDomain as never,
    range,
    timeOfDayPairs: timeOfDayPairs as never,
    records,
  });
  const evidence = evidenceRaw && !dismissedIds.has(evidenceRaw.id) ? evidenceRaw : null;

  // ── Interpreted metrics (educational + gentle guidance) ──
  const hrMax = estimateHrMax(acts as never) ?? 190;
  const loadDay = new Map<string, number>();
  const weekSec = new Map<string, number>();
  const catSec = { easy: 0, quality: 0, long: 0 };
  const hardDates: string[] = [];
  const easyRuns: Array<{ avgHr: number }> = [];
  let bestRun: { distanceMeters: number; durationSeconds: number } | null = null;
  for (const a of acts) {
    const day = (a.startTimeLocal ?? a.startTime).slice(0, 10);
    loadDay.set(day, (loadDay.get(day) ?? 0) + (a.trainingLoad ?? a.durationSeconds / 60));
    weekSec.set(startOfIsoWeek(day), (weekSec.get(startOfIsoWeek(day)) ?? 0) + a.durationSeconds);
    const cat = a.completionMatchId ? categoryByMatchId.get(a.completionMatchId) : undefined;
    if (cat === "quality" || cat === "race") {
      catSec.quality += a.durationSeconds;
      hardDates.push(day);
    } else if (cat === "long") catSec.long += a.durationSeconds;
    else catSec.easy += a.durationSeconds;
    if ((cat === "easy" || cat === "recovery" || !cat) && a.avgHeartRate) easyRuns.push({ avgHr: a.avgHeartRate });
    if ((a.distanceMeters ?? 0) >= 3000 && a.durationSeconds > 0) {
      const pace = a.durationSeconds / (a.distanceMeters! / 1000);
      const bestPace = bestRun ? bestRun.durationSeconds / (bestRun.distanceMeters / 1000) : Infinity;
      if (pace < bestPace) bestRun = { distanceMeters: a.distanceMeters!, durationSeconds: a.durationSeconds };
    }
  }
  const loadsByDay = [...loadDay.entries()].map(([date, load]) => ({ date, load }));
  const weeklySeconds = [...weekSec.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, s]) => s);

  const splitRuns: Array<{ firstHalfPace: number; secondHalfPace: number }> = [];
  for (const a of acts) {
    const rl = (lapsByActivity.get(a.id) ?? [])
      .filter((l) => (l.distanceMeters ?? 0) > 0 && l.durationSeconds > 0)
      .sort((x, y) => x.lapIndex - y.lapIndex);
    if (rl.length < 2) continue;
    const totalD = rl.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
    let acc = 0;
    const half: [typeof rl, typeof rl] = [[], []];
    for (const l of rl) {
      half[acc < totalD / 2 ? 0 : 1].push(l);
      acc += l.distanceMeters ?? 0;
    }
    const pace = (ls: typeof rl) => {
      const d = ls.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
      const t = ls.reduce((s, l) => s + l.durationSeconds, 0);
      return d > 0 ? t / (d / 1000) : 0;
    };
    const fp = pace(half[0]);
    const sp = pace(half[1]);
    if (fp > 0 && sp > 0) splitRuns.push({ firstHalfPace: fp, secondHalfPace: sp });
  }

  const health = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, addDays(today, -35))));

  const fmtDur = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  };

  const interpreted: InterpretedMetric[] = [
    interpret("acwr", "Training load balance", computeAcwr(loadsByDay, today), (v) => ({
      value: v.acwr.toFixed(2),
      band: v.acwr > 1.5 ? "watch" : v.acwr < 0.8 ? "low" : "healthy",
      range: "sweet spot 0.8–1.3",
      meaning:
        "How your recent 7-day training load compares to your month-long average. A spike means you ramped up fast.",
      suggestion:
        v.acwr > 1.5
          ? "A ratio this high tends to precede injury — this week is a big jump on your norm."
          : v.acwr < 0.8
            ? "You're below your recent norm — fine for a planned down week."
            : undefined,
    })),
    interpret("ramp", "Weekly ramp", computeRampRate(weeklySeconds), (v) => ({
      value: `${v.pct > 0 ? "+" : ""}${v.pct}%`,
      band: v.pct > 10 ? "watch" : "healthy",
      range: "under ~10%/week",
      meaning: "How much your running time changed from last week.",
      suggestion: v.pct > 10 ? "Jumps much above ~10%/week tend to raise injury risk." : undefined,
    })),
    interpret("balance", "Easy / hard balance", computeBalance(catSec, acts.length), (v) => ({
      value: `${v.easyPct}% easy`,
      band: v.easyPct >= 75 ? "healthy" : "watch",
      range: "~80% easy",
      meaning: `Share of running time by type: ${v.easyPct}% easy, ${v.qualityPct}% quality, ${v.longPct}% long.`,
      suggestion: v.easyPct < 75 ? "The most durable training keeps roughly 80% of time easy." : undefined,
    })),
    interpret(
      "restingHr",
      "Resting heart rate",
      computeRestingHr(health.map((h) => ({ date: h.date, restingHeartRate: h.restingHeartRate }))),
      (v) => ({
        value: `${v.latest} bpm`,
        band: v.deltaBpm >= 5 ? "watch" : "healthy",
        range: `your baseline ${v.baseline} bpm`,
        meaning:
          "Your resting heart rate versus your 30-day median. A sustained rise can signal fatigue or illness.",
        suggestion:
          v.deltaBpm >= 5 ? `${v.deltaBpm} bpm above baseline — worth an easier day if it persists.` : undefined,
      }),
    ),
    interpret("hrv", "HRV trend", computeHrvTrend(health.map((h) => ({ date: h.date, hrv: h.hrv }))), (v) => ({
      value: `${v.latest} ms`,
      band: v.pctVsBaseline <= -10 ? "watch" : "healthy",
      range: `your baseline ${v.baseline} ms`,
      meaning: "Your 7-day HRV versus your 30-day baseline. Lower HRV often reflects accumulated stress.",
      suggestion: v.pctVsBaseline <= -10 ? "A sustained drop suggests you're carrying fatigue." : undefined,
    })),
    interpret("hardStack", "Hard-day stacking", computeHardDayStacking(hardDates, today), (v) => ({
      value: `${v.consecutive} day${v.consecutive === 1 ? "" : "s"}`,
      band: v.consecutive >= 2 ? "watch" : "healthy",
      meaning: "Consecutive days ending today with a quality or race effort.",
      suggestion: v.consecutive >= 2 ? "Back-to-back hard days leave less room to adapt — an easy day helps." : undefined,
    })),
    interpret("easyDiscipline", "Easy-run discipline", computeEasyDiscipline(easyRuns, hrMax), (v) => ({
      value: `${v.inEasyPct}%`,
      band: v.inEasyPct >= 80 ? "healthy" : "watch",
      range: "≥80%",
      meaning: "Share of your easy runs whose heart rate actually stayed easy (zones 1–2).",
      suggestion: v.inEasyPct < 80 ? "Keeping easy runs genuinely easy builds your aerobic base faster." : undefined,
    })),
    interpret("races", "Race predictions", predictRaces(bestRun), (v) => ({
      value: `5k ${fmtDur(v.k5)} · 10k ${fmtDur(v.k10)} · HM ${fmtDur(v.half)}`,
      meaning: "A rough estimate scaled from your fastest recent run. Real races depend on training and the day.",
    })),
    interpret("splits", "Finish-faster tendency", negativeSplit(splitRuns), (v) => ({
      value: `${v.negativePct}% of runs`,
      band: v.negativePct >= 40 ? "healthy" : undefined,
      meaning: "How often your second half is faster than your first — a sign of good pacing and durability.",
    })),
  ];

  const reviews = await db
    .select()
    .from(weeklyReviews)
    .where(eq(weeklyReviews.userId, userId))
    .orderBy(desc(weeklyReviews.weekStart))
    .limit(6);

  return c.json({ consistency, weekly, efficiency, drift, timeOfDay, records, evidence, reviews, interpreted });
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

/** Full deletion of all cloud data (single-user: every row belongs to them). */
settingsRoutes.post("/delete-all", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const confirm = (await c.req.json<{ confirm?: string }>()).confirm;
  if (confirm !== "delete everything") return c.json({ error: "confirmation_required" }, 400);

  const {
    activityLaps,
    activitySourceLinks,
    activityStreamSummaries,
    calendarEventSuppressions,
    corosScheduleSnapshots,
    corosWriteAttempts,
    computedMetrics,
    deviceHandshakes,
    dismissedInsights,
    gardenDayInputs,
    gardenPlants,
    gardenSnapshots,
    gardenUnlocks,
    gardenWildlife,
    motivationEvidence,
    oauthStates,
    plannedWorkoutStages,
    providerCursorState,
    scheduleOverrides,
    sessions,
    syncErrors,
    syncRuns,
    trainingPlanVersions,
    webhookEvents,
    workoutCompletionMatches,
  } = await import("@rg/database");

  // Child tables keyed by workout/activity/job (not userId) — single-user, so
  // clearing them entirely is correct and leaves no orphans.
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
    webhookEvents,
    workoutCompletionMatches,
  ] as const;
  for (const t of childTables) await db.delete(t as any);

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
    syncErrors,
    syncRuns,
    auditEvents,
    sessions,
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
  return c.json({ ok: true });
});
