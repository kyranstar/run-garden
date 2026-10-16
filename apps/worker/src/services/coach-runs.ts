import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { accountState, coachProposals, coachRunEvents, coachRuns, conditionChecks, llmUsage } from "@rg/database";
import { newId, todayInZone } from "@rg/domain";
import { isProfileId, profileById } from "@rg/exercise-library";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { clearOutOfCredits, OUT_OF_CREDITS_REASON, recordOutOfCredits } from "./ai-credits.js";
import { loadPreferences } from "./calendar-sync.js";
import { designContextBuilder } from "./design-context.js";
import { DESIGNER_CEILING_MICROS, MAX_TOOL_CALLS_PER_TURN, RUN_LIMITS, SET_REDO_ROUNDS } from "./design-limits.js";
import { NO_TOOL_LINE } from "./design-prompt.js";
import {
  designerStopLine,
  isSetScope,
  promoteSetWithWhatItHas,
  settleSet,
  supersedeOlderPlans,
  type KeyLine,
  type SetEstimate,
} from "./design-orchestrate.js";
import { LLM_BUDGET, llmBudgetStatus } from "./llm.js";
import {
  callMessages,
  designModel,
  messagesCostMicros,
  type Effort,
  type MessageParam,
  type MessagesRequest,
  type MessagesResult,
  type RequestBlock,
  type SystemBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./llm-messages.js";
import { COACH_RUN_LEFT_MINUTES, COACH_RUN_SET_WINDOW_HOURS, COACH_RUN_STEP_STALE_MINUTES } from "./cron-limits.js";
import {
  closeUnreviewed,
  PROMOTE_TRIES,
  promoteWithWhatItHas,
  resumeAfterReview,
  reviewPacket,
  STOPPED_NOTES,
  stoppedNote,
  toolRecords,
  unavailableWhy,
} from "./design-review.js";
import { allTools } from "./design-tools/index.js";
import { designProposalId } from "./design-tools/propose.js";
import { askedAnswerRows, insertAnswers } from "./design-tools/record-answer.js";
import {
  isToolErr,
  type DesignTool,
  type ReviewHooks,
  type ReviewOf,
  type RunScope,
  type RunScopeKind,
  type SetHooks,
  type SetRound,
  type ToolContext,
  type ToolErr,
  type ToolOk,
  type ToolRole,
} from "./design-tools/types.js";

/**
 * THE COACH DESIGNER'S RUNS AND THEIR STEP LOOP (Stage 3 spec §2; principles §6.11).
 *
 * A run (`coach_runs`) is one agent at work: the main agent, a workout's designer or its reviewer, the last two as
 * sub-runs under a parent. It advances one STEP per request, driven by the client while its screen is open (and by the
 * hourly cron for a run nobody is stepping), and everything it needs to resume lives in `state`:
 *
 *  1. The first step builds the opening context (`deps.buildContext`) and stores it: the system blocks, sent exactly
 *     as built (the builder marks its own breakpoint on its last stable block), and the header, sent as the opening
 *     user message. Built once, so every later call's prefix is byte-identical and cacheable. The loop adds one more
 *     breakpoint, on the newest message, moved each call — never more than four in all.
 *  2. A step with tool calls queued runs them, in order, and calls no model.
 *  3. Otherwise the step calls the model ONCE, then runs the tool calls it asked for, in order, while each next call's
 *     declared statement cost still fits the request's budget; the rest are queued for the next step. A turn's
 *     results go back to the model as one user message once every call of the turn has run.
 *
 * WHAT A STEP MAY SPEND (Workers Free: ≤ 45 D1 statements + fetches per request, the model call one fetch). The route
 * spends ROUTE_OVERHEAD before the step begins; the step's own reads and writes are fixed (PENDING_STEP_FIXED /
 * MODEL_STEP_FIXED, every one of them counted, including the ones reserved for rare paths); what is left is the tools'.
 * A tool declares its cost; a counting test pins every declaration and the worst case of every route.
 *
 * THE HISTORY IS APPEND-ONLY. What the model has been sent is never rewritten: rewriting an earlier turn invalidates
 * the prompt cache from there on, and Opus 5.5 can refuse (400) a history whose thinking turns were edited. Thinking
 * blocks go back exactly as they came. The history is bounded by design instead: a tool result above
 * TOOL_RESULT_MAX_BYTES is cut before it enters it (with a note saying how to page); each run has a step cap (model
 * calls, by role) and a state cap (STATE_MAX_BYTES). Near either, the run gets one last call, told it is the last; past
 * it, it stops with a plain event. A step whose results would push the stored state over the cap ends the run without
 * storing them. Sub-runs start with fresh histories of their own.
 *
 * ONE STEP AT A TIME. A step claims its run with a conditional update (`active` → `stepping`, stamped with the claim
 * time) and writes its outcome only while the claim is still its own: a cancel that lands meanwhile wins, and the
 * step adds its spend and nothing else. Its tools run only after a read that finds the claim still its own (after the
 * model call, or before a step of queued calls), and a finish makes its proposal pending in a statement guarded by the
 * same claim. A step that died (a killed invocation, a phone sent to the background mid-call) leaves the run
 * `stepping`; after COACH_RUN_STEP_STALE_MINUTES the next step takes the claim back itself (and so does the sweep),
 * counting the takeover: the third in a row with no step getting as far as its write fails the run (MAX_TAKEOVERS).
 * The stamp a step leaves is the end of the step.
 *
 * MONEY. Before every model call: the run's own ceiling (state), the step and state caps, then the weekly cap
 * (`llmBudgetStatus`, the one the whole app shares) as a hard ceiling — the call is made only when its worst case fits
 * under it. Every call is recorded in `llm_usage` by role (design_main | design_workout | design_review): a row is
 * written before the call at what a killed call could have cost — so a step killed mid-call is still counted — and set
 * to the real usage after it, or to what a broken-off answer had used, or to zero when nothing was billed. A 402
 * records the existing out-of-credits marker and fails the run with a plain event; a call that works clears it.
 *
 * A STOP PROPOSES WHAT WAS REVIEWED (fix wave 3A, A2). A main run that stops any way but the athlete's cancel — a
 * spending limit, its step or state cap, the AI account or service failing it, an internal error, its window closing —
 * proposes what had been reviewed (`promoteWithWhatItHas` / `promoteSetWithWhatItHas`, the finish's own guard), and its
 * lines say that it stopped and then what came of it: proposed, or nothing. A promote that loses its write to a verdict
 * landing meanwhile reads again and tries once more (round 2, A-M3); a set's reads its designers with its proposal, so
 * whoever finds the stop — a step, a create, the sweep — proposes the same (round 2, A-I1).
 *
 * HOW LONG A RUN STAYS OPEN. Its context is frozen at its first step, so a run has a window: for now or later today,
 * the athlete's local day it began on; for a set, COACH_RUN_SET_WINDOW_HOURS. A step, an answer or the sweep that
 * finds it past its window expires it with a plain event. Within the window the clock still moves: when the model is
 * called on a later local date, or more than CLOCK_LINE_AFTER_MINUTES after it was last told the time, the call's
 * newest message says the time now ("It is now Tuesday, 13 October 2026, 08:15.").
 *
 * NOBODY WATCHING. The hourly sweep never calls the model: it takes back dead claims, runs a left run's queued tool
 * calls, and expires runs past their window. The model is only ever called for a client that is stepping.
 *
 * THE TRAIL. Every step appends events (`coach_run_events`): one plain line each — what the coach said, each tool's
 * result in summary, a question, a stop — on the MAIN run's trail, so the run view reads one sequence. An event of a
 * sub-run carries `payload.by = { runId, role }`. Sequence numbers are taken inside the insert itself, so a cancel and
 * a step can never take the same one.
 *
 * UNTRUSTED TEXT. The athlete's request is stored as data and handed to the context builder, which places it in the
 * header (the opening user message) inside a marked block; the loop never puts it in a system block. An answer goes
 * back to the model as `{ text, untrusted }`. An answer to a question that declared a check-in is also kept as the
 * athlete's answer (record-answer.ts `askedAnswerRows`; never a rehearsal's), in one insert once the answer stands.
 *
 * REVIEW (design-review.ts; ruling 4). With `deps.review`, a draft propose_workout stores is reviewed by an independent
 * REVIEWER SUB-RUN before anything reaches the athlete: the call starts it (`ReviewHooks.start`: one insert, its state
 * fresh — its root's window, timezone, ceiling and rehearsal, the clock the run was last told, and the review packet
 * built from this run's tool results, never its reasoning) and the run pauses, `waiting_review`. The next steps advance
 * the reviewer (a parent waits for its live sub-runs); its `submit_review` is its finish. The reviewer is never offered
 * a finish of its own; a review that can't be read gets one repair, then the reviewer ends and the validator's view
 * stands. Once the reviewer is over, the designer's own next step resumes it — no model call — with the review as its
 * propose_workout call's result.
 *
 * SPEND ROLLS UP THE TREE. A run's ceiling holds its whole tree: before a model call, every run from the due one up to
 * the main run is checked against its own ceiling with the spend of everything under it, finished sub-runs included
 * (`loadTree` reads the main run's whole tree). A money stop — a ceiling, the weekly cap, the account out of credits, no
 * key — stops the whole live tree with one line; a ceiling stops the tree under the run whose ceiling it is (the
 * highest reached), so a set's designer that reaches its own stops alone and the set goes on. The run's cost
 * (`CoachRunDto.costUsd`) is the tree's.
 *
 * A SET (design-orchestrate.ts; Task 7). For a week or the next N, the main run's plan_set starts one DESIGNER SUB-RUN
 * per brief (`SetHooks.start`: one insert — its brief, a workout's ceiling, the main run's scope, window, timezone,
 * rehearsal and last-told clock) and the main run pauses, `waiting_set`. The designers run one at a time in brief
 * order, each with its reviewers before the next. Once every designer is over, the main run's own next step resumes it
 * — no model call — with the set's outcome as plan_set's result (`settleSet`). A designer's finish line is kept in its
 * state (`final`), for that outcome. A set's main run that stops proposes what was reviewed
 * (`promoteSetWithWhatItHas`), naming the days whose designers got no draft in.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────

export type RunStatus =
  | "active"
  | "stepping"
  | "waiting_athlete"
  /** Its draft is with the reviewer sub-run it started; it resumes once that run is over. */
  | "waiting_review"
  /** A main run whose set's designers (plan_set) are at work; it resumes once every one of them is over. */
  | "waiting_set"
  | "finished"
  | "failed"
  | "cancelled"
  | "expired"
  | "stopped_cap";

/** A run still in play: it holds the athlete's one live main run. */
export const LIVE_STATUSES = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"] as const satisfies readonly RunStatus[];
const isLive = (status: string): boolean => (LIVE_STATUSES as readonly string[]).includes(status);
/** A live run nobody else holds and no answer is awaited for, that a step may claim (a waiting_review or waiting_set run
 * is due only once its reviewer, or every designer of its set, is over: `dueRun` never returns a run with a live
 * sub-run). */
const CLAIMABLE = ["active", "waiting_review", "waiting_set"] as const satisfies readonly RunStatus[];
/** The live statuses a guarded stop or expiry takes at once (a `stepping` run only once its claim is stale). */
const RESTING = ["active", "waiting_athlete", "waiting_review", "waiting_set"] as const satisfies readonly RunStatus[];
const steppable = (status: string): boolean => (CLAIMABLE as readonly string[]).includes(status);

export type RunEventKind = "tool_call" | "tool_result" | "draft" | "review" | "revision" | "question" | "note" | "error";

const SCOPE_KINDS: readonly RunScopeKind[] = ["now", "later_today", "week", "next_n"];
const ROLES: readonly ToolRole[] = ["main", "designer", "reviewer"];

/** A run's limits by role — model calls (the step cap), effort, output ceiling — defined in design-limits.ts, which the
 * prompt and the opening context read without importing the loop (fix wave 3A round 2, B-M9). */
export { RUN_LIMITS };

/** A run's own spending ceiling, by scope (spec §2): $1.50 for now / later today, $6 for a set. */
export const RUN_CEILING_MICROS: Readonly<Record<RunScopeKind, number>> = {
  now: 1_500_000,
  later_today: 1_500_000,
  week: 6_000_000,
  next_n: 6_000_000,
};

const USAGE_KIND: Readonly<Record<ToolRole, string>> = {
  main: "design_main",
  designer: "design_workout",
  reviewer: "design_review",
};

// ── The budget ──────────────────────────────────────────────────────────

export const STEP_BUDGET = 45;
/** What `requireUser` spends before a step begins: the session read and the restore marker. */
export const ROUTE_OVERHEAD = 2;
/** Every step: the tree read, the claim, the events insert, the run write. */
const BASE_FIXED = 4;
/** Reserved: the spend added to a run whose claim a cancel took (the run write then matched nothing). */
const LOST_CLAIM_WRITE = 1;
/** Reserved: the proposal's one write when its run finishes — a rehearsal's marked, or a reviewed one made pending. (The
 * older plans' days a pending one covers, superseded after it, are on finish's own declared cost.) */
const FINISH_WRITE = 1;
/** Reserved: a main run that stops — any way but a cancel, even after its tools ran (its state grew past the cap) —
 * proposes what was reviewed (fix wave 3A, A2): the proposal read and its write — read and written once more when the
 * write lost to a verdict landing between the two (round 2, A-M3: design-review.ts PROMOTE_TRIES) — and the older
 * plans' days it covers superseded. */
const STOP_PROPOSE = 2 * PROMOTE_TRIES + 1;
/** What a step's end may spend beyond its own writes: a finish's proposal write and a lost claim's spend can land in
 * one step (a cancel taking the claim while the tools ran), while a stop that proposes never meets either — it is
 * written under the claim it holds, and finishes nothing — so the larger of the two is reserved. */
const END_RESERVE = Math.max(LOST_CLAIM_WRITE + FINISH_WRITE, STOP_PROPOSE);
/** The standing read before a step's tools run — the restore marker and whether the claim is still the step's, in one
 * statement (fix wave 3A, A11): after the model call in a model step, before the queued calls in a step of them. */
const STANDING_READ = 1;
export const PENDING_STEP_FIXED = BASE_FIXED + END_RESERVE + STANDING_READ;
/** + the weekly-cap read, the usage row before the call, the model call, the credits marker, the usage row's update
 * after it. */
export const MODEL_STEP_FIXED = PENDING_STEP_FIXED + 5;
/** The most one tool may declare: what a step of queued calls has room for. A tool above it is a registry bug, and
 * its call is answered with an error rather than queued forever. */
export const MAX_TOOL_STATEMENT_COST = STEP_BUDGET - ROUTE_OVERHEAD - PENDING_STEP_FIXED;
/** What the opening context may spend (Task 3's `buildDesignContext` is pinned against it). */
export const CONTEXT_STATEMENT_BUDGET = STEP_BUDGET - ROUTE_OVERHEAD - BASE_FIXED - LOST_CLAIM_WRITE;

/** Tool calls run in one step at most (CPU; and it keeps a step's events to one insert). */
export const MAX_TOOL_CALLS_PER_STEP = 8;
/** Tool calls one turn may ask for (design-limits.ts, which the prompt states too); past this each gets an error
 * result and nothing runs. */
export { MAX_TOOL_CALLS_PER_TURN };
/** Consecutive transient failures before the run fails. */
export const MAX_RETRIES = 3;
const RETRY_BACKOFF_SECONDS = 10;

// ── The history's bounds ────────────────────────────────────────────────

/** One tool result as the model sees it, at most. Tools are compact by contract; this is the backstop. */
export const TOOL_RESULT_MAX_BYTES = 8_000;
/** The whole stored state, at most (D1 allows a 2 MB row; this keeps every step's read and write small). */
export const STATE_MAX_BYTES = 200_000;
/** Past this, the next model call is the run's last. */
export const STATE_LAST_CALL_BYTES = 150_000;
/** One answer (the assistant turn) at most; a bigger one is not stored and ends the run. */
export const ANSWER_MAX_BYTES = 64_000;
/** One event's payload at most, and one summary line. */
const EVENT_PAYLOAD_MAX_CHARS = 4_000;
const SUMMARY_MAX_CHARS = 300;
/** Events one insert writes (5 + 3 bound values each: 65 of D1's 100). A step makes at most MAX_TOOL_CALLS_PER_STEP
 * tool events plus four more (the model's words, a control or stop line, a cap, the clock), so always one insert. */
export const EVENTS_PER_INSERT = 20;

/** The model is told the time again when it was last told more than this long ago (or on another local date). */
export const CLOCK_LINE_AFTER_MINUTES = 30;

/** Bytes of a prompt per token, for the estimates made before a call: JSON tokenises densely, at about 3.5. */
export const PROMPT_BYTES_PER_TOKEN = 3.5;

const EPHEMERAL = { type: "ephemeral" } as const;
const MAX_BREAKPOINTS = 4;

// ── State ───────────────────────────────────────────────────────────────

/** How long a run stays open (cron-limits.ts): through a local day, or until an instant. */
export type RunWindow = { kind: "day"; date: string } | { kind: "until"; at: string };

export interface RunSettings {
  ceilingMicros: number;
  /** The step cap: model calls this run may make. */
  maxCalls: number;
  effort: Effort;
  maxTokens: number;
  rehearsal: boolean;
  /** The athlete's timezone when the run began: its window's day and the clock line are in it. */
  timezone?: string;
  /** Absent (a run made without one): COACH_RUN_SET_WINDOW_HOURS from when the run began. */
  window?: RunWindow;
}

export interface PendingCall {
  id: string;
  name: string;
  input: unknown;
  /** Past MAX_TOOL_CALLS_PER_TURN: answered with an error, never run. */
  overflow?: boolean;
}

export interface RunState {
  v: 1;
  settings: RunSettings;
  /** A sub-run's brief from the run that started it (the orchestration sets it); its opening context carries it. */
  brief?: string;
  /** The opening system blocks, built on the first step; null until then. */
  system: SystemBlock[] | null;
  /** The model's history: append-only. */
  messages: MessageParam[];
  /** Calls the model asked for that have not run yet, in its order. */
  pending: PendingCall[];
  /** This turn's results so far; sent as one user message once `pending` is empty. */
  results: ToolResultBlock[];
  /** The ask call waiting on the athlete. */
  awaiting: string | null;
  /** Model calls made. */
  calls: number;
  /** Consecutive transient failures. */
  retries: number;
  /** Set once the last call allowed has been made: which cap it was. */
  lastCall: "step_cap" | "state_cap" | null;
  /** When the model was last told the time: the opening context's build, or the last clock line. */
  toldAt: string | null;
  /** What `awaiting` waits on: the athlete's answer (absent), the review of the draft that call proposed, or the
   * designers of the set that call (plan_set) started. */
  awaitingKind?: "review" | "set";
  /** An ask for today's condition check (fix wave 3A, A8): answered by a check the athlete logs, saved today at or after
   * `since` (when it was asked). */
  awaitingCheck?: { since: string };
  /** The review awaited: the proposal the draft is in, and the reviewer sub-run reviewing it. */
  awaitingReview?: { proposalId: string; reviewRunId: string; round: number };
  /** Where the awaited review's result goes among this turn's results: the calls before it ran, the ones after it were
   * answered "not run" at the pause, and the turn's results keep the model's order. */
  awaitingAt?: number;
  /** A reviewer's repairs used: a review that couldn't be read, or an answer with no review (one is allowed). */
  repairs?: number;
  /** A main run's or designer's turns in a row that called no tool (fix wave 3A, A3): the first is nudged, the second
   * ends the run as a finish. A turn with a tool call clears it. */
  textOnly?: number;
  /** Times a dead step's claim on this run was taken back since a step last wrote its state (fix wave 3A, A14):
   * counted in the claim itself (or the sweep's), cleared by any step that gets as far as writing. */
  takeovers?: number;
  /** A reviewer's packet (design-review.ts), until its opening context is built from it. */
  packet?: string;
  /** A reviewer's draft: what its submit_review stores the review against. */
  reviewOf?: ReviewOf;
  /** A main run's set: each plan_set call's briefs and the designers it started, in order (design-orchestrate.ts). */
  set?: { rounds: SetRound[]; keyLines?: KeyLine[] };
  /** A main run's set: its estimated cost, from its first plan (the run view shows it). */
  estimate?: SetEstimate;
  /** A designer's finish line, its own words: its set's outcome quotes it when its workout is left out. */
  final?: string;
  /** A set's designer: the day of its brief — what a stop names when the designer got no draft in (read in SQL). */
  day?: string;
  /** A set's redo designer: the designer whose workout its replaces once reviewed (ToolContext.replaces). */
  replaces?: string;
}

/** A fresh state for a run of `role` (sub-runs start here too: a history of their own, the parent's window). */
export function newRunState(
  role: ToolRole,
  scope: RunScope,
  opts: {
    rehearsal?: boolean;
    ceilingMicros?: number;
    brief?: string;
    timezone?: string;
    window?: RunWindow;
    /** A sub-run: the clock its parent was last told (its own context tells it again when built). */
    toldAt?: string | null;
    packet?: string;
    reviewOf?: ReviewOf;
  } = {},
): RunState {
  const limits = RUN_LIMITS[role];
  return {
    v: 1,
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(opts.packet ? { packet: opts.packet } : {}),
    ...(opts.reviewOf ? { reviewOf: opts.reviewOf } : {}),
    settings: {
      ceilingMicros: opts.ceilingMicros ?? RUN_CEILING_MICROS[scope.kind],
      maxCalls: limits.maxCalls,
      effort: limits.effort,
      maxTokens: limits.maxTokens,
      rehearsal: opts.rehearsal === true,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
      ...(opts.window ? { window: opts.window } : {}),
    },
    system: null,
    messages: [],
    pending: [],
    results: [],
    awaiting: null,
    calls: 0,
    retries: 0,
    lastCall: null,
    toldAt: opts.toldAt ?? null,
  };
}

/** A new main run's window: the athlete's local day for now / later today, a day from `now` for a set. A timezone
 * that can't be read counts as UTC. */
export function runWindow(scope: RunScope, timezone: string, now: Date): RunWindow {
  return scope.kind === "now" || scope.kind === "later_today"
    ? { kind: "day", date: localDate(timezone, now) }
    : { kind: "until", at: new Date(now.getTime() + COACH_RUN_SET_WINDOW_HOURS * 3_600_000).toISOString() };
}

/** Has the run's window closed at `now`? A run made without one stays open COACH_RUN_SET_WINDOW_HOURS from its start.
 * Never throws: a timezone that can't be read counts as UTC, so a bad stored value can't leave a run stuck. */
export function windowClosed(settings: RunSettings | undefined, createdAt: string, now: Date): boolean {
  const w = settings?.window;
  if (w?.kind === "day") return localDate(settings?.timezone || "UTC", now) > w.date;
  const until = w?.kind === "until" ? Date.parse(w.at) : Date.parse(createdAt) + COACH_RUN_SET_WINDOW_HOURS * 3_600_000;
  return now.getTime() >= until;
}

/** The stored state, or null when it cannot be read (the run then fails plainly rather than looping). */
export function readRunState(text: string | null): RunState | null {
  if (!text) return null;
  let s: Partial<RunState>;
  try {
    s = JSON.parse(text) as Partial<RunState>;
  } catch {
    return null;
  }
  const ok =
    !!s &&
    typeof s === "object" &&
    s.v === 1 &&
    !!s.settings &&
    typeof s.settings.ceilingMicros === "number" &&
    typeof s.settings.maxCalls === "number" &&
    (s.system === null || s.system === undefined || Array.isArray(s.system)) &&
    Array.isArray(s.messages);
  if (!ok) return null;
  return {
    v: 1,
    settings: s.settings!,
    ...(typeof s.brief === "string" ? { brief: s.brief } : {}),
    system: s.system ?? null,
    messages: s.messages!,
    pending: Array.isArray(s.pending) ? s.pending : [],
    results: Array.isArray(s.results) ? s.results : [],
    awaiting: typeof s.awaiting === "string" ? s.awaiting : null,
    calls: typeof s.calls === "number" ? s.calls : 0,
    retries: typeof s.retries === "number" ? s.retries : 0,
    lastCall: s.lastCall === "step_cap" || s.lastCall === "state_cap" ? s.lastCall : null,
    toldAt: typeof s.toldAt === "string" ? s.toldAt : null,
    ...(s.awaitingKind === "review" || s.awaitingKind === "set" ? { awaitingKind: s.awaitingKind } : {}),
    ...(s.awaitingCheck && typeof s.awaitingCheck.since === "string" ? { awaitingCheck: { since: s.awaitingCheck.since } } : {}),
    ...(s.awaitingReview && typeof s.awaitingReview === "object" ? { awaitingReview: s.awaitingReview } : {}),
    ...(typeof s.awaitingAt === "number" ? { awaitingAt: s.awaitingAt } : {}),
    ...(typeof s.repairs === "number" ? { repairs: s.repairs } : {}),
    ...(typeof s.textOnly === "number" ? { textOnly: s.textOnly } : {}),
    ...(typeof s.takeovers === "number" ? { takeovers: s.takeovers } : {}),
    ...(typeof s.packet === "string" ? { packet: s.packet } : {}),
    ...(s.reviewOf && typeof s.reviewOf === "object" ? { reviewOf: s.reviewOf } : {}),
    ...(s.set && typeof s.set === "object" && Array.isArray(s.set.rounds)
      ? { set: { rounds: s.set.rounds, ...(Array.isArray(s.set.keyLines) ? { keyLines: s.set.keyLines } : {}) } }
      : {}),
    ...(typeof s.replaces === "string" ? { replaces: s.replaces } : {}),
    ...(typeof s.day === "string" ? { day: s.day } : {}),
    ...(s.estimate && typeof s.estimate === "object" ? { estimate: s.estimate } : {}),
    // (`final` is written once, at a designer's finish, and read in SQL: never read back here.)
  };
}

export function parseRunScope(raw: unknown): RunScope | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, n } = raw as { kind?: unknown; n?: unknown };
  if (typeof kind !== "string" || !(SCOPE_KINDS as readonly string[]).includes(kind)) return null;
  if (kind !== "next_n") return { kind: kind as RunScopeKind };
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 14 ? { kind: "next_n", n: n as number } : null;
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

