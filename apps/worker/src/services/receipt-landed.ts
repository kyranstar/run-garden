/**
 * A TAKE-BACK RECEIPT THAT FOUND NO WRITE TO RECORD (R1; services/take-back.ts `receiptInsert`): its `post_state` is read
 * from the row as the write in the same batch left it — the row at the write's own instant — and is NULL when that write
 * didn't land (its guard refused it, or it matched no row), so the NOT NULL column fails the batch and nothing of it stands:
 * no write without its receipt, and no receipt without its write. A leaf, so the writers (plan-mutations.ts, doc-workouts.ts)
 * can tell that refusal apart — and keep a receipt with a row their collision pass re-timed — without importing the
 * take-back service.
 */
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { takeBackReceipts } from "@rg/database";
import type { AtomicStatement, Db } from "./db.js";

/**
 * THE COMPARE COLUMNS (DESIGN-3 §3.4.3): what the owner, the laptop or the coach can change of a session. Not compared — the
 * providers change these without the owner: `updated_at`, `coros_sync_state`, `calendar_sync_state`, `missing_reads`,
 * `last_verified_coros_date`. The document is held by its revision (`workout_doc_rev`), structure and parameters whole.
 */
export const COMPARE_COLUMNS = [
  "effective_date",
  "effective_time",
  "completion_state",
  "content_state",
  "archived_at",
  "archive_reason",
  "workout_doc_rev",
  "sanctioned_by",
  "category",
  "title",
  "calendar_block_duration_seconds",
  "structured_json",
  "session_params",
] as const;

/** A row's compare columns as canonical JSON, in SQL — the same text at the write and at every take-back. */
export const POST_STATE_SQL: SQL = sql.raw(`json_object(${COMPARE_COLUMNS.map((c) => `'${c}', "planned_workouts"."${c}"`).join(", ")})`);

/**
 * AFTER A WRITE'S COLLISION PASS, ONE STATEMENT (R1; review B-9): the write's own receipt (`ownId`, when it has one to
 * settle) holds its row as the pass placed it; and each open receipt of an OTHER row the pass re-timed (`moved`) holds that
 * row as the pass left it — only when the re-time is all that changed since its write (its `post_state` is the row now with
 * the time it had before the pass, `from`). A row someone changed beside it stays as its receipt saw it: changed since. None
 * when there is nothing to settle.
 */
export function receiptsAfterPass(db: Db, userId: string, ownId: string | null, moved: ReadonlyArray<{ workoutId: string; from: string }>): AtomicStatement[] {
  if (ownId === null && moved.length === 0) return [];
  const t = takeBackReceipts;
  const row = sql`"planned_workouts"."id" = "take_back_receipts"."workout_id" and "planned_workouts"."user_id" = ${userId}`;
  const before = sql.join(moved.map((m) => sql`when ${m.workoutId} then ${m.from}`), sql` `);
  const followed: SQL | undefined =
    moved.length > 0
      ? and(
          inArray(t.workoutId, moved.map((m) => m.workoutId)),
          sql`"take_back_receipts"."post_state" = (select json_set(${POST_STATE_SQL}, '$.effective_time', case "planned_workouts"."id" ${before} end) from "planned_workouts" where ${row})`,
        )
      : undefined;
  const which = ownId !== null && followed ? or(eq(t.id, ownId), followed) : ownId !== null ? eq(t.id, ownId) : followed;
  return [
    db
      .update(t)
      .set({ postState: sql`(select ${POST_STATE_SQL} from "planned_workouts" where ${row})` })
      .where(and(eq(t.userId, userId), eq(t.status, "open"), which)),
  ];
}
const NOT_LANDED = /NOT NULL constraint failed: take_back_receipts\.post_state/;

/** The error a batch answers when its receipt found the write it records not landed (D1 may wrap it, as `cause`). */
export function receiptNotLanded(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 4; i++, x = (x as { cause?: unknown }).cause) {
    if (x instanceof Error && NOT_LANDED.test(x.message)) return true;
  }
  return false;
}
