/**
 * THE PHONE'S VIEW OF THE COACH, BY ALLOWLIST (R1 review A/MAJOR-1 and its residual MAJOR-1r; the lead's v0.20
 * "structured results over raw transcripts"; the v4 grant's "Never heart rate, pace, routes or health readings").
 *
 * The laptop's coach answers carry the coach's working trail and its words: what each tool read and was given, the
 * opening's line ("Today's run: HR drifted 6% late"), a chip's words ("16 km at 5:40 /km"), the weekly review's narrative,
 * workout titles, finish lines. A phone (`training-v5`) never gets those. Every coach answer a device reads is rebuilt
 * here, route by route and FIELD BY FIELD (`deviceCoachAnswer`): only the fields named below go out, each one structured —
 * an id, a kind, a status, a day or a time, a count, minutes, a category — or a line the APP generates from such fields.
 * Nothing goes out because it wasn't named, and no field the model wrote is shown, with two exceptions the grant names
 * and the owner must act on:
 *  - the question the coach asks — its words and chips, so the owner can answer it on the phone ("answer its questions");
 *    a condition check is `check: "condition"` alone (the app shows its own);
 *  - memory items — "see, edit, add to and delete what your coach remembers" — as `{id, kind, body, confidence, pinned,
 *    expiresAt, learnedAt, source}` (review A MINOR-1: never the account's id or the ids in its provenance).
 * The question still loses every sentence that names a reading, a pace or a condition (`stripReadings`): a belt beside the
 * braces. The owner's own words come back only where they are a phone's own: a run asked from a phone in typed words. A
 * run asked from a chip says the chip's label (the phone sends a chip's id, never its words: routes/coach-runs.ts); a
 * laptop's run, nothing of its words. The laptop's (cookie) answers are unchanged.
 *
 * Pinned by device-never-list.test.ts: readings, a pace, zones, cadence, power, training load, elevation, a condition and
 * memory-core lines planted where the coach reads and words them — its trail, the opening, a chip, the weekly review —
 * reach no v5 answer.
 */
import type { MiddlewareHandler } from "hono";
import { PROFILES } from "@rg/exercise-library";
import type { AppContext } from "../auth/middleware.js";

// ── Words (the belt, for the question alone) ─────────────────────────────────────────────────────────────────────

/** Words that name a body reading, a pace, an effort measure, or the coach's view of either. */
const READING =
  /\b(hrv|hr|heart[\s-]?rate|resting\s+hr|rhr|bpm|pulse|sleep\w*|slept|stress\w*|readiness|body\s+battery|spo2|vo2\s*max|blood\s+pressure|temperature|recovery\s+score|pace[sd]?|per\s+km|per\s+mile|min\/km|min\/mi|threshold|zones?|cadence|spm|power|watts?|training\s+load|load|elevation|ascent|climb\w*)\b|\d\s*(ms|bpm|w|spm|m|km|mi)\b|\d+:\d{2}\s*\/\s*(km|mi)\b|\d+(\.\d+)?\s*%/i;

/** Each condition the library knows, by its id and label, and the words its checks use. */
const CONDITION_WORDS: readonly string[] = Object.entries(PROFILES).flatMap(([id, p]) => [id, (p as { label?: string }).label ?? id, ...(id === "tmj" ? ["jaw", "clench", "clenched", "clenching"] : [])]);
const CONDITION = new RegExp(`\\b(${[...new Set(CONDITION_WORDS.map((w) => w.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()).filter(Boolean))].join("|")}|flare\\w*|condition\\s+check\\w*|feeling\\s+off)\\b`, "i");

/** Whether a line names a reading, a pace or a condition. */
export const namesReading = (text: string): boolean => READING.test(text) || CONDITION.test(text);

/** A line with every sentence that names a reading, a pace or a condition taken out; null when nothing is left. */
export function stripReadings(text: string): string | null {
  const kept = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !namesReading(s));
  return kept.length > 0 ? kept.join(" ") : null;
}

