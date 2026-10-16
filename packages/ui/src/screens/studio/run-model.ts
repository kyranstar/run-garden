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
 *   fallbackTiles  ways to train now when nothing was proposed: the day's programme session, a recent template — the
 *                  Studio's own tiles, never one the quick starts right below already show
 *   trailSections  a set's trail by day, under the main run's own lines; foldLines, the athlete's lines never folded
 *   refusalWords   why the plan refused a workout or a change at approval, in plain words
 *
 * Every text the coach or the athlete wrote (the request, an event's summary, a question, a why) is data: the view
 * renders it as text, never as markup.
 */
import { ApiError, type CoachRunDto, type CoachRunEventDto, type CoachRunRole, type CoachRunStatus, type DesignChangeBeforeDto, type TodayResponse } from "@rg/api-client";
import { dayLabel } from "@rg/domain";
import { formatTime, weekdayShort } from "../../components.js";
import { kindWords } from "../settings/coach-memory-model.js";

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

/** The header's spend (fix wave 3B, M4): "Spent $0.16" — read again with every read of the run. */
export const spentWords = (n: number): string => `Spent ${usd(n)}`;

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

/** ✓ a step done, ! one that didn't work, – an outcome that is neither (nothing was proposed). */
export type Glyph = "done" | "error" | "neutral";

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
  /** A set's sub-run's line: the day its workout is for ("YYYY-MM-DD", the server's `payload.forDay`); the main run's
   * own lines carry none (fix wave 3B, B-I7). */
  forDay: string | null;
  /** That workout's title, once known (`payload.forTitle`). */
  forTitle: string | null;
  /** The athlete's own part of the trail — a question put to them, their answer, a skip, a logged check: never folded
   * into "earlier lines" (M10). */
  mine: boolean;
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

/**
 * A handle that takes back what the coach remembered (remember's receipt, Task 10: `rm:<run>:<call>`). The memory item
 * outlives the run, so its Undo is offered whatever the run's status.
 */
export const isMemoryHandle = (handle: string): boolean => handle.startsWith("rm:");

/** A line that says something went wrong: the loop's errors, and a tool the coach couldn't use. */
function isErrorEvent(e: CoachRunEventDto): boolean {
  return e.kind === "error" || (e.kind === "tool_result" && record(e.payload)?.ok === false);
}

/**
 * A call the plan refused, which the coach then adjusted its draft after (fix wave 3B, B-I4; the server's contract): a
 * note — "Adjusted the draft." — its refusal in the payload. Neither a step done nor an alarm.
 */
export function isRefusalNote(e: CoachRunEventDto): boolean {
  const p = record(e.payload);
  return e.kind === "note" && !!p && (p.ok === false || typeof p.error === "string" || p.refused !== undefined);
}

/** An event's mark: ! for what went wrong, – for an outcome that is no step done (nothing proposed, a refused call
 * adjusted after), else ✓. */
function glyphOf(e: CoachRunEventDto): Glyph {
  if (isErrorEvent(e)) return "error";
  return record(e.payload)?.proposed === false || isRefusalNote(e) ? "neutral" : "done";
}

/** "YYYY-MM-DD", nothing else. */
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The athlete's own lines: what the coach asked them, and what they answered, skipped or logged (M10). */
const ATHLETE_LINE = /^You (answered|skipped|logged)\b/;
function isMine(e: CoachRunEventDto): boolean {
  return e.kind === "question" || Array.isArray(record(e.payload)?.answers) || ATHLETE_LINE.test(e.summary);
}

/** A question's line once it was answered: what the coach asked, in the athlete's words. */
function askedLine(e: CoachRunEventDto): string {
  return record(record(e.payload)?.data)?.check === "condition" ? "Asked for today's condition check." : `Asked you: ${e.summary}`;
}

/**
 * The trail's lines, from the events alone (agent-design M10: never from what the model said between tools): one line
 * an event, a `tool_call` and the `tool_result` that answers it one line (the result's summary). A question is a line
 * once asked ("Asked you: …"); the one the coach waits on (`waiting`) is no line — its card sits on top (lead's QA, Q4).
 */
export function runLines(events: readonly CoachRunEventDto[], o: { waiting?: boolean } = {}): RunLine[] {
  const lines: RunLine[] = [];
  const openCalls = new Map<string, RunLine>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const pending = o.waiting ? sorted.filter((e) => e.kind === "question").at(-1) : undefined;
  for (const e of sorted) {
    if (e === pending) continue;
    const key = toolKey(e);
    if (e.kind === "tool_result" && key && openCalls.has(key)) {
      const line = openCalls.get(key)!;
      openCalls.delete(key);
      line.events.push(e);
      line.summary = e.summary;
      line.glyph = glyphOf(e);
      line.undo = line.undo ?? undoHandleOf(e);
      continue;
    }
    const summary = e.kind === "question" ? askedLine(e) : e.summary;
    const p = record(e.payload);
    const line: RunLine = {
      key: e.seq,
      summary,
      glyph: glyphOf(e),
      events: [e],
      undo: undoHandleOf(e),
      forDay: isDay(p?.forDay) ? p.forDay : null,
      forTitle: typeof p?.forTitle === "string" && p.forTitle.trim() ? p.forTitle.trim() : null,
      mine: isMine(e),
    };
    lines.push(line);
    if (e.kind === "tool_call" && key) openCalls.set(key, line);
  }
  return lines;
}

/** Once the run is over, the trail folds to this one line (fix wave 3B, B-I7): the card's Approve sits high on a phone. */
export const TRAIL_FOLD_LINE = "How the coach made this";

/** The line under a live run (M10): it moves only while the Studio is open — the client is what steps it. */
export const PAUSE_LINE = "The coach pauses while you're away from the Studio.";

/** "Sat 17 Oct · Single-leg strength": a set's day, and its workout's title once known. */
export function dayHeading(day: string, title: string | null): string {
  return title ? `${dayLabel(day)} · ${title}` : dayLabel(day);
}

export interface DayGroup {
  day: string;
  title: string | null;
  heading: string;
  lines: RunLine[];
}

/**
 * The trail as it shows (fix wave 3B, B-I7): the main run's own lines, ungrouped, at the top; a set's sub-runs' lines
 * under their day's heading, the days in date order — a day's title is the newest any of its lines knows.
 */
export function trailSections(lines: readonly RunLine[]): { main: RunLine[]; days: DayGroup[] } {
  const main: RunLine[] = [];
  const byDay = new Map<string, DayGroup>();
  for (const line of lines) {
    if (!line.forDay) {
      main.push(line);
      continue;
    }
    const group = byDay.get(line.forDay) ?? { day: line.forDay, title: null, heading: "", lines: [] };
    group.lines.push(line);
    if (line.forTitle) group.title = line.forTitle;
    byDay.set(line.forDay, group);
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((g) => ({ ...g, heading: dayHeading(g.day, g.title) }));
  return { main, days };
}

/**
 * The latest `keep` lines, and every earlier line of the athlete's own (M10: their answers never fold away); `hidden`
 * counts the rest, one tap away.
 */
export function foldLines(lines: readonly RunLine[], keep: number): { hidden: number; shown: RunLine[] } {
  const from = Math.max(0, lines.length - keep);
  const shown = lines.filter((l, i) => i >= from || l.mine);
  return { hidden: lines.length - shown.length, shown: shown.length === lines.length ? (lines as RunLine[]) : shown };
}

// ── A line's detail ─────────────────────────────────────────────────────────

/** A detail value, at most. */
export const DETAIL_VALUE_MAX = 160;
/** Rows a section shows, at most. */
export const DETAIL_ROWS_MAX = 12;

/** Payload keys that say nothing to the athlete: the system's own ids, revisions, kinds and markers (fix round, M6). */
const QUIET_KEYS = new Set([
  "by", "ok", "tool", "untrusted", "signature", "toolUseId", "proposalId", "runId", "handle", "undo",
  "id", "opId", "workoutId", "baseRev", "rev", "reviewRunId", "round", "kind", "final", "proposal", "asOf",
  "memoryId", "replaced",
  // A set's grouping marks (fix wave 3B, B-I7): the trail's headings say them.
  "forDay", "forTitle", "rehearsal",
]);

/** Keys a tool's input or receipt uses, in the athlete's words. */
const KEY_WORDS: Readonly<Record<string, string>> = {
  doc: "Workout",
  target: "For",
  changeNote: "What changed",
  query: "Searched for",
  date: "Day",
  mustFix: "Must fix",
  questions: "Questions",
};

/**
 * The review's rubric, in plainer words (fix wave 3B, M2) — the card's scores and the trail's alike, keyed by the
 * dimension's id (the ids stay the server's).
 */
export const REVIEW_LABELS: Readonly<Record<string, string>> = {
  intent: "Clear purpose",
  sequencing: "Order of the parts",
  alignment: "Fits your goals",
  balance: "Balance across your weeks",
  progression: "A sensible step from your history",
  diversity: "Variety",
  recovery: "Room to recover",
  condition_safety: "Safe for your condition",
  time_fit: "Fits your time",
  equipment_fit: "Fits your equipment",
  specificity: "Made for you",
  honesty: "Honest explanation",
};

/** A dimension's plainer label; one the map doesn't hold keeps the words it came with. */
export const reviewLabel = (id: string, fallback: string): string => REVIEW_LABELS[id] ?? fallback;

/** The system's words for the athlete, as they would say them. */
const yourWords = (s: string): string => s.replace(/\bthe athlete's\b/g, "your").replace(/\bthe athlete\b/g, "you");

const clip = (s: string, max = DETAIL_VALUE_MAX): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "baseRev" → "Base rev"; "condition_safety" → "Condition safety". */
export function keyWords(key: string): string {
  if (KEY_WORDS[key]) return KEY_WORDS[key]!;
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
  // A whole value that is a day reads as one ("Fri 16 Oct", fix wave 3B, B-I3); a date inside words is theirs.
  if (isDay(v)) return dayLabel(v);
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
  /** The section's heading; none where its rows say what they are. */
  title: string | null;
  rows: DetailRow[];
}

/** A question's detail (fix wave 3B, B-I3): "You were asked: …" and its "Choices: …", one pair a question. */
function questionRows(p: Record<string, unknown>): DetailRow[] {
  const data = record(p.data);
  if (!data) return [];
  if (data.check === "condition") {
    const why = typeof data.why === "string" && data.why.trim() ? data.why.trim() : null;
    return [{ key: "You were asked", value: clip(["Today's condition check", why].filter(Boolean).join(" · ")) }];
  }
  if (!Array.isArray(data.questions)) return [];
  return data.questions.flatMap((x): DetailRow[] => {
    const q = record(x);
    if (!q || typeof q.text !== "string") return [];
    const chips = Array.isArray(q.chips) ? q.chips.filter((c): c is string => typeof c === "string") : [];
    return [{ key: "You were asked", value: clip(q.text) }, ...(chips.length ? [{ key: "Choices", value: clip(chips.join(" · ")) }] : [])];
  });
}

/** What the coach remembered, by its kind (fix wave 3B, B-I3): never "Body", "Confidence" or a kind's code. */
function rememberedRows(p: Record<string, unknown>): DetailRow[] {
  const from = record(p.input) ?? record(record(p.data)?.remembered);
  if (!from) return [];
  const kind = (typeof from.kind === "string" ? from.kind : "note") as Parameters<typeof kindWords>[0]["kind"];
  const expiresAt = typeof from.expires === "string" ? from.expires : null;
  const rows: DetailRow[] = [{ key: kindWords({ kind, expiresAt }), value: valueWords(from.body) }];
  if (Array.isArray(from.evidence) && from.evidence.length > 0) rows.push({ key: "Because", value: valueWords(from.evidence) });
  return rows;
}

/** A set's outcome, a row a day (fix wave 3B, B-I3): the day, and the workout — or why it was left out — in words. */
function setRows(set: readonly unknown[]): DetailRow[] {
  return set.slice(0, DETAIL_ROWS_MAX).flatMap((x): DetailRow[] => {
    const o = record(x);
    if (!o) return [];
    const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : null;
    let value: string;
    switch (o.outcome) {
      case "left_out":
        value = reason ? `Left out — ${reason}` : "Left out";
        break;
      case "kept_first":
        value = reason ? `The first version kept — ${reason}` : "The first version kept";
        break;
      default: {
        const title = o.title !== undefined ? valueWords(o.title) : null;
        const minutes = typeof o.minutes === "number" ? `${Math.round(o.minutes)} min` : null;
        value = [title, minutes].filter(Boolean).join(" · ") || "Proposed";
      }
    }
    return [{ key: isDay(o.date) ? dayLabel(o.date) : "—", value: clip(value) }];
  });
}

/** Why a call was refused: the server's own words when it gave them, else its code in words. */
function whyNot(p: Record<string, unknown>): DetailRow {
  return { key: "Why not", value: typeof p.why === "string" && p.why.trim() ? clip(p.why.trim()) : keyWords(String(p.error ?? "refused")) };
}

/**
 * A line's detail: what the coach asked for (the call's input) and a summary of what came back (where from, what was
 * missing, the receipt — a review's scores and notes among them), each a short key: value list. Never raw JSON, and
 * never a payload's own keys where words say it better (fix wave 3B, B-I3): a question, a set, what was remembered.
 */
export function detailOf(line: RunLine): DetailSection[] {
  const out: DetailSection[] = [];
  for (const e of line.events) {
    const p = record(e.payload);
    if (!p) continue;
    if (e.kind === "question") {
      const rows = questionRows(p);
      if (rows.length > 0) out.push({ title: null, rows });
      continue;
    }
    if (p.tool === "remember") {
      const rows = rememberedRows(p);
      if (p.ok === false) rows.push(whyNot(p));
      if (rows.length > 0) out.push({ title: p.ok === false ? "Asked to remember" : "Remembered", rows });
      continue;
    }
    if (p.input !== undefined) {
      const rows = rowsOf(p.input);
      if (rows.length > 0) out.push({ title: "Asked for", rows });
    }
    const back: DetailRow[] = [];
    const prov = record(p.provenance);
    if (prov && typeof prov.source === "string") back.push({ key: "Read from", value: clip(yourWords(prov.source)) });
    if (Array.isArray(p.missing) && p.missing.length > 0) back.push({ key: "Missing", value: valueWords(p.missing) });
    if (typeof p.error === "string" || typeof p.why === "string") back.push(whyNot(p));
    const receipt = record(p.receipt);
    const scores = record(receipt?.scores);
    if (receipt && scores) {
      // A review's receipt: every score its own row ("Order of the parts: 4 of 5"), then the rest of it.
      for (const [dim, score] of Object.entries(scores)) {
        back.push({ key: reviewLabel(dim, keyWords(dim)), value: typeof score === "number" ? `${score} of 5` : valueWords(score) });
      }
      back.push(...rowsOf(Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== "scores"))));
    } else if (p.receipt !== undefined) back.push(...rowsOf(p.receipt));
    if (p.answers !== undefined) back.push({ key: "Your answer", value: valueWords(p.answers) });
    if (p.text !== undefined) back.push({ key: "In full", value: valueWords(p.text) });
    if (Array.isArray(p.set)) {
      const rows = setRows(p.set);
      if (rows.length > 0) out.push({ title: "The set", rows });
    }
    // A review's scores come whole, the cap on top of them.
    const cap = DETAIL_ROWS_MAX + (scores ? Object.keys(scores).length : 0);
    if (back.length > 0) out.push({ title: "Came back", rows: back.slice(0, cap) });
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
/** The line the composer shows when the athlete already has the coach working on something — and how to ask anew (M10). */
export const EXISTING_LINE = "You already have the coach working on something. Here it is. Cancel it to ask for something new.";

// ── Failures ────────────────────────────────────────────────────────────────

export interface Failure {
  /** What stopped, in plain words. */
  what: string;
  /** What happens next. */
  next: string | null;
  /** Out of credits: the owner's billing — said, never a route offered (fix wave 3B, M5). */
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

/** What a way to train now is: the day's programme session, one of the athlete's templates, a built-in quick start. */
export type FallbackKind = "session" | "template" | "quick";

export interface FallbackTile {
  key: string;
  kind: FallbackKind;
  title: string;
  minutes: number | null;
  href: string;
}

/** A tile's kind as it says it (lead's QA, Q2): so the day's session never reads as a quick start of another length. */
export function tileKindWord(t: Pick<FallbackTile, "kind">): string {
  return t.kind === "session" ? "Today's session" : t.kind === "template" ? "Your template" : "Quick start";
}

/** Under the ways to train now: the Studio's quick starts sit right below the coach (M5). */
export const QUICK_BELOW_LINE = "or pick a quick start below";

/**
 * Ways to train now (spec §10), as the Studio's own tiles, each saying what kind it is: the day's programme session when
 * there is one still to do — by its own name (without the theme its build appends) and length — opening its sheet,
 * where Start is (Today's read); then a recent template. Never a tile the quick starts right below already show (fix
 * wave 3B, M5): a built-in quick start, or a template pinned among them.
 */
export function fallbackTiles(o: {
  today: Pick<TodayResponse, "todaySessions"> | null | undefined;
  /** The quick-start tiles (`quickTiles`): built-in ones first, then pinned templates — shown below the coach. */
  quick: ReadonlyArray<Omit<FallbackTile, "kind">>;
  /** The athlete's templates' tiles, in the templates list's order (pinned, then recent). */
  templates: ReadonlyArray<Omit<FallbackTile, "kind">>;
}): FallbackTile[] {
  const out: FallbackTile[] = [];
  const session = (o.today?.todaySessions ?? []).find(
    (s) => s.workout.origin === "program" && s.workout.completionState === "scheduled" && s.workout.contentState !== "done",
  );
  if (session) {
    const seconds = session.workout.workoutSeconds;
    const theme = session.build?.theme;
    const title = theme && session.workout.title.endsWith(` · ${theme}`) ? session.workout.title.slice(0, -` · ${theme}`.length) : session.workout.title;
    out.push({
      key: `session:${session.workout.id}`,
      kind: "session",
      title,
      // Its build's minutes; before it is built, the session's own length.
      minutes: session.build?.minutes ?? (typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 60) : null),
      href: `/plan?workout=${encodeURIComponent(session.workout.id)}`,
    });
  }
  const below = new Set(o.quick.map((q) => q.key));
  const template = o.templates.find((t) => !below.has(t.key));
  if (template) out.push({ ...template, kind: "template" });
  return out;
}

/** The check ask's primary action (M6), in the profile's own word: "Do the jaw check"; an acronym keeps its capitals. */
export function checkAskLabel(checkLabel: string): string {
  const word = checkLabel.trim().split(/[\s/]+/)[0] || checkLabel.trim();
  return `Do the ${word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()} check`;
}

/** What an approve did to a session already on the plan, and how it stood (B-I5): "Skipped · was Sun 8:55 AM, 30 min". */
export function appliedChangeLine(kind: "skip" | "move" | "adjust", before: Pick<DesignChangeBeforeDto, "date" | "time" | "minutes">): string {
  const verb = kind === "skip" ? "Skipped" : kind === "move" ? "Moved" : "Changed";
  return `${verb} · was ${dayAndTime(before.date, before.time)}${before.minutes !== null ? `, ${before.minutes} min` : ""}`;
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

/** How the server begins an `invalid_doc` why (Task 8): what follows is the rule the day now refuses. */
const DAY_REFUSES = /^The day now refuses it:\s*/;

/** The refused op's line: its code's words, and the server's own why where it adds something (rendered as text). */
export function refusedLine(r: { error: string; why: string; cause?: string }): { lead: string; detail: string | null } {
  const why = r.why.trim();
  // Said once: "The day doesn't allow it now: <the rule>" — never the day's words twice (fix round, M7).
  if (r.error === "invalid_doc" && DAY_REFUSES.test(why)) {
    const rest = why.replace(DAY_REFUSES, "").trim();
    if (rest) return { lead: `The day doesn't allow it now: ${rest}`, detail: null };
  }
  const lead = refusalWords(r);
  // A cause the words name says it all too (the server's why for it is the same thing, shorter).
  const named = r.error === "not_editable" && !!r.cause && r.cause !== "unknown";
  return { lead, detail: SAID_BY_CODE.has(r.error) || named || why.length === 0 || why === lead ? null : why };
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
