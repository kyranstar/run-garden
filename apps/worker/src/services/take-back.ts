/**
 * RECEIPT-BOUND TAKE-BACK (R1; the LifeOS migration's DESIGN-3 §3.4.3, the lead's v0.20 Q2 ruling).
 *
 * THE RECEIPT. Every training write the owner may take back writes a receipt (`take_back_receipts`) IN THE SAME D1 BATCH as
 * the write — a saved workout put on the plan (`place`), or an approved coach op (`coach_approve`: a new workout, a
 * revision, a move or a skip of a session already there). The receipt's `post_state` is read from the row inside that
 * batch, at the write's own instant (`receiptInsert`): a write that didn't land leaves it NULL, which fails the batch, so a
 * write never stands without its receipt nor a receipt without its write. Its id is deterministic over the account, the
 * source and its key (`receiptIdOf`): a retried write makes no second receipt. It lapses 8 days after the write, or at the
 * end of the session's day on the account's clock if that comes first (`receiptExpiry`).
 *
 * THE TAKE-BACK (`takeBack`, `POST /api/native/take-back {receiptIds, requestId}`), in order:
 *  1. Idempotency: a receipt already taken back with this `requestId` answers what it did; with another, `already_taken_back`
 *     and what it did — found so at preflight, or at the write (another request took it back meanwhile: review B-7). An id
 *     that isn't one of the account's receipts is `not_found` (another account's too); so, to a phone, is one it didn't make
 *     (`made_by`: its own places and approves only — review A MINOR-4; the laptop's session takes back any).
 *  2. Eligibility, per receipt, in words: `expired`; `past` (its day has ended — or a move's earlier day has, which it can't
 *     go back to); `executed` (started, done, a performed session or a completion match: performed work is never touched);
 *     `ineligible` (a race, a programme's session); `has_dependents` (an open receipt that relies on it isn't named);
 *     `group_incomplete` (the request's other open receipts — ops applied together go back together — aren't all named).
 *  3. Preflight: the row as it now reads (`POST_STATE_SQL`) against the receipt's `post_state`. Any difference — a laptop
 *     move, a document edit, a skip — is `changed_since`, with how it stands now. A group with any receipt refused is
 *     refused whole (`group_refused` for the rest): nothing of it is written.
 *  4. Apply, one receipt at a time, newest first within its group, each in ONE batch through run-garden's own writer: the
 *     inverse write, guarded by the premise (the row still reads exactly `post_state`, and the receipt is still open and
 *     unexpired), then the receipt marked `taken_back` with this request and what it did, and an audit row — both gated on
 *     the inverse having landed at this instant. A create is archived (`removeFromPlan`, reason `taken_back`: never deleted);
 *     a revision is revised back to its base's document as a NEW revision (`reviseDocWorkout`: history kept); a move moves
 *     back (`applyMove`, guarded); a skip is put back (`unskipWorkout`, guarded). A guard that refuses at the write is that
 *     receipt's `changed_since`, and the group's later receipts are `not_attempted`: a race after preflight can leave a group
 *     partly taken back, and the answer says so receipt by receipt — never silently.
 *  5. Compensation: what the providers still have to do, read live from their own rows (`compensationOf`): the watch's
 *     delete — owed on the sent build while COROS writes are off (pending), or its job: pending while it runs, done only once
 *     verified, failed else (review B-4, B-6) — and the calendar's event: a create's pending until the sync removes it, a
 *     move's, skip's or revise's pending while the row's own calendar state is (review B-5). Never "undone" while a
 *     provider step is pending.
 *  6. One request stays inside the Worker's statement budget: receipts are taken back while their declared cost fits
 *     (`TAKE_BACK_COST`); the rest come back in `remaining`, for the phone to send again with the same `requestId`.
 *
 * WHAT IT COVERS (R1): places, and an approve's `doc_workout` ops (new and revised) and `plan_adjust` moves and skips. An
 * ease, a length change, a remove or a restore, and every plan-level op, write no receipt: an ease replaces a session's
 * content, which no run-garden writer restores, so it is changed on the laptop (CALLS C4).
 */
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, calendarEventLinks, corosWriteJobs, plannedWorkouts, sessionBuilds, takeBackReceipts, workoutDocRevisions } from "@rg/database";
import { addDays, newId, parseStoredWorkoutDoc, todayInZone, type UserPreferences } from "@rg/domain";
import { sha256Hex } from "../auth/crypto.js";
import { runWireOf, type Env } from "../env.js";
import { loadPreferences } from "./calendar-sync.js";
import type { AlsoInBatch, AtomicStatement, Db, TakeBackBatch } from "./db.js";
import { startOfLocalDate } from "./design-context.js";
import type { ValidateCtx } from "@rg/workout";
import {
  DocInvalidError,
  DocWorkoutNotFoundError,
  NotEditableError,
  PastDateError,
  reviseDocWorkout,
  reviseJudged,
  RunUnsupportedError,
  StaleRevisionError,
  type DocWriteReceipt,
} from "./doc-workouts.js";
import { RestoreInProgressError } from "./programs.js";
import { provisionalRecord } from "./session-build.js";
import { UNPUSH_OWED_AT_PATH } from "./watch-push.js";
import { applyMove } from "./jobs.js";
import { removeFromPlan, unskipWorkout } from "./plan-mutations.js";

// ── The receipt ─────────────────────────────────────────────────────────────

