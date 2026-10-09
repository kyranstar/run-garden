/**
 * A KILLED REPLAY NEVER LOSES AN ACTIVITY'S CREDIT (cron reliability, part 3).
 *
 * `resimulateFrom` replays the garden from the checkpoint before a changed day: it purges the day inputs, events and
 * checkpoints after that checkpoint, walks forward, and only at the end persists `garden_state` (C21: so a mid-walk
 * failure never leaves a genesis stub). But an invocation killed after the purge left `garden_state` at its old day —
 * on or after the changed day — so the next walk started PAST it: the new activity was never credited, and the purged
 * days' inputs and events stayed missing (walkForward's "timeline hole"). On the free plan the half-hourly sweep that
 * ingests new activities was killed often enough (Oct 3–7) for this to matter.
 *
 * The replay now records the day it must start from (`account_state.garden_changed_from`) before it purges anything,
 * and clears it only once the walk has passed it; whatever walks the garden next — the hourly, the sweep, a garden
 * read — sees the record and replays from it. These kill the replay at every write it makes, then run the next walk,
 * and require the garden to land exactly where one uninterrupted replay lands: the same state, day inputs, events,
 * checkpoints, plants, unlocks and wildlife.
 *
 * Fixed calendar: nothing here reads the real clock (garden-resim-crash-safety.test.ts explains why that matters).
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { advanceGarden, ensureGarden, loadGarden, resimulateFrom, type GardenSimResult } from "../src/services/garden-sync.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { gardenTimeline, replayMarker } from "./garden-compare.js";

const GENESIS = "2026-04-06"; // A Monday: checkpoints on GENESIS, +7, +14, +21.
/** Noon in Los Angeles on GENESIS+24: with no planned workouts every day is resolved, so a walk reaches GENESIS+23. */
const NOW = new Date(`${addDays(GENESIS, 24)}T19:00:00Z`);
const HISTORY: Array<[number, "run" | "strength" | "yoga"]> = [
  [1, "run"], [2, "strength"], [3, "run"], [5, "run"], [6, "yoga"], [8, "run"], [9, "strength"], [10, "run"],
  [12, "run"], [13, "yoga"], [15, "run"], [16, "strength"], [19, "run"], [20, "yoga"], [22, "run"],
];
/** The day the late activity lands on: already simulated, so only a replay credits it. Its checkpoint is GENESIS+14,
 * so the replay walks nine days. */
const LATE_DAY = addDays(GENESIS, 17);

