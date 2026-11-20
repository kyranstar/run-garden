/**
 * `/api/coach/runs` — the coach designer's runs (Stage 3 spec §2). The client creates a run, then steps it — one
 * model call a request — while its screen is open, reading the run's events as they land; the hourly cron looks after
 * runs nobody is stepping (services/coach-runs.ts).
 *
 * Inert until the owner turns it on: every path here is a plain 404 unless `COACH_DESIGNER = "1"` or this is staging,
 * signed in or not; then the session is checked. Mounted ahead of `/api/coach` in index.ts so the coach's own sign-in
 * never answers for these paths first.
 *
 *   POST /                  { scope?, request?, rehearsal?, focus?, conversationId?, savesBatchId?, nudge?, frame?, chip?,
 *                           clientId? } → { run, existing, conversationId }
 *                           `clientId` (R1.2; the lead's kit v0.21: restarting or reconnecting resumes the same designer run,
 *                           never another paid request): a phone's key for this ask, made once per ask — a UUID; 400
 *                           `bad_client_id` for anything else, or from the laptop's cookie. Looked up FIRST, before anything
 *                           is judged: the run its first create made answers again, 200 `{ run, existing: false,
 *                           conversationId, repeated: true }`, never a second run. Keyed by the account, the device and
 *                           the clientId (`deviceAskKey`, an audit row `coach.device_ask` with `{clientId, runId}`, never
 *                           the ask's words), written in the run's own batch: a create that started nothing (the week, a
 *                           refused frame, a live run in the way) wrote no key, so the same clientId may go again.
 *                           Creating spends nothing: the model runs only in a step.
 *                           (409 `week_budget` past the athlete's week; a rehearsal past the rehearsal lane's own,
 *                           409 `rehearsal_budget` { spentUsd, capUsd }: llm.ts DEV_BUDGET)
 *                           (the new shape §5: no conversationId, the current conversation — its newest ask under 18 hours
 *                           old — else a new one; null, a new one; a run's id, the conversation it is a turn of; 400
 *                           `bad_conversation` for one that can't be an id) (one live main run per athlete: a
 *                           second create answers the live run with `offer` and the `ignoredRequest` it did not start;
 *                           409 { error: "week_budget", spentUsd, cutoffUsd } when the week's spend and what a run of
 *                           the scope costs would pass the weekly cutoff, and no live run is there — Task 13's fix wave)
 *                           `focus: { kind, id }` (coach everywhere, A1; design-focus.ts): what the athlete asked from —
 *                           400 `bad_focus` when it isn't one; 404 `focus_not_found` when it isn't theirs or isn't there
 *                           (one statement; none for a day or a move); 400 { error: "focus_out_of_range" | "focus_is_set",
 *                           why } for a day past the run's horizon or a set's suggestion, in words. A suggestion's focus
 *                           with no scope takes the suggestion's own.
 *                           `savesBatchId` (the saves flow, §12.1: "Fit them in" sets it): the saved batch the run
 *                           fits — read with its skip set in one statement more, kept with the run and its designers;
 *                           400 `bad_saves_batch` when it isn't an id; 404 `saves_batch_not_found` when it isn't a saved
 *                           batch of the athlete's, and nothing starts.
 *                           `nudge` (where you stand, spec §7.2: a "needs you" drift chip's tap sets it): the chip's id
 *                           (where-you-stand.ts DRIFT_ID), kept as the run's `diagnose` — its opening context carries
 *                           the diagnose-first instruction; no statement; 400 `bad_nudge` for anything else.
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
import { CONVERSATION_ID } from "../services/coach-conversation.js";
import { DRIFT_ID } from "../services/where-you-stand.js";
import { FocusError, focusSchema } from "../services/design-focus.js";
import { dayFrameSchema, frameInReach, type DayFrame } from "../services/design-frame.js";
import { frameRefusal } from "../services/device-sharing.js";
import { readCoachOpening } from "../services/coach-nudges.js";
import type { Db } from "../services/db.js";
import { planDraftsOn } from "../services/plan-drafts.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { addDays, todayInZone } from "@rg/domain";
import { coachModelGate, deviceCoachGate } from "./coach-device-gate.js";
import { deviceCoachView } from "../services/device-view.js";
import {
  ANSWER_MAX_CHARS,
  REQUEST_MAX_CHARS,
  answerRun,
  cancelRun,
  createRun,
  currentRun,
  defaultRunDeps,
  deviceAskKey,
  DEVICE_ASK_KIND,
  getRun,
  keyedRun,
  LIVE_STATUSES,
  noteOnTrail,
  parseScopeRequest,
  RehearsalBudgetError,
  RunKeyTakenError,
  runStep,
  SavesBatchError,
  type CoachRunDto,
  type RunDeps,
  WeekBudgetError,
} from "../services/coach-runs.js";
import { handleRunId, isMemoryHandle, undoRecordedAnswers } from "../services/design-tools/record-answer.js";
import { undoRemembered } from "../services/design-tools/remember.js";

/** A condition check's id, at most (ids are the app's own: `newId`). */
const CHECK_ID_MAX_CHARS = 100;
/** A saves batch's id as a fit-in create names it (the app's own: `newId`). */
const SAVES_BATCH_ID = /^[A-Za-z0-9-]{1,100}$/;

