/**
 * THE KEY RESULTS, CHEAPER AND THE SAME (the go-live CPU gate: design-cpu-bench.test.ts, shape 6 — the objectives board
 * asks every measure over its window and over every logged day). Two changes, both for CPU alone: each run_best's window
 * start is computed once, not once a run, when the runs worth labelling are picked; and the logged sets are read as
 * plain rows, mapped by position, never through drizzle's per-row mapping.
 *
 * Exactly equivalent: the implementation before them (key-result-measures-e2ff1b8.ts, frozen) and the one now measure
 * the same requests — every measure family, in kg and lb, over windows from a week to every logged day — on two years
 * of record (long-history-fixture.ts) with what makes a set hard to read added: sets held a side at a time, an
 * activity's watch copy beside the athlete's own record, a session still being written, empty values, a move the
 * library doesn't know. Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId } from "@rg/domain";
import { measureKeyResults, type MeasureRequest } from "../src/services/key-result-measures.js";
import { BEST_EVER_DAYS } from "../src/services/objectives-board.js";
import { PENDING_HASH } from "../src/services/watch-sets.js";
import { measureKeyResults as legacyMeasureKeyResults } from "./key-result-measures-e2ff1b8.js";
import { seedLongHistory } from "./long-history-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import type { Db } from "../src/services/db.js";

// addDays counted (the window starts): the rest of @rg/domain as it is.
vi.mock("@rg/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rg/domain")>();
  return { ...actual, addDays: vi.fn(actual.addDays) };
});

const TODAY = "2026-10-16";
const stamp = (date: string, hhmm = "07:00") => `${date}T${hhmm}:00.000Z`;

/** What makes a set hard to read, on top of the long history. */
async function seedOddities(db: Db, uid: string): Promise<void> {
  const session = (id: string, date: string, o: Partial<typeof schema.performedSessions.$inferInsert> = {}) => ({
    id, userId: uid, source: "app", localDate: date, startedAt: stamp(date), seconds: 1800, minutes: 30, mode: "build", theme: "fullBody", completed: true,
    payloadHash: `h-${id}`, createdAt: stamp(date, "08:00"), updatedAt: stamp(date, "08:00"), ...o,
  });
  const runId = `odd-run-${uid}`;
  await db.insert(schema.activities).values({
    id: runId, userId: uid, source: "coros", startTime: stamp(addDays(TODAY, -3), "06:00"), startTimeLocal: `${addDays(TODAY, -3)}T06:00:00`, sport: "strength",
    durationSeconds: 1800, title: "Strength", createdAt: stamp(addDays(TODAY, -3)), updatedAt: stamp(addDays(TODAY, -3)),
  });
  await db.insert(schema.performedSessions).values([
    session("odd-sides", addDays(TODAY, -2)),
    // The athlete's own record of an activity, and the watch's copy of it: one physical session.
    session("odd-own", addDays(TODAY, -3), { activityId: runId }),
    session("odd-watch", addDays(TODAY, -3), { activityId: runId, source: "watch" }),
    // Still being written: not there yet.
    session("odd-pending", addDays(TODAY, -1), { payloadHash: PENDING_HASH }),
    session("odd-empty", addDays(TODAY, -5)),
  ]);
  const set = (sessionId: string, entryIndex: number, exerciseId: string, setIndex: number, o: Partial<typeof schema.performedSets.$inferInsert>) => ({
    id: newId(), performedSessionId: sessionId, entryIndex, exerciseId, setIndex, done: true, ...o,
  });
  // A run the plan asked for at race effort, on the first day of a week's window (TODAY − 6: the long history's 21.1 km
  // run): its label ("test") comes only from the facts of the runs picked as worth labelling.
  const raceDoc = {
    version: 1, title: "Time trial", intent: { summary: "A time trial.", goals: [], focus: [], effort: "test" },
    parts: [{ purpose: "run", format: "straight", items: [{ kind: "run", effort: "race", target: { distanceM: 21_100 } }] }], source: { kind: "coach" },
  };
  await db.insert(schema.plannedWorkouts).values({
    id: `odd-trial-${uid}`, userId: uid, planId: "plan", sourceWorkoutId: `odd-trial-${uid}`, title: "Time trial", category: "race", sport: "run",
    originalPlanDate: addDays(TODAY, -6), lastVerifiedCorosDate: "", effectiveDate: addDays(TODAY, -6), effectiveTime: "18:00", sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 7200, createdAt: stamp(TODAY), updatedAt: stamp(TODAY), workoutDoc: JSON.stringify(raceDoc),
  });
  await db.insert(schema.workoutCompletionMatches).values({ id: newId(), workoutId: `odd-trial-${uid}`, activityId: "long-r6", confidence: 1, method: "manual", matchedAt: stamp(TODAY) });
  await db.insert(schema.performedSets).values([
    // A hold a side at a time: both sides of set 0, one side of set 1 (the other skipped).
    set("odd-sides", 0, "wallSit", 0, { side: "left", seconds: 70 }),
    set("odd-sides", 0, "wallSit", 0, { side: "right", seconds: 64 }),
    set("odd-sides", 0, "wallSit", 1, { side: "left", seconds: 95 }),
    set("odd-own", 0, "gobletSquat", 0, { reps: 5, loadKg: 30, loadValue: 30, loadUnit: "kg" }),
    set("odd-watch", 0, "gobletSquat", 0, { reps: 6, loadKg: 31, loadValue: 31, loadUnit: "kg" }),
    set("odd-pending", 0, "gobletSquat", 0, { reps: 3, loadKg: 60, loadValue: 60, loadUnit: "kg" }),
    set("odd-empty", 0, "gobletSquat", 0, { reps: null, loadKg: null }),
    set("odd-empty", 1, "wallSit", 0, { seconds: null }),
    set("odd-empty", 2, "retiredMove", 0, { reps: 9, seconds: 40, loadKg: 12 }),
    set("odd-empty", 3, "bandRow", 0, { reps: 14, done: false }),
  ]);
}

