/**
 * THE COACH'S ANSWERS, READ TOLERANTLY (the owner's robustness request, 2026-10-16). A server deployed after this bundle
 * may answer with a status, an event kind, an op kind or a field this code has never seen, and a broken or cut-off
 * answer may lack a field it always had. Everything the coach's screens read from the server comes through here first:
 *
 *  - a known shape passes as it is;
 *  - a missing list is empty, a missing text is empty or null, a number that isn't one is null (or 0 for a spend);
 *  - an unknown status, kind or code passes as its own word: the screens render it generically and never throw;
 *  - an event with no seq is dropped (it can't be ordered or merged), every other event is kept.
 *
 * Pure, no React: the step loop's reads, the current run's read and a suggestion's read all use it.
 */
import {
  api,
  type CoachAlsoOpenDto,
  type CoachConversationCardDto,
  type CoachConversationDto,
  type CoachConversationTurnDto,
  type CoachOpenProposalDto,
  type CoachRunCurrentResponse,
  type CoachRunDto,
  type CoachRunEventDto,
  type CoachRunStatus,
  type CoachRunStepResult,
  type DesignAlternateDto,
  type DesignChangeLineDto,
  type DesignContextRowDto,
  type DesignLineDto,
  type DesignPlanLineDto,
} from "@rg/api-client";

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Words worth showing: a text with something in it, trimmed; else null. */
const words = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** "YYYY-MM-DD", nothing else. */
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A run as the screens read it: every field its type promises, whatever came. */
export function toRun(v: unknown): CoachRunDto {
  const r = record(v) ?? {};
  const scope = record(r.scope);
  const kind = typeof scope?.kind === "string" ? (scope.kind as CoachRunDto["scope"]["kind"]) : "now";
  return {
    id: text(r.id),
    role: (typeof r.role === "string" ? r.role : "main") as CoachRunDto["role"],
    scope: num(scope?.n) !== null ? { kind, n: num(scope?.n)! } : { kind },
    request: textOrNull(r.request),
    // An unknown status passes as its own word: the run view says it plainly, and nothing steps it.
    status: (typeof r.status === "string" && r.status ? r.status : "active") as CoachRunStatus,
    steps: num(r.steps) ?? 0,
    costUsd: num(r.costUsd) ?? 0,
    proposalId: textOrNull(r.proposalId) || null,
    error: textOrNull(r.error),
    createdAt: text(r.createdAt),
    updatedAt: text(r.updatedAt),
    finishedAt: textOrNull(r.finishedAt),
    estimateUsd: num(r.estimateUsd),
    ceilingUsd: num(r.ceilingUsd),
  };
}

/** A run's events: those with a seq to order them by, each with a text summary; any kind and any payload. */
export function toEvents(v: unknown): CoachRunEventDto[] {
  return list(v).flatMap((x): CoachRunEventDto[] => {
    const e = record(x);
    const seq = num(e?.seq);
    if (!e || seq === null) return [];
    return [{ seq, kind: text(e.kind) as CoachRunEventDto["kind"], summary: text(e.summary), payload: e.payload ?? null, at: text(e.at) }];
  });
}

/** A step's answer: a `nextDue` that can't be read is none (the loop then reads the run to learn what is next). */
export function toStepResult(v: unknown): CoachRunStepResult {
  const r = record(v) ?? {};
  const due = record(r.nextDue);
  const at = text(due?.at);
  return {
    status: (typeof r.status === "string" && r.status ? r.status : "active") as CoachRunStatus,
    nextDue: due && at && Number.isFinite(Date.parse(at)) ? { runId: text(due.runId), role: (text(due.role) || "main") as CoachRunDto["role"], at } : null,
    events: toEvents(r.events),
    // Armed only when the server says so in so many words: anything else is the step itself.
    ...(r.armed === true ? { armed: true as const } : {}),
  };
}

/** A run's read (`GET /api/coach/runs/:id`). */
export function toRunRead(v: unknown): { run: CoachRunDto; events: CoachRunEventDto[] } {
  const r = record(v) ?? {};
  return { run: toRun(r.run), events: toEvents(r.events) };
}

