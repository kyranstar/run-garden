import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { corosWriteJobs, deviceHandshakes, desktopDevices } from "@rg/database";
import {
  corosWriteResultSchema,
  newId,
  nowInstant,
  sourceActivitySchema,
  todayInZone,
} from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireDevice, requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { applyJobResult, claimNextJob, emitPendingWork } from "../services/jobs.js";
import { DEVICE_ONLINE_WINDOW_MS } from "../services/sync-status.js";
import { importPlanSnapshot } from "../services/import-plan.js";
import { ingestActivities } from "../services/completion.js";
import { enqueueCoachReads, processCoachReads } from "../services/coach-reads.js";
import { ingestDailyHealth } from "../services/health-ingest.js";
import { advanceBackfill, recordChunk } from "../services/backfill.js";
import { advanceGarden, buildGardenView, resimulateFrom } from "../services/garden-sync.js";
import { finishSyncRun, recordSyncError, startSyncRun } from "../services/reconcile-daily.js";
import { isExerciseCatalogStale, upsertExerciseCatalog } from "../services/exercise-catalog.js";
import { bridgeJobPayload } from "../services/studio-push.js";
import { chunkIds } from "../services/db.js";
import { dailyHealth } from "@rg/database";
import { fingerprint } from "@rg/domain";

export const deviceRoutes = new Hono<AppContext>();

// ── Pairing (unauthenticated start; approval happens via Google sign-in) ─────

const handshakeSchema = z.object({
  publicKey: z.string().min(32),
  deviceName: z.string().min(1).max(80),
  platform: z.enum(["macos", "windows", "linux"]),
  appVersion: z.string().max(40),
});

deviceRoutes.post("/handshake", async (c) => {
  const body = handshakeSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const id = newId();
  await c.get("db").insert(deviceHandshakes).values({
    id,
    publicKey: body.data.publicKey,
    deviceName: body.data.deviceName,
    platform: body.data.platform,
    appVersion: body.data.appVersion,
    status: "pending",
    createdAt: nowInstant(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  return c.json({
    handshakeId: id,
    approveUrl: `${c.env.APP_URL}/api/auth/google/start?handshake=${id}`,
  });
});

deviceRoutes.get("/handshake/:id", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(deviceHandshakes)
    .where(eq(deviceHandshakes.id, c.req.param("id")))
    .limit(1);
  const hs = rows[0];
  if (!hs) return c.json({ error: "not_found" }, 404);
  if (hs.expiresAt < nowInstant() && hs.status === "pending") {
    return c.json({ status: "expired" });
  }
  if (hs.status === "approved") {
    // Claim: create the device record and hand back its id (single use).
    const deviceId = newId();
    const now = nowInstant();
    await db.insert(desktopDevices).values({
      id: deviceId,
      userId: hs.approvedUserId!,
      name: hs.deviceName,
      publicKey: hs.publicKey,
      platform: hs.platform,
      appVersion: hs.appVersion,
      createdAt: now,
      lastSeenAt: now,
    });
    await db
      .update(deviceHandshakes)
      .set({ status: "claimed", deviceId })
      .where(eq(deviceHandshakes.id, hs.id));
    return c.json({ status: "claimed", deviceId });
  }
  if (hs.status === "claimed") return c.json({ status: "claimed", deviceId: hs.deviceId });
  return c.json({ status: hs.status });
});

// ── User-facing device management ────────────────────────────────────────────

deviceRoutes.get("/", requireUser, async (c) => {
  const devices = await c
    .get("db")
    .select()
    .from(desktopDevices)
    .where(eq(desktopDevices.userId, c.get("userId")));
  return c.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      bridgeVersion: d.bridgeVersion,
      capabilities: d.capabilities,
      bridgePaused: d.bridgePaused,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      online: !d.revokedAt && Date.parse(d.lastSeenAt) > Date.now() - DEVICE_ONLINE_WINDOW_MS,
    })),
  });
});

deviceRoutes.post("/:id/revoke", requireUser, async (c) => {
  await c
    .get("db")
    .update(desktopDevices)
    .set({ revokedAt: nowInstant() })
    .where(and(eq(desktopDevices.id, c.req.param("id")!), eq(desktopDevices.userId, c.get("userId"))));
  return c.json({ ok: true });
});

deviceRoutes.post("/:id/pause", requireUser, async (c) => {
  const paused = (await c.req.json<{ paused: boolean }>()).paused;
  await c
    .get("db")
    .update(desktopDevices)
    .set({ bridgePaused: paused })
    .where(and(eq(desktopDevices.id, c.req.param("id")!), eq(desktopDevices.userId, c.get("userId"))));
  return c.json({ ok: true });
});

