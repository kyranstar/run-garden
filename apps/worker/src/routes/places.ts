/**
 * `/api/places` — where sessions happen and the gear there (Phase 2 spec §2c "Settings sections";
 * services/places.ts).
 *
 *   GET     /      {places, equipment: [{id, label, weighted}]} — the default place first; the gear vocabulary with
 *                  its labels, and which gear takes weights (the UI holds no gear words of its own)
 *   POST    /      {name, equipment, implements?, isDefault?: true} → 201 {place}
 *   PATCH   /:id   {name?, equipment?, implements? (replaced whole), isDefault?: true} → {place}
 *   DELETE  /:id   → {ok}; the default's place passes to the oldest other
 *
 * 422 `invalid_place` (gear outside the vocabulary, a list that is not weights, a list for gear that takes none);
 * 404 for a place that is not this account's; 409 `place_in_use` naming the active program that builds there; 423
 * while a restore is replacing the account.
 */
import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { nowInstant } from "@rg/domain";
import { EQUIPMENT, EQUIPMENT_IDS, LOAD_IMPLEMENTS } from "@rg/exercise-library";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  createPlace,
  deletePlace,
  listPlaces,
  PlaceInUseError,
  PlaceNotFoundError,
  updatePlace,
} from "../services/places.js";
import { RestoreInProgressError } from "../services/programs.js";

export const placeRoutes = new Hono<AppContext>();
placeRoutes.use("*", requireUser);

const WEIGHTED: ReadonlySet<string> = new Set(LOAD_IMPLEMENTS);
const VOCABULARY = EQUIPMENT_IDS.map((id) => ({ id, label: EQUIPMENT[id], weighted: WEIGHTED.has(id) }));

function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof ZodError) return c.json({ error: "invalid_place", issues: e.issues }, 422);
  if (e instanceof PlaceNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof PlaceInUseError) return c.json({ error: "place_in_use", program: e.program }, 409);
  if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
  throw e;
}

async function placeOf(c: Context<AppContext>, id: string) {
  return (await listPlaces(c.get("db"), c.get("userId"))).find((p) => p.id === id)!;
}

placeRoutes.get("/", async (c) => c.json({ places: await listPlaces(c.get("db"), c.get("userId")), equipment: VOCABULARY }));

placeRoutes.post("/", async (c) => {
  try {
    const id = await createPlace(c.get("db"), c.get("userId"), await c.req.json().catch(() => null), nowInstant());
    return c.json({ place: await placeOf(c, id) }, 201);
  } catch (e) {
    return refusal(c, e);
  }
});

placeRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await updatePlace(c.get("db"), c.get("userId"), id, await c.req.json().catch(() => null), nowInstant());
    return c.json({ place: await placeOf(c, id) });
  } catch (e) {
    return refusal(c, e);
  }
});

placeRoutes.delete("/:id", async (c) => {
  try {
    await deletePlace(c.get("db"), c.get("userId"), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return refusal(c, e);
  }
});
