/**
 * `/api/sessions` — a program slot's session, built on its day (Phase 2 spec §2a "Build API") — and
 * `/api/conditions` — the day's condition check (the Today chip).
 *
 *   GET    /api/sessions/:workoutId          the slot, its current build (or none), its day's checks, the lock
 *   GET    /api/sessions/:workoutId/current  {buildId, current, locked}: is that build still the day's? (no build made)
 *   GET    /api/sessions/:workoutId/review-basis  what the review reads of the history, fetched at Start (a read)
 *   POST   /api/sessions/:workoutId/build    {checks?, overrides?, swaps?} → build, or the stored build when the
 *                                            inputs are unchanged; a day ahead is a preview
 *   POST   /api/sessions/:workoutId/start    {buildId} → lock that build, while it is still the day's; idempotent
 *   POST   /api/sessions/:workoutId/unstart  the player's Discard: back to built, the build unlocked; idempotent
 *   PUT    /api/sessions/performed/:id       a performed session from the player's outbox, saved exactly once
 *   POST   /api/conditions/checks            {profileId, value, feelingOff} → the day's check
 *
 * 404 for a slot that is not this user's live program / on-demand row; 409 `not_today` (a day gone, or Start on a
 * day ahead), 409 `locked` with the locked session, 409 `not_built`, 409 `stale` with the fresh session (Start named a
 * build the day's inputs no longer make); 422 for an invalid body or a profile that is not switched on. Everything engine-shaped lives in `services/session-build.ts`. A restore in progress is refused
 * (423) by `requireUser` before any write runs.
 */
import { Hono, type Context } from "hono";
import { z, type ZodError } from "zod";
import { nowInstant, sessionModeSchema, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import {
  buildSessionOutcome,
  loadSession,
  NotBuiltError,
  NotTodayError,
  PerformedExistsError,
  recordCheck,
  RestoringError,
  sessionCurrency,
  SessionLockedError,
  SessionNotFoundError,
  StaleBuildError,
  startSessionOutcome,
  UnknownProfileError,
  unstartSession,
} from "../services/session-build.js";
import { InvalidSaveError, savePerformedSession } from "../services/session-save.js";
import { reviewBasis } from "../services/session-review-basis.js";
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

/** Start names the build the athlete was shown (audit I3). */
const startSchema = z.object({ buildId: z.string().min(1).max(200) }).strict();

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

/** Whether the build the slot shows is still the one its day's inputs make (Start would lock it as it is). */
sessionRoutes.get("/:workoutId/current", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await sessionCurrency(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant(), prefs }));
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * What the player's review needs of the history — the records baseline, the graduation basis, the build's moves'
 * saved prefs — fetched once at Start and kept on the device, so the review works offline (session-review-basis.ts).
 */
sessionRoutes.get("/:workoutId/review-basis", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await reviewBasis(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), unit: prefs.weightUnit }));
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
    const { session, calendarChanged } = await buildSessionOutcome(db, userId, c.req.param("workoutId"), parsed.data, { today, now, prefs });
    // A new build of the day renames and resizes the row: the calendar picks it up through the existing
    // reconciler. A stored build returned unchanged (or a preview) changed nothing it shows.
    if (calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
    return c.json(session);
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * The player's Discard (ruling 2b-R9): a started slot back to `built`, its build unlocked — Today offers Start again.
 * 200 with the session (also when it was built already); 409 `performed` once a performed session exists for it; 404
 * for a slot that is not this user's; 423 while a restore runs.
 */
sessionRoutes.post("/:workoutId/unstart", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await unstartSession(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant() }));
  } catch (e) {
    if (e instanceof PerformedExistsError) return c.json({ error: "performed" }, 409);
    if (e instanceof RestoringError) return c.json({ error: "restore_in_progress" }, 423);
    return refusal(c, e);
  }
});

sessionRoutes.post("/:workoutId/start", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_start", issues: parsed.error.issues }, 422);
  try {
    const { session, calendarChanged } = await startSessionOutcome(db, userId, c.req.param("workoutId"), parsed.data.buildId, nowInstant());
    // An outline again took the build's title and length as Start locked it (U4): the calendar picks that up.
    if (calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
    return c.json(session);
  } catch (e) {
    if (e instanceof StaleBuildError) {
      if (e.calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
      return c.json({ error: "stale", session: e.session }, 409);
    }
    return refusal(c, e);
  }
});

/**
 * The player's outbox delivers a performed session here, as often as it needs (services/session-save.ts): 200
 * `{status:"saved", …}` or `{status:"same_payload"}`; 409 `{error:"conflict"}` for the same session with other edits;
 * 409 `{error:"slot_done"}` for another session of a slot whose app session is saved already (ruling 2b-R18);
 * 404 for a slot that is not this user's; 422 `invalid_save`; 503 `busy` while the same session is being saved (the
 * outbox retries); 423 while a restore runs (`requireUser`, or the save's own check).
 */
sessionRoutes.put("/performed/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid_save", issues: [{ message: "invalid JSON" }] }, 422);
  }
  const prefs = await loadPreferences(db, userId);
  try {
    const outcome = await savePerformedSession(db, userId, c.req.param("id"), body, { now: nowInstant(), prefs });
    if (outcome.status === "conflict") return c.json({ error: "conflict" }, 409);
    if (outcome.status === "slot_done") return c.json({ error: "slot_done" }, 409);
    if (outcome.status === "busy") return c.json({ error: "busy" }, 503);
    if (outcome.status === "restoring") return c.json({ error: "restore_in_progress" }, 423);
    return c.json(outcome);
  } catch (e) {
    if (e instanceof InvalidSaveError) return c.json({ error: "invalid_save", issues: e.issues }, 422);
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
