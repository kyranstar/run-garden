/**
 * APPROVING A DESIGNED WORKOUT'S PROPOSAL, ALL OR SOME (Stage 3 spec §8; Task 8).
 *
 * THE STUDIO'S OWN SERVICE. Each op the athlete approves is written through the path the Studio's Schedule and Save
 * use (doc-workouts.ts; Stage 2 spec §10): `createDocWorkout` for a new workout, `reviseDocWorkout` for a revision of a
 * planned one. So it is judged again for its day by the server's own rules — the day's reading as a save reads it
 * (`slotChecks`), what was done cleanly, the recent sessions, the moves set aside, the place's gear (`docDayContext`;
 * the coach proposed against the same day, one rule: design-approve.test.ts holds the two together) — and its watch and
 * calendar are queued exactly as a Studio save queues them: a new workout `calendar_only` with no watch address and its
 * event `not_created` for the reconciler to book, a revision's event marked to update when what it shows changed; only
 * the athlete's Send ever puts one on the watch. Nothing here calls Google or COROS.
 *
 * Each workout is stamped `basedOn: { kind: "proposal", id, opId }`; its revision row says who wrote it — the coach
 * (`coach`), or the athlete who edited the coach's draft (`athlete_edit`) — and for which op (`approvalRef`).
 *
 * FATAL ONLY WHEN WRONG, OP BY OP. An op the server refuses today is refused with its reason, and the others still
 * apply: a day gone (`past_date`), a base changed since the coach read it (`stale_revision`), a resolved row or a
 * programme's session (`not_editable`), a workout removed since (`not_found`), a hard rule the day now refuses or a move
 * the library no longer has (`invalid_doc`, with the validator's errors), a run (`run_unsupported`), a restore under way
 * (`restore_in_progress`). A refused op stays open: the day can change, and the athlete can edit it.
 *
 * WHAT IS KEPT. Each op keeps its outcome (`outcome`) for read_proposals and the UI: applied — its workout, the
 * revision written, and `edited` when the athlete changed the coach's draft; refused — why; declined — the athlete's
 * words, if any. The coach's own document stays as it proposed it. The proposal is `approved` once every op applied,
 * `partially_approved` while some have (still the athlete's to finish), `declined` when every op was, else `pending`
 * (`statusOfOps`). The write is guarded by the status and the ops it read: two requests that race never lose an outcome
 * (the second is refused, `ProposalChangedError`, and asks again — everything here is idempotent).
 *
 * IDEMPOTENT. An op that applied is never applied again, and a decided one is reported as it was decided (`settled`) —
 * so is every op of a proposal decided whole (approved, declined), writing nothing; one no longer the athlete's
 * (expired, superseded, never shown) is refused (`NotOpenError`). A
 * crash between a workout's write and the proposal's is found again: a new workout by its key (`createDocWorkout`'s
 * `clientId`, made from the proposal and the op), a revision by its revision row (the one after the coach's base,
 * written for this op).
 *
 * ONE REQUEST, ≤ 45 STATEMENTS. A request applies ops while their declared costs fit what its fixed part leaves
 * (`APPROVE_FIXED`; each op's cost measured on a busy account, design-approve-routes.test.ts); the rest come back as
 * `remaining`, for the client to ask again with. The first op is always applied, so every request moves on. A set of
 * seven new workouts placed by the athlete's window approves in four requests.
 *
 * EDIT BEFORE APPROVE (`edit`). The builder saves the athlete's version of ONE op's draft: approved through the same
 * path, marked `edited` when it differs from the coach's (compared as the builder compares two documents), a new
 * workout's day and time the athlete's. It answers as a Studio save answers: a refusal is thrown as the Studio's own
 * error, for the route to answer as `POST /api/workouts` and `PUT /api/workouts/:id/doc` do, and nothing is recorded —
 * the coach's draft stays open.
 *
 * DECLINE (`declineDesignOps`). The proposal, or the chosen ops, declined; the athlete's reason — their own words, data
 * only — kept on each op for read_proposals. An op that applied is never declined.
 *
 * THE THREAD. Approving writes one plain receipt in the thread once nothing of the request remains — the workouts
 * approved, each by its day, title and minutes, and any not approved with why (design-manifest.ts) — and a decline that
 * declines the whole proposal says "Left as planned", as the thread's own does. A receipt that fails never fails the
 * approve: the workouts are written by then.
 */
