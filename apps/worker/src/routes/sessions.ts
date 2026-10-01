/**
 * `/api/sessions` — a program slot's session, built on its day (Phase 2 spec §2a "Build API") — and
 * `/api/conditions` — the day's condition check (the Today chip).
 *
 *   GET    /api/sessions/:workoutId          the slot, its current build (or none), its day's checks, the lock
 *   POST   /api/sessions/:workoutId/build    {checks?, overrides?, swaps?} → build, or the stored build when the
 *                                            inputs are unchanged; a day ahead is a preview
 *   POST   /api/sessions/:workoutId/start    lock the day's build; idempotent
 *   POST   /api/conditions/checks            {profileId, value, feelingOff} → the day's check
 *
 * 404 for a slot that is not this user's live program / on-demand row; 409 `not_today` (a day gone, or Start on a
 * day ahead), 409 `locked` with the locked session, 409 `not_built`; 422 for an invalid body or a profile that is
 * not switched on. Everything engine-shaped lives in `services/session-build.ts`. A restore in progress is refused
 * (423) by `requireUser` before any write runs.
 */
import { Hono, type Context } from "hono";
import { z, type ZodError } from "zod";
import { nowInstant, sessionModeSchema, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import {
  buildSession,
  loadSession,
  NotBuiltError,
  NotTodayError,
  recordCheck,
  SessionLockedError,
  SessionNotFoundError,
  startSession,
  UnknownProfileError,
} from "../services/session-build.js";
import { waitUntilSafe } from "../services/wait-until.js";

export const sessionRoutes = new Hono<AppContext>();
sessionRoutes.use("*", requireUser);

export const conditionRoutes = new Hono<AppContext>();
conditionRoutes.use("*", requireUser);

const profileId = z.string().min(1).max(60);
const exerciseId = z.string().min(1).max(200);
const checkValue = z.number().int().min(0).max(10).nullable();

const buildSchema = z
  .object({
    checks: z.record(profileId, z.object({ pre: checkValue, feelingOff: z.boolean().default(false) }).strict()).optional(),
    overrides: z
      .object({
        mode: sessionModeSchema.optional(),
        theme: z.string().min(1).max(60).optional(),
        minutes: z.number().int().min(10).max(90).optional(),
        locationId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    swaps: z
      .record(
        z.string().min(1).max(60),
        z.object({ from: exerciseId.nullable().optional(), to: exerciseId.nullable().optional() }).strict().nullable(),
      )
      .refine((s) => Object.keys(s).length <= 100, { message: "too many swaps" })
      .optional(),
  })
  .strict();

const checkSchema = z
  .object({ profileId, value: checkValue, feelingOff: z.boolean().default(false) })
  .strict();

const invalid = (c: Context<AppContext>, error: ZodError) => c.json({ error: "invalid_build", issues: error.issues }, 422);

/** The errors every session route shares, as responses; anything else is rethrown. */
function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof NotTodayError) return c.json({ error: "not_today", date: e.date, today: e.today }, 409);
  if (e instanceof SessionLockedError) return c.json({ error: "locked", session: e.session }, 409);
  if (e instanceof NotBuiltError) return c.json({ error: "not_built" }, 409);
  if (e instanceof UnknownProfileError) return c.json({ error: "unknown_profile" }, 422);
  throw e;
}

sessionRoutes.get("/:workoutId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await loadSession(db, userId, c.req.param("workoutId"), todayInZone(prefs.timezone)));
  } catch (e) {
    return refusal(c, e);
  }
});

sessionRoutes.post("/:workoutId/build", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // No body is an empty request: "build with what the day already holds".
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_build", issues: [{ message: "invalid JSON" }] }, 422);
    }
  }
  const parsed = buildSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  try {
    const session = await buildSession(db, userId, c.req.param("workoutId"), parsed.data, { today, now, prefs });
    // A new build of the day renames and resizes the row: the calendar picks it up through the existing
    // reconciler. A stored build returned unchanged (or a preview) changed nothing it shows.
    if (session.date === today && session.build?.builtAt === now) waitUntilSafe(c, syncCalendar(db, c.env, userId));
    return c.json(session);
  } catch (e) {
    return refusal(c, e);
  }
});

sessionRoutes.post("/:workoutId/start", async (c) => {
  try {
    return c.json(await startSession(c.get("db"), c.get("userId"), c.req.param("workoutId"), nowInstant()));
  } catch (e) {
    return refusal(c, e);
  }
});

conditionRoutes.post("/checks", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = checkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_check", issues: parsed.error.issues }, 422);
  const prefs = await loadPreferences(db, userId);
  try {
    const check = await recordCheck(db, userId, parsed.data, { today: todayInZone(prefs.timezone), now: nowInstant() });
    return c.json({ check });
  } catch (e) {
    if (e instanceof UnknownProfileError) return c.json({ error: "unknown_profile" }, 422);
    throw e;
  }
});
