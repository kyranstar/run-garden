import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { gardenState } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { buildGardenView, recentGardenEvents } from "../services/garden-sync.js";
import { loadPreferences, savePreferences } from "../services/calendar-sync.js";

export const gardenRoutes = new Hono<AppContext>();
gardenRoutes.use("*", requireUser);

gardenRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const view = await buildGardenView(db, userId, prefs);
  const events = await recentGardenEvents(db, userId, 40);

  return c.json({
    ...view,
    events,
    restMode: {
      active: prefs.gardenRestMode,
      until: prefs.gardenRestModeUntil,
    },
  });
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