/** A phone's key for one ask (R1.2): a UUID, as the phone makes one per ask — 36 characters, within the 100 the key takes. */
const CLIENT_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const CLIENT_ID_MAX_CHARS = 100;

/**
 * Every key a create's body may hold. A phone's are these but `rehearsal` and `savesBatchId` (device-scope.ts
 * `deviceRunCreateBody`, pinned against this list in native-allowlist.test.ts).
 */
export const RUN_CREATE_KEYS = ["scope", "request", "rehearsal", "focus", "conversationId", "savesBatchId", "nudge", "frame", "chip", "clientId"] as const;

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
const hintOf = (run: Pick<CoachRunDto, "status" | "scope"> & Partial<Pick<CoachRunDto, "estimateUsd">>): StepperHint => ({
  stepping: run.status === "stepping",
  // An auto run that planned a set (the new shape §5: its set's estimate is made at its first plan) has a set's lease.
  leaseMs: stepperLeaseMs(run.scope.kind === "auto" && typeof run.estimateUsd === "number" ? { kind: "week" } : run.scope),
});

/**
 * A client's word to its run's object (the step alarm): a read or an answer is here (`touch`), an answer asks for the
 * step it resumes (`arm`). A word that fails is logged and never the request's failure — the read answered — and the
 * client's next word, or its own arm, tells the object again.
 */
async function tellQuietly(env: Env, run: Pick<CoachRunDto, "id" | "status" | "scope"> & Partial<Pick<CoachRunDto, "estimateUsd">>, userId: string, op: StepperOp): Promise<void> {
  const runId = run.id;
  try {
    await tellStepper(env, runId, userId, op, hintOf(run));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "coach-runs: the run's stepper was not told", run: runId, op, error: e instanceof Error ? e.message : "unknown" }));
  }
}

/** The routes, over `deps` (the model, the opening context, the tools); tests pass scripted ones. */
/** A frame's refusal by kind, in the app's words (never a value it was sent). */
const FRAME_ISSUE_WORDS: Readonly<Record<string, string>> = {
  invalid_type: "not the kind of value the frame takes",
  invalid_enum_value: "not one of the frame's own values",
  invalid_literal: "not one of the frame's own values",
  invalid_string: "not in the frame's own form",
  unrecognized_keys: "a key the frame doesn't take",
  too_small: "fewer than the frame takes",
  too_big: "more than the frame takes",
  custom: "outside the frame's bounds",
};

/**
 * A chip the opening would offer now, by its id, with its words (a phone's run from a chip: review A MAJOR-1r — the phone
 * sends the id, never the words). Null when it is no longer offered. The read the opening screen makes, once.
 */
