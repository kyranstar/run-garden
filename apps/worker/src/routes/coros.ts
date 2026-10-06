import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  connectCoros,
  corosConnectionStatus,
  disconnectCoros,
} from "../services/coros-connection.js";
import { corosReadNow } from "../services/coros-read.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { processCoachReads } from "../services/coach-reads.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { MAX_WINDOW_DAYS, probeStrengthLapKeys } from "../services/coros-lap-probe.js";
import {
  clampWindowDays,
  probeStrengthSetStats,
  STRENGTH_SET_DEFAULT_DAYS,
} from "../services/coros-strength-set-probe.js";
import {
  runSpikeCleanup,
  runUnmappedMoveSpike,
  SPIKE_CLEANUP_CONFIRM,
  SPIKE_CONFIRM,
} from "../services/coros-unmapped-spike.js";
import { fixtureModeEnabled } from "../env.js";
import { backfillWatchSets } from "../services/watch-sets.js";

/**
 * Cloud COROS connection surface (cloud-direct spec §1). The password's MD5
 * arrives pre-hashed from the browser; a live login verifies before anything
 * is stored. COROS rejections are 200s with a status the settings card can
 * speak — they're expected states, not server errors.
 */

export const corosRoutes = new Hono<AppContext>();
corosRoutes.use("*", requireUser);

const connectSchema = z.object({
  email: z.string().email().max(200),
  pwdMd5: z.string().regex(/^[0-9a-f]{32}$/),
  region: z.enum(["us", "eu", "cn"]).default("us"),
});

corosRoutes.post("/connect", async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const result = await connectCoros(db, c.env, userId, parsed.data);
  if (result.status === "connected") {
    // First pull rides the connect: activities, schedule, health, and the
    // exercise catalog appear right away instead of waiting for a sweep.
    waitUntilSafe(
      c,
      (async () => {
        const prefs = await loadPreferences(db, userId);
        await corosReadNow(db, c.env, userId, prefs, { force: true });
        await processCoachReads(db, c.env, userId, prefs, {});
      })().catch(() => undefined),
    );
  }
  return c.json(result);
});

corosRoutes.delete("/connect", async (c) => {
  await disconnectCoros(c.get("db"), c.get("userId"));
  return c.json({ ok: true });
});

corosRoutes.get("/status", async (c) => {
  return c.json(await corosConnectionStatus(c.get("db"), c.get("userId")));
});

corosRoutes.post("/read-now", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const result = await corosReadNow(db, c.env, userId, prefs);
  // Drain ambient reads on every pull, not only ingesting ones — a backlog
  // enqueued earlier otherwise waits for the hourly cron (audit finding 14);
  // an empty queue costs one SELECT.
  waitUntilSafe(c, processCoachReads(db, c.env, userId, prefs, {}).catch(() => undefined));
  return c.json(result);
});

const lapProbeQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).default(30),
});

/**
 * Masked lap probe (Task 15): the key skeleton of the most recent strength
 * activities' laps and summary — keys and types only, never a value. Read-only.
 */
corosRoutes.get("/debug/lap-keys", async (c) => {
  const parsed = lapProbeQuery.safeParse({ days: c.req.query("days") });
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const result = await probeStrengthLapKeys(db, c.env, userId, prefs, parsed.data.days);
  switch (result.status) {
    case "fixture_mode":
      return c.json({ error: "not_found" }, 404);
    case "not_connected":
      return c.json({ error: "not_connected" }, 409);
    case "coros_error":
      return c.json({ error: "coros_error", ...(result.code ? { code: result.code } : {}) }, 502);
    case "runtime_limit":
      return c.json({ error: "runtime_limit" }, 503);
    case "probe_error":
      return c.json({ error: "probe_error" }, 500);
    case "ok":
      return c.json(result.body);
  }
});