import { and, eq, sql } from "drizzle-orm";
import { coachMessages, coachProposals, plannedWorkouts, workoutDocRevisions } from "@rg/database";
import { newId, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, startEditing, toProposable, type DocDerived, type DocIssue } from "@rg/workout";
import type { Db } from "./db.js";
import {
  createDocWorkout,
  DocInvalidError,
  DocWorkoutNotFoundError,
  NotEditableError,
  PastDateError,
  reviseDocWorkout,
  RunUnsupportedError,
  StaleRevisionError,
  type DocWorkoutCtx,
  type DocWorkoutDto,
  type DocWriteSource,
} from "./doc-workouts.js";
import { receiptLine } from "./design-manifest.js";
import type { DocWorkoutOp, DocWorkoutTarget } from "./design-tools/propose.js";
import { RestoreInProgressError } from "./programs.js";
import { isDocWorkoutOp, opIdOf } from "./proposal-kinds.js";

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the server refused an op today: the Studio's own error names. */
export type RefusalCode = "past_date" | "stale_revision" | "not_editable" | "not_found" | "invalid_doc" | "run_unsupported" | "restore_in_progress";

/** A validator's issue, as an answer carries it. */
export type IssueOut = Pick<DocIssue, "path" | "code" | "message" | "severity"> & { fix?: string };
const issueOut = (i: DocIssue): IssueOut => ({ path: i.path, code: i.code, message: i.message, severity: i.severity, ...(i.fix !== undefined ? { fix: i.fix } : {}) });

/** How an op ended (see the module comment). Absent while it is the athlete's to decide. */
export type OpOutcome =
  | { status: "applied"; at: string; workoutId: string; rev: number | null; edited?: true }
  | { status: "refused"; at: string; error: RefusalCode; why: string; issues?: IssueOut[] }
  | { status: "declined"; at: string; reason?: string };

/** A designed workout's op as a proposal holds it once the athlete has seen it (Task 5's `DocWorkoutOp` + its outcome). */
export type DesignedOp = DocWorkoutOp & { outcome?: OpOutcome };

export type DesignProposalStatus = "pending" | "partially_approved" | "approved" | "declined";

/** The statuses a designed proposal is still the athlete's to decide in. */
export const OPEN_TO_ATHLETE: readonly string[] = ["pending", "partially_approved"];
/** The statuses of a proposal the athlete decided whole: asked again, each op answers how it was decided. */
const DECIDED: readonly string[] = ["approved", "declined"];

/** The proposal as the routes read it. */
export interface DesignProposalRow {
  id: string;
  title: string;
  status: string;
  ops: unknown;
  resolvedAt: string | null;
}

/** The id an approved op's revision row carries (`source_ref`): the proposal and the op. */
export const approvalRef = (proposalId: string, opId: string): string => `proposal:${proposalId}:${opId}`;

/** The key a new workout is made under: the same op makes the same row, however often it is approved. */
const approvalKey = (proposalId: string, opId: string): string => `approve:${proposalId}:${opId}`;

/** The proposal's status from its ops' outcomes (see the module comment). */
export function statusOfOps(ops: readonly { outcome?: OpOutcome }[]): DesignProposalStatus {
  const applied = ops.filter((o) => o.outcome?.status === "applied").length;
  if (ops.length > 0 && applied === ops.length) return "approved";
  if (applied > 0) return "partially_approved";
  if (ops.length > 0 && ops.every((o) => o.outcome?.status === "declined")) return "declined";
  return "pending";
}