// ── Field helpers ────────────────────────────────────────────────────────────────────────────────────────────────

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const day = (v: unknown): string | null => (typeof v === "string" && DAY.test(v) ? v : null);
const clock = (v: unknown): string | null => (typeof v === "string" && CLOCK.test(v) ? v : null);
/** An id, a code or an instant: one token the app wrote (never words). */
const TOKEN = /^[A-Za-z0-9_.:+-]{1,200}$/;
const token = (v: unknown): string | null => (typeof v === "string" && TOKEN.test(v) ? v : null);
const tokens = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(token).filter((t): t is string => t !== null) : undefined);
/** The named fields that are present (`undefined` dropped; `null` kept). */
const pick = (fields: O): O => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** The app's own words for a category the plan uses. */
const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  recovery: "recovery",
  easy: "easy",
  long: "long",
  quality: "quality",
  race: "race",
  cross_training: "cross-training",
  strength: "strength",
  yoga: "mobility",
  mobility: "mobility",
  rest: "rest",
};
/** A workout's line from its fields alone: "30 min strength". */
export function workoutLabel(minutes: unknown, category: unknown): string {
  const m = num(minutes);
  const c = typeof category === "string" ? CATEGORY_WORDS[category] : undefined;
  return [m !== null ? `${Math.round(m)} min` : null, c ?? "session"].filter(Boolean).join(" ");
}

// ── Runs and their trail ─────────────────────────────────────────────────────────────────────────────────────────

/** A tool's own line on the phone: what it did, never what it found. */
const TOOL_LINES: Readonly<Record<string, string>> = {
  read_readiness: "Read your readiness",
  read_day: "Read your day",
  read_profile: "Read your profile",
  recall_memory: "Recalled what it remembers",
  read_history: "Read your recent sessions",
  read_sessions: "Read your recent sessions",
  read_plan: "Read your plan",
  read_plans: "Read your plans",
  read_workouts: "Read your workouts",
  read_templates: "Read your saved workouts",
  read_library: "Looked through the library",
  search_library: "Looked through the library",
  read_balance: "Read your week's balance",
  read_objectives: "Read your goals",
  read_answers: "Read your answers",
  read_saves: "Read your saved posts",
  read_set: "Read the set",
  read_proposals: "Read its suggestions",
  propose_workout: "Drafted a workout",
  adjust_plan: "Suggested a change to your plan",
  plan_set: "Planned a set",
  remember: "Noted something to remember",
  ask_athlete: "Asked you",
  finish: "Finished",
};
const toolLine = (tool: string | null): string => (tool && TOOL_LINES[tool]) || "Worked on it";
const EVENT_KINDS = new Set(["tool_call", "tool_result", "draft", "review", "revision", "question", "note", "error"]);
const KIND_LINES: Readonly<Record<string, string>> = {
  draft: "Drafted a workout",
  review: "Reviewed the draft",
  revision: "Revised the draft",
  question: "The coach has a question.",
  error: "Something went wrong.",
};
/** The app's lines for how a run's turn ended. */
export const SUGGESTS_LINE = "Here's what your coach suggests.";
export const ANSWERED_LINE = "Your coach answered: open it on the laptop to read it.";
/** A note's line from its fields: the run's last line says what came of it, in the app's words. */
function noteLine(p: O): string {
  if (p.final === true && typeof p.proposalId === "string") return SUGGESTS_LINE;
  if (p.final === true && p.answer === true) return ANSWERED_LINE;
  if (p.final === true) return "Your coach is done.";
  return "The coach is working on it.";
}

/** A question as the phone shows it (the first exception): each question's words and chips, readings stripped; a
 * condition check as `check: "condition"` alone. */
