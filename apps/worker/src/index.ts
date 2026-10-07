import { Hono, type MiddlewareHandler } from "hono";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  gardenEvents,
  plannedWorkouts,
  syncRuns,
  users,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";
import { computeWeeklyFacts, DISCIPLINES } from "@rg/analytics";
import type { Env } from "./env.js";
import { fixtureModeEnabled, stagingEnabled } from "./env.js";
import { installStagingGuard } from "./services/staging.js";
import { withDb, requireUser, type AppContext } from "./auth/middleware.js";
import { authRoutes } from "./routes/auth.js";
import { planRoutes } from "./routes/plan.js";
import { gardenRoutes } from "./routes/garden.js";
import { activityRoutes, calendarRoutes, insightRoutes, settingsRoutes } from "./routes/misc.js";
import { studioRoutes } from "./routes/studio.js";
import { coachRoutes, sweepUserProposals } from "./routes/coach.js";
import { corosRoutes } from "./routes/coros.js";
import { syncRoutes } from "./routes/sync.js";
import { adminRoutes } from "./routes/admin.js";
import { programRoutes } from "./routes/programs.js";
import { conditionRoutes, sessionRoutes } from "./routes/sessions.js";
import { libraryRoutes } from "./routes/library.js";
import { makeDb, chunkIds, type Db } from "./services/db.js";
import { loadPreferences, syncCalendar } from "./services/calendar-sync.js";
import { advanceGarden } from "./services/garden-sync.js";
import { runBackfillChunkCloud, sweepStaleBackfills } from "./services/backfill.js";
import { closeStrandedSyncRuns, sweepStaleSuppressions, reconcileCompletionStates, startSyncRun, finishSyncRun } from "./services/reconcile-daily.js";
import { generateWeeklyReview } from "./services/llm.js";
import { healLegacySyncState } from "./services/heal-legacy-sync.js";
import { evaluateTriggers } from "./services/coach-triggers.js";
import { processCoachReads } from "./services/coach-reads.js";
import { corosReadSweep } from "./services/coros-read.js";
import { corosMcpSleepSweep } from "./services/coros-mcp.js";
import { executeCloudJobs } from "./services/coros-write-cloud.js";
import { purgeExpiredSessions, createSession, sessionCookie } from "./auth/sessions.js";
import { purgeExpiredStates } from "./auth/google.js";
import { ensureFixtureUser, seedFixtures } from "./services/fixtures.js";
import { accountsRestoring, restoreInProgress } from "./services/account-state.js";
import { placeSlotsForAllPrograms } from "./services/program-slots.js";

const app = new Hono<AppContext>();

app.use("*", withDb);

/**
 * Same-origin app; a light CSRF guard for mutating API calls from browsers.
 * A PRESENT Origin must equal APP_URL's origin exactly — the old
 * `APP_URL.startsWith(origin)` was direction-inverted (any prefix such as
 * "https://run" passed), and the x-device-id bypass was dead code from the
 * deleted desktop bridge. A missing Origin still passes: same-origin GETs
 * and non-browser clients omit the header.
 */
export const originGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.env.APP_URL).origin) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  await next();
};

app.use("/api/*", originGuard);

app.route("/api/auth", authRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/garden", gardenRoutes);
app.route("/api/coach", coachRoutes);
app.route("/api/coros", corosRoutes);
app.route("/api/calendar", calendarRoutes);
app.route("/api/activities", activityRoutes);
app.route("/api/insights", insightRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/studio", studioRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api/programs", programRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/conditions", conditionRoutes);
app.route("/api/library", libraryRoutes);
// The parity harness: 404 unless staging or PARITY_ENABLED, then requireUser.
// Its DTO hash calls this same app in-process, as the caller.
app.route("/api/admin", adminRoutes((req, env, ctx) => app.fetch(req, env, ctx)));

app.get("/api/health", (c) => c.json({ ok: true, fixtureMode: fixtureModeEnabled(c.env), staging: stagingEnabled(c.env) }));

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

/**
 * Every account a cron may work on: all of them except one a restore is
 * replacing (ruling B2) — the file is still arriving into a half-wiped
 * account, and anything written now would win over it. Each writer checks the
 * marker again itself; skipping here just keeps the loop from trying.
 */
async function allUserIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users);
  const restoring = await accountsRestoring(db);
  return rows.map((r) => r.id).filter((id) => !restoring.has(id));
}

