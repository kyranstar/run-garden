/**
 * The garden after a restore (audit 1 data finding 6, ruling B4).
 *
 * Finish used to catch a restored garden up with `resimulateFrom`, which for a
 * garden behind the calendar walks every missing day in ONE request: 983
 * statements for a sparse garden 120 days behind, against D1's ~1,000 budget.
 * Past that, finish returned 500 after every row had landed, and every later
 * garden read retried the same walk and died the same way.
 *
 * Now finish does no garden work at all. It flags a FULL rebuild — from the
 * garden's genesis, through the resumable, day-capped rebuild the version
 * upgrade already uses — and the next garden reads walk it forward, at most
 * 45 days a read, persisting progress as checkpoints. The rebuilt garden is
 * the same garden an uncapped walk over the same restored rows produces.
 *
 * The verifier's note is pinned too: `resimulateFrom`'s checkpoint path was
 * uncapped (a backfill — the natural follow-up to restoring an old file —
 * replayed the whole garden in one request). A walk longer than the cap now
 * hands itself to the same resumable rebuild.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { advanceGarden, buildGardenView, ensureGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { finishRestore } from "../src/services/account-restore.js";
import { loadAccountState } from "../src/services/account-state.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { exportAll, restoreAll } from "./restore-driver.js";

/** A generous ceiling under D1's 1,000 that leaves the caller room for its
 * own work (the hourly cron shares one budget across every step). */
const READ_BUDGET = 800;

function countingDb(): { db: Db; count: () => number } {
  let n = 0;
  const db = makeTestDb({ boundVariableCap: 100, onStatement: () => (n += 1) });
  return {
    db,
    count: () => {
      const out = n;
      n = 0;
      return out;
    },
  };
}