/** The other suggestions still open (Task 13, R2): each with an id and a day; its title, time and count as they read. */
function toAlsoOpen(v: unknown): CoachAlsoOpenDto[] {
  return list(v).flatMap((x): CoachAlsoOpenDto[] => {
    const a = record(x);
    if (!a || typeof a.proposalId !== "string" || !a.proposalId || !isDay(a.date)) return [];
    const time = typeof a.time === "string" && /^\d{1,2}:\d{2}/.test(a.time) ? a.time : null;
    const items = num(a.items);
    return [
      {
        proposalId: a.proposalId,
        title: words(a.title) ?? "A suggestion",
        date: a.date,
        time,
        items: items !== null && items > 0 ? Math.round(items) : 1,
        // Now only when the server says so in so many words (round 2, Minor 11).
        ...(a.atNow === true ? { atNow: true as const } : {}),
      },
    ];
  });
}

/** The current run's read: no run unless one with an id came; the other open suggestions whenever they came. */
export function toCurrent(v: unknown): CoachRunCurrentResponse {
  const r = record(v);
  const run = record(r?.run);
  const also = r && r.alsoOpen !== undefined ? { alsoOpen: toAlsoOpen(r.alsoOpen) } : {};
  if (!r || !run || typeof run.id !== "string" || !run.id) return { run: null, ...also };
  const p = record(r.proposal);
  const proposal: CoachOpenProposalDto | null = p && typeof p.id === "string" && p.id ? { id: p.id, status: text(p.status), flags: texts(p.flags) } : null;
  return { run: toRun(run), events: toEvents(r.events), proposal, ...also };
}

/** A suggestion's read (`GET /api/coach/proposals/:id`). */
export type ProposalRead = Awaited<ReturnType<typeof api.coachProposal>>;

/** An outcome as the card reads it: an object with a status, the texts it reads texts; anything else none. */
function toOutcome(v: unknown): Record<string, unknown> | null {
  const o = record(v);
  if (!o || typeof o.status !== "string") return null;
  const out: Record<string, unknown> = { ...o, at: text(o.at) };
  if ("reason" in o) out.reason = typeof o.reason === "string" ? o.reason : undefined;
  if (o.status === "refused") Object.assign(out, { error: text(o.error), why: text(o.why) });
  if (o.status === "applied" || o.status === "applying") {
    const before = record(o.before);
    if (o.status === "applied") out.workoutId = text(o.workoutId);
    if (before) out.before = { date: text(before.date), time: text(before.time), title: text(before.title), minutes: num(before.minutes) };
    else if (o.status === "applying" || "before" in o) out.before = null;
  }
  return out;
}

function toReview(v: unknown): DesignLineDto["review"] {
  const r = record(v);
  if (!r) return null;
  return {
    dimensions: list(r.dimensions).flatMap((x) => {
      const d = record(x);
      if (!d) return [];
      return [{ id: text(d.id), label: text(d.label) || text(d.id), score: num(d.score), note: textOrNull(d.note) }];
    }),
    mustFix: texts(r.mustFix),
    improvements: texts(r.improvements),
    changes: texts(r.changes),
    accepted: texts(r.accepted),
    rounds: num(r.rounds) ?? 0,
    note: textOrNull(r.note),
  };
}

const toIssues = (v: unknown): Array<{ code: string; message: string }> =>
  list(v).flatMap((x) => {
    const i = record(x);
    return i && typeof i.message === "string" ? [{ code: text(i.code), message: i.message }] : [];
  });

/** The moves weighed instead of one: each with a name, its why words or none. */
const toAlternates = (v: unknown): DesignAlternateDto[] =>
  list(v).flatMap((x) => {
    const a = record(x);
    const name = words(a?.name);
    return name ? [{ name, why: words(a!.why) }] : [];
  });

