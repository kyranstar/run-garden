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
import { corosClient } from "../services/coros-connection.js";
import { addDays, todayInZone } from "@rg/domain";
import { localDateToCorosDay } from "@rg/providers";
import { waitUntilSafe } from "../services/wait-until.js";
import { processCoachReads } from "../services/coach-reads.js";
import { loadPreferences } from "../services/calendar-sync.js";

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

/** TEMPORARY field-discovery probe (race-hub design, 2026-08-14): dumps the
 * RAW dashboard + dayDetail payloads so we can see every field COROS
 * actually returns for this account — vo2max, threshold pace, and whatever
 * else the typed subset drops. Session-gated like everything else; remove
 * once the race hub's data contract is settled. */
corosRoutes.get("/probe-fields", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const client = await corosClient(db, c.env, userId, fetch);
  if (!client) return c.json({ error: "not_connected" }, 412);
  const today = todayInZone(prefs.timezone);
  const truncate = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, 2).map(truncate);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, truncate(x)]));
    }
    return v;
  };
  const grab = async (path: string, query?: Record<string, string>) => {
    try {
      return truncate(await client.rawGet(path, query));
    } catch (e) {
      return { probe_error: e instanceof Error ? e.message : String(e) };
    }
  };
  return c.json({
    dashboard: await grab("/dashboard/query"),
    dayDetail: await grab("/analyse/dayDetail/query", {
      startDay: String(localDateToCorosDay(addDays(today, -7))),
      endDay: String(localDateToCorosDay(today)),
    }),
  });
});

/** App-open pull (cloud-direct spec §3): single-flighted server-side; a 90s
 * freshness window makes racing tabs free. The UI shows "Checking COROS…"
 * until this resolves. */
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
