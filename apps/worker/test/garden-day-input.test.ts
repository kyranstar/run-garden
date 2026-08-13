/**
 * Day-input derivation fixes from the 2026-08-12 core-product audit (#2, #10,
 * #11) plus the unlock-date / wildlife-arrival honesty pins (#18, #22):
 * NULL-dated plans cover only the span of their own workouts, the pre-race
 * taper shelters the run-decay clock, coach-sanctioned skips leave the
 * weekAdherence denominator, and evening credit reads the run's real start
 * hour. All input-side — the simulation's transition function is untouched.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import {
  advanceGarden,
  buildDayInput,
  buildGardenView,
  ensureGarden,
  resimulateFrom,
} from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function insertPlan(
  db: Db,
  userId: string,
  opts: { id: string; startDate?: string | null; endDate?: string | null },
): Promise<void> {
  await db.insert(schema.trainingPlans).values({
    id: opts.id,
    userId,
    provider: "coros",
    sourcePlanId: `src-${opts.id}`,
    name: "Test Plan",
    status: "active",
    startDate: opts.startDate ?? null,
    endDate: opts.endDate ?? null,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function insertWorkout(
  db: Db,
  userId: string,
  opts: {
    date: string;
    time?: string;
    category?: string;
    sport?: string;
    state?: string;
    planId?: string;
    sanctioned?: boolean;
    archived?: boolean;
  },
): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: opts.planId ?? "p",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    title: "Session",
    category: opts.category ?? "quality",
    sport: opts.sport ?? "run",
    originalPlanDate: opts.date,
    lastVerifiedCorosDate: opts.date,
    effectiveDate: opts.date,
    effectiveTime: opts.time ?? "07:00",
    completionState: opts.state ?? "scheduled",
    resolutionDate: opts.state && opts.state !== "scheduled" ? opts.date : null,
    sanctionedBy: opts.sanctioned ? "coach" : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    archivedAt: opts.archived ? nowInstant() : null,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** A matched run/etc activity completing `workoutId` at `localTime` on `date`. */
