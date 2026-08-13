/**
 * Two race truths (audit#2 #3) must be resolvable in one step: the banner's
 * buttons and the coach's resolveRaceConflict op share this service, and
 * both directions converge the data so the warning cannot re-fire for the
 * same divergence.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { findRaceConflict, resolveRaceConflict } from "../src/services/race-conflict.js";
import { applyOps } from "../src/services/coach-apply.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seedRaceRow(db: Db, userId: string, id: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Race Day!",
    category: "race",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "09:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("race conflict", () => {
  it("finds the divergence and stays silent when dates agree or data is absent", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const planDay = addDays(today, 30);
    const statedDay = addDays(today, 50);

    // No race row, no stated day → no conflict.
    expect(await findRaceConflict(db, userId, prefs)).toBeNull();

    await seedRaceRow(db, userId, "race1", planDay);
    // Race row but no stated day → still no conflict.
    expect(await findRaceConflict(db, userId, prefs)).toBeNull();

    // Dates agree → no conflict.
    expect(await findRaceConflict(db, userId, { ...prefs, raceDate: planDay })).toBeNull();

    const conflict = await findRaceConflict(db, userId, { ...prefs, raceDate: statedDay });
    expect(conflict).toEqual({
      workoutId: "race1",
      plannedDate: planDay,
      title: "Race Day!",
      raceDate: statedDay,
    });
  });

  it("keep settings demotes the plan's label to a regular quality session", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const planDay = addDays(today, 30);
    const stated = { ...prefs, raceDate: addDays(today, 50) };
    await seedRaceRow(db, userId, "race1", planDay);

    const resolved = await resolveRaceConflict(db, userId, stated, "settings");
    expect(resolved?.workoutId).toBe("race1");

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "race1"));
    expect(row!.category).toBe("quality");
    expect(row!.archivedAt).toBeNull();
    expect(row!.effectiveDate).toBe(planDay);

    // Converged: the conflict is gone, and a second resolve is a no-op.
    expect(await findRaceConflict(db, userId, stated)).toBeNull();
    expect(await resolveRaceConflict(db, userId, stated, "settings")).toBeNull();
  });

  it("keep plan moves the stated race day to the plan's date", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const planDay = addDays(today, 30);
    await savePreferences(db, userId, { ...prefs, raceDate: addDays(today, 50) });
    await seedRaceRow(db, userId, "race1", planDay);

    const stated = await loadPreferences(db, userId);
    const resolved = await resolveRaceConflict(db, userId, stated, "plan");
    expect(resolved?.plannedDate).toBe(planDay);

    const after = await loadPreferences(db, userId);
    expect(after.raceDate).toBe(planDay);
    expect(await findRaceConflict(db, userId, after)).toBeNull();

    // The row keeps its race identity — the plan was right.
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "race1"));
    expect(row!.category).toBe("race");
  });

  it("applies as a coach op through applyOps", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const planDay = addDays(today, 30);
    const stated = { ...prefs, raceDate: addDays(today, 50) };
    await seedRaceRow(db, userId, "race1", planDay);

    const out = await applyOps(db, userId, stated, "prop-race", [
      { kind: "resolveRaceConflict", keep: "settings" },
    ]);
    expect(out.updated).toEqual(["race1"]);

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "race1"));
    expect(row!.category).toBe("quality");

    // Re-applying the approved proposal (idempotency contract) is a no-op.
    const again = await applyOps(db, userId, stated, "prop-race", [
      { kind: "resolveRaceConflict", keep: "settings" },
    ]);
    expect(again.updated).toEqual([]);
  });
});
