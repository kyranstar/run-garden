/**
 * THE COACH, A CONVERSATION (the new shape §5). One conversation per athlete, continuing across screens and visits: a
 * conversation is the athlete's recent coach runs — each message they send starts one main run (the existing engine),
 * and each run keeps the conversation it is a turn of in its state (`settings.conversationId`; no table, no column,
 * no migration). A conversation's id is its first run's own id; a run made before conversations is a conversation of
 * its own (its own id). The create finds it in its own insert (coach-runs.ts `createRun`): none asked, the current one
 * while its newest run was asked under CONVERSATION_QUIET_HOURS ago, else a new one; `null`, a new one; an id, that one.
 *
 * READ BACK (`readConversation`; `GET /api/coach/conversation`, `?id=` for a given one): `{ id, startedAt, turns }`, at
 * most CONVERSATION_TURNS_MAX turns, the newest of them, oldest first — each the athlete's words as they wrote them, the
 * run's status, the coach's line (its finish's words or its answer; a stop's own line; null while live), its cards —
 * a workout, the plan changes, a set, a whole plan (§8 §5: its lines too), the moves in rotation (saved-posts import,
 * Task 18: the coach's lines too): one line each, by the proposal — and the question it waits on. None current, or
 * none of the athlete's by that id: `{ id: null, startedAt: null, turns: [] }`. A rehearsal's is never read. ONE
 * statement (`turnsSql`): the runs with, per run, its last line, its question and its proposal's ops in brief, read in
 * SQL — never a whole state, a whole trail or a whole document.
 *
 * THE CONVERSATION SO FAR (`conversationBlock`): a later turn's opening message (design-context.ts) carries the turns
 * before it — at most CONTEXT_TURNS, the athlete's words and the coach's marked as data, one line per card with its id
 * and how it stands (so a reply like "make it 10 minutes" can name the suggestion it changes: propose_workout's
 * `replaces`), and a question left unanswered — in one statement more, never past CONVERSATION_BLOCK_MAX_CHARS.
 */
import { sql, type SQL } from "drizzle-orm";
import { addDays, dayLabel, dayRangeLabel, todayInZone } from "@rg/domain";
import { label } from "@rg/exercise-library";
import type { Db } from "./db.js";
import { markUntrusted } from "./design-prompt.js";
import { clipProse } from "./design-prose.js";
import { CHECK_ASKED } from "./design-tools/ask.js";
import { designProposalId } from "./design-tools/propose.js";
import { PINS_LINES_MAX, pinsCardLinesOf, pinsLineText, PLAN_LINES_MAX } from "./proposal-kinds.js";

/** A conversation goes quiet after this long with no new ask: the next ask (naming none) starts a new one. */
export const CONVERSATION_QUIET_HOURS = 18;
/** The turns a read answers, at most: the newest of them. */
export const CONVERSATION_TURNS_MAX = 20;
/** The turns before a run its opening message carries, at most. */
export const CONTEXT_TURNS = 6;
/** The conversation so far, at most (characters): the oldest turns are left out past it. */
export const CONVERSATION_BLOCK_MAX_CHARS = 8_000;
/** A conversation id as the routes take it: a run's id (`newId`), with room. */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,100}$/;

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConversationCard {
  /** `programme` (§8 §5): a change to a programme's settings, approved with one tap — one card a programme; `pins`
   * (saved-posts import, Task 18): the moves in rotation the coach would change, approved with one tap. */
  kind: "workout" | "plan_changes" | "set" | "plan" | "programme" | "pins";
  proposalId: string;
  title: string;
  /** One line: "Today · Now · 24 min · Maintain", "3 changes to your week", "3 workouts · Wed 13 – Fri 15 May",
   * "4 weeks · 4 sessions to start · race Sun 14 Jun". */
  summary: string;
  /** Its proposal's status: pending, partially_approved, approved, declined, superseded, expired. */
  status: string;
  /** A whole plan's (§8 §5): the thread coach's own manifest lines, at most 8, then "and N more"; a programme change's, a
   * line a setting and where its next sessions go; the moves in rotation's, the coach's own lines (at most 20), each as
   * one text ("Name: text", `pinsLineText`). */
  lines?: string[];
  /** The moves in rotation's lines, as the card draws them (the saves flow redesigned, §3.5): a move's name, set in bold
   * once, and the text — null for a general line or one stored before the redesign (a plain string). */
  pinLines?: Array<{ moveId?: string; name: string | null; text: string }>;
  /** A programme change's op (§8 §5): what its card approves and declines — a proposal may hold one a programme; the
   * moves in rotation's too. */
  opId?: string;
  /** A designed run's (§8 §3): a workout card whose body is a run — its steps, paces and the watch line (the manifest's). */
  sport?: "run";
}

