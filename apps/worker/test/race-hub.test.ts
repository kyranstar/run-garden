/**
 * Race hub (2026-08-14): countdown/phase geometry, the threshold-pace goal
 * band, derived coach checklist items, and the post-race debrief window.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { buildRaceHub } from "../src/services/race-hub.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seedHealth(
  db: Db,
  userId: string,
  date: string,
  fields: Partial<{ thresholdPaceSecPerKm: number; staminaLevel: number }>,
) {
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${date}`,
    userId,
    date,
    ...fields,
    provider: "coros",
    contentFingerprint: "fp",
    updatedAt: nowInstant(),
  });
}

describe("buildRaceHub", () => {
  it("returns null without a race date, and after the debrief window closes", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    expect(await buildRaceHub(db, userId, prefs)).toBeNull();
    const today = todayInZone(prefs.timezone);
    expect(
      await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, -15) }),
    ).toBeNull();
    expect(
      await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, -14) }),
    ).not.toBeNull();
  });

  it("derives phase and the goal band from the latest threshold reading", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedHealth(db, userId, addDays(today, -2), { thresholdPaceSecPerKm: 300, staminaLevel: 77 });
    await seedHealth(db, userId, today, { thresholdPaceSecPerKm: 289, staminaLevel: 79 });

    const build = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 60) });
    expect(build!.phase).toBe("build");
    expect(build!.goal).toMatchObject({
      thresholdPaceSecPerKm: 289,
      bandLowSecPerKm: 289,
      bandHighSecPerKm: 296,
      predictedLowSeconds: 2890,
      predictedHighSeconds: 2960,
      asOf: today,
    });
    expect(build!.stamina.map((s) => s.value)).toEqual([77, 79]);

    const taper = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 14) });
    expect(taper!.phase).toBe("taper");
    const raceWeek = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 3) });
    expect(raceWeek!.phase).toBe("race_week");
  });

  it("goal is null before any threshold reading exists", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 30) });
    expect(hub!.goal).toBeNull();
    expect(hub!.checklist.length).toBeGreaterThan(0);
  });

  it("coach checklist items derive from approved reshapes and race-week strength", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const raceDate = addDays(today, 10);

    // A real strength session inside race week → lifts item OPEN.
    await db.insert(schema.plannedWorkouts).values({
      id: "lift-1",
      userId,
      planId: "p",
      sourceWorkoutId: "lift-1",
      title: "Heavy lower",
      category: "strength",
      sport: "strength",
      originalPlanDate: addDays(raceDate, -3),
      lastVerifiedCorosDate: addDays(raceDate, -3),
      effectiveDate: addDays(raceDate, -3),
      effectiveTime: "17:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const before = await buildRaceHub(db, userId, { ...prefs, raceDate });
    expect(before!.checklist.find((i) => i.id === "coach-restructure")!.done).toBe(false);
    expect(before!.checklist.find((i) => i.id === "coach-lifts")!.done).toBe(false);

    // Approve a windDown touching race week + shrink the lift to mobility.
    await db.insert(schema.coachProposals).values({
      id: newId(),
      userId,
      title: "Race week wind-down",
      evidence: "race in 10d",
      rationale: "arrive fresh",
      flags: [],
      ops: [
        {
          kind: "windDown",
          planId: "cp1",
          sessions: [{ date: addDays(raceDate, -2), session: { category: "easy", title: "Shakeout", durationMinutes: 20 } }],
        },
      ],
      status: "approved",
      createdAt: nowInstant(),
      expiresAt: nowInstant(),
    });
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.plannedWorkouts)
      .set({ calendarBlockDurationSeconds: 1200 })
      .where(eq(schema.plannedWorkouts.id, "lift-1"));

    const after = await buildRaceHub(db, userId, { ...prefs, raceDate });
    expect(after!.checklist.find((i) => i.id === "coach-restructure")!.done).toBe(true);
    expect(after!.checklist.find((i) => i.id === "coach-lifts")!.done).toBe(true);
  });

  it("post-race: debrief picks the longest race-day run, then the hub hides", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const raceDate = addDays(today, -2);
    for (const [id, dur] of [
      ["warmup", 900],
      ["race", 2894],
    ] as const) {
      await db.insert(schema.activities).values({
        id,
        userId,
        corosActivityId: id,
        startTime: `${raceDate}T15:00:00Z`,
        startTimeLocal: `${raceDate}T08:00:00`,
        sport: "run",
        durationSeconds: dur,
        distanceMeters: id === "race" ? 10000 : 2000,
        avgPaceSecPerKm: id === "race" ? 289 : 450,
        sourceMergeConfidence: 1,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    }
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate });
    expect(hub!.phase).toBe("post");
    expect(hub!.debrief).toMatchObject({ activityId: "race", durationSeconds: 2894 });
  });
});