// ── Dependencies ────────────────────────────────────────────────────────

/** What the opening context is built from: the run as it is stored, never anything this run's model wrote. `brief`
 * is a sub-run's brief, written by the run that started it — model-written text, which the context marks as
 * untrusted data like the athlete's own words. */
export interface ContextRun {
  id: string;
  role: ToolRole;
  scope: RunScope;
  request: string | null;
  parentId: string | null;
  brief?: string;
  /** A reviewer's packet: composed by the app (design-review.ts), its outside texts already marked. */
  packet?: string;
}

/**
 * The opening context (Task 3's `designContextBuilder`): system blocks, sent as the system exactly as built (the
 * builder marks its own cache breakpoint on its last stable block), and a header, sent as the run's first user
 * message, never in the system. `statementCost` is the most one build runs (≤ CONTEXT_STATEMENT_BUDGET).
 */
export interface ContextBuilder {
  statementCost: number;
  build(db: Db, env: Env, userId: string, run: ContextRun, now: Date): Promise<{ system: SystemBlock[]; header: string }>;
}

export interface RunDeps {
  callModel: (env: Env, req: MessagesRequest) => Promise<MessagesResult>;
  buildContext: ContextBuilder;
  tools: DesignTool[];
  /**
   * Drafts are reviewed by an independent reviewer sub-run before the athlete sees them (design-review.ts): the
   * default deps always. Off — the act tools' own tests — a draft is stored unreviewed, and so never becomes pending.
   */
  review?: boolean;
  /** Milliseconds, for how long a step took (its stamp is its `now` plus that). Default: the real clock. */
  clock?: () => number;
}

export function defaultRunDeps(): RunDeps {
  return { callModel: (env, req) => callMessages(env, req), buildContext: designContextBuilder, tools: allTools(), review: true };
}

// ── Runs as rows ────────────────────────────────────────────────────────

interface RunNode {
  id: string;
  parentId: string | null;
  role: ToolRole;
  scope: RunScope;
  request: string | null;
  status: RunStatus;
  steps: number;
  costUsd: number;
  proposalId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** From the state, read in SQL: its window and timezone (a run's tree is open while its main run's window is). */
  settings?: RunSettings;
  /** From the state, read in SQL: a designer's finish line (`RunState.final`). (A set's designers' days and redos are
   * read by the promote that needs them, with its proposal — design-orchestrate.ts `readSetProposal` — never from a
   * tree a caller holds: round 2, A-I1.) */
  final?: string | null;
  /** From the state, read in SQL: when an ask for today's condition check was put (`RunState.awaitingCheck`). */
  checkSince?: string | null;
  /** From the state, read in SQL: a set's estimated cost in micros, once its first plan made one (`RunState.estimate`). */
  estimateMicros?: number | null;
}

/** Everything but `state`, and from the state only its settings (read in SQL, so a large state is never read whole;
 * a state that is not JSON reads as none). */
const NODE_COLUMNS = {
  settings: sql<string | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_extract(${coachRuns.state}, '$.settings') END`,
  final: sql<string | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_extract(${coachRuns.state}, '$.final') END`,
  checkSince: sql<string | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_extract(${coachRuns.state}, '$.awaitingCheck.since') END`,
  estimateMicros: sql<number | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_extract(${coachRuns.state}, '$.estimate.micros') END`,
  id: coachRuns.id,
  parentId: coachRuns.parentId,
  role: coachRuns.role,
  scope: coachRuns.scope,
  request: coachRuns.request,
  status: coachRuns.status,
  steps: coachRuns.steps,
  costUsd: coachRuns.costUsd,
  proposalId: coachRuns.proposalId,
  error: coachRuns.error,
  createdAt: coachRuns.createdAt,
  updatedAt: coachRuns.updatedAt,
  finishedAt: coachRuns.finishedAt,
};

type NodeRow = { [K in keyof typeof NODE_COLUMNS]: unknown };

