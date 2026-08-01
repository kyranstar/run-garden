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
