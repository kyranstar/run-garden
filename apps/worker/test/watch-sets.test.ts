/**
 * Logged sets from watch strength sessions (Phase 2a+ Task 2): a COROS
 * strength activity's lap items become one `watch` performed session and one
 * `performed_sets` row per set.
 *
 * The wire facts come from six masked probe runs (rulings 2a+-R1..R4): the lap
 * `weight` is kg × 1000; a weight typed in pounds is stored in pounds; the
 * items appear twice, once per lap type, and only the lowest code is read;
 * within it, items group by (exerciseIndex, setIndex) — every item carrying
 * reps or weight is a set, a following no-data item is that set's rest, and a
 * group with no data item is one timed set from its first item; `time` is
 * 1/100 s; the exercise's identity is `exerciseNameKey`.
 *
 * Every fixture below is synthetic, shaped like the real lap skeleton (the
 * probe's own fixtures). No value comes from the athlete's account.
 */
import { describe, expect, it } from "vitest";
import { fixtureCorosStrengthLapList } from "@rg/providers";
import { deriveWatchSession, watchLoad } from "../src/services/watch-sets.js";
import { ACTIVITY, detailOf, duplicateView, item, NOW, USER, workView } from "./watch-sets-fixture.js";

type Row = Record<string, unknown>;
const pick = (rows: Row[], keys: string[]) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
const SET_KEYS = ["entryIndex", "setIndex", "exerciseId", "reps", "seconds", "loadValue", "loadUnit", "loadKg"];

/** The expected sets of `workView`, worked out by hand from the rulings. */
const EXPECTED_SETS = [
  { entryIndex: 0, setIndex: 0, exerciseId: "coros:T1041", reps: 8, seconds: null, loadValue: 50, loadUnit: "lb", loadKg: 22.68 },
  { entryIndex: 0, setIndex: 1, exerciseId: "coros:T1041", reps: 8, seconds: null, loadValue: 50, loadUnit: "lb", loadKg: 22.68 },
  { entryIndex: 1, setIndex: 0, exerciseId: "coros:T1055", reps: 10, seconds: null, loadValue: 12, loadUnit: "kg", loadKg: 12 },
  { entryIndex: 1, setIndex: 1, exerciseId: "coros:T1055", reps: 9, seconds: null, loadValue: 12, loadUnit: "kg", loadKg: 12 },
  { entryIndex: 2, setIndex: 0, exerciseId: "coros:T1010", reps: null, seconds: 45, loadValue: null, loadUnit: null, loadKg: null },
  { entryIndex: 3, setIndex: 0, exerciseId: "coros:T1004", reps: 15, seconds: null, loadValue: null, loadUnit: null, loadKg: null },
];

