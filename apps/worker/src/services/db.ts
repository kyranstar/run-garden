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
export async function chunkedInsert<T>(
  rows: T[],
  columns: number,
  insertBatch: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  if (rows.length === 0) return;
  const perBatch = Math.max(1, Math.floor(90 / Math.max(1, columns)));
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