function questionView(data: unknown): O {
  const d = obj(data);
  if (d?.check === "condition") return { check: "condition" };
  return {
    questions: arr(d?.questions).map((raw) => {
      const q = obj(raw) ?? {};
      return {
        text: (typeof q.text === "string" ? stripReadings(q.text) : null) ?? KIND_LINES.question,
        chips: arr(q.chips)
          .map((c) => (typeof c === "string" ? c : str(obj(c)?.label)))
          .filter((l): l is string => typeof l === "string" && !namesReading(l)),
      };
    }),
  };
}

/** One trail event: its kind, sequence and time, the app's line for it, and its structured payload. */
export function eventView(raw: unknown): O | null {
  const e = obj(raw);
  if (!e || typeof e.kind !== "string" || !EVENT_KINDS.has(e.kind)) return null;
  const kind = e.kind;
  const p = obj(e.payload) ?? {};
  const base = { seq: num(e.seq), kind, at: token(e.at) };
  if (kind === "tool_call" || kind === "tool_result") {
    const tool = typeof p.tool === "string" && TOOL_LINES[p.tool] ? p.tool : null;
    return { ...base, summary: p.ok === false ? `${toolLine(tool)}: it couldn't` : toolLine(tool), payload: pick({ tool: tool ?? undefined, ok: bool(p.ok) ?? undefined }) };
  }
  if (kind === "question") return { ...base, summary: KIND_LINES.question, payload: questionView(p.data) };
  if (kind === "note") return { ...base, summary: noteLine(p), payload: pick({ proposalId: token(p.proposalId) ?? undefined, final: p.final === true ? true : undefined, answer: p.answer === true ? true : undefined }) };
  return { ...base, summary: KIND_LINES[kind] ?? "The coach is working on it.", payload: {} };
}
const eventsView = (v: unknown): O[] => arr(v).map(eventView).filter((e): e is O => e !== null);

/** A chip's label from its id's kind alone (`<kind>:<subject>`): the app's words, never the chip's. */
const CHIP_LABELS: Readonly<Record<string, string>> = {
  missed: "Rework my week around a missed session",
  comeback: "Ease me back in",
  horizon: "Fill in the next stretch of my plan",
  race: "Get me ready for race day",
  ending: "Choose what comes after this plan",
  drift: "Look at where I stand",
  session: "Plan around my last session",
  review: "Plan this week",
  ready: "See the next stretch of my plan",
};
export const chipKindOf = (id: string): string => id.split(":")[0] ?? "";
export const chipLabelOf = (id: string): string => CHIP_LABELS[chipKindOf(id)] ?? "Ask your coach about this";

/** A run: its structured fields; its request only when it is a phone's own typed words (a phone run not asked from a chip)
 * — a chip's run says the chip's label, a laptop's run nothing of its words. */
export function runView(raw: unknown): O | null {
  const r = obj(raw);
  if (!r) return null;
  const chip = token(r.chip);
  const scope = obj(r.scope);
  const focus = obj(r.focus);
  return pick({
    id: token(r.id),
    role: token(r.role),
    scope: scope ? pick({ kind: token(scope.kind), n: num(scope.n) ?? undefined }) : null,
    request: r.via === "lifeos" ? (chip ? chipLabelOf(chip) : str(r.request)) : null,
    status: token(r.status),
    steps: num(r.steps),
    costUsd: num(r.costUsd),
    proposalId: token(r.proposalId),
    error: token(r.error),
    createdAt: token(r.createdAt),
    updatedAt: token(r.updatedAt),
    finishedAt: token(r.finishedAt),
    estimateUsd: num(r.estimateUsd),
    ceilingUsd: num(r.ceilingUsd),
    focus: focus ? pick({ kind: token(focus.kind), id: token(focus.id) }) : undefined,
    conversationId: token(r.conversationId),
    origin: token(r.origin) ?? undefined,
    via: r.via === "lifeos" ? "lifeos" : undefined,
    // The day frame's lines are the app's, written from the phone's own typed frame.
    frameLines: r.via === "lifeos" && Array.isArray(r.frameLines) ? r.frameLines.filter((l): l is string => typeof l === "string") : undefined,
    chip: chip ?? undefined,
  });
}

