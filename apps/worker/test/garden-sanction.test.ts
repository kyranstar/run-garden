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
  // audit#2 #9: resolutions can land days away from their workout — in
  // either direction — so tests can split the two dates.
  resolutionDate: string = date,
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
    resolutionDate,
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

describe("resolution landing dates (audit#2 #9)", () => {
  it("a skip resolved days after its workout debits on the resolution day, not the workout day", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const workoutDay = addDays(today, -2);
    await seedSkip(db, userId, "w-late", workoutDay, false, today);

    // The workout's own day sees no debit — the decision hadn't landed yet.
    const onWorkoutDay = await buildDayInput(db, userId, workoutDay, prefs);
    expect(onWorkoutDay.missedRuns).toHaveLength(0);
    // The resolution day carries it (the old same-day intersection satisfied
    // neither day, so the skip vanished from the garden entirely).
    const onResolutionDay = await buildDayInput(db, userId, today, prefs);
    expect(onResolutionDay.missedRuns).toEqual([{ workoutId: "w-late" }]);
  });

  it("an advance sanction (resolved BEFORE its day) earns its mercy on the workout day", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSkip(db, userId, "w-advance", today, true, addDays(today, -2));

    // Nothing lands on the resolution day — the workout wasn't due yet.
    const onResolutionDay = await buildDayInput(db, userId, addDays(today, -2), prefs);
    expect(onResolutionDay.missedRuns).toHaveLength(0);
    expect(onResolutionDay.restObserved).toBe(false);
    // The workout day gets the promised rest credit.
    const onWorkoutDay = await buildDayInput(db, userId, today, prefs);
    expect(onWorkoutDay.missedRuns).toHaveLength(0);
    expect(onWorkoutDay.restObserved).toBe(true);
  });

  it("the rolling-week mercy lookback counts landings, not raw resolution dates", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // Resolved 8 days ago (outside a raw-resolutionDate window) but due — and
    // therefore landed — 3 days ago, squarely inside the rolling week.
    await seedSkip(db, userId, "w-prior", addDays(today, -3), true, addDays(today, -8));
    await seedSkip(db, userId, "w-today", today, true);

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.missedRuns).toHaveLength(0);
    expect(input.restObserved).toBe(false); // second sanction in the week: neutral
  });
});

describe("coached block completion (fairness spec §4)", () => {
  async function seedPlanWithWorkouts(
    db: Db,
    userId: string,
    endDate: string,
    outcomes: Array<{ state: string; sanctioned?: boolean }>,
  ) {
    const startDate = addDays(endDate, -13);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate,
      endDate,
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    for (const [i, o] of outcomes.entries()) {
      const date = addDays(startDate, i);
      await db.insert(schema.plannedWorkouts).values({
        id: `bw${i}`,
        userId,
        planId: "cp1",
        sourceWorkoutId: `bw${i}`,
        title: `Session ${i}`,
        category: "easy",
        sport: "run",
        originalPlanDate: date,
        lastVerifiedCorosDate: date,
        effectiveDate: date,
        effectiveTime: "07:00",
        completionState: o.state,
        resolutionDate: date,
        sanctionedBy: o.sanctioned ? "coach" : null,
        sourceContentFingerprint: "fp",
        calendarBlockDurationSeconds: 3600,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    }
  }

  it("fires the day after a ≥85% block — sanctioned skips excluded from the denominator", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // 6 completed + 1 sanctioned skip = 100% of the mercy-adjusted denominator.
    await seedPlanWithWorkouts(db, userId, addDays(today, -1), [
      { state: "completed" },
      { state: "completed" },
      { state: "completed" },
      { state: "completed" },
      { state: "completed" },
      { state: "completed" },
      { state: "skipped", sanctioned: true },
    ]);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.coachedBlockCompleted).toBe(true);
  });

  it("a bucket of one-offs never earns the block credit — a bucket has no finish line", async () => {
    // The garden's coached-block unlock fired the morning after ANY single
    // one-off: `ensureAdhocPlan` writes startDate === endDate, so the bucket
    // "ended yesterday" at 100% adherence over its one session.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const yesterday = addDays(today, -1);
    await db.insert(schema.coachPlans).values({
      id: `adhoc-lift-${userId.slice(0, 8)}`,
      userId,
      discipline: "lift",
      name: "Coach one-offs",
      status: "active",
      startDate: yesterday,
      endDate: yesterday,
      stampPrefix: "Coach one-offs",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.plannedWorkouts).values({
      id: "oneoff",
      userId,
      planId: `adhoc-lift-${userId.slice(0, 8)}`,
      sourceWorkoutId: "oneoff",
      title: "Ski legs",
      category: "strength",
      sport: "strength",
      originalPlanDate: yesterday,
      lastVerifiedCorosDate: "",
      effectiveDate: yesterday,
      effectiveTime: "18:00",
      completionState: "completed",
      resolutionDate: yesterday,
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 2700,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.coachedBlockCompleted).toBeUndefined();
  });

  it("stays quiet below 85% or on any other day", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedPlanWithWorkouts(db, userId, addDays(today, -1), [
      { state: "completed" },
      { state: "skipped" },
      { state: "skipped" },
    ]);
    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.coachedBlockCompleted).toBeUndefined();
    const wrongDay = await buildDayInput(db, userId, addDays(today, 1), prefs);
    expect(wrongDay.coachedBlockCompleted).toBeUndefined();
  });
});