const strengthSetQuery = z.object({
  // An integer, clamped to 1..120 days (an empty or non-integer value is refused).
  days: z
    .string()
    .regex(/^-?\d{1,9}$/)
    .optional()
    .transform((s) => clampWindowDays(s === undefined ? STRENGTH_SET_DEFAULT_DAYS : Number(s))),
});

/**
 * Masked scale probe (Phase 2a+ Task 1): counts and order-of-magnitude buckets
 * of the reps, weight and intensityValue on recent strength activities' lap
 * items — never a value, id, name or date. Read-only.
 */
corosRoutes.get("/debug/strength-set-stats", async (c) => {
  const parsed = strengthSetQuery.safeParse({ days: c.req.query("days") });
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const result = await probeStrengthSetStats(db, c.env, userId, prefs, parsed.data.days);
  switch (result.status) {
    case "fixture_mode":
      return c.json({ error: "not_found" }, 404);
    case "not_connected":
      return c.json({ error: "not_connected" }, 409);
    case "coros_error":
      return c.json({ error: "coros_error", ...(result.code ? { code: result.code } : {}) }, 502);
    case "runtime_limit":
      return c.json({ error: "runtime_limit" }, 503);
    case "probe_error":
      return c.json({ error: "probe_error" }, 500);
    case "ok":
      return c.json(result.body);
  }
});

/**
 * The watch-sets backfill (Phase 2a+): one bounded batch of stored strength
 * activities gets its logged sets from COROS (read-only). Call again with
 * `?before=<next>` until `next` is null. Idempotent: a filled activity drops
 * out, so running it twice changes nothing.
 */
corosRoutes.post("/watch-sets/backfill", async (c) => {
  const before = c.req.query("before");
  if (before !== undefined && !(/^\d{4}-\d{2}-\d{2}T/.test(before) && Number.isFinite(Date.parse(before)))) {
    return c.json({ error: "invalid_cursor" }, 400);
  }
  const result = await backfillWatchSets(c.get("db"), c.env, c.get("userId"), before ? { before } : {});
  return c.json(result);
});

const spikeConfirmSchema = z
  .object({ confirm: z.union([z.literal(SPIKE_CONFIRM), z.literal(SPIKE_CLEANUP_CONFIRM)]) })
  .strict();

/**
 * Owner-gated write spike (Task 16): writes ONE stamped strength workout to
 * the real COROS account, reads it back, deletes it. Absent (404) unless the
 * body is exactly `{ "confirm": "write a test workout" }` AND COROS writes are
 * enabled for the account.
 *
 * `{ "confirm": "remove test workouts" }` (same gate) is the cleanup-only
 * call (Ruling C3): it removes spike workouts earlier runs left behind, a
 * few per call, and writes nothing. The run itself refuses (409
 * `leftovers`) while any are on COROS.
 */
corosRoutes.post("/spike/unmapped-moves", async (c) => {
  const notFound = () => c.json({ error: "not_found" }, 404);
  const confirmed = spikeConfirmSchema.safeParse(await c.req.json().catch(() => null));
  if (!confirmed.success || fixtureModeEnabled(c.env)) return notFound();
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  if (prefs.corosWritesEnabled !== true) return notFound();
  if (confirmed.data.confirm === SPIKE_CLEANUP_CONFIRM) {
    const cleanup = await runSpikeCleanup(db, c.env, userId, prefs);
    if (cleanup.status !== "done") return c.json({ error: cleanup.status }, 409);
    return c.json(cleanup.body);
  }
  const result = await runUnmappedMoveSpike(db, c.env, userId, prefs);
  switch (result.status) {
    case "not_connected":
      return c.json({ error: "not_connected" }, 409);
    case "busy":
      return c.json({ error: "busy" }, 409);
    case "catalog_incomplete":
      return c.json({ error: "catalog_incomplete", message: result.message }, 422);
    case "leftovers":
      return c.json({ error: "leftovers", count: result.count, cleanup: { confirm: SPIKE_CLEANUP_CONFIRM } }, 409);
    case "done":
      return c.json(result.body);
  }
});