/** A designed proposal's ops. */
export function designedOps(ops: unknown): DesignedOp[] {
  return Array.isArray(ops) ? (ops.filter(isDocWorkoutOp) as DesignedOp[]) : [];
}

export class NotOpenError extends Error {
  override name = "NotOpenError";
  constructor(readonly status: string) {
    super("not_pending");
  }
}

export class UnknownOpError extends Error {
  override name = "UnknownOpError";
  constructor(readonly opIds: string[]) {
    super("unknown_op");
  }
}

/** Another request changed the proposal between this one's read and its write: nothing of its record was lost; ask again. */
export class ProposalChangedError extends Error {
  override name = "ProposalChangedError";
  constructor() {
    super("proposal_changed");
  }
}

// ── Costs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every request: ≤ 45 combined D1 statements and fetches (Workers Free; the suites budget 45). */
export const REQUEST_BUDGET = 45;
/**
 * An approve's own: the session and its restore check, the proposal, the preferences, the proposal's write and the
 * receipt — 6 measured, one spare.
 */
export const APPROVE_FIXED = 7;
/**
 * A new workout at a time asked for: its key's read, the day it is judged for (the place, the profiles and set-aside
 * moves, the history — at most five — and the day's checks), the restore check, and the batch (the Studio programme,
 * the row, its revision, the pinned time). A pinned time is never moved: no collision pass.
 */
export const CREATE_AT_TIME_COST = 16;
/** A new workout placed at the athlete's window: no pinned time, then the day's collision pass (two reads) and up to
 * two rows it moves. */
export const CREATE_PLACED_COST = 19;
/**
 * A revision: this op's revision row (with the row's day), the row, the day it is judged for, the restore check, the
 * update and its revision, the read after, a new length's collision pass (two reads, two rows moved), and whether the
 * watch holds an older copy (two).
 */
export const REVISE_COST = 22;

function opCost(op: DesignedOp, mine: ApproveInput["edit"]): number {
  if (op.target.kind === "revise") return REVISE_COST;
  const time = mine && mine.time !== undefined ? mine.time : op.target.time;
  return time ? CREATE_AT_TIME_COST : CREATE_PLACED_COST;
}

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ApproveInput {
  /** The ops to approve; none named: all of them. */
  opIds?: string[];
  /** Edit before approve: the athlete's version of one op's draft (a new workout's day and time may be theirs). */
  edit?: { opId: string; doc: Record<string, unknown>; date?: string; time?: string | null };
}

export interface Applied {
  opId: string;
  workout: DocWorkoutDto;
  /** The server's warnings for the day (costs, never blocks). */
  warnings: IssueOut[];
  edited?: true;
  /** The watch holds a copy built from an older revision: the athlete may send the new one. */
  watchHasOlder?: true;
}

export interface Refused {
  opId: string;
  error: RefusalCode;
  why: string;
  issues?: IssueOut[];
}

/** An op decided before this request: nothing done. */
export interface Settled {
  opId: string;
  outcome: "applied" | "declined";
  workoutId?: string;
}

export interface ApproveAnswer {
  status: DesignProposalStatus;
  applied: Applied[];
  refused: Refused[];
  settled: Settled[];
  /** The ops this request had no room for: ask again with these. */
  remaining: string[];
}

/** The ops `ids` names, in the proposal's order; every id must be one of its ops. */
function chosen(ops: readonly DesignedOp[], ids: readonly string[] | undefined): DesignedOp[] {
  if (!ids) return [...ops];
  const known = new Set(ops.map(opIdOf));
  const unknown = [...new Set(ids)].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UnknownOpError(unknown);
  const wanted = new Set(ids);
  return ops.filter((o) => wanted.has(opIdOf(o)));
}

function settledOf(op: DesignedOp): Settled | null {
  const o = op.outcome;
  if (o?.status === "applied") return { opId: opIdOf(op), outcome: "applied", workoutId: o.workoutId };
  if (o?.status === "declined") return { opId: opIdOf(op), outcome: "declined" };
  return null;
}