export type ReceiptSource = "place" | "coach_approve";
/** What the write did to its row. */
export type ReceiptOp = "create" | "revise" | "move" | "skip";
export type ReceiptStatus = "open" | "taken_back" | "expired";

/** How long a receipt stays open at most: 8 days (DESIGN-3 §3.4.3). */
export const RECEIPT_DAYS = 8;

export { COMPARE_COLUMNS, POST_STATE_SQL } from "./receipt-landed.js";
import { POST_STATE_SQL } from "./receipt-landed.js";

/** A receipt's id: `tb_` and 32 hex of sha-256 over the account, the source and its key — the same for a retried write. */
export async function receiptIdOf(userId: string, source: ReceiptSource, sourceKey: string): Promise<string> {
  return `tb_${(await sha256Hex(`${userId}|${source}|${sourceKey}`)).slice(0, 32)}`;
}

/** When a receipt lapses: 8 days after `createdAt`, or the end of the session's `date` on the account's clock if sooner. */
export function receiptExpiry(createdAt: string, date: string, timezone: string): string {
  const eightDays = new Date(Date.parse(createdAt) + RECEIPT_DAYS * 86_400_000).toISOString();
  const dayEnd = startOfLocalDate(timezone, addDays(date, 1));
  return dayEnd < eightDays ? dayEnd : eightDays;
}

/** The provider work a write queued, so the take-back can say what of it is still to be undone. */
export type Effect = { provider: "watch" | "calendar" };

export interface ReceiptSpec {
  id: string;
  userId: string;
  source: ReceiptSource;
  sourceKey: string;
  /** `device:<native_devices.id>` or `session`. */
  madeBy: string;
  op: ReceiptOp;
  groupId: string;
  dependsOn: readonly string[];
  /** null for a create; a revise's `{rev}`; a move's `{date, time}`; a skip's `{date}`. */
  preState: Record<string, unknown> | null;
  effects: readonly Effect[];
  expiresAt: string;
  /** A condition on the row (raw on "planned_workouts") that says this write landed, beside its instant: a skip's row is
   * skipped, a move's on its new day. */
  landed?: SQL;
}

/** Who made a write: the device that signed the request in, or the laptop's session. */
export const madeByOf = (device: { id: string } | undefined): string => (device ? `device:${device.id}` : "session");

/** Whether `asker` (`madeByOf`) may act on a receipt: a phone, only on what it made; the laptop's session, on any. */
export const madeByMatches = (r: { madeBy: string }, asker: string): boolean => !asker.startsWith("device:") || r.madeBy === asker;

/**
 * The receipt's insert, for the write's own batch: its `post_state` read from the row at the write's instant (NULL, failing
 * the batch, when the write didn't land — receipt-landed.ts). A write retried after it landed writes nothing new: the writers
 * answer it before their batch, and a race between two is the primary key's.
 */
export function receiptInsert(db: Db, r: ReceiptSpec): AlsoInBatch {
  return ({ now, workoutId }) => [
    db.insert(takeBackReceipts).values({
      id: r.id,
      userId: r.userId,
      source: r.source,
      sourceKey: r.sourceKey,
      madeBy: r.madeBy,
      workoutId,
      op: r.op,
      groupId: r.groupId,
      dependsOn: JSON.stringify(r.dependsOn),
      preState: r.preState === null ? null : JSON.stringify(r.preState),
      postState: sql`(select ${POST_STATE_SQL} from "planned_workouts" where "planned_workouts"."id" = ${workoutId} and "planned_workouts"."user_id" = ${r.userId} and "planned_workouts"."updated_at" = ${now}${r.landed ? sql` and ${r.landed}` : sql``})`,
      effects: JSON.stringify(r.effects),
      createdAt: now,
      expiresAt: r.expiresAt,
      status: "open",
    }),
  ];
}

/**
 * THE RECEIPTS ONE APPROVE REQUEST WRITES (design-approve.ts): one group for the request (its ops go back together), each
 * receipt relying on the ones this request landed before it, keyed `<proposalId>:<opId>`. `insert` and `docHook` build a
 * receipt for an op's write; `landed` records that the write stood (its receipt with it); `written` is the answer's list.
 */
export class ReceiptLog {
  readonly groupId: string;
  readonly written: Array<{ opId: string; receiptId: string }> = [];
  private readonly ids = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly proposalId: string,
    private readonly madeBy: string,
    private readonly timezone: string,
    private readonly now: string,
  ) {
    this.groupId = `${proposalId}:${newId()}`;
  }

  private async spec(opId: string, op: ReceiptOp, date: string, preState: Record<string, unknown> | null, landed?: SQL): Promise<ReceiptSpec> {
    const id = await receiptIdOf(this.userId, "coach_approve", `${this.proposalId}:${opId}`);
    this.ids.set(opId, id);
    return {
      id,
      userId: this.userId,
      source: "coach_approve",
      sourceKey: `${this.proposalId}:${opId}`,
      madeBy: this.madeBy,
      op,
      groupId: this.groupId,
      dependsOn: [...this.order],
      preState,
      effects: op === "create" ? [{ provider: "calendar" }] : [],
      expiresAt: receiptExpiry(this.now, date, this.timezone),
      ...(landed ? { landed } : {}),
    };
  }

  /** A change's receipt (a move, a skip) for the write's own batch. */
  async insert(opId: string, op: ReceiptOp, date: string, preState: Record<string, unknown> | null, landed?: SQL): Promise<AlsoInBatch> {
    return receiptInsert(this.db, await this.spec(opId, op, date, preState, landed));
  }

  /** A document write's receipt (a new workout, a revision): in its batch, and settled once its row is placed. */
  async docHook(opId: string, op: ReceiptOp, date: string, preState: Record<string, unknown> | null): Promise<DocWriteReceipt> {
    const spec = await this.spec(opId, op, date, preState);
    return { alsoInBatch: receiptInsert(this.db, spec), settleId: spec.id };
  }

  /** The op's write stood: its receipt with it. */
  landed(opId: string): void {
    const id = this.ids.get(opId);
    if (!id || this.order.includes(id)) return;
    this.order.push(id);
    this.written.push({ opId, receiptId: id });
  }
}

