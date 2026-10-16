/**
 * THE COACH'S RUN, PURE (Stage 3 spec §10; Task 9). What the composer, the run view and the step loop decide that needs
 * no React and no network:
 *
 *   statusWord     the header's word for what the coach is doing — plain words, never a status name
 *   runLines       the trail's lines: one per event, a tool's call and its result one line; the glyph each wears
 *   detailRows     a line's detail as a short key: value list — never raw JSON, every value cut to size
 *   mergeEvents    a step's events and a poll's merged by `seq`, never one twice
 *   the loop's decisions: what can be stepped, how long to wait (never before `nextDue`, the backoff on top), what an
 *                  error means
 *   failureOf      what stopped the coach, in plain words, and what happens next
 *   fallbackTiles  up to three ways to train now when nothing was proposed: the day's programme session, a pinned or
 *                  recent template, the built-in quick starts — the Studio's own tiles
 *   refusalWords   why the plan refused a workout or a change at approval, in plain words
 *
 * Every text the coach or the athlete wrote (the request, an event's summary, a question, a why) is data: the view
 * renders it as text, never as markup.
 */
import { ApiError, type CoachRunDto, type CoachRunEventDto, type CoachRunRole, type CoachRunStatus, type TodayResponse } from "@rg/api-client";
import { formatTime, weekdayShort } from "../../components.js";

// ── Statuses ────────────────────────────────────────────────────────────────

/** A run still in play: it holds the athlete's one live run. */
export const LIVE_STATUSES: readonly CoachRunStatus[] = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
/** What the client steps (the brief's three, and `stepping`: another tab holds the step — a 409 says so, and the loop
 * backs off). Never `waiting_athlete`: the athlete's answer comes first. */
const STEPPABLE: readonly CoachRunStatus[] = ["active", "stepping", "waiting_review", "waiting_set"];

export const isLive = (s: CoachRunStatus): boolean => LIVE_STATUSES.includes(s);
export const isSteppable = (s: CoachRunStatus): boolean => STEPPABLE.includes(s);
/** A set: the main coach plans several workouts, each designed by its own designer. */
export const isSetScope = (run: Pick<CoachRunDto, "scope">): boolean => run.scope.kind === "week" || run.scope.kind === "next_n";

/**
 * The header's word: designing, waiting for you, reviewing, planning the set, done, stopped, ran out of budget, expired,
 * cancelled. A live run's word follows what its next step does (`dueRole`, the last step's `nextDue.role`): a reviewer
 * is reviewing; a set's main coach is planning the set.
 */
export function statusWord(run: Pick<CoachRunDto, "status" | "error" | "scope">, dueRole: CoachRunRole | null = null): string {
  switch (run.status) {
    case "waiting_athlete":
      return "waiting for you";
    case "waiting_review":
      return "reviewing";
    case "waiting_set":
      return "planning the set";
    case "active":
    case "stepping":
      if (dueRole === "reviewer") return "reviewing";
      if (dueRole === "main" && isSetScope(run)) return "planning the set";
      return "designing";
    case "finished":
      return "done";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "stopped_cap":
    case "failed":
      return run.error === "run_ceiling" || run.error === "weekly_cap" ? "ran out of budget" : "stopped";
  }
}

/** Every money figure: two decimals. */
export const usd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** "About $4.23; the limit is $6.00" — a set's estimate, once its plan made one. */
export function estimateLine(run: Pick<CoachRunDto, "estimateUsd" | "ceilingUsd">): string | null {
  if (typeof run.estimateUsd !== "number") return null;
  return typeof run.ceilingUsd === "number" ? `About ${usd(run.estimateUsd)}; the limit is ${usd(run.ceilingUsd)}` : `About ${usd(run.estimateUsd)}`;
}

/** Above this spend, Cancel asks first. */
export const CANCEL_CONFIRM_ABOVE_USD = 0.5;

// ── Events → lines ──────────────────────────────────────────────────────────