/** Every family over many windows, as the board asks them — and every logged day. */
function requests(): MeasureRequest[] {
  const out: MeasureRequest[] = [];
  for (const windowDays of [7, 30, 90, 365, BEST_EVER_DAYS]) {
    out.push(
      { measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays }, unit: "s" },
      { measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays }, unit: "lb" },
      { measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays } },
      { measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "load_at_reps", reps: 6, windowDays }, unit: "kg" },
      { measure: { kind: "best_set", libraryIds: ["bandRow", "deadBug"], metric: "reps_at_load", loadKg: 0, windowDays }, unit: "reps" },
      { measure: { kind: "best_set", libraryIds: ["retiredMove"], metric: "reps_at_load", loadKg: 10, windowDays } },
      { measure: { kind: "run_best", distanceM: 5000, windowDays }, unit: "s" },
      { measure: { kind: "run_best", distanceM: 10_000, windowDays }, unit: "min" },
      { measure: { kind: "run_best", distanceM: 21_100, windowDays } },
      { measure: { kind: "pace_at_hr", hrLow: 140, hrHigh: 155, minDurationSec: 1200, windowDays }, unit: "s/km" },
      { measure: { kind: "threshold_pace", windowDays }, unit: "s/km" },
      { measure: { kind: "predicted_time", distanceM: 21_097, windowDays }, unit: "min" },
    );
  }
  out.push({ measure: { kind: "checkin", questionId: "energy" } }, { measure: { kind: "test", testId: "wall-sit-max" } });
  return out;
}

