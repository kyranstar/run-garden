/**
 * What an activity row shows of its logged sets (Phase 2a+ Task 3): the sets
 * of the performed session linked to the activity — any source, the app's own
 * (or a watch review) over a watch copy — grouped by exercise in the order
 * done, names humanized once here, weights in the athlete's unit.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { exerciseDisplayName, loggedSetsByActivity, loggedTopKgByWeek } from "../src/services/logged-sets.js";
import { upsertWatchSession } from "../src/services/watch-sets.js";
import type { Db } from "../src/services/db.js";
import { D1_BIND_LIMIT, makeTestDb, makeTestUser } from "./helpers.js";
import { ACTIVITY, detailOf, workView } from "./watch-sets-fixture.js";

async function withWatchSession(opts: { cap?: boolean } = {}) {
  const db = makeTestDb(opts.cap ? { boundVariableCap: D1_BIND_LIMIT } : {});
  const { userId } = await makeTestUser(db);
  await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
  return { db, userId };
}

async function appSession(
  db: Db,
  userId: string,
  activityId: string,
  sets: Array<{ entry: number; exerciseId: string; reps: number | null; load: [number, "lb" | "kg"] | null; done?: boolean; side?: "left" | "right" }>,
) {
  const id = newId();
  await db.insert(schema.performedSessions).values({
    id,
    userId,
    activityId,
    source: "app",
    localDate: "2026-10-01",
    payloadHash: "h",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  let i = 0;
  for (const s of sets) {
    await db.insert(schema.performedSets).values({
      id: newId(),
      performedSessionId: id,
      entryIndex: s.entry,
      exerciseId: s.exerciseId,
      setIndex: i++,
      side: s.side ?? null,
      reps: s.reps,
      loadValue: s.load?.[0] ?? null,
      loadUnit: s.load?.[1] ?? null,
      loadKg: s.load ? (s.load[1] === "kg" ? s.load[0] : s.load[0] * 0.45359237) : null,
      done: s.done ?? true,
    });
  }
}

describe("loggedSetsByActivity", () => {
  it("groups a watch session's sets by exercise, by name, weights in pounds for a pounds athlete", async () => {
    const { db, userId } = await withWatchSession();
    const out = await loggedSetsByActivity(db, userId, [ACTIVITY.activityId], "lb");
    expect(out.get(ACTIVITY.activityId)).toEqual([
      {
        exerciseId: "coros:T1041",
        name: "Bench Press",
        sets: [
          { reps: 8, seconds: null, load: { v: 50, u: "lb" }, side: null },
          { reps: 8, seconds: null, load: { v: 50, u: "lb" }, side: null },
        ],
      },
      {
        exerciseId: "coros:T1055",
        name: "Dumbbell Row",
        sets: [
          // 12 kg as typed → 26.46 lb, to the half pound
          { reps: 10, seconds: null, load: { v: 26.5, u: "lb" }, side: null },
          { reps: 9, seconds: null, load: { v: 26.5, u: "lb" }, side: null },
        ],
      },
      { exerciseId: "coros:T1010", name: "Planks", sets: [{ reps: null, seconds: 45, load: null, side: null }] },
      { exerciseId: "coros:T1004", name: "Push-ups", sets: [{ reps: 15, seconds: null, load: null, side: null }] },
    ]);
  });

  it("speaks kilograms to a kilograms athlete, keeping a kilogram weight exactly as typed", async () => {
    const { db, userId } = await withWatchSession();
    const out = (await loggedSetsByActivity(db, userId, [ACTIVITY.activityId], "kg")).get(ACTIVITY.activityId)!;
    expect(out[0]!.sets[0]!.load).toEqual({ v: 22.5, u: "kg" }); // 50 lb = 22.68 kg, to the half kilo
    expect(out[1]!.sets[0]!.load).toEqual({ v: 12, u: "kg" });
  });

  it("shows the app's own session, never the watch copy beside it", async () => {
    const { db, userId } = await withWatchSession();
    await appSession(db, userId, ACTIVITY.activityId, [
      { entry: 0, exerciseId: "gobletSquat", reps: 8, load: [25, "lb"] },
      { entry: 0, exerciseId: "gobletSquat", reps: 8, load: [25, "lb"], done: false },
      { entry: 1, exerciseId: "coros:Chin tuck hold", reps: null, load: null, done: false },
    ]);
    expect((await loggedSetsByActivity(db, userId, [ACTIVITY.activityId], "lb")).get(ACTIVITY.activityId)).toEqual([
      // A set kept as not done is not shown; an exercise with none done is not either.
      { exerciseId: "gobletSquat", name: "Goblet squat", sets: [{ reps: 8, seconds: null, load: { v: 25, u: "lb" }, side: null }] },
    ]);
  });

  it("a circuit's rounds join one row per exercise, first-seen order, sets in the order done", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    // Three rounds of squat then row: the watch gives every round of a move its own entry.
    await appSession(db, userId, "act-circuit", [
      { entry: 0, exerciseId: "gobletSquat", reps: 10, load: [25, "lb"] },
      { entry: 1, exerciseId: "coros:T1001", reps: 12, load: null },
      { entry: 2, exerciseId: "gobletSquat", reps: 9, load: [25, "lb"] },
      { entry: 3, exerciseId: "coros:T1001", reps: 11, load: null },
      { entry: 4, exerciseId: "gobletSquat", reps: 8, load: [30, "lb"] },
    ]);
    const rows = (await loggedSetsByActivity(db, userId, ["act-circuit"], "lb")).get("act-circuit")!;
    expect(rows.map((r) => [r.exerciseId, r.sets.map((s) => s.reps)])).toEqual([
      ["gobletSquat", [10, 9, 8]],
      ["coros:T1001", [12, 11]],
    ]);
  });

  it("leaves out activities with nothing logged, and other people's sessions", async () => {
    const { db, userId } = await withWatchSession();
    const other = await makeTestUser(db);
    await appSession(db, other.userId, "act-other", [{ entry: 0, exerciseId: "gobletSquat", reps: 5, load: null }]);
    const out = await loggedSetsByActivity(db, userId, ["act-none", "act-other", ACTIVITY.activityId], "lb");
    expect([...out.keys()]).toEqual([ACTIVITY.activityId]);
    expect((await loggedSetsByActivity(db, other.userId, [ACTIVITY.activityId], "lb")).size).toBe(0);
  });

  it("shows nothing of a session whose sets are still being written (audit M-3)", async () => {
    // The write dies after its first batch of sets: the session row still says `pending`.
    let n = 0;
    const db = makeTestDb({
      onStatement: (sql) => {
        if (/^\s*insert into "performed_sets"/i.test(sql) && ++n === 2) throw new Error("worker died mid-write");
      },
    });
    const { userId } = await makeTestUser(db);
    const twelve = [0, 1, 2, 3].flatMap((ex) =>
      [0, 1, 2].map((set) => ({ ...workView()[0]!, exerciseIndex: ex, setIndex: set, exerciseNameKey: `T10${41 + ex}` })),
    );
    await expect(upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(twelve) })).rejects.toThrow(/mid-write/);
    const stored = await db.select().from(schema.performedSets);
    expect(stored.length).toBeGreaterThan(0); // some sets landed…
    expect(stored.length).toBeLessThan(12);
    // …and none of them is shown.
    expect((await loggedSetsByActivity(db, userId, [ACTIVITY.activityId], "lb")).size).toBe(0);
  });

  it("reads a full page of activities under D1's bind cap", async () => {
    const { db, userId } = await withWatchSession({ cap: true });
    const ids = [...Array.from({ length: 120 }, (_, i) => `act-${i}`), ACTIVITY.activityId];
    expect((await loggedSetsByActivity(db, userId, ids, "lb")).get(ACTIVITY.activityId)).toHaveLength(4);
  });

  it("reads the sets of more sessions than one IN list holds, under D1's bind cap (audit M-13)", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const { userId } = await makeTestUser(db);
    // 120: past one IN list (90), and past the cap itself were the sets query not chunked.
    const ids = Array.from({ length: 120 }, (_, i) => `act-${String(i).padStart(3, "0")}`);
    for (const [i, activityId] of ids.entries()) {
      await appSession(db, userId, activityId, [{ entry: 0, exerciseId: "gobletSquat", reps: i + 1, load: null }]);
    }
    const out = await loggedSetsByActivity(db, userId, ids, "lb");
    expect(out.size).toBe(120);
    expect(out.get("act-119")).toEqual([
      { exerciseId: "gobletSquat", name: "Goblet squat", sets: [{ reps: 120, seconds: null, load: null, side: null }] },
    ]);
  });
});

describe("loggedTopKgByWeek — a plan's exercises, their heaviest logged set per week", () => {
  /** A Monday: week 1 of the plan. */
  const W1 = "2026-09-28";

  async function session(
    db: Db,
    userId: string,
    localDate: string,
    sets: Array<[string, number | null, boolean?]>,
    payloadHash = "h",
  ) {
    const id = newId();
    await db.insert(schema.performedSessions).values({
      id,
      userId,
      source: "watch",
      sourceRef: id,
      localDate,
      payloadHash,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    for (const [i, [exerciseId, kg, done]] of sets.entries()) {
      await db.insert(schema.performedSets).values({
        id: newId(),
        performedSessionId: id,
        entryIndex: i,
        exerciseId,
        setIndex: 0,
        reps: 5,
        loadValue: kg,
        loadUnit: kg === null ? null : "kg",
        loadKg: kg,
        done: done ?? true,
      });
    }
  }

  const exact = (id: string, originId: string) =>
    ({ id, providers: { coros: { originId, confidence: "exact", method: "curated" } } }) as unknown as ExerciseRecord;

  it("matches a plan exercise by its catalog key or its library mapping, week by week", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);
    await db.insert(schema.corosExercises).values([
      { id: "41", name: "T1041", updatedAt: nowInstant() },
      { id: "61", name: "T1061", updatedAt: nowInstant() },
    ]);
    await session(db, userId, "2026-09-30", [["coros:T1041", 22.68], ["coros:T1041", 20], ["coros:T1061", 60]]); // week 1
    await session(db, userId, "2026-10-06", [["benchPressLib", 30], ["coros:T1041", 40, false]]); // week 2; the 40 was not done
    await session(db, userId, "2026-09-27", [["coros:T1041", 99]]); // the day before the plan
    await session(db, userId, "2026-10-19", [["coros:T1041", 99]]); // after its three weeks
    await session(db, userId, "2026-10-13", [["coros:T1041", null]]); // week 3, bodyweight only
    await session(db, other.userId, "2026-09-30", [["coros:T1041", 99]]);

    const out = await loggedTopKgByWeek(db, userId, {
      weekOne: W1,
      weeks: 3,
      originIds: ["41", "name:sled push"],
      library: [exact("benchPressLib", "41")],
    });
    expect([...out.keys()]).toEqual(["41"]);
    expect([...out.get("41")!.entries()]).toEqual([
      [1, 22.68],
      [2, 30],
    ]);
  });

  it("counts nothing from a session whose sets are still being written (audit M-3)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.corosExercises).values({ id: "41", name: "T1041", updatedAt: nowInstant() });
    await session(db, userId, "2026-09-30", [["coros:T1041", 20]]);
    await session(db, userId, "2026-10-01", [["coros:T1041", 90]], "pending"); // half-written: not lifted yet
    const out = await loggedTopKgByWeek(db, userId, { weekOne: W1, weeks: 3, originIds: ["41"], library: [] });
    expect([...out.get("41")!.entries()]).toEqual([[1, 20]]);
  });

  it("reads nothing when the plan names no exercise the catalog or library knows", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    expect((await loggedTopKgByWeek(db, userId, { weekOne: W1, weeks: 3, originIds: ["S2"], library: [] })).size).toBe(0);
  });
});

describe("exerciseDisplayName — the one place an exercise id becomes words", () => {
  it.each([
    ["coros:T1041", "Bench Press"], // COROS's own English name for its key
    ["coros:Chin tuck hold", "Chin tuck hold"], // a custom move keeps its typed name
    ["gobletSquat", "Goblet squat"], // the library's name
    ["coros:T99999", "T99999"], // a key COROS does not translate stays as COROS sent it
  ])("%s → %s", (id, name) => {
    expect(exerciseDisplayName(id)).toBe(name);
  });
});
