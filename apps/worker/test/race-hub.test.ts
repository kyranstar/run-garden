/**
 * Race hub (2026-08-14): countdown/phase geometry, the threshold-pace goal
 * band, derived coach checklist items, and the post-race debrief window.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
    expect(await buildRaceHub(db, userId, prefs, todayInZone(prefs.timezone))).toBeNull();
    const today = todayInZone(prefs.timezone);
    expect(
      await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, -15) }, todayInZone(prefs.timezone)),
    ).toBeNull();
    expect(
      await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, -14) }, todayInZone(prefs.timezone)),
    ).not.toBeNull();
  });

  it("derives phase and the goal band from the latest threshold reading", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedHealth(db, userId, addDays(today, -2), { thresholdPaceSecPerKm: 300, staminaLevel: 77 });
    await seedHealth(db, userId, today, { thresholdPaceSecPerKm: 289, staminaLevel: 79 });

    const build = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 60) }, todayInZone(prefs.timezone));
    expect(build!.phase).toBe("build");
    expect(build!.goal).toMatchObject({ thresholdPaceSecPerKm: 289, asOf: today });
    // No race distance set → no time claim at all (audit#3-b #1).
    expect(build!.goal!.prediction).toBeNull();
    expect(build!.stamina.map((s) => s.value)).toEqual([77, 79]);

    const taper = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 14) }, todayInZone(prefs.timezone));
    expect(taper!.phase).toBe("taper");
    const raceWeek = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 3) }, todayInZone(prefs.timezone));
    expect(raceWeek!.phase).toBe("race_week");
  });

  it("goal is null before any threshold reading exists", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 30) }, todayInZone(prefs.timezone));
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

    const before = await buildRaceHub(db, userId, { ...prefs, raceDate }, todayInZone(prefs.timezone));
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
    await db
      .update(schema.plannedWorkouts)
      .set({ calendarBlockDurationSeconds: 1200 })
      .where(eq(schema.plannedWorkouts.id, "lift-1"));

    const after = await buildRaceHub(db, userId, { ...prefs, raceDate }, todayInZone(prefs.timezone));
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
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate }, todayInZone(prefs.timezone));
    expect(hub!.phase).toBe("post");
    expect(hub!.debrief).toMatchObject({ activityId: "race", durationSeconds: 2894 });
  });
});

describe("race hub — audit#3-b regressions", () => {
  it("race day itself is race week, not post", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate: today }, todayInZone(prefs.timezone));
    expect(hub!.daysToRace).toBe(0);
    expect(hub!.phase).toBe("race_week");
    // …and the day the taper opens is already the taper.
    const taper = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 21) }, todayInZone(prefs.timezone));
    expect(taper!.phase).toBe("taper");
    const build = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 22) }, todayInZone(prefs.timezone));
    expect(build!.phase).toBe("build");
    const lastBuildDay = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 7) }, todayInZone(prefs.timezone));
    expect(lastBuildDay!.phase).toBe("taper");
  });

  it("scales the goal to the athlete's actual race distance", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedHealth(db, userId, today, { thresholdPaceSecPerKm: 289 });

    const tenK = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 30),
      raceDistanceKm: 10,
    }, todayInZone(prefs.timezone));
    // A 10K takes under an hour, so it runs slightly FASTER than threshold.
    expect(tenK!.goal!.prediction!.fastSecPerKm).toBeLessThan(289);
    expect(tenK!.goal!.prediction!.distanceKm).toBe(10);

    const marathon = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 30),
      raceDistanceKm: 42.195,
    }, todayInZone(prefs.timezone));
    // A marathon runs materially slower than threshold — the old code
    // claimed threshold pace for every distance regardless.
    expect(marathon!.goal!.prediction!.fastSecPerKm).toBeGreaterThan(289 + 15);
    expect(marathon!.goal!.prediction!.fastSeconds).toBeGreaterThan(3 * 3600);
  });

  it("an unwritten race week is 'not written yet', never 'eased'", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 40) }, todayInZone(prefs.timezone));
    const lifts = hub!.checklist.find((i) => i.id === "coach-lifts")!;
    expect(lifts.done).toBe(false);
    expect(lifts.note).toBe("race week not written yet");
  });

  it("judges race-week lifts on the workout, not the buffered calendar block", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const raceDate = addDays(today, 5);
    // 11 real minutes of mobility, but 25 minutes of buffers on the calendar
    // block — prod's exact shape, which used to read as real lifting.
    await db.insert(schema.plannedWorkouts).values({
      id: "mobility",
      userId,
      planId: "p",
      sourceWorkoutId: "mobility",
      title: "Pre-Race Primer",
      category: "strength",
      sport: "strength",
      originalPlanDate: addDays(raceDate, -2),
      lastVerifiedCorosDate: addDays(raceDate, -2),
      effectiveDate: addDays(raceDate, -2),
      effectiveTime: "17:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      sourceEstimatedDurationSeconds: 660,
      calendarBlockDurationSeconds: 2160,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate }, todayInZone(prefs.timezone));
    expect(hub!.checklist.find((i) => i.id === "coach-lifts")!.done).toBe(true);
  });

  it("reads the coach's race line back, and drops it once stale", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachMessages).values({
      id: "m-fresh",
      userId,
      role: "coach",
      body: "",
      refs: { raceLine: "Six quality sessions left before the taper." },
      at: nowInstant(),
    });
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 30) }, todayInZone(prefs.timezone));
    expect(hub!.raceLine?.text).toBe("Six quality sessions left before the taper.");

    await db
      .update(schema.coachMessages)
      .set({ at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() })
      .where(eq(schema.coachMessages.id, "m-fresh"));
    const stale = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 30) }, todayInZone(prefs.timezone));
    expect(stale!.raceLine).toBeNull();
  });

  it("checklist ticks belong to one race — a new date reseeds", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const raceA = addDays(today, 30);
    const withTicks = {
      ...prefs,
      raceDate: raceA,
      raceChecklist: [{ id: `${raceA}:bib`, label: "Bib pickup / registration sorted", done: true }],
    };
    const a = await buildRaceHub(db, userId, withTicks, todayInZone(prefs.timezone));
    expect(a!.checklist.find((i) => i.id === `${raceA}:bib`)!.done).toBe(true);

    // Same stored ticks, different race → everything opens fresh.
    const b = await buildRaceHub(db, userId, { ...withTicks, raceDate: addDays(today, 200) }, todayInZone(prefs.timezone));
    expect(b!.checklist.filter((i) => i.kind === "user").every((i) => !i.done)).toBe(true);
  });

  it("a zero threshold reading is never turned into a prescription", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedHealth(db, userId, today, { thresholdPaceSecPerKm: 0, staminaLevel: 0 });
    const hub = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 30),
      raceDistanceKm: 10,
    }, todayInZone(prefs.timezone));
    expect(hub!.goal).toBeNull();
    expect(hub!.stamina).toEqual([]);
  });
});

describe("terrain awareness (2026-08-14)", () => {
  const seedRun = async (
    db: Db,
    userId: string,
    id: string,
    date: string,
    km: number,
    climb: number,
  ) => {
    await db.insert(schema.activities).values({
      id,
      userId,
      corosActivityId: id,
      startTime: `${date}T15:00:00Z`,
      startTimeLocal: `${date}T08:00:00`,
      sport: "run",
      durationSeconds: Math.round(km * 300),
      distanceMeters: km * 1000,
      elevationGainMeters: climb,
      sourceMergeConfidence: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
  };

  it("measures recent climb per km and flags training flatter than the course", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // The athlete's real shape: mostly flat city running.
    await seedRun(db, userId, "r1", addDays(today, -3), 7.9, 8);
    await seedRun(db, userId, "r2", addDays(today, -8), 10, 45);
    // Out of the window — must not count.
    await seedRun(db, userId, "old", addDays(today, -60), 9, 400);

    const hub = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 40),
      raceDistanceKm: 10,
      raceCourseClimbMetres: 120,
    }, todayInZone(prefs.timezone));
    expect(hub!.terrain.recent).toMatchObject({ runs: 2, totalClimbMetres: 53 });
    expect(hub!.terrain.recent!.metresPerKm).toBeCloseTo(3, 0);
    expect(hub!.terrain.raceMetresPerKm).toBe(12);
    expect(hub!.terrain.comparison!.verdict).toBe("under_prepared");
  });

  it("falls back to the course profile, and stays silent with neither", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedRun(db, userId, "r1", addDays(today, -2), 10, 120);

    const byProfile = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 40),
      raceCourseProfile: "rolling",
    }, todayInZone(prefs.timezone));
    expect(byProfile!.terrain.raceMetresPerKm).toBe(12);
    expect(byProfile!.terrain.comparison!.verdict).toBe("matched");

    const unset = await buildRaceHub(db, userId, { ...prefs, raceDate: addDays(today, 40) }, todayInZone(prefs.timezone));
    expect(unset!.terrain.recent!.metresPerKm).toBe(12);
    expect(unset!.terrain.raceMetresPerKm).toBeNull();
    expect(unset!.terrain.comparison).toBeNull();
  });

  it("no runs with elevation is null, never zero", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hub = await buildRaceHub(db, userId, {
      ...prefs,
      raceDate: addDays(today, 40),
      raceCourseClimbMetres: 120,
      raceDistanceKm: 10,
    }, todayInZone(prefs.timezone));
    expect(hub!.terrain.recent).toBeNull();
    expect(hub!.terrain.comparison).toBeNull();
  });
});