describe("the key results, measured as before", () => {
  it("over two years and the odd sets, every family and window answers exactly as the implementation before the gate's fixes", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { timezone: "America/Los_Angeles", weightUnit: "lb", raceDate: addDays(TODAY, -30) });
    await seedLongHistory(db, userId, TODAY);
    await seedOddities(db, userId);
    for (const ctx of [{ today: TODAY, raceDate: addDays(TODAY, -30) }, { today: addDays(TODAY, -200), raceDate: null }]) {
      const now = await measureKeyResults(db, userId, requests(), ctx);
      const before = await legacyMeasureKeyResults(db, userId, requests(), ctx);
      expect(now.length).toBe(requests().length);
      expect(now).toEqual(before);
      // Not a trivial agreement: the long history is read (points in most series).
      expect(now.filter((p) => p.series.length > 10).length).toBeGreaterThan(20);
    }
    // And each window asked alone, as a key result's progress asks it: the runs worth labelling are then the window's.
    for (const windowDays of [7, 30, 90, 365]) {
      const alone = requests().filter((r) => "windowDays" in r.measure && r.measure.windowDays === windowDays);
      const now = await measureKeyResults(db, userId, alone, { today: TODAY, raceDate: addDays(TODAY, -30) });
      expect(now, `${windowDays} days`).toEqual(await legacyMeasureKeyResults(db, userId, alone, { today: TODAY, raceDate: addDays(TODAY, -30) }));
      if (windowDays === 7) expect(now.flatMap((p) => p.series).some((pt) => pt.label === "test")).toBe(true);
    }
  });
});

describe("the key results' CPU: what the board's best ever made grow with the history", () => {
  /** Runs every other day back from TODAY: `n` of them. */
  async function runsOnly(db: Db, n: number): Promise<string> {
    const { userId } = await makeTestUser(db, { timezone: "UTC" });
    const rows = Array.from({ length: n }, (_, i) => {
      const date = addDays(TODAY, -2 * i);
      return {
        id: `${userId}-r${i}`, userId, source: "coros", startTime: stamp(date, "18:00"), startTimeLocal: `${date}T18:00:00`, sport: "run",
        durationSeconds: 1500 + (i % 7) * 20, distanceMeters: i % 2 ? 5000 : 10_000, createdAt: stamp(date), updatedAt: stamp(date),
      };
    });
    for (let i = 0; i < rows.length; i += 50) await db.insert(schema.activities).values(rows.slice(i, i + 50));
    return userId;
  }

  it("each best's window start is computed once, not once a run: the dates computed don't grow with the runs", async () => {
    const db = makeTestDb();
    const few = await runsOnly(db, 20);
    const many = await runsOnly(db, 300);
    const asks: MeasureRequest[] = [
      { measure: { kind: "run_best", distanceM: 5000, windowDays: BEST_EVER_DAYS } },
      { measure: { kind: "run_best", distanceM: 10_000, windowDays: BEST_EVER_DAYS } },
    ];
    const counted = async (uid: string) => {
      vi.mocked(addDays).mockClear();
      const out = await measureKeyResults(db, uid, asks, { today: TODAY });
      expect(out[0]!.series.length).toBeGreaterThan(5);
      return vi.mocked(addDays).mock.calls.length;
    };
    expect(await counted(many)).toBe(await counted(few));
  });

  it("the logged sets never go through drizzle's per-row mapping (read as plain rows, mapped by position)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { timezone: "UTC" });
    await seedLongHistory(db, userId, TODAY);
    const column = schema.performedSets.loadKg as unknown as { mapFromDriverValue: (v: unknown) => unknown };
    let mapped = 0;
    column.mapFromDriverValue = function (this: unknown, v: unknown) {
      mapped += 1;
      return v;
    };
    try {
      const [best] = await measureKeyResults(db, userId, [{ measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays: BEST_EVER_DAYS } }], { today: TODAY });
      expect(best!.series.length).toBeGreaterThan(300);
      expect(mapped).toBe(0);
    } finally {
      delete (column as { mapFromDriverValue?: unknown }).mapFromDriverValue;
    }
  });
});
