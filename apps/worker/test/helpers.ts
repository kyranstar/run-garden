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

/** In-memory SQLite with the real D1 migrations applied. */
export function makeTestDb(): Db {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
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

export async function registerTestDevice(
  db: Db,
  userId: string,
  capabilities: Record<string, boolean> = {
    readPlan: true,
    readSchedule: true,
    updateExistingScheduledWorkout: true,
    addScheduledWorkout: true,
    removeScheduledWorkout: true,
  },
): Promise<string> {
  const deviceId = newId();
  await db.insert(schema.desktopDevices).values({
    id: deviceId,
    userId,
    name: "Test Mac",
    publicKey: "test-key",
    platform: "macos",
    appVersion: "0.0.0-test",
    capabilities,
    createdAt: nowInstant(),
    lastSeenAt: nowInstant(),
  });
  return deviceId;
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