function toNode(r: NodeRow): RunNode {
  return {
    id: r.id as string,
    parentId: (r.parentId as string | null) ?? null,
    role: (ROLES as readonly string[]).includes(r.role as string) ? (r.role as ToolRole) : "main",
    scope: parseRunScope(r.scope) ?? { kind: "now" },
    request: (r.request as string | null) ?? null,
    status: r.status as RunStatus,
    steps: Number(r.steps ?? 0),
    costUsd: Number(r.costUsd ?? 0),
    proposalId: (r.proposalId as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
    finishedAt: (r.finishedAt as string | null) ?? null,
    settings: parseSettings((r.settings as string | null) ?? null),
    final: typeof r.final === "string" ? r.final : null,
    checkSince: typeof r.checkSince === "string" ? r.checkSince : null,
    estimateMicros: typeof r.estimateMicros === "number" && Number.isFinite(r.estimateMicros) ? r.estimateMicros : null,
  };
}

/** How deep a run's tree is read (main → designer → reviewer is two). */
const TREE_DEPTH_MAX = 8;

/** The ids of the run `rootId` and every run under it, finished or not (a subquery). */
const treeIds = (userId: string, rootId: string) => sql`(
  WITH RECURSIVE tree(id, depth) AS (
    SELECT id, 0 FROM coach_runs WHERE id = ${rootId} AND user_id = ${userId}
    UNION
    SELECT c.id, t.depth + 1 FROM coach_runs c JOIN tree t ON c.parent_id = t.id WHERE c.user_id = ${userId} AND t.depth < ${TREE_DEPTH_MAX}
  ) SELECT id FROM tree)`;

/** The main run `rootId` (never a sub-run: the routes address main runs) with its whole tree — finished sub-runs too,
 * whose spend counts toward the ceilings — and every live run of the athlete. One statement. */
async function loadTree(db: Db, userId: string, rootId: string): Promise<{ root: RunNode | null; nodes: RunNode[] }> {
  const rows = await db
    .select(NODE_COLUMNS)
    .from(coachRuns)
    .where(and(eq(coachRuns.userId, userId), or(inArray(coachRuns.id, treeIds(userId, rootId)), inArray(coachRuns.status, [...LIVE_STATUSES]))));
  const nodes = rows.map((r) => toNode(r as NodeRow));
  const root = nodes.find((n) => n.id === rootId && n.parentId === null) ?? null;
  return { root, nodes };
}

const byCreated = (a: RunNode, b: RunNode) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The run the next step advances: the first live run, depth first, that has no live run under it. A parent with live
 * sub-runs waits for them (the orchestration's designers and reviewers run before the run that started them goes on).
 */
function dueRun(nodes: RunNode[], root: RunNode): RunNode | null {
  const walk = (n: RunNode, depth: number): RunNode | null => {
    if (depth > 8) return null;
    for (const kid of nodes.filter((k) => k.parentId === n.id && isLive(k.status)).sort(byCreated)) {
      const d = walk(kid, depth + 1);
      if (d) return d;
    }
    return isLive(n.status) ? n : null;
  };
  return walk(root, 0);
}

/** The run's status as the athlete sees it: a finished main run's own, else what its due run is doing (a run waiting
 * on a review, or on its set, that is over is about to go on: active). */
function treeStatus(root: RunNode, nodes: RunNode[]): RunStatus {
  if (!isLive(root.status)) return root.status;
  const status = dueRun(nodes, root)?.status ?? root.status;
  return status === "waiting_review" || status === "waiting_set" ? "active" : status;
}

function subtree(nodes: RunNode[], root: RunNode): RunNode[] {
  const out = [root];
  for (let i = 0; i < out.length && i < 64; i++) out.push(...nodes.filter((n) => n.parentId === out[i]!.id));
  return out;
}

/** What a run and everything under it have spent, in micros. */
const treeSpendMicros = (nodes: RunNode[], top: RunNode): number =>
  subtree(nodes, top).reduce((sum, n) => sum + Math.round(n.costUsd * 1_000_000), 0);

/** The run and its parents up to the main run, nearest first. */
function lineage(nodes: RunNode[], run: RunNode): RunNode[] {
  const out = [run];
  for (let i = 0; i < 16; i++) {
    const parent = nodes.find((n) => n.id === out.at(-1)!.parentId);
    if (!parent) break;
    out.push(parent);
  }
  return out;
}

/** The highest ceiling the run's spend reaches — its own, or a parent's with everything under that parent — and whose
 * it is; or null. The highest, so the stop reaches as far as the limit does: a designer's own stops its tree alone, the
 * main run's stops the set. */
function ceilingReached(nodes: RunNode[], run: RunNode, own: RunSettings): { ceiling: number; of: RunNode } | null {
  let reached: { ceiling: number; of: RunNode } | null = null;
  for (const n of lineage(nodes, run)) {
    const ceiling = n === run ? own.ceilingMicros : n.settings?.ceilingMicros;
    if (typeof ceiling === "number" && treeSpendMicros(nodes, n) >= ceiling) reached = { ceiling, of: n };
  }
  return reached;
}

// ── DTOs ────────────────────────────────────────────────────────────────

export interface CoachRunDto {
  id: string;
  role: ToolRole;
  scope: RunScope;
  /** The athlete's words. */
  request: string | null;
  /** What the run is doing now: a finished run's end, or its due run's status (a sub-run waiting on the athlete makes
   * the whole run `waiting_athlete`). */
  status: RunStatus;
  steps: number;
  costUsd: number;
  proposalId: string | null;
  /** Why it stopped, as a code: weekly_cap | run_ceiling | step_cap | state_cap | gateway_402 | no_key | retries |
   * refusal | expired | bad_state | internal, or the gateway's reason for a rejected call. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** A set's estimated cost in dollars, once its first plan made one (Task 7, `RunState.estimate`): null before it, and
   * for a run for now or later today. The run view shows it beside the ceiling (Task 9). */
  estimateUsd: number | null;
  /** The run's own spending ceiling in dollars (`RunSettings.ceilingMicros`); null when its state can't be read. */
  ceilingUsd: number | null;
}

export interface CoachRunEventDto {
  seq: number;
  kind: RunEventKind;
  summary: string;
  payload: unknown;
  at: string;
}

export interface StepResult {
  status: RunStatus;
  /** The run the next step advances, and when (later than now after a transient failure); null when there is
   * nothing to step: finished, stopped, or waiting on the athlete. */
  nextDue: { runId: string; role: ToolRole; at: string } | null;
  events: CoachRunEventDto[];
}

export type StepOutcome =
  | { kind: "ok"; result: StepResult }
  /** Another step holds the run. */
  | { kind: "busy" }
  | { kind: "not_found" }
  /** A restore began during the model call: nothing was written. */
  | { kind: "restoring" };

function runDto(root: RunNode, nodes: RunNode[]): CoachRunDto {
  return {
    id: root.id,
    role: root.role,
    scope: root.scope,
    request: root.request,
    status: treeStatus(root, nodes),
    steps: root.steps,
    costUsd: treeSpendMicros(nodes, root) / 1_000_000,
    proposalId: root.proposalId,
    error: root.error,
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
    finishedAt: root.finishedAt,
    estimateUsd: typeof root.estimateMicros === "number" ? root.estimateMicros / 1_000_000 : null,
    ceilingUsd: typeof root.settings?.ceilingMicros === "number" ? root.settings.ceilingMicros / 1_000_000 : null,
  };
}

// ── Events ──────────────────────────────────────────────────────────────

interface NewEvent {
  kind: RunEventKind;
  summary: string;
  payload?: unknown;
}

const line = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…` : flat;
};

function bounded(value: unknown, max = EVENT_PAYLOAD_MAX_CHARS): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value) ?? "null";
  return text.length <= max ? value : { truncated: true, head: text.slice(0, max) };
}

/**
 * Append `events` to the main run's trail in one statement (a chunk per EVENTS_PER_INSERT; a step makes far fewer).
 * The sequence number is taken inside the insert, from the trail's own highest, so two writers never share one.
 */
async function appendEvents(db: Db, userId: string, rootId: string, events: NewEvent[], at: string): Promise<CoachRunEventDto[]> {
  const out: CoachRunEventDto[] = [];
  for (let i = 0; i < events.length; i += EVENTS_PER_INSERT) {
    const chunk = events.slice(i, i + EVENTS_PER_INSERT);
    const values = chunk.map(
      (e, j) =>
        sql`(${sql.raw(String(j + 1))}, ${e.kind}, ${line(e.summary) || "…"}, ${e.payload === undefined ? null : JSON.stringify(bounded(e.payload))})`,
    );
    const rows = (await db.all(sql`
      INSERT INTO coach_run_events (id, user_id, run_id, seq, kind, summary, payload, at)
      SELECT ${rootId} || ':' || (b.base + v.column1), ${userId}, ${rootId}, b.base + v.column1, v.column2, v.column3, v.column4, ${at}
      FROM (SELECT COALESCE(MAX(seq), 0) AS base FROM coach_run_events WHERE run_id = ${rootId}) AS b,
           (VALUES ${sql.join(values, sql`, `)}) AS v
      RETURNING seq, kind, summary, payload, at
    `)) as Array<{ seq: number; kind: RunEventKind; summary: string; payload: string | null; at: string }>;
    for (const r of rows.sort((a, b) => a.seq - b.seq)) out.push({ ...r, seq: Number(r.seq), payload: parsePayload(r.payload) });
  }
  return out;
}

/**
 * One plain line on a main run's trail from outside a step — what the athlete did from the run view (an answer taken
 * back). The caller has established the run is the athlete's. One statement.
 */
export async function noteOnTrail(db: Db, userId: string, rootId: string, summary: string, payload: unknown, now: Date): Promise<void> {
  await appendEvents(db, userId, rootId, [{ kind: "note", summary, ...(payload === undefined ? {} : { payload }) }], now.toISOString());
}

function parsePayload(text: string | null): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Creating and reading runs ───────────────────────────────────────────

export interface CreateRunInput {
  scope: RunScope;
  request?: string | null;
  rehearsal?: boolean;
}

export const REQUEST_MAX_CHARS = 2_000;

export type CreateRunResult =
  | { run: CoachRunDto; existing: false }
  | {
      /** The athlete's live run, as it is: nothing about it changed. */
      run: CoachRunDto;
      existing: true;
      /** What the screen can offer: answer the live run's question, or go on with it — or cancel it either way. */
      offer: "answer_or_cancel" | "continue_or_cancel";
      /** What this request asked for, not started: the screen can offer to start it once the live run is cancelled. */
      ignoredRequest: { scope: RunScope; request: string | null };
    };

/**
 * A new main run, unless the athlete already has a live one: then that one comes back (`existing: true`), with what
 * the screen can offer and the words this request carried, so they never vanish silently. One statement decides it
 * (an insert guarded by NOT EXISTS), so two taps can never start two. A rehearsal is in a lane of its own: it never
 * holds, nor is offered as, the athlete's one live run, nor theirs it. The run's window and timezone are fixed here.
 * A live run whose window has closed is not offered: it is expired, with its plain line, and the new run starts.
 */
export async function createRun(db: Db, userId: string, input: CreateRunInput, now: Date): Promise<CreateRunResult> {
  const at = now.toISOString();
  // A rehearsal (the live scenario suite) is never the athlete's one live main run, nor offered as it (fix wave 3A,
  // A15): rehearsals and the athlete's own runs each have their one live main run.
  const rehearsal = input.rehearsal === true;
  const request = input.request?.trim().slice(0, REQUEST_MAX_CHARS) || null;
  const timezone = (await loadPreferences(db, userId)).timezone;
  const state = newRunState("main", input.scope, {
    rehearsal,
    timezone,
    window: runWindow(input.scope, timezone, now),
  });
  const insert = async (): Promise<CreateRunResult | null> => {
    const id = newId();
    const inserted = (await db.all(sql`
      INSERT INTO coach_runs (id, user_id, parent_id, role, scope, request, status, state, steps, cost_usd, created_at, updated_at)
      SELECT ${id}, ${userId}, NULL, 'main', ${JSON.stringify(input.scope)}, ${request}, 'active', ${JSON.stringify(state)}, 0, 0, ${at}, ${at}
      WHERE NOT EXISTS (
        SELECT 1 FROM coach_runs WHERE user_id = ${userId} AND parent_id IS NULL AND status IN ('active', 'stepping', 'waiting_athlete', 'waiting_review', 'waiting_set')
          AND coalesce(CASE WHEN json_valid(state) THEN json_extract(state, '$.settings.rehearsal') END, 0) = ${rehearsal ? 1 : 0}
      )
      RETURNING id
    `)) as Array<{ id: string }>;
    if (inserted.length === 0) return null;
    const node: RunNode = {
      id,
      parentId: null,
      role: "main",
      scope: input.scope,
      request,
      status: "active",
      steps: 0,
      costUsd: 0,
      proposalId: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      settings: state.settings,
    };
    return { run: runDto(node, [node]), existing: false };
  };
  const live = async () => {
    const rows = await db
      .select(NODE_COLUMNS)
      .from(coachRuns)
      .where(and(eq(coachRuns.userId, userId), inArray(coachRuns.status, [...LIVE_STATUSES])));
    const nodes = rows.map((r) => toNode(r as NodeRow));
    return { nodes, root: nodes.filter((n) => n.parentId === null && (n.settings?.rehearsal === true) === rehearsal).sort(byCreated).at(-1) };
  };

  const created = await insert();
  if (created) return created;
  let { nodes, root } = await live();
  if (root && windowClosed(root.settings, root.createdAt, now) && (await expireTree(db, userId, root, nodes, now)).took) {
    const fresh = await insert();
    if (fresh) return fresh;
    ({ nodes, root } = await live()); // another create won the race: answer that one
  }
  if (!root) throw new Error("coach run: neither created nor found");
  const run = runDto(root, nodes);
  return {
    run,
    existing: true,
    offer: run.status === "waiting_athlete" ? "answer_or_cancel" : "continue_or_cancel",
    ignoredRequest: { scope: input.scope, request },
  };
}

/**
 * The spend of a step that died holding a run's claim, for the update that takes that claim back: the step's usage
 * row(s) — written before its model call, stamped with the claim's own time and fingerprinted with the run — so a
 * killed call still counts toward the run's ceiling. Evaluated against the row as it was: nothing for a run that is
 * not `stepping`, so it costs no statement of its own.
 */
const DEAD_STEP_SPEND = sql.raw(
  `CASE WHEN coach_runs.status = 'stepping' THEN COALESCE((` +
    `SELECT SUM(u.cost_micros) FROM llm_usage u WHERE u.user_id = coach_runs.user_id ` +
    `AND u.created_at = coach_runs.updated_at ` +
    `AND substr(u.request_fingerprint, 1, length('run:' || coach_runs.id || ':')) = 'run:' || coach_runs.id || ':'` +
    `), 0) / 1000000.0 ELSE 0 END`,
);

/**
 * Whether a main run's proposal, as its claim reads it, says the run's finish already promoted it (fix wave 3A, A17;
 * round 2, A-M4): any status but none, `unreviewed` or `rehearsal` — `pending`, or one the athlete or the app has moved
 * on from since (approved, partially approved, declined, expired, superseded). A rehearsal's never counts: it is never
 * promoted.
 */
function promotedAlready(status: string | null | undefined): boolean {
  return typeof status === "string" && status !== "unreviewed" && status !== "rehearsal";
}

/** A run whose dead step was taken back this many times in a row, never getting as far as writing its state, fails
 * (fix wave 3A, A14): a step that dies the same way every time would otherwise be retaken, and billed, until a ceiling
 * stopped it. */
export const MAX_TAKEOVERS = 3;

/**
 * The state a claim leaves: as it was — or, taking back a dead step's claim (the run still `stepping`), with that
 * takeover counted (`RunState.takeovers`). Evaluated against the row as it was, in the claim's own statement.
 */
const TAKEOVERS = sql.raw(
  `CASE WHEN coach_runs.status = 'stepping' AND json_valid(coach_runs.state) ` +
    `THEN json_set(coach_runs.state, '$.takeovers', coalesce(json_extract(coach_runs.state, '$.takeovers'), 0) + 1) ` +
    `ELSE coach_runs.state END`,
);

/**
 * What one tree's expiry spends at most (`expireTree`): the expiry; the proposal read and its write, both once more
 * when the write lost to a late verdict (design-review.ts PROMOTE_TRIES); the older plans superseded — or, nothing
 * proposed, the close; and the lines. The sweep spends its read, a claim taken back when there is one, and this per
 * tree it expires (a counting test pins it); a step, an answer or a create spends it once.
 */
export const EXPIRE_TREE_STATEMENTS = 1 + 2 * PROMOTE_TRIES + 1 + 1;

/**
 * Expire a run's live tree, past its window or left under a run that is over, with the main run's plain line. Guarded:
 * a run a live step holds is left to that step — it finishes its work, and the next step, answer, create or sweep
 * expires the run — while a dead step's claim is taken, its spend added to the run. Answers whether the expiry took
 * the run itself. A main run that expires proposes what was reviewed (fix wave 3A, A2), a workout whose day has passed
 * (in the athlete's zone) left out — what a set's designers did read with its proposal, whatever `nodes` holds (round 2,
 * A-I1: the sweep and a create hold only the live runs); with nothing to propose, its design proposal still unreviewed
 * is closed with it: nothing half-made is ever shown. Its lines say it expired, and what came of the proposal — one line
 * for a run whose day has passed and whose later days' workouts are proposed (round 2, A-M7). At most
 * EXPIRE_TREE_STATEMENTS; one when the run itself did not expire.
 */
async function expireTree(
  db: Db,
  userId: string,
  root: RunNode,
  nodes: RunNode[],
  now: Date,
): Promise<{ took: boolean; events: CoachRunEventDto[] }> {
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - COACH_RUN_STEP_STALE_MINUTES * 60_000).toISOString();
  const members = subtree(nodes, root).filter((n) => isLive(n.status));
  if (members.length === 0) return { took: false, events: [] };
  const expired = await db
    .update(coachRuns)
    .set({
      status: "expired",
      error: "expired",
      finishedAt: at,
      updatedAt: at,
      costUsd: sql`${coachRuns.costUsd} + ${DEAD_STEP_SPEND}`,
    })
    .where(
      and(
        eq(coachRuns.userId, userId),
        inArray(coachRuns.id, members.map((n) => n.id)),
        or(
          inArray(coachRuns.status, [...RESTING]),
          and(eq(coachRuns.status, "stepping"), lt(coachRuns.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning({ id: coachRuns.id });
  for (const n of members) if (expired.some((e) => e.id === n.id)) Object.assign(n, { status: "expired", error: "expired", finishedAt: at, updatedAt: at });
  const took = expired.some((e) => e.id === root.id);
  if (!took || root.parentId !== null) return { took, events: [] };
  const today = localDate(root.settings?.timezone || "UTC", now);
  const proposed = await proposeWhatItHas(db, userId, root, STOPPED_NOTES.expired!, at, today);
  if (!proposed) await closeUnreviewed(db, userId, designProposalId(root.id), "expired", at);
  const lines: NewEvent[] =
    proposed && root.settings?.window?.kind === "day"
      ? [{ kind: "note", summary: LINES.expiredDayLater, payload: { proposalId: designProposalId(root.id) } }]
      : [{ kind: "note", summary: expiredLine(root.settings) }, proposedLine(root, proposed, LINES.proposed)];
  const events = await appendEvents(db, userId, root.id, lines, at);
  return { took, events };
}

export async function getRun(
  db: Db,
  userId: string,
  runId: string,
  afterSeq: number,
): Promise<{ run: CoachRunDto; events: CoachRunEventDto[] } | null> {
  const { root, nodes } = await loadTree(db, userId, runId);
  if (!root) return null;
  const rows = await db
    .select({ seq: coachRunEvents.seq, kind: coachRunEvents.kind, summary: coachRunEvents.summary, payload: coachRunEvents.payload, at: coachRunEvents.at })
    .from(coachRunEvents)
    .where(and(eq(coachRunEvents.runId, root.id), eq(coachRunEvents.userId, userId), gt(coachRunEvents.seq, afterSeq)))
    .orderBy(coachRunEvents.seq)
    .limit(200);
  return {
    run: runDto(root, nodes),
    events: rows.map((r) => ({ seq: r.seq, kind: r.kind as RunEventKind, summary: r.summary, payload: r.payload ?? null, at: r.at })),
  };
}

/** How many of its latest events the Studio's read of the current run answers (`currentRun`). */
export const CURRENT_RUN_EVENTS = 50;

/** What `currentRun` spends beyond the route's own: the pick (its proposal read with it), the run's tree, its events. */
export const CURRENT_RUN_STATEMENTS = 3;

/** The design proposal a run holds open for the athlete: its id, its status and its flags (a stop's note among them). */
export interface OpenProposalDto {
  id: string;
  status: string;
  flags: string[];
}

/** Whether the joined design proposal `p` still has an op the athlete can decide — no outcome yet, refused (a refused op
 * stays open: Task 8), or a change an approve is applying (Task 8b: asked again, the approve finishes it) — in a status
 * the athlete decides in. Never errs on ops that aren't JSON. */
const OPEN_OP = sql.raw(
  `(p.status IN ('pending', 'partially_approved') AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.ops) THEN p.ops ELSE '[]' END) o ` +
    `WHERE json_extract(o.value, '$.kind') IN ('doc_workout', 'plan_adjust') ` +
    `AND (json_extract(o.value, '$.outcome') IS NULL OR json_extract(o.value, '$.outcome.status') IN ('refused', 'applying'))))`,
);
const LIVE_ROOT = sql.raw(`r.status IN (${LIVE_STATUSES.map((s) => `'${s}'`).join(", ")})`);

/**
 * The run the Studio shows when it opens (Task 9): the athlete's newest live main run; else the newest main run that is
 * over whose design proposal still has an op to decide (pending, or partially approved with an op undecided or refused —
 * Task 8); else null. Never a rehearsal's (its lane is its own: fix wave 3A, A15), never a sub-run. With its last
 * CURRENT_RUN_EVENTS events, oldest first, and the proposal it holds open. CURRENT_RUN_STATEMENTS: the pick — one
 * statement, the proposal read with it — then the tree and the events; the pick alone when there is none.
 */
export async function currentRun(
  db: Db,
  userId: string,
): Promise<{ run: CoachRunDto; events: CoachRunEventDto[]; proposal: OpenProposalDto | null } | null> {
  const [pick] = (await db.all(sql`
    SELECT r.id AS id, p.id AS proposalId, p.status AS proposalStatus, p.flags AS flags, CASE WHEN ${OPEN_OP} THEN 1 ELSE 0 END AS open
    FROM coach_runs r LEFT JOIN coach_proposals p ON p.id = ${designProposalId("")} || r.id AND p.user_id = r.user_id
    WHERE r.user_id = ${userId} AND r.parent_id IS NULL AND r.role = 'main'
      AND coalesce(CASE WHEN json_valid(r.state) THEN json_extract(r.state, '$.settings.rehearsal') END, 0) = 0
      AND (${LIVE_ROOT} OR ${OPEN_OP})
    ORDER BY CASE WHEN ${LIVE_ROOT} THEN 1 ELSE 0 END DESC, r.created_at DESC, r.id DESC
    LIMIT 1
  `)) as Array<{ id: string; proposalId: string | null; proposalStatus: string | null; flags: string | null; open: number }>;
  if (!pick) return null;
  const { root, nodes } = await loadTree(db, userId, pick.id);
  if (!root) return null;
  const rows = await db
    .select({ seq: coachRunEvents.seq, kind: coachRunEvents.kind, summary: coachRunEvents.summary, payload: coachRunEvents.payload, at: coachRunEvents.at })
    .from(coachRunEvents)
    .where(and(eq(coachRunEvents.runId, root.id), eq(coachRunEvents.userId, userId)))
    .orderBy(desc(coachRunEvents.seq))
    .limit(CURRENT_RUN_EVENTS);
  const events = rows
    .map((r) => ({ seq: r.seq, kind: r.kind as RunEventKind, summary: r.summary, payload: r.payload ?? null, at: r.at }))
    .sort((a, b) => a.seq - b.seq);
  const proposal =
    Number(pick.open) === 1 && pick.proposalId && pick.proposalStatus
      ? { id: pick.proposalId, status: pick.proposalStatus, flags: flagsOf(pick.flags) }
      : null;
  return { run: runDto(root, nodes), events, proposal };
}

/** A proposal's flags as stored (JSON text): its strings, in order. */
function flagsOf(text: string | null): string[] {
  try {
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

// ── Cancel ──────────────────────────────────────────────────────────────

/** Cancel the run and every live run under it, and close its design proposal if it is still unreviewed (nothing
 * half-made is ever shown). A step in flight keeps only its spend (it writes under its claim, which this takes, and adds
 * its spend itself); a step that DIED holding a claim (stale) never will, so its spend is added here, as a takeover
 * would (fix wave 3A, A12). Idempotent: a run that is over comes back as it is. */
export async function cancelRun(db: Db, userId: string, runId: string, now: Date): Promise<{ run: CoachRunDto } | null> {
  const { root, nodes } = await loadTree(db, userId, runId);
  if (!root) return null;
  const live = subtree(nodes, root).filter((n) => isLive(n.status));
  if (live.length === 0) return { run: runDto(root, nodes) };
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - COACH_RUN_STEP_STALE_MINUTES * 60_000).toISOString();
  const cancelled = await db
    .update(coachRuns)
    .set({
      status: "cancelled",
      finishedAt: at,
      updatedAt: at,
      costUsd: sql`${coachRuns.costUsd} + CASE WHEN ${coachRuns.updatedAt} < ${staleBefore} THEN ${DEAD_STEP_SPEND} ELSE 0 END`,
    })
    .where(
      and(
        eq(coachRuns.userId, userId),
        inArray(coachRuns.id, live.map((n) => n.id)),
        inArray(coachRuns.status, [...LIVE_STATUSES]),
      ),
    )
    .returning({ id: coachRuns.id, costUsd: coachRuns.costUsd });
  for (const n of live) {
    const row = cancelled.find((r) => r.id === n.id);
    Object.assign(n, { status: "cancelled", finishedAt: at, updatedAt: at, ...(row ? { costUsd: Number(row.costUsd ?? 0) } : {}) });
  }
  await closeUnreviewed(db, userId, designProposalId(root.id), "cancelled", at);
  await appendEvents(db, userId, root.id, [{ kind: "note", summary: "Cancelled." }], at);
  return { run: runDto(root, nodes) };
}

// ── Answers ─────────────────────────────────────────────────────────────

export interface AnswerInput {
  /** One per question asked, in order: the chip tapped or the words typed. */
  answers: string[];
  /** The athlete skipped the question: the coach goes on with its best judgement and says so. */
  dismissed?: boolean;
  /** An ask for today's condition check, answered (fix wave 3A, A8): the id of the check the athlete logged. */
  conditionCheckId?: string;
}

export const ANSWER_MAX_CHARS = 500;

export type AnswerOutcome =
  | { kind: "ok"; run: CoachRunDto }
  | { kind: "not_found" }
  | { kind: "not_waiting"; status: RunStatus }
  /** The answer doesn't fit the wait: words for a check, a check for a question, or a check not today's, or older than
   * the question. */
  | { kind: "bad_answer"; why: string }
  /** No condition check of this athlete's has that id. */
  | { kind: "check_not_found" };

/**
 * The note the model gets when the athlete logged the condition check it asked for: which profile's check, and what it
 * reads (round 2, A-M6 and B-M11), so the coach sees which check was logged — then validate again. (For an athlete with
 * more than one profile whose gates read a check, the answer takes whichever check they log; matching it to the profile
 * the coach needed is not done yet.)
 */
export function checkLoggedNote(profile: string, value: number | null, feelingOff: boolean): string {
  const reading = [value !== null ? String(value) : null, feelingOff ? "feeling off" : null].filter((x) => x !== null).join(", ") || "no value";
  return `The athlete logged today's ${profile} check: ${reading}. Validate again.`;
}
/** A condition profile's own label (the library's words), or its id when the library no longer knows it. */
const profileLabel = (id: string): string => (isProfileId(id) ? profileById(id).label : id);