/**
 * The proposal's ops, and of the ones `ids` names (none: all) those decided already (`settled`) and those still to
 * decide (`todo`). A proposal decided whole has nothing to decide; one no longer the athlete's (expired, superseded,
 * never shown) is `NotOpenError`.
 */
function decidable(p: DesignProposalRow, ids: readonly string[] | undefined): { ops: DesignedOp[]; settled: Settled[]; todo: DesignedOp[] } {
  const open = OPEN_TO_ATHLETE.includes(p.status);
  if (!open && !DECIDED.includes(p.status)) throw new NotOpenError(p.status);
  const ops = designedOps(p.ops);
  const settled: Settled[] = [];
  const todo: DesignedOp[] = [];
  for (const op of chosen(ops, ids)) {
    const s = settledOf(op);
    if (s) settled.push(s);
    else if (open) todo.push(op);
  }
  return { ops, settled, todo };
}

/**
 * Approve the chosen ops of a designed proposal (see the module comment). Throws `NotOpenError`, `UnknownOpError`,
 * `ProposalChangedError` — and with `edit`, the Studio's own refusal of the athlete's version.
 */
export async function approveDesignOps(
  db: Db,
  userId: string,
  p: DesignProposalRow,
  input: ApproveInput,
  ctx: DocWorkoutCtx,
  budget: number = REQUEST_BUDGET - APPROVE_FIXED,
): Promise<ApproveAnswer> {
  const { ops, settled, todo } = decidable(p, input.edit ? [input.edit.opId] : input.opIds);

  const applied: Applied[] = [];
  const refused: Refused[] = [];
  const remaining: string[] = [];
  const outcomes = new Map<string, OpOutcome>();
  let left = budget;
  for (const [i, op] of todo.entries()) {
    const cost = opCost(op, input.edit);
    // The first always goes: every request moves on.
    if (i > 0 && cost > left) {
      remaining.push(...todo.slice(i).map(opIdOf));
      break;
    }
    left -= cost;
    const opId = opIdOf(op);
    const result = await applyOp(db, userId, p.id, op, input.edit, ctx);
    if ("refusal" in result) {
      // Edit before approve answers as a Studio save does: the athlete's version is refused, nothing recorded.
      if (input.edit) throw result.error;
      refused.push({ opId, ...result.refusal });
      outcomes.set(opId, { status: "refused", at: ctx.now, ...result.refusal });
    } else {
      applied.push({ opId, ...result.applied });
      outcomes.set(opId, {
        status: "applied",
        at: ctx.now,
        workoutId: result.applied.workout.id,
        rev: result.applied.workout.docRev,
        ...(result.applied.edited ? { edited: true } : {}),
      });
    }
  }
  if (outcomes.size === 0) return { status: p.status as DesignProposalStatus, applied, refused, settled, remaining };

  const next = withOutcomes(p.ops, outcomes);
  const status = statusOfOps(designedOps(next));
  await writeOps(db, userId, p, next, status, ctx.now);

  // One receipt once nothing of the request remains, when it changed something the thread has not been told.
  const news = applied.length > 0 || refused.some((r) => {
    const before = ops.find((o) => opIdOf(o) === r.opId)?.outcome;
    return before?.status !== "refused" || before.error !== r.error;
  });
  if (remaining.length === 0 && news && designedOps(next).some((o) => o.outcome?.status === "applied")) {
    await receipt(db, userId, approvedReceipt(p.title, designedOps(next), applied), p.id).catch((e: unknown) =>
      console.error(JSON.stringify({ level: "error", msg: "design approve: applied, but the receipt failed", proposal: p.id, error: e instanceof Error ? e.message : "unknown" })),
    );
  }
  return { status, applied, refused, settled, remaining };
}

type OpResult =
  | { applied: Omit<Applied, "opId"> }
  | { refusal: Omit<Refused, "opId">; /** The Studio's own error, for edit before approve to answer with. */ error: Error };

