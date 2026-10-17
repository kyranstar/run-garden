/**
 * `/api/coach/runs` — the coach designer's runs (Stage 3 spec §2). The client creates a run, then steps it — one
 * model call a request — while its screen is open, reading the run's events as they land; the hourly cron looks after
 * runs nobody is stepping (services/coach-runs.ts).
 *
 * Inert until the owner turns it on: every path here is a plain 404 unless `COACH_DESIGNER = "1"` or this is staging,
 * signed in or not; then the session is checked. Mounted ahead of `/api/coach` in index.ts so the coach's own sign-in
 * never answers for these paths first.
 *
 *   POST /                  { scope?, request?, rehearsal?, focus? } → { run, existing }  (one live main run per athlete: a
 *                           second create answers the live run with `offer` and the `ignoredRequest` it did not start;
 *                           409 { error: "week_budget", spentUsd, cutoffUsd } when the week's spend and what a run of
 *                           the scope costs would pass the weekly cutoff, and no live run is there — Task 13's fix wave)
 *                           `focus: { kind, id }` (coach everywhere, A1; design-focus.ts): what the athlete asked from —
 *                           400 `bad_focus` when it isn't one; 404 `focus_not_found` when it isn't theirs or isn't there
 *                           (one statement; none for a day or a move); 400 { error: "focus_out_of_range" | "focus_is_set",
 *                           why } for a day past the run's horizon or a set's suggestion, in words. A suggestion's focus
 *                           with no scope takes the suggestion's own.
 *   POST /:id/step          → { status, nextDue, events }    (409 busy while another step holds the run)
 *                           With the step alarm on (COACH_STEP_ALARM, coach-run-stepper.ts): `?afterSeq=n` → { status,
 *                           armed: true, nextDue: null, events after n } at once — the run's object is armed and its
 *                           alarm steps the run; never a model call in the request. A run waiting on the athlete, or
 *                           over: { status, nextDue: null, events }, nothing armed. Sign-in, the run and its events, and
 *                           one request to the object.
 *   GET  /current           → { run, events, proposal, alsoOpen } | { run: null }   (what the Studio shows when it opens,
 *                           Task 9: the newest live main run, else the newest one over whose design proposal still has
 *                           an op to decide, or was decided in the last 10 minutes (a reload during Approve shows what
 *                           came of it) — never a rehearsal's; its last 50 events; that proposal; the other designed
 *                           suggestions still open, newest first, at most 5 (Task 13's fix wave, R2) — 2 + 4
 *                           statements, pinned)
 *   GET  /:id?afterSeq=n    → { run, events }                (events after n, in order; with the step alarm on, a
 *                           live run's object is told a client is here — its lease — and arms a step that is due)
 *   POST /:id/answer        { answers, dismissed? } → { run } (409 when nothing is waiting; an answer to a check-in
 *                           question is kept as the athlete's answer — 7 statements in all, pinned)
 *                           { conditionCheckId } answers an ask for today's condition check (fix wave 3A, A8): the
 *                           athlete's check, dated their today and saved after the question (400 otherwise; another
 *                           athlete's, or none, 404) — 7 statements, pinned (with the step alarm on, and one request
 *                           to the run's object: the run it resumes is armed)
 *   POST /:id/cancel        → { run }                       (with the step alarm on, and one request to the run's
 *                           object: it forgets the run)
 *   POST /:id/undo-answer   { handle } → { undone }       (what record_answer kept from the request, or a check-in
 *                           question's kept answer, taken back; the
 *                           handle is the call's receipt's, and names this run: another run's is 400, one already taken
 *                           back 404)
 */
import { Hono } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled, type Env } from "../env.js";
import { stepAlarmOn, stepperLeaseMs, tellStepper, type StepperHint, type StepperOp } from "../services/coach-run-stepper.js";
import { FocusError, focusSchema } from "../services/design-focus.js";
import {
  ANSWER_MAX_CHARS,
  REQUEST_MAX_CHARS,
  answerRun,
  cancelRun,
  createRun,
  currentRun,
  defaultRunDeps,
  getRun,
  LIVE_STATUSES,
  noteOnTrail,
  parseScopeRequest,
  runStep,
  type CoachRunDto,
  type RunDeps,
  WeekBudgetError,
} from "../services/coach-runs.js";
import { handleRunId, isMemoryHandle, undoRecordedAnswers } from "../services/design-tools/record-answer.js";
import { undoRemembered } from "../services/design-tools/remember.js";

/** A condition check's id, at most (ids are the app's own: `newId`). */
const CHECK_ID_MAX_CHARS = 100;

/** A run a step goes on from: live, and not waiting on the athlete. */
const AT_WORK: readonly string[] = ["active", "stepping", "waiting_review", "waiting_set"];
const isLive = (status: string): boolean => (LIVE_STATUSES as readonly string[]).includes(status);