/** …and when they skipped it. */
const CHECK_SKIPPED =
  "The athlete skipped today's condition check: the moves its gates close stay closed. Go on without them, and say so.";

/**
 * The question the run is waiting on, answered: its result for the model is the athlete's words, marked as theirs.
 * An ask for today's condition check is answered by the check itself (fix wave 3A, A8): a `condition_checks` row of
 * the athlete's, dated their today and saved at or after the question — one read, before the claim — and the model is
 * told it was logged — which profile's check, and its reading — to validate again. A run past its window is expired
 * instead (with its plain line); an answer that
 * loses to a cancel writes nothing.
 */
export async function answerRun(db: Db, userId: string, runId: string, input: AnswerInput, now: Date): Promise<AnswerOutcome> {
  const { root, nodes } = await loadTree(db, userId, runId);
  if (!root) return { kind: "not_found" };
  const waiting = dueRun(nodes, root);
  if (!waiting || waiting.status !== "waiting_athlete") return { kind: "not_waiting", status: treeStatus(root, nodes) };
  // Past its window the question no longer stands: the run expires (with its line), and the answer is refused.
  if (windowClosed(root.settings, root.createdAt, now)) {
    await expireTree(db, userId, root, nodes, now);
    return { kind: "not_waiting", status: treeStatus(root, nodes) };
  }
  const checkWait = typeof waiting.checkSince === "string";
  if (!input.dismissed) {
    if (checkWait && !input.conditionCheckId) return { kind: "bad_answer", why: "The coach asked for today's condition check: log it, or skip." };
    if (!checkWait && input.conditionCheckId) return { kind: "bad_answer", why: "The coach asked a question, not for a condition check." };
  }
  /** The check that answers an ask for one: which profile's, and its reading (what the coach is told). */
  let logged: { profile: string; value: number | null; feelingOff: boolean } | null = null;
  if (checkWait && !input.dismissed && input.conditionCheckId) {
    const [check] = await db
      .select({ localDate: conditionChecks.localDate, at: conditionChecks.at, profileId: conditionChecks.profileId, value: conditionChecks.value, feelingOff: conditionChecks.feelingOff })
      .from(conditionChecks)
      .where(and(eq(conditionChecks.id, input.conditionCheckId), eq(conditionChecks.userId, userId)));
    if (!check) return { kind: "check_not_found" };
    const today = localDate(waiting.settings?.timezone || root.settings?.timezone || "UTC", now);
    if (check.localDate !== today) return { kind: "bad_answer", why: "That check is from another day: log today's." };
    if (check.at < waiting.checkSince!) return { kind: "bad_answer", why: "That check was logged before the coach asked: log a new one." };
    logged = { profile: profileLabel(check.profileId), value: check.value ?? null, feelingOff: check.feelingOff === true };
  }
  const claimAt = now.toISOString();
  const [claimed] = await db
    .update(coachRuns)
    .set({ status: "stepping", updatedAt: claimAt })
    .where(and(eq(coachRuns.id, waiting.id), eq(coachRuns.userId, userId), eq(coachRuns.status, "waiting_athlete")))
    .returning({ state: coachRuns.state });
  if (!claimed) return { kind: "not_waiting", status: await currentStatus(db, root, nodes, waiting) };

  const state = readRunState(claimed.state);
  let status: RunStatus = "active";
  let error: string | null = null;
  const events: NewEvent[] = [];
  /** The athlete's answers to check-in questions, to keep once the answer stands (one insert). */
  let kept: { handle: string; rows: ReturnType<typeof askedAnswerRows>["rows"] } | null = null;
  if (!state || !state.awaiting) {
    status = "failed";
    error = "bad_state";
    events.push({ kind: "error", summary: LINES.badState });
  } else if (state.awaitingCheck) {
    // Today's condition check: logged (read above, before the claim) or skipped. The validator reads the day's readings
    // afresh on its next call, so a logged check opens the gates that read it.
    const content =
      !input.dismissed && logged
        ? { checkLogged: true, check: logged, note: checkLoggedNote(logged.profile, logged.value, logged.feelingOff) }
        : { dismissed: true, note: CHECK_SKIPPED };
    state.results.push({ type: "tool_result", tool_use_id: state.awaiting, content: JSON.stringify(content) });
    state.awaiting = null;
    delete state.awaitingCheck;
    if (state.pending.length === 0) flushResults(state);
    events.push({ kind: "note", summary: "checkLogged" in content ? "You logged today's condition check." : "You skipped the condition check." });
  } else {
    const questions = askedQuestions(state, state.awaiting);
    const answers = input.answers.map((a) => a.trim().slice(0, ANSWER_MAX_CHARS)).filter((a) => a.length > 0);
    const content =
      input.dismissed || answers.length === 0
        ? {
            dismissed: true,
            note: "The athlete skipped the question. Go on with your best judgement, and say what you assumed.",
          }
        : { answers: answers.map((text, i) => ({ question: questions[i] ?? null, answer: { text, untrusted: true } })) };
    // An answer to a question that declared a check-in is kept as the athlete's answer (ruling 3) — never a rehearsal's.
    if (!("dismissed" in content) && !state.settings.rehearsal) {
      const given = input.answers.map((a) => a.trim().slice(0, ANSWER_MAX_CHARS));
      const asked = askedAnswerRows({
        userId,
        mainRunId: root.id,
        toolUseId: state.awaiting,
        questions: askedQuestionInputs(state, state.awaiting),
        answers: given,
        localDate: localDate(state.settings.timezone || "UTC", now),
        at: claimAt,
      });
      const rows = asked.rows.filter((r) => given[Number(r.id.split(":").at(-1))]!.length > 0);
      if (rows.length > 0) kept = { handle: asked.handle, rows };
    }
    state.results.push({ type: "tool_result", tool_use_id: state.awaiting, content: JSON.stringify(content) });
    state.awaiting = null;
    if (state.pending.length === 0) flushResults(state);
    events.push(
      "dismissed" in content
        ? { kind: "note", summary: "You skipped the question." }
        : { kind: "note", summary: `You answered: ${answers.join(" · ")}`, payload: { answers, ...(kept ? { receipt: { undo: { handle: kept.handle } } } : {}) } },
    );
  }
  const terminal = !isLive(status);
  const [written] = await db
    .update(coachRuns)
    .set({
      status,
      ...(state && !terminal ? { state: JSON.stringify(state) } : {}),
      updatedAt: claimAt,
      ...(terminal ? { finishedAt: claimAt, error } : {}),
    })
    .where(and(eq(coachRuns.id, waiting.id), eq(coachRuns.status, "stepping"), eq(coachRuns.updatedAt, claimAt)))
    .returning({ id: coachRuns.id });
  // A cancel (or an expiry) took the run while the answer was being written: nothing of the answer stands, so the
  // trail says nothing of it either.
  if (!written) return { kind: "not_waiting", status: await currentStatus(db, root, nodes, waiting) };
  if (kept) {
    // The answer stood (the run's write above): a keep that fails is logged, never the route's error — the athlete's
    // answer still reaches the model, only its copy among their check-ins is lost.
    try {
      await insertAnswers(db, kept.rows);
    } catch (e) {
      console.error(
        JSON.stringify({ level: "error", msg: "coach-runs: answer kept failed", run: root.id, error: e instanceof Error ? e.message : "unknown" }),
      );
    }
  }
  const by = waiting.id === root.id ? undefined : { runId: waiting.id, role: waiting.role };
  await appendEvents(db, userId, root.id, events.map((e) => withBy(e, by)), claimAt);
  waiting.status = status;
  if (terminal) return { kind: "not_waiting", status: treeStatus(root, nodes) };
  return { kind: "ok", run: runDto(root, nodes) };
}

/** After a lost claim: the run as it stands now (one read), and the tree's status from it. */
async function currentStatus(db: Db, root: RunNode, nodes: RunNode[], run: RunNode): Promise<RunStatus> {
  const [row] = await db.select({ status: coachRuns.status }).from(coachRuns).where(eq(coachRuns.id, run.id));
  if (row) run.status = row.status as RunStatus;
  return treeStatus(root, nodes);
}

/** The questions an ask call put, in order, as the call gave them, read from the assistant turn that made it. */
function askedQuestionInputs(state: RunState, toolUseId: string): unknown[] {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const use = m.content.find((b) => b.type === "tool_use" && (b as ToolUseBlock).id === toolUseId) as ToolUseBlock | undefined;
    if (!use) continue;
    const qs = (use.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(qs) ? qs : [];
  }
  return [];
}