/** One op through the Studio's service: applied, or refused with its reason. */
async function applyOp(db: Db, userId: string, proposalId: string, op: DesignedOp, edit: ApproveInput["edit"], ctx: DocWorkoutCtx): Promise<OpResult> {
  const opId = opIdOf(op);
  const mine = edit?.opId === opId ? edit : undefined;
  const edited = mine ? !sameDocument(mine.doc, op.doc) : false;
  const doc = { ...(mine?.doc ?? op.doc), basedOn: { kind: "proposal", id: proposalId, opId } };
  const source: DocWriteSource = { sourceKind: edited ? "athlete_edit" : "coach", sourceRef: approvalRef(proposalId, opId) };
  const target: DocWorkoutTarget = op.target;
  let date = op.date;
  try {
    if (target.kind === "new") {
      date = mine?.date ?? target.date;
      const time = mine && mine.time !== undefined ? mine.time : (target.time ?? null);
      const made = await createDocWorkout(db, userId, { date, time, doc, clientId: approvalKey(proposalId, opId) }, ctx, source);
      return { applied: { workout: made.workout, warnings: made.warnings.map(issueOut), ...(edited ? { edited: true } : {}) } };
    }
    const row = await revisionState(db, userId, target.workoutId, target.baseRev, approvalRef(proposalId, opId));
    if (!row) return refusalOf(new DocWorkoutNotFoundError(), target, date);
    date = row.dto.date;
    // This op's revision is there already: it applied (a crash came between it and the proposal's write).
    if (row.ours) return { applied: { workout: row.dto, warnings: [], ...(row.ours === "athlete_edit" ? { edited: true } : {}) } };
    if (row.dto.date < ctx.today) return refusalOf(new PastDateError(), target, date);
    const revised = await reviseDocWorkout(db, userId, target.workoutId, { doc, baseRev: target.baseRev }, ctx, source);
    return {
      applied: {
        workout: revised.workout,
        warnings: revised.warnings.map(issueOut),
        ...(edited ? { edited: true } : {}),
        ...(revised.watchHasOlder ? { watchHasOlder: true } : {}),
      },
    };
  } catch (e) {
    return refusalOf(e, target, date);
  }
}

/** The Studio's refusal as an op's: its code and why, in plain words; anything else is thrown on. */
function refusalOf(e: unknown, target: DocWorkoutTarget, date: string): { refusal: Omit<Refused, "opId">; error: Error } {
  const r = ((): Omit<Refused, "opId"> | null => {
    if (e instanceof PastDateError) return { error: "past_date", why: `Its day (${date}) has passed.` };
    if (e instanceof StaleRevisionError) {
      const base = target.kind === "revise" ? target.baseRev : 0;
      return { error: "stale_revision", why: `It changed since the coach read it: it is at revision ${e.rev ?? 0}, not ${base}.` };
    }
    if (e instanceof NotEditableError) return { error: "not_editable", why: "It can't change now: it is done, under way, or a programme's session." };
    if (e instanceof DocWorkoutNotFoundError) return { error: "not_found", why: "The workout is no longer in the plan." };
    if (e instanceof DocInvalidError) {
      const errors = e.issues.filter((i) => i.severity === "error");
      return { error: "invalid_doc", why: `The day now refuses it: ${errors[0]?.message ?? "it no longer passes the day's rules"}`, issues: errors.slice(0, 10).map(issueOut) };
    }
    if (e instanceof RunUnsupportedError) return { error: "run_unsupported", why: "A run can't be planned from the Studio yet." };
    if (e instanceof RestoreInProgressError) return { error: "restore_in_progress", why: "The account is being restored." };
    return null;
  })();
  if (!r) throw e;
  return { refusal: r, error: e as Error };
}