/** A step's events and a poll's, merged by `seq`: in order, never one twice (the later copy of a seq wins). */
export function mergeEvents(have: readonly CoachRunEventDto[], incoming: readonly CoachRunEventDto[]): CoachRunEventDto[] {
  if (incoming.length === 0) return have as CoachRunEventDto[];
  const bySeq = new Map<number, CoachRunEventDto>();
  for (const e of have) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest seq held: what a poll reads after. */
export const lastSeq = (events: readonly CoachRunEventDto[]): number => events.reduce((m, e) => Math.max(m, e.seq), 0);

export type Glyph = "done" | "error";

/** One line of the trail. */
export interface RunLine {
  /** The first event's seq: the line's key. */
  key: number;
  summary: string;
  glyph: Glyph;
  /** The events it is made of: a tool's call and its result share one line. */
  events: CoachRunEventDto[];
  /** What the athlete's answer kept, to take back (`undo-answer`): the receipt's handle. */
  undo: string | null;
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The tool a call or a result names, and the sub-run it came from: a call and its result pair on both. */
function toolKey(e: CoachRunEventDto): string | null {
  const p = record(e.payload);
  if (!p || typeof p.tool !== "string") return null;
  const by = record(p.by);
  return `${typeof by?.runId === "string" ? by.runId : "main"}:${p.tool}`;
}

/** The undo handle a line's receipt carries, if any. */
export function undoHandleOf(e: CoachRunEventDto): string | null {
  const undo = record(record(record(e.payload)?.receipt)?.undo);
  return typeof undo?.handle === "string" && undo.handle.length > 0 ? undo.handle : null;
}

/** A line that says something went wrong: the loop's errors, and a tool the coach couldn't use. */
function isErrorEvent(e: CoachRunEventDto): boolean {
  return e.kind === "error" || (e.kind === "tool_result" && record(e.payload)?.ok === false);
}

/**
 * The trail's lines, from the events alone (agent-design M10: never from what the model said between tools): one line
 * an event, a `tool_call` and the `tool_result` that answers it one line (the result's summary). A question is a line
 * too ("The coach asked …"); its card sits at the top while it waits.
 */
export function runLines(events: readonly CoachRunEventDto[]): RunLine[] {
  const lines: RunLine[] = [];
  const openCalls = new Map<string, RunLine>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = toolKey(e);
    if (e.kind === "tool_result" && key && openCalls.has(key)) {
      const line = openCalls.get(key)!;
      openCalls.delete(key);
      line.events.push(e);
      line.summary = e.summary;
      line.glyph = isErrorEvent(e) ? "error" : "done";
      line.undo = line.undo ?? undoHandleOf(e);
      continue;
    }
    const line: RunLine = { key: e.seq, summary: e.summary, glyph: isErrorEvent(e) ? "error" : "done", events: [e], undo: undoHandleOf(e) };
    lines.push(line);
    if (e.kind === "tool_call" && key) openCalls.set(key, line);
  }
  return lines;
}

// ── A line's detail ─────────────────────────────────────────────────────────

/** A detail value, at most. */
export const DETAIL_VALUE_MAX = 160;
/** Rows a section shows, at most. */
export const DETAIL_ROWS_MAX = 12;

/** Payload keys that say nothing to the athlete. */
const QUIET_KEYS = new Set(["by", "ok", "tool", "untrusted", "signature", "toolUseId", "proposalId", "runId", "handle", "undo"]);

const clip = (s: string, max = DETAIL_VALUE_MAX): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "baseRev" → "Base rev"; "condition_safety" → "Condition safety". */
export function keyWords(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A value in words: text as it is (marked untrusted text too), numbers, yes/no, lists and small objects inline. */
export function valueWords(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return clip(v.replace(/\s+/g, " ").trim());
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    if (v.length === 0) return "none";
    return clip(v.map((x) => valueWords(x, depth + 1)).join(", "));
  }
  const o = record(v);
  if (!o) return clip(String(v));
  // Marked text ({ text, untrusted }) is its text.
  if (typeof o.text === "string" && Object.keys(o).every((k) => k === "text" || k === "untrusted")) return clip(o.text);
  // A named thing reads as its name.
  for (const k of ["title", "name", "label", "summary"]) if (typeof o[k] === "string") return clip(o[k] as string);
  if (depth >= 2) return "…";
  return clip(
    Object.entries(o)
      .filter(([k]) => !QUIET_KEYS.has(k))
      .map(([k, x]) => `${keyWords(k).toLowerCase()} ${valueWords(x, depth + 1)}`)
      .join(" · "),
  );
}

export interface DetailRow {
  key: string;
  value: string;
}

/** An object's entries as rows, quiet keys left out, at most DETAIL_ROWS_MAX. */
export function rowsOf(v: unknown): DetailRow[] {
  const o = record(v);
  if (!o) return v === undefined || v === null ? [] : [{ key: "Detail", value: valueWords(v) }];
  if ("truncated" in o && typeof o.head === "string") return [{ key: "Detail", value: clip(o.head) }];
  return Object.entries(o)
    .filter(([k, x]) => !QUIET_KEYS.has(k) && x !== undefined)
    .slice(0, DETAIL_ROWS_MAX)
    .map(([k, x]) => ({ key: keyWords(k), value: valueWords(x) }));
}

export interface DetailSection {
  title: string;
  rows: DetailRow[];
}

/**
 * A line's detail: what the coach asked for (the call's input) and a summary of what came back (where from, what was
 * missing, the receipt — a review's scores and notes among them), each a short key: value list. Never raw JSON.
 */
export function detailOf(line: RunLine): DetailSection[] {
  const out: DetailSection[] = [];
  for (const e of line.events) {
    const p = record(e.payload);
    if (!p) continue;
    if (p.input !== undefined) {
      const rows = rowsOf(p.input);
      if (rows.length > 0) out.push({ title: "Asked for", rows });
    }
    const back: DetailRow[] = [];
    const prov = record(p.provenance);
    if (prov && typeof prov.source === "string") back.push({ key: "From", value: clip(prov.source) });
    if (Array.isArray(p.missing) && p.missing.length > 0) back.push({ key: "Missing", value: valueWords(p.missing) });
    if (typeof p.error === "string") back.push({ key: "Why not", value: keyWords(p.error) });
    const receipt = record(p.receipt);
    const scores = record(receipt?.scores);
    if (receipt && scores) {
      // A review's receipt: every score its own row ("Sequencing: 4 of 5"), then the rest of it.
      for (const [dim, score] of Object.entries(scores)) back.push({ key: keyWords(dim), value: typeof score === "number" ? `${score} of 5` : valueWords(score) });
      back.push(...rowsOf(Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== "scores"))));
    } else if (p.receipt !== undefined) back.push(...rowsOf(p.receipt));
    if (p.answers !== undefined) back.push({ key: "Your answer", value: valueWords(p.answers) });
    if (p.text !== undefined) back.push({ key: "In full", value: valueWords(p.text) });
    if (p.set !== undefined) back.push({ key: "The set", value: valueWords(p.set) });
    if (e.kind === "question") {
      const data = record(p.data);
      if (data) back.push(...rowsOf(data));
    }
    // A review's scores come whole, the cap on top of them.
    const cap = DETAIL_ROWS_MAX + (scores ? Object.keys(scores).length : 0);
    if (back.length > 0) out.push({ title: e.kind === "question" ? "The question" : "Came back", rows: back.slice(0, cap) });
  }
  return out;
}

