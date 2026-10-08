import { describe, expect, it } from "vitest";
import {
  conditionCheckSchema,
  PERFORMED_LIMITS,
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
  minutes: 30,
  mode: "build",
  theme: "pull-day",
  locationId: "loc-1",
  blockRef: "pb-1",
  blockNumber: 2,
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

describe("performedSessionSaveSchema — limits a real session never reaches (audit 2b-A M-4)", () => {
  const entry = (exerciseId: string, sets: number) => ({
    exerciseId,
    implement: null,
    format: "straight" as const,
    perSide: false,
    sets: Array.from({ length: sets }, (_, i) => ({ setIndex: i, reps: 8, seconds: null, load: null })),
  });

  it("takes up to 300 sets in all, and refuses more (a save that large could never complete)", () => {
    const sets = (n: number) => Array.from({ length: n / 50 }, (_, i) => entry(`move-${i}`, 50));
    expect(performedSessionSaveSchema.safeParse({ ...valid(), entries: sets(300) }).success).toBe(true);
    const tooMany = performedSessionSaveSchema.safeParse({ ...valid(), entries: [...sets(300), entry("one-more", 1)] });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error!.issues.map((i) => i.path)).toEqual([["entries"]]);
    expect(PERFORMED_LIMITS.sets).toBe(300);
  });

  it("rates or sets aside at most the moves the session holds (entries + moves reached)", () => {
    const ids = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`move-${i}`, 1 as const]));
    // valid() holds one entry and one move reached: two.
    expect(performedSessionSaveSchema.safeParse({ ...valid(), review: { ratings: ids(2), excluded: {} } }).success).toBe(true);
    const ratings = performedSessionSaveSchema.safeParse({ ...valid(), review: { ratings: ids(3) } });
    expect(ratings.success).toBe(false);
    expect(ratings.error!.issues.map((i) => i.path)).toEqual([["review", "ratings"]]);
    const excluded = performedSessionSaveSchema.safeParse({ ...valid(), review: { excluded: Object.fromEntries(Object.keys(ids(3)).map((k) => [k, true])) } });
    expect(excluded.error!.issues.map((i) => i.path)).toEqual([["review", "excluded"]]);
  });

  it("counts every move the session held — its plan's, done or skipped — plus its entries (ruling 2b-R17)", () => {
    const ids = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`move-${i}`, -1 as const]));
    // A mobility session whose four holds were all skipped: nothing done, nothing logged, every row rated.
    const skipped = { ...valid(), entries: [], movesDone: [], movesPlanned: 4 };
    expect(performedSessionSaveSchema.safeParse({ ...skipped, review: { ratings: ids(4) } }).success).toBe(true);
    expect(performedSessionSaveSchema.safeParse({ ...skipped, review: { excluded: { "move-0": true, "move-3": true } } }).success).toBe(true);
    // valid() logs one entry: its plan's four moves plus that entry.
    expect(performedSessionSaveSchema.safeParse({ ...valid(), movesPlanned: 4, review: { ratings: ids(5) } }).success).toBe(true);
    const over = performedSessionSaveSchema.safeParse({ ...valid(), movesPlanned: 4, review: { ratings: ids(6) } });
    expect(over.error!.issues.map((i) => i.path)).toEqual([["review", "ratings"]]);
    // Only junk is refused: a plan holds no more moves than a session may have done.
    const junk = performedSessionSaveSchema.safeParse({ ...valid(), movesPlanned: PERFORMED_LIMITS.movesDone + 1 });
    expect(junk.error!.issues.map((i) => i.path)).toEqual([["movesPlanned"]]);
    // Without it (an import, a watch review, an outbox entry saved before it existed): the moves done count, as before.
    expect(performedSessionSaveSchema.parse(valid())).not.toHaveProperty("movesPlanned");
  });

  it("graduates each core family at most once, and no more families than there are", () => {
    const grad = (family: string) => ({ family, to: `${family}-harder` });
    const families = ["squat", "hinge", "row", "press", "carry"];
    expect(performedSessionSaveSchema.safeParse({ ...valid(), review: { graduations: families.map(grad) } }).success).toBe(true);
    expect(performedSessionSaveSchema.safeParse({ ...valid(), review: { graduations: [...families, "lunge"].map(grad) } }).success).toBe(false);
    const twice = performedSessionSaveSchema.safeParse({ ...valid(), review: { graduations: [grad("squat"), { family: "squat", to: "other" }] } });
    expect(twice.success).toBe(false);
    expect(twice.error!.issues.map((i) => i.path)).toEqual([["review", "graduations", 1]]);
    expect(PERFORMED_LIMITS.graduations).toBe(5);
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