// ── The routes' projections ──────────────────────────────────────────────────────────────────────────────────────

/** An error answer: its code and the app's own fields beside it. */
function errorView(b: O): O {
  const missing = obj(b.missing);
  return pick({
    error: token(b.error) ?? undefined,
    why: str(b.why) ?? undefined,
    status: token(b.status) ?? undefined,
    max: num(b.max) ?? undefined,
    version: token(b.version) ?? undefined,
    retryable: bool(b.retryable) ?? undefined,
    spentUsd: num(b.spentUsd) ?? undefined,
    cutoffUsd: num(b.cutoffUsd) ?? undefined,
    capUsd: num(b.capUsd) ?? undefined,
    opIds: tokens(b.opIds),
    missing: missing ? pick({ status: token(missing.status), error: token(missing.error), line: str(missing.line) }) : undefined,
    issues: Array.isArray(b.issues) ? b.issues.map((i) => pick({ path: str(obj(i)?.path) ?? undefined, message: str(obj(i)?.message) ?? undefined })) : undefined,
  });
}

function opsSummaryView(v: unknown): O[] {
  return arr(v).map((raw) => {
    const o = obj(raw) ?? {};
    return pick({
      opId: token(o.opId),
      op: token(o.op),
      workoutId: token(o.workoutId) ?? undefined,
      day: day(o.day),
      start: clock(o.start) ?? undefined,
      minutesBefore: num(o.minutesBefore) ?? undefined,
      minutesAfter: num(o.minutesAfter) ?? undefined,
      category: token(o.category) ?? undefined,
      outcome: token(o.outcome) ?? undefined,
      dayBefore: day(o.dayBefore) ?? undefined,
      startBefore: clock(o.startBefore) ?? undefined,
    });
  });
}

/** The phone's proposal read: typed fields, and each workout's line from its minutes and category (never its title). */
function proposalView(b: O): O {
  const ops = opsSummaryView(b.opsSummary);
  const labels = Object.fromEntries(ops.filter((o) => o.op === "add" || o.op === "revise").map((o) => [o.opId as string, workoutLabel(o.minutesAfter, o.category)]));
  return pick({
    id: token(b.id),
    status: token(b.status),
    resolvedAt: token(b.resolvedAt),
    version: token(b.version) ?? undefined,
    complete: bool(b.complete) ?? undefined,
    missing: obj(b.missing) ? errorView({ missing: b.missing }).missing : undefined,
    opsSummary: b.opsSummary !== undefined ? ops : undefined,
    titles: b.opsSummary !== undefined ? labels : undefined,
    receipts: Array.isArray(b.receipts) ? b.receipts.map((r) => pick({ opId: token(obj(r)?.opId), receiptId: token(obj(r)?.receiptId) })) : undefined,
    takeBackable: tokens(b.takeBackable),
  });
}

const workoutView = (w: unknown): O | null => {
  const x = obj(w);
  return x ? pick({ id: token(x.id), date: day(x.date), time: clock(x.time), minutes: num(x.minutes), category: token(x.category), sport: token(x.sport), label: workoutLabel(x.minutes, x.category) }) : null;
};

