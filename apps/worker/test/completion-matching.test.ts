/**
 * C19 (audit slice A): a match-driven ingest must add the matched WORKOUT's
 * own date into `stats.affectedDates`, not just the activity's date. A
 * dangling `else` left by the Strava-removal commit (completion.ts, around
 * the old `if (newState === "completed") … else affectedDates.add(…)`) made
 * that add dead code, since `newState` was always the literal "completed"
 * string.
 *
 * Downstream, `resimulateFrom` is driven by `stats.affectedDates` (see
 * devices.ts and backfill.ts) and restarts from the checkpoint immediately
 * before the EARLIEST affected date. The matcher's ±1-day window lets an
 * activity complete a workout dated a day earlier (e.g. a Monday workout
 * completed by an activity that syncs in on Tuesday) — without the workout's
 * own date in `affectedDates`, the resim never replays Monday, so the
 * garden/timeline never show that day's run even though the plan page
 * correctly shows it completed.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant, type SourceActivity } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function insertWorkout(
  db: Db,
  userId: string,
  overrides: { effectiveDate?: string; sourceProgramId?: string } = {},
): Promise<string> {
  const workoutId = newId();
  const date = overrides.effectiveDate ?? "2026-08-10"; // a Monday
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
    sourceProgramId: overrides.sourceProgramId,
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    completionState: "unresolved",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

describe("ingestActivities — matched-workout resim scheduling (C19)", () => {
  it("a cross-day match (activity synced a day after its workout) adds the WORKOUT's date to affectedDates, not just the activity's", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    // Monday's workout is durably simulated as still-open by the time
    // Tuesday's activity syncs in — the report's exact repro shape.
    await insertWorkout(db, userId, { effectiveDate: "2026-08-10", sourceProgramId: "program-123" });

    // Explicit COROS plan linkage (sourcePlannedWorkoutId) matches at
    // confidence 1, date-agnostically — the matcher's ±1-day window is what
    // lets this land on a workout dated a day before the activity.
    const activity: SourceActivity = {
      provider: "coros",
      providerActivityId: "act-1",
      sourcePlannedWorkoutId: "program-123",
      startTime: "2026-08-11T12:08:02Z",
      startTimeLocal: "2026-08-11T05:08:02",
      sport: "run",
      durationSeconds: 2400,
      distanceMeters: 6000,
      contentFingerprint: "fp-1",
    };

    const stats = await ingestActivities(db, { userId, sources: [activity] });

    expect(stats.matchesCreated).toBe(1);
    expect(stats.completions).toBe(1);
    // The bug: only "2026-08-11" (the activity's own date, added
    // unconditionally earlier in ingestActivities) would appear here: the
    // dangling `else` made the workout-date add dead code. Both dates must
    // be present so a resim driven by affectedDates[0] restarts before
    // Monday's checkpoint and actually replays it.
    expect(stats.affectedDates).toEqual(["2026-08-10", "2026-08-11"]);

    const workout = (await db.select().from(schema.plannedWorkouts))[0]!;
    expect(workout.completionState).toBe("completed");
  });

  it("a same-day match adds exactly one date (no regression from the fix)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertWorkout(db, userId, { effectiveDate: "2026-08-10", sourceProgramId: "program-456" });

    const activity: SourceActivity = {
      provider: "coros",
      providerActivityId: "act-2",
      sourcePlannedWorkoutId: "program-456",
      startTime: "2026-08-10T12:08:02Z",
      startTimeLocal: "2026-08-10T05:08:02",
      sport: "run",
      durationSeconds: 2400,
      distanceMeters: 6000,
      contentFingerprint: "fp-2",
    };

    const stats = await ingestActivities(db, { userId, sources: [activity] });

    expect(stats.completions).toBe(1);
    expect(stats.affectedDates).toEqual(["2026-08-10"]);
  });
});
