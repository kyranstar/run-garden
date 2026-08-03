import { Hono } from "hono";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import {
  activities,
  gardenEvents,
  plannedWorkouts,
  users,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";
import { computeWeeklyFacts } from "@rg/analytics";
import type { Env } from "./env.js";
import { fixtureModeEnabled } from "./env.js";
import { withDb, requireUser, type AppContext } from "./auth/middleware.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { planRoutes } from "./routes/plan.js";
import { gardenRoutes } from "./routes/garden.js";
import { stravaRoutes } from "./routes/strava.js";
import { activityRoutes, calendarRoutes, insightRoutes, settingsRoutes } from "./routes/misc.js";
import { studioRoutes } from "./routes/studio.js";
import { syncRoutes } from "./routes/sync.js";
import { makeDb, type Db } from "./services/db.js";
import { loadPreferences, syncCalendar } from "./services/calendar-sync.js";
import { advanceGarden } from "./services/garden-sync.js";
import { reconcileCompletionStates, startSyncRun, finishSyncRun } from "./services/reconcile-daily.js";
import { generateWeeklyReview } from "./services/llm.js";
import { healLegacySyncState } from "./services/heal-legacy-sync.js";
import { purgeExpiredSessions, createSession, sessionCookie } from "./auth/sessions.js";
import { purgeExpiredStates } from "./auth/google.js";
import { ensureFixtureUser, seedFixtures } from "./services/fixtures.js";

const app = new Hono<AppContext>();

app.use("*", withDb);

// Same-origin app; a light CSRF guard for mutating API calls from browsers.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const isDevice = c.req.header("x-device-id");
    const isWebhook = c.req.path.startsWith("/api/strava/webhook");
    if (!isDevice && !isWebhook && origin && !c.env.APP_URL.startsWith(origin)) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  await next();
});

app.route("/api/auth", authRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/garden", gardenRoutes);
app.route("/api/strava", stravaRoutes);
app.route("/api/calendar", calendarRoutes);
app.route("/api/activities", activityRoutes);
app.route("/api/insights", insightRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/studio", studioRoutes);
app.route("/api/sync", syncRoutes);

app.get("/api/health", (c) => c.json({ ok: true, fixtureMode: fixtureModeEnabled(c.env) }));

// ── Fixture mode (explicit, never silent) ────────────────────────────────────

app.post("/api/dev/fixture-login", async (c) => {
  if (!fixtureModeEnabled(c.env)) return c.json({ error: "not_in_fixture_mode" }, 403);
  const db = c.get("db");
  const userId = await ensureFixtureUser(db, c.env.ALLOWED_GOOGLE_EMAIL || "fixture@example.com");
  const token = await createSession(db, userId, "fixture");
  c.header("Set-Cookie", sessionCookie(token, c.env.APP_URL.startsWith("https")));
  return c.json({ ok: true, userId });
});

app.post("/api/dev/seed", requireUser, async (c) => {
  if (!fixtureModeEnabled(c.env)) return c.json({ error: "not_in_fixture_mode" }, 403);
  const result = await seedFixtures(c.get("db"), c.env, c.get("userId"));
  return c.json(result);
});

// Static assets (the built web app) are served by the assets binding for all
// non-/api routes via wrangler's run_worker_first configuration.
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

// ── Cron ─────────────────────────────────────────────────────────────────────

async function allUserIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.map((r) => r.id);
}

async function halfHourly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    const runId = await startSyncRun(db, "calendar_sync", userId);
    try {
      const stats = await syncCalendar(db, env, userId);
      await finishSyncRun(db, runId, "ok", stats as unknown as Record<string, unknown>);
    } catch {
      await finishSyncRun(db, runId, "error");
    }
  }
  await purgeExpiredSessions(db);
  await purgeExpiredStates(db);
}

async function hourly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    const runId = await startSyncRun(db, "reconcile", userId);
    try {
      const prefs = await loadPreferences(db, userId);
      const rec = await reconcileCompletionStates(db, userId, prefs);
      const garden = await advanceGarden(db, userId, prefs);
      await healLegacySyncState(db, userId);
      await finishSyncRun(db, runId, "ok", { ...rec, ...garden });
    } catch {
      await finishSyncRun(db, runId, "error");
    }
  }
}

async function weekly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    const runId = await startSyncRun(db, "weekly_review", userId);
    try {
      const prefs = await loadPreferences(db, userId);
      const today = todayInZone(prefs.timezone);
      const weekStart = addDays(startOfIsoWeek(today), -7);
      const weekEnd = addDays(weekStart, 6);

      const workouts = await db
        .select()
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            gte(plannedWorkouts.effectiveDate, weekStart),
            lte(plannedWorkouts.effectiveDate, weekEnd),
            isNull(plannedWorkouts.archivedAt),
          ),
        );
      const matches = await db
        .select()
        .from(workoutCompletionMatches)
        .where(isNull(workoutCompletionMatches.undoneAt));
      const matchedIds = new Set(
        matches.filter((m) => workouts.some((w) => w.id === m.workoutId)).map((m) => m.activityId),
      );
      const acts = (
        await db.select().from(activities).where(eq(activities.userId, userId))
      ).filter((a) => matchedIds.has(a.id));
      const events = await db
        .select()
        .from(gardenEvents)
        .where(
          and(
            eq(gardenEvents.userId, userId),
            gte(gardenEvents.date, weekStart),
            lte(gardenEvents.date, weekEnd),
          ),
        );

      // COROS/derived aggregates only — no Strava-specific fields reach the LLM.
      const facts = computeWeeklyFacts({
        range: { start: weekStart, end: weekEnd },
        workouts: workouts.map((w) => ({ ...w, sourceProvider: "coros", stages: [] })) as never,
        activities: acts.map((a) => ({
          ...a,
          title: undefined,
          summaryPolyline: undefined,
          stravaActivityId: undefined,
        })) as never,
        garden: {
          plantsAdded: events.filter((e) => e.kind === "plant_added").length,
          wildlife: events.filter((e) => e.kind === "wildlife_arrived").length,
        },
      });

      const result = await generateWeeklyReview(
        db,
        env,
        userId,
        { weekStart, facts: facts as unknown as Record<string, unknown> },
        prefs.aiEnabled && env.AI_DEFAULT_ENABLED !== "0",
      );
      await finishSyncRun(db, runId, "ok", { narrative: !!result.narrative, reason: result.reason });
    } catch {
      await finishSyncRun(db, runId, "error");
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = makeDb(env.DB);
    switch (event.cron) {
      case "*/30 * * * *":
        ctx.waitUntil(halfHourly(db, env));
        break;
      case "15 * * * *":
        ctx.waitUntil(hourly(db, env));
        break;
      case "0 14 * * 1":
        ctx.waitUntil(weekly(db, env));
        break;
      default:
        ctx.waitUntil(hourly(db, env));
    }
  },
};