/** An approve's or decline's answer: which ops did what, and the ids and times it left — never a line or a warning. */
function decidedView(b: O): O {
  const opsOf = (v: unknown, f: (o: O) => O) => (Array.isArray(v) ? v.map((x) => f(obj(x) ?? {})) : undefined);
  const before = (v: unknown) => (obj(v) ? pick({ date: day(obj(v)!.date), time: clock(obj(v)!.time) }) : undefined);
  return pick({
    ...(b.error !== undefined ? errorView(b) : {}),
    ok: bool(b.ok) ?? undefined,
    status: token(b.status) ?? undefined,
    applied: opsOf(b.applied, (o) => pick({ opId: token(o.opId), workout: workoutView(o.workout), moved: o.moved === true ? true : undefined, watchHasOlder: o.watchHasOlder === true ? true : undefined })),
    changed: opsOf(b.changed, (o) => pick({ opId: token(o.opId), change: token(o.change), workoutId: token(o.workoutId), before: before(o.before) })),
    refused: opsOf(b.refused, (o) => pick({ opId: token(o.opId), error: token(o.error) })),
    settled: opsOf(b.settled, (o) => pick({ opId: token(o.opId), outcome: token(o.outcome), workoutId: token(o.workoutId) ?? undefined })),
    declined: tokens(b.declined),
    remaining: tokens(b.remaining),
    inFlight: tokens(b.inFlight),
    notNamed: tokens(b.notNamed),
    planned: opsOf(b.planned, (o) => ({ opId: token(o.opId) })),
    corrected: opsOf(b.corrected, (o) => ({ opId: token(o.opId) })),
    objectives: opsOf(b.objectives, (o) => ({ opId: token(o.opId) })),
    pinned: opsOf(b.pinned, (o) => ({ opId: token(o.opId) })),
    coachDrain: b.coachDrain === true ? true : undefined,
    receipts: opsOf(b.receipts, (o) => pick({ opId: token(o.opId), receiptId: token(o.receiptId) })),
    version: token(b.version) ?? undefined,
  });
}

/** A memory item (the second exception): its words and standing, and where it came from in one word. */
export function memoryItemView(raw: unknown): O | null {
  const m = obj(raw);
  if (!m) return null;
  return {
    id: token(m.id),
    kind: token(m.kind),
    body: str(m.body),
    confidence: token(m.confidence),
    pinned: m.pinned === true || m.pinned === 1,
    expiresAt: token(m.expiresAt),
    learnedAt: token(m.learnedAt),
    source: token(m.source) ?? token(obj(m.provenance)?.source),
  };
}
const memoriesView = (v: unknown): O[] => arr(v).map(memoryItemView).filter((m): m is O => m !== null);

const CARD_LABELS: Readonly<Record<string, string>> = {
  workout: "A workout",
  plan_changes: "Changes to your plan",
  set: "A set of workouts",
  plan: "A plan",
  programme: "A change to a programme",
  plan_change: "A change to a plan",
  pins: "Moves in rotation",
  corrections: "Corrections to your data",
  objectives: "A change to your goals",
};

/** The conversation: each turn's structured fields, its line in the app's words, its cards by kind, its question. */
function conversationView(b: O): O {
  return pick({
    id: token(b.id),
    startedAt: token(b.startedAt),
    turns: arr(b.turns).map((raw) => {
      const t = obj(raw) ?? {};
      const chip = token(t.chip);
      const cards = arr(t.cards).map((c) => {
        const x = obj(c) ?? {};
        return pick({
          kind: token(x.kind),
          proposalId: token(x.proposalId),
          title: (typeof x.kind === "string" && CARD_LABELS[x.kind]) || "A suggestion",
          status: token(x.status),
          opId: token(x.opId) ?? undefined,
          opIds: tokens(x.opIds),
          sport: x.sport === "run" ? "run" : undefined,
        });
      });
      const q = obj(t.question);
      const status = token(t.status);
      let question: O | null = null;
      if (q?.check === true) question = { check: true, text: "Log today's condition check.", choices: [], questions: [] };
      else if (q) {
        const asked = arr(questionView({ questions: arr(q.questions).map((x) => ({ text: obj(x)?.text, chips: obj(x)?.choices })) }).questions) as Array<{ text: string; chips: string[] }>;
        question = { text: asked[0]?.text ?? KIND_LINES.question, choices: asked[0]?.chips ?? [], questions: asked.map((x) => ({ text: x.text, choices: x.chips, why: null })) };
      }
      return pick({
        runId: token(t.runId),
        at: token(t.at),
        words: t.via === "lifeos" ? (chip ? chipLabelOf(chip) : str(t.words)) : null,
        from: t.from === "app" ? "app" : undefined,
        via: t.via === "lifeos" ? "lifeos" : undefined,
        frameLines: t.via === "lifeos" && Array.isArray(t.frameLines) ? t.frameLines.filter((l): l is string => typeof l === "string") : undefined,
        chip: chip ?? undefined,
        status,
        line: t.line == null ? null : cards.length > 0 ? SUGGESTS_LINE : status === "finished" ? ANSWERED_LINE : "Your coach stopped: open it on the laptop.",
        cards,
        question,
      });
    }),
  });
}

