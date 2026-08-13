/**
 * Security audit S2 — user scoping on settings/diagnostics and settings/export.
 *
 * diagnostics used to select sync_errors and sync_runs with no user filter;
 * export used to dump EVERY activity_laps and workout_completion_matches row
 * (neither table has a user_id column). Both now return only the signed-in
 * user's rows — laps/matches scoped through the user's own activity/workout
 * ids.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

async function seedOps(db: Db, userId: string, tag: string): Promise<void> {
  await db.insert(schema.syncErrors).values({
    id: newId(),
    userId,
    provider: "google_calendar",
    operation: "sync",
    category: "auth",
    message: `${tag} error`,
    createdAt: nowInstant(),
  });
  await db.insert(schema.syncRuns).values({
    id: newId(),
    userId,
    kind: "calendar_sync",
    startedAt: nowInstant(),
    finishedAt: nowInstant(),
    status: "ok",
  });
}

async function seedTraining(
  db: Db,
  userId: string,
  tag: string,
): Promise<{ activityId: string; workoutId: string }> {
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: "2026-08-01T14:00:00Z",
    startTimeLocal: "2026-08-01T07:00:00",
    sport: "run",
    durationSeconds: 1800,
    distanceMeters: 5000,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.activityLaps).values({
    id: newId(),
    activityId,
    lapIndex: 0,
    durationSeconds: 600,
  });
  const workoutId = newId();
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId}`,
    title: `Run ${tag}`,
    category: "easy",
    sport: "run",
    originalPlanDate: "2026-08-01",
    lastVerifiedCorosDate: "2026-08-01",
    effectiveDate: "2026-08-01",
    effectiveTime: "07:00",
    completionState: "completed",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: newId(),
    workoutId,
    activityId,
    confidence: 1,
    method: "manual",
    matchedAt: nowInstant(),
  });
  return { activityId, workoutId };
}

async function request(db: Db, userId: string, path: string): Promise<Response> {
  const token = await createSession(db, userId, "test");
  const app = mountRoutes(db, "/api/settings", settingsRoutes);
  return app.request(path, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, makeEnv());
}

describe("settings/diagnostics scoping (S2)", () => {
  it("returns only the signed-in user's sync errors and runs", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedOps(db, me, "mine");
    await seedOps(db, other, "theirs");

    const res = await request(db, me, "/api/settings/diagnostics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recentErrors: { userId: string | null; message: string | null }[];
      recentSyncRuns: { userId: string | null }[];
    };
    expect(body.recentErrors).toHaveLength(1);
    expect(body.recentErrors[0]?.userId).toBe(me);
    expect(body.recentErrors[0]?.message).toBe("mine error");
    expect(body.recentSyncRuns).toHaveLength(1);
    expect(body.recentSyncRuns[0]?.userId).toBe(me);
  });
});

describe("settings/export scoping (S2)", () => {
  it("exports only the signed-in user's laps and completion matches", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    const mine = await seedTraining(db, me, "mine");
    await seedTraining(db, other, "theirs");

    const res = await request(db, me, "/api/settings/export");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activities: { id: string }[];
      plannedWorkouts: { id: string }[];
      laps: { activityId: string }[];
      completionMatches: { workoutId: string }[];
    };
    expect(body.activities.map((a) => a.id)).toEqual([mine.activityId]);
    expect(body.plannedWorkouts.map((w) => w.id)).toEqual([mine.workoutId]);
    expect(body.laps.map((l) => l.activityId)).toEqual([mine.activityId]);
    expect(body.completionMatches.map((m) => m.workoutId)).toEqual([mine.workoutId]);
  });
});
