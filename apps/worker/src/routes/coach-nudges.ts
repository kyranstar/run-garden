/**
 * `GET /api/coach/nudges` — the coach's opening screen's read (services/coach-nudges.ts): `{ nudges: [{ id, label,
 * request }], opening? }`.
 *  - `nudges`: the "needs you" chips (§8 §6), at most two, computed on read from the thread coach's old trigger rules,
 *    writing nothing. The screen puts them before its general starters; a tap sends `request` as the athlete's words.
 *  - `opening` (stream H; absent when there is none — an older screen never looks): the coach's own line, when it
 *    noticed something — last week's review, or a session just finished — `{ id, line, source, chips, workoutId? }`.
 *    `?seen=<id>,<id>`: openings this device has already shown, which give way to the next.
 *
 * Inert while the coach designer is off, as its conversation is: a plain 404, signed in or not; then the session is
 * checked. Mounted ahead of `/api/coach` in index.ts.
 *
 * Eight statements at most with the sign-in and the preferences (pinned): the read's six, and four on a quiet account.
 */
import { Hono } from "hono";
import { todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { parseSeen } from "../services/coach-opening-line.js";
import { readCoachOpening } from "../services/coach-nudges.js";

/** The routes, over a clock (tests pass their own). */
export function makeCoachNudgesRoutes(deps: { now?: () => Date } = {}): Hono<AppContext> {
  const clock = deps.now ?? (() => new Date());
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);

  routes.get("/", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId");
    const prefs = await loadPreferences(db, userId);
    const now = clock();
    const { opening, nudges } = await readCoachOpening(db, userId, prefs, todayInZone(prefs.timezone, now), now, parseSeen(c.req.query("seen")));
    return c.json(opening ? { nudges, opening } : { nudges });
  });

  return routes;
}

export const coachNudgesRoutes = makeCoachNudgesRoutes();
