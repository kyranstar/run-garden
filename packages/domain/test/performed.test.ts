import { describe, expect, it } from "vitest";
import {
  conditionCheckSchema,
  performedSessionSaveSchema,
  performedSetSchema,
  type PerformedSessionWireInput,
} from "../src/index.js";

const valid = (): PerformedSessionWireInput => ({
  id: "perf-1",
  source: "app",
  sourceRef: null,
  workoutId: "pw-1",
  buildId: "sb-1",
  localDate: "2026-10-01",
  startedAt: "2026-10-01T18:00:00.000Z",
  endedAt: "2026-10-01T18:31:00.000Z",
  seconds: 1860,
  plannedSeconds: 1800,
  mode: "build",
  theme: "pull-day",
  locationId: "loc-1",
  blockRef: "pb-1",
  completed: true,
  stepsTotal: 24,
  stepsDone: 22,
  movesDone: [{ exerciseId: "goblet-squat", seconds: 240 }],
  note: null,
  newMove: null,
  entries: [
    {
      exerciseId: "goblet-squat",
      implement: "kettlebell",
      format: "straight",
      perSide: false,
      sets: [
        { setIndex: 0, reps: 8, seconds: null, load: { v: 35, u: "lb" }, flags: ["flag-a"] },
        { setIndex: 1, reps: 8, seconds: null, load: { v: 16, u: "kg" } },
      ],
    },
  ],
  checks: [
    { profileId: "profile-a", kind: "pre", value: 2, feelingOff: false, at: "2026-10-01T18:00:00.000Z" },
    { profileId: "profile-a", kind: "post", value: 1, at: "2026-10-01T18:31:00.000Z" },
  ],
  review: { ratings: { "goblet-squat": 1, "cat-cow": null }, excluded: { "dead-bug": true }, graduations: [{ family: "squat", to: "front-squat" }] },
});

describe("performedSessionSaveSchema — the outbox payload", () => {
  it("parses a full payload and fills the per-set defaults", () => {
    const parsed = performedSessionSaveSchema.parse(valid());
    expect(parsed.entries[0]!.sets[1]).toEqual({ setIndex: 1, side: null, reps: 8, seconds: null, load: { v: 16, u: "kg" }, done: true, flags: [] });
    expect(parsed.checks[1]!.feelingOff).toBe(false);
    expect(parsed.review.graduations).toEqual([{ family: "squat", to: "front-squat" }]);
  });

  it("is stable: parsing its own output gives the same payload (what the outbox hashes)", () => {
    const once = performedSessionSaveSchema.parse(valid());
    expect(performedSessionSaveSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("defaults movesDone, checks and review when a sender leaves them out", () => {
    const { movesDone: _m, checks: _c, review: _r, ...rest } = valid();
    const parsed = performedSessionSaveSchema.parse(rest);
    expect(parsed.movesDone).toEqual([]);
    expect(parsed.checks).toEqual([]);
    expect(parsed.review).toEqual({ ratings: {}, excluded: {}, graduations: [] });
  });

  it("requires an import to name its source session", () => {
    expect(performedSessionSaveSchema.safeParse({ ...valid(), source: "import", sourceRef: null }).success).toBe(false);
    expect(performedSessionSaveSchema.safeParse({ ...valid(), source: "import", sourceRef: "standalone-17" }).success).toBe(true);
  });

  it("takes pre and post checks only, at most one of each per profile", () => {
    const at = "2026-10-01T18:00:00.000Z";
    const withChecks = (checks: unknown[]) => performedSessionSaveSchema.safeParse({ ...valid(), checks }).success;
    expect(withChecks([{ profileId: "a", kind: "daily", value: 3, at }])).toBe(false);
    expect(withChecks([{ profileId: "a", kind: "pre", value: 3, at }, { profileId: "a", kind: "pre", value: 4, at }])).toBe(false);
    expect(withChecks([{ profileId: "a", kind: "pre", value: 3, at }, { profileId: "b", kind: "pre", value: 4, at }])).toBe(true);
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["a bad local date", { localDate: "2026-02-30" }],
    ["a time that is not an instant", { startedAt: "6pm" }],
    ["negative seconds", { seconds: -1 }],
    ["fractional seconds", { seconds: 1.5 }],
    ["an unknown mode", { mode: "flare" }],
    ["an unknown source", { source: "coros" }],
    ["an empty id", { id: "" }],
    ["a rating other than ±1", { review: { ratings: { x: 2 } } }],
  ])("refuses %s", (_label, patch) => {
    expect(performedSessionSaveSchema.safeParse({ ...valid(), ...patch }).success).toBe(false);
  });

  it("refuses an entry with no sets, an unknown format, or a set with a zero or unit-less load", () => {
    const entry = valid().entries[0]!;
    const withEntry = (e: unknown) => performedSessionSaveSchema.safeParse({ ...valid(), entries: [e] }).success;
    expect(withEntry({ ...entry, sets: [] })).toBe(false);
    expect(withEntry({ ...entry, format: "amrap" })).toBe(false);
    expect(performedSetSchema.safeParse({ setIndex: 0, reps: 5, seconds: null, load: { v: 0, u: "lb" } }).success).toBe(false);
    expect(performedSetSchema.safeParse({ setIndex: 0, reps: 5, seconds: null, load: { v: 10 } }).success).toBe(false);
  });
});

describe("conditionCheckSchema", () => {
  it("takes 0–10 or null, and a daily check on its own", () => {
    const at = "2026-10-01T08:00:00+02:00";
    expect(conditionCheckSchema.parse({ profileId: "a", kind: "daily", value: null, feelingOff: true, at })).toEqual({
      profileId: "a",
      kind: "daily",
      value: null,
      feelingOff: true,
      at,
    });
    for (const value of [-1, 11, 2.5]) {
      expect(conditionCheckSchema.safeParse({ profileId: "a", kind: "pre", value, at }).success, String(value)).toBe(false);
    }
  });
});
