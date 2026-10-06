/**
 * What an activity row shows of its logged sets (Phase 2a+ Task 3): the sets
 * of the performed session linked to the activity — any source, the app's own
 * (or a watch review) over a watch copy — grouped by exercise in the order
 * done, names humanized once here, weights in the athlete's unit.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { exerciseDisplayName, loggedSetsByActivity } from "../src/services/logged-sets.js";
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

  it("leaves out activities with nothing logged, and other people's sessions", async () => {
    const { db, userId } = await withWatchSession();
    const other = await makeTestUser(db);
    await appSession(db, other.userId, "act-other", [{ entry: 0, exerciseId: "gobletSquat", reps: 5, load: null }]);
    const out = await loggedSetsByActivity(db, userId, ["act-none", "act-other", ACTIVITY.activityId], "lb");
    expect([...out.keys()]).toEqual([ACTIVITY.activityId]);
    expect((await loggedSetsByActivity(db, other.userId, [ACTIVITY.activityId], "lb")).size).toBe(0);
  });

  it("reads a full page of activities under D1's bind cap", async () => {
    const { db, userId } = await withWatchSession({ cap: true });
    const ids = [...Array.from({ length: 120 }, (_, i) => `act-${i}`), ACTIVITY.activityId];
    expect((await loggedSetsByActivity(db, userId, ids, "lb")).get(ACTIVITY.activityId)).toHaveLength(4);
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