/** Two documents the same as the builder's save would send them (its "changed" test), the source and lineage aside. */
function sameDocument(raw: unknown, coach: WorkoutDoc): boolean {
  const parsed = workoutDocSchema.safeParse(raw);
  if (!parsed.success) return false;
  const plain = (d: WorkoutDoc) => {
    const x = toProposable(startEditing(d).doc);
    if (!x) return null;
    const { source: _source, basedOn: _basedOn, ...rest } = x;
    return JSON.stringify(rest);
  };
  const a = plain(parsed.data);
  return a !== null && a === plain(coach);
}

/**
 * A revision target as it is now, in one statement: the row (as the Studio answers it), and whether the revision after
 * the coach's base is this op's — and whose (`coach`, or `athlete_edit`). Null for no row, or one removed.
 */
async function revisionState(
  db: Db,
  userId: string,
  workoutId: string,
  baseRev: number,
  ref: string,
): Promise<{ dto: DocWorkoutDto; ours: string | null } | null> {
  const pw = plannedWorkouts;
  const r = workoutDocRevisions;
  const [row] = (await db.all(sql`
    select ${pw.id} as id, ${pw.effectiveDate} as date, ${pw.effectiveTime} as time, ${pw.title} as title, ${pw.category} as category,
      ${pw.sport} as sport, ${pw.origin} as origin, ${pw.contentState} as content, ${pw.completionState} as completion,
      ${pw.workoutDocRev} as rev, ${pw.archivedAt} as archived, ${pw.fallbackEstimatedDurationSeconds} as seconds,
      case when json_valid(${pw.workoutDoc}) then json_extract(${pw.workoutDoc}, '$.intent.summary') end as summary,
      (select ${r.sourceKind} from ${r} where ${r.id} = ${`${workoutId}:${baseRev + 1}`} and ${r.userId} = ${userId} and ${r.sourceRef} = ${ref}) as ours
    from ${pw} where ${pw.id} = ${workoutId} and ${pw.userId} = ${userId}
  `)) as Array<Record<string, unknown>>;
  if (!row || row.archived) return null;
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  return {
    dto: {
      id: str(row.id),
      date: str(row.date),
      time: str(row.time),
      title: str(row.title),
      intentSummary: str(row.summary),
      category: str(row.category),
      sport: str(row.sport),
      origin: str(row.origin, "studio"),
      contentState: str(row.content, "outline"),
      completionState: str(row.completion),
      docRev: typeof row.rev === "number" ? row.rev : null,
      minutes: typeof row.seconds === "number" ? Math.round(row.seconds / 60) : 0,
    },
    ours: typeof row.ours === "string" ? row.ours : null,
  };
}

/** The proposal's ops with these outcomes on the designed ones they name; every other op as it was. */
function withOutcomes(ops: unknown, outcomes: ReadonlyMap<string, OpOutcome>): unknown[] {
  return (Array.isArray(ops) ? ops : []).map((o) => {
    if (!isDocWorkoutOp(o)) return o;
    const outcome = outcomes.get(opIdOf(o as DesignedOp));
    return outcome ? { ...(o as DesignedOp), outcome } : o;
  });
}

/** Write the ops' outcomes and the status, while the proposal is still as this request read it. */
async function writeOps(db: Db, userId: string, p: DesignProposalRow, next: unknown[], status: DesignProposalStatus, now: string): Promise<void> {
  const resolvedAt = status === "pending" ? p.resolvedAt : status === p.status ? (p.resolvedAt ?? now) : now;
  const written = await db
    .update(coachProposals)
    .set({ ops: next, status, resolvedAt })
    .where(
      and(
        eq(coachProposals.id, p.id),
        eq(coachProposals.userId, userId),
        eq(coachProposals.status, p.status),
        sql`${coachProposals.ops} = ${JSON.stringify(p.ops)}`,
      ),
    )
    .returning({ id: coachProposals.id });
  if (written.length === 0) throw new ProposalChangedError();
}

