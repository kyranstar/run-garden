/**
 * `/api/coach/replay` — the coach's voice workshop (services/coach-replay.ts, coach-voice.ts): a finished main run's
 * athlete-facing step called again with the production model on its own stored context, once per voice variant, and
 * only the coach's words answered. For the owner's own account only.
 *
 * Inert unless all of: the coach designer's switch (`COACH_DESIGNER = "1"`, or staging — as the runs), a session, and
 * the owner signed in (`ALLOWED_GOOGLE_EMAIL`, compared as sign-in compares it): otherwise a plain 404 (401 with no
 * session). Mounted ahead of `/api/coach` in index.ts.
 *
 *   POST /       { confirm: "replay a coach run", runId, at?: "finish" | "ask" | "prose",
 *                  variants: [{ id, length?, tone?, include?, person? }] (1–8; each variable an enum, coach-voice.ts) }
 *                → { runId, at, request, model, baseline, variants: [{ id, settings, line?, chars?, question?, choices?,
 *                  prose?, said?, called?, costUsd, usage?, stopReason?, error?, skipped? }], costUsd, capNote }
 *                At most 3 variants for `at: "prose"` (each answer a whole document, parsed in this request's CPU).
 *                SPEND: the $1 per-request cap is SOFT — checked on an estimate (twice the longest answer seen), so a
 *                replay can spend up to about three times it (`capNote` says so). The weekly cap is the hard bound:
 *                each call's worst case must fit under it, and a request cut off partway holds its calls' worst case
 *                for 15 minutes, then counts them at their estimate (llm.ts `weekCostSql`).
 *                A body without the exact confirm is a 404 (nothing read, nothing called); with it, anything else wrong is
 *                400 { error: "bad_request", why }. Not the athlete's finished main run (another's, a sub-run, live,
 *                stopped, a rehearsal, none): 404. A step the run never took: 409 { error: "not_replayable", why }. The
 *                week can't cover the first call: 409 { error: "weekly_cap", why, spentUsd, cutoffUsd }.
 *                Statements and fetches: the sign-in's 2, then 4 + 2 a variant + 1 more past the first (8 variants: 23,
 *                pinned).
 *   GET /runs?limit=20 → { runs: [{ id, at, words, line, outcome, steps, costUsd }] }  the athlete's finished main runs,
 *                newest first (1–50; else 400 `bad_limit`): what each came to (answer, workout, plan_change, set, plan)
 *                and which steps replay. 2 statements with the sign-in (pinned).
 *
 * Nothing here writes anything but `llm_usage` (kind `coach_replay`).
 */
import { Hono } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import {
  defaultReplayDeps,
  listReplayable,
  REPLAY_CONFIRM,
  REPLAY_LIST_DEFAULT,
  REPLAY_LIST_MAX,
  replayBodySchema,
  replayRun,
  type ReplayDeps,
} from "../services/coach-replay.js";

/** The routes, over the model's transport and a clock (tests pass their own). */
export function makeCoachReplayRoutes(deps: () => ReplayDeps = defaultReplayDeps, o: { now?: () => Date } = {}): Hono<AppContext> {
  const now = o.now ?? (() => new Date());
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);
  routes.use("*", async (c, next) => {
    const owner = (c.env.ALLOWED_GOOGLE_EMAIL ?? "").trim().toLowerCase();
    if (!owner || (c.get("userEmail") ?? "").toLowerCase() !== owner) return c.json({ error: "not_found" }, 404);
    await next();
  });

  routes.get("/runs", async (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? REPLAY_LIST_DEFAULT : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!(limit >= 1 && limit <= REPLAY_LIST_MAX)) return c.json({ error: "bad_limit" }, 400);
    return c.json(await listReplayable(c.get("db"), c.get("userId"), limit));
  });

  routes.post("/", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (!raw || typeof raw !== "object" || raw.confirm !== REPLAY_CONFIRM) return c.json({ error: "not_found" }, 404);
    const body = replayBodySchema.safeParse(raw);
    if (!body.success) {
      const issue = body.error.issues[0];
      return c.json({ error: "bad_request", why: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Not a replay." }, 400);
    }
    const out = await replayRun(c.get("db"), c.env, c.get("userId"), body.data, deps(), now);
    switch (out.kind) {
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "not_replayable":
        return c.json({ error: "not_replayable", why: out.why }, 409);
      case "weekly_cap":
        return c.json({ error: "weekly_cap", why: out.why, spentUsd: out.spentUsd, cutoffUsd: out.cutoffUsd }, 409);
      case "ok":
        return c.json(out.body);
    }
  });

  return routes;
}

export const coachReplayRoutes = makeCoachReplayRoutes();
