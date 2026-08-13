/**
 * D5 (2026-08-12 production deep audit): POST /workouts/:id/unmatch used to
 * resimulate the garden from TODAY, while the matching path deliberately
 * resimulates from the workout's effectiveDate (completion.ts adds it to
 * affectedDates). Unmatching a workout resolved days ago therefore stranded
 * that day's garden events — the durable day input still credited the run.
 * The fix replays from min(workout.effectiveDate, today), mirrored here at
 * the durable garden_day_inputs boundary the way the other garden suites
 * assert.
 *
 * Mounts `planRoutes` the same way plan-routes.test.ts does.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import type { UserPreferences } from "@rg/domain";
import type { GardenDayInput } from "@rg/garden-engine";
import { planRoutes } from "../src/routes/plan.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { gardenDayInputs, plannedWorkouts, workoutCompletionMatches } = schema;

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

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

function client() {
  const app = mountRoutes(db, "/api/plan", planRoutes);
  return {
    post: (path: string) =>
      app.request(path, { method: "POST", headers: { Cookie: cookie } }, makeEnv()),
  };
}

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db);
  userId = user.userId;
  prefs = user.prefs;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

async function seedMatchedWorkout(date: string): Promise<{ workoutId: string; activityId: string }> {
  const workoutId = newId();
  await db.insert(plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 6)}`,
    title: "Session",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "completed",
    resolutionDate: date,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T14:30:00Z`,
    startTimeLocal: `${date}T07:30:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000,
    sourceMergeConfidence: 1,
    completionMatchId: `m-${activityId}`,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(workoutCompletionMatches).values({
    id: `m-${activityId}`,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
  return { workoutId, activityId };
}

const dayInputFor = async (date: string): Promise<GardenDayInput> => {
  const row = (
    await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`))
  )[0]!;
  expect(row).toBeDefined();
  return row.input as unknown as GardenDayInput;
};

describe("POST /api/plan/workouts/:id/unmatch — garden resim starts at the workout's day (D5)", () => {
  it("unmatching a workout resolved days ago rewrites that day's durable garden input, not just today's", async () => {
    const today = todayInZone(prefs.timezone);
    const genesis = addDays(today, -10);
    const runDay = addDays(today, -8);
    await ensureGarden(db, userId, prefs, genesis);
    const { workoutId, activityId } = await seedMatchedWorkout(runDay);
    await advanceGarden(db, userId, prefs);

    // Durably simulated as a planned completion on its own day.
    const before = await dayInputFor(runDay);
    expect(before.completedRuns).toHaveLength(1);
    expect(before.completedRuns[0]!.workoutId).toBe(workoutId);
    expect(before.completedRuns[0]!.unplanned).toBeUndefined();

    const res = await client().post(`/api/plan/workouts/${workoutId}/unmatch`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Route effects: match undone, workout back to unresolved.
    const match = (
      await db
        .select()
        .from(workoutCompletionMatches)
        .where(eq(workoutCompletionMatches.workoutId, workoutId))
    )[0]!;
    expect(match.undoneAt).not.toBeNull();
    const workout = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.completionState).toBe("unresolved");

    // The D5 fix: the resim replayed runDay itself. The planned completion is
    // gone from the durable input; the now-unmatched activity re-enters as an
    // unplanned session (buildDayInput's unmatched-scan), so no entry credits
    // the workout anymore. Before the fix (resim from today only) this row
    // still carried the workoutId credit.
    const after = await dayInputFor(runDay);
    expect(after.completedRuns.some((r) => r.workoutId === workoutId)).toBe(false);
    expect(after.completedRuns).toHaveLength(1);
    expect(after.completedRuns[0]!.workoutId).toBe(`unplanned-${activityId}`);
    expect(after.completedRuns[0]!.unplanned).toBe(true);
  });
});
