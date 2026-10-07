/**
 * `/api/library` — the exercise library to browse, and the athlete's say on each move (Phase 2 spec §2c "Library
 * API"; services/library-view.ts).
 *
 *   GET  /?q=&pattern=&region=&role=&equipment=&location=&safe=   slim rows, the default place, the switched-on
 *                                                                  profiles and the wishlist's unlock counts
 *   GET  /:id                                                      the whole record with the athlete's history for it
 *   PUT  /:id/prefs  {rating?: 1|-1|null, excluded?, pinned?}      → `{prefs}`; only what is sent changes
 *
 * 422 `invalid_query` for a filter outside the vocabularies or a place that is not this user's (nor a preset);
 * 404 `not_found` for a move the library does not have; 422 `invalid_prefs` for a body that is not one of the above;
 * 423 while a restore is replacing the account (`requireUser`, and the service's own check).
 */
import { Hono } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import { EQUIPMENT_IDS, PATTERNS, REGIONS, ROLES } from "@rg/exercise-library";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  LibraryItemNotFoundError,
  libraryItem,
  listLibrary,
  setExercisePrefs,
  UnknownPlaceError,
} from "../services/library-view.js";
import { RestoreInProgressError } from "../services/programs.js";

export const libraryRoutes = new Hono<AppContext>();
libraryRoutes.use("*", requireUser);

const querySchema = z
  .object({
    q: z.string().max(100).optional(),
    pattern: z.enum(PATTERNS).optional(),
    region: z.enum(REGIONS).optional(),
    role: z.enum(ROLES).optional(),
    equipment: z.enum(EQUIPMENT_IDS).optional(),
    location: z.string().min(1).max(200).optional(),
    safe: z
      .enum(["1", "0", "true", "false"])
      .transform((v) => v === "1" || v === "true")
      .optional(),
  })
  .strict();

const prefsSchema = z
  .object({
    rating: z.union([z.literal(1), z.literal(-1), z.null()]).optional(),
    excluded: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to change" });

libraryRoutes.get("/", async (c) => {
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "invalid_query", issues: parsed.error.issues }, 422);
  try {
    return c.json(await listLibrary(c.get("db"), c.get("userId"), parsed.data));
  } catch (e) {
    if (e instanceof UnknownPlaceError) return c.json({ error: "invalid_query", issues: [{ path: ["location"], message: "not one of your places" }] }, 422);
    throw e;
  }
});

libraryRoutes.get("/:id", async (c) => {
  try {
    return c.json(await libraryItem(c.get("db"), c.get("userId"), c.req.param("id")));
  } catch (e) {
    if (e instanceof LibraryItemNotFoundError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
});

libraryRoutes.put("/:id/prefs", async (c) => {
  const parsed = prefsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_prefs", issues: parsed.error.issues }, 422);
  try {
    const prefs = await setExercisePrefs(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data, nowInstant());
    return c.json({ prefs });
  } catch (e) {
    if (e instanceof LibraryItemNotFoundError) return c.json({ error: "not_found" }, 404);
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
});