async function receipt(db: Db, userId: string, body: string, proposalId: string): Promise<void> {
  await db.insert(coachMessages).values({ id: newId(), userId, role: "receipt", body, refs: { proposalId }, at: new Date().toISOString() });
}

/**
 * "✓ approved — <title>: Fri 15 May · Hips · 24 min; …" — every workout of the proposal approved so far, then any the
 * server refused, with why; "(k of n)" while some are not approved. Computed from the documents: a workout this request
 * wrote is said as it was written (the athlete's version, when edited).
 */
function approvedReceipt(title: string, ops: readonly DesignedOp[], appliedNow: readonly Applied[]): string {
  const now = new Map(appliedNow.map((a) => [a.opId, a]));
  const minutesOf = (doc: WorkoutDoc) => deriveDoc(doc, EXERCISES).estimatedMinutes;
  const done: string[] = [];
  const not: string[] = [];
  for (const op of ops) {
    const o = op.outcome;
    if (o?.status === "applied") {
      const a = now.get(opIdOf(op));
      done.push(a ? receiptLine(a.workout.date, a.workout.title, a.workout.minutes, !!a.edited) : receiptLine(op.date, op.doc.title, minutesOf(op.doc), !!o.edited));
    } else if (o?.status === "refused") {
      not.push(`${receiptLine(op.date, op.doc.title, minutesOf(op.doc))} (${o.why})`);
    }
  }
  const count = done.length < ops.length ? ` (${done.length} of ${ops.length})` : "";
  return `✓ approved — ${title}${count}: ${done.join("; ")}${not.length ? ` · not approved: ${not.join("; ")}` : ""}`;
}

// ── Decline ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest decline reason kept: the athlete's words, data only. */
export const DECLINE_REASON_MAX = 500;

export interface DeclineAnswer {
  status: DesignProposalStatus;
  declined: string[];
  settled: Settled[];
}

/** Decline the chosen ops (none named: all) — see the module comment. Throws `NotOpenError`, `UnknownOpError`, `ProposalChangedError`. */
export async function declineDesignOps(
  db: Db,
  userId: string,
  p: DesignProposalRow,
  input: { opIds?: string[]; reason?: string },
  now: string,
): Promise<DeclineAnswer> {
  const { settled, todo } = decidable(p, input.opIds);
  const reason = input.reason?.trim().slice(0, DECLINE_REASON_MAX);
  const declined = todo.map(opIdOf);
  if (declined.length === 0) return { status: p.status as DesignProposalStatus, declined, settled };
  const outcome: OpOutcome = { status: "declined", at: now, ...(reason ? { reason } : {}) };
  const next = withOutcomes(p.ops, new Map(declined.map((id) => [id, outcome])));
  const status = statusOfOps(designedOps(next));
  await writeOps(db, userId, p, next, status, now);
  if (status === "declined") await receipt(db, userId, `Left as planned — ${p.title}`, p.id);
  return { status, declined, settled };
}

// ── The draft ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** An op's draft, in the shape the builder loads a document (`GET /api/workouts/:id/doc`), with where it goes. */
export interface DesignDraft {
  proposalId: string;
  opId: string;
  /** The proposal's status. */
  status: string;
  doc: WorkoutDoc;
  derived: DocDerived;
  /** No planned revision of its own: a draft. */
  rev: null;
  target: DocWorkoutTarget;
  date: string;
  time: string | null;
  outcome: OpOutcome | null;
}

/** The op's draft, or null when the proposal holds no such op. */
export function designDraft(p: Pick<DesignProposalRow, "id" | "status" | "ops">, opId: string): DesignDraft | null {
  const op = designedOps(p.ops).find((o) => opIdOf(o) === opId);
  if (!op) return null;
  return {
    proposalId: p.id,
    opId,
    status: p.status,
    doc: op.doc,
    derived: deriveDoc(op.doc, EXERCISES),
    rev: null,
    target: op.target,
    date: op.date,
    time: op.time ?? null,
    outcome: op.outcome ?? null,
  };
}