export interface ConversationQuestion {
  /** The (first) question's words. */
  text: string;
  /** Its chips. */
  choices: string[];
  /** Every question asked (an ask holds one or two; the answer route takes one answer each). */
  questions: Array<{ text: string; choices: string[]; why: string | null }>;
  /** The coach asks for today's condition check: the app's own check answers it. */
  check?: true;
}

export interface ConversationTurn {
  runId: string;
  /** When the athlete asked. */
  at: string;
  /** The athlete's words, as they wrote them; null for a run asked with none. */
  words: string | null;
  status: string;
  /** The coach's line: its finish's words or its answer, a stop's own line; null while it works. */
  line: string | null;
  cards: ConversationCard[];
  /** The question the run waits on; null when it waits on none. */
  question: ConversationQuestion | null;
}

export interface ConversationDto {
  id: string | null;
  startedAt: string | null;
  turns: ConversationTurn[];
}

/** A proposal's op in brief, as `turnsSql` reads it. */
interface OpBrief {
  kind: "doc_workout" | "plan_adjust" | "plan_structure" | "programme_change" | "move_pins";
  date: string | null;
  time: string | null;
  atNow: number | null;
  title: string | null;
  minutes: number | null;
  effort: string | null;
  /** A designed workout's run's role: a set's designer's makes the proposal a set's. */
  by: string | null;
  /** A change's kind, and the session it changes as the plan held it. */
  change: string | null;
  row: string | null;
  outcome: string | null;
  reason: string | null;
  /** A designed workout's derived discipline: a run's card says so (§8 §3). */
  discipline?: string | null;
  /** A whole plan change's (§8 §5): its card's title and line, and its manifest lines. */
  planTitle?: string | null;
  planSummary?: string | null;
  lines?: unknown;
  /** A programme change's op id (§8 §5), and the moves in rotation's. */
  opId?: string | null;
}

interface ProposalBrief {
  id: string;
  title: string;
  status: string;
  ops: OpBrief[];
}

/** One run of the conversation, as the statement reads it. */
export interface TurnRow {
  cid: string;
  startedAt: string;
  id: string;
  request: string | null;
  status: string;
  error: string | null;
  scope: string | null;
  createdAt: string;
  settings: string | null;
  /** The question it waits on, unanswered (its event's summary and payload); null when it waits on none. */
  askedSummary: string | null;
  asked: string | null;
  line: string | null;
  proposal: string | null;
  prefs: string | null;
}

// ── The one statement ───────────────────────────────────────────────────────────────────────────────────────────────

const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
/** A proposal the athlete has never seen: never a card. */
const UNSEEN = new Set(["unreviewed", "rehearsal", "cancelled"]);
const NOT_REHEARSAL = (alias: string) =>
  sql.raw(`coalesce(CASE WHEN json_valid(${alias}.state) THEN json_extract(${alias}.state, '$.settings.rehearsal') END, 0) = 0`);
/** The conversation a main run is a turn of: its settings', else (made before conversations) its own id. */
const TURN_OF = (alias: string) =>
  sql.raw(`coalesce(CASE WHEN json_valid(${alias}.state) THEN json_extract(${alias}.state, '$.settings.conversationId') END, ${alias}.id)`);

/** The conversation the athlete is in now: their newest ask's, when it was asked under CONVERSATION_QUIET_HOURS ago. */
export function currentConversationSql(userId: string, now: Date): SQL {
  const since = new Date(now.getTime() - CONVERSATION_QUIET_HOURS * 3_600_000).toISOString();
  return sql`(SELECT ${TURN_OF("n")} FROM coach_runs n WHERE n.user_id = ${userId} AND n.parent_id IS NULL AND n.created_at >= ${since}
    AND ${NOT_REHEARSAL("n")} ORDER BY n.created_at DESC, n.id DESC LIMIT 1)`;
}