function toLine(v: unknown): DesignLineDto | null {
  const l = record(v);
  if (!l || typeof l.opId !== "string" || !l.opId) return null;
  const written = record(l.written);
  const outcome = toOutcome(l.outcome);
  // The whys and the alternates as the moves are (parallel to `detail`), whatever came: a missing one none.
  const detail = texts(l.detail);
  const whys = list(l.whys);
  const alternates = list(l.alternates);
  const { atNow: _atNow, ...rest } = l;
  return {
    ...(rest as unknown as DesignLineDto),
    opId: l.opId,
    kind: (text(l.kind) || "new") as DesignLineDto["kind"],
    date: text(l.date),
    time: textOrNull(l.time),
    title: text(l.title) || "Workout",
    minutes: num(l.minutes) ?? 0,
    summary: text(l.summary),
    effort: text(l.effort),
    place: text(l.place),
    parts: texts(l.parts),
    detail,
    intent: words(l.intent),
    whys: detail.map((_, i) => words(whys[i])),
    alternates: detail.map((_, i) => toAlternates(alternates[i])),
    // Now only when the server says so in so many words.
    ...(l.atNow === true ? { atNow: true as const } : {}),
    reviewMean: num(l.reviewMean),
    review: toReview(l.review),
    issues: toIssues(l.issues),
    outcome: outcome as DesignLineDto["outcome"],
    written: written
      ? {
          date: text(written.date) || text(l.date),
          time: text(written.time),
          title: text(written.title),
          minutes: num(written.minutes) ?? num(l.minutes) ?? 0,
          summary: text(written.summary),
          edited: written.edited === true,
          moved: written.moved === true,
        }
      : null,
  };
}

function toChange(v: unknown): DesignChangeLineDto | null {
  const c = record(v);
  if (!c || typeof c.opId !== "string" || !c.opId) return null;
  return {
    ...(c as unknown as DesignChangeLineDto),
    opId: c.opId,
    // An op kind this bundle doesn't know reads as a change ("Changed · was …").
    kind: (text(c.kind) || "adjust") as DesignChangeLineDto["kind"],
    workoutId: text(c.workoutId),
    date: textOrNull(c.date) || null,
    time: textOrNull(c.time),
    summary: text(c.summary) || "A change to your plan",
    was: textOrNull(c.was),
    effect: textOrNull(c.effect),
    why: text(c.why),
    issues: toIssues(c.issues),
    outcome: toOutcome(c.outcome) as DesignChangeLineDto["outcome"],
  };
}

/**
 * A set's other row on the plan: one with a day and a title to say — a rest day with none says "Rest" — its time and
 * minutes when they can be read.
 */
function toContextRow(v: unknown): DesignContextRowDto | null {
  const c = record(v);
  const title = words(c?.title) ?? (c?.kind === "rest" ? "Rest" : null);
  if (!c || !isDay(c.date) || !title) return null;
  const time = typeof c.time === "string" && /^\d{1,2}:\d{2}/.test(c.time) ? c.time : null;
  const minutes = num(c.minutes);
  return { date: c.date, time, kind: text(c.kind), title, minutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null };
}

/** A suggestion's read, every line and change with the fields the card reads. */
/** A whole plan change's line (§8 §5): its id or nothing; its texts texts; its outcome by its status, its own texts read. */
function toPlanLine(v: unknown): DesignPlanLineDto | null {
  const p = record(v);
  if (!p || typeof p.opId !== "string" || !p.opId) return null;
  const o = record(p.outcome);
  const progress = record(o?.progress);
  const outcome: DesignPlanLineDto["outcome"] =
    o?.status === "applied"
      ? { status: "applied", at: text(o.at), summary: text(o.summary) }
      : o?.status === "applying"
        ? { status: "applying", at: text(o.at), progress: progress ? { step: text(progress.step), done: num(progress.done) ?? 0 } : null }
        : o?.status === "refused"
          ? { status: "refused", at: text(o.at), error: text(o.error), why: text(o.why) }
          : o?.status === "declined"
            ? { status: "declined", at: text(o.at), ...(typeof o.reason === "string" ? { reason: o.reason } : {}) }
            : o?.status === "superseded"
              ? { status: "superseded", at: text(o.at), reason: text(o.reason), by: text(o.by) }
              : null;
  return {
    opId: p.opId,
    kind: text(p.kind),
    title: words(p.title) ?? "A plan",
    summary: text(p.summary),
    lines: texts(p.lines),
    why: text(p.why),
    issues: list(p.issues).flatMap((x) => {
      const i = record(x);
      return i && typeof i.message === "string" ? [{ code: text(i.code), message: i.message }] : [];
    }),
    outcome,
  };
}

