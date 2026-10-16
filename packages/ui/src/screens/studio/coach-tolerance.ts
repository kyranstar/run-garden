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
  type CoachOpenProposalDto,
  type CoachRunCurrentResponse,
  type CoachRunDto,
  type CoachRunEventDto,
  type CoachRunStatus,
  type CoachRunStepResult,
  type DesignChangeLineDto,
  type DesignLineDto,
} from "@rg/api-client";

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
  };
}

/** A run's read (`GET /api/coach/runs/:id`). */
export function toRunRead(v: unknown): { run: CoachRunDto; events: CoachRunEventDto[] } {
  const r = record(v) ?? {};
  return { run: toRun(r.run), events: toEvents(r.events) };
}

/** The current run's read: no run unless one with an id came. */
export function toCurrent(v: unknown): CoachRunCurrentResponse {
  const r = record(v);
  const run = record(r?.run);
  if (!r || !run || typeof run.id !== "string" || !run.id) return { run: null };
  const p = record(r.proposal);
  const proposal: CoachOpenProposalDto | null = p && typeof p.id === "string" && p.id ? { id: p.id, status: text(p.status), flags: texts(p.flags) } : null;
  return { run: toRun(run), events: toEvents(r.events), proposal };
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

function toLine(v: unknown): DesignLineDto | null {
  const l = record(v);
  if (!l || typeof l.opId !== "string" || !l.opId) return null;
  const written = record(l.written);
  const outcome = toOutcome(l.outcome);
  return {
    ...(l as unknown as DesignLineDto),
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
    detail: texts(l.detail),
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

/** A suggestion's read, every line and change with the fields the card reads. */
export function toProposal(v: unknown): ProposalRead {
  const r = record(v) ?? {};
  const lines = list(r.lines).map(toLine).filter((l): l is DesignLineDto => l !== null);
  const changes = list(r.changes).map(toChange).filter((c): c is DesignChangeLineDto => c !== null);
  return {
    id: text(r.id),
    status: text(r.status) as ProposalRead["status"],
    resolvedAt: textOrNull(r.resolvedAt),
    ...(r.lines !== undefined ? { lines } : {}),
    ...(r.changes !== undefined ? { changes } : {}),
  };
}

/** A suggestion, read and made safe to show: what the card and the Studio share under one query key. */
export const readProposal = async (id: string): Promise<ProposalRead> => toProposal(await api.coachProposal(id));

/** The current run, read and made safe to show. */
export const readCurrent = async (): Promise<CoachRunCurrentResponse> => toCurrent(await api.coachRunCurrent());
