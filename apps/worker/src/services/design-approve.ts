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
 * programme's session (`not_editable`, with its `cause`), a workout removed since (`not_found`), a hard rule the day now
 * refuses or a move the library no longer has (`invalid_doc`, with the validator's errors), a run (`run_unsupported`),
 * a restore under way (`restore_in_progress`). Each `why` is plain words; the codes are for the UI to word. A refused op
 * stays open: the day can change, and the athlete can edit it.
 *
 * WHAT IS KEPT. Each op keeps its outcome (`outcome`) for read_proposals and the UI: applied — its workout, the
 * revision written, and what was WRITTEN (`written`: its day, time, title and minutes, which after an edit are the
 * athlete's, never the coach's), `edited` when the athlete changed the coach's draft and `moved` when they chose another
 * day or time; refused — why; declined — the athlete's words, if any. The coach's own document stays as it proposed it.
 * The proposal is `approved` once every op applied, `partially_approved` while some have (still the athlete's to finish),
 * `declined` when every op was, else `pending` (`statusOfOps`). The write is guarded by the status and the ops it read:
 * two requests that race never lose an outcome (the second is refused, `ProposalChangedError`, and asks again —
 * everything here is idempotent).
 *
 * THE OP THAT MADE A WORKOUT RECORDS APPLIED. One read of the plan (`readPlan`) says, for every op in hand, whether its
 * workout is already there — a new workout by its key (`createDocWorkout`'s `clientId`, made from the proposal and the
 * op), a revision by its revision row (the one after the coach's base, carrying this op's ref) — and such an op is
 * recorded applied, never made again and never declined: a crash between a workout's write and the proposal's, a
 * double tap, an approve that raced a decline. A revise that met its own revision mid-way (`stale_revision` at the base's
 * next revision) reads it once more and is applied. A proposal decided whole answers each op's outcome (`settled`),
 * writing nothing, but for an op declined whose workout is there; one no longer the athlete's (expired, superseded,
 * never shown) is refused (`NotOpenError`).
 *
 * ONE REQUEST, ≤ 45 STATEMENTS — true upper bounds. The plan read also counts each day's scheduled sessions, so an op's
 * cost is known before it runs: a new workout at a time asked for, `CREATE_AT_TIME_COST`; one placed at the athlete's
 * window, `CREATE_PLACED_BASE` plus every session its day's collision pass could move (the day's, this request's own
 * on that day, and itself); a revision, `REVISE_BASE` plus its day's sessions. A request applies ops while their costs
 * fit what `APPROVE_FIXED` leaves; the rest come back as `remaining`, for the client to ask again with. The first op
 * always goes, so every request moves on — and the largest op still fits a request on its own.
 *
 * EDIT BEFORE APPROVE (`edit`). The builder saves the athlete's version of ONE op's draft: approved through the same
 * path, marked `edited` when it differs from the coach's (compared as the builder compares two documents), a new
 * workout's day and time the athlete's (`moved` when they differ). It answers as a Studio save answers: a refusal is
 * thrown as the Studio's own error, for the route to answer as `POST /api/workouts` and `PUT /api/workouts/:id/doc` do,
 * and nothing is recorded — the coach's draft stays open.
 *
 * DECLINE (`declineDesignOps`). The proposal, or the chosen ops, declined; the athlete's reason — their own words, data
 * only — kept on each op for read_proposals. An op whose workout is there is recorded applied instead.
 *
 * THE THREAD. Approving writes one plain receipt in the thread once nothing of the request remains — the workouts
 * approved, each as written (design-manifest.ts), how many were declined, and any not approved with why — and a decline
 * that declines the whole proposal says "Left as planned", as the thread's own does. A receipt that fails never fails
 * the approve: the workouts are written by then.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { coachMessages, coachProposals, plannedWorkouts, workoutDocRevisions } from "@rg/database";