// ── The take-back ───────────────────────────────────────────────────────────

/** The Worker's statement budget for one request (Workers Free: 50, the repo keeps 45), and what a take-back always spends:
 * the gate, the receipts, the preferences, the rows, the base revisions, compensation (two) and slack. */
export const TAKE_BACK_BUDGET = 45;
export const TAKE_BACK_FIXED = 10;
/**
 * What one receipt's inverse write can cost, at most, by op (its writer's reads, its batch, the receipt and audit, its tail).
 * A revise's day is not read again: its preflight read it (`TAKE_BACK_PREFLIGHT`).
 */
export const TAKE_BACK_COST: Readonly<Record<ReceiptOp, number>> = { create: 14, revise: 22, move: 19, skip: 7 };
/** What checking a receipt before its group is written costs (`preflightOf`): a revise's revisability (the library) and the
 * day its base document is judged for (the place, the profiles, the history, the day's checks: 10). */
export const TAKE_BACK_PREFLIGHT: Readonly<Record<ReceiptOp, number>> = { create: 0, revise: 11, move: 0, skip: 0 };

export type Refusal =
  | "expired"
  | "past"
  | "executed"
  | "ineligible"
  | "cant_restore"
  | "has_dependents"
  | "group_incomplete"
  | "changed_since"
  | "group_refused"
  | "not_attempted";

export type CompensationState = "pending" | "done" | "failed";
export interface Compensation {
  provider: "watch" | "calendar";
  state: CompensationState;
}

export type ReceiptOutcome =
  | { receiptId: string; outcome: "taken_back"; op: ReceiptOp; workoutId: string; at: string; compensation: Compensation[] }
  | { receiptId: string; outcome: "already_taken_back"; op: ReceiptOp; workoutId: string; at: string | null; compensation: Compensation[] }
  | { receiptId: string; outcome: "not_found" }
  | { receiptId: string; outcome: "refused"; error: Refusal; why: string; receiptIds?: string[]; now?: SessionNow | null };

/** How a session stands now, in the phone's words (a `changed_since` refusal's `now`; never the row's columns: A MINOR-2). */
export interface SessionNow {
  date: string | null;
  time: string | null;
  state: string | null;
  archived: boolean;
  title: string | null;
  minutes: number | null;
}

export interface TakeBackAnswer {
  requestId: string;
  outcomes: ReceiptOutcome[];
  /** Named, eligible, and left for the next request (the statement budget): send them again with the same `requestId`. */
  remaining: string[];
}

/** The words of each refusal (the phone shows them as they are). */
export const REFUSAL_WORDS: Readonly<Record<Refusal, string>> = {
  expired: "It's too late to take this back from the phone: change it on your plan instead.",
  past: "Its day has gone, so it stays as it is.",
  executed: "You've started or done this session, so it stays as it is.",
  ineligible: "This session can't be taken back from the phone: change it on the laptop.",
  cant_restore: "Its earlier version can't go back on that day now: change it on the laptop.",
  has_dependents: "Something added after it relies on it: take that back first, or with it.",
  group_incomplete: "These were added together, so they go back together: take them back at once.",
  changed_since: "It changed after it was added, so it stays as it is now.",
  group_refused: "It was added with another change that can't be taken back, so neither was.",
  not_attempted: "It was added with a change that couldn't be taken back just now, so it stays as it is.",
};

type ReceiptRow = typeof takeBackReceipts.$inferSelect;

const parsedJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const idsOf = (text: string): string[] => {
  const v = parsedJson(text);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/**
 * THE CLAIM, first in the inverse's batch: the receipt marked taken back by this request at `at` — only while it is open and
 * live and its row still reads exactly as the write it records left it (`post_state`). Everything after it in the batch is
 * held to it: the inverse write's guard is `claimedBy`, and its check fails the batch when the inverse didn't land.
 */
function claimOf(db: Db, r: ReceiptRow, requestId: string, at: string): AtomicStatement {
  const t = takeBackReceipts;
  const result = JSON.stringify({ outcome: "taken_back", op: r.op, workoutId: r.workoutId, at });
  return db
    .update(t)
    .set({ status: "taken_back", requestId, takenBackAt: at, result })
    .where(
      and(
        eq(t.id, r.id),
        eq(t.userId, r.userId),
        eq(t.status, "open"),
        sql`${t.expiresAt} > ${at}`,
        sql`exists (select 1 from "planned_workouts" where "planned_workouts"."id" = ${r.workoutId} and "planned_workouts"."user_id" = ${r.userId} and ${POST_STATE_SQL} = ${r.postState})`,
      ),
    );
}

/** The inverse write's guard: this request's claim of the receipt, made at `at` in the same batch. */
function claimedBy(r: Pick<ReceiptRow, "id" | "userId">, requestId: string, at: string): SQL {
  const t = takeBackReceipts;
  return sql`exists (select 1 from ${t} where ${t.id} = ${r.id} and ${t.userId} = ${r.userId} and ${t.status} = 'taken_back' and ${t.requestId} = ${requestId} and ${t.takenBackAt} = ${at})`;
}

/** What the row reads once the receipt's inverse has landed at `at` (raw on "planned_workouts", for the check). */
function landedOf(r: ReceiptRow, at: string): SQL {
  const pre = parsedJson(r.preState) as Record<string, unknown> | null;
  const post = parsedJson(r.postState) as { workout_doc_rev?: unknown } | null;
  const c = (col: string) => sql.raw(`"planned_workouts"."${col}"`);
  switch (r.op as ReceiptOp) {
    case "create":
      return sql`${c("archived_at")} = ${at} and ${c("archive_reason")} = 'taken_back'`;
    case "skip":
      return sql`${c("completion_state")} = 'scheduled' and ${c("updated_at")} = ${at}`;
    case "move":
      return sql`${c("effective_date")} = ${String(pre?.date ?? "")} and ${c("effective_time")} = ${String(pre?.time ?? "")} and ${c("updated_at")} = ${at}`;
    case "revise":
      return sql`${c("workout_doc_rev")} = ${Number(post?.workout_doc_rev ?? -1) + 1} and ${c("updated_at")} = ${at}`;
  }
  return sql`0`;
}

/**
 * The take-back's statements for its inverse's batch: the claim first; after the inverse, its CHECK and its audit row in one
 * insert — only once the claim landed, and with a kind that is NULL (failing the whole batch, the claim with it) when the
 * inverse didn't land as it should (`landedOf`). So a receipt is taken back exactly when its inverse lands, and never else.
 */
export function takeBackBatchOf(db: Db, r: ReceiptRow, requestId: string, madeBy: string, at: string): TakeBackBatch {
  const detail = JSON.stringify({ receiptId: r.id, op: r.op, workoutId: r.workoutId, source: r.source, requestId, by: madeBy });
  return {
    first: () => [claimOf(db, r, requestId, at)],
    after: () => [
      db
        .insert(auditEvents)
        .select(
          sql`select ${newId()}, ${r.userId}, (select 'take_back' from "planned_workouts" where "planned_workouts"."id" = ${r.workoutId} and "planned_workouts"."user_id" = ${r.userId} and ${landedOf(r, at)}), ${detail}, ${at} where ${claimedBy(r, requestId, at)}`,
        ),
    ],
  };
}

/** The error a batch answers when its take-back check found the inverse not landed (D1 may wrap it, as `cause`). */
export function takeBackNotLanded(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 4; i++, x = (x as { cause?: unknown }).cause) {
    if (x instanceof Error && /NOT NULL constraint failed: audit_events\.kind/.test(x.message)) return true;
  }
  return false;
}

/** A watch delete's job, by its status: running is pending, done only once verified (read back), anything else — failed,
 * needing attention, cancelled, neutralised by a restore, or superseded with no newer delete — failed (review B-4). */
const WATCH_RUNNING: readonly string[] = ["queued", "claimed", "in_progress", "verifying"];
const watchStateOf = (status: string): CompensationState => (WATCH_RUNNING.includes(status) ? "pending" : status === "verified" ? "done" : "failed");

/**
 * The live state of what the providers still have to undo, by receipt (`key`), for its row taken back at `since` by `op`
 * (three statements, for any number of rows): the watch's delete owed on the sent build (COROS writes off: pending until
 * `runOwedUnpushes` queues it), else its newest delete job since; the calendar's event, if one is still linked.
 */
export async function compensationOf(
  db: Db,
  userId: string,
  rows: ReadonlyArray<{ key: string; workoutId: string; since: string; op: string }>,
): Promise<Map<string, Compensation[]>> {
  const out = new Map<string, Compensation[]>(rows.map((r) => [r.key, []]));
  if (rows.length === 0) return out;
  const ids = [...new Set(rows.map((r) => r.workoutId))];
  const [jobs, links, owed] = await Promise.all([
    db
      .select({ workoutId: corosWriteJobs.workoutId, status: corosWriteJobs.status, requestedAt: corosWriteJobs.requestedAt })
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.workoutId, ids), eq(corosWriteJobs.kind, "coach_delete_workout"))),
    db
      .select({ workoutId: calendarEventLinks.workoutId, state: calendarEventLinks.state, rowSync: plannedWorkouts.calendarSyncState })
      .from(calendarEventLinks)
      .innerJoin(plannedWorkouts, and(eq(plannedWorkouts.id, calendarEventLinks.workoutId), eq(plannedWorkouts.userId, userId)))
      .where(inArray(calendarEventLinks.workoutId, ids)),
    // Owed as `runOwedUnpushes` reads it: a sent build (locked, or a provisional copy's record) holding the owed mark.
    db
      .select({ workoutId: sessionBuilds.workoutId })
      .from(sessionBuilds)
      .where(
        and(
          eq(sessionBuilds.userId, userId),
          inArray(sessionBuilds.workoutId, ids),
          or(isNotNull(sessionBuilds.lockedAt), provisionalRecord()),
          sql`json_extract(${sessionBuilds.payload}, ${UNPUSH_OWED_AT_PATH}) is not null`,
        ),
      ),
  ]);
  for (const r of rows) {
    const list = out.get(r.key)!;
    const newest = jobs.filter((j) => j.workoutId === r.workoutId && j.requestedAt >= r.since).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    if (owed.some((o) => o.workoutId === r.workoutId)) list.push({ provider: "watch", state: "pending" });
    else if (newest) list.push({ provider: "watch", state: watchStateOf(newest.status) });
    const linked = links.filter((l) => l.workoutId === r.workoutId && l.state !== "user_deleted");
    if (linked.length === 0) continue;
    // A create's event is on the calendar until the next sync removes it (the suppression asks it to); a move's, skip's or
    // revise's stays, and is the row's again once the sync has written it back (its calendar state).
    const pending = r.op === "create" || linked.some((l) => l.rowSync === "pending");
    list.push({ provider: "calendar", state: pending ? "pending" : "done" });
  }
  return out;
}