/** A chip: its id, its kind and subject (a day when it is one), the app's label for its kind — never its words. */
function chipView(raw: unknown): O | null {
  const c = obj(raw) ?? {};
  const id = token(c.id);
  if (!id) return null;
  const subject = id.slice(chipKindOf(id).length + 1);
  return pick({ id, kind: chipKindOf(id), subject: token(subject) ?? undefined, date: day(subject) ?? undefined, label: chipLabelOf(id), proposalId: token(c.proposalId) ?? undefined });
}
const OPENING_LINES: Readonly<Record<string, string>> = { review: "Last week's review is in.", session: "A session you finished is in.", read: "A session you finished is in." };

/** The opening and its chips: kinds, ids, days and the app's labels — never the line, a chip's words or the review. */
function nudgesView(b: O): O {
  const opening = obj(b.opening);
  const chips = (v: unknown) => arr(v).map(chipView).filter((c): c is O => c !== null);
  return pick({
    nudges: chips(b.nudges),
    ready: Array.isArray(b.ready) ? chips(b.ready) : undefined,
    opening: opening
      ? pick({
          id: token(opening.id),
          source: token(opening.source),
          line: (typeof opening.source === "string" && OPENING_LINES[opening.source]) || "Your coach noticed something.",
          chips: chips(opening.chips),
          workoutId: token(opening.workoutId) ?? undefined,
          weekStart: day(obj(opening.review)?.weekStart) ?? undefined,
        })
      : undefined,
  });
}

function spendView(b: O): O {
  const kinds = (v: unknown) => arr(v).map((x) => pick({ kind: token(obj(x)?.kind), calls: num(obj(x)?.calls), inputTokens: num(obj(x)?.inputTokens), outputTokens: num(obj(x)?.outputTokens), costMicros: num(obj(x)?.costMicros) }));
  const dev = obj(b.rehearsalAndReplay) ?? {};
  return pick({
    since: token(b.since),
    spentMicros: num(b.spentMicros),
    spentUsd: num(b.spentUsd),
    warnMicros: num(b.warnMicros),
    cutoffMicros: num(b.cutoffMicros),
    byKind: kinds(b.byKind),
    rehearsalAndReplay: pick({ spentMicros: num(dev.spentMicros), spentUsd: num(dev.spentUsd), capMicros: num(dev.capMicros), byKind: kinds(dev.byKind) }),
  });
}