import { dayLabel, docOriginRow, newId, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, startEditing, toProposable, type DocDerived, type DocIssue } from "@rg/workout";
import type { Db } from "./db.js";
import {
  createDocWorkout,
  DocInvalidError,
  DocWorkoutNotFoundError,
  keyedRowId,
  LOCKED_CONTENT,
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
import { FROZEN_STATES } from "./workout-doc-store.js";

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the server refused an op today: the Studio's own error names. */
export type RefusalCode = "past_date" | "stale_revision" | "not_editable" | "not_found" | "invalid_doc" | "run_unsupported" | "restore_in_progress";

/** Why a planned workout can't change (`not_editable`), as the Studio's own rules say it. */
export type NotEditableCause = "programme" | "completed" | "skipped" | "missed" | "under_way" | "unknown";

/** A validator's issue, as an answer carries it. */
export type IssueOut = Pick<DocIssue, "path" | "code" | "message" | "severity"> & { fix?: string };
const issueOut = (i: DocIssue): IssueOut => ({ path: i.path, code: i.code, message: i.message, severity: i.severity, ...(i.fix !== undefined ? { fix: i.fix } : {}) });

/** What an approve wrote: the workout's day and time, title and minutes, as the plan now holds it. */
export interface Written {
  date: string;
  time: string;
  title: string;
  minutes: number;
}

/** How an op ended (see the module comment). Absent while it is the athlete's to decide. */
export type OpOutcome =
  | { status: "applied"; at: string; workoutId: string; rev: number | null; written: Written; edited?: true; moved?: true }
  | { status: "refused"; at: string; error: RefusalCode; why: string; cause?: NotEditableCause; issues?: IssueOut[] }
  | { status: "declined"; at: string; reason?: string }
  /** A newer plan of the coach's covers its day (Task 7, design-orchestrate.ts `supersedeOlderPlans`): decided, never
   * approved after. */
  | { status: "superseded"; at: string; reason: string; by: string };

/** A designed workout's op as a proposal holds it once the athlete has seen it (Task 5's `DocWorkoutOp` + its outcome). */
export type DesignedOp = DocWorkoutOp & { outcome?: OpOutcome };

export type DesignProposalStatus = "pending" | "partially_approved" | "approved" | "declined" | "superseded";

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

/**
 * The proposal's status from its ops' outcomes (see the module comment) — the rule design-orchestrate.ts
 * `supersedeOlderPlans` writes in SQL: once every op is decided, `superseded` when none applied and not all were
 * declined.
 */
export function statusOfOps(ops: readonly { outcome?: OpOutcome }[]): DesignProposalStatus {
  const applied = ops.filter((o) => o.outcome?.status === "applied").length;
  if (ops.length > 0 && applied === ops.length) return "approved";
  if (applied > 0) return "partially_approved";
  if (ops.length > 0 && ops.every((o) => o.outcome?.status === "declined")) return "declined";
  if (ops.length > 0 && ops.every((o) => o.outcome?.status === "declined" || o.outcome?.status === "superseded")) return "superseded";
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

// ── Costs (true upper bounds: each part is the most its code can run) ─────────────────────────────────────────────

/** Every request: ≤ 45 combined D1 statements and fetches (Workers Free; the suites budget 45). */
export const REQUEST_BUDGET = 45;
/** An approve's own: the session and its restore check, the proposal, the preferences, the plan read, the proposal's
 * write and the receipt. */
export const APPROVE_FIXED = 7;
/** A decline: the session and its restore check, the proposal, the plan read, the write and the receipt. */
export const DECLINE_COST = 6;
/**
 * The day a new workout or a revision is judged for (`docDayContext`): the place (two when the place it names is gone),
 * the profiles and the set-aside moves, the history (at most five reads) and the day's checks.
 */
const DAY_READS = 2 + 2 + 5 + 1;
/** A new workout at a time asked for: its key's read, its day, the restore check, and the batch (the Studio programme,
 * the row, its revision, the pinned time). A pinned time is never moved: no collision pass. */
export const CREATE_AT_TIME_COST = 1 + DAY_READS + 1 + 4;
/** A new workout placed at the athlete's window, before the rows its day's collision pass moves: its key's read, its
 * day, the restore check, the batch (programme, row, revision) and the pass's two reads. */
export const CREATE_PLACED_BASE = 1 + DAY_READS + 1 + 3 + 2;
/** A revision, before the rows its day's collision pass moves: the row, its day, the restore check, the update and its
 * revision, the read after, the pass's two reads, and whether the watch holds an older copy (two). */
export const REVISE_BASE = 1 + DAY_READS + 1 + 2 + 1 + 2 + 2;
/** The ops one plan read covers (its bound values stay well under D1's 100). A set holds at most seven. */
const PLAN_MAX = 10;

/** What an op costs, by the sessions its day already holds (`dayRows`, this request's own included). */
export function opCostOf(op: Pick<DocWorkoutOp, "target">, dayRows: number, edit?: ApproveInput["edit"]): number {
  if (op.target.kind === "revise") return REVISE_BASE + dayRows;
  const time = edit && edit.time !== undefined ? edit.time : op.target.time;
  // The collision pass may move every unpinned session of the day, the new one with them.
  return time ? CREATE_AT_TIME_COST : CREATE_PLACED_BASE + dayRows + 1;
}

// ── The plan, read once ─────────────────────────────────────────────────────────────────────────────────────────────

/** A planned row as the plan read gives it. */
interface RowState {
  dto: DocWorkoutDto;
  origin: string | null;
  archived: boolean;
}

interface Plan {
  rows: Map<string, RowState>;
  /** Revision id → its writer (`coach`, `athlete_edit`), for revisions carrying one of these ops' refs. */
  revisions: Map<string, string>;
  /** Scheduled sessions per day (the collision pass's own rows: not archived, not rest). */
  days: Map<string, number>;
  /** The row a new op's workout is made under. */
  keyOf: Map<string, string>;
}

const values = (xs: readonly string[]): SQL => (xs.length ? sql.join(xs.map((x) => sql`${x}`), sql`, `) : sql`null`);

function parsedRows(text: unknown): Array<Record<string, unknown>> {
  try {
    const v = JSON.parse(typeof text === "string" ? text : "[]") as unknown;
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * ONE statement: the rows these ops' workouts are (or would be) — each new op's keyed row, each revise op's target — the
 * revisions carrying these ops' refs, and the scheduled sessions on each day they touch (`dates`, and each revised row's
 * own day).
 */
async function readPlan(db: Db, userId: string, proposalId: string, ops: readonly DesignedOp[], dates: readonly string[]): Promise<Plan> {
  const keyOf = new Map<string, string>();
  for (const op of ops) if (op.target.kind === "new") keyOf.set(opIdOf(op), await keyedRowId(userId, approvalKey(proposalId, opIdOf(op))));
  const revised = ops.flatMap((o) => (o.target.kind === "revise" ? [o.target.workoutId] : []));
  const revisionIds = ops.flatMap((o) =>
    o.target.kind === "revise" ? [`${o.target.workoutId}:${o.target.baseRev + 1}`] : [`${keyOf.get(opIdOf(o))}:1`],
  );
  const refs = ops.map((o) => approvalRef(proposalId, opIdOf(o)));
  const pw = plannedWorkouts;
  const r = workoutDocRevisions;
  const [row] = (await db.all(sql`
    select
      (select json_group_array(json_object('id', ${pw.id}, 'date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'title', ${pw.title},
        'category', ${pw.category}, 'sport', ${pw.sport}, 'origin', ${pw.origin}, 'content', ${pw.contentState},
        'completion', ${pw.completionState}, 'rev', ${pw.workoutDocRev}, 'archived', ${pw.archivedAt},
        'seconds', ${pw.fallbackEstimatedDurationSeconds},
        'summary', case when json_valid(${pw.workoutDoc}) then json_extract(${pw.workoutDoc}, '$.intent.summary') end))
        from ${pw} where ${pw.userId} = ${userId} and ${pw.id} in (${values([...keyOf.values(), ...revised])})) as rows,
      (select json_group_array(json_object('id', ${r.id}, 'kind', ${r.sourceKind}))
        from ${r} where ${r.userId} = ${userId} and ${r.id} in (${values(revisionIds)}) and ${r.sourceRef} in (${values(refs)})) as revisions,
      (select json_group_array(json_object('date', d, 'n', n)) from (
        select ${pw.effectiveDate} as d, count(*) as n from ${pw}
        where ${pw.userId} = ${userId} and ${pw.archivedAt} is null and ${pw.completionState} = 'scheduled' and ${pw.category} != 'rest'
          and (${pw.effectiveDate} in (${values(dates)})
            or ${pw.effectiveDate} in (select ${pw.effectiveDate} from ${pw} where ${pw.userId} = ${userId} and ${pw.id} in (${values(revised)})))
        group by ${pw.effectiveDate})) as days
  `)) as Array<{ rows: unknown; revisions: unknown; days: unknown }>;
  const rows = new Map<string, RowState>();
  for (const x of parsedRows(row?.rows)) {
    rows.set(str(x.id), {
      dto: {
        id: str(x.id),
        date: str(x.date),
        time: str(x.time),
        title: str(x.title),
        intentSummary: str(x.summary),
        category: str(x.category),
        sport: str(x.sport),
        origin: str(x.origin, "studio"),
        contentState: str(x.content, "outline"),
        completionState: str(x.completion),
        docRev: typeof x.rev === "number" ? x.rev : null,
        minutes: typeof x.seconds === "number" ? Math.round(x.seconds / 60) : 0,
      },
      origin: typeof x.origin === "string" ? x.origin : null,
      archived: typeof x.archived === "string" && x.archived.length > 0,
    });
  }
  // Each revision id names one op's revision; its ref was checked in the read (the op's own).
  const revisions = new Map(parsedRows(row?.revisions).map((x) => [str(x.id), str(x.kind)]));
  const days = new Map(parsedRows(row?.days).map((x) => [str(x.date), typeof x.n === "number" ? x.n : 0]));
  return { rows, revisions, days, keyOf };
}

/**
 * The workout an op already made, as an applied outcome — or null when it made none. A new op's: its keyed row. A
 * revise op's: its target row, when the revision after the coach's base is this op's.
 */
function madeOf(op: DesignedOp, plan: Plan, at: string): Extract<OpOutcome, { status: "applied" }> | null {
  const target = op.target;
  const id = target.kind === "new" ? plan.keyOf.get(opIdOf(op)) : target.workoutId;
  const row = id ? plan.rows.get(id) : undefined;
  if (!id || !row) return null;
  const revId = target.kind === "new" ? `${id}:1` : `${id}:${target.baseRev + 1}`;
  const writer = plan.revisions.get(revId);
  if (target.kind === "revise" && writer === undefined) return null;
  const d = row.dto;
  const moved = target.kind === "new" && (d.date !== target.date || (!!target.time && d.time !== target.time));
  return {
    status: "applied",
    at,
    workoutId: id,
    rev: target.kind === "new" ? 1 : target.baseRev + 1,
    written: writtenOf(d),
    ...(writer === "athlete_edit" ? { edited: true } : {}),
    ...(moved ? { moved: true } : {}),
  };
}

const writtenOf = (w: DocWorkoutDto): Written => ({ date: w.date, time: w.time, title: w.title, minutes: w.minutes });

/** Why a planned workout can't change, by the Studio's own rules (doc-workouts.ts `reviseDocWorkout`). */
function notEditableCause(row: RowState | undefined): NotEditableCause {
  if (!row) return "unknown";
  if (!docOriginRow({ origin: row.origin })) return "programme";
  const c = row.dto.completionState;
  if ((FROZEN_STATES as readonly string[]).includes(c)) return c as "completed" | "skipped" | "missed";
  if ((LOCKED_CONTENT as readonly string[]).includes(row.dto.contentState)) return "under_way";
  return "unknown";
}

const NOT_EDITABLE_WHY: Record<NotEditableCause, string> = {
  programme: "It's a programme's session: the programme plans it.",
  completed: "It's done already.",
  skipped: "It was skipped.",
  missed: "It was missed.",
  under_way: "It's under way.",
  unknown: "It can't change now.",
};

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
  moved?: true;
  /** The watch holds a copy built from an older revision: the athlete may send the new one. */
  watchHasOlder?: true;
}

export interface Refused {
  opId: string;
  error: RefusalCode;
  why: string;
  cause?: NotEditableCause;
  issues?: IssueOut[];
}

/** An op decided before this request: nothing done. */
export interface Settled {
  opId: string;
  outcome: "applied" | "declined" | "superseded";
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

/**
 * Of the ops `ids` names (none: all): those applied already (`settled`), those declined (`declined`: settled, unless the
 * plan read finds their workout), and those still to decide (`todo`). A proposal decided whole has nothing to decide;
 * one no longer the athlete's (expired, superseded, never shown) is `NotOpenError`.
 */
function decidable(p: DesignProposalRow, ids: readonly string[] | undefined) {
  const open = OPEN_TO_ATHLETE.includes(p.status);
  if (!open && !DECIDED.includes(p.status)) throw new NotOpenError(p.status);
  const ops = designedOps(p.ops);
  const settled: Settled[] = [];
  const declined: DesignedOp[] = [];
  const todo: DesignedOp[] = [];
  for (const op of chosen(ops, ids)) {
    const o = op.outcome;
    if (o?.status === "applied") settled.push({ opId: opIdOf(op), outcome: "applied", workoutId: o.workoutId });
    else if (o?.status === "superseded") settled.push({ opId: opIdOf(op), outcome: "superseded" });
    else if (o?.status === "declined") declined.push(op);
    else if (open) todo.push(op);
  }
  return { ops, settled, declined, todo };
}

/** The day an op's new workout goes on (the athlete's, with an edit); a revision's is its row's. */
const dayOf = (op: DesignedOp, edit: ApproveInput["edit"]): string | null =>
  op.target.kind === "new" ? (edit?.opId === opIdOf(op) && edit.date ? edit.date : op.target.date) : null;

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
  const { ops, settled, declined, todo: open } = decidable(p, input.edit ? [input.edit.opId] : input.opIds);
  // One plan read covers at most PLAN_MAX ops; the rest wait for the next request.
  const inPlan = open.slice(0, PLAN_MAX);
  const overflow = open.slice(PLAN_MAX).map(opIdOf);
  const applied: Applied[] = [];
  const refused: Refused[] = [];
  const outcomes = new Map<string, OpOutcome>();
  if (inPlan.length === 0 && declined.length === 0) return { status: p.status as DesignProposalStatus, applied, refused, settled, remaining: overflow };

  const inHand = [...inPlan, ...declined];
  const plan = await readPlan(db, userId, p.id, inHand, inHand.flatMap((o) => dayOf(o, input.edit) ?? []));
  // An op whose workout is there already — a crash, a double tap, an approve that raced a decline — is applied, and
  // made no second time; a declined op whose workout isn't there stays declined.
  const todo: DesignedOp[] = [];
  for (const op of inHand) {
    const made = madeOf(op, plan, ctx.now);
    if (made) {
      outcomes.set(opIdOf(op), made);
      applied.push(appliedOf(op, made, plan));
    } else if (op.outcome?.status === "declined") settled.push({ opId: opIdOf(op), outcome: "declined" });
    else todo.push(op);
  }

  const remaining: string[] = [];
  let left = budget;
  const added = new Map<string, number>();
  for (const [i, op] of todo.entries()) {
    const opId = opIdOf(op);
    const day = dayOf(op, input.edit) ?? (op.target.kind === "revise" ? plan.rows.get(op.target.workoutId)?.dto.date : undefined);
    const rows = day ? (plan.days.get(day) ?? 0) + (added.get(day) ?? 0) : 0;
    const cost = opCostOf(op, rows, input.edit);
    // The first always goes: every request moves on.
    if (i > 0 && cost > left) {
      remaining.push(...todo.slice(i).map(opIdOf));
      break;
    }
    left -= cost;
    const result = await applyOp(db, userId, p.id, op, input.edit, ctx, plan);
    if ("refusal" in result) {
      // Edit before approve answers as a Studio save does: the athlete's version is refused, nothing recorded.
      if (input.edit) throw result.error;
      refused.push({ opId, ...result.refusal });
      outcomes.set(opId, { status: "refused", at: ctx.now, ...result.refusal });
    } else {
      applied.push({ opId, ...result.applied });
      if (op.target.kind === "new") added.set(result.applied.workout.date, (added.get(result.applied.workout.date) ?? 0) + 1);
      outcomes.set(opId, {
        status: "applied",
        at: ctx.now,
        workoutId: result.applied.workout.id,
        rev: result.applied.workout.docRev,
        written: writtenOf(result.applied.workout),
        ...(result.applied.edited ? { edited: true } : {}),
        ...(result.applied.moved ? { moved: true } : {}),
      });
    }
  }
  remaining.push(...overflow);
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
    await receipt(db, userId, approvedReceipt(p.title, designedOps(next)), p.id).catch((e: unknown) =>
      console.error(JSON.stringify({ level: "error", msg: "design approve: applied, but the receipt failed", proposal: p.id, error: e instanceof Error ? e.message : "unknown" })),
    );
  }
  return { status, applied, refused, settled, remaining };
}

/** An op found applied (made already) as the answer says it. */
function appliedOf(op: DesignedOp, made: Extract<OpOutcome, { status: "applied" }>, plan: Plan): Applied {
  const row = plan.rows.get(made.workoutId);
  const workout: DocWorkoutDto = row ? { ...row.dto } : { ...emptyDto(made.workoutId), ...made.written };
  return { opId: opIdOf(op), workout, warnings: [], ...(made.edited ? { edited: true } : {}), ...(made.moved ? { moved: true } : {}) };
}

const emptyDto = (id: string): DocWorkoutDto => ({
  id, date: "", time: "", title: "", intentSummary: "", category: "", sport: "", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: null, minutes: 0,
});

type OpResult =
  | { applied: Omit<Applied, "opId"> }
  | { refusal: Omit<Refused, "opId">; /** The Studio's own error, for edit before approve to answer with. */ error: Error };

/** One op through the Studio's service: applied, or refused with its reason. */
async function applyOp(
  db: Db,
  userId: string,
  proposalId: string,
  op: DesignedOp,
  edit: ApproveInput["edit"],
  ctx: DocWorkoutCtx,
  plan: Plan,
): Promise<OpResult> {
  const opId = opIdOf(op);
  const mine = edit?.opId === opId ? edit : undefined;
  const edited = mine ? !sameDocument(mine.doc, op.doc) : false;
  const doc = { ...(mine?.doc ?? op.doc), basedOn: { kind: "proposal", id: proposalId, opId } };
  const source: DocWriteSource = { sourceKind: edited ? "athlete_edit" : "coach", sourceRef: approvalRef(proposalId, opId) };
  const target: DocWorkoutTarget = op.target;
  let date = op.date;
  const row = target.kind === "revise" ? plan.rows.get(target.workoutId) : undefined;
  try {
    if (target.kind === "new") {
      date = mine?.date ?? target.date;
      const time = mine && mine.time !== undefined ? mine.time : (target.time ?? null);
      // The athlete chose another day or time than the coach's.
      const moved = date !== target.date || (time ?? null) !== (target.time ?? null);
      const made = await createDocWorkout(db, userId, { date, time, doc, clientId: approvalKey(proposalId, opId) }, ctx, source);
      return { applied: { workout: made.workout, warnings: made.warnings.map(issueOut), ...(edited ? { edited: true } : {}), ...(moved ? { moved: true } : {}) } };
    }
    if (!row || row.archived) return refusalOf(new DocWorkoutNotFoundError(), date, row);
    date = row.dto.date;
    if (date < ctx.today) return refusalOf(new PastDateError(), date, row);
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
    // A revise that met the base's next revision: a double tap of this op may have written it. Read it once more.
    if (e instanceof StaleRevisionError && target.kind === "revise" && e.rev === target.baseRev + 1) {
      const again = await readPlan(db, userId, proposalId, [op], []);
      const made = madeOf(op, again, ctx.now);
      if (made) return { applied: appliedOf(op, made, again) };
    }
    return refusalOf(e, date, row);
  }
}

/** The Studio's refusal as an op's: its code and why, in plain words; anything else is thrown on. */
function refusalOf(e: unknown, date: string, row: RowState | undefined): { refusal: Omit<Refused, "opId">; error: Error } {
  const r = ((): Omit<Refused, "opId"> | null => {
    if (e instanceof PastDateError) return { error: "past_date", why: `${dayLabel(date)} has passed.` };
    if (e instanceof StaleRevisionError) return { error: "stale_revision", why: "It changed after the coach read it." };
    if (e instanceof NotEditableError) {
      const cause = notEditableCause(row);
      return { error: "not_editable", cause, why: NOT_EDITABLE_WHY[cause] };
    }
    if (e instanceof DocWorkoutNotFoundError) return { error: "not_found", why: "It's no longer in the plan." };
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
 * "✓ approved — <title>: Fri 15 May · Hips · 24 min; …" — every workout of the proposal approved so far, each as it was
 * WRITTEN (the athlete's version and day, when edited or moved), then any the server refused, with why; "(k of n; d
 * declined)" while some are not approved.
 */
function approvedReceipt(title: string, ops: readonly DesignedOp[]): string {
  const minutesOf = (doc: WorkoutDoc) => deriveDoc(doc, EXERCISES).estimatedMinutes;
  const done: string[] = [];
  const not: string[] = [];
  let declined = 0;
  for (const op of ops) {
    const o = op.outcome;
    if (o?.status === "applied") {
      const w = o.written;
      done.push(w ? receiptLine(w.date, w.title, w.minutes, !!o.edited) : receiptLine(op.date, op.doc.title, minutesOf(op.doc), !!o.edited));
    } else if (o?.status === "refused") {
      not.push(`${receiptLine(op.date, op.doc.title, minutesOf(op.doc))} (${o.why})`);
    } else if (o?.status === "declined") declined += 1;
  }
  const count = done.length < ops.length ? ` (${done.length} of ${ops.length}${declined ? `; ${declined} declined` : ""})` : "";
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

/**
 * Decline the chosen ops (none named: all) — see the module comment: an op whose workout is there is recorded applied,
 * never declined. Throws `NotOpenError`, `UnknownOpError`, `ProposalChangedError`.
 */
export async function declineDesignOps(
  db: Db,
  userId: string,
  p: DesignProposalRow,
  input: { opIds?: string[]; reason?: string },
  now: string,
): Promise<DeclineAnswer> {
  const { settled, declined: before, todo } = decidable(p, input.opIds);
  for (const op of before) settled.push({ opId: opIdOf(op), outcome: "declined" });
  const reason = input.reason?.trim().slice(0, DECLINE_REASON_MAX);
  const declined: string[] = [];
  if (todo.length === 0) return { status: p.status as DesignProposalStatus, declined, settled };
  const plan = await readPlan(db, userId, p.id, todo, []);
  const outcomes = new Map<string, OpOutcome>();
  for (const op of todo) {
    const made = madeOf(op, plan, now);
    if (made) {
      outcomes.set(opIdOf(op), made);
      settled.push({ opId: opIdOf(op), outcome: "applied", workoutId: made.workoutId });
    } else {
      outcomes.set(opIdOf(op), { status: "declined", at: now, ...(reason ? { reason } : {}) });
      declined.push(opIdOf(op));
    }
  }
  const next = withOutcomes(p.ops, outcomes);
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
