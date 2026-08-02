import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@rg/database";
import { newId, nowInstant, DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
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