async function chipOffered(db: Db, userId: string, id: string, now: Date, drafts: boolean): Promise<{ id: string; request: string } | null> {
  const prefs = await loadPreferences(db, userId);
  // The opening offers one line at a time (the review, then the newest session): a chip of a later one is looked for past
  // the ones the screen has shown, as the screen's own `seen` asks for them.
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const read = await readCoachOpening(db, userId, prefs, todayInZone(prefs.timezone, now), now, seen, { drafts });
    const found = [...read.nudges, ...(read.opening?.chips ?? [])].find((c) => c.id === id);
    if (found) return { id: found.id, request: found.request };
    if (!read.opening) return null;
    seen.add(read.opening.id);
  }
  return null;
}

export function makeCoachRunRoutes(deps: () => RunDeps = defaultRunDeps): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  routes.use("*", async (c, next) => {
    if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  routes.use("*", requireUser);
  // R1: the QA account's phone has no coach (its switches are off only inside requireUser), and a phone's new run needs a
  // model it can reach.
  routes.use("*", deviceCoachGate);
  // R1 review A/MAJOR-1: a phone reads the coach as a structured projection — never a reading, a condition or the trail.
  routes.use("*", deviceCoachView);

  routes.post("/", coachModelGate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<Record<(typeof RUN_CREATE_KEYS)[number], unknown>> | null;
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
    // The conversation (the new shape §5): absent, the current one; null, a new one; a run's id, that one's.
    const conversationId = body.conversationId;
    if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId))) {
      return c.json({ error: "bad_conversation" }, 400);
    }
    // The batch a fit-in run fits (the saves flow, §12.1): absent, or a batch's id.
    const savesBatchId = body.savesBatchId;
    if (savesBatchId !== undefined && (typeof savesBatchId !== "string" || !SAVES_BATCH_ID.test(savesBatchId))) {
      return c.json({ error: "bad_saves_batch" }, 400);
    }
    // A drift chip's id (where you stand, §7.2): absent, or one.
    const nudge = body.nudge;
    if (nudge !== undefined && (typeof nudge !== "string" || !DRIFT_ID.test(nudge))) return c.json({ error: "bad_nudge" }, 400);
    const device = c.get("device");
    // A PHONE'S ASK, ONCE (R1.2; the lead's kit v0.21: "restarting or reconnecting should resume the same designer run,
    // never silently create another paid request"): the phone's key for this ask, from a phone only. Its run, if its first
    // create made one, answers again — looked up before the frame, the chip, the focus or the week is judged, so a resend
    // whose answer was lost is answered whatever changed since.
    const clientId = body.clientId;
    if (clientId !== undefined && (!device || typeof clientId !== "string" || clientId.length > CLIENT_ID_MAX_CHARS || !CLIENT_ID.test(clientId))) {
      return c.json({ error: "bad_client_id" }, 400);
    }
    const askKey = device && typeof clientId === "string" ? await deviceAskKey(c.get("userId"), device.id, clientId) : null;
    if (askKey) {
      const made = await keyedRun(c.get("db"), c.get("userId"), askKey);
      if (made) return c.json(made);
    }
    // THE DAY FRAME (R1, DESIGN-3 §3.3.2): its exact typed keys or 400, and only from a phone whose switch A is on under the
    // words the frame names, or 409 `sharing_off` — refused, never ignored, and nothing starts (CALLS C1).
    let frame: DayFrame | undefined;
    if (body.frame !== undefined) {
      const f = dayFrameSchema.safeParse(body.frame);
      // Where, in the app's own words — never what was sent (review A NIT 1: zod's own messages quote the value).
      if (!f.success) return c.json({ error: "bad_frame", issues: f.error.issues.map((i) => ({ path: i.path.join("."), message: FRAME_ISSUE_WORDS[i.code] ?? "not what the frame takes" })) }, 400);
      const today = todayInZone((await loadPreferences(c.get("db"), c.get("userId"))).timezone);
      if (!frameInReach(f.data, today, addDays)) return c.json({ error: "bad_frame", issues: [{ path: "days", message: "days from yesterday to a week ahead" }] }, 400);
      const refused = await frameRefusal(c.get("db"), c.get("userId"), device?.id, f.data.consent);
      if (refused) return c.json(refused, 409);
      frame = f.data;
    }
    // A CHIP FROM THE PHONE (review A MAJOR-1r): the phone sends the chip's id, never its words — its words (which may say a
    // pace or a reading) are the server's own, looked up again now among the chips it would offer; one no longer offered is
    // 409 `chip_gone`, and nothing starts. A drift chip diagnoses its drift, as the laptop's does.
    let chip: { id: string; request: string } | null = null;
    if (body.chip !== undefined) {
      if (!device || typeof body.chip !== "string") return c.json({ error: "bad_chip" }, 400);
      chip = await chipOffered(c.get("db"), c.get("userId"), body.chip, new Date(), planDraftsOn(c.env));
      if (!chip) return c.json({ error: "chip_gone", why: "That suggestion has changed: look at your coach again." }, 409);
    }
    try {
      const created = await createRun(
        c.get("db"),
        c.get("userId"),
        {
          ...asked,
          request: chip ? chip.request : ((body.request as string | null | undefined) ?? null),
          rehearsal: body.rehearsal === true,
          ...(focus?.success ? { focus: focus.data } : {}),
          ...(conversationId !== undefined ? { conversationId: conversationId as string | null } : {}),
          ...(savesBatchId !== undefined ? { savesBatchId: savesBatchId as string } : {}),
          ...(typeof nudge === "string" ? { diagnose: nudge } : chip && DRIFT_ID.test(chip.id) ? { diagnose: chip.id } : {}),
          // Who asked from where: the device that signed the request in — never a field of the body.
          ...(device ? { lifeos: { deviceId: device.id, ...(frame ? { frame } : {}), ...(chip ? { chip: chip.id } : {}) } } : {}),
          // Its key, written with the run in one batch (never without it); the ask a turn of its conversation as any other.
          ...(askKey ? { once: { key: askKey, kind: DEVICE_ASK_KIND, detail: { clientId }, conversation: "asked" as const } } : {}),
        },
        new Date(),
      );
      // A live run in the way: the same ask, sent twice at once, may have made it — then it is this ask's run, repeated.
      if (askKey && created.existing) {
        const made = await keyedRun(c.get("db"), c.get("userId"), askKey);
        if (made && made.run.id === created.run.id) return c.json(made);
      }
      return c.json(created);
    } catch (e) {
      // The key is written and no live run is in the way: another create had it first — its run, repeated. Its run gone
      // (an account deleted or restored meanwhile): 409, and the phone asks again under a new key.
      if (e instanceof RunKeyTakenError && askKey) {
        const made = await keyedRun(c.get("db"), c.get("userId"), askKey);
        return made ? c.json(made) : c.json({ error: "client_id_taken" }, 409);
      }
      // The week can't pay for it (Task 13's fix wave, §2.11): nothing started.
      if (e instanceof WeekBudgetError) return c.json({ error: "week_budget", spentUsd: e.spentUsd, cutoffUsd: e.cutoffUsd }, 409);
      // A rehearsal past the rehearsal lane's week (audit C1: rehearsals and replays together): nothing started.
      if (e instanceof RehearsalBudgetError) return c.json({ error: "rehearsal_budget", spentUsd: e.spentUsd, capUsd: e.capUsd }, 409);
      // Not the athlete's, or not one there (404); a day the run can't plan, or a set's suggestion (400, in words).
      if (e instanceof FocusError) {
        return e.code === "focus_not_found" ? c.json({ error: e.code }, 404) : c.json({ error: e.code, why: e.why ?? "" }, 400);
      }
      // Not a saved batch of the athlete's (§12.1): nothing started, and nothing says another account's exists.
      if (e instanceof SavesBatchError) return c.json({ error: "saves_batch_not_found" }, 404);
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