/** The questions' texts, in order. */
function askedQuestions(state: RunState, toolUseId: string): string[] {
  return askedQuestionInputs(state, toolUseId).map((q) => {
    const text = (q as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : "";
  });
}

function withBy(e: NewEvent, by: { runId: string; role: ToolRole } | undefined): NewEvent {
  if (!by) return e;
  const payload = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : e.payload === undefined ? {} : { value: e.payload };
  return { ...e, payload: { ...(payload as Record<string, unknown>), by } };
}

function flushResults(state: RunState): void {
  if (state.results.length === 0) return;
  state.messages.push({ role: "user", content: state.results });
  state.results = [];
}

// ── One step ────────────────────────────────────────────────────────────

interface StepEnd {
  status: RunStatus;
  /** The state to store; null keeps what is stored (it could not be read, or this step's would overflow it). */
  state: RunState | null;
  costMicros: number;
  error: string | null;
  proposalId: string | null;
  events: NewEvent[];
  /** After a transient failure: how long after the step's end to step again. */
  retryInMs?: number;
  /** Nothing to do without a model (the sweep's step): the claim is given back and nothing else is written. */
  idle?: true;
  /** A money stop (a ceiling, the weekly cap, no credits, no key): every other live run of the tree stops with it. */
  stopTree?: true;
  /** A ceiling's stop reaches the tree under the run whose ceiling it is (absent: the main run's whole tree). */
  stopFrom?: string;
  /** A main run that ended in words with its proposal not made pending by the finish's guard (a review left under way,
   * a workout unreviewed): once its end is written it proposes what was reviewed, as a stop does, with this note. */
  withWhatItHas?: string;
}

type Advance = { kind: "end"; end: StepEnd } | { kind: "lost"; costMicros: number } | { kind: "restoring" };

interface StepCtx {
  db: Db;
  env: Env;
  userId: string;
  now: Date;
  deps: RunDeps;
  run: RunNode;
  /** The main run, and its tree as read at the step's start (a reviewer this step starts joins it). */
  root: RunNode;
  nodes: RunNode[];
  state: RunState;
  claimAt: string;
  /** The stored state's size as it was read: what the step started from, measured once. */
  storedBytes: number;
  /** False for the sweep: queued calls only, never the model (or a context nobody is waiting for). */
  allowModel: boolean;
  /** What this step's model call cost, once it is known: kept on the run even if the step then breaks. */
  spent: number;
}

const stop = (state: RunState | null, status: RunStatus, error: string, summary: string, kind: RunEventKind = "note", costMicros = 0): StepEnd => ({
  status,
  state,
  costMicros,
  error,
  proposalId: null,
  events: [{ kind, summary }],
});

const IDLE: StepEnd = { status: "active", state: null, costMicros: 0, error: null, proposalId: null, events: [], idle: true };

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

/** The loop's own lines. A stop's line says only that the coach stopped, and why; what it proposed — or that it
 * proposed nothing — is the line after it (`proposed` / `nothingProposed`), written once the proposal is settled. */
export const LINES = {
  context: "Read the request and what the coach needs to start.",
  weeklyCap: "The weekly AI budget is used up — the coach stopped here.",
  stepCap: "This design reached its step limit — the coach stopped.",
  stateCap: "This design grew too long to continue — the coach stopped.",
  outOfCredits: "The AI account is out of credits — the coach stopped here.",
  noKey: "This server has no AI key — the coach can't design here.",
  rejected: "The AI service refused the request — the coach stopped here.",
  retrying: "The AI service didn't answer — trying again shortly.",
  retries: `The AI service didn't answer after ${MAX_RETRIES} tries — the coach stopped here.`,
  refusal: "The model declined to design this — the coach stopped.",
  internal: "Something went wrong inside the coach — this design stopped.",
  badState: "This design's saved state can't be read — the coach stopped.",
  keptStopping: "The coach kept stopping partway through; it's been stopped.",
  finished: "The coach finished.",
  expiredDay: "This design was for a day that has passed — start a new one for today.",
  expiredSet: "This design was left open for a day — it stopped. Start a new one when you're ready.",
  /** A run for a day that has passed, whose workouts for later days are proposed: one line, never `expiredDay` and a
   * line contradicting it (round 2, A-M7). */
  expiredDayLater: "The day this was designed for has passed. The workouts for later days are proposed.",
  proposed: "Proposed what had been reviewed before the stop.",
  /** A main run that ended in words with its proposal kept back by the finish's guard: it ended, it didn't stop
   * (round 2, A-M7). */
  proposedAtEnd: "Proposed what had been reviewed.",
  nothingProposed: "Nothing was proposed.",
} as const;

/** The reviewer's own lines on the trail. */
const REVIEWER_LINES = {
  context: "Reviewing the draft.",
  stepCap: "The review reached its step limit — the validator's view stands.",
  unreadable: "The review couldn't be read — the validator's view stands.",
} as const;

/** A reviewer that answered in words instead of calling submit_review: its one repair. */
export const REVIEW_NUDGE =
  "Your review wasn't submitted. Return it by calling submit_review: a whole score from 1 to 5 and a one-line note for every dimension, the must-fix items and the improvements.";

/** The plain line for a run that outlived its window. */
export function expiredLine(settings: RunSettings | undefined): string {
  return settings?.window?.kind === "day" ? LINES.expiredDay : LINES.expiredSet;
}

/** Told to the model on its last call, in the newest (not yet sent) user message (fix wave 3A, A3: never an invitation
 * to answer in words, which would end the run with nothing shown). */
export const LAST_TURN_NOTE = "This is your last turn in this run. Call finish now, with one plain line for the athlete.";

/** A main run's or a designer's turn that called no tool: its one repair (fix wave 3A, A3; the reviewer has its own) —
 * the shared prompt's own line, which says what this loop does (round 2, A-M5 and B-M1). */
export const NO_TOOL_NUDGE = NO_TOOL_LINE;

/** An answer cut off at the output limit (fix wave 3A, A4): the thinking used the room, and the document is not the
 * problem — never a hint to make it smaller. */
export const CUT_OFF_NOTE =
  "Your answer was cut off before it finished. Your thinking used most of the room: think less before you write, and keep the document whole.";
const CUT_OFF_WHY = "Your answer was cut off before it finished.";
/** The reviewer's last-turn note: it has no finish; its review is its end. */
export const REVIEWER_LAST_TURN_NOTE = "This is your last turn in this run. Submit your review now with submit_review, from what you have read.";

export interface StepOptions {
  /** False: the sweep's step — run queued calls, never the model. */
  model?: boolean;
}

/**
 * Advance the run `runId` (a main run) by one step: its due run — itself, or the sub-run it waits on. `busy` when
 * another live step holds that run; a step that died long enough ago (COACH_RUN_STEP_STALE_MINUTES) is taken over.
 * Never more than STEP_BUDGET statements and fetches with the route's own.
 */
export async function runStep(
  db: Db,
  env: Env,
  runId: string,
  userId: string,
  now: Date,
  deps: RunDeps,
  opts: StepOptions = {},
): Promise<StepOutcome> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const { root, nodes } = await loadTree(db, userId, runId);
  if (!root) return { kind: "not_found" };
  // A main run that is over steps nothing more — not a sub-run left live under it (the sweep expires those).
  if (!isLive(root.status)) return okStep({ status: root.status, nextDue: null, events: [] });
  // Past its window the run expires here, waiting on a question or not, with its plain line — unless a live step
  // holds it: that step finishes its work, and the next step, answer, create or sweep expires the run.
  if (windowClosed(root.settings, root.createdAt, now)) {
    const expired = await expireTree(db, userId, root, nodes, now);
    if (!expired.took) return { kind: "busy" };
    return okStep({ status: "expired", nextDue: null, events: expired.events });
  }
  const due = dueRun(nodes, root);
  if (!due) return okStep({ status: root.status, nextDue: null, events: [] });
  if (due.status === "waiting_athlete") return okStep({ status: "waiting_athlete", nextDue: null, events: [] });
  const staleBefore = new Date(now.getTime() - COACH_RUN_STEP_STALE_MINUTES * 60_000).toISOString();
  if (due.status === "stepping" && due.updatedAt >= staleBefore) return { kind: "busy" };

  const claimAt = now.toISOString();
  // Taking back a dead step's claim adds its spend (its pre-call usage row) to the run, so the ceiling below sees it,
  // and counts the takeover in its state (TAKEOVERS). A main run's claim also reads its proposal's status (A17).
  const [claimed] = await db
    .update(coachRuns)
    .set({ status: "stepping", updatedAt: claimAt, costUsd: sql`${coachRuns.costUsd} + ${DEAD_STEP_SPEND}`, state: TAKEOVERS })
    .where(
      and(
        eq(coachRuns.id, due.id),
        eq(coachRuns.userId, userId),
        or(inArray(coachRuns.status, [...CLAIMABLE]), and(eq(coachRuns.status, "stepping"), lt(coachRuns.updatedAt, staleBefore))),
      ),
    )
    .returning({
      state: coachRuns.state,
      costUsd: coachRuns.costUsd,
      proposalStatus: sql<string | null>`(SELECT status FROM coach_proposals WHERE id = ${designProposalId(root.id)} AND user_id = ${userId})`,
    });
  if (!claimed) {
    // Another request changed the run between the read and the claim: a live step holds it (busy), or it is now
    // something else — answered with what it is.
    const status = await currentStatus(db, root, nodes, due);
    if (due.status === "stepping") return { kind: "busy" };
    return okStep({ status, nextDue: nextDueOf(nodes, root, claimAt), events: [] });
  }
  due.costUsd = Number(claimed.costUsd ?? 0);

  const stored = claimed.state ?? "";
  const state = readRunState(claimed.state);
  let advance: Advance;
  if (!state) {
    advance = { kind: "end", end: stop(null, "failed", "bad_state", LINES.badState, "error") };
  } else if (due.id === root.id && promotedAlready(claimed.proposalStatus)) {
    // A main run whose proposal is already pending — or the athlete has since decided it, or it has expired — is one
    // whose finish made it so and then died before the run's own write (fix wave 3A, A17; round 2, A-M4): it is
    // finished — the model is not called again to finish twice.
    advance = { kind: "end", end: { status: "finished", state, costMicros: 0, error: null, proposalId: designProposalId(root.id), events: [{ kind: "note", summary: LINES.finished, payload: { proposalId: designProposalId(root.id) } }] } };
  } else if ((state.takeovers ?? 0) >= MAX_TAKEOVERS) {
    // Taken over again and again, never getting further (fix wave 3A, A14): each death is billed, so it stops here.
    advance = { kind: "end", end: stop(null, "failed", "kept_stopping", LINES.keptStopping, "error") };
  } else {
    const ctx: StepCtx = {
      db,
      env,
      userId,
      now,
      deps,
      run: due,
      root,
      nodes,
      state,
      claimAt,
      storedBytes: bytes(stored),
      allowModel: opts.model !== false,
      spent: 0,
    };
    try {
      advance = await advanceRun(ctx);
    } catch (e) {
      console.error(
        JSON.stringify({ level: "error", msg: "coach-runs: step failed", run: due.id, error: e instanceof Error ? e.message : "unknown" }),
      );
      // A call billed before the break is still the run's spend.
      advance = { kind: "end", end: stop(null, "failed", "internal", LINES.internal, "error", ctx.spent) };
    }
  }
  if (advance.kind === "restoring") return { kind: "restoring" };
  // The stamp the step leaves is its end: `now` plus however long it took.
  const endAt = new Date(now.getTime() + Math.max(0, clock() - started)).toISOString();

  if (advance.kind === "lost") {
    due.status = await addSpend(db, due.id, advance.costMicros);
    return okStep({ status: treeStatus(root, nodes), nextDue: null, events: [] });
  }

  if (advance.end.idle) {
    // Nothing done: the claim goes back, and the run's stamp is what it was.
    await db
      .update(coachRuns)
      .set({ status: "active", updatedAt: due.updatedAt })
      .where(and(eq(coachRuns.id, due.id), eq(coachRuns.status, "stepping"), eq(coachRuns.updatedAt, claimAt)));
    return okStep({ status: treeStatus(root, nodes), nextDue: nextDueOf(nodes, root, claimAt), events: [] });
  }

  // A step that gets as far as writing its state made progress: its run's takeovers start again from none.
  if (advance.end.state) delete advance.end.state.takeovers;
  const { end, json } = guardStateSize(advance.end);
  const terminal = !isLive(end.status);
  const [written] = await db
    .update(coachRuns)
    .set({
      status: end.status,
      ...(json !== null ? { state: json } : {}),
      steps: sql`${coachRuns.steps} + 1`,
      costUsd: sql`${coachRuns.costUsd} + ${end.costMicros / 1_000_000}`,
      updatedAt: endAt,
      finishedAt: terminal ? endAt : null,
      error: end.error,
      ...(end.proposalId ? { proposalId: end.proposalId } : {}),
    })
    .where(and(eq(coachRuns.id, due.id), eq(coachRuns.status, "stepping"), eq(coachRuns.updatedAt, claimAt)))
    .returning({ id: coachRuns.id });
  const mainLines: NewEvent[] = [];
  if (written) {
    Object.assign(due, { status: end.status, steps: due.steps + 1, updatedAt: endAt, finishedAt: terminal ? endAt : null, error: end.error });
    if (end.stopTree) {
      const from = (end.stopFrom && nodes.find((n) => n.id === end.stopFrom)) || root;
      await stopLiveTree(db, userId, from, nodes, due, end, endAt, staleBefore);
    }
    // The main run stopped — this step ended it, any way but a cancel (a cancel takes the claim, so nothing here is
    // written): it proposes what it has (spec §2; fix wave 3A, A2), under the finish's own guard, with why it stopped —
    // a set what was reviewed, the rest left out — and its next line says what came of it. STOP_PROPOSE: the proposal
    // read and, when it proposes, its write and the older plans' days it covers superseded.
    if (!isLive(root.status) && root.status !== "finished" && root.status !== "cancelled") {
      mainLines.push(proposedLine(root, await proposeWhatItHas(db, userId, root, stoppedNote(root.error), endAt), LINES.proposed));
    } else if (end.withWhatItHas && due === root) {
      // A main run that ended in words, its proposal kept back by the finish's guard: what was reviewed (fix wave 3A, A3).
      mainLines.push(proposedLine(root, await proposeWhatItHas(db, userId, root, end.withWhatItHas, endAt), LINES.proposedAtEnd));
    }
  } else {
    // A cancel took the claim while the tools ran: what they did is on the trail below, the cancel's status stands.
    due.status = await addSpend(db, due.id, end.costMicros);
  }
  const by = due.id === root.id ? undefined : { runId: due.id, role: due.role };
  const events = await appendEvents(db, userId, root.id, [...designerLines(due, end, reviewerLines(due, end)).map((e) => withBy(e, by)), ...mainLines], endAt);
  const next = dueRun(nodes, root);
  return okStep({
    status: treeStatus(root, nodes),
    nextDue:
      next && steppable(next.status)
        ? {
            runId: next.id,
            role: next.role,
            at: next.id === due.id && end.retryInMs ? new Date(Date.parse(endAt) + end.retryInMs).toISOString() : endAt,
          }
        : null,
    events,
  });
}

const okStep = (result: StepResult): StepOutcome => ({ kind: "ok", result });

/**
 * A main run that stopped proposes what was reviewed (fix wave 3A, A2): a set's reviewed workouts (design-orchestrate.ts
 * `promoteSetWithWhatItHas`, which reads the set's designers with its proposal — the days they never got a draft in
 * named, one version of a redone workout), or the run's reviewed draft (design-review.ts `promoteWithWhatItHas`); with
 * `today` (an expiry), a workout whose day has passed is left out. Made pending, the older plans' days it covers are
 * superseded. Answers whether it proposed. At most STOP_PROPOSE statements: the proposal read and its write (each once
 * more when the write lost to a late verdict) and the supersede (one when nothing is proposed).
 */
async function proposeWhatItHas(db: Db, userId: string, root: RunNode, note: string, at: string, today?: string): Promise<boolean> {
  const proposalId = designProposalId(root.id);
  const proposed = isSetScope(root.scope)
    ? await promoteSetWithWhatItHas(db, userId, proposalId, note, { mainRunId: root.id, ...(today ? { today } : {}) })
    : await promoteWithWhatItHas(db, userId, proposalId, note, today ? { today } : {});
  if (!proposed) return false;
  await supersedeOlderPlans(db, userId, proposalId, at);
  return true;
}

/** The line after a stop's — or a finish in words' — own: `line` (what was proposed), or that nothing was. */
function proposedLine(root: RunNode, proposed: boolean, line: string): NewEvent {
  return proposed ? { kind: "note", summary: line, payload: { proposalId: designProposalId(root.id) } } : { kind: "note", summary: LINES.nothingProposed };
}

function nextDueOf(nodes: RunNode[], root: RunNode, at: string): StepResult["nextDue"] {
  const next = dueRun(nodes, root);
  return next && steppable(next.status) ? { runId: next.id, role: next.role, at } : null;
}

/** The loop's lines that say the design itself stopped. */
const DESIGN_STOP_LINES = new Set<string>([
  LINES.stateCap,
  LINES.stepCap,
  LINES.retries,
  LINES.rejected,
  LINES.refusal,
  LINES.internal,
  LINES.badState,
  LINES.keptStopping,
]);

/**
 * A reviewer that ends is not the design stopping: whenever a reviewer's run ends other than by a whole-tree stop (a
 * spending limit, no credits, no key) or with a line of its own (an unreadable review, its step cap), any line saying
 * the design stopped becomes "The reviewer couldn't finish: <why>." — its draft goes back to its designer, who goes on.
 */