/** A row as the take-back reads it: its compare state now, and what says whether work was performed on it. */
interface RowNow {
  id: string;
  state: string;
  category: string;
  origin: string | null;
  effectiveDate: string;
  completionState: string;
  contentState: string | null;
  /** What its revisability reads (a revise's preflight). */
  sport: string | null;
  workoutDoc: string | null;
  performed: number;
  matched: number;
}

async function rowsNow(db: Db, userId: string, ids: readonly string[]): Promise<Map<string, RowNow>> {
  if (ids.length === 0) return new Map();
  const pw = plannedWorkouts;
  const rows = await db
    .select({
      id: pw.id,
      state: sql<string>`${POST_STATE_SQL}`,
      category: pw.category,
      origin: pw.origin,
      effectiveDate: pw.effectiveDate,
      completionState: pw.completionState,
      contentState: pw.contentState,
      sport: pw.sport,
      workoutDoc: sql<string | null>`${pw.workoutDoc}`,
      // Correlated by explicit names: a column inside a select's own SQL is written unqualified.
      performed: sql<number>`exists (select 1 from "performed_sessions" ps where ps."workout_id" = "planned_workouts"."id" and ps."user_id" = ${userId})`,
      matched: sql<number>`exists (select 1 from "workout_completion_matches" m where m."workout_id" = "planned_workouts"."id")`,
    })
    .from(pw)
    .where(and(eq(pw.userId, userId), inArray(pw.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}

/** How the row stands now, in the phone's words (null when the row is gone): never its columns (A MINOR-2). */
function stateNow(row: RowNow | undefined): SessionNow | null {
  const s = row ? (parsedJson(row.state) as Record<string, unknown> | null) : null;
  if (!s) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const seconds = typeof s.calendar_block_duration_seconds === "number" ? s.calendar_block_duration_seconds : null;
  return {
    date: text(s.effective_date),
    time: text(s.effective_time),
    state: text(s.completion_state),
    archived: s.archived_at !== null && s.archived_at !== undefined,
    title: text(s.title),
    minutes: seconds === null ? null : Math.round(seconds / 60),
  };
}

/** A receipt's own refusal at preflight, or null. */
function ownRefusal(r: ReceiptRow, row: RowNow | undefined, today: string, now: string): Refusal | null {
  if (r.status === "expired" || r.expiresAt <= now) return "expired";
  if (!row) return "changed_since";
  if (row.completionState === "completed" || row.contentState === "started" || row.contentState === "done" || Number(row.performed) === 1 || Number(row.matched) === 1) return "executed";
  const pre = parsedJson(r.preState) as { date?: unknown } | null;
  if (row.effectiveDate < today || (r.op === "move" && typeof pre?.date === "string" && pre.date < today)) return "past";
  if (row.category === "race" || row.origin === "program" || row.origin === "on_demand") return "ineligible";
  if (row.state !== r.postState) return "changed_since";
  return null;
}

/**
 * Take back the named receipts (see the module comment). `madeBy` is who asks (recorded in the audit). Writes nothing for a
 * receipt it refuses, and nothing at all for a group any receipt of which it refuses.
 */
export async function takeBack(
  db: Db,
  env: Env,
  userId: string,
  input: { receiptIds: readonly string[]; requestId: string; madeBy: string },
  now: string,
): Promise<TakeBackAnswer> {
  const t = takeBackReceipts;
  const named = [...new Set(input.receiptIds)];
  // The named receipts, whatever their state, and every open live one of the account (its groups and dependents): one read.
  const [receipts, prefs] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), or(inArray(t.id, named), and(eq(t.status, "open"), sql`${t.expiresAt} > ${now}`)))),
    loadPreferences(db, userId),
  ]);
  // A phone's own receipts only (A MINOR-4): another maker's is not_found to it, as another account's is.
  const byId = new Map(receipts.filter((r) => madeByMatches(r, input.madeBy)).map((r) => [r.id, r]));
  const open = receipts.filter((r) => r.status === "open" && r.expiresAt > now);
  const today = todayInZone(prefs.timezone, new Date(now));
  const outcomes = new Map<string, ReceiptOutcome>();
  const asked = named.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  for (const id of named) if (!byId.has(id)) outcomes.set(id, { receiptId: id, outcome: "not_found" });
  // Taken back, by this request or another: answered at the end, its compensation read live with the rest.
  const answered: Array<{ r: ReceiptRow; requestId: string | null; at: string | null }> = [];

  // 1. Taken back already: this request's answer again, or another's.
  const done = asked.filter((r) => r.status === "taken_back");
  const live = asked.filter((r) => r.status !== "taken_back");
  const rows = await rowsNow(db, userId, live.map((r) => r.workoutId));
  for (const r of done) answered.push({ r, requestId: r.requestId, at: r.takenBackAt });

  // 2–3. Each receipt's own refusal, then its group's and its dependents'; a group refused in part is refused whole.
  const askedIds = new Set(live.map((r) => r.id));
  const refusals = new Map<string, { error: Refusal; receiptIds?: string[] }>();
  for (const r of live) {
    const own = ownRefusal(r, rows.get(r.workoutId), today, now);
    if (own) {
      refusals.set(r.id, { error: own });
      continue;
    }
    const dependents = open.filter((o) => !askedIds.has(o.id) && idsOf(o.dependsOn).includes(r.id)).map((o) => o.id);
    if (dependents.length > 0) {
      refusals.set(r.id, { error: "has_dependents", receiptIds: dependents });
      continue;
    }
    const groupLeft = open.filter((o) => o.groupId === r.groupId && !askedIds.has(o.id)).map((o) => o.id);
    if (groupLeft.length > 0) refusals.set(r.id, { error: "group_incomplete", receiptIds: groupLeft });
  }
  const refusedGroups = new Set(live.filter((r) => refusals.has(r.id)).map((r) => r.groupId));
  for (const r of live) {
    const refused = refusals.get(r.id) ?? (refusedGroups.has(r.groupId) ? { error: "group_refused" as const } : null);
    if (!refused) continue;
    outcomes.set(r.id, {
      receiptId: r.id,
      outcome: "refused",
      error: refused.error,
      why: REFUSAL_WORDS[refused.error],
      ...(refused.receiptIds ? { receiptIds: refused.receiptIds } : {}),
      ...(refused.error === "changed_since" ? { now: stateNow(rows.get(r.workoutId)) } : {}),
    });
  }

  // 4. Apply, group by group, each newest first (a receipt relies on the ones written before it), within the request's
  // budget. A group is checked whole before anything of it is written: what its writers would refuse whatever the moment
  // refuses it whole (`preflightOf`, review B-2). And once one of a group is left for the next request, every older one of
  // it is too (review B-3): a group never goes back out of order.
  const eligible = live.filter((r) => !outcomes.has(r.id)).sort((a, b) => idsOf(b.dependsOn).length - idsOf(a.dependsOn).length || b.createdAt.localeCompare(a.createdAt));
  const groups = new Map<string, ReceiptRow[]>();
  for (const r of eligible) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
  const bases = await baseDocsOf(db, userId, eligible);
  const remaining: string[] = [];
  let left = TAKE_BACK_BUDGET - TAKE_BACK_FIXED;
  let first = true;
  const refuse = (r: ReceiptRow, error: Refusal, now?: RowNow) =>
    outcomes.set(r.id, { receiptId: r.id, outcome: "refused", error, why: REFUSAL_WORDS[error], ...(error === "changed_since" ? { now: stateNow(now) } : {}) });
  for (const members of groups.values()) {
    const checking = members.reduce((n, r) => n + TAKE_BACK_PREFLIGHT[r.op as ReceiptOp], 0);
    if (!first && checking + costOf(members[0]!) > left) {
      remaining.push(...members.map((r) => r.id));
      continue;
    }
    left -= checking;
    const checked = new Map<string, Exclude<Checked, { refusal: Refusal }>>();
    let refused: { id: string; error: Refusal } | null = null;
    for (const r of members) {
      const c = await preflightOf(db, r, rows.get(r.workoutId), bases, today);
      if ("refusal" in c) {
        refused = { id: r.id, error: c.refusal };
        break;
      }
      checked.set(r.id, c);
    }
    if (refused) {
      for (const r of members) refuse(r, r.id === refused.id ? refused.error : "group_refused", rows.get(r.workoutId));
      continue;
    }
    let deferred = false;
    let stopped = false;
    for (const r of members) {
      if (stopped) {
        refuse(r, "not_attempted");
        continue;
      }
      const cost = costOf(r);
      if (deferred || (!first && cost > left)) {
        deferred = true;
        remaining.push(r.id);
        continue;
      }
      first = false;
      left -= cost;
      const done = await inverseOf(db, env, prefs, r, input, today, now, checked.get(r.id)!);
      if ("at" in done) {
        answered.push({ r, requestId: input.requestId, at: done.at });
      } else if ("by" in done) {
        // Another request took it back meanwhile (review B-7): what it did, never changed_since. Its group goes on: the
        // receipt it relied on is back either way.
        answered.push({ r, requestId: done.by, at: done.takenBackAt });
      } else {
        stopped = true;
        const [again] = done.refusal === "changed_since" ? await rowsNowList(db, userId, r.workoutId) : [undefined];
        refuse(r, done.refusal, again);
      }
    }
  }

  // 5. What the providers still have to do, read live — for what this request took back, and what another had. The same
  // shape, key for key, whenever it is asked again.
  const live5 = await compensationOf(db, userId, answered.map(({ r, at }) => ({ key: r.id, workoutId: r.workoutId, since: at ?? r.createdAt, op: r.op })));
  for (const { r, requestId, at } of answered) {
    const compensation = live5.get(r.id) ?? [];
    const op = r.op as ReceiptOp;
    outcomes.set(
      r.id,
      requestId === input.requestId
        ? { receiptId: r.id, outcome: "taken_back", op, workoutId: r.workoutId, at: at ?? now, compensation }
        : { receiptId: r.id, outcome: "already_taken_back", op, workoutId: r.workoutId, at, compensation },
    );
  }
  return { requestId: input.requestId, outcomes: named.flatMap((id) => (outcomes.has(id) ? [outcomes.get(id)!] : [])), remaining };
}