async function completedRun(db: Db, userId: string, date: string): Promise<void> {
  const workoutId = newId();
  const activityId = newId();
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId}`,
    title: "Easy",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "completed",
    resolutionDate: date,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T07:30:00Z`,
    startTimeLocal: `${date}T07:30:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000,
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

/** A 230-day-old garden with a run every four days, last simulated 200 days
 * ago — what restoring an old export leaves behind. */
async function oldGarden(db: Db): Promise<{ userId: string; prefs: UserPreferences; genesis: string }> {
  const { userId, prefs } = await makeTestUser(db);
  const today = todayInZone(prefs.timezone);
  const genesis = addDays(today, -230);
  await ensureGarden(db, userId, prefs, genesis);
  for (let d = 2; d < 226; d += 4) await completedRun(db, userId, addDays(genesis, d));
  await advanceGarden(db, userId, prefs, new Date(`${addDays(today, -200)}T12:00:00Z`));
  return { userId, prefs, genesis };
}

async function gardenRows(db: Db, userId: string) {
  const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
  const events = await db
    .select()
    .from(schema.gardenEvents)
    .where(eq(schema.gardenEvents.userId, userId))
    .orderBy(asc(schema.gardenEvents.date), asc(schema.gardenEvents.seq));
  const inputs = await db
    .select()
    .from(schema.gardenDayInputs)
    .where(eq(schema.gardenDayInputs.userId, userId))
    .orderBy(asc(schema.gardenDayInputs.date));
  return {
    snapshot: state!.snapshot,
    lastSimulatedDate: state!.lastSimulatedDate,
    events: events.map(({ createdAt: _c, ...e }) => e),
    inputs: inputs.map(({ updatedAt: _u, ...i }) => i),
  };
}

/** Garden reads until the pending rebuild is done; statements per read. */
async function readUntilRebuilt(db: Db, count: () => number, userId: string, prefs: UserPreferences): Promise<number[]> {
  const perRead: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    count();
    await advanceGarden(db, userId, prefs);
    perRead.push(count());
    if (!(await loadAccountState(db, userId))?.gardenRebuildPending) return perRead;
  }
  throw new Error(`rebuild did not converge: ${perRead.join(", ")}`);
}

describe("finish hands the garden to the capped rebuild (B4)", () => {
  it("a garden 200 days behind: finish stays inside a small budget, and the reads converge to the full walk", async () => {
    const { db, count } = countingDb();
    const { userId, prefs, genesis } = await oldGarden(db);
    const file = await exportAll(db, userId);
    expect((file.tables.garden_state![0]!.lastSimulatedDate as string) < addDays(todayInZone(prefs.timezone), -199)).toBe(true);

    // The reference: the same rows, walked uncapped to today.
    await advanceGarden(db, userId, prefs);
    const reference = await gardenRows(db, userId);

    let finishStatements = 0;
    await restoreAll(db, userId, file, {
      beforeFinish: async () => {
        count();
      },
    }).then(() => {
      finishStatements = count();
    });
    // Counts and two bookkeeping writes — no simulation.
    expect(finishStatements).toBeLessThan(100);
    const restored = await gardenRows(db, userId);
    expect(restored.lastSimulatedDate).toBe(file.tables.garden_state![0]!.lastSimulatedDate);
    expect(await loadAccountState(db, userId)).toMatchObject({ gardenRebuildPending: true, gardenRebuildFrom: genesis });

    const perRead = await readUntilRebuilt(db, count, userId, prefs);
    expect(perRead.length).toBeGreaterThanOrEqual(5); // 230 days at ≤ 45 a read
    for (const n of perRead) expect(n).toBeLessThanOrEqual(READ_BUDGET);

    const rebuilt = await gardenRows(db, userId);
    expect(rebuilt.snapshot).toEqual(reference.snapshot);
    expect(rebuilt.lastSimulatedDate).toBe(reference.lastSimulatedDate);
    expect(rebuilt.events).toEqual(reference.events);
    expect(rebuilt.inputs).toEqual(reference.inputs);
    expect((rebuilt.snapshot as { state: { createdDate: string } }).state.createdDate).toBe(genesis);
  }, 60_000);

  it("while the rebuild is pending, reads show the restored garden and an activity import stays capped", async () => {
    const { db, count } = countingDb();
    const { userId, prefs } = await oldGarden(db);
    const file = await exportAll(db, userId);
    await advanceGarden(db, userId, prefs);
    const reference = await gardenRows(db, userId);
    await restoreAll(db, userId, file);

    // The first read walks one capped step; the garden it serves is the file's.
    count();
    const view = await buildGardenView(db, userId, prefs);
    expect(count()).toBeLessThanOrEqual(READ_BUDGET);
    expect(view.snapshot.state.lastSimulatedDate).toBe(file.tables.garden_state![0]!.lastSimulatedDate);

    // A COROS read imports a run from 150 days ago mid-rebuild.
    count();
    const res = await resimulateFrom(db, userId, addDays(todayInZone(prefs.timezone), -150), prefs);
    expect(count()).toBeLessThanOrEqual(READ_BUDGET);
    expect(res.resimPending).toBe(true);

    await readUntilRebuilt(db, count, userId, prefs);
    const rebuilt = await gardenRows(db, userId);
    expect(rebuilt.snapshot).toEqual(reference.snapshot);
    expect(rebuilt.events).toEqual(reference.events);
  }, 60_000);

  it("finish never runs the garden: a restore with no garden in the file leaves nothing pending", async () => {
    const { db } = countingDb();
    const { userId } = await makeTestUser(db);
    const done = await restoreAll(db, userId, {
      format: "run-garden-export",
      schemaVersion: "0023",
      exportedAt: nowInstant(),
      tables: { dismissed_insights: [{ id: "d1", userId: "x", cardId: "c", dismissedAt: nowInstant() }] },
    });
    expect(done.short).toEqual([]);
    expect(await loadAccountState(db, userId)).toMatchObject({ gardenRebuildPending: false });
    void finishRestore; // finish is exercised through restoreAll
  });
});

describe("resimulateFrom's checkpoint path no longer walks uncapped (verifier R6)", () => {
  it("a change 225 days back on a current garden rebuilds in capped steps and converges to the same garden", async () => {
    const { db, count } = countingDb();
    const { userId, prefs, genesis } = await oldGarden(db);
    await advanceGarden(db, userId, prefs);
    const before = await gardenRows(db, userId);

    // The backfill after a restore: history changed near the garden's start.
    count();
    const first = await resimulateFrom(db, userId, addDays(genesis, 5), prefs);
    const firstStatements = count();
    expect(firstStatements).toBeLessThanOrEqual(READ_BUDGET);
    expect(first.resimPending).toBe(true);
    // Reads keep serving the garden as it was until the rebuild lands.
    expect((await gardenRows(db, userId)).snapshot).toEqual(before.snapshot);

    const perRead = await readUntilRebuilt(db, count, userId, prefs);
    for (const n of perRead) expect(n).toBeLessThanOrEqual(READ_BUDGET);
    const after = await gardenRows(db, userId);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.events).toEqual(before.events);
    expect(after.inputs).toEqual(before.inputs);
  }, 60_000);

  it("a short resimulation still lands in the same request", async () => {
    const { db } = countingDb();
    const { userId, prefs } = await oldGarden(db);
    await advanceGarden(db, userId, prefs);
    const res = await resimulateFrom(db, userId, addDays(todayInZone(prefs.timezone), -10), prefs);
    expect(res.resimPending).toBeUndefined();
    expect((await loadAccountState(db, userId))?.gardenRebuildPending ?? false).toBe(false);
  }, 60_000);
});