// ── Bridge endpoints (Ed25519-signed) ────────────────────────────────────────

const bridgeSyncSchema = z.object({
  bridgeVersion: z.string().optional(),
  capabilities: z.record(z.boolean()).optional(),
  plan: z
    .object({
      sourcePlanId: z.string(),
      name: z.string(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      pbVersion: z.string().optional(),
      sourceVersion: z.string().optional(),
    })
    .nullable()
    .optional(),
  workouts: z.array(z.any()).optional(),
  rangeStart: z.string().optional(),
  rangeEnd: z.string().optional(),
  activities: z.array(sourceActivitySchema).optional(),
  lapsByProviderId: z.record(z.array(z.any())).optional(),
  health: z.array(z.any()).optional(),
  // Counts of sportType codes the bridge saw but did not admit (e.g. bike),
  // keyed by sportType string. Optional so older bridges stay valid.
  skippedSportTypes: z.record(z.number()).optional(),
  // The COROS strength-exercise catalog (id/name pairs), sent only when the
  // bridge believes the worker's stored copy is stale (plan-studio-design §4).
  exerciseCatalog: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

deviceRoutes.post("/bridge/sync", requireDevice, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = bridgeSyncSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const body = parsed.data;
  if (body.skippedSportTypes && Object.keys(body.skippedSportTypes).length > 0) {
    // Surfaces unmapped/unadmitted COROS sportType codes for ops discovery.
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "coros: skipped sportTypes",
        userId,
        skippedSportTypes: body.skippedSportTypes,
      }),
    );
  }
  const runId = await startSyncRun(db, "coros_read", userId, c.get("deviceId"));

  try {
    if (body.capabilities || body.bridgeVersion) {
      await db
        .update(desktopDevices)
        .set({
          capabilities: body.capabilities ?? undefined,
          bridgeVersion: body.bridgeVersion ?? undefined,
        })
        .where(eq(desktopDevices.id, c.get("deviceId")));
    }

    const prefs = await loadPreferences(db, userId);
    const stats: Record<string, unknown> = {};

    if (body.plan && body.workouts && body.rangeStart && body.rangeEnd) {
      const importStats = await importPlanSnapshot(
        db,
        {
          userId,
          plan: body.plan,
          workouts: body.workouts as never,
          rangeStart: body.rangeStart,
          rangeEnd: body.rangeEnd,
          source: "bridge",
        },
        prefs,
      );
      stats.import = importStats;
      await syncCalendar(db, c.env, userId).catch(async (e) => {
        await recordSyncError(db, {
          syncRunId: runId,
          userId,
          provider: "google_calendar",
          operation: "sync",
          category: "calendar_sync_failed",
          message: e instanceof Error ? e.message : "unknown",
        });
      });
      stats.emittedJobs = await emitPendingWork(db, userId, {
        corosWritesEnabled: prefs.corosWritesEnabled,
      });
    }

    if (body.activities && body.activities.length > 0) {
      const ingest = await ingestActivities(db, {
        userId,
        sources: body.activities,
        lapsByProviderId: body.lapsByProviderId as never,
      });
      stats.ingest = ingest;
      const earliest = ingest.affectedDates[0];
      if (earliest) await resimulateFrom(db, userId, earliest, prefs);
      // Ambient coach reads (rework spec §1): enqueue is a cheap idempotent
      // DB write; the LLM work rides waitUntil so sync latency never pays for
      // it, and the hourly sweep catches anything a dropped waitUntil misses.
      try {
        await enqueueCoachReads(db, userId, todayInZone(prefs.timezone));
        c.executionCtx?.waitUntil?.(
          processCoachReads(db, c.env, userId, prefs, {}).catch(() => undefined),
        );
      } catch {
        // Never fail an ingest over the perception layer.
      }
    }

    if (body.health && body.health.length > 0) {
      stats.health = await ingestDailyHealth(
        db,
        userId,
        body.health as Array<Record<string, unknown>>,
      );
    }

    if (body.exerciseCatalog && body.exerciseCatalog.length > 0) {
      const catalog = await upsertExerciseCatalog(db, body.exerciseCatalog);
      stats.exerciseCatalog = catalog;
    }

    await advanceGarden(db, userId, await loadPreferences(db, userId));
    await finishSyncRun(db, runId, "ok", stats);
    const catalogStale = await isExerciseCatalogStale(db);
    return c.json({ ok: true, stats, catalogStale });
  } catch (e) {
    await recordSyncError(db, {
      syncRunId: runId,
      userId,
      provider: "coros",
      operation: "bridge_sync",
      category: "bridge_sync_failed",
      message: e instanceof Error ? e.message : "unknown",
    });
    await finishSyncRun(db, runId, "error");
    return c.json({ error: "sync_failed" }, 500);
  }
});

