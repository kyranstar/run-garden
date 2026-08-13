/**
 * Security audit S4 — restoreCalendarEvent verifies workout ownership before
 * touching calendar_event_suppressions / calendar_event_links (neither table
 * has a user_id column, so the deletes key on workoutId alone).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { restoreCalendarEvent } from "../src/services/calendar-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seedSuppressedWorkout(db: Db, userId: string): Promise<string> {
  const workoutId = newId();
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId}`,
    title: "Tempo 3×10",
    category: "quality",
    sport: "run",
    originalPlanDate: "2026-08-01",
    lastVerifiedCorosDate: "2026-08-01",
    effectiveDate: "2026-08-01",
    effectiveTime: "07:00",
    completionState: "scheduled",
    calendarSyncState: "synced",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.calendarEventSuppressions).values({
    id: newId(),
    workoutId,
    eventId: "evt-1",
    reason: "user_deleted",
    createdAt: nowInstant(),
  });
  await db.insert(schema.calendarEventLinks).values({
    id: newId(),
    workoutId,
    calendarId: "cal-1",
    eventId: "evt-1",
    state: "user_deleted",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

async function counts(db: Db, workoutId: string): Promise<{ suppressions: number; links: number; syncState: string }> {
  const suppressions = await db
    .select()
    .from(schema.calendarEventSuppressions)
    .where(eq(schema.calendarEventSuppressions.workoutId, workoutId));
  const links = await db
    .select()
    .from(schema.calendarEventLinks)
    .where(eq(schema.calendarEventLinks.workoutId, workoutId));
  const workout = await db
    .select()
    .from(schema.plannedWorkouts)
    .where(eq(schema.plannedWorkouts.id, workoutId));
  return {
    suppressions: suppressions.length,
    links: links.length,
    syncState: workout[0]?.calendarSyncState ?? "missing",
  };
}

describe("restoreCalendarEvent ownership (S4)", () => {
  it("leaves another user's suppression and link rows untouched", async () => {
    const db = makeTestDb();
    const { userId: owner } = await makeTestUser(db);
    const { userId: stranger } = await makeTestUser(db);
    const workoutId = await seedSuppressedWorkout(db, owner);

    await restoreCalendarEvent(db, stranger, workoutId);

    expect(await counts(db, workoutId)).toEqual({
      suppressions: 1,
      links: 1,
      syncState: "synced",
    });
  });

  it("restores the owner's workout: rows cleared, sync state pending", async () => {
    const db = makeTestDb();
    const { userId: owner } = await makeTestUser(db);
    const workoutId = await seedSuppressedWorkout(db, owner);

    await restoreCalendarEvent(db, owner, workoutId);

    expect(await counts(db, workoutId)).toEqual({
      suppressions: 0,
      links: 0,
      syncState: "pending",
    });
  });
});