/** The conversation a run of the athlete's (any turn of it) is a turn of; none for another athlete's, or a rehearsal's. */
export function namedConversationSql(userId: string, runId: string): SQL {
  return sql`(SELECT ${TURN_OF("g")} FROM coach_runs g WHERE g.id = ${runId} AND g.user_id = ${userId} AND g.parent_id IS NULL AND ${NOT_REHEARSAL("g")})`;
}

const DESIGNED_PREFIX = designProposalId("");

/**
 * The conversation `conversation` (an expression naming it) — its newest `limit` runs, newest first, `exclude` left out
 * — with, per run, its last line (its finish's: the event its receipt or its loop marks `final`), the question it
 * waits on, and its proposal's ops in brief, read in SQL; and the athlete's preferences (their today). ONE statement.
 */
export async function conversationRows(db: Db, userId: string, conversation: SQL, o: { limit: number; exclude?: string }): Promise<TurnRow[]> {
  const op = (path: string) => sql.raw(`json_extract(o.value, '${path}')`);
  return (await db.all(sql`
    WITH c(cid) AS (SELECT ${conversation}),
      s(started) AS (SELECT r0.created_at FROM coach_runs r0, c WHERE r0.id = c.cid AND r0.user_id = ${userId})
    SELECT c.cid AS cid, s.started AS startedAt, r.id AS id, r.request AS request, r.status AS status, r.error AS error,
      r.scope AS scope, r.created_at AS createdAt,
      CASE WHEN json_valid(r.state) THEN json_extract(r.state, '$.settings') END AS settings,
      (SELECT CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload, '$.text'), e.summary) ELSE e.summary END
        FROM coach_run_events e WHERE e.run_id = r.id AND e.user_id = r.user_id AND e.kind = 'note' AND json_valid(e.payload)
          AND (json_extract(e.payload, '$.receipt.final') = 1 OR json_extract(e.payload, '$.final') = 1)
        ORDER BY e.seq DESC LIMIT 1) AS line,
      CASE WHEN json_valid(r.state) AND json_extract(r.state, '$.awaiting') IS NOT NULL AND json_extract(r.state, '$.awaitingKind') IS NULL
        THEN (SELECT q.summary FROM coach_run_events q WHERE q.run_id = r.id AND q.user_id = r.user_id AND q.kind = 'question' ORDER BY q.seq DESC LIMIT 1)
      END AS askedSummary,
      CASE WHEN json_valid(r.state) AND json_extract(r.state, '$.awaiting') IS NOT NULL AND json_extract(r.state, '$.awaitingKind') IS NULL
        THEN (SELECT q.payload FROM coach_run_events q WHERE q.run_id = r.id AND q.user_id = r.user_id AND q.kind = 'question' ORDER BY q.seq DESC LIMIT 1)
      END AS asked,
      (SELECT json_object('id', p.id, 'title', p.title, 'status', p.status, 'ops', json((SELECT json_group_array(json_object(
          'kind', ${op("$.kind")}, 'date', ${op("$.date")}, 'time', ${op("$.time")}, 'atNow', ${op("$.target.atNow")},
          'title', ${op("$.doc.title")}, 'minutes', ${op("$.derived.minutes")}, 'effort', ${op("$.doc.intent.effort")},
          'by', ${op("$.by.role")}, 'change', ${op("$.op.kind")}, 'row', ${op("$.row.title")},
          'outcome', ${op("$.outcome.status")}, 'reason', ${op("$.outcome.reason")}, 'discipline', ${op("$.derived.discipline")},
          'planTitle', ${op("$.title")}, 'planSummary', ${op("$.summary")}, 'lines', json(CASE WHEN ${op("$.kind")} IN ('plan_structure', 'programme_change', 'move_pins') THEN ${op("$.lines")} END),
          'opId', CASE WHEN ${op("$.kind")} IN ('programme_change', 'move_pins') THEN ${op("$.id")} END))
        FROM json_each(CASE WHEN json_valid(p.ops) THEN p.ops ELSE '[]' END) o WHERE ${op("$.kind")} IN ('doc_workout', 'plan_adjust', 'plan_structure', 'programme_change', 'move_pins'))))
        FROM coach_proposals p WHERE p.id = ${DESIGNED_PREFIX} || r.id AND p.user_id = r.user_id) AS proposal,
      (SELECT up.prefs FROM user_preferences up WHERE up.user_id = ${userId}) AS prefs
    FROM c, s, coach_runs r
    WHERE r.user_id = ${userId} AND r.parent_id IS NULL AND r.created_at >= s.started AND ${TURN_OF("r")} = c.cid
      ${o.exclude ? sql`AND r.id <> ${o.exclude}` : sql``}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${o.limit}
  `)) as TurnRow[];
}

