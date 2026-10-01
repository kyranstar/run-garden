/**
 * `/api/programs` — the athlete's adaptive programs (Phase 2 spec §2a "Programs API").
 *
 *   GET    /             the user's programs with their block and this week's count vs goal
 *   POST   /             {name, config} → create, place its slots, return it (201)
 *   PATCH  /:id          {name?, config? (merged), status? active|retired} → update, re-place, return it
 *
 * An invalid body is 422 with zod's issues. Placement runs here, after the write, through the one rule the
 * hourly pass uses; the calendar then books it through the existing reconciler. A restore in progress is refused
 * (423) by `requireUser` before any of this runs.
 */
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { adaptiveConfigSchema, nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { placeSlots } from "../services/program-slots.js";
import {
  adaptiveStatusSchema,
  createAdaptiveProgram,
  loadProgram,
  listPrograms,
  programNameSchema,
  ProgramNotFoundError,
  RestoreInProgressError,
  updateProgram,
} from "../services/programs.js";
import { waitUntilSafe } from "../services/wait-until.js";

export const programRoutes = new Hono<AppContext>();
programRoutes.use("*", requireUser);

const createSchema = z
  .object({
    name: programNameSchema,
    config: adaptiveConfigSchema,
  })
  .strict();

const patchSchema = z
  .object({
    name: programNameSchema.optional(),
    /** Only the keys sent change; the service merges them over the stored config. */
    config: adaptiveConfigSchema.partial().strict().optional(),
    status: adaptiveStatusSchema.optional(),
  })
  .strict();

function invalid(c: Context<AppContext>, error: ZodError): Response {
  return c.json({ error: "invalid_program", issues: error.issues }, 422);
}

/** Place the program's slots, then let the calendar book them. */
async function placeAndBook(c: Context<AppContext>, programId: string, today: string, now: string): Promise<void> {
  const db = c.get("db");
  const userId = c.get("userId");
  await placeSlots(db, userId, programId, today, await loadPreferences(db, userId), now);
  waitUntilSafe(c, syncCalendar(db, c.env, userId));
}

programRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  return c.json({ programs: await listPrograms(db, userId, todayInZone(prefs.timezone)) });
});

programRoutes.post("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  let id: string;
  try {
    id = await createAdaptiveProgram(db, userId, parsed.data, now);
  } catch (e) {
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
  await placeAndBook(c, id, today, now);
  return c.json({ program: await loadProgram(db, userId, id, today) }, 201);
});

programRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  try {
    await updateProgram(db, userId, id, parsed.data, now);
  } catch (e) {
    if (e instanceof ProgramNotFoundError) return c.json({ error: "not_found" }, 404);
    if (e instanceof ZodError) return invalid(c, e);
    throw e;
  }
  await placeAndBook(c, id, today, now);
  return c.json({ program: await loadProgram(db, userId, id, today) });
});
