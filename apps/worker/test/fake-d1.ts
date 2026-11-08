/**
 * A STAND-IN D1 CLIENT over better-sqlite3, for driving drizzle's real D1 driver (`drizzle-orm/d1`, the production one:
 * services/db.ts `makeDb`) in a test. The test database (`makeTestDb`) runs on the better-sqlite3 driver, which has no
 * `batch()`: `runAtomically` / `runAtomicallyClaim` take their transaction branch there, never the D1 one. Anything that
 * must hold in a production batch — every batch item a statement drizzle's D1 session can prepare and bind — is only seen
 * through this.
 *
 * What it keeps of D1: a prepared statement binds its values and answers `all` (`{ results }`, rows as objects), `run`
 * (`{ results: [], meta }`), `raw` (rows as arrays) and `first`; `batch` runs its statements in one transaction, in order,
 * and answers each one's result (a statement that throws rolls them all back). True and false bind as 1 and 0, as D1 binds
 * them; nothing else is converted. Synthetic data only.
 */
import type Database from "better-sqlite3";
import { makeDb } from "../src/services/db.js";
import type { Db } from "../src/services/db.js";

type Bound = { sql: string; params: unknown[] };

const bindable = (params: unknown[]) => params.map((p) => (p === true ? 1 : p === false ? 0 : p === undefined ? null : p));

function results(sqlite: Database.Database, s: Bound): { results: unknown[]; meta: { changes: number } } {
  const prepared = sqlite.prepare(s.sql);
  const params = bindable(s.params);
  if (prepared.reader) return { results: prepared.all(...params), meta: { changes: 0 } };
  const info = prepared.run(...params);
  return { results: [], meta: { changes: info.changes } };
}

function statement(sqlite: Database.Database, sql: string, params: unknown[] = []) {
  const s: Bound = { sql, params };
  return {
    ...s,
    bind: (...p: unknown[]) => statement(sqlite, sql, p),
    all: async () => results(sqlite, s),
    run: async () => results(sqlite, s),
    first: async () => (results(sqlite, s).results[0] ?? null) as unknown,
    raw: async () => {
      const prepared = sqlite.prepare(s.sql);
      if (!prepared.reader) {
        prepared.run(...bindable(s.params));
        return [];
      }
      return prepared.raw(true).all(...bindable(s.params));
    },
  };
}

/** A D1 client over `sqlite`. */
export function fakeD1(sqlite: Database.Database): D1Database {
  return {
    prepare: (sql: string) => statement(sqlite, sql),
    batch: async (stmts: Bound[]) => sqlite.transaction(() => stmts.map((s) => results(sqlite, s)))(),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
}

/** The test database `db` again, through drizzle's D1 driver: the same rows, the production batch path. */
export function viaD1(db: Db): Db {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  return makeDb(fakeD1(sqlite)) as unknown as Db;
}
