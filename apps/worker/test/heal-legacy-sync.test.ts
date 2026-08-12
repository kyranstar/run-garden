import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { healLegacySyncState } from "../src/services/heal-legacy-sync.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, studioPlanPushes, studioPlans, trainingPlans, calendarEventSuppressions, auditEvents } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;

async function seedTrainingPlan(): Promise<string> {
  const id = newId();
  await db.insert(trainingPlans).values({
    id,
    userId,
    provider: "coros",
    sourcePlanId: "test-plan",
    name: "Test Plan",
    status: "active",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
});

describe("healLegacySyncState", () => {
  it("migrates studio_plan_pushes with error 'changed_on_coros' to adopted status", async () => {
    // Seed a plan
    const planId = newId();
    await db.insert(studioPlans).values({
      id: planId,
      userId,
      brief: { startDate: "2026-09-07", goal: "strength" },
      plan: { weeks: [] },
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // Seed a push row with the legacy error state
    const pushId = newId();
    await db.insert(studioPlanPushes).values({
      id: pushId,
      planId,
      planVersion: 1,
      happenDay: "2026-09-07",
      sessionTitle: "Test Session",
      corosIdInPlan: "1",
      corosProgramId: "123",
      corosPlanId: "coros-plan",
      status: "pending",
      error: "changed_on_coros",
      updatedAt: nowInstant(),
    });

    const result = await healLegacySyncState(db, userId);
    expect(result.healed).toBe(true);

    const updated = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId));
    expect(updated[0]).toBeDefined();
    expect(updated[0]!.status).toBe("adopted");
    expect(updated[0]!.error).toBeNull();
  });

  it("migrates needs_attention workouts with matching dates to synced", async () => {
    const planId = await seedTrainingPlan();
    const date = "2026-09-07";
    const workoutId = newId();
    await db.insert(plannedWorkouts).values({
      id: workoutId,
      userId,
      planId,
      sourceWorkoutId: "coros-123",
      title: "Test Workout",
      category: "quality",
      sport: "run",
      effectiveDate: date,
      effectiveTime: "06:00",
      sourceEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3900,
      sourceContentFingerprint: "fp",
      originalPlanDate: date,
      corosSyncState: "needs_attention",
      lastVerifiedCorosDate: date, // Dates match
      completionState: "scheduled",
      calendarSyncState: "synced",
      archivedAt: null,
      archiveReason: null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const result = await healLegacySyncState(db, userId);
    expect(result.healed).toBe(true);

    const updated = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(updated[0]).toBeDefined();
    expect(updated[0]!.corosSyncState).toBe("synced");
  });

  it("creates auto_resolve move intent for calendar_only with date mismatch", async () => {
    const planId = await seedTrainingPlan();
    const effectiveDate = "2026-09-07";
    const verifiedDate = "2026-09-06";
    const workoutId = newId();
    await db.insert(plannedWorkouts).values({
      id: workoutId,
      userId,
      planId,
      sourceWorkoutId: "coros-123",
      title: "Test Workout",
      category: "quality",
      sport: "run",
      effectiveDate,
      effectiveTime: "06:00",
      sourceEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3900,
      sourceContentFingerprint: "fp",
      originalPlanDate: verifiedDate,
      corosSyncState: "calendar_only",
      lastVerifiedCorosDate: verifiedDate, // Dates differ
      completionState: "scheduled",
      calendarSyncState: "synced",
      archivedAt: null,
      archiveReason: null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const result = await healLegacySyncState(db, userId);
    expect(result.healed).toBe(true);

    // State should remain unchanged
    const workout = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(workout[0]!.corosSyncState).toBe("calendar_only");

    // Open intent should exist with auto_resolve source
    const intent = await openIntentFor(db, userId, workoutId, "move");
    expect(intent).toBeDefined();
    expect(intent!.source).toBe("auto_resolve");
    expect(intent!.payload).toEqual({ toDate: effectiveDate, toTime: "06:00", fromDate: verifiedDate });
  });

  it("backfills archiveReason with suppression or absence_confirmed", async () => {
    const planId = await seedTrainingPlan();
    const workoutId1 = newId();
    const workoutId2 = newId();

    // Seed archived workouts without archiveReason
    await db.insert(plannedWorkouts).values({
      id: workoutId1,
      userId,
      planId,
      sourceWorkoutId: "coros-1",
      title: "Removed Workout",
      category: "quality",
      sport: "run",
      effectiveDate: "2026-09-07",
      effectiveTime: "06:00",
      sourceEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3900,
      sourceContentFingerprint: "fp1",
      originalPlanDate: "2026-09-07",
      corosSyncState: "synced",
      lastVerifiedCorosDate: "2026-09-07",
      completionState: "scheduled",
      calendarSyncState: "synced",
      archivedAt: nowInstant(),
      archiveReason: null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    await db.insert(plannedWorkouts).values({
      id: workoutId2,
      userId,
      planId,
      sourceWorkoutId: "coros-2",
      title: "Absence Workout",
      category: "quality",
      sport: "run",
      effectiveDate: "2026-09-08",
      effectiveTime: "06:00",
      sourceEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3900,
      sourceContentFingerprint: "fp2",
      originalPlanDate: "2026-09-08",
      corosSyncState: "synced",
      lastVerifiedCorosDate: "2026-09-08",
      completionState: "scheduled",
      calendarSyncState: "synced",
      archivedAt: nowInstant(),
      archiveReason: null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // Seed suppression for first workout
    await db.insert(calendarEventSuppressions).values({
      id: newId(),
      workoutId: workoutId1,
      reason: "user_removed",
      createdAt: nowInstant(),
    });

    const result = await healLegacySyncState(db, userId);
    expect(result.healed).toBe(true);

    // First should have user_removed reason
    const first = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId1));
    expect(first[0]!.archiveReason).toBe("user_removed");

    // Second should have absence_confirmed reason
    const second = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId2));
    expect(second[0]!.archiveReason).toBe("absence_confirmed");
  });

  it("is idempotent and returns { healed: false } on second call", async () => {
    const planId = await seedTrainingPlan();
    const date = "2026-09-07";
    const workoutId = newId();
    await db.insert(plannedWorkouts).values({
      id: workoutId,
      userId,
      planId,
      sourceWorkoutId: "coros-123",
      title: "Test Workout",
      category: "quality",
      sport: "run",
      effectiveDate: date,
      effectiveTime: "06:00",
      sourceEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3900,
      sourceContentFingerprint: "fp",
      originalPlanDate: date,
      corosSyncState: "needs_attention",
      lastVerifiedCorosDate: date,
      completionState: "scheduled",
      calendarSyncState: "synced",
      archivedAt: null,
      archiveReason: null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // First call should heal
    const firstResult = await healLegacySyncState(db, userId);
    expect(firstResult.healed).toBe(true);

    // Verify it was healed
    let updated = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(updated[0]!.corosSyncState).toBe("synced");

    // Second call should return false and not change anything
    const secondResult = await healLegacySyncState(db, userId);
    expect(secondResult.healed).toBe(false);

    // Verify nothing changed
    updated = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(updated[0]!.corosSyncState).toBe("synced");
  });
});
