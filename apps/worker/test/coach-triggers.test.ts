/**
 * Deterministic trigger layer (Plan A Task A4, spec §1): six SQL rules that
 * MARK — they never think. Dedupe: a kind re-fires only after its prior row
 * is consumed and 72h have passed, or immediately once consumed if older.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import {
  consumeTriggers,
  evaluateTriggers,
  pendingTriggers,
} from "../src/services/coach-triggers.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seedSleep(db: Db, userId: string, today: string, hoursPerNight: number[]) {
  for (let i = 0; i < hoursPerNight.length; i++) {
    const date = addDays(today, -(i + 1));
    await db.insert(schema.sleepRecords).values({
      id: `${userId}:${date}`,
      userId,
      date,
      durationSeconds: Math.round(hoursPerNight[i]! * 3600),
      contentFingerprint: `s${i}`,
      updatedAt: nowInstant(),
    });
  }
}

describe("coach triggers", () => {
  it("sleep_deficit fires on a 3-night avg under 6h and stays quiet at 7h", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSleep(db, userId, today, [5.2, 5.4, 5.1]);
    const fired = await evaluateTriggers(db, userId, prefs, today);
    expect(fired).toContain("sleep_deficit");

    const db2 = makeTestDb();
    const { userId: u2, prefs: p2 } = await makeTestUser(db2);
    await seedSleep(db2, u2, today, [7.2, 7.4, 7.1]);
    expect(await evaluateTriggers(db2, u2, p2, today)).not.toContain("sleep_deficit");
  });

  it("missed_workout fires on a recent skip resolution", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.plannedWorkouts).values({
      id: "w1",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:1",
      title: "Tempo",
      category: "quality",
      sport: "run",
      originalPlanDate: addDays(today, -1),
      lastVerifiedCorosDate: addDays(today, -1),
      effectiveDate: addDays(today, -1),
      effectiveTime: "07:00",
      completionState: "skipped",
      resolutionDate: addDays(today, -1),
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    expect(await evaluateTriggers(db, userId, prefs, today)).toContain("missed_workout");
  });

  it("plan_ending and race_proximity fire from coach plans", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: addDays(today, -30),
      endDate: addDays(today, 10),
      raceDate: addDays(today, 12),
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const fired = await evaluateTriggers(db, userId, prefs, today);
    expect(fired).toContain("plan_ending");
    expect(fired).toContain("race_proximity");
  });

  it("plan_ending ignores a bucket of one-offs — a bucket is permanently 'ending'", async () => {
    // Its end date is its last one-off, so it always looks like a plan that
    // finishes this week, and the coach was woken to plan what comes after a
    // filing drawer.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: `adhoc-lift-${userId.slice(0, 8)}`,
      userId,
      discipline: "lift",
      name: "Coach one-offs",
      status: "active",
      startDate: today,
      endDate: today,
      stampPrefix: "Coach one-offs",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    expect(await evaluateTriggers(db, userId, prefs, today)).not.toContain("plan_ending");
  });

  it("plan_horizon fires when firm detail runs short with shape weeks waiting", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: addDays(today, -30),
      endDate: addDays(today, 60),
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.coachPlanWeeks).values([
      { id: newId(), planId: "cp1", weekStart: addDays(today, -2), state: "firm", shape: null },
      {
        id: newId(),
        planId: "cp1",
        weekStart: addDays(today, 12),
        state: "shape",
        shape: { volumeTarget: "40k", keySessions: ["long"] },
      },
    ]);
    expect(await evaluateTriggers(db, userId, prefs, today)).toContain("plan_horizon");
  });

  it("comeback fires on the first completion after a 7+ day gap", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    for (const [i, date] of [addDays(today, -1), addDays(today, -10)].entries()) {
      await db.insert(schema.activities).values({
        id: `a${i}`,
        userId,
        startTime: `${date}T14:00:00Z`,
        startTimeLocal: `${date}T07:00:00`,
        sport: "run",
        durationSeconds: 1800,
        sourceMergeConfidence: 1,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    }
    expect(await evaluateTriggers(db, userId, prefs, today)).toContain("comeback");
  });

  it("dedupes: an unconsumed row blocks re-fire; consume + fresh evidence re-fires after the window", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedSleep(db, userId, today, [5, 5, 5]);
    const first = await evaluateTriggers(db, userId, prefs, today);
    expect(first).toContain("sleep_deficit");
    const second = await evaluateTriggers(db, userId, prefs, today);
    expect(second).not.toContain("sleep_deficit");

    const pending = await pendingTriggers(db, userId);
    expect(pending.map((t) => t.kind)).toContain("sleep_deficit");
    await consumeTriggers(db, userId, pending.map((t) => t.id), nowInstant());
    expect(await pendingTriggers(db, userId)).toHaveLength(0);
    // Just consumed → inside the 72h window → still no re-fire.
    expect(await evaluateTriggers(db, userId, prefs, today)).not.toContain("sleep_deficit");
  });
});

describe("notable_read (2026-08-11 rework §3)", () => {
  async function seedRead(db: Db, userId: string, flags: string[], completedAt: string): Promise<void> {
    await db.insert(schema.coachReads).values({
      id: newId(),
      userId,
      activityId: newId(),
      status: "done",
      attempt: 1,
      nextAttemptAt: completedAt,
      claimToken: null,
      claimedAt: null,
      glance: "HR drifted 6% late — fueling, not fitness.",
      body: "…",
      flags,
      model: "m",
      createdAt: completedAt,
      completedAt,
    });
  }

  it("fires for a flagged read newer than the last briefing, not for an unflagged one", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedRead(db, userId, [], nowInstant());
    let kinds = await evaluateTriggers(db, userId, prefs, today);
    expect(kinds).not.toContain("notable_read");

    await seedRead(db, userId, ["hr_drift"], nowInstant());
    kinds = await evaluateTriggers(db, userId, prefs, today);
    expect(kinds).toContain("notable_read");

    // Dedupe: unconsumed row blocks a refire.
    kinds = await evaluateTriggers(db, userId, prefs, today);
    expect(kinds).not.toContain("notable_read");
  });

  it("stays quiet when the athlete was already briefed after the read", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedRead(db, userId, ["breakthrough"], "2026-08-01T00:00:00.000Z");
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "briefing that already covered it",
      refs: {},
      at: nowInstant(),
    });
    const kinds = await evaluateTriggers(db, userId, prefs, today);
    expect(kinds).not.toContain("notable_read");
  });
});
