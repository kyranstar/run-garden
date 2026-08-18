import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { schema } from "@rg/database";

export function makeDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

/**
 * Common database type satisfied by both the D1 driver (production) and the
 * better-sqlite3 driver (tests). All service code awaits every query, which is
 * a no-op for the synchronous test driver.
 */
export type Db = BaseSQLiteDatabase<"async" | "sync", unknown, typeof schema>;

/**
 * D1/SQLite caps a statement at ~100 bound variables. Bulk `.values([...])`
 * inserts of wide rows (garden plants, events, stages, laps) blow past that as
 * history grows, so split them into safe batches. `columns` is the row width;
 * we keep each statement under ~90 variables.
 */
export async function chunkedInsert<T extends object>(
  rows: T[],
  insertBatch: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  if (rows.length === 0) return;
  // COUNTED, NEVER PASSED IN. This took a hand-written column count until
  // 2026-08-18, and `import-plan.ts` and `coach-apply.ts` both said 15 for
  // `planned_workout_stages`. Five columns were later added to that table
  // (`reps`, `loadKg`, `loadBodyweight`, `restSeconds`, `note`) and the literals
  // stayed 15, so the batch stayed 6 rows while each row grew to 20 bindings:
  // 120 against D1's ~100 cap. Every import of a workout with six or more
  // stages then threw `D1_ERROR: too many SQL variables`, and because the read's
  // catch blamed the wire it reached the athlete as "COROS unreachable" on a
  // connection answering `result=0000`. Tests never saw it — better-sqlite3 has
  // no such cap — and no reviewer would spot a number that was right when
  // written. A count that cannot be stale is the only version worth having.
  const perBatch = Math.max(1, Math.floor(90 / Math.max(1, Object.keys(rows[0] as object).length)));
  for (let i = 0; i < rows.length; i += perBatch) {
    await insertBatch(rows.slice(i, i + perBatch));
  }
}

/**
 * The same ~100 bound-variable cap seen from the other side: an `inArray`
 * binds one variable per element, so a list longer than this becomes a failing
 * statement in production while passing in tests — better-sqlite3 has no such
 * cap. 90 leaves room for the other bindings in the same statement, matching
 * `chunkedInsert`'s budget above.
 */
export const IN_ARRAY_CHUNK = 90;

/** Split ids into `size`-sized batches. Exported so the batching is testable. */
export function chunkIds(ids: string[], size: number = IN_ARRAY_CHUNK): string[][] {
  const width = Math.max(1, size);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += width) out.push(ids.slice(i, i + width));
  return out;
}
