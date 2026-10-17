/**
 * `/api/today` — the Today card's body check (the new shape, 2026-10-17; services/body-check.ts).
 *
 *   GET  /api/today/body?workout=<id>          the check as the card shows it: today's answer, what it did, open or not,
 *                                              the areas the picker offers
 *   POST /api/today/body       {workoutId, feel, areas?}   keep the answer, and adapt the day as it asks
 *   POST /api/today/body/undo  {workoutId}                 put the session back as the day had it; the answer stays
 *
 * Each answers the check (`BodyCheckView`): `pending: true` when an ease is recorded and not yet applied (the client
 * asks again, at once), `coachDrain: true` when a watch write is queued for the client to drain (as after an approve).
 * 404 `not_found` for a session that isn't the athlete's; 409 `closed` once it has started, is done, or isn't today's;
 * 422 `invalid` for an answer the check doesn't take. A restore in progress is refused (423) by `requireUser` before
 * any write.
 *
 * NO CALENDAR SYNC IN THE REQUEST. An eased session's block changes length; the half-hourly reconcile books it, as it
 * books a new build's (routes/sessions.ts). A sync here — Google calls and their writes — would not fit beside a build
 * in one invocation (the budget is pinned in body-check-engine.test.ts).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import {
  answerBodyCheck,
  BODY_FEELS,
  BodyCheckClosedError,
  BodyCheckInvalidError,
  BodyCheckNotFoundError,
  readBodyCheck,
  undoBodyCheck,
  type BodyCheckCtx,
  type BodyCheckOutcome,
} from "../services/body-check.js";

export const todayBodyRoutes = new Hono<AppContext>();
todayBodyRoutes.use("*", requireUser);

const workoutId = z.string().min(1).max(200);
const answerSchema = z
  .object({ workoutId, feel: z.enum(BODY_FEELS), areas: z.array(z.string().min(1).max(60)).max(30).optional() })
  .strict();
const undoSchema = z.object({ workoutId }).strict();

function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof BodyCheckNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof BodyCheckClosedError) return c.json({ error: "closed" }, 409);
  if (e instanceof BodyCheckInvalidError) return c.json({ error: "invalid", why: e.why }, 422);
  throw e;
}

const answered = (c: Context<AppContext>, out: BodyCheckOutcome): Response =>
  c.json({ ...out.view, ...(out.coachDrain ? { coachDrain: true } : {}) });

async function checkCtx(c: Context<AppContext>): Promise<BodyCheckCtx> {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  return { today: todayInZone(prefs.timezone), now: nowInstant(), prefs };
}

todayBodyRoutes.get("/body", async (c) => {
  const id = workoutId.safeParse(c.req.query("workout"));
  if (!id.success) return c.json({ error: "invalid", why: "workout" }, 422);
  try {
    return c.json(await readBodyCheck(c.get("db"), c.get("userId"), id.data, await checkCtx(c)));
  } catch (e) {
    return refusal(c, e);
  }
});

todayBodyRoutes.post("/body", async (c) => {
  const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", why: parsed.error.issues.map((i) => i.path.join(".")).join(", ") }, 422);
  const { workoutId: id, ...answer } = parsed.data;
  try {
    return answered(c, await answerBodyCheck(c.get("db"), c.get("userId"), id, answer, await checkCtx(c)));
  } catch (e) {
    return refusal(c, e);
  }
});

todayBodyRoutes.post("/body/undo", async (c) => {
  const parsed = undoSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", why: "workoutId" }, 422);
  try {
    return answered(c, await undoBodyCheck(c.get("db"), c.get("userId"), parsed.data.workoutId, await checkCtx(c)));
  } catch (e) {
    return refusal(c, e);
  }
});