async function rowsNowList(db: Db, userId: string, workoutId: string): Promise<Array<RowNow | undefined>> {
  return [(await rowsNow(db, userId, [workoutId])).get(workoutId)];
}

const costOf = (r: ReceiptRow): number => TAKE_BACK_COST[r.op as ReceiptOp] ?? TAKE_BACK_COST.revise;

/** A receipt its preflight passed: a revise's base document, and the day it was judged for (its write judges it there). */
type Checked = { refusal: Refusal } | { ok: true; doc?: unknown; dayContext?: ValidateCtx };

/** The base revisions' documents the named revises go back to, by `<workoutId>:<rev>` (one statement). */
async function baseDocsOf(db: Db, userId: string, receipts: readonly ReceiptRow[]): Promise<Map<string, string | null>> {
  const wanted = receipts.flatMap((r) => {
    const rev = r.op === "revise" ? (parsedJson(r.preState) as { rev?: unknown } | null)?.rev : undefined;
    return typeof rev === "number" ? [{ workoutId: r.workoutId, rev }] : [];
  });
  if (wanted.length === 0) return new Map();
  const v = workoutDocRevisions;
  const rows = await db
    .select({ workoutId: v.workoutId, rev: v.rev, doc: v.doc })
    .from(v)
    .where(and(eq(v.userId, userId), or(...wanted.map((x) => and(eq(v.workoutId, x.workoutId), eq(v.rev, x.rev))))));
  return new Map(rows.map((x) => [`${x.workoutId}:${x.rev}`, x.doc as string | null]));
}