function reviewerLines(due: RunNode, end: StepEnd): NewEvent[] {
  const ownLine = ["run_ceiling", "weekly_cap", OUT_OF_CREDITS_REASON, "no_key", "review_unreadable", "step_cap"];
  if (due.role !== "reviewer" || isLive(end.status) || end.status === "finished" || ownLine.includes(end.error ?? "")) return end.events;
  return end.events.map((e) => (DESIGN_STOP_LINES.has(e.summary) ? { ...e, summary: `The reviewer couldn't finish: ${unavailableWhy(end.error)}.` } : e));
}

/**
 * A set's designer that ends on its own — not by a limit of the whole tree (the weekly cap, no credits, no key), not at
 * its own ceiling (which has its own line) — stops only its workout: any line saying the design stopped says so, and
 * that the rest of the set goes on (design-orchestrate.ts `designerStopLine`).
 */
function designerLines(due: RunNode, end: StepEnd, events: NewEvent[]): NewEvent[] {
  const ownLine = ["run_ceiling", "weekly_cap", OUT_OF_CREDITS_REASON, "no_key"];
  if (due.role !== "designer" || isLive(end.status) || end.status === "finished" || ownLine.includes(end.error ?? "")) return events;
  return events.map((e) => (DESIGN_STOP_LINES.has(e.summary) ? { ...e, summary: designerStopLine(end.error) } : e));
}

/**
 * A money stop reaches every run of the tree: no call of theirs could be paid for either. The other live runs end
 * with the due run's status and reason (its one line says why); a run a live step holds is left to that step, which
 * stops the same way at its next call. One statement, only when there is another live run.
 */