async function insertActivity(db: Db, userId: string, date: string, sport: string, localTime = "07:00", id = newId()): Promise<string> {
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: `${date}T${localTime}:00Z`,
    startTimeLocal: `${date}T${localTime}:00`,
    sport,
    durationSeconds: 2700,
    distanceMeters: sport === "run" ? 8000 : null,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** A garden grown through GENESIS+23 from a few weeks of runs, lifts and yoga; then a lift lands on LATE_DAY. */
async function seed(): Promise<{ db: Db; userId: string; prefs: Awaited<ReturnType<typeof makeTestUser>>["prefs"]; lateId: string }> {
  const db = makeTestDb({ boundVariableCap: 100 });
  const { userId, prefs } = await makeTestUser(db);
  for (const [d, sport] of HISTORY) await insertActivity(db, userId, addDays(GENESIS, d), sport);
  await ensureGarden(db, userId, prefs, GENESIS);
  const grown = await advanceGarden(db, userId, prefs, NOW);
  expect(grown.lastSimulatedDate).toBe(addDays(GENESIS, 23));
  const lateId = await insertActivity(db, userId, LATE_DAY, "strength", "18:00");
  return { db, userId, prefs, lateId };
}

/**
 * Kills the invocation at the k-th garden write after `arm` (counting every insert/update/delete except the replay
 * record's own account_state write: a kill before that record lands is a kill before the replay began — the read
 * records the day before its ingest for that, see coros-read's test). The error reads like the platform's.
 */
function killSwitch() {
  const s = { armed: false, at: Infinity, writes: 0 };
  return {
    hook: (sql: string) => {
      if (!s.armed || !isWrite(sql) || /"account_state"/.test(sql)) return;
      s.writes += 1;
      if (s.writes === s.at) throw new Error("Exceeded CPU time limit (simulated kill)");
    },
    arm(at = Infinity) {
      s.armed = true;
      s.at = at;
      s.writes = 0;
    },
    disarm() {
      s.armed = false;
    },
    get writes() {
      return s.writes;
    },
  };
}

/** The walks after the kill, as the hourly cron takes them: a few days a run until nothing is left. */
async function hourlyWalks(
  db: Db,
  userId: string,
  prefs: Parameters<typeof advanceGarden>[2],
): Promise<Array<GardenSimResult & { shown: string }>> {
  const runs: Array<GardenSimResult & { shown: string }> = [];
  for (let i = 0; i < 12; i++) {
    const r = await advanceGarden(db, userId, prefs, NOW, { maxWalkDays: 3, maxResimDays: 3 });
    runs.push({ ...r, shown: (await loadGarden(db, userId))!.state.lastSimulatedDate });
    if (r.simulatedDays === 0 && !r.resimPending) break;
  }
  return runs;
}

describe("a replay killed part-way is resumed by whatever walks the garden next", () => {
  it("killed at any of its writes, the next garden read lands exactly where one uninterrupted replay lands", { timeout: 60_000 }, async () => {
    const { db: base, userId, prefs, lateId } = await seed();

    // The reference: one uninterrupted replay from the late day.
    const counter = killSwitch();
    const reference = cloneTestDb(base, { boundVariableCap: 100, onStatement: counter.hook });
    counter.arm();
    const replayed = await resimulateFrom(reference, userId, LATE_DAY, prefs, NOW);
    counter.disarm();
    expect(replayed.simulatedDays).toBe(9);
    const expected = await gardenTimeline(reference, userId);
    const lateInput = expected.inputs.find((i) => i.date === LATE_DAY)!.input as { completedRuns: Array<{ activityId?: string }> };
    expect(lateInput.completedRuns.map((r) => r.activityId)).toContain(lateId);
    expect(await replayMarker(reference, userId)).toBeNull();
    const totalWrites = counter.writes;
    expect(totalWrites).toBeGreaterThan(9);

    const holes: number[] = [];
    for (let k = 1; k <= totalWrites; k++) {
      const kill = killSwitch();
      const db = cloneTestDb(base, { boundVariableCap: 100, onStatement: kill.hook });
      kill.arm(k);
      await expect(resimulateFrom(db, userId, LATE_DAY, prefs, NOW)).rejects.toThrow("simulated kill");
      kill.disarm();
      // The record survived the kill; the rendered garden is never left behind where it was.
      expect(await replayMarker(db, userId)).toBe(LATE_DAY);
      expect((await loadGarden(db, userId))!.state.lastSimulatedDate).toBe(addDays(GENESIS, 23));

      await advanceGarden(db, userId, prefs, NOW); // the next garden read (uncapped)
      const landed = await gardenTimeline(db, userId);
      if (JSON.stringify(landed) !== JSON.stringify(expected)) holes.push(k);
      expect(await replayMarker(db, userId)).toBeNull();
    }
    expect(holes).toEqual([]);
  });

  it("killed part-way, the hourly's capped walks finish it a few days a run and land where one uninterrupted replay lands", { timeout: 60_000 }, async () => {
    const { db: base, userId, prefs } = await seed();
    const reference = cloneTestDb(base, { boundVariableCap: 100 });
    await resimulateFrom(reference, userId, LATE_DAY, prefs, NOW);
    const expected = await gardenTimeline(reference, userId, { mondayCheckpointsOnly: true });

    for (const k of [1, 4, 12, 20]) {
      const kill = killSwitch();
      const db = cloneTestDb(base, { boundVariableCap: 100, onStatement: kill.hook });
      kill.arm(k);
      await expect(resimulateFrom(db, userId, LATE_DAY, prefs, NOW)).rejects.toThrow("simulated kill");
      kill.disarm();

      const runs = await hourlyWalks(db, userId, prefs);
      expect(runs.every((r) => r.simulatedDays <= 3)).toBe(true);
      expect(runs.filter((r) => r.simulatedDays > 0).length).toBeGreaterThanOrEqual(3); // nine days, three a run
      // While the replay is behind what garden_state shows, the rendered garden stays where it was — never rewound.
      expect(runs[0]!.resimPending).toBe(true);
      expect(runs.every((r) => r.shown === addDays(GENESIS, 23))).toBe(true);
      expect(await gardenTimeline(db, userId, { mondayCheckpointsOnly: true })).toEqual(expected);
      expect(await replayMarker(db, userId)).toBeNull();
    }
  });

  it("a second change that lands while a replay is pending is folded in: the walk starts from the earlier of the two", { timeout: 60_000 }, async () => {
    const { db: base, userId, prefs } = await seed();
    const reference = cloneTestDb(base, { boundVariableCap: 100 });
    const earlier = addDays(GENESIS, 11);
    const yogaId = newId();
    await insertActivity(reference, userId, earlier, "yoga", "19:00", yogaId);
    await resimulateFrom(reference, userId, earlier, prefs, NOW);
    const expected = await gardenTimeline(reference, userId);

    const kill = killSwitch();
    const db = cloneTestDb(base, { boundVariableCap: 100, onStatement: kill.hook });
    kill.arm(6);
    await expect(resimulateFrom(db, userId, LATE_DAY, prefs, NOW)).rejects.toThrow("simulated kill");
    kill.disarm();
    // The next change lands on a day before the pending one.
    await insertActivity(db, userId, earlier, "yoga", "19:00", yogaId);
    await resimulateFrom(db, userId, earlier, prefs, NOW);
    expect(await gardenTimeline(db, userId)).toEqual(expected);
    expect(await replayMarker(db, userId)).toBeNull();
  });

  it("a record for a day the garden has not reached yet is cleared, and the walk forward reads that day fresh", async () => {
    const { db, userId, prefs } = await seed();
    await db.insert(schema.accountState).values({ userId, gardenChangedFrom: addDays(GENESIS, 30), gardenChangedSeq: 1, updatedAt: nowInstant() });
    const before = await gardenTimeline(db, userId);
    const r = await advanceGarden(db, userId, prefs, NOW);
    expect(r.simulatedDays).toBe(0);
    expect(await replayMarker(db, userId)).toBeNull();
    expect((await gardenTimeline(db, userId)).inputs).toEqual(before.inputs);
  });
});
