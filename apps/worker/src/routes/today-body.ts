/**
 * `/api/today` — the Today card's body check (the new shape, 2026-10-17; services/body-check.ts).
 *
 *   GET  /api/today/body?workout=<id>          the check as the card shows it: today's answer, what it did, open or not,
 *                                              the areas the picker offers
 *   POST /api/today/body       {workoutId, feel, areas?}   keep the answer, and adapt the day as it asks
 *   POST /api/today/body/undo  {workoutId}                 put the session back as it was planned; the answer stays
 *
 * Each answers the check (`BodyCheckView`), with `coachDrain: true` when a watch write is queued for the client to drain
 * (as after an approve). 404 `not_found` for a session that isn't the athlete's; 409 `closed` once it has started, is
 * done, or isn't today's; 422 `invalid` for an answer the check doesn't take. A restore in progress is refused (423) by
 * `requireUser` before any write.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import {
  answerBodyCheck,
  BODY_FEELS,
  BodyCheckClosedError,
  BodyCheckInvalidError,
  BodyCheckNotFoundError,
  readBodyCheck,
  type BodyCheckOutcome,
} from "../services/body-check.js";
import { waitUntilSafe } from "../services/wait-until.js";

export const todayBodyRoutes = new Hono<AppContext>();
todayBodyRoutes.use("*", requireUser);

const workoutId = z.string().min(1).max(200);
const answerSchema = z
  .object({ workoutId, feel: z.enum(BODY_FEELS), areas: z.array(z.string().min(1).max(60)).max(30).optional() })
  .strict();

async function refusal(c: Context<AppContext>, e: unknown): Promise<Response> {
  if (e instanceof BodyCheckNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof BodyCheckClosedError) return c.json({ error: "closed" }, 409);
  if (e instanceof BodyCheckInvalidError) return c.json({ error: "invalid", why: e.why }, 422);
  throw e;
}

/** The check, with what the client does next: its calendar synced in the background, its watch write drained. */
function answered(c: Context<AppContext>, out: BodyCheckOutcome): Response {
  if (out.calendarChanged) {
    waitUntilSafe(c, syncCalendar(c.get("db"), c.env, c.get("userId"), { maxOps: CALENDAR_OPS_PER_REQUEST }));
  }
  return c.json({ ...out.view, ...(out.coachDrain ? { coachDrain: true } : {}) });
}

todayBodyRoutes.get("/body", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = workoutId.safeParse(c.req.query("workout"));
  if (!id.success) return c.json({ error: "invalid", why: "workout" }, 422);
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await readBodyCheck(db, userId, id.data, { today: todayInZone(prefs.timezone) }));
  } catch (e) {
    return refusal(c, e);
  }
});

todayBodyRoutes.post("/body", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", why: parsed.error.issues.map((i) => i.path.join(".")).join(", ") }, 422);
  const prefs = await loadPreferences(db, userId);
  const { workoutId: id, ...answer } = parsed.data;
  try {
    return answered(c, await answerBodyCheck(db, userId, id, answer, { today: todayInZone(prefs.timezone), now: nowInstant(), prefs }));
  } catch (e) {
    return refusal(c, e);
  }
});