// ── Reading it back ─────────────────────────────────────────────────────────────────────────────────────────────────

const parsed = (text: string | null): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The athlete's today, by the preferences read with the rows (UTC when they can't be read). */
function todayOf(prefsText: string | null, now: Date): string {
  const tz = (parsed(prefsText) as { timezone?: unknown } | null)?.timezone;
  try {
    return todayInZone(typeof tz === "string" && tz ? tz : "UTC", now);
  } catch {
    return todayInZone("UTC", now);
  }
}

/** The athlete's timezone, as `todayOf` reads it. */
function zoneOf(prefsText: string | null): string {
  const tz = (parsed(prefsText) as { timezone?: unknown } | null)?.timezone;
  try {
    if (typeof tz === "string" && tz) {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return tz;
    }
  } catch {
    // An unreadable zone is UTC.
  }
  return "UTC";
}

function proposalOf(text: string | null): ProposalBrief | null {
  const p = parsed(text) as Partial<ProposalBrief> | null;
  if (!p || typeof p.id !== "string" || typeof p.status !== "string") return null;
  const ops = (Array.isArray(p.ops) ? p.ops : []).filter((x): x is OpBrief => !!x && typeof x === "object");
  return { id: p.id, title: typeof p.title === "string" ? p.title : "", status: p.status, ops };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A day as a card names it: today, tomorrow, else its day's name. */
function dayWord(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return dayLabel(date);
}

/** A workout's line: "Today · Now · 24 min · Maintain". */
function workoutSummary(op: OpBrief, today: string): string {
  const when = op.atNow ? "Now" : str(op.time);
  const minutes = typeof op.minutes === "number" && Number.isFinite(op.minutes) ? `${Math.round(op.minutes)} min` : null;
  const effort = str(op.effort) ? label(op.effort!) : null;
  return [op.date ? dayWord(op.date, today) : null, when, minutes, effort].filter(Boolean).join(" · ");
}

/** Whether a proposal is a set's: its run planned a week or the next N, or a set's designer drafted in it. */
function isSet(scopeText: string | null, p: ProposalBrief): boolean {
  const kind = (parsed(scopeText) as { kind?: unknown } | null)?.kind;
  return kind === "week" || kind === "next_n" || p.ops.some((o) => o.kind === "doc_workout" && o.by === "designer");
}

/** A whole plan change's lines, as the statement read them: strings only, at most PLAN_LINES_MAX and its "and N more" —
 * or `max`. */
function planLinesOf(raw: unknown, max = PLAN_LINES_MAX + 1): string[] {
  const list = typeof raw === "string" ? parsed(raw) : raw;
  return (Array.isArray(list) ? list : []).filter((l): l is string => typeof l === "string").slice(0, max);
}

/**
 * A turn's cards (see the module comment): none for a proposal the athlete never saw. A set's proposal is one card;
 * otherwise each designed workout is one, and the changes to the plan one between them; a whole plan change (§8 §5) is
 * one card of its own, after them, with its lines — then each programme change, then the moves in rotation (Task 18).
 */
export function cardsOf(scopeText: string | null, p: ProposalBrief | null, today: string): ConversationCard[] {
  if (!p || UNSEEN.has(p.status)) return [];
  const workouts = p.ops.filter((o) => o.kind === "doc_workout");
  const changes = p.ops.filter((o) => o.kind === "plan_adjust");
  const base = { proposalId: p.id, status: p.status };
  const plans = p.ops
    .filter((o) => o.kind === "plan_structure")
    .map((o): ConversationCard => ({ kind: "plan", ...base, title: str(o.planTitle) ?? "A plan", summary: str(o.planSummary) ?? "", lines: planLinesOf(o.lines) }));
  // A programme change (§8 §5): one card each, after the plans — its own op approved and declined.
  const programmes = p.ops
    .filter((o) => o.kind === "programme_change")
    .map((o): ConversationCard => ({
      kind: "programme",
      ...base,
      title: str(o.planTitle) ?? "A programme",
      summary: str(o.planSummary) ?? "",
      lines: planLinesOf(o.lines),
      ...(str(o.opId) ? { opId: str(o.opId)! } : {}),
    }));
  // The moves in rotation (saved-posts import, Task 18): one card, last — its own op approved and declined, the coach's
  // own words and lines; each line a move's name and its text (§3.5), or a plain string stored before that.
  const pins = p.ops
    .filter((o) => o.kind === "move_pins")
    .map((o): ConversationCard => {
      const lines = pinsCardLinesOf(typeof o.lines === "string" ? parsed(o.lines) : o.lines).slice(0, PINS_LINES_MAX);
      return {
        kind: "pins",
        ...base,
        title: str(o.planTitle) ?? "Moves for your programme",
        summary: str(o.planSummary) ?? "",
        lines: lines.map(pinsLineText),
        pinLines: lines.map((l) => ({ ...(l.moveId ? { moveId: l.moveId } : {}), name: l.name ?? null, text: l.text })),
        ...(str(o.opId) ? { opId: str(o.opId)! } : {}),
      };
    });
  const changesCard = (): ConversationCard[] => {
    if (changes.length === 0) return [];
    const inWeek = changes.every((c) => !c.date || c.date <= addDays(today, 6));
    return [{ kind: "plan_changes", ...base, title: "Changes to your plan", summary: `${plural(changes.length, "change")} to your ${inWeek ? "week" : "plan"}` }];
  };
  if (workouts.length > 0 && isSet(scopeText, p)) {
    const days = workouts.flatMap((w) => (w.date ? [w.date] : [])).sort();
    const what = `${plural(workouts.length, "workout")}${changes.length > 0 ? ` and ${plural(changes.length, "change")}` : ""}`;
    return [{ kind: "set", ...base, title: p.title || "Your week", summary: days.length > 0 ? `${what} · ${dayRangeLabel(days[0]!, days.at(-1)!)}` : what }, ...plans, ...programmes, ...pins];
  }
  return [
    ...workouts.map((w): ConversationCard => ({
      kind: "workout",
      ...base,
      title: str(w.title) ?? "A workout",
      summary: workoutSummary(w, today),
      ...(w.discipline === "run" ? { sport: "run" as const } : {}),
    })),
    ...changesCard(),
    ...plans,
    ...programmes,
    ...pins,
  ];
}

/** The question a run waits on, from its question event's payload (ask.ts's `data`). */
export function questionOf(payloadText: string | null): ConversationQuestion | null {
  const data = (parsed(payloadText) as { data?: unknown } | null)?.data as { questions?: unknown; check?: unknown } | undefined;
  if (!data) return null;
  if (data.check === "condition") return { text: CHECK_ASKED, choices: [], questions: [], check: true };
  const qs = (Array.isArray(data.questions) ? data.questions : []).flatMap((q) => {
    const x = q as { text?: unknown; chips?: unknown; why?: unknown };
    if (typeof x.text !== "string") return [];
    const choices = Array.isArray(x.chips) ? x.chips.filter((c): c is string => typeof c === "string") : [];
    return [{ text: x.text, choices, why: typeof x.why === "string" ? x.why : null }];
  });
  const first = qs[0];
  return first ? { text: first.text, choices: first.choices, questions: qs } : null;
}

/** The status a turn shows: a run waiting on its reviewer or its set is at work. */
const shownStatus = (status: string): string => (status === "waiting_review" || status === "waiting_set" ? "active" : status);

/** A line for a run that is over without a finish of its own (coach-runs.ts `endedLine`, handed in: no cycle). */
export type EndedLine = (
  status: string,
  error: string | null,
  settings:
    | { window?: { kind: "day"; date: string } | { kind: "until"; at: string }; ceilingMicros: number; setCeilingMicros?: number; raisedAt?: string; planRaisedAt?: string }
    | undefined,
) => string | null;

/** One run as a turn. */
function turnOf(row: TurnRow, today: string, endedLine: EndedLine): ConversationTurn {
  const live = LIVE.includes(row.status);
  const settings = parsed(row.settings) as Parameters<EndedLine>[2] | null;
  const line = live ? null : row.status === "finished" ? str(row.line) : endedLine(row.status, row.error, settings ?? undefined);
  return {
    runId: row.id,
    at: row.createdAt,
    words: row.request,
    status: shownStatus(row.status),
    line,
    cards: cardsOf(row.scope, proposalOf(row.proposal), today),
    question: row.status === "waiting_athlete" ? questionOf(row.asked) : null,
  };
}

/**
 * The conversation `id` names — or, with none, the athlete's current one (see the module comment). ONE statement.
 */
export async function readConversation(db: Db, userId: string, now: Date, o: { id?: string; endedLine: EndedLine }): Promise<ConversationDto> {
  const conversation = o.id === undefined ? currentConversationSql(userId, now) : namedConversationSql(userId, o.id);
  const rows = await conversationRows(db, userId, conversation, { limit: CONVERSATION_TURNS_MAX });
  const first = rows[0];
  if (!first) return { id: null, startedAt: null, turns: [] };
  const today = todayOf(first.prefs, now);
  return { id: first.cid, startedAt: first.startedAt, turns: rows.reverse().map((r) => turnOf(r, today, o.endedLine)) };
}

// ── The conversation so far, in a later turn's opening message ─────────────────────────────────────────────────────

const WORDS_MAX = 300;
const LINE_MAX = 300;
const TITLE_MAX = 80;
const CARDS_SHOWN = 3;
const QUESTION_MAX = 200;

/** How a card stands, in words: a workout's own outcome when it has one, else its proposal's status. */
function standing(status: string, outcome?: string | null, reason?: string | null): string {
  if (outcome === "applied") return "approved";
  if (outcome === "declined") return "declined";
  if (outcome === "superseded") return reason && reason.startsWith("Changed") ? "replaced by a later change" : "replaced by a newer plan";
  switch (status) {
    case "pending":
      return "still open";
    case "partially_approved":
      return "approved in part, the rest still open";
    case "approved":
      return "approved";
    case "declined":
      return "declined";
    case "superseded":
      return "replaced by a newer suggestion";
    case "expired":
      return "expired unapproved";
    default:
      return status;
  }
}

const ENDED_WORDS: Record<string, string> = {
  cancelled: "The athlete cancelled it.",
  expired: "It expired before it finished.",
  stopped_cap: "The coach stopped before it finished (a limit).",
  failed: "The coach stopped before it finished.",
};

/** When a turn was asked, in the athlete's zone: "Wed 13 May, 09:30" — one formatter for the whole block (CPU). */
function whenWords(clock: Intl.DateTimeFormat, at: string): string {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return at;
  const p = Object.fromEntries(clock.formatToParts(when).map((x) => [x.type, x.value]));
  return `${dayLabel(`${p.year}-${p.month}-${p.day}`)}, ${p.hour}:${p.minute}`;
}

/** One turn, as the opening message carries it. */
function turnLines(row: TurnRow, today: string, clock: Intl.DateTimeFormat): string[] {
  const time = whenWords(clock, row.createdAt);
  const words = row.request ? markUntrusted("athlete", clipProse(row.request.replace(/\s+/g, " ").trim(), WORDS_MAX)) : "(no words: a quick tap)";
  const out = [`- ${time} — the athlete: ${words}`];
  const line = str(row.line);
  if (row.status === "finished") out.push(`  The coach: ${line ? markUntrusted("main coach", clipProse(line.replace(/\s+/g, " ").trim(), LINE_MAX)) : "(finished)"}`);
  else if (ENDED_WORDS[row.status]) out.push(`  ${ENDED_WORDS[row.status]}`);
  else out.push("  (still at work)");
  const p = proposalOf(row.proposal);
  const cards = cardsOf(row.scope, p, today);
  // A single run's workout cards are its workouts, in order (`cardsOf`).
  const workouts = (p?.ops ?? []).filter((o) => o.kind === "doc_workout");
  for (const [i, card] of cards.slice(0, CARDS_SHOWN).entries()) {
    const title = markUntrusted("main coach", clipProse(card.title, TITLE_MAX));
    if (card.kind === "workout") {
      const op = workouts[i];
      out.push(`  Suggested a workout (id ${card.proposalId}): ${title} · ${card.summary} — ${standing(card.status, op?.outcome, op?.reason)}`);
    } else if (card.kind === "set") {
      out.push(`  Suggested a set (id ${card.proposalId}): ${title} · ${card.summary} — ${standing(card.status)}`);
    } else if (card.kind === "programme") {
      // A programme change (§8 §5): its title names the athlete's programme; how it stands is its op's.
      const g = p!.ops.find((o) => o.kind === "programme_change" && o.opId === card.opId);
      const how = g?.outcome === "applying" ? "being applied" : standing(card.status, g?.outcome, g?.reason);
      out.push(`  Suggested a programme change (id ${card.proposalId}): ${title} · ${clipProse(card.summary, TITLE_MAX)} — ${how}`);
    } else if (card.kind === "pins") {
      // The moves in rotation (Task 18): its title and line are the coach's words; how it stands is its op's.
      const g = p!.ops.find((o) => o.kind === "move_pins" && o.opId === card.opId);
      out.push(
        `  Suggested moves for the engine's pool (id ${card.proposalId}): ${title} · ${markUntrusted("main coach", clipProse(card.summary, TITLE_MAX))} — ${g?.outcome === "applying" ? "being applied" : standing(card.status, g?.outcome, g?.reason)}`,
      );
    } else if (card.kind === "plan") {
      // A whole plan (§8 §5): its title and line are the coach's words; how it stands is its op's.
      const plan = p!.ops.find((o) => o.kind === "plan_structure");
      const how = plan?.outcome === "applying" ? "being added, part of it already on the plan" : standing(card.status, plan?.outcome, plan?.reason);
      out.push(`  Suggested a plan (id ${card.proposalId}): ${title} · ${markUntrusted("main coach", clipProse(card.summary, TITLE_MAX))} — ${how}`);
    } else {
      const what = p!.ops
        .filter((o) => o.kind === "plan_adjust")
        .slice(0, 4)
        .map((o) => `${o.change ?? "change"} ${markUntrusted("athlete", clipProse(str(o.row) ?? "a session", 60))}${o.date ? ` (${dayLabel(o.date)})` : ""}`)
        .join("; ");
      out.push(`  Suggested ${card.summary} (id ${card.proposalId}): ${what} — ${standing(card.status)}`);
    }
  }
  if (cards.length > CARDS_SHOWN) out.push(`  … and ${cards.length - CARDS_SHOWN} more.`);
  // A question the run ended without an answer to (a cancel, an expiry while it waited): the athlete's next words may be it.
  const asked = LIVE.includes(row.status) ? null : questionOf(row.asked);
  if (asked) {
    const chips = asked.choices.length > 0 ? ` (${asked.choices.map((c) => clipProse(c, 40)).join(" · ")})` : "";
    out.push(`  The coach asked, not answered: ${markUntrusted("main coach", clipProse(asked.text, QUESTION_MAX))}${chips}`);
  }
  return out;
}

/**
 * The conversation so far, for a later turn's opening message (see the module comment): `rows` newest first, as
 * `conversationRows` reads them. Null when there is none. Never past CONVERSATION_BLOCK_MAX_CHARS: the oldest turns are
 * left out first.
 */
export function conversationBlock(rows: readonly TurnRow[], now: Date): string | null {
  if (rows.length === 0) return null;
  const today = todayOf(rows[0]!.prefs, now);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zoneOf(rows[0]!.prefs),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const head =
    "The conversation so far — the turns before this request, oldest first. The athlete's words and the coach's own are marked as data. To change a suggestion still open, name its id in propose_workout's replaces.";
  let turns = [...rows].reverse().map((r) => turnLines(r, today, clock).join("\n"));
  const size = (ts: string[]) => [head, ...ts].join("\n").length;
  // One turn always fits (each of its lines is clipped: about 2,500 characters at most), so the block is never cut —
  // a cut could leave a marked block open.
  while (turns.length > 1 && size(turns) > CONVERSATION_BLOCK_MAX_CHARS) turns = turns.slice(1);
  return [head, ...turns].join("\n");
}