// ── The question ────────────────────────────────────────────────────────────

export interface AskedQuestion {
  text: string;
  chips: string[];
}

/** What the coach is waiting on: questions with chips (and free text), or today's condition check. */
export type Asked = { kind: "questions"; questions: AskedQuestion[] } | { kind: "check"; why: string };

/** The latest question event's ask, read from its payload (`{ tool: "ask_athlete", data }`); null when unreadable. */
export function askedOf(events: readonly CoachRunEventDto[]): Asked | null {
  const q = [...events].sort((a, b) => b.seq - a.seq).find((e) => e.kind === "question");
  const data = record(record(q?.payload)?.data);
  if (!data) return null;
  if (data.check === "condition") return { kind: "check", why: typeof data.why === "string" ? data.why : "" };
  if (!Array.isArray(data.questions)) return null;
  const questions = data.questions.flatMap((x): AskedQuestion[] => {
    const o = record(x);
    if (!o || typeof o.text !== "string") return [];
    const chips = Array.isArray(o.chips) ? o.chips.filter((c): c is string => typeof c === "string") : [];
    return [{ text: o.text, chips }];
  });
  return questions.length > 0 ? { kind: "questions", questions } : null;
}

// ── The step loop's decisions ───────────────────────────────────────────────

/** Failures in a row (a network error, a 5xx) before the loop stops and offers Retry. */
export const MAX_FAILURES = 4;
/** How often the run's events are read while a step is in flight. */
export const POLL_MS = 2_000;
/** The longest the loop waits for a `nextDue` (a clock that disagrees with the server's never parks it for long). */
export const MAX_DUE_WAIT_MS = 60_000;