export function toProposal(v: unknown): ProposalRead {
  const r = record(v) ?? {};
  const plans = list(r.plans).map(toPlanLine).filter((p): p is DesignPlanLineDto => p !== null);
  const lines = list(r.lines).map(toLine).filter((l): l is DesignLineDto => l !== null);
  const changes = list(r.changes).map(toChange).filter((c): c is DesignChangeLineDto => c !== null);
  const context = list(r.context).map(toContextRow).filter((c): c is DesignContextRowDto => c !== null);
  return {
    id: text(r.id),
    status: text(r.status) as ProposalRead["status"],
    resolvedAt: textOrNull(r.resolvedAt),
    ...(r.lines !== undefined ? { lines } : {}),
    ...(r.changes !== undefined ? { changes } : {}),
    ...(r.plans !== undefined ? { plans } : {}),
    ...(r.context !== undefined ? { context } : {}),
  };
}

/** A suggestion, read and made safe to show: what the card and the Studio share under one query key. */
export const readProposal = async (id: string): Promise<ProposalRead> => toProposal(await api.coachProposal(id));

/** The current run, read and made safe to show. */
export const readCurrent = async (): Promise<CoachRunCurrentResponse> => toCurrent(await api.coachRunCurrent());

// ── The conversation (the new shape §5) ──

type Turn = CoachConversationTurnDto;
type Question = NonNullable<Turn["question"]>;

/** A question's words and choices; none without words. A two-question ask and a check pass through. */
function toQuestion(v: unknown): Question | null {
  const q = record(v);
  const t = words(q?.text);
  if (!q || !t) return null;
  const questions = Array.isArray(q.questions)
    ? q.questions.flatMap((x): NonNullable<Question["questions"]> => {
        const one = record(x);
        const qt = words(one?.text);
        if (!one || !qt) return [];
        return [{ text: qt, choices: texts(one.choices), ...(typeof one.why === "string" ? { why: one.why } : {}) }];
      })
    : null;
  return {
    text: t,
    choices: texts(q.choices),
    ...(questions && questions.length > 0 ? { questions } : {}),
    ...(q.check === true ? { check: true as const } : {}),
  };
}

/** A card: its suggestion's id, or nothing; an unknown kind passes as its own word (shown as one line). */
function toCard(v: unknown): CoachConversationCardDto | null {
  const c = record(v);
  if (!c || typeof c.proposalId !== "string" || !c.proposalId) return null;
  return {
    kind: (text(c.kind) || "workout") as CoachConversationCardDto["kind"],
    proposalId: c.proposalId,
    title: words(c.title) ?? "A suggestion",
    summary: text(c.summary),
    status: text(c.status),
    // A plan's lines (§8 §5): texts only.
    ...(Array.isArray(c.lines) ? { lines: texts(c.lines) } : {}),
  };
}

/** One turn: a run's id or nothing; every list there, every text a text. */
function toTurn(v: unknown): Turn | null {
  const t = record(v);
  if (!t || typeof t.runId !== "string" || !t.runId) return null;
  return {
    runId: t.runId,
    at: text(t.at),
    words: textOrNull(t.words),
    status: (typeof t.status === "string" && t.status ? t.status : "finished") as CoachRunStatus,
    line: textOrNull(t.line),
    cards: list(t.cards).map(toCard).filter((c): c is CoachConversationCardDto => c !== null),
    question: toQuestion(t.question),
  };
}

/** The conversation's read: no conversation unless turns came; the turns that can be shown, oldest first. */
export function toConversation(v: unknown): CoachConversationDto {
  const r = record(v);
  return {
    id: textOrNull(r?.id) || null,
    startedAt: textOrNull(r?.startedAt),
    turns: list(r?.turns).map(toTurn).filter((t): t is Turn => t !== null),
  };
}

/** The current conversation, read and made safe to show. */
export const readConversation = async (): Promise<CoachConversationDto> => toConversation(await api.coachConversation());
