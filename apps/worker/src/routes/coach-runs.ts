/**
 * `/api/coach/runs` — the coach designer's runs (Stage 3 spec §2). The client creates a run, then steps it — one
 * model call a request — while its screen is open, reading the run's events as they land; the hourly cron looks after
 * runs nobody is stepping (services/coach-runs.ts).
 *
 * Inert until the owner turns it on: every path here is a plain 404 unless `COACH_DESIGNER = "1"` or this is staging,
 * signed in or not; then the session is checked. Mounted ahead of `/api/coach` in index.ts so the coach's own sign-in
 * never answers for these paths first.
 *
 *   POST /                  { scope?, request?, rehearsal? } → { run, existing }  (one live main run per athlete: a
 *                           second create answers the live run with `offer` and the `ignoredRequest` it did not start)
 *   POST /:id/step          → { status, nextDue, events }    (409 busy while another step holds the run)
 *   GET  /current           → { run, events, proposal } | { run: null }   (what the Studio shows when it opens, Task 9:
 *                           the newest live main run, else the newest one over whose design proposal still has an op
 *                           to decide — never a rehearsal's; its last 50 events; the proposal it holds open — 2 + 3
 *                           statements, pinned)
 *   GET  /:id?afterSeq=n    → { run, events }                (events after n, in order)
 *   POST /:id/answer        { answers, dismissed? } → { run } (409 when nothing is waiting; an answer to a check-in
 *                           question is kept as the athlete's answer — 7 statements in all, pinned)
 *                           { conditionCheckId } answers an ask for today's condition check (fix wave 3A, A8): the
 *                           athlete's check, dated their today and saved after the question (400 otherwise; another
 *                           athlete's, or none, 404) — 7 statements, pinned
 *   POST /:id/cancel        → { run }
 *   POST /:id/undo-answer   { handle } → { undone }       (what record_answer kept from the request, or a check-in
 *                           question's kept answer, taken back; the
 *                           handle is the call's receipt's, and names this run: another run's is 400, one already taken
 *                           back 404)
 */
import { Hono } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import {
  ANSWER_MAX_CHARS,
  REQUEST_MAX_CHARS,
  answerRun,
  cancelRun,
  createRun,
  currentRun,
  defaultRunDeps,
  getRun,
  noteOnTrail,
  parseScopeRequest,
  runStep,
  type RunDeps,
} from "../services/coach-runs.js";
import { handleRunId, isMemoryHandle, undoRecordedAnswers } from "../services/design-tools/record-answer.js";
import { undoRemembered } from "../services/design-tools/remember.js";

/** A condition check's id, at most (ids are the app's own: `newId`). */
const CHECK_ID_MAX_CHARS = 100;

/** The routes, over `deps` (the model, the opening context, the tools); tests pass scripted ones. */
export function makeCoachRunRoutes(deps: () => RunDeps = defaultRunDeps): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);

  routes.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { scope?: unknown; request?: unknown; rehearsal?: unknown } | null;
    // No scope: the athlete's default; "next workouts" with no count: theirs (Settings → Coach, Task 10).
    const asked = body && typeof body === "object" && !Array.isArray(body) ? parseScopeRequest(body.scope) : null;
    if (!body || !asked) return c.json({ error: "bad_scope" }, 400);
    if (body.request !== undefined && body.request !== null && typeof body.request !== "string") {
      return c.json({ error: "bad_request_text" }, 400);
    }
    if (typeof body.request === "string" && body.request.length > REQUEST_MAX_CHARS) {
      return c.json({ error: "request_too_long", max: REQUEST_MAX_CHARS }, 400);
    }
    if (body.rehearsal !== undefined && typeof body.rehearsal !== "boolean") return c.json({ error: "bad_rehearsal" }, 400);
    const created = await createRun(
      c.get("db"),
      c.get("userId"),
      { ...asked, request: (body.request as string | null | undefined) ?? null, rehearsal: body.rehearsal === true },
      new Date(),
    );
    return c.json(created);
  });

  routes.post("/:id/step", async (c) => {
    const outcome = await runStep(c.get("db"), c.env, c.req.param("id"), c.get("userId"), new Date(), deps());
    switch (outcome.kind) {
      case "ok":
        return c.json(outcome.result);
      case "busy":
        return c.json({ error: "busy" }, 409);
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "restoring":
        return c.json({ error: "restore_in_progress" }, 423);
    }
  });

  // Before `/:id`, which would otherwise take "current" for a run's id.
  routes.get("/current", async (c) => {
    const current = await currentRun(c.get("db"), c.get("userId"));
    return c.json(current ?? { run: null });
  });

  routes.get("/:id", async (c) => {
    const raw = c.req.query("afterSeq") ?? "0";
    const afterSeq = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
    if (afterSeq === null) return c.json({ error: "bad_after_seq" }, 400);
    const run = await getRun(c.get("db"), c.get("userId"), c.req.param("id"), afterSeq);
    return run ? c.json(run) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/:id/answer", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { answers?: unknown; dismissed?: unknown; conditionCheckId?: unknown } | null;
    const dismissed = body?.dismissed === true;
    const answers = body?.answers ?? [];
    const checkId = body?.conditionCheckId;
    if (checkId !== undefined && (typeof checkId !== "string" || checkId.length === 0 || checkId.length > CHECK_ID_MAX_CHARS)) {
      return c.json({ error: "bad_check" }, 400);
    }
    const valid =
      Array.isArray(answers) &&
      answers.length <= 2 &&
      answers.every((a) => typeof a === "string" && a.length <= ANSWER_MAX_CHARS) &&
      (dismissed || typeof checkId === "string" || answers.some((a) => (a as string).trim().length > 0));
    if (!body || !valid) return c.json({ error: "bad_answers" }, 400);
    const outcome = await answerRun(
      c.get("db"),
      c.get("userId"),
      c.req.param("id"),
      { answers: answers as string[], dismissed, ...(typeof checkId === "string" ? { conditionCheckId: checkId } : {}) },
      new Date(),
    );
    switch (outcome.kind) {
      case "ok":
        return c.json({ run: outcome.run });
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "check_not_found":
        return c.json({ error: "check_not_found" }, 404);
      case "bad_answer":
        return c.json({ error: "bad_answer", why: outcome.why }, 400);
      case "not_waiting":
        return c.json({ error: "not_waiting", status: outcome.status }, 409);
    }
  });

  routes.post("/:id/cancel", async (c) => {
    const cancelled = await cancelRun(c.get("db"), c.get("userId"), c.req.param("id"), new Date());
    return cancelled ? c.json(cancelled) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/:id/undo-answer", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { handle?: unknown } | null;
    const handle = body?.handle;
    if (typeof handle !== "string" || handle.length > 300 || handleRunId(handle) !== c.req.param("id")) return c.json({ error: "bad_handle" }, 400);
    // remember's handle takes back the item it kept (Task 10); the others, the answers a call kept.
    const undone = isMemoryHandle(handle)
      ? await undoRemembered(c.get("db"), c.get("userId"), handle)
      : await undoRecordedAnswers(c.get("db"), c.get("userId"), handle);
    if (!undone) return c.json({ error: "not_found" }, 404);
    await noteOnTrail(c.get("db"), c.get("userId"), c.req.param("id"), `Taken back: ${undone.line}`, { undo: { handle, count: undone.count } }, new Date());
    return c.json({ undone: undone.count });
  });

  return routes;
}

export const coachRunRoutes = makeCoachRunRoutes();