/** The backoff after the nth refusal or failure in a row: 1, 2, 4, then 8 s, capped at 8. */
export function backoffMs(n: number): number {
  if (n <= 0) return 0;
  return Math.min(8_000, 1_000 * 2 ** (n - 1));
}

/** How long to wait before the next step: never before `nextDue` (when the server said one), the backoff on top. */
export function stepDelay(o: { nextDueAt: number | null; now: number; backoff: number }): number {
  const due = o.nextDueAt === null ? 0 : Math.min(MAX_DUE_WAIT_MS, Math.max(0, o.nextDueAt - o.now));
  return Math.max(due, o.backoff);
}

/** What a failed step request means: another tab or device holds the step; the run is gone; or try again later. */
export type StepErrorKind = "busy" | "gone" | "transient";

export function stepErrorKind(e: unknown): StepErrorKind {
  if (e instanceof ApiError) {
    if (e.status === 409) return "busy";
    if (e.status === 404) return "gone";
  }
  return "transient";
}

/** Whether an error is the server saying the coach isn't there at all (its routes are off). */
export const isNotAvailable = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

/** The line the loop shows after MAX_FAILURES failures in a row. */
export const LOST_LINE = "Lost the connection. It'll pick up when you're back.";
/** The composer's one quiet line when the server's coach is off. */
export const NOT_AVAILABLE_LINE = "The coach isn't available here.";
/** The line the composer shows when the athlete already has the coach working on something. */
export const EXISTING_LINE = "You already have the coach working on something. Here it is.";

// ── Failures ────────────────────────────────────────────────────────────────

/** The out-of-credits copy, pinned (spec §10). */
export const OUT_OF_CREDITS_FALLBACK = "The AI account is out of credits — here are three ways to train now:";

export interface Failure {
  /** What stopped, in plain words. */
  what: string;
  /** What happens next. */
  next: string | null;
  /** Out of credits: the pinned lead over the tiles. */
  credits: boolean;
}

/** What stopped a run that is over, and what happens next; null for one that finished, or was cancelled. */
export function failureOf(run: Pick<CoachRunDto, "status" | "error">): Failure | null {
  if (run.status === "finished" || run.status === "cancelled" || isLive(run.status)) return null;
  if (run.status === "expired") return { what: "This design ran out of time.", next: "Start a new one when you're ready.", credits: false };
  switch (run.error) {
    case "gateway_402":
      return { what: "The AI account is out of credits.", next: "The coach can design again once credits are added.", credits: true };
    case "weekly_cap":
      return { what: "This week's AI budget is used up.", next: "The coach can design again next week.", credits: false };
    case "run_ceiling":
      return { what: "This design reached its spending limit.", next: "Start a new one when you're ready.", credits: false };
    case "step_cap":
      return { what: "This design reached its step limit.", next: "Start a new one when you're ready.", credits: false };
    case "state_cap":
      return { what: "This design grew too long to continue.", next: "Try a shorter request.", credits: false };
    case "no_key":
      return { what: "This server has no AI key, so the coach can't design here.", next: null, credits: false };
    case "refusal":
      return { what: "The model declined to design this.", next: "Try asking another way.", credits: false };
    case "retries":
      return { what: "The AI service didn't answer.", next: "Try again in a while.", credits: false };
    case "internal":
    case "bad_state":
    case "kept_stopping":
      return { what: "Something went wrong inside the coach.", next: "Try again in a while.", credits: false };
    default:
      // A rejected call answers with the gateway's own reason.
      return { what: "The AI service refused the request.", next: "Try again in a while.", credits: false };
  }
}