const S = "[^/]+";
type View = (b: O) => O;
/** Each v5 coach route's projection, by method and path. Any other coach answer a device gets is its error's fields alone. */
const ROUTES: ReadonlyArray<[string, RegExp, View]> = [
  // `repeated` (R1.2): the run this ask's clientId already made, answered again.
  ["POST", /^\/api\/coach\/runs$/, (b) => pick({ run: runView(b.run), existing: bool(b.existing) ?? undefined, conversationId: token(b.conversationId) ?? undefined, offer: token(b.offer) ?? undefined, repeated: b.repeated === true ? true : undefined })],
  [
    "GET",
    /^\/api\/coach\/runs\/current$/,
    (b) => {
      const p = obj(b.proposal);
      return pick({
        run: b.run === null ? null : runView(b.run),
        events: b.events !== undefined ? eventsView(b.events) : undefined,
        proposal: p ? pick({ id: token(p.id), status: token(p.status), flags: tokens(p.flags) }) : b.proposal === null ? null : undefined,
        alsoOpen: Array.isArray(b.alsoOpen) ? b.alsoOpen.map((x) => pick({ proposalId: token(obj(x)?.proposalId), date: day(obj(x)?.date), time: clock(obj(x)?.time), items: num(obj(x)?.items), atNow: obj(x)?.atNow === true ? true : undefined })) : undefined,
      });
    },
  ],
  [
    "POST",
    new RegExp(`^/api/coach/runs/${S}/step$`),
    (b) => {
      const due = obj(b.nextDue);
      return pick({ status: token(b.status), armed: bool(b.armed) ?? undefined, nextDue: due ? pick({ runId: token(due.runId), role: token(due.role), at: token(due.at) }) : b.nextDue === null ? null : undefined, events: eventsView(b.events) });
    },
  ],
  ["POST", new RegExp(`^/api/coach/runs/${S}/(answer|cancel)$`), (b) => pick({ run: runView(b.run) })],
  ["POST", new RegExp(`^/api/coach/runs/${S}/undo-answer$`), (b) => pick({ undone: num(b.undone) })],
  ["GET", new RegExp(`^/api/coach/runs/${S}$`), (b) => pick({ run: runView(b.run), events: eventsView(b.events) })],
  ["GET", /^\/api\/coach\/conversation$/, conversationView],
  ["GET", /^\/api\/coach\/nudges$/, nudgesView],
  ["GET", new RegExp(`^/api/coach/proposals/${S}$`), proposalView],
  [
    "GET",
    new RegExp(`^/api/coach/proposals/${S}/ops/${S}/draft$`),
    (b) => {
      const d = obj(b.derived) ?? {};
      return pick({ opId: token(b.opId), minutes: num(d.estimatedMinutes) ?? undefined, category: token(d.category) ?? undefined, discipline: token(d.discipline) ?? undefined, label: workoutLabel(d.estimatedMinutes, d.category) });
    },
  ],
  ["POST", new RegExp(`^/api/coach/proposals/${S}/(approve|decline)$`), decidedView],
  ["POST", /^\/api\/coach\/drain$/, (b) => pick({ executed: num(b.executed) })],
  ["GET", /^\/api\/coach\/memory$/, (b) => ({ memory: memoriesView(b.memory), history: memoriesView(b.history) })],
  ["POST", /^\/api\/coach\/memory$/, (b) => pick({ ok: bool(b.ok) ?? undefined, item: memoryItemView(b.item) ?? undefined, repeated: b.repeated === true ? true : undefined, existing: b.existing === true ? true : undefined })],
  ["PATCH", new RegExp(`^/api/coach/memory/${S}$`), (b) => pick({ ok: bool(b.ok) ?? undefined, item: memoryItemView(b.item) ?? undefined })],
  ["DELETE", new RegExp(`^/api/coach/memory/${S}$`), (b) => pick({ ok: bool(b.ok) ?? undefined })],
  ["GET", /^\/api\/coach\/spend$/, spendView],
];

/** A device's coach answer, rebuilt by its route's allowlist (see the module comment). An error is its own fields. */
export function deviceCoachAnswer(method: string, path: string, status: number, body: unknown): unknown {
  const b = obj(body);
  if (!b) return {};
  const route = ROUTES.find(([m, re]) => m === method && re.test(path));
  // An approve's or decline's 409 carries what else it did: its own projection keeps the error with it.
  if (route && route[2] === decidedView) return decidedView(b);
  if (!route || status >= 400 || b.error !== undefined) return errorView(b);
  return route[2](b);
}

/**
 * The response middleware on every coach route: a device's JSON answer, as its route's allowlist rebuilds it. A cookie's
 * answer, and anything not JSON, passes as it is.
 */
export const deviceCoachView: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (!c.get("device")) return;
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return;
  const body = (await c.res.clone().json().catch(() => undefined)) as unknown;
  if (body === undefined) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(deviceCoachAnswer(c.req.method, new URL(c.req.url).pathname, c.res.status, body)), { status: c.res.status, headers });
};