async function stopLiveTree(db: Db, userId: string, root: RunNode, nodes: RunNode[], due: RunNode, end: StepEnd, at: string, staleBefore: string): Promise<void> {
  const others = subtree(nodes, root).filter((n) => n.id !== due.id && isLive(n.status));
  if (others.length === 0) return;
  const stopped = await db
    .update(coachRuns)
    .set({ status: end.status, error: end.error, finishedAt: at, updatedAt: at, costUsd: sql`${coachRuns.costUsd} + ${DEAD_STEP_SPEND}` })
    .where(
      and(
        eq(coachRuns.userId, userId),
        inArray(coachRuns.id, others.map((n) => n.id)),
        or(
          inArray(coachRuns.status, [...RESTING]),
          and(eq(coachRuns.status, "stepping"), lt(coachRuns.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning({ id: coachRuns.id });
  for (const n of others) if (stopped.some((x) => x.id === n.id)) Object.assign(n, { status: end.status, error: end.error, finishedAt: at, updatedAt: at });
}

/** Add a step's spend to a run whose claim was taken; answers the run's status now. */
async function addSpend(db: Db, id: string, costMicros: number): Promise<RunStatus> {
  const [row] = await db
    .update(coachRuns)
    .set({ costUsd: sql`${coachRuns.costUsd} + ${costMicros / 1_000_000}` })
    .where(eq(coachRuns.id, id))
    .returning({ status: coachRuns.status });
  return (row?.status as RunStatus | undefined) ?? "cancelled";
}

/**
 * The state to write, stringified once. The stored state never exceeds STATE_MAX_BYTES: a step whose state would is
 * not stored, and the run stops.
 */
function guardStateSize(end: StepEnd): { end: StepEnd; json: string | null } {
  const json = end.state ? JSON.stringify(end.state) : null;
  if (json === null || bytes(json) <= STATE_MAX_BYTES) return { end, json };
  const live = isLive(end.status);
  return {
    end: {
      ...end,
      state: null,
      ...(live ? { status: "stopped_cap" as const, error: "state_cap" } : {}),
      events: live ? [...end.events, { kind: "note", summary: LINES.stateCap }] : end.events,
    },
    json: null,
  };
}

async function advanceRun(s: StepCtx): Promise<Advance> {
  const { state } = s;
  const end = (e: StepEnd): Advance => ({ kind: "end", end: e });
  if (state.awaiting && state.awaitingKind === "review") return end(await resumeReview(s));
  if (state.awaiting && state.awaitingKind === "set") return end(await resumeSet(s));
  if (state.awaiting) return end({ status: "waiting_athlete", state, costMicros: 0, error: null, proposalId: null, events: [] });
  if (state.pending.length > 0 && state.system !== null) {
    // Queued calls run only while the claim is still this step's and no restore has begun — as after a model call
    // (fix wave 3A, A11): a cancel that landed since the claim wins before anything is written.
    const { restoring, ours } = await standing(s.db, s.userId, s.run.id, s.claimAt);
    if (restoring) return { kind: "restoring" };
    if (!ours) return { kind: "lost", costMicros: 0 };
    const ran = await runTools(s, STEP_BUDGET - ROUTE_OVERHEAD - PENDING_STEP_FIXED);
    return end({ state, costMicros: 0, error: null, ...ran });
  }
  if (!s.allowModel) return end(IDLE);
  if (state.system === null) return end(await contextStep(s));
  return modelStep(s);
}

/**
 * The designer's run, resumed once its reviewer is over (design-review.ts `resumeAfterReview`): the review — or the
 * validator's view, or word that the round was dropped — becomes its propose_workout call's result, in its place among
 * the turn's results (the calls after it were answered "not run" at the pause), and the turn goes back to the model as
 * one message. No model call: the next step calls it. At most two statements beyond the step's own.
 */
async function resumeReview(s: StepCtx): Promise<StepEnd> {
  const { state } = s;
  const callId = state.awaiting!;
  const w = state.awaitingReview;
  const reviewer = w ? s.nodes.find((n) => n.id === w.reviewRunId) : undefined;
  const { result, lines } = w
    ? await resumeAfterReview(s.db, s.userId, { proposalId: w.proposalId, designerRunId: s.run.id, toolUseId: callId, reviewerError: reviewer?.error ?? null, now: s.now })
    : { result: { data: { review: null, unavailable: true, note: "This draft's review could not be found: it isn't reviewed." } } as ToolOk, lines: [] };
  const at = Math.min(Math.max(0, state.awaitingAt ?? state.results.length), state.results.length);
  state.results.splice(at, 0, okResult(callId, result));
  state.awaiting = null;
  delete state.awaitingKind;
  delete state.awaitingReview;
  delete state.awaitingAt;
  if (state.pending.length === 0) flushResults(state);
  return { status: "active", state, costMicros: 0, error: null, proposalId: null, events: lines.map((summary) => ({ kind: "note" as const, summary })) };
}

/**
 * The main run, resumed once every designer of its set is over (design-orchestrate.ts `settleSet`): the set's outcome —
 * each workout proposed, or left out with its reason — becomes the plan_set call's result, in its place among the
 * turn's results (the calls after it were answered "not run" at the pause). No model call: the next step calls it. At
 * most two statements beyond the step's own: the proposal, and the ops and lines written when anything changed.
 */
async function resumeSet(s: StepCtx): Promise<StepEnd> {
  const { state } = s;
  const callId = state.awaiting!;
  const rounds = state.set?.rounds ?? [];
  const round = rounds.find((r) => r.toolUseId === callId);
  const settled = round
    ? await settleSet(s.db, s.userId, {
        proposalId: designProposalId(s.root.id),
        round,
        keyLines: state.set?.keyLines ?? [],
        budget: { ceilingMicros: state.settings.ceilingMicros, spentMicros: treeSpendMicros(s.nodes, s.root) },
        designers: round.designers.map((d) => {
          const n = s.nodes.find((x) => x.id === d.runId);
          return {
            key: d.key,
            runId: d.runId,
            status: n?.status ?? "missing",
            error: n?.error ?? null,
            final: n?.final ?? null,
            ...(typeof n?.settings?.ceilingMicros === "number" ? { ceilingMicros: n.settings.ceilingMicros } : {}),
          };
        }),
        // The rounds before this one past the first are the redos used.
        redoLeft: Math.max(0, SET_REDO_ROUNDS - rounds.indexOf(round)),
      })
    : { data: { set: [], note: "This set's plan can't be found: nothing was designed from it.", next: "Call finish." }, line: null, keyLines: null };
  if (settled.keyLines && state.set) state.set = { ...state.set, keyLines: settled.keyLines };
  const result: ToolOk = { data: settled.data, provenance: { source: "the set's designers and their independent reviews", asOf: s.now.toISOString() } };
  const at = Math.min(Math.max(0, state.awaitingAt ?? state.results.length), state.results.length);
  state.results.splice(at, 0, okResult(callId, result));
  state.awaiting = null;
  delete state.awaitingKind;
  delete state.awaitingAt;
  if (state.pending.length === 0) flushResults(state);
  const events: NewEvent[] = settled.line ? [{ kind: "note", summary: settled.line, payload: { set: settled.data.set } }] : [];
  return { status: "active", state, costMicros: 0, error: null, proposalId: null, events };
}

async function contextStep(s: StepCtx): Promise<StepEnd> {
  const run: ContextRun = {
    id: s.run.id,
    role: s.run.role,
    scope: s.run.scope,
    request: s.run.request,
    parentId: s.run.parentId,
    ...(s.state.brief ? { brief: s.state.brief } : {}),
    ...(s.state.packet ? { packet: s.state.packet } : {}),
  };
  const built = await s.deps.buildContext.build(s.db, s.env, s.userId, run, s.now);
  s.state.system = built.system;
  s.state.messages = [{ role: "user", content: [{ type: "text", text: built.header }] }];
  s.state.toldAt = s.now.toISOString();
  // The packet is in the opening message now: kept twice it would only weigh on every later step.
  delete s.state.packet;
  const line = s.run.role === "reviewer" ? REVIEWER_LINES.context : LINES.context;
  return { status: "active", state: s.state, costMicros: 0, error: null, proposalId: null, events: [{ kind: "note", summary: line }] };
}

async function modelStep(s: StepCtx): Promise<Advance> {
  const { db, env, userId, deps, run, state, now } = s;
  const end = (e: StepEnd): Advance => ({ kind: "end", end: e });
  const settings = state.settings;

  // ── Before the call: the tree's ceilings, the run's step and state caps, the weekly cap ──
  const reached = ceilingReached(s.nodes, run, settings);
  if (reached !== null) {
    // A sub-run's own ceiling (a set's designer) stops its own tree; the main run's stops the whole of it.
    const whole = reached.of.parentId === null;
    const summary = whole
      ? `This design reached its spending limit (${usd(reached.ceiling)}) — the coach stopped here.`
      : `This workout's design reached its spending limit (${usd(reached.ceiling)}) — it stopped; the rest of the set goes on.`;
    return end({ ...stop(state, "stopped_cap", "run_ceiling", summary), stopTree: true, ...(whole ? {} : { stopFrom: reached.of.id }) });
  }
  const size = s.storedBytes;
  if (state.lastCall !== null || state.calls >= settings.maxCalls || size > STATE_MAX_BYTES) {
    const cap = state.lastCall ?? (size > STATE_MAX_BYTES ? "state_cap" : "step_cap");
    const capLine = cap === "state_cap" ? LINES.stateCap : run.role === "reviewer" ? REVIEWER_LINES.stepCap : LINES.stepCap;
    return end(stop(state, "stopped_cap", cap, capLine));
  }
  // The call's size: the stored state and the tools, at PROMPT_BYTES_PER_TOKEN (fix wave 3A, A13).
  const model = designModel(env);
  const tools = offeredTools(deps.tools).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const promptTokens = Math.ceil((size + bytes(JSON.stringify(tools))) / PROMPT_BYTES_PER_TOKEN);
  // What a killed call could have cost at most: the whole prompt written to the cache (the dearest input, $5 a million
  // on Opus 5.5 against $4 uncached), at PROMPT_BYTES_PER_TOKEN, and the output at the call's ceiling (a call writes at
  // most max_tokens, and at 60 tokens a second — PESSIMISTIC_OUTPUT_TOKENS_PER_SECOND — its 10-minute window reaches
  // that ceiling).
  const worst = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: promptTokens, outputTokens: settings.maxTokens };
  const worstMicros = messagesCostMicros(model, worst);
  // THE WEEKLY CAP IS A HARD CEILING (fix wave 3A, A5): a call is made only when its worst case — priced as the row
  // recorded before it (round 2, A-M2), so a call admitted never records more than the cutoff — fits under the week's
  // cutoff with everything spent so far. A run's and a tree's own ceilings are checked against what has been spent, so
  // a run may pass its own by one call's cost (its last): the week's is the account's guard rail, and is never passed.
  const week = await llmBudgetStatus(db, userId);
  if (week.spentMicros + worstMicros > LLM_BUDGET.cutoffMicros) return end({ ...stop(state, "stopped_cap", "weekly_cap", LINES.weeklyCap), stopTree: true });

  // ── The newest (unsent) message: the time now if the frozen clock has drifted, the last-turn note at a cap ──
  const timezone = settings.timezone || "UTC";
  const tellTime = clockDrifted(state.toldAt, timezone, now);
  const last = state.calls + 1 >= settings.maxCalls ? "step_cap" : size > STATE_LAST_CALL_BYTES ? "state_cap" : null;
  let sent = state.messages;
  if (tellTime) sent = withClockLine(sent, clockLine(timezone, now));
  if (last) sent = withLastTurnNote(sent, run.role === "reviewer" ? REVIEWER_LAST_TURN_NOTE : LAST_TURN_NOTE);

  // ── The call, on the record before it is made ──
  // At its worst case (above): pessimistic, because a step killed mid-call never comes back to correct it. The real
  // usage replaces it once the answer is in.
  const usageId = newId();
  await db.insert(llmUsage).values({
    id: usageId,
    userId,
    kind: USAGE_KIND[run.role],
    model,
    inputTokens: promptTokens,
    outputTokens: worst.outputTokens,
    costMicros: worstMicros,
    cacheHit: false,
    requestFingerprint: `run:${run.id}:${state.calls + 1}`,
    createdAt: s.claimAt,
  });
  const result = await deps.callModel(env, {
    model,
    system: capSystemBreakpoints(state.system ?? []),
    messages: withMessageBreakpoint(sent),
    tools,
    maxTokens: settings.maxTokens,
    effort: settings.effort,
  });

  // What the call cost — the answer's usage; a broken-off answer's, as far as it got; nothing if never billed — known
  // before anything else can break: the run keeps it even if the step then does (fix wave 3A, A12).
  const billed = result.ok
    ? { model: result.model, usage: result.usage, costMicros: result.costMicros }
    : result.kind === "retryable" && result.usage
      ? { model, usage: result.usage, costMicros: result.costMicros ?? messagesCostMicros(model, result.usage) }
      : null;
  const spent = billed?.costMicros ?? 0;
  s.spent = spent;

  // ── After the call: every writer stands down for a restore; the claim may have been cancelled meanwhile ──
  const { restoring, ours } = await standing(db, userId, run.id, s.claimAt);
  if (restoring) return { kind: "restoring" };
  if (result.ok) await clearOutOfCredits(db, userId);
  else if (result.kind === "out_of_credits") await recordOutOfCredits(db, userId, s.claimAt);
  await db
    .update(llmUsage)
    .set(
      billed
        ? {
            model: billed.model,
            inputTokens: billed.usage.inputTokens + billed.usage.cacheReadTokens + billed.usage.cacheWriteTokens,
            outputTokens: billed.usage.outputTokens,
            costMicros: billed.costMicros,
            cacheHit: billed.usage.cacheReadTokens > 0,
          }
        : { inputTokens: 0, outputTokens: 0, costMicros: 0, cacheHit: false },
    )
    .where(eq(llmUsage.id, usageId));
  if (!ours) return { kind: "lost", costMicros: spent };

  if (!result.ok) {
    switch (result.kind) {
      case "out_of_credits":
        return end({ ...stop(state, "failed", OUT_OF_CREDITS_REASON, LINES.outOfCredits, "error", spent), stopTree: true });
      case "no_key":
        return end({ ...stop(state, "failed", "no_key", LINES.noKey, "error", spent), stopTree: true });
      case "rejected":
        return end(stop(state, "failed", result.reason, LINES.rejected, "error", spent));
      case "retryable": {
        state.retries += 1;
        if (state.retries >= MAX_RETRIES) return end(stop(state, "failed", "retries", LINES.retries, "error", spent));
        const retryInMs = RETRY_BACKOFF_SECONDS * 1000 * 2 ** (state.retries - 1);
        return end({ ...stop(state, "active", result.reason, LINES.retrying, "error", spent), retryInMs });
      }
    }
  }

  // ── The answer ──
  let content = result.content;
  if (result.stopReason === "max_tokens") {
    // Cut off while thinking: a trailing thinking block without its signature cannot be sent back (the API checks
    // it), and this turn was never sent, so dropping it rewrites nothing.
    const kept = [...content];
    while (kept.length > 0 && kept.at(-1)!.type === "thinking" && !(kept.at(-1) as { signature?: string }).signature) kept.pop();
    content = kept;
  }
  if (bytes(JSON.stringify(content)) > ANSWER_MAX_BYTES) {
    return end(stop(state, "stopped_cap", "state_cap", LINES.stateCap, "note", spent));
  }
  state.messages = sent;
  state.calls += 1;
  state.retries = 0;
  if (last) state.lastCall = last;
  if (tellTime) state.toldAt = now.toISOString();
  if (content.length > 0) state.messages.push({ role: "assistant", content: content as RequestBlock[] });

  const events: NewEvent[] = [];
  const said = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
  if (said) events.push({ kind: "note", summary: said, ...(said.length > SUMMARY_MAX_CHARS ? { payload: { text: said } } : {}) });

  const base = { state, costMicros: spent, error: null, proposalId: null };
  if (result.stopReason === "refusal") return end({ ...base, status: "failed", error: "refusal", events: [...events, { kind: "error", summary: LINES.refusal }] });

  const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (result.stopReason === "max_tokens") {
    // Cut off mid-answer: a cut call's input is not what the model meant, so nothing runs; it is told and goes on —
    // told that its thinking used the room, never to make the document smaller (fix wave 3A, A4).
    if (uses.length > 0) {
      state.results = uses.map((u) => errorResult(u.id, { error: "cut_off", why: CUT_OFF_WHY, fix: CUT_OFF_NOTE.slice(CUT_OFF_WHY.length + 1) }));
      flushResults(state);
    } else {
      state.messages.push({ role: "user", content: [{ type: "text", text: CUT_OFF_NOTE }] });
    }
    return end({ ...base, status: "active", events });
  }
  if (uses.length === 0) {
    if (run.role === "reviewer") {
      // A review written as words is a review that can't be read: one nudge to submit it, then the validator's view.
      state.repairs = (state.repairs ?? 0) + 1;
      if (state.repairs > 1) {
        return end({ ...base, status: "failed", error: "review_unreadable", events: [...events, { kind: "note", summary: REVIEWER_LINES.unreadable }] });
      }
      state.messages.push({ role: "user", content: [{ type: "text", text: REVIEW_NUDGE }] });
      return end({ ...base, status: "active", events });
    }
    // A turn with no tool call (fix wave 3A, A3; the agent-design audit's C1): ended there, it would leave a reviewed
    // draft unshown. The first gets one nudge; a second in a row — or one on the run's last call, which no nudge could
    // follow — ends the run as its finish would, its words the run's last line.
    state.textOnly = (state.textOnly ?? 0) + 1;
    if (state.textOnly < 2 && !last) {
      state.messages.push({ role: "user", content: [{ type: "text", text: NO_TOOL_NUDGE }] });
      return end({ ...base, status: "active", events });
    }
    return end(await finishInWords(s, said, spent));
  }
  delete state.textOnly;
  state.pending = uses.map((u, i) => ({ id: u.id, name: u.name, input: u.input, ...(i >= MAX_TOOL_CALLS_PER_TURN ? { overflow: true } : {}) }));
  state.results = [];
  const ran = await runTools(s, STEP_BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED);
  return end({ ...base, ...ran, events: [...events, ...ran.events] });
}

/** Has the clock the model was given drifted: a later local date, or more than CLOCK_LINE_AFTER_MINUTES? */
function clockDrifted(toldAt: string | null, timezone: string, now: Date): boolean {
  if (!toldAt) return false;
  const told = new Date(toldAt);
  if (now.getTime() - told.getTime() > CLOCK_LINE_AFTER_MINUTES * 60_000) return true;
  return localDate(timezone, now) !== localDate(timezone, told);
}

function localDate(timezone: string, at: Date): string {
  try {
    return todayInZone(timezone, at);
  } catch {
    return todayInZone("UTC", at);
  }
}

/** "It is now Tuesday, 13 October 2026, 08:15." in the athlete's timezone. */
export function clockLine(timezone: string, now: Date): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timezone);
  } catch {
    parts = format("UTC");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `It is now ${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}.`;
}

/**
 * The history with the clock line as a block of its own in its newest (unsent) user message, after what is there —
 * the tool results must lead a results message, and they stay exactly as the tools answered — or as a message of its
 * own when the newest is the model's. A last-turn note, when there is one, follows it.
 */
function withClockLine(messages: MessageParam[], line: string): MessageParam[] {
  const newest = messages.at(-1);
  const text = { type: "text" as const, text: line };
  if (!newest || newest.role !== "user") return [...messages, { role: "user", content: [text] }];
  const blocks = typeof newest.content === "string" ? [{ type: "text" as const, text: newest.content }] : newest.content;
  return [...messages.slice(0, -1), { role: "user", content: [...blocks, text] }];
}

/**
 * Where a step stands, in ONE statement: whether a restore has begun (account-state.ts `restoreInProgress`: every
 * writer stands down for it), and whether the run's claim is still this step's (a cancel or an expiry that landed
 * meanwhile took it).
 */
async function standing(db: Db, userId: string, runId: string, claimAt: string): Promise<{ restoring: boolean; ours: boolean }> {
  const [row] = (await db.all(sql`
    SELECT (SELECT ${accountState.restoreId} FROM ${accountState} WHERE ${accountState.userId} = ${userId} LIMIT 1) AS restoreId,
      (SELECT ${coachRuns.status} FROM ${coachRuns} WHERE ${coachRuns.id} = ${runId}) AS status,
      (SELECT ${coachRuns.updatedAt} FROM ${coachRuns} WHERE ${coachRuns.id} = ${runId}) AS updatedAt
  `)) as Array<{ restoreId: string | null; status: string | null; updatedAt: string | null }>;
  return {
    restoring: typeof row?.restoreId === "string" && row.restoreId.length > 0,
    ours: row?.status === "stepping" && row.updatedAt === claimAt,
  };
}

/**
 * The tools every run is offered, whatever its role: one list, so main, designer and reviewer share one cached prefix
 * (the tools come first in the cache order). A call the role may not make is answered with an error; the role's own
 * block in the system says which tools it uses.
 */
function offeredTools(tools: DesignTool[]): DesignTool[] {
  const seen = new Set<string>();
  return tools.filter((t) => !seen.has(t.name) && seen.add(t.name));
}

/**
 * Run the queued calls in order while the next one's declared cost fits `room`, at most MAX_TOOL_CALLS_PER_STEP. An
 * ask pauses the run (the calls after it wait); a finish ends it (the calls after it are dropped). Once the queue is
 * empty the turn's results become one user message.
 */
async function runTools(
  s: StepCtx,
  room: number,
): Promise<{ status: RunStatus; events: NewEvent[]; proposalId: string | null; error?: string }> {
  const { state, run } = s;
  const offered = offeredTools(s.deps.tools);
  const mine = offered.filter((t) => t.roles.includes(run.role));
  const ctx: ToolContext = {
    db: s.db,
    env: s.env,
    userId: s.userId,
    run: { id: run.id, role: run.role, scope: run.scope, parentId: run.parentId, rehearsal: state.settings.rehearsal },
    now: s.now,
    ...(s.deps.review && run.role !== "reviewer" ? { review: reviewHooks(s) } : {}),
    ...(state.reviewOf ? { reviewOf: state.reviewOf } : {}),
    ...(run.role === "main" ? { set: setHooks(s) } : {}),
    ...(state.replaces ? { replaces: state.replaces } : {}),
  };
  const events: NewEvent[] = [];
  let executed = 0;
  while (state.pending.length > 0) {
    const call = state.pending[0]!;
    const named = offered.find((t) => t.name === call.name);
    const tool = named && named.roles.includes(run.role) ? named : undefined;
    if (call.overflow) {
      state.pending.shift();
      state.results.push(
        errorResult(call.id, { error: "too_many_calls", why: `One turn may make at most ${MAX_TOOL_CALLS_PER_TURN} tool calls.`, fix: "Make the most useful calls first, and the rest next turn." }),
      );
      continue;
    }
    if (tool && tool.statementCost > MAX_TOOL_STATEMENT_COST) {
      state.pending.shift();
      state.results.push(errorResult(call.id, { error: "unavailable", why: `${call.name} cannot run here.`, fix: "Use another tool." }));
      continue;
    }
    const cost = tool?.statementCost ?? 0;
    if (executed >= MAX_TOOL_CALLS_PER_STEP || cost > room) break;
    room -= cost;
    executed += 1;
    state.pending.shift();

    const fix = mine.length > 0 ? `Use one of: ${mine.map((t) => t.name).join(", ")}.` : "No tools are yours here: finish with what you have.";
    const result: ToolOk | ToolErr = tool
      ? await runTool(tool, { ...ctx, toolUseId: call.id }, call.input)
      : named
        ? run.role === "reviewer" && call.name === "finish"
          ? REVIEWER_HAS_NO_FINISH
          : { error: "not_for_role", why: `${call.name} is not a tool for the ${run.role}.`, fix }
        : { error: "unknown_tool", why: `There is no tool named ${call.name}.`, fix };
    const ok = !isToolErr(result);
    if (tool?.control === "ask" && ok) {
      state.awaiting = call.id;
      // An ask for today's condition check waits on a check the athlete logs from now on (fix wave 3A, A8).
      if ((result.data as { check?: unknown } | null)?.check === "condition") state.awaitingCheck = { since: s.now.toISOString() };
      events.push({ kind: "question", summary: result.summary ?? "The coach has a question.", payload: { tool: call.name, data: result.data } });
      return { status: "waiting_athlete", events, proposalId: null };
    }
    if (ok && result.control === "review") {
      // The draft is with its reviewer: this run waits, and the call's result is the review, once it is in.
      const d = result.data as { proposalId?: unknown; reviewRunId?: unknown; round?: unknown };
      state.awaiting = call.id;
      state.awaitingKind = "review";
      state.awaitingReview = { proposalId: String(d.proposalId), reviewRunId: String(d.reviewRunId), round: Number(d.round) || 1 };
      events.push({
        kind: state.awaitingReview.round > 1 ? "revision" : "draft",
        summary: result.summary ?? "A draft, sent for review.",
        payload: { tool: call.name, input: bounded(call.input, 1_500), ...(result.receipt ? { receipt: result.receipt } : {}) },
      });
      // The calls queued after it never run before the review is read — a finish least of all: each is answered now,
      // and their answers go back with the review, in the model's order, as one message.
      state.awaitingAt = state.results.length;
      for (const queued of state.pending) {
        state.results.push(errorResult(queued.id, REVIEW_FIRST));
        events.push({ kind: "tool_result", summary: `Couldn't use ${label(queued.name)}: ${REVIEW_FIRST.why}`, payload: { tool: queued.name, ok: false, error: REVIEW_FIRST.error } });
      }
      state.pending = [];
      return { status: "waiting_review", events, proposalId: null };
    }
    if (ok && result.control === "set") {
      // The set's designers are at work: this run waits, and the call's result is the set's outcome, once every one of
      // them is over. The round is kept (a replay's replaces its own); the estimate from the first plan.
      const d = result.data as { round?: SetRound; estimate?: SetEstimate } | null;
      if (d?.round) state.set = { ...state.set, rounds: [...(state.set?.rounds ?? []).filter((r) => r.toolUseId !== d.round!.toolUseId), d.round] };
      if (d?.estimate && !state.estimate) state.estimate = d.estimate;
      state.awaiting = call.id;
      state.awaitingKind = "set";
      events.push({
        kind: "tool_result",
        summary: result.summary ?? "Planned the set.",
        payload: { tool: call.name, input: bounded(call.input, 1_500), ok: true, ...(result.receipt ? { receipt: result.receipt } : {}) },
      });
      // As after a draft: the calls queued after it never run before the set is in, and are answered now.
      state.awaitingAt = state.results.length;
      for (const queued of state.pending) {
        state.results.push(errorResult(queued.id, SET_FIRST));
        events.push({ kind: "tool_result", summary: `Couldn't use ${label(queued.name)}: ${SET_FIRST.why}`, payload: { tool: queued.name, ok: false, error: SET_FIRST.error } });
      }
      state.pending = [];
      return { status: "waiting_set", events, proposalId: null };
    }
    if (tool?.control === "finish" && ok) {
      state.pending = [];
      state.results = [];
      // A designer's own last line, as it wrote it: its set's outcome quotes it if its workout is left out.
      const said = (call.input as { summary?: unknown } | null)?.summary;
      if (run.role === "designer" && typeof said === "string") state.final = said.trim().slice(0, SUMMARY_MAX_CHARS);
      const proposalId = typeof (result.data as { proposalId?: unknown } | null)?.proposalId === "string" ? ((result.data as { proposalId: string }).proposalId) : null;
      if (proposalId) await closeProposalAtFinish(s, proposalId);
      const payload = { ...(proposalId ? { proposalId } : {}), ...(result.receipt ? { receipt: result.receipt } : {}) };
      // A reviewer's finish is its review.
      events.push({ kind: run.role === "reviewer" ? "review" : "note", summary: result.summary ?? LINES.finished, ...(Object.keys(payload).length > 0 ? { payload } : {}) });
      return { status: "finished", events, proposalId };
    }
    state.results.push(ok ? okResult(call.id, result) : errorResult(call.id, result));
    events.push({
      kind: "tool_result",
      summary: ok ? (result.summary ?? `Used ${label(call.name)}`) : `Couldn't use ${label(call.name)}: ${result.why}`,
      payload: {
        tool: call.name,
        input: bounded(call.input, 1_500),
        ok,
        ...(ok ? { provenance: result.provenance, missing: result.missing, ...(result.receipt ? { receipt: result.receipt } : {}) } : { error: result.error }),
      },
    });
    if (!ok && run.role === "reviewer" && result.error === "invalid_review") {
      // A review that can't be read gets one repair (this error, with what was wrong); a second ends the reviewer, and
      // its designer goes on with the validator's view.
      state.repairs = (state.repairs ?? 0) + 1;
      if (state.repairs > 1) {
        state.pending = [];
        state.results = [];
        events.push({ kind: "note", summary: REVIEWER_LINES.unreadable });
        return { status: "failed", error: "review_unreadable", events, proposalId: null };
      }
    }
  }
  if (state.pending.length === 0) flushResults(state);
  return { status: "active", events, proposalId: null };
}

/**
 * A run's proposal at its finish (the finish tool's, or a finish in words): a rehearsal's marked a rehearsal — never
 * one the athlete could act on, or see in a list; a main run's made `pending` — the only status the app lists — when
 * every workout in it carries its review and none is under way (review comes before the athlete sees anything, spec
 * §5), the older plans' days it covers then superseded. FINISH_WRITE, and the supersede on finish's declared cost (the
 * finish in words calls no tool: it has the whole tool room). Answers what became of it: `pending`, `rehearsal`, or
 * `kept` (nothing written: a designer's, or one the guard keeps back).
 */
async function closeProposalAtFinish(s: StepCtx, proposalId: string): Promise<"pending" | "rehearsal" | "kept"> {
  // Only while the run is still live and held by this step, in the same statement (fix wave 3A, A11): a cancel that
  // landed since the step's last look wins, and its proposal is never shown.
  const held = sql`exists (select 1 from ${coachRuns} where ${coachRuns.id} = ${s.run.id} and ${coachRuns.userId} = ${s.userId}
    and ${coachRuns.status} = 'stepping' and ${coachRuns.updatedAt} = ${s.claimAt})`;
  if (s.state.settings.rehearsal) {
    await s.db
      .update(coachProposals)
      .set({ status: "rehearsal" })
      .where(and(eq(coachProposals.id, proposalId), eq(coachProposals.userId, s.userId), inArray(coachProposals.status, ["pending", "unreviewed"]), held));
    return "rehearsal";
  }
  if (s.run.role !== "main") return "kept";
  const promoted = await s.db
    .update(coachProposals)
    .set({ status: "pending" })
    .where(
      and(
        eq(coachProposals.id, proposalId),
        eq(coachProposals.userId, s.userId),
        eq(coachProposals.status, "unreviewed"),
        held,
        sql`json_valid(${coachProposals.ops}) and json_array_length(${coachProposals.ops}) > 0`,
        // Every designed WORKOUT reviewed: a change to a session already on the plan (adjust_plan, Task 8b) is never
        // reviewed, so a proposal of changes alone is made pending too.
        sql`not exists (select 1 from json_each(${coachProposals.ops}) where json_extract(json_each.value, '$.kind') = 'doc_workout'
          and json_extract(json_each.value, '$.review') is null)`,
        // No review under way either (design-review.ts `reviewRunning`): a dangling candidate is never shown.
        sql`not exists (select 1 from json_each(${coachProposals.ops}) o where json_extract(o.value, '$.candidate') is not null
          or exists (select 1 from json_each(json_extract(o.value, '$.reviewLog')) r where json_extract(r.value, '$.status') = 'reviewing'))`,
      ),
    )
    .returning({ id: coachProposals.id });
  if (promoted.length === 0) return "kept";
  await supersedeOlderPlans(s.db, s.userId, proposalId, s.now.toISOString());
  return "pending";
}

/**
 * A main run's or designer's second turn in a row with no tool call — or one on its last call — ends the run as its
 * finish would (fix wave 3A, A3), its words the run's last line: a designer's kept as its finish line (`final`, which
 * its set's outcome quotes); a main run's proposal made pending through the finish's own guard — or, kept back by it
 * (a review left under way, a workout unreviewed), what was reviewed proposed once the end is written, as a stop does
 * (`withWhatItHas`). No tool ran this step: at most the guard's write, the supersede, and a stop's proposal.
 */
async function finishInWords(s: StepCtx, said: string, spent: number): Promise<StepEnd> {
  const { state, run } = s;
  const words = said.length > 0 ? said : LINES.finished;
  const longer = said.length > SUMMARY_MAX_CHARS ? { text: said } : {};
  if (run.role !== "main") {
    if (said.length > 0) state.final = said.slice(0, SUMMARY_MAX_CHARS);
    return { status: "finished", state, costMicros: spent, error: null, proposalId: null, events: [{ kind: "note", summary: words, ...(said.length > SUMMARY_MAX_CHARS ? { payload: longer } : {}) }] };
  }
  const proposalId = designProposalId(run.id);
  const closed = await closeProposalAtFinish(s, proposalId);
  const shown = closed === "pending";
  return {
    status: "finished",
    state,
    costMicros: spent,
    error: null,
    proposalId: shown ? proposalId : null,
    events: [{ kind: "note", summary: words, ...(shown || said.length > SUMMARY_MAX_CHARS ? { payload: { ...longer, ...(shown ? { proposalId } : {}) } } : {}) }],
    ...(closed === "kept" ? { withWhatItHas: STOPPED_NOTES.unfinished } : {}),
  };
}

/** A call queued after a propose_workout that paused for its review. */
const REVIEW_FIRST: ToolErr = {
  error: "not_run",
  why: "Not run: propose_workout's review comes first.",
  fix: "Call it again after reading the review.",
};

/** A call queued after a plan_set that paused for its designers. */
const SET_FIRST: ToolErr = {
  error: "not_run",
  why: "Not run: plan_set's designers come first.",
  fix: "Call it again once the set's result is in.",
};

/** The reviewer's finish is its review: a call to finish is answered with what to call instead. */
const REVIEWER_HAS_NO_FINISH: ToolErr = {
  error: "not_for_role",
  why: "The reviewer has no finish: its run ends when its review is in.",
  fix: "Call submit_review with a whole score from 1 to 5 and a one-line note for every dimension, the must-fix items and the improvements.",
};

/**
 * The review hooks a designing run's tools are given (ToolContext.review): `start` puts the reviewer sub-run in place —
 * a fresh history, the root's window, timezone and ceiling, this run's rehearsal and last-told clock, and the review
 * packet from this run's tool results (never its reasoning) — in one insert keyed on the proposing call's id, and adds
 * it to the step's tree so the step answers it as the run due next. `ended` says how a reviewer of this run ended, from
 * that tree (the whole tree is read, finished runs too).
 */
function reviewHooks(s: StepCtx): ReviewHooks {
  return {
    ended(reviewRunId) {
      const n = s.nodes.find((x) => x.id === reviewRunId);
      return n && !isLive(n.status) ? { status: n.status, error: n.error } : null;
    },
    async start(req) {
      const { state, run, root } = s;
      const at = s.now.toISOString();
      const packet = reviewPacket({ round: req.round, draft: req.draft, records: toolRecords(state.messages, state.results), ...(state.brief ? { brief: state.brief } : {}) });
      const rootSettings = root.settings ?? state.settings;
      const reviewerState = newRunState("reviewer", run.scope, {
        rehearsal: state.settings.rehearsal,
        ceilingMicros: rootSettings.ceilingMicros ?? state.settings.ceilingMicros,
        timezone: rootSettings.timezone ?? state.settings.timezone,
        window: rootSettings.window ?? state.settings.window,
        toldAt: state.toldAt,
        packet,
        reviewOf: { proposalId: req.proposalId, designerRunId: run.id, toolUseId: req.toolUseId, round: req.round },
      });
      const inserted = (await s.db.all(sql`
        INSERT INTO coach_runs (id, user_id, parent_id, role, scope, request, status, state, steps, cost_usd, created_at, updated_at)
        VALUES (${req.reviewRunId}, ${s.userId}, ${run.id}, 'reviewer', ${JSON.stringify(run.scope)}, ${root.request}, 'active',
          ${JSON.stringify(reviewerState)}, 0, 0, ${at}, ${at})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `)) as Array<{ id: string }>;
      if (inserted.length === 0) return false;
      s.nodes.push({
        id: req.reviewRunId,
        parentId: run.id,
        role: "reviewer",
        scope: run.scope,
        request: root.request,
        status: "active",
        steps: 0,
        costUsd: 0,
        proposalId: null,
        error: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
        settings: reviewerState.settings,
      });
      return true;
    },
  };
}

/**
 * The set hooks the main run's tools are given (ToolContext.set): the rounds its state holds, and `start`, which puts a
 * round's designer sub-runs in place in ONE insert — each with its brief, a workout's own ceiling, the main run's scope,
 * request, window, timezone and rehearsal and the clock it was last told, keyed on its id (a replay inserts nothing) —
 * and adds them to the step's tree, so the step answers the first of them as the run due next. One bound row per
 * designer (eight values each: 56 of D1's 100 for a full set).
 */
function setHooks(s: StepCtx): SetHooks {
  return {
    rounds: () => s.state.set?.rounds ?? [],
    budget: () => {
      // This set's designers: what each cost, its reviewers included. (Main plans again only once every one of them is
      // over — `waiting_set` — and a designer that never ran is one only a whole-tree stop leaves, after which nothing
      // is planned.)
      const done = s.nodes.filter((n) => n.parentId === s.root.id && n.role === "designer");
      return {
        ceilingMicros: s.state.settings.ceilingMicros,
        // The tree's spend as read at the step's start, and this step's model call.
        spentMicros: treeSpendMicros(s.nodes, s.root) + s.spent,
        mainSpentMicros: Math.round(s.root.costUsd * 1_000_000) + s.spent,
        perDesignerMicros: done.length > 0 ? Math.round(done.reduce((sum, d) => sum + treeSpendMicros(s.nodes, d), 0) / done.length) : null,
        estimate: s.state.estimate ?? null,
      };
    },
    started: (runIds) => s.nodes.some((n) => runIds.includes(n.id)),
    keyLine(key, line) {
      const set = s.state.set ?? { rounds: [] };
      s.state.set = { ...set, keyLines: [...(set.keyLines ?? []), { key, line }] };
    },
    async start(designers) {
      if (designers.length === 0) return [];
      const { state, run } = s;
      const at = s.now.toISOString();
      const rows = designers.map((d) => ({
        ...d,
        state: newRunState("designer", run.scope, {
          rehearsal: state.settings.rehearsal,
          // A workout's own; the main run's holds the whole set above it (the highest ceiling reached stops a run).
          ceilingMicros: DESIGNER_CEILING_MICROS,
          ...(state.settings.timezone ? { timezone: state.settings.timezone } : {}),
          ...(state.settings.window ? { window: state.settings.window } : {}),
          toldAt: state.toldAt,
          brief: d.brief,
        }),
      }));
      for (const r of rows) {
        r.state.day = r.date;
        if (r.replaces) r.state.replaces = r.replaces;
      }
      const values = rows.map(
        (r) => sql`(${r.runId}, ${s.userId}, ${run.id}, 'designer', ${JSON.stringify(run.scope)}, ${run.request}, 'active', ${JSON.stringify(r.state)}, 0, 0, ${at}, ${at})`,
      );
      const inserted = (await s.db.all(sql`
        INSERT INTO coach_runs (id, user_id, parent_id, role, scope, request, status, state, steps, cost_usd, created_at, updated_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `)) as Array<{ id: string }>;
      const ids = new Set(inserted.map((r) => r.id));
      for (const r of rows) {
        if (!ids.has(r.runId)) continue;
        s.nodes.push({
          id: r.runId,
          parentId: run.id,
          role: "designer",
          scope: run.scope,
          request: run.request,
          status: "active",
          steps: 0,
          costUsd: 0,
          proposalId: null,
          error: null,
          createdAt: at,
          updatedAt: at,
          finishedAt: null,
          settings: r.state.settings,
          final: null,
        });
      }
      return rows.filter((r) => ids.has(r.runId)).map((r) => r.runId);
    },
  };
}

const label = (name: string): string => name.replace(/_/g, " ");

async function runTool(tool: DesignTool, ctx: ToolContext, input: unknown): Promise<ToolOk | ToolErr> {
  try {
    return await tool.run(ctx, input);
  } catch (e) {
    console.error(
      JSON.stringify({ level: "error", msg: "coach-runs: tool threw", tool: tool.name, error: e instanceof Error ? e.message : "unknown" }),
    );
    return { error: "tool_failed", why: `${tool.name} stopped with an internal error.`, fix: "Try another approach, or call it again later." };
  }
}

function okResult(id: string, r: ToolOk): ToolResultBlock {
  const { summary: _summary, receipt: _receipt, control: _control, ...forModel } = r;
  return { type: "tool_result", tool_use_id: id, content: capResult(JSON.stringify(forModel)) };
}

function errorResult(id: string, e: ToolErr): ToolResultBlock {
  return { type: "tool_result", tool_use_id: id, content: capResult(JSON.stringify({ error: e.error, why: e.why, fix: e.fix })), is_error: true };
}

const TRUNCATED_NOTE =
  "\n…[truncated: this result was cut to 8 KB. Ask for less — a smaller limit, a narrower filter, or the next page with its cursor.]";

/** A result above TOOL_RESULT_MAX_BYTES, cut (by bytes, at a character boundary) with a note saying how to page. */
function capResult(text: string): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= TOOL_RESULT_MAX_BYTES) return text;
  const room = TOOL_RESULT_MAX_BYTES - bytes(TRUNCATED_NOTE);
  let head = new TextDecoder().decode(encoded.slice(0, room));
  while (bytes(head) > room) head = head.slice(0, -1); // a split character decodes as U+FFFD (3 bytes)
  return head + TRUNCATED_NOTE;
}