/** `afterSeq` as the reads take it: digits, at most nine (absent: 0); null when it isn't. */
function afterSeqOf(raw: string | undefined): number | null {
  const text = raw ?? "0";
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/** What a route read of the run tells its object with every word (Task 13's fix wave): whether it reads `stepping`
 * — a step on record for a run that doesn't holds no claim (R18) — and its lease by scope (§2.12). */
const hintOf = (run: Pick<CoachRunDto, "status" | "scope">): StepperHint => ({ stepping: run.status === "stepping", leaseMs: stepperLeaseMs(run.scope) });

/**
 * A client's word to its run's object (the step alarm): a read or an answer is here (`touch`), an answer asks for the
 * step it resumes (`arm`). A word that fails is logged and never the request's failure — the read answered — and the
 * client's next word, or its own arm, tells the object again.
 */
async function tellQuietly(env: Env, run: Pick<CoachRunDto, "id" | "status" | "scope">, userId: string, op: StepperOp): Promise<void> {
  const runId = run.id;
  try {
    await tellStepper(env, runId, userId, op, hintOf(run));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "coach-runs: the run's stepper was not told", run: runId, op, error: e instanceof Error ? e.message : "unknown" }));
  }
}

/** The routes, over `deps` (the model, the opening context, the tools); tests pass scripted ones. */
export function makeCoachRunRoutes(deps: () => RunDeps = defaultRunDeps): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);

  routes.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { scope?: unknown; request?: unknown; rehearsal?: unknown; focus?: unknown } | null;
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
    // What the athlete asked from (coach everywhere, A1): a kind and an id, nothing else (design-focus.ts).
    const focus = body.focus === undefined ? null : focusSchema.safeParse(body.focus);
    if (focus && !focus.success) return c.json({ error: "bad_focus" }, 400);
    try {
      const created = await createRun(
        c.get("db"),
        c.get("userId"),
        {
          ...asked,
          request: (body.request as string | null | undefined) ?? null,
          rehearsal: body.rehearsal === true,
          ...(focus?.success ? { focus: focus.data } : {}),
        },
        new Date(),
      );
      return c.json(created);
    } catch (e) {
      // The week can't pay for it (Task 13's fix wave, §2.11): nothing started.
      if (e instanceof WeekBudgetError) return c.json({ error: "week_budget", spentUsd: e.spentUsd, cutoffUsd: e.cutoffUsd }, 409);
      // Not the athlete's, or not one there (404); a day the run can't plan, or a set's suggestion (400, in words).
      if (e instanceof FocusError) {
        return e.code === "focus_not_found" ? c.json({ error: e.code }, 404) : c.json({ error: e.code, why: e.why ?? "" }, 400);
      }
      throw e;
    }
  });

  routes.post("/:id/step", async (c) => {
    if (stepAlarmOn(c.env)) {
      // The alarm path: the run checked and read, its object armed — the step runs in the object's alarm, never here.
      const afterSeq = afterSeqOf(c.req.query("afterSeq"));
      if (afterSeq === null) return c.json({ error: "bad_after_seq" }, 400);
      const read = await getRun(c.get("db"), c.get("userId"), c.req.param("id"), afterSeq);
      if (!read) return c.json({ error: "not_found" }, 404);
      // (A sub-run's id is no run here — the reads answer main runs only — so only a main run's object is armed.)
      if (!AT_WORK.includes(read.run.status)) return c.json({ status: read.run.status, nextDue: null, events: read.events });
      try {
        await tellStepper(c.env, read.run.id, c.get("userId"), "arm", hintOf(read.run));
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "coach-runs: the run's stepper was not armed", run: read.run.id, error: e instanceof Error ? e.message : "unknown" }));
        return c.json({ error: "stepper_unavailable" }, 503);
      }
      return c.json({ status: read.run.status, armed: true, nextDue: null, events: read.events });
    }
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
    const afterSeq = afterSeqOf(c.req.query("afterSeq"));
    if (afterSeq === null) return c.json({ error: "bad_after_seq" }, 400);
    const run = await getRun(c.get("db"), c.get("userId"), c.req.param("id"), afterSeq);
    if (!run) return c.json({ error: "not_found" }, 404);
    // A client reading a live run is watching it: its lease (and a step that is due, armed).
    if (stepAlarmOn(c.env) && isLive(run.run.status)) await tellQuietly(c.env, run.run, c.get("userId"), "touch");
    return c.json(run);
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
      case "ok": {
        // The answer resumes the run: its object armed (or, a question still open, told the athlete is here).
        const run = outcome.run;
        if (stepAlarmOn(c.env) && isLive(run.status)) {
          await tellQuietly(c.env, run, c.get("userId"), AT_WORK.includes(run.status) ? "arm" : "touch");
        }
        return c.json({ run });
      }
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
    if (!cancelled) return c.json({ error: "not_found" }, 404);
    // Over by the athlete's hand: its object forgets it at once, nothing left armed (the go-live review, M5).
    if (stepAlarmOn(c.env)) await tellQuietly(c.env, cancelled.run, c.get("userId"), "forget");
    return c.json(cancelled);
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