export async function halfHourly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    const runId = await startSyncRun(db, "calendar_sync", userId);
    try {
      const stats = await syncCalendar(db, env, userId);
      await finishSyncRun(db, runId, "ok", stats as unknown as Record<string, unknown>);
    } catch (e) {
      // Record WHY — 187 consecutive bare errors made the dead Google token
      // undiagnosable from the runs table alone.
      await finishSyncRun(db, runId, "error", { message: String(e).slice(0, 200) });
    }
  }
  // Cloud-direct COROS pull (spec §3): replaces bridge snapshots for
  // connected users; the bridge's own payloads stay accepted (idempotent
  // ingest) during the transition.
  await corosReadSweep(db, env).catch((e: unknown) =>
    console.error(`coros read sweep failed: ${e instanceof Error ? e.message : "unknown"}`),
  );
  // Official-MCP sleep pull (sleep/recovery phase 2) — throttled per user
  // inside; wake-date-keyed data needs at most one pull a night.
  await corosMcpSleepSweep(db, env, async (userId) => (await loadPreferences(db, userId)).timezone).catch(
    (e: unknown) => console.error(`coros mcp sleep sweep failed: ${e instanceof Error ? e.message : "unknown"}`),
  );
  // Cloud backfill: one 90-day chunk per tick per user with an active walk.
  for (const userId of await allUserIds(db)) {
    const prefs = await loadPreferences(db, userId);
    await runBackfillChunkCloud(db, env, userId, prefs).catch(() => undefined);
  }
  // A backfill with no progress for 12h stops saying "queued"/"running" and
  // says so. Before the purges so an earlier throw can't skip it; a broken
  // sweep must be visible, not swallowed.
  await sweepStaleBackfills(db, new Date()).catch((e: unknown) =>
    console.error(`backfill sweep failed: ${e instanceof Error ? e.message : "unknown"}`),
  );
  await purgeExpiredSessions(db);
  await purgeExpiredStates(db);
}

/** Thrown between steps of a per-user cron loop when a restore began for
 * that account while the loop was working on it (ruling B9). */
class RestoreBegan extends Error {}

/** A run row written into an account a restore began replacing is not the
 * restored account's history (m7): the loop removes its own row. */
async function dropSyncRun(db: Db, runId: string): Promise<void> {
  await db.delete(syncRuns).where(eq(syncRuns.id, runId));
}

export async function hourly(db: Db, env: Env): Promise<void> {
  await closeStrandedSyncRuns(db).catch(() => undefined);
  await sweepStaleSuppressions(db).catch(() => undefined);
  // Adaptive programs keep their weeks filled as the days roll on (Phase 2a). FIRST of the per-user work, and
  // cheap: an invocation that dies later on a CPU or subrequest ceiling (the garden, the coach, the COROS
  // writes) has still placed the week (audit 2a-model M8). Its own pass over every program; it skips a
  // restoring account itself, its failure is caught here so every step after it still runs, and the
  // half-hourly calendar sync books what it places.
  await placeSlotsForAllPrograms(db).catch((e: unknown) =>
    console.error(`slot placement failed: ${e instanceof Error ? e.message : "unknown"}`),
  );
  for (const userId of await allUserIds(db)) {
    // The loop was handed this account before any step ran, and a step (the
    // garden's, a coach read) can take seconds: a restore that began since
    // must stop every step still to come, not only the ones that check the
    // marker themselves — and leave no run row in the account it restores.
    if (await restoreInProgress(db, userId)) continue;
    const runId = await startSyncRun(db, "reconcile", userId);
    const stillOurs = async (): Promise<void> => {
      if (await restoreInProgress(db, userId)) throw new RestoreBegan();
    };
    try {
      const prefs = await loadPreferences(db, userId);
      await stillOurs();
      const rec = await reconcileCompletionStates(db, userId, prefs);
      await stillOurs();
      const garden = await advanceGarden(db, userId, prefs);
      await stillOurs();
      await healLegacySyncState(db, userId);
      await stillOurs();
      // Coach trigger marks are cheap SQL — a fired row waits for the next
      // wake; nothing here thinks (spec §1).
      await evaluateTriggers(db, userId, prefs, todayInZone(prefs.timezone)).catch(() => []);
      await stillOurs();
      await sweepUserProposals(db, userId, prefs.timezone).catch(() => undefined);
      await stillOurs();
      // Perception catch-up: drains reads a dropped waitUntil missed. Cap 2
      // per tick keeps the per-user loop bounded (rework spec §1).
      await processCoachReads(db, env, userId, prefs, {}).catch(() => undefined);
      await stillOurs();
      // Cloud-direct writes (spec §4): queued watch updates execute here
      // when a cloud connection exists — the Mac is no longer in the loop.
      await executeCloudJobs(db, env, userId, prefs).catch(() => undefined);
      await finishSyncRun(db, runId, "ok", { ...rec, ...garden });
    } catch (e) {
      if (e instanceof RestoreBegan) await dropSyncRun(db, runId);
      else await finishSyncRun(db, runId, "error");
    }
  }
}

export async function weekly(db: Db, env: Env): Promise<void> {
  for (const userId of await allUserIds(db)) {
    if (await restoreInProgress(db, userId)) continue;
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

      // A restore that began while this week's facts were gathered wins
      // (B9); generateWeeklyReview checks again before it writes.
      if (await restoreInProgress(db, userId)) {
        await dropSyncRun(db, runId);
        continue;
      }
      const result = await generateWeeklyReview(
        db,
        env,
        userId,
        { weekStart, facts: facts as unknown as Record<string, unknown>, units: prefs.units },
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
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (stagingEnabled(env)) installStagingGuard();
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (stagingEnabled(env)) return;
    const db = makeDb(env.DB);
    switch (event.cron) {
      case "*/30 * * * *":
        ctx.waitUntil(halfHourly(db, env));
        break;
      case "15 * * * *":
        ctx.waitUntil(hourly(db, env));
        break;
      case "0 20 * * MON":
        ctx.waitUntil(weekly(db, env));
        break;
      default:
        ctx.waitUntil(hourly(db, env));
    }
  },
};
