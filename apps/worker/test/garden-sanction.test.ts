/**
 * Sanctioned rest in the day-input builder (garden-loop spec §1): the mercy
 * matrix — first-in-week becomes observed rest, second is merely neutral,
 * unsanctioned skips still cost, and completions always win the day.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { buildDayInput } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seedSkip(
  db: Db,
  userId: string,
  id: string,
  date: string,
  sanctioned: boolean,
): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Tempo",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "skipped",
    resolutionDate: date,
    sanctionedBy: sanctioned ? "coach" : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("sanctioned rest mercy", () => {
  it("first sanctioned skip in a rolling week → observed rest, no debt", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w1", today, true);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.missedRuns).toHaveLength(0);
    expect(input.restObserved).toBe(true);
  });

  it("second sanctioned skip in the same rolling week → neutral (no debt, no rest)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w-prior", addDays(today, -3), true);
    await seedSkip(db, userId, "w2", today, true);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.missedRuns).toHaveLength(0);
    expect(input.restObserved).toBe(false);
  });

  it("the window rolls: a sanction 7+ days ago restores mercy", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w-old", addDays(today, -7), true);
    await seedSkip(db, userId, "w2", today, true);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.restObserved).toBe(true);
  });

  it("unsanctioned skips still cost the garden", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w1", today, false);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.missedRuns).toHaveLength(1);
    expect(input.restObserved).toBe(false);
  });

  it("a completed run on the mercy day wins — no restObserved, still no debt", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w1", today, true);
    // An unplanned run the same day.
    await db.insert(schema.activities).values({
      id: newId(),
      userId,
      startTime: `${today}T14:00:00Z`,
      startTimeLocal: `${today}T07:00:00`,
      sport: "run",
      durationSeconds: 1800,
      sourceMergeConfidence: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.missedRuns).toHaveLength(0);
    expect(input.restObserved).toBe(false);
    expect(input.completedRuns.length).toBeGreaterThan(0);
  });
});
