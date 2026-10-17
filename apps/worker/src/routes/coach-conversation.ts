/**
 * `/api/coach/conversation` — the coach, a conversation (the new shape §5; services/coach-conversation.ts).
 *
 * Inert until the owner turns it on, as the runs are: a plain 404 unless `COACH_DESIGNER = "1"` or this is staging,
 * signed in or not; then the session is checked. Mounted ahead of `/api/coach` in index.ts.
 *
 *   GET /        → { id, startedAt, turns }   the athlete's current conversation (its newest ask under 18 hours old):
 *                                              at most 20 turns, the newest of them, oldest first — each { runId, at,
 *                                              words, status, line, cards, question }; none current: { id: null,
 *                                              startedAt: null, turns: [] }
 *   GET /?id=x   → the same for the conversation the athlete's run `x` is a turn of (any turn of it); none of theirs by
 *                  that id answers as none current; an id that can't be one: 400 { error: "bad_conversation" }
 *
 * Two statements with the sign-in (pinned; the seam allows three): the sign-in's, and the conversation's one read.
 */
import { Hono } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import { CONVERSATION_ID, readConversation } from "../services/coach-conversation.js";
import { endedLine } from "../services/coach-runs.js";

/** The routes, over a clock (tests pass their own). */
export function makeCoachConversationRoutes(deps: { now?: () => Date } = {}): Hono<AppContext> {
  const now = deps.now ?? (() => new Date());
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);

  routes.get("/", async (c) => {
    const id = c.req.query("id");
    if (id !== undefined && !CONVERSATION_ID.test(id)) return c.json({ error: "bad_conversation" }, 400);
    return c.json(await readConversation(c.get("db"), c.get("userId"), now(), { ...(id !== undefined ? { id } : {}), endedLine }));
  });

  return routes;
}

export const coachConversationRoutes = makeCoachConversationRoutes();