/** The refusal a writer's error is, when it refuses a take-back's inverse whatever the moment. */
function writerRefusal(e: unknown): Refusal | null {
  if (e instanceof PastDateError) return "past";
  if (e instanceof NotEditableError) return "ineligible";
  if (e instanceof DocInvalidError || e instanceof RunUnsupportedError) return "cant_restore";
  if (e instanceof RestoreInProgressError) return "not_attempted";
  if (e instanceof Error && e.message === "races_cannot_move") return "ineligible";
  return null;
}

/**
 * What a receipt's writer would refuse whatever the moment, found before anything of its group is written (review B-2): a
 * move with no day and time to go back to (`ineligible`); a revise whose base revision is gone or unreadable
 * (`cant_restore`), whose row its writer would no longer revise (`past`, `ineligible`), or whose base document its day no
 * longer allows — the condition gate, a run (`reviseJudged`: `cant_restore`). A revise that passes carries its base
 * document and the day it was judged for, for its write to use.
 */
async function preflightOf(db: Db, r: ReceiptRow, row: RowNow | undefined, bases: Map<string, string | null>, today: string): Promise<Checked> {
  const pre = parsedJson(r.preState) as Record<string, unknown> | null;
  switch (r.op as ReceiptOp) {
    case "create":
    case "skip":
      return { ok: true };
    case "move":
      return typeof pre?.date === "string" && typeof pre.time === "string" ? { ok: true } : { refusal: "ineligible" };
    case "revise": {
      const rev = typeof pre?.rev === "number" ? pre.rev : null;
      const post = parsedJson(r.postState) as { workout_doc_rev?: unknown } | null;
      if (rev === null || typeof post?.workout_doc_rev !== "number") return { refusal: "ineligible" };
      const doc = parseStoredWorkoutDoc(bases.get(`${r.workoutId}:${rev}`) ?? null);
      if (!row) return { refusal: "changed_since" };
      if (!doc) return { refusal: "cant_restore" };
      const judged = await reviseJudged(db, r.userId, { ...row, id: r.workoutId }, doc, today);
      if (judged.ok) return { ok: true, doc, dayContext: judged.dayContext };
      return { refusal: writerRefusal(judged.error) ?? "cant_restore" };
    }
  }
  return { refusal: "ineligible" };
}

/**
 * The inverse write of one receipt, through run-garden's own writer, in one batch with its claim and check: the instant it
 * landed, or why it didn't — its row no longer as the write left it (`changed_since`: a race after preflight), or the
 * writer's own rule (`ineligible`, `past`). Whatever a writer answers, the receipt itself says whether it was taken back.
 */