/**
 * Deep-backfill chunk.
 *
 * ACTIVITIES ONLY — this endpoint must never call importPlanSnapshot. An old
 * range contains none of today's workouts, and import-plan rules 8/9 would read
 * that absence as "removed upstream" and archive the live plan.
 */
const backfillChunkSchema = z.object({
  chunkStart: z.string(),
  chunkEnd: z.string(),
  activities: z.array(sourceActivitySchema).default([]),
  lapsByProviderId: z.record(z.array(z.any())).default({}),
  skippedSportTypes: z.record(z.number()).default({}),
});

deviceRoutes.post("/bridge/backfill-chunk", requireDevice, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = backfillChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_chunk" }, 400);
  const body = parsed.data;

  const runId = await startSyncRun(db, "coros_backfill", userId, c.get("deviceId"));
  try {
    await recordChunk(db, userId, {
      chunkStart: body.chunkStart,
      chunkEnd: body.chunkEnd,
      activities: body.activities,
      lapsByProviderId: body.lapsByProviderId as never,
      skippedSportTypes: body.skippedSportTypes,
    });
    const today = todayInZone((await loadPreferences(db, userId)).timezone);
    await advanceBackfill(db, userId, "", { activitiesFound: body.activities.length }, today);
    await finishSyncRun(db, runId, "ok");
    return c.json({ ok: true, ingested: body.activities.length });
  } catch (e) {
    await recordSyncError(db, {
      syncRunId: runId,
      userId,
      provider: "coros",
      operation: "backfill_chunk",
      category: "backfill_chunk_failed",
      message: e instanceof Error ? e.message : "unknown",
    });
    await finishSyncRun(db, runId, "error");
    return c.json({ error: "backfill_chunk_failed" }, 500);
  }
});

deviceRoutes.post("/bridge/jobs/claim", requireDevice, async (c) => {
  const db = c.get("db");
  const device = (
    await db.select().from(desktopDevices).where(eq(desktopDevices.id, c.get("deviceId"))).limit(1)
  )[0];
  if (device?.bridgePaused) return c.json({ job: null, paused: true });
  const job = await claimNextJob(db, c.get("userId"), c.get("deviceId"));
  const remaining = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, c.get("userId")), eq(corosWriteJobs.status, "queued")));
  const pendingCount = remaining.length;
  if (!job) return c.json({ job: null, pendingCount });
  const studio = bridgeJobPayload(job);
  return c.json({
    pendingCount,
    job: {
      id: job.id,
      kind: job.kind,
      originalDate: job.originalDate,
      destinationDate: job.destinationDate,
      expectedContentFingerprint: job.expectedContentFingerprint,
      expectedSourceVersion: job.expectedSourceVersion,
      attemptCount: job.attemptCount,
      workout: job.workout
        ? {
            id: job.workout.id,
            // The COROS plan id (sourceWorkoutId is `${corosPlanId}:${idInPlan}`)
            // — NOT the internal plan row uuid, which means nothing on the wire.
            // The executor scopes merged multi-plan schedule reads with this.
            sourcePlanId: job.workout.sourceWorkoutId.split(":")[0],
            sourceWorkoutId: job.workout.sourceWorkoutId,
            sourceIdInPlan: job.workout.sourceIdInPlan,
            sourceProgramId: job.workout.sourceProgramId,
            title: job.workout.title,
          }
        : null,
      // Studio kinds only, and only the fields the bridge needs: a changed
      // session's follow-up create stays server-side, because whether it
      // happens is the worker's decision, not the device's.
      ...(studio ? { studio } : {}),
    },
  });
});

deviceRoutes.post("/bridge/jobs/:id/result", requireDevice, async (c) => {
  const db = c.get("db");
  const parsed = corosWriteResultSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  if (parsed.data.jobId !== c.req.param("id") || parsed.data.deviceId !== c.get("deviceId")) {
    return c.json({ error: "mismatched_ids" }, 400);
  }
  const prefs = await loadPreferences(db, c.get("userId"));
  const result = await applyJobResult(db, c.get("userId"), parsed.data, prefs);
  // Reconcile the Calendar if COROS produced a materially different result.
  await syncCalendar(db, c.env, c.get("userId")).catch(() => undefined);
  return c.json({ ok: true, ...result });
});

// Ambient garden: the same renderable garden the website shows, read over the
// device's signed channel so the desktop's screensaver window can display it
// without a browser session. Read-only — advances the sim and returns it.
deviceRoutes.post("/bridge/garden", requireDevice, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const view = await buildGardenView(db, userId, prefs);
  return c.json(view);
});
