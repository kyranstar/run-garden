/**
 * An unplanned COROS run counts for the garden. The owner, 2026-11-17: "COROS runs I do that aren't on the plan don't
 * count for the garden. They should." Live, an 11 km run on a day with no planned run reached the garden only as a light
 * watering: the run clock neither reset nor advanced, the weather stayed "dry spell", and the garden walked on into
 * drought. Every real run from COROS brings the rain and resets the run clock now, matched or not; the plan keeps only
 * its own rewards (plantings and the category counters). These go through the real COROS ingest and the real walk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { fixtureCorosCompletedThreshold, normalizeCorosActivity } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { ingestActivities } from "../src/services/completion.js";
import { advanceGarden, buildDayInput, ensureGarden, loadGarden } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let genesis: string;

beforeEach(async () => {
  pinMiddayToday();
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  genesis = addDays(today, -20);
  // A plan that covers every day, so no day is a plan gap and the run clock counts each dry day.
  await db.insert(schema.trainingPlans).values({
    id: "plan",
    userId,
    provider: "coros",
    sourcePlanId: "src-plan",
    name: "Plan",
    status: "active",
    startDate: genesis,
    endDate: addDays(today, 30),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await ensureGarden(db, userId, prefs, genesis);
});
afterEach(() => vi.useRealTimers());

/** A COROS run on `date` at 09:00 local (the fixture's zone is UTC-7), through the real normalize and ingest. */
async function corosRun(date: string, labelId: string) {
  const { item, detail } = fixtureCorosCompletedThreshold(`${date}T16:00:00Z`, labelId);
  return ingestActivities(db, { userId, sources: [normalizeCorosActivity(item, detail)] });
}

async function plannedRun(date: string): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "plan",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    sourceEstimatedDurationSeconds: 3240,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

async function eventsOn(date: string) {
  return db
    .select()
    .from(schema.gardenEvents)
    .where(and(eq(schema.gardenEvents.userId, userId), eq(schema.gardenEvents.date, date)));
}

describe("an unplanned COROS run", () => {
  it("brings the rain and resets the run clock, like a planned run", async () => {
    const runDay = addDays(genesis, 10);
    const stats = await corosRun(runDay, "coros-unplanned-1");
    expect(stats.newActivities).toBe(1);
    expect(stats.completions).toBe(0); // nothing on the plan to match

    const input = await buildDayInput(db, userId, runDay, prefs);
    expect(input.completedRuns).toHaveLength(1);
    expect(input.completedRuns[0]!.unplanned).toBe(true);
    expect(input.planGap).toBe(false);

    await advanceGarden(db, userId, prefs);
    const garden = (await loadGarden(db, userId))!;
    const last = garden.state.lastSimulatedDate;
    expect(last).toBe(addDays(today, -1));
    // The clock restarted on the run's day: one dry day for each day after it, not twenty dry days but the run's.
    const daysAfter = Math.round((Date.parse(last) - Date.parse(runDay)) / 86_400_000);
    expect(garden.state.daysSinceCompletedRun).toBe(daysAfter);
    expect(garden.state.totalCompletedRuns).toBe(1);

    const day = await eventsOn(runDay);
    expect(day.some((e) => e.kind === "run_completed" && e.detail === "unplanned")).toBe(true);
    expect(day.some((e) => e.kind === "weather_changed" && e.detail === "fresh_rain")).toBe(true);
  });

  it("is credited once, and a run that matched the plan is credited once as the plan's", async () => {
    const plannedDay = addDays(genesis, 8);
    const unplannedDay = addDays(genesis, 12);
    const workoutId = await plannedRun(plannedDay);
    const matched = await corosRun(plannedDay, "coros-planned-1");
    expect(matched.completions).toBe(1);
    await corosRun(unplannedDay, "coros-unplanned-2");
    // Read again: the second ingest re-reads the first (its fingerprint is unchanged — nothing is added twice).
    await corosRun(plannedDay, "coros-planned-1");
    expect((await db.select().from(schema.activities).where(eq(schema.activities.userId, userId))).length).toBe(2);

    const onPlanned = await buildDayInput(db, userId, plannedDay, prefs);
    expect(onPlanned.completedRuns.map((r) => [r.workoutId, r.unplanned ?? false])).toEqual([[workoutId, false]]);
    const onUnplanned = await buildDayInput(db, userId, unplannedDay, prefs);
    expect(onUnplanned.completedRuns).toHaveLength(1);
    expect(onUnplanned.completedRuns[0]!.unplanned).toBe(true);

    await advanceGarden(db, userId, prefs);
    const garden = (await loadGarden(db, userId))!;
    expect(garden.state.totalCompletedRuns).toBe(2);
    // The plan's quality run earned its own counter; the unplanned run none of the category counters.
    expect(garden.state.qualityRunCount).toBe(1);
    expect(garden.state.easyRunCount).toBe(0);
    const daysAfter = Math.round((Date.parse(garden.state.lastSimulatedDate) - Date.parse(unplannedDay)) / 86_400_000);
    expect(garden.state.daysSinceCompletedRun).toBe(daysAfter);
    const runEvents = (
      await db.select().from(schema.gardenEvents).where(eq(schema.gardenEvents.userId, userId))
    ).filter((e) => e.kind === "run_completed");
    expect(runEvents.map((e) => e.date).sort()).toEqual([plannedDay, unplannedDay]);
  });
});
