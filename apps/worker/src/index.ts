import { Hono } from "hono";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  gardenEvents,
  plannedWorkouts,
  users,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";
import { computeWeeklyFacts, DISCIPLINES } from "@rg/analytics";
import type { Env } from "./env.js";
import { fixtureModeEnabled } from "./env.js";
import { withDb, requireUser, type AppContext } from "./auth/middleware.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { planRoutes } from "./routes/plan.js";
import { gardenRoutes } from "./routes/garden.js";
import { activityRoutes, calendarRoutes, insightRoutes, settingsRoutes } from "./routes/misc.js";
import { studioRoutes } from "./routes/studio.js";
import { coachRoutes, sweepUserProposals } from "./routes/coach.js";
import { syncRoutes } from "./routes/sync.js";
import { makeDb, chunkIds, type Db } from "./services/db.js";
import { loadPreferences, syncCalendar } from "./services/calendar-sync.js";
import { advanceGarden } from "./services/garden-sync.js";
import { sweepStaleBackfills } from "./services/backfill.js";
import { reconcileCompletionStates, startSyncRun, finishSyncRun } from "./services/reconcile-daily.js";
import { generateWeeklyReview } from "./services/llm.js";
import { healLegacySyncState } from "./services/heal-legacy-sync.js";
import { evaluateTriggers } from "./services/coach-triggers.js";
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
    if (!isDevice && origin && !c.env.APP_URL.startsWith(origin)) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  await next();
});

app.route("/api/auth", authRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/garden", gardenRoutes);
app.route("/api/coach", coachRoutes);
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
  // A backfill nobody claimed for 12h stops saying "queued" and says so.
  await sweepStaleBackfills(db, new Date()).catch(() => undefined);
}

async function hourly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    const runId = await startSyncRun(db, "reconcile", userId);
    try {
      const prefs = await loadPreferences(db, userId);
      const rec = await reconcileCompletionStates(db, userId, prefs);
      const garden = await advanceGarden(db, userId, prefs);
      await healLegacySyncState(db, userId);
      // Coach trigger marks are cheap SQL — a fired row waits for the next
      // wake; nothing here thinks (spec §1).
      await evaluateTriggers(db, userId, prefs, todayInZone(prefs.timezone)).catch(() => []);
      await sweepUserProposals(db, userId, prefs.timezone).catch(() => undefined);
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
      // Scoped by this week's workout ids (chunked: an `inArray` binds one
      // variable per id and D1 caps a statement at ~100) rather than a full
      // unscoped scan of every match ever made for every user — the same
      // pattern the insights route uses. computeWeeklyFacts's adherence,
      // completed, and moved counts all flow from `workouts` itself, so this
      // is surfaced only in the sync-run stats below, not fed into facts.
      const matchChunks = await Promise.all(
        chunkIds(workouts.map((w) => w.id)).map((ids) =>
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
      );
      const matches = matchChunks.flat();
      // Every run in the week counts toward the review — not just the ones
      // the matcher happened to link to a planned workout. Filtering to
      // matched-only activities silently dropped unplanned/bonus runs from
      // the weekly totals, which is exactly the kind of undercount a runner
      // would notice and stop trusting.
      const localDate = (a: { startTimeLocal: string | null; startTime: string }): string =>
        (a.startTimeLocal ?? a.startTime).slice(0, 10);
      // All three disciplines, not runs only: a week with two lifts and a
      // yoga session and no runs is a real training week, and a review that
      // called it empty would be wrong.
      const acts = (
        await db.select().from(activities).where(eq(activities.userId, userId))
      ).filter(
        (a) =>
          DISCIPLINES.includes(a.sport as (typeof DISCIPLINES)[number]) &&
          localDate(a) >= weekStart &&
          localDate(a) <= weekEnd,
      );
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

      const facts = computeWeeklyFacts({
        range: { start: weekStart, end: weekEnd },
        workouts: workouts.map((w) => ({ ...w, sourceProvider: "coros", stages: [] })) as never,
        activities: acts as never,
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
      await finishSyncRun(db, runId, "ok", {
        narrative: !!result.narrative,
        reason: result.reason,
        activityCount: acts.length,
        matchedActivityCount: matches.length,
      });
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
      case "0 20 * * 1":
        ctx.waitUntil(weekly(db, env));
        break;
      default:
        ctx.waitUntil(hourly(db, env));
    }
  },
};
