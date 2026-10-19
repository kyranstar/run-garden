/**
 * `/api/programs` — the athlete's adaptive programs (Phase 2 spec §2a "Programs API").
 *
 *   GET    /             the user's programs with their block and this week's count vs goal, plus the places and
 *                         switched-on profiles their settings pick from
 *   POST   /             {name, config} → create, place its slots, return it (201)
 *   PATCH  /:id          {name?, config? (merged), status? active|retired} → update, re-place, return it
 *
 * An invalid body is 422 with zod's issues. Placement runs here, after the write, through the one rule the
 * hourly pass uses; the calendar then books it through the existing reconciler. A restore in progress is refused
 * (423) by `requireUser` before any of this runs.
 *
 * WITHIN A REQUEST'S BUDGET (2026-10-19): a save that moves the days retracts and places a slot at a time, and a days
 * change at four weeks ahead measured 123 statements in one request against the free plan's 50. The write lands
 * whole; placement does what fits (`placeSlotsWithin`) and the answer says `placing: true` while some is left — the
 * settings sheet sends the same save again until it doesn't (a save is idempotent), and the hourly pass finishes it
 * for a client that never asks. The calendar's step runs in the room the last request left. Pinned in
 * programs-budget.test.ts.
 */
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import { locations } from "@rg/database";
import { activeProfileIds, conditionView } from "../services/condition-views.js";
import { adaptiveConfigSchema, nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { calendarOpsFitting } from "../services/design-approve.js";
import { placeSlotsWithin } from "../services/program-slots.js";
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

/** A request's statements at most (the suites' budget for the free plan's 50). */
export const REQUEST_BUDGET = 45;
/**
 * What a save costs beside placement: the session (2), the preferences, the write (the restore check, the program read
 * and its update: 3; a new one's insert is less), and the program read back (`loadProgram`: the programs, their blocks,
 * this week's slots: 3). Measured in programs-budget.test.ts.
 */
export const PROGRAM_SAVE_FIXED = 2 + 1 + 3 + 3;
/** The statements a save's placement may spend. */
export const PROGRAM_PLACE_BUDGET = REQUEST_BUDGET - PROGRAM_SAVE_FIXED;

/**
 * Place what fits of the program's slots; once nothing is left, let the calendar book them in the room left. True while
 * some is left (`placing`).
 */
async function placeAndBook(
  c: Context<AppContext>,
  programId: string,
  today: string,
  now: string,
  prefs: Awaited<ReturnType<typeof loadPreferences>>,
): Promise<boolean> {
  const db = c.get("db");
  const userId = c.get("userId");
  const placed = await placeSlotsWithin(db, userId, programId, today, prefs, now, PROGRAM_PLACE_BUDGET);
  if (placed.more) return true;
  const maxOps = calendarOpsFitting(PROGRAM_PLACE_BUDGET - placed.spent);
  if (maxOps > 0) waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps }).catch(() => undefined));
  return false;
}

programRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const [list, places, profiles] = await Promise.all([
    listPrograms(db, userId, todayInZone(prefs.timezone)),
    // What a program's settings pick from: the account's places (the default first) and its switched-on profiles.
    db
      .select({ id: locations.id, name: locations.name, isDefault: locations.isDefault })
      .from(locations)
      .where(eq(locations.userId, userId))
      .orderBy(desc(locations.isDefault), asc(locations.createdAt), asc(locations.id)),
    activeProfileIds(db, userId),
  ]);
  return c.json({ programs: list, places, profiles: profiles.map(conditionView) });
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
  const placing = await placeAndBook(c, id, today, now, prefs);
  return c.json({ program: await loadProgram(db, userId, id, today), ...(placing ? { placing } : {}) }, 201);
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
  const placing = await placeAndBook(c, id, today, now, prefs);
  return c.json({ program: await loadProgram(db, userId, id, today), ...(placing ? { placing } : {}) });
});
