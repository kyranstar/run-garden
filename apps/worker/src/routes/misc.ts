import { Hono } from "hono";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
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
  computeAerobicEfficiency,
  computeConsistency,
  computeHrDrift,
  computeRecords,
  computeTimeOfDay,
  computeWeeklyTraining,
  pickEvidenceCard,
} from "@rg/analytics";
import { SIMULATION_VERSION } from "@rg/garden-engine";
import { NORMALIZER_VERSION } from "@rg/providers";
import { ESTIMATOR_VERSION } from "@rg/scheduling";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { googleCalendarClient } from "../services/google-calendar.js";
import { loadPreferences, savePreferences, syncCalendar } from "../services/calendar-sync.js";
import { llmBudgetStatus, LLM_BUDGET } from "../services/llm.js";

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

  let chosen = calendarId;
  if (createNew) {
    const created = await client.createCalendar(DEFAULT_CALENDAR_NAME, prefs.timezone);
    chosen = created.id;
  }
  if (!chosen) return c.json({ error: "no_calendar" }, 400);
  await savePreferences(db, userId, { ...prefs, calendarId: chosen });
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
  const rows = await c
    .get("db")
    .select()
    .from(activities)
    .where(eq(activities.userId, c.get("userId")))
    .orderBy(desc(activities.startTime))
    .limit(Number(c.req.query("limit") ?? 30));
  return c.json({ activities: rows });
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

  const reviews = await db
    .select()
    .from(weeklyReviews)
    .where(eq(weeklyReviews.userId, userId))
    .orderBy(desc(weeklyReviews.weekStart))
    .limit(6);

  return c.json({ consistency, weekly, efficiency, drift, timeOfDay, records, evidence, reviews });
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

/** Full deletion of all cloud data. */
settingsRoutes.post("/delete-all", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const confirm = (await c.req.json<{ confirm?: string }>()).confirm;
  if (confirm !== "delete everything") return c.json({ error: "confirmation_required" }, 400);
  const tables = [
    plannedWorkouts,
    activities,
    dailyHealth,
    sleepRecords,
    gardenEvents,
    gardenState,
    weeklyReviews,
    llmUsage,
    corosWriteJobs,
    desktopDevices,
    providerConnections,
    userPreferences,
    trainingPlans,
    calendarEventLinks,
    auditEvents,
  ] as const;
  for (const t of tables) {
    await db.delete(t).where(eq((t as typeof plannedWorkouts).userId, userId));
  }
  await db.delete(users).where(eq(users.id, userId));
  return c.json({ ok: true });
});