async function matchActivity(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  localTime: string,
  sport = "run",
): Promise<void> {
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T${localTime}:00Z`,
    startTimeLocal: `${date}T${localTime}:00`,
    sport,
    durationSeconds: 2400,
    distanceMeters: 8000,
    sourceMergeConfidence: 1,
    completionMatchId: `m-${activityId}`,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: `m-${activityId}`,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
}

describe("plan coverage from workout bounds (audit#2 (a))", () => {
  it("a NULL-dated plan covers exactly the span of its own unarchived workouts", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await insertPlan(db, userId, { id: "plan-a" });
    await insertWorkout(db, userId, { date: addDays(today, -5), planId: "plan-a" });
    await insertWorkout(db, userId, { date: addDays(today, -1), planId: "plan-a" });
    // An archived straggler past the real end must not stretch coverage.
    await insertWorkout(db, userId, { date: addDays(today, 3), planId: "plan-a", archived: true });

    // Inside the span (even with no workout that day): covered, no gap.
    expect((await buildDayInput(db, userId, addDays(today, -3), prefs)).planGap).toBe(false);
    // Past the last scheduled day: the gap can finally fire — the NULL end
    // date used to read as "covers every date forever".
    expect((await buildDayInput(db, userId, today, prefs)).planGap).toBe(true);
  });

  it("a NULL-dated plan with no workouts covers nothing (the stale empty containers)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await insertPlan(db, userId, { id: "plan-empty" });

    expect((await buildDayInput(db, userId, today, prefs)).planGap).toBe(true);
  });

  it("explicit plan dates still govern coverage unchanged", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await insertPlan(db, userId, {
      id: "plan-dated",
      startDate: addDays(today, -2),
      endDate: addDays(today, 2),
    });

    expect((await buildDayInput(db, userId, today, prefs)).planGap).toBe(false);
    expect((await buildDayInput(db, userId, addDays(today, 3), prefs)).planGap).toBe(true);
  });
});

describe("race taper shelter (audit#2 (b))", () => {
  it("a no-run day inside the 21 days before raceDate reads as observed rest", async () => {
    const db = makeTestDb();
    const today = todayInZone("America/Los_Angeles");
    const { userId, prefs } = await makeTestUser(db, { raceDate: addDays(today, 10) });
    // Strength-only taper day (the real user's plan: lifts through Oct 21).
    await insertWorkout(db, userId, { date: today, category: "strength", sport: "strength" });

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.restObserved).toBe(true);
    expect(input.missedRuns).toHaveLength(0);
  });

  it("a day that schedules a run gets no shelter — skipping taper work still costs", async () => {
    const db = makeTestDb();
    const today = todayInZone("America/Los_Angeles");
    const { userId, prefs } = await makeTestUser(db, { raceDate: addDays(today, 10) });
    await insertWorkout(db, userId, { date: today, category: "easy", sport: "run" });

    expect((await buildDayInput(db, userId, today, prefs)).restObserved).toBe(false);
  });

  it("the shelter covers the race day itself", async () => {
    const db = makeTestDb();
    const today = todayInZone("America/Los_Angeles");
    const { userId, prefs } = await makeTestUser(db, { raceDate: today });

    expect((await buildDayInput(db, userId, today, prefs)).restObserved).toBe(true);
  });

  it("no shelter outside the window — 22+ days out, after the race, or with no race set", async () => {
    const db = makeTestDb();
    const today = todayInZone("America/Los_Angeles");
    const { userId: farOut, prefs: farPrefs } = await makeTestUser(db, {
      raceDate: addDays(today, 30),
    });
    expect((await buildDayInput(db, farOut, today, farPrefs)).restObserved).toBe(false);

    const { userId: past, prefs: pastPrefs } = await makeTestUser(db, {
      raceDate: addDays(today, -1),
    });
    expect((await buildDayInput(db, past, today, pastPrefs)).restObserved).toBe(false);

    const { userId: none, prefs: nonePrefs } = await makeTestUser(db);
    expect((await buildDayInput(db, none, today, nonePrefs)).restObserved).toBe(false);
  });
});

describe("weekAdherence excludes coach-sanctioned skips (audit#2 #10)", () => {
  const monday = "2026-08-10"; // weekAdherence is computed on Mondays only

  it("a taper week of 2 completed + 1 sanctioned skip is a perfect week", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await insertWorkout(db, userId, { date: addDays(monday, -7), state: "completed" });
    await insertWorkout(db, userId, { date: addDays(monday, -5), state: "completed" });
    await insertWorkout(db, userId, {
      date: addDays(monday, -3),
      state: "skipped",
      sanctioned: true,
    });

    const input = await buildDayInput(db, userId, monday, prefs);
    expect(input.weekAdherence).toBe(1);
  });

  it("unsanctioned skips still count against the week", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await insertWorkout(db, userId, { date: addDays(monday, -7), state: "completed" });
    await insertWorkout(db, userId, { date: addDays(monday, -5), state: "completed" });
    await insertWorkout(db, userId, { date: addDays(monday, -3), state: "skipped" });

    const input = await buildDayInput(db, userId, monday, prefs);
    expect(input.weekAdherence).toBeCloseTo(2 / 3);
  });
});

describe("evening-run credit reads the real start hour (audit#2 #11)", () => {
  it("a matched run's window comes from the activity, not the planned slot", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // Planned as a morning slot; actually run at 18:12 (the Aug 11 run).
    const workoutId = await insertWorkout(db, userId, {
      date: today,
      time: "07:00",
      state: "completed",
    });
    await matchActivity(db, userId, workoutId, today, "18:12");

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.completedRuns).toHaveLength(1);
    expect(input.completedRuns[0]!.window).toBe("evening");
    expect(input.completedRuns[0]!.startHourLocal).toBe(18);
  });

  it("before 17:00 local stays morning even when the slot says evening", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const workoutId = await insertWorkout(db, userId, {
      date: today,
      time: "19:00",
      state: "completed",
    });
    await matchActivity(db, userId, workoutId, today, "13:30");

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.completedRuns[0]!.window).toBe("morning");
  });

  it("unmatched completions fall back to the planned slot", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await insertWorkout(db, userId, { date: today, time: "19:00", state: "completed" });

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.completedRuns[0]!.window).toBe("evening");
    expect(input.completedRuns[0]!.startHourLocal).toBeUndefined();
  });
});

describe("wildlife `since` records the arrival date (audit#2 #22)", () => {
  it("a multi-day walk stamps the arrival event's date, not the walk end", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const genesis = addDays(today, -10);
    await ensureGarden(db, userId, prefs, genesis);
    await advanceGarden(db, userId, prefs);

    // Rabbits arrive on day one (starter meadow + genesis moisture) but the
    // walk lands here once, ending yesterday.
    const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
    expect(state!.lastSimulatedDate).toBe(addDays(today, -1));
    const [rabbits] = await db
      .select()
      .from(schema.gardenWildlife)
      .where(eq(schema.gardenWildlife.id, `${userId}:rabbits`));
    expect(rabbits!.present).toBe(true);
    expect(rabbits!.since).toBe(genesis);
  });

  it("a wrong stored `since` heals on the next persist", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const genesis = addDays(today, -10);
    await ensureGarden(db, userId, prefs, genesis);
    await advanceGarden(db, userId, prefs);
    // The prod shape: presence is right, the date records a later walk end.
    await db
      .update(schema.gardenWildlife)
      .set({ since: addDays(today, -2) })
      .where(eq(schema.gardenWildlife.id, `${userId}:rabbits`));

    await advanceGarden(db, userId, prefs);
    const [rabbits] = await db
      .select()
      .from(schema.gardenWildlife)
      .where(eq(schema.gardenWildlife.id, `${userId}:rabbits`));
    expect(rabbits!.since).toBe(genesis);
  });
});

describe("codex unlock dates (audit#2 #18)", () => {
  it("a resim overwrites a wrong unlockedOn with the replayed event's date", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const genesis = addDays(today, -10);
    const runDay = addDays(today, -8);
    await ensureGarden(db, userId, prefs, genesis);
    const workoutId = await insertWorkout(db, userId, { date: runDay, state: "completed" });
    await matchActivity(db, userId, workoutId, runDay, "07:30");
    await advanceGarden(db, userId, prefs);

    const poppy = () =>
      db
        .select()
        .from(schema.gardenUnlocks)
        .where(eq(schema.gardenUnlocks.userId, userId))
        .then((rows) => rows.find((r) => r.speciesId === "poppy"));
    expect((await poppy())!.unlockedOn).toBe(runDay);

    // The prod corruption: a self-heal era row stamped at genesis.
    await db
      .update(schema.gardenUnlocks)
      .set({ unlockedOn: genesis })
      .where(eq(schema.gardenUnlocks.userId, userId));
    await resimulateFrom(db, userId, addDays(runDay, -1), prefs);
    expect((await poppy())!.unlockedOn).toBe(runDay);
  });

  it("the self-heal seeds only start-gated species — an earned species is never stamped at genesis", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const genesis = addDays(today, -10);
    const runDay = addDays(today, -8);
    await ensureGarden(db, userId, prefs, genesis);
    const workoutId = await insertWorkout(db, userId, { date: runDay, state: "completed" });
    await matchActivity(db, userId, workoutId, runDay, "07:30");
    await advanceGarden(db, userId, prefs);
    // Simulate a lost ledger row for the earned poppy.
    const rows = await db
      .select()
      .from(schema.gardenUnlocks)
      .where(eq(schema.gardenUnlocks.userId, userId));
    const poppyRow = rows.find((r) => r.speciesId === "poppy");
    await db.delete(schema.gardenUnlocks).where(eq(schema.gardenUnlocks.id, poppyRow!.id));

    const view = await buildGardenView(db, userId, prefs);
    const codexPoppy = view.codex.find((c) => c.speciesId === "poppy");
    // Honest absence — not a fabricated genesis date.
    expect(codexPoppy!.unlockedOn).toBeNull();
    // Genesis species keep their day-one seeding.
    const grass = view.codex.find((c) => c.speciesId === "meadow_grass");
    expect(grass!.unlockedOn).toBe(genesis);
  });
});