async function inverseOf(
  db: Db,
  env: Env,
  prefs: UserPreferences,
  r: ReceiptRow,
  input: { requestId: string; madeBy: string },
  today: string,
  at: string,
  checked: Exclude<Checked, { refusal: Refusal }>,
): Promise<{ at: string } | { by: string | null; takenBackAt: string | null } | { refusal: Refusal }> {
  const takeBack = takeBackBatchOf(db, r, input.requestId, input.madeBy, at);
  const onlyIf = claimedBy(r, input.requestId, at);
  const pre = parsedJson(r.preState) as Record<string, unknown> | null;
  try {
    switch (r.op as ReceiptOp) {
      case "create":
        await removeFromPlan(db, r.userId, r.workoutId, { now: at, source: "undo", prefs, archiveReason: "taken_back", onlyIf, takeBack });
        break;
      case "skip":
        await unskipWorkout(db, r.userId, r.workoutId, { now: at, today, source: "app", onlyIf, takeBack });
        break;
      case "move":
        if (typeof pre?.date !== "string" || typeof pre.time !== "string") return { refusal: "ineligible" };
        await applyMove(db, { userId: r.userId, workoutId: r.workoutId, toDate: pre.date, toTime: pre.time, source: "app", corosWritesEnabled: prefs.corosWritesEnabled ?? false, onlyIf, takeBack, now: at });
        break;
      case "revise": {
        const post = parsedJson(r.postState) as { workout_doc_rev?: unknown } | null;
        const postRev = typeof post?.workout_doc_rev === "number" ? post.workout_doc_rev : null;
        // The base's own document, as its revision row kept it (read and judged at preflight): the take-back is a NEW
        // revision of it (history kept), judged for the day its preflight read.
        if (postRev === null || !checked.doc) return { refusal: "ineligible" };
        await reviseDocWorkout(
          db,
          r.userId,
          r.workoutId,
          { doc: checked.doc, baseRev: postRev },
          { today, now: at, prefs, runWire: runWireOf(env) },
          { sourceKind: "athlete_edit", sourceRef: `take_back:${r.id}` },
          { onlyIf, takeBack, ...(checked.dayContext ? { dayContext: checked.dayContext } : {}) },
        );
        break;
      }
      default:
        return { refusal: "ineligible" };
    }
  } catch (e) {
    // A writer's own refusal is this receipt's, never a 500 (review B-2): found here only when the moment changed it since
    // its preflight.
    const refusal = writerRefusal(e);
    if (refusal) return { refusal };
    const changed = takeBackNotLanded(e) || e instanceof StaleRevisionError || e instanceof DocWorkoutNotFoundError || (e instanceof Error && ["session_changed", "workout_not_found"].includes(e.message));
    if (!changed) throw e;
  }
  // The receipt says whether this request took it back: its claim stands only with its inverse.
  const [now] = await db
    .select({ status: takeBackReceipts.status, requestId: takeBackReceipts.requestId, takenBackAt: takeBackReceipts.takenBackAt })
    .from(takeBackReceipts)
    .where(eq(takeBackReceipts.id, r.id))
    .limit(1);
  if (now?.status !== "taken_back") return { refusal: "changed_since" };
  return now.requestId === input.requestId && now.takenBackAt === at ? { at } : { by: now.requestId, takenBackAt: now.takenBackAt };
}

/** One receipt as the phone reads it (`GET /api/native/receipts/:id`): its state and the providers' work, live. */
export async function receiptStatus(db: Db, userId: string, id: string, madeBy: string): Promise<null | {
  id: string;
  source: string;
  op: string;
  workoutId: string;
  status: ReceiptStatus;
  createdAt: string;
  expiresAt: string;
  takenBackAt: string | null;
  compensation: Compensation[];
}> {
  const [r] = await db.select().from(takeBackReceipts).where(and(eq(takeBackReceipts.id, id), eq(takeBackReceipts.userId, userId))).limit(1);
  if (!r || !madeByMatches(r, madeBy)) return null;
  const status: ReceiptStatus = r.status === "open" && r.expiresAt <= new Date().toISOString() ? "expired" : (r.status as ReceiptStatus);
  const compensation = r.status === "taken_back" ? ((await compensationOf(db, userId, [{ key: r.id, workoutId: r.workoutId, since: r.takenBackAt ?? r.createdAt, op: r.op }])).get(r.id) ?? []) : [];
  return { id: r.id, source: r.source, op: r.op, workoutId: r.workoutId, status, createdAt: r.createdAt, expiresAt: r.expiresAt, takenBackAt: r.takenBackAt, compensation };
}

/** The receipts a proposal's approved ops wrote, by op id (the proposal read's `receipts` and `takeBackable`) — to a phone,
 * only those it made (`madeByMatches`, as its take-back: review A MINOR-4); to the laptop, all. */
export async function receiptsOfProposal(db: Db, userId: string, proposalId: string, now: string, asker: string): Promise<Array<{ opId: string; receiptId: string; open: boolean }>> {
  const t = takeBackReceipts;
  const all = await db
    .select({ id: t.id, sourceKey: t.sourceKey, status: t.status, expiresAt: t.expiresAt, madeBy: t.madeBy })
    .from(t)
    // `<proposalId>:` up to `<proposalId>;` (the next character): a range the unique (user, source, key) index serves.
    .where(and(eq(t.userId, userId), eq(t.source, "coach_approve"), sql`${t.sourceKey} >= ${`${proposalId}:`}`, sql`${t.sourceKey} < ${`${proposalId};`}`));
  const rows = all.filter((r) => madeByMatches(r, asker));
  return rows.map((r) => ({ opId: r.sourceKey.slice(proposalId.length + 1), receiptId: r.id, open: r.status === "open" && r.expiresAt > now }));
}

export type { AtomicStatement };
