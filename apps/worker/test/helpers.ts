import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { schema } from "@rg/database";
import { newId, nowInstant, DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import type { AppContext } from "../src/auth/middleware.js";
import type { Db } from "../src/services/db.js";
import { savePreferences } from "../src/services/calendar-sync.js";

const MIGRATIONS_DIR = join(__dirname, "../../../packages/database/migrations");

/**
 * D1's real per-statement bound-variable ceiling. SQLite compiled for D1 keeps
 * `SQLITE_LIMIT_VARIABLE_NUMBER` at 100; better-sqlite3 ships 32766, which is
 * precisely why an unchunked `inArray` passes every local test and then throws
 * `D1_ERROR: too many SQL variables` in production.
 */
export const D1_BIND_LIMIT = 100;

/**
 * Make the test driver as strict as D1 about bound variables.
 *
 * Without this the whole class of "too many SQL variables" bug is invisible
 * locally: better-sqlite3 happily binds thousands. A live coach wake burned
 * 125 seconds and an LLM call, persisted its briefing, and then died on an
 * unchunked 134-id `inArray` that every test in this repo had been passing
 * over for months. Tests that opt into `boundVariableCap` fail the same way,
 * in milliseconds.
 */
function installBoundVariableCap(sqlite: Database.Database, cap: number): void {
  const prepare = sqlite.prepare.bind(sqlite);
  const guard = (stmt: Record<string, unknown>, method: string): void => {
    const original = stmt[method];
    if (typeof original !== "function") return;
    const bound = (original as (...a: unknown[]) => unknown).bind(stmt);
    stmt[method] = (...params: unknown[]) => {
      // Drizzle's better-sqlite3 driver spreads params as individual args.
      const count =
        params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]).length : params.length;
      if (count > cap) {
        throw new Error(
          `D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR ` +
            `(statement bound ${count} variables, D1 allows ${cap}) — ` +
            `chunk the id list with chunkIds() from services/db.ts`,
        );
      }
      return bound(...params);
    };
  };
  (sqlite as unknown as { prepare: unknown }).prepare = (...args: unknown[]) => {
    const stmt = (prepare as (...a: unknown[]) => unknown)(...args) as Record<string, unknown>;
    // `.raw()`/`.pluck()` return the same statement object, so guarding these
    // four own-properties covers every path drizzle takes to execute it.
    for (const method of ["run", "get", "all", "iterate"]) guard(stmt, method);
    return stmt;
  };
}

/**
 * In-memory SQLite with the real D1 migrations applied.
 *
 * Pass `{ boundVariableCap: D1_BIND_LIMIT }` to also enforce D1's bound-variable
 * ceiling — see `installBoundVariableCap`.
 */
export function makeTestDb(opts: { boundVariableCap?: number } = {}): Db {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  // Installed after the migrations: DDL binds nothing, and the cap should only
  // ever police application queries.
  if (opts.boundVariableCap !== undefined) installBoundVariableCap(sqlite, opts.boundVariableCap);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

export async function makeTestUser(
  db: Db,
  prefs: Partial<UserPreferences> = {},
): Promise<{ userId: string; prefs: UserPreferences }> {
  const userId = newId();
  // Unique per user: `users.google_sub` is UNIQUE, so a fixed value made a
  // second test user impossible (multi-user isolation is exactly what several
  // suites need to assert).
  await db.insert(schema.users).values({
    id: userId,
    email: `runner-${userId}@example.com`,
    googleSub: `sub-${userId}`,
    createdAt: nowInstant(),
  });
  const merged: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    timezone: "America/Los_Angeles",
    ...prefs,
  };
  await savePreferences(db, userId, merged);
  return { userId, prefs: merged };
}

/** A connected cloud COROS row, directly — for tests where only presence
 * matters (no mock-server round-trip). */
export async function connectTestCoros(db: Db, userId: string): Promise<void> {
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "coros",
    status: "connected",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    meta: { email: "runner@example.com", region: "us" },
    externalAccountId: "98765",
  });
}

/**
 * Minimal Hono host for route-level tests. Real usage (`src/index.ts`) wires
 * `withDb` (which builds a D1-backed db from `c.env.DB`) ahead of every route
 * module; tests use better-sqlite3 instead, so this swaps that middleware for
 * a direct `db` binding and mounts the routes under test at `path` — every
 * other piece of the request pipeline (`requireUser`, the route's own
 * handlers) runs unmodified. No route-level test existed anywhere in this
 * repo before Plan Studio's (grep confirms it — every prior suite calls
 * service functions directly against a test db); this is that pattern, kept
 * here rather than duplicated per test file so later route suites reuse it.
 */
export function mountRoutes(db: Db, path: string, routes: Hono<AppContext>): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route(path, routes);
  return app;
}
