import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { gardenSeen, gardenState } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { buildGardenTimeline, buildGardenView, recentGardenEvents } from "../services/garden-sync.js";
import { loadPreferences, savePreferences } from "../services/calendar-sync.js";

export const gardenRoutes = new Hono<AppContext>();
gardenRoutes.use("*", requireUser);

gardenRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const view = await buildGardenView(db, userId, prefs);
  const stored = await recentGardenEvents(db, userId, 40);
  // Today's previewed events lead the feed (they aren't in the DB yet); the
  // durable sim writes identical rows tomorrow, so ids collide cleanly.
  const events = [
    ...view.previewEvents.map((e) => ({ ...e, id: `${userId}:${e.id}`, preview: true })).reverse(),
    ...stored,
  ];

  return c.json({
    ...view,
    events,
    restMode: {
      active: prefs.gardenRestMode,
      until: prefs.gardenRestModeUntil,
    },
  });
});

/**
 * The day-slider scrubber: replays every durably simulated day so the UI can
 * drag through the garden's history client-side after one fetch. Read-only —
 * see `buildGardenTimeline` — so it's safe to call as often as the UI likes.
 */
gardenRoutes.get("/timeline", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const days = await buildGardenTimeline(db, userId);
  return c.json({ days });
});

/**
 * Arrival watermark (spec §3, 2026-08-05 reward-loop design): the client
 * marks the newest durable event it has presented, plus any same-day
 * (preview) unlocks it has already celebrated, so ceremonies fire exactly
 * once — across refreshes, devices, and days.
 */
gardenRoutes.post("/seen", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const body = await c.req
    .json<{ lastSeenDate?: unknown; lastSeenSeq?: unknown; celebratedSpeciesIds?: unknown }>()
    .catch(() => null);
  const ids = body?.celebratedSpeciesIds;
  if (
    !body ||
    typeof body.lastSeenDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.lastSeenDate) ||
    typeof body.lastSeenSeq !== "number" ||
    !Number.isInteger(body.lastSeenSeq) ||
    !Array.isArray(ids) ||
    // celebratedSpeciesIds is a permanent ledger (C13 round 2: backfilled
    // admissions are never pruned), bounded by the codex — 57 species + 4
    // ground kinds (`ground:<kind>` prefix) as of this writing. 256 gives
    // generous headroom as the codex grows without ever being a realistic
    // cap on legitimate data.
    ids.length > 256 ||
    ids.some((s) => typeof s !== "string")
  ) {
    return c.json({ error: "bad_request" }, 400);
  }
  const value = {
    lastSeenDate: body.lastSeenDate,
    lastSeenSeq: body.lastSeenSeq,
    celebratedSpeciesIds: ids as string[],
    updatedAt: nowInstant(),
  };
  await db
    .insert(gardenSeen)
    .values({ userId, ...value })
    .onConflictDoUpdate({ target: gardenSeen.userId, set: value });
  return c.json({ ok: true });
});

gardenRoutes.post("/rest-mode", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { active, until } = await c.req.json<{ active: boolean; until?: string | null }>();
  const prefs = await loadPreferences(db, userId);
  await savePreferences(db, userId, {
    ...prefs,
    gardenRestMode: active,
    gardenRestModeUntil: active ? (until ?? null) : null,
  });
  return c.json({ ok: true, active, until: active ? (until ?? null) : null, updatedAt: nowInstant() });
});

/** Numeric internals — diagnostics only, never primary UI. */
gardenRoutes.get("/diagnostics", async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(gardenState)
    .where(eq(gardenState.userId, c.get("userId")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "no_garden" }, 404);
  const snapshot = rows[0].snapshot as unknown as GardenSnapshot;
  return c.json({
    simulationVersion: rows[0].simulationVersion,
    lastSimulatedDate: rows[0].lastSimulatedDate,
    state: snapshot.state,
    plantCount: snapshot.plants.length,
    livingPlants: snapshot.plants.filter((p) => p.state !== "dead").length,
    wildlife: snapshot.wildlife,
  });
});
