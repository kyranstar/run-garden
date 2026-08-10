/**
 * Spec §2 (docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md):
 * the same-day preview must survive a durable-sim lag by folding forward
 * read-only — resolved days as recorded, unresolved days neutral — return
 * only TODAY's events, never persist anything, and fall back to the durable
 * snapshot beyond a 14-day defensive cap.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { initialSnapshot, type GardenSnapshot } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import { buildGardenView, ensureGarden, previewToday } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { gardenState } = schema;

async function insertWorkout(
  db: Db,
  userId: string,
  effectiveDate: string,
  completionState: "scheduled" | "completed",
): Promise<string> {
  const workoutId = newId();
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: effectiveDate,
    lastVerifiedCorosDate: effectiveDate,
    effectiveDate,
    effectiveTime: "07:00",
    completionState,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

async function insertCompletedRun(db: Db, userId: string, date: string): Promise<void> {
  const workoutId = await insertWorkout(db, userId, date, "completed");
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T14:30:00Z`,
    startTimeLocal: `${date}T07:30:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000,
    sourceMergeConfidence: 1,
    completionMatchId: "m-" + activityId,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: "m-" + activityId,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
}

describe("same-day preview fold-forward", () => {
  it("previews today's run even when the durable sim is 2 days behind", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);

    await ensureGarden(db, userId, prefs, addDays(today, -10));
    // An unresolved workout yesterday makes advanceGarden break inside its
    // grace window — the durable sim stops at today-2.
    await insertWorkout(db, userId, addDays(today, -1), "scheduled");
    await insertCompletedRun(db, userId, today);

    const view = await buildGardenView(db, userId, prefs);
    const snapshot = view.snapshot as unknown as GardenSnapshot;

    expect(view.previewEvents.some((e) => e.kind === "run_completed")).toBe(true);
    expect(view.previewEvents.every((e) => e.date === today)).toBe(true);
    expect(snapshot.state.weatherState).toBe("fresh_rain");
    expect(snapshot.state.lastSimulatedDate).toBe(today);

    // The durable row is untouched by the preview.
    const [row] = await db.select().from(gardenState).where(eq(gardenState.userId, userId));
    expect(row!.lastSimulatedDate).toBe(addDays(today, -2));
  });

  it("previewToday falls back to the durable snapshot beyond the 14-day cap", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const stale = initialSnapshot(addDays(today, -20));

    const out = await previewToday(db, userId, stale, today, prefs);
    expect(out.snapshot).toBe(stale);
    expect(out.events).toEqual([]);
  });

  it("previewToday advances the snapshot to today even with zero completions", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // Genesis yesterday → lastSimulatedDate is two days back → gap of 2.
    const snapshot = initialSnapshot(addDays(today, -1));

    const out = await previewToday(db, userId, snapshot, today, prefs);
    expect(out.snapshot.state.lastSimulatedDate).toBe(today);
    expect(out.events.every((e) => e.date === today)).toBe(true);
  });
});

describe("adventure shield across a multi-day preview fold (C11)", () => {
  it("the caption uses the preview fold's own shield, not stale pre-fold bank state", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const hikeDate = addDays(today, -2);
    const unresolvedDate = addDays(today, -1);

    await ensureGarden(db, userId, prefs, addDays(today, -10));
    // An open-ended active plan so `today` (with no workout of its own in
    // this fixture) isn't treated as a plan gap — a gap short-circuits the
    // grace-day check before the bank is ever consulted, which would mask
    // exactly the bug this test is pinning.
    await db.insert(schema.trainingPlans).values({
      id: newId(),
      userId,
      provider: "coros",
      sourcePlanId: "test-plan",
      name: "Test Plan",
      status: "active",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // A big hike two days ago: durationMin (200) clears bigDurationMin (150),
    // so the durable sim banks one grace day when it commits this day.
    await db.insert(schema.activities).values({
      id: newId(),
      userId,
      startTime: `${hikeDate}T14:00:00Z`,
      startTimeLocal: `${hikeDate}T09:00:00`,
      sport: "hike",
      durationSeconds: 200 * 60,
      trainingLoad: 90,
      sourceMergeConfidence: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    // Yesterday's planned workout is still unresolved (ordinary COROS sync
    // lag) — advanceGarden's grace rule holds the durable sim back at the
    // hike day, so `lastAdventureDate`/`adventureGraceDays` land in
    // gardenState with the bank still full.
    await insertWorkout(db, userId, unresolvedDate, "scheduled");

    const view = await buildGardenView(db, userId, prefs);
    const snapshot = view.snapshot as unknown as GardenSnapshot;

    // The durable row really did stop at the hike day, bank intact there.
    const [row] = await db.select().from(gardenState).where(eq(gardenState.userId, userId));
    expect(row!.lastSimulatedDate).toBe(hikeDate);

    // But previewToday folds yesterday (unresolved → neutral input) THEN
    // today read-only: yesterday spends the banked grace day, so today's
    // OWN fold step finds the bank empty and decays for real.
    expect(snapshot.state.daysSinceCompletedRun).toBeGreaterThan(0);
    // The caption must agree with what actually rendered — no false "still
    // sheltered" claim sourced from the pre-fold bank of 1.
    expect(view.adventure.graceDay).toBe(false);
    expect(view.adventure.frozenToday).toBe(false);
  });
});

describe("garden anniversary (Bundle 3 §6)", () => {
  it("appears exactly on the yearly anniversary of genesis", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const twoYearsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
    await ensureGarden(db, userId, prefs, twoYearsAgo);
    const view = await buildGardenView(db, userId, prefs);
    expect(view.anniversary).toBe("The garden turns 2 today — it remembers every run.");
  });

  it("is null on any other day (and in year one)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await ensureGarden(db, userId, prefs, addDays(today, -10));
    const view = await buildGardenView(db, userId, prefs);
    expect(view.anniversary).toBeNull();
  });
});