describe("deriveWatchSession — the lap layout (ruling 2a+-R3)", () => {
  it("logs each data item as a set, skips its rest, and turns a no-data group into one timed set (Review Focus 1)", () => {
    const out = deriveWatchSession(detailOf(workView()), ACTIVITY, USER, { now: NOW });
    expect(out).not.toBeNull();
    expect(pick(out!.sets as Row[], SET_KEYS)).toEqual(EXPECTED_SETS);
  });

  it("reads only the lowest lap type, wherever it sits in the list and however the lap lists split", () => {
    // Lap type 1 first, in one list with lap type 0.
    const mixed = deriveWatchSession(detailOf([...duplicateView(1), ...workView(0)]), ACTIVITY, USER, { now: NOW });
    expect(pick(mixed!.sets as Row[], SET_KEYS)).toEqual(EXPECTED_SETS);
    // Each lap type in its own lap list, the duplicate's list first.
    const split = deriveWatchSession(detailOf(duplicateView(1), workView(0)), ACTIVITY, USER, { now: NOW });
    expect(pick(split!.sets as Row[], SET_KEYS)).toEqual(EXPECTED_SETS);
    // A higher code is still the duplicate when it is the only other one present.
    const three = deriveWatchSession(detailOf(workView(2), duplicateView(5)), ACTIVITY, USER, { now: NOW });
    expect(pick(three!.sets as Row[], SET_KEYS)).toEqual(EXPECTED_SETS);
  });

  it("keeps a weighted item with no reps as a set, with its time when it has one", () => {
    const out = deriveWatchSession(
      detailOf([
        item({ exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1067", reps: 0, weight: 20_000, time: 3_350 }),
        item({ exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1067", time: 6_000 }),
      ]),
      ACTIVITY,
      USER,
      { now: NOW },
    );
    expect(pick(out!.sets as Row[], SET_KEYS)).toEqual([
      { entryIndex: 0, setIndex: 0, exerciseId: "coros:T1067", reps: null, seconds: 34, loadValue: 20, loadUnit: "kg", loadKg: 20 },
    ]);
  });

  it("drops a no-data item that comes before its group's data item (it is not a hold)", () => {
    const out = deriveWatchSession(
      detailOf([
        item({ exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1061", time: 5_000 }),
        item({ exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1061", reps: 12, weight: 0, time: 4_000 }),
      ]),
      ACTIVITY,
      USER,
      { now: NOW },
    );
    expect(pick(out!.sets as Row[], ["exerciseId", "reps", "seconds"])).toEqual([
      { exerciseId: "coros:T1061", reps: 12, seconds: null },
    ]);
  });

  it("skips an item with no exercise key (it cannot be named), and returns null when no set is left", () => {
    const keyless = [
      item({ exerciseNameKey: "", reps: 10, weight: 20_000, time: 3_000 }),
      item({ exerciseNameKey: undefined, reps: 10, weight: 20_000, time: 3_000 }),
    ];
    expect(deriveWatchSession(detailOf(keyless), ACTIVITY, USER, { now: NOW })).toBeNull();
    expect(deriveWatchSession({}, ACTIVITY, USER, { now: NOW })).toBeNull();
    expect(deriveWatchSession(detailOf([]), ACTIVITY, USER, { now: NOW })).toBeNull();
  });

  it("reads time as 1/100 s (ruling 2a+-R4)", () => {
    const out = deriveWatchSession(
      detailOf([item({ exerciseNameKey: "T1010", time: 6_049, targetType: 2 })]),
      ACTIVITY,
      USER,
      { now: NOW },
    );
    expect(out!.sets[0]!.seconds).toBe(60);
  });
});

describe("deriveWatchSession — exercise identity (Review Focus 4)", () => {
  it("names an unmapped exercise by its COROS key", () => {
    const out = deriveWatchSession(detailOf(workView()), ACTIVITY, USER, { now: NOW });
    expect([...new Set(out!.sets.map((s) => s.exerciseId))]).toEqual([
      "coros:T1041",
      "coros:T1055",
      "coros:T1010",
      "coros:T1004",
    ]);
  });

  it("uses the library id when the reverse mapping knows the key", () => {
    const out = deriveWatchSession(detailOf(workView()), ACTIVITY, USER, {
      now: NOW,
      libraryIdFor: (key) => (key === "T1041" ? "benchPress" : null),
    });
    expect([...new Set(out!.sets.map((s) => s.exerciseId))]).toEqual([
      "benchPress",
      "coros:T1055",
      "coros:T1010",
      "coros:T1004",
    ]);
  });

  it("identifies by name key, never by exerciseId (one exerciseId spans many exercises)", () => {
    const sameId = workView().map((i) => ({ ...i, exerciseId: "8100" }));
    const out = deriveWatchSession(detailOf(sameId), ACTIVITY, USER, { now: NOW });
    expect(new Set(out!.sets.map((s) => s.exerciseId)).size).toBe(4);
  });
});

describe("deriveWatchSession — the session row", () => {
  it("is a completed watch session keyed by the COROS activity, dated by the activity's local day", () => {
    const out = deriveWatchSession(detailOf(workView()), ACTIVITY, USER, { now: NOW, workoutId: "wo-31" });
    const s = out!.session;
    expect(s).toMatchObject({
      userId: USER,
      source: "watch",
      sourceRef: "lbl-strength-9001",
      activityId: "act-5512",
      workoutId: "wo-31",
      buildId: null,
      localDate: "2026-10-01",
      startedAt: "2026-10-01T13:00:00.000Z",
      endedAt: "2026-10-01T13:45:00.000Z",
      seconds: 2400,
      completed: true,
      mode: null,
      theme: null,
      note: null,
      newMove: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Every move reached, with the time spent on it (sets and rests): the engine's `done`.
    expect(s.movesDone).toEqual([
      { exerciseId: "coros:T1041", seconds: 267 },
      { exerciseId: "coros:T1055", seconds: 61 },
      { exerciseId: "coros:T1010", seconds: 165 },
      { exerciseId: "coros:T1004", seconds: 90 },
    ]);
    // Watch sets are whole sets, done, unflagged.
    for (const set of out!.sets) {
      expect(set).toMatchObject({ performedSessionId: s.id, side: null, perSide: false, done: true, flags: [] });
    }
  });

  it("gives the session and its sets ids that a re-derivation reproduces", () => {
    const a = deriveWatchSession(detailOf(workView()), ACTIVITY, USER, { now: NOW });
    const b = deriveWatchSession(detailOf(duplicateView(1), workView(0)), ACTIVITY, USER, { now: "2026-10-03T00:00:00.000Z" });
    expect(b!.session.id).toBe(a!.session.id);
    expect(b!.sets.map((s) => s.id)).toEqual(a!.sets.map((s) => s.id));
    expect(new Set(a!.sets.map((s) => s.id)).size).toBe(a!.sets.length);
    // Same content → same hash; the hash ignores when it was derived and the workout it matched.
    expect(b!.session.payloadHash).toBe(a!.session.payloadHash);
    const edited = workView().map((i) => (i.reps === 8 ? { ...i, reps: 7 } : i));
    const c = deriveWatchSession(detailOf(edited), ACTIVITY, USER, { now: NOW, workoutId: "wo-9" });
    expect(c!.session.payloadHash).not.toBe(a!.session.payloadHash);
  });
});

describe("the fixture stack's strength lap list", () => {
  it("derives to the sets it was written to show", () => {
    const out = deriveWatchSession({ lapList: fixtureCorosStrengthLapList() }, ACTIVITY, USER, { now: NOW });
    const text = (s: Row) => [s.exerciseId, s.reps ?? `${s.seconds} s`, s.loadValue === null ? "bw" : `${s.loadValue} ${s.loadUnit}`].join(" ");
    expect((out!.sets as Row[]).map(text)).toEqual([
      "coros:T1061 8 60 lb",
      "coros:T1061 8 60 lb",
      "coros:T1061 8 60 lb",
      "coros:T1055 10 14 kg",
      "coros:T1055 10 14 kg",
      "coros:T1055 10 14 kg",
      "coros:T1055 10 14 kg",
      "coros:T1041 6 27.5 kg",
      "coros:T1041 6 27.5 kg",
      "coros:T1041 6 30 kg",
      "coros:T1010 45 s bw",
      "coros:T1010 45 s bw",
    ]);
  });
});

describe("watchLoad — the unit the athlete most likely typed (rulings 2a+-R1, R2; Review Focus 5)", () => {
  it.each([
    // grams      value  unit   kg
    [22_680, 50, "lb", 22.68], // 50.0009 lb
    [10_206, 22.5, "lb", 10.206], // 22.5003 lb — a 2.5 lb step
    [11_340, 25, "lb", 11.34],
    [4_536, 10, "lb", 4.536],
    [20_000, 20, "kg", 20], // a whole kg
    [127_000, 127, "kg", 127], // a whole kg that is also 279.99 lb: kg wins
    [12_345, 12.345, "kg", 12.345], // neither: kept as the wire's kg
    [2_500, 2.5, "kg", 2.5],
  ])("%d g → %d %s (%d kg)", (grams, value, unit, kg) => {
    const load = watchLoad(grams);
    expect(load).not.toBeNull();
    expect(load!.value).toBe(value);
    expect(load!.unit).toBe(unit);
    expect(Math.abs(load!.kg - kg)).toBeLessThan(0.005);
  });

  it("reads a zero, missing or junk weight as bodyweight (no load)", () => {
    expect(watchLoad(0)).toBeNull();
    expect(watchLoad(undefined)).toBeNull();
    expect(watchLoad(-5_000)).toBeNull();
    expect(watchLoad("n/a")).toBeNull();
  });

  it("accepts a numeric string the way the probe saw some fields arrive", () => {
    expect(watchLoad("22680")).toEqual({ value: 50, unit: "lb", kg: 22.68 });
  });
});