// ── Ways to train now ───────────────────────────────────────────────────────

export interface FallbackTile {
  key: string;
  title: string;
  minutes: number | null;
  href: string;
}

/**
 * Up to three ways to train now (spec §10), as the Studio's own tiles: the day's programme session when there is one
 * still to do (Today's read: its sheet, where Start is), then a pinned or recent template, then the built-in quick
 * starts — filling the three.
 */
export function fallbackTiles(o: {
  today: Pick<TodayResponse, "todaySessions"> | null | undefined;
  /** The quick-start tiles (`quickTiles`): built-in ones first, then pinned templates. */
  quick: readonly FallbackTile[];
  /** The athlete's templates' tiles, in the templates list's order (pinned, then recent). */
  templates: readonly FallbackTile[];
}): FallbackTile[] {
  const out: FallbackTile[] = [];
  const session = (o.today?.todaySessions ?? []).find(
    (s) => s.workout.origin === "program" && s.workout.completionState === "scheduled" && s.workout.contentState !== "done",
  );
  if (session) {
    const seconds = session.workout.workoutSeconds;
    out.push({
      key: `session:${session.workout.id}`,
      title: session.workout.title,
      // Its build's minutes; before it is built, the session's own length.
      minutes: session.build?.minutes ?? (typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 60) : null),
      href: `/plan?workout=${encodeURIComponent(session.workout.id)}`,
    });
  }
  // Never two tiles of one name (a programme session titled as a quick start is): the first stands.
  const named = (t: FallbackTile) => out.some((x) => x.key === t.key || x.title.trim().toLowerCase() === t.title.trim().toLowerCase());
  const template = o.templates.find((t) => !named(t));
  if (template) out.push(template);
  for (const q of o.quick) {
    if (out.length >= 3) break;
    if (!q.key.startsWith("template:") && !named(q)) out.push(q);
  }
  return out.slice(0, 3);
}

// ── Approval ────────────────────────────────────────────────────────────────

/** Why the plan refused a workout or a change at approval (Task 8's codes, Task 8b's `race` and cause `studio`). */
export function refusalWords(r: { error: string; cause?: string }): string {
  switch (r.error) {
    case "past_date":
      return "Its day has passed.";
    case "stale_revision":
      return "That workout changed after the coach read it.";
    case "not_found":
      return "That workout isn't on your plan any more.";
    case "invalid_doc":
      return "The day doesn't allow it now.";
    case "run_unsupported":
      return "A run can't be added this way yet.";
    case "restore_in_progress":
      return "A restore is running — try again once it finishes.";
    case "race":
      return "A race day stays as it is.";
    case "not_editable":
      switch (r.cause) {
        case "programme":
          return "It's a programme's session: the programme plans it.";
        case "studio":
          return "Its length comes from the Studio: edit the workout there.";
        case "completed":
          return "It's done already.";
        case "skipped":
          return "It was skipped.";
        case "missed":
          return "It was missed.";
        case "under_way":
          return "It's under way.";
        default:
          return "It can't change now.";
      }
    default:
      return "The plan couldn't take it.";
  }
}

/** Codes whose words say it all: the why (the server's words, about this op) adds to the others. */
const SAID_BY_CODE = new Set(["past_date", "stale_revision", "not_found", "run_unsupported", "restore_in_progress", "race"]);

/** The refused op's line: its code's words, and the server's own why where it adds something (rendered as text). */
export function refusedLine(r: { error: string; why: string; cause?: string }): { lead: string; detail: string | null } {
  const lead = refusalWords(r);
  const why = r.why.trim();
  return { lead, detail: SAID_BY_CODE.has(r.error) || why.length === 0 || why === lead ? null : why };
}

/** "Thu 6 PM" — a day and, when set, a time. */
export function dayAndTime(date: string, time: string | null | undefined): string {
  return time ? `${weekdayShort(date)} ${formatTime(time)}` : weekdayShort(date);
}

/** The Plan's day for a workout: its week, the workout's sheet open. */
export function planDayHref(workoutId: string, date: string): string {
  return `/plan?week=${mondayOf(date)}&workout=${encodeURIComponent(workoutId)}`;
}

/** The Monday of a date's ISO week. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