/** The system blocks as sent: exactly as the context built them (it marks its own breakpoint on its last stable
 * block), except that at most MAX_BREAKPOINTS − 1 survive — the latest ones — leaving one for the newest message. */
function capSystemBreakpoints(system: SystemBlock[]): SystemBlock[] {
  let extra = system.filter((b) => b.cache_control).length - (MAX_BREAKPOINTS - 1);
  if (extra <= 0) return system;
  return system.map((b) => {
    if (!b.cache_control || extra <= 0) return b;
    extra -= 1;
    const { cache_control: _drop, ...rest } = b;
    return rest;
  });
}

/** The history as sent: no breakpoint anywhere but on the newest message's last block (they move; they never pile
 * up). The stored history carries none. */
function withMessageBreakpoint(messages: MessageParam[]): MessageParam[] {
  return messages.map((m, i) => {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const copy = blocks.map((b) => {
      if (!("cache_control" in b)) return b;
      const { cache_control: _drop, ...rest } = b as RequestBlock & { cache_control?: unknown };
      return rest as RequestBlock;
    });
    if (i === messages.length - 1) {
      const lastIdx = copy.length - 1;
      const lastBlock = copy[lastIdx];
      if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_use" || lastBlock.type === "tool_result")) {
        copy[lastIdx] = { ...lastBlock, cache_control: EPHEMERAL } as RequestBlock;
      }
    }
    return { role: m.role, content: copy };
  });
}

/** The history with the last-turn note added to its newest user message (not yet sent) — or as a message of its own
 * when the newest is the model's. Returns a new list; the stored one changes only once the call is made. */
function withLastTurnNote(messages: MessageParam[], text: string): MessageParam[] {
  const note = { type: "text" as const, text };
  const lastMsg = messages.at(-1);
  if (!lastMsg || lastMsg.role !== "user") return [...messages, { role: "user", content: [note] }];
  const blocks = typeof lastMsg.content === "string" ? [{ type: "text" as const, text: lastMsg.content }] : lastMsg.content;
  return [...messages.slice(0, -1), { role: "user", content: [...blocks, note] }];
}

// ── The sweep ───────────────────────────────────────────────────────────

/** What the sweep reads of each live run: the row without its state, and from the state (in SQL, so a large state is
 * never read whole) its settings, how many calls are queued, and whether it waits on an answer. */
const SWEEP_COLUMNS = {
  ...NODE_COLUMNS,
  pending: sql<number | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_array_length(${coachRuns.state}, '$.pending') END`,
  awaiting: sql<string | null>`CASE WHEN json_valid(${coachRuns.state}) THEN json_extract(${coachRuns.state}, '$.awaiting') END`,
};

function parseSettings(text: string | null): RunSettings | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as RunSettings;
  } catch {
    return undefined;
  }
}

/**
 * The hourly's care of one athlete's runs (cron-limits.ts). It never calls the model:
 * - a step that died (`stepping` past COACH_RUN_STEP_STALE_MINUTES) gives its run back;
 * - a run past its window expires, with a plain event (written only when the expiry took), and so does a sub-run left
 *   live under a main run that is over (a step it was in the middle of first goes stale);
 * - a run its client left (COACH_RUN_LEFT_MINUTES) with tool calls queued gets a step that runs them, at most
 *   `maxSteps` of them. The rest waits for the athlete to come back.
 * One statement when nothing is live.
 */
export async function sweepCoachRuns(
  db: Db,
  env: Env,
  userId: string,
  now: Date,
  deps: RunDeps,
  opts: { maxSteps: number },
): Promise<{ reclaimed: number; expired: number; stepped: number }> {
  const out = { reclaimed: 0, expired: 0, stepped: 0 };
  const rows = await db
    .select(SWEEP_COLUMNS)
    .from(coachRuns)
    .where(and(eq(coachRuns.userId, userId), inArray(coachRuns.status, [...LIVE_STATUSES])));
  if (rows.length === 0) return out;
  const live = rows.map((r) => ({
    node: toNode(r as unknown as NodeRow),
    pending: Number(r.pending ?? 0),
    awaiting: typeof r.awaiting === "string" && r.awaiting.length > 0,
  }));
  const t = now.getTime();
  const iso = (minutesAgo: number) => new Date(t - minutesAgo * 60_000).toISOString();

  const staleBefore = iso(COACH_RUN_STEP_STALE_MINUTES);
  const stale = live.filter((r) => r.node.status === "stepping" && r.node.updatedAt < staleBefore);
  if (stale.length > 0) {
    await db
      .update(coachRuns)
      .set({ status: "active", costUsd: sql`${coachRuns.costUsd} + ${DEAD_STEP_SPEND}`, state: TAKEOVERS })
      .where(
        and(
          eq(coachRuns.userId, userId),
          inArray(coachRuns.id, stale.map((r) => r.node.id)),
          eq(coachRuns.status, "stepping"),
          lt(coachRuns.updatedAt, staleBefore),
        ),
      );
    for (const r of stale) r.node.status = "active";
    out.reclaimed = stale.length;
  }

  // Each live run belongs to the tree of its topmost live ancestor; the tree's window is that run's. A tree topped by a
  // sub-run has lost its main run (over, or gone): nothing will step it again.
  const byId = new Map(live.map((r) => [r.node.id, r]));
  const top = (n: RunNode): RunNode => {
    let r = n;
    for (let i = 0; i < 16 && r.parentId && byId.has(r.parentId); i++) r = byId.get(r.parentId)!.node;
    return r;
  };
  const trees = new Map<string, RunNode[]>();
  for (const { node } of live) trees.set(top(node).id, [...(trees.get(top(node).id) ?? []), node]);

  const leftBefore = iso(COACH_RUN_LEFT_MINUTES);
  for (const [rootId, members] of trees) {
    const root = byId.get(rootId)!;
    const orphaned = root.node.parentId !== null;
    if (orphaned || windowClosed(root.node.settings, root.node.createdAt, now)) {
      // Guarded: a run a live step holds is left alone — that step finishes its work, and the next step, answer,
      // create or sweep expires the run (or, should the step die, its claim goes stale and is taken back first).
      if ((await expireTree(db, userId, root.node, members, now)).took) out.expired += 1;
      continue;
    }
    if (out.stepped >= opts.maxSteps || root.node.parentId !== null) continue;
    const lastTouched = members.map((n) => n.updatedAt).sort().at(-1)!;
    if (lastTouched > leftBefore) continue;
    const due = dueRun(members, root.node);
    const queued = due ? byId.get(due.id) : undefined;
    if (!due || due.status !== "active" || !queued || queued.pending === 0 || queued.awaiting) continue;
    const r = await runStep(db, env, rootId, userId, now, deps, { model: false });
    if (r.kind === "ok") out.stepped += 1;
  }
  return out;
}
