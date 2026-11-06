/**
 * THE TRE COURSE: a fixed sequence whose order and doses come from its sources, not from the engine. The first ten
 * sessions play the whole sequence, later ones only the floor. Tremor time and the wall sit step up, never past the
 * sources' beginner cap. It validates clean for an athlete with an active condition profile, plays as a calm session
 * (never a lift), and its moves are never picked for any other session on their own. Synthetic; nothing personal.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, TMJ, type CheckReading } from "@rg/exercise-library";
import { LIBRARY, seededBuilds } from "./seeded-builds.js";
import {
  deriveDoc,
  playerStepsFromDoc,
  quickStartDoc,
  suggestForPart,
  treSessionDoc,
  validateWorkoutDoc,
  type DayContext,
  type QuickStartKind,
  type SuggestCtx,
} from "../src/index.js";

const WHOLE_SEQUENCE = [
  "footEdgeShifts",
  "singleLegCalfRaise",
  "supportedOneLegSquat",
  "wideForwardFold",
  "standingPsoasStretch",
  "highWallSit",
  "hangingForwardFold",
  "reclinedButterfly",
  "bridge",
  "reclinedButterfly",
  "floorTremor",
  "legsUp",
];
const FLOOR_ONLY = ["reclinedButterfly", "bridge", "reclinedButterfly", "floorTremor", "legsUp"];
/** The moves that exist only for this sequence: never picked for another session. */
const TRE_ONLY = ["footEdgeShifts", "supportedOneLegSquat", "wideForwardFold", "standingPsoasStretch", "highWallSit", "hangingForwardFold", "floorTremor"];

const moves = (doc: WorkoutDoc): string[] => doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId] : [])));
const holdOf = (doc: WorkoutDoc, id: string): number | undefined => {
  for (const part of doc.parts) for (const i of part.items) if (i.kind === "exercise" && i.libraryId === id) return i.dose.holdSec;
  return undefined;
};

const TODAY = "2026-03-10";
const reading = (pre: number | null, feelingOff = false): CheckReading => ({ pre, post: null, feelingOff });
const dayOf = (r: CheckReading | null, o: Partial<DayContext> = {}): DayContext => ({ date: TODAY, today: TODAY, readings: { tmj: r }, ...o });
const validate = (doc: WorkoutDoc, day: DayContext | null) =>
  validateWorkoutDoc(doc, { library: EXERCISES, activeProfiles: [TMJ], day, excluded: [], equipment: EQUIPMENT_IDS });
const SESSIONS = Array.from({ length: 16 }, (_, i) => i + 1);

describe("the course's sequence", () => {
  it.each([1, 2, 5, 9, 10])("session %i plays the whole sequence, in order", (n) => {
    expect(moves(treSessionDoc(n))).toEqual(WHOLE_SEQUENCE);
  });

  it.each([11, 12, 14, 40])("session %i goes straight to the floor", (n) => {
    expect(moves(treSessionDoc(n))).toEqual(FLOOR_ONLY);
  });

  it("names each session by where it is in the course", () => {
    expect(treSessionDoc(3).title).toBe("TRE 3 of 10");
    expect(treSessionDoc(10).title).toBe("TRE 10 of 10");
    expect(treSessionDoc(11).title).toBe("TRE · floor");
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses session %s", (n) => {
    expect(() => treSessionDoc(n)).toThrow();
  });
});

describe("the course's doses", () => {
  it.each([
    [1, 180, 300],
    [2, 180, 300],
    [3, 240, 420],
    [4, 240, 420],
    [5, 300, 600],
    [8, 300, 600],
    [10, 300, 600],
  ])("session %i: a %i s wall sit, then %i s of tremor", (n, wallSit, tremor) => {
    const doc = treSessionDoc(n);
    expect(holdOf(doc, "highWallSit")).toBe(wallSit);
    expect(holdOf(doc, "floorTremor")).toBe(tremor);
  });

  it.each([
    [11, 600],
    [12, 600],
    [13, 720],
    [14, 720],
    [15, 900],
    [60, 900],
  ])("session %i: %i s of tremor on the floor", (n, tremor) => {
    expect(holdOf(treSessionDoc(n), "floorTremor")).toBe(tremor);
  });

  it("never lengthens the tremor past 15 minutes or steps it back", () => {
    let last = 0;
    for (let n = 1; n <= 100; n++) {
      const tremor = holdOf(treSessionDoc(n), "floorTremor")!;
      expect(tremor).toBeLessThanOrEqual(900);
      expect(tremor).toBeGreaterThanOrEqual(last);
      last = tremor;
    }
  });

  it("the prep's rests and the closing rest keep the sources' times", () => {
    const doc = treSessionDoc(5);
    expect(holdOf(doc, "hangingForwardFold")).toBe(60);
    expect(holdOf(doc, "bridge")).toBe(60);
    expect(holdOf(doc, "reclinedButterfly")).toBe(60);
    expect(holdOf(doc, "legsUp")).toBe(300);
  });
});

describe("the course as a workout", () => {
  it.each(SESSIONS)("session %i has no errors, whatever the day", (n) => {
    const days: Array<DayContext | null> = [null, dayOf(reading(1)), dayOf(null), dayOf(reading(7)), dayOf(reading(2, true)), dayOf(null, { date: "2026-03-13" })];
    for (const day of days) {
      expect(validate(treSessionDoc(n), day).filter((i) => i.severity === "error")).toEqual([]);
    }
  });

  it.each(SESSIONS)("session %i raises no warning on a calm day, a day ahead or as a template", (n) => {
    for (const day of [null, dayOf(reading(1)), dayOf(null, { date: "2026-03-13" })]) {
      expect(validate(treSessionDoc(n), day)).toEqual([]);
    }
  });

  it.each(SESSIONS)("session %i counts as a calm session, not a lift", (n) => {
    const derived = deriveDoc(treSessionDoc(n), EXERCISES);
    expect(derived.discipline).toBe("yoga");
    expect(derived.category).toBe("yoga");
  });

  // By hand: 30 s of shifts, 13 reps x 2 x 3 s on each leg move, 12 and 9 breaths x 6 s, then the holds as written.
  it.each([
    [1, 20, 25],
    [5, 27, 32],
    [11, 15, 20],
  ])("session %i runs about %i to %i minutes", (n, low, high) => {
    const minutes = deriveDoc(treSessionDoc(n), EXERCISES).estimatedMinutes;
    expect(minutes).toBeGreaterThanOrEqual(low);
    expect(minutes).toBeLessThanOrEqual(high);
  });
});

describe("the course in the player", () => {
  const steps = playerStepsFromDoc(treSessionDoc(5), EXERCISES);
  const of = (id: string) => steps.filter((s) => s.exerciseId === id);

  it("waits on the moves led by effort: they stop at 7 out of 10, not on a clock", () => {
    expect(of("singleLegCalfRaise").every((s) => s.kind === "set")).toBe(true);
    expect(of("supportedOneLegSquat").every((s) => s.kind === "set")).toBe(true);
  });

  // Hands on the floor and head down: nobody can tap Done. Twelve and nine breaths at the record's 6 s a breath, 72 s
  // and 54 s, which a window rounds to the nearest 5 s.
  it("runs the folds on a timer, hands free", () => {
    expect(of("wideForwardFold").map((s) => [s.kind, s.seconds])).toEqual([["timed", 70]]);
    expect(of("standingPsoasStretch").map((s) => [s.kind, s.seconds])).toEqual([["timed", 55]]);
    expect(of("hangingForwardFold").map((s) => [s.kind, s.seconds])).toEqual([["timed", 60]]);
  });

  it("times the holds at their dose", () => {
    expect(of("highWallSit").map((s) => [s.kind, s.seconds])).toEqual([["timed", 300]]);
    expect(of("floorTremor").map((s) => [s.kind, s.seconds])).toEqual([["timed", 600]]);
  });

  it("never pauses for a rest inside the standing work", () => {
    const standing = steps.slice(0, steps.findIndex((s) => s.exerciseId === "reclinedButterfly"));
    expect(standing.filter((s) => s.kind === "rest")).toEqual([]);
  });

  it("ends on the five-minute rest, never on the tremor", () => {
    const last = steps[steps.length - 1]!;
    expect([last.exerciseId, last.seconds]).toEqual(["legsUp", 300]);
  });
});

describe("the course's own moves are never picked for another session", () => {
  const FOCUS = ["hips", "adductors", "hip-flexors", "hamstrings", "calves", "quads"];
  const CTX: SuggestCtx = {
    activeProfiles: [TMJ],
    day: dayOf(reading(1)),
    focusRefs: FOCUS,
    recentIds: [],
    pinned: [],
    excluded: [],
    equipment: EQUIPMENT_IDS,
    seed: 1,
  };
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

  it("the library holds them, so these sweeps can see them", () => {
    const ids = new Set(EXERCISES.map((e) => e.id));
    expect(TRE_ONLY.filter((id) => !ids.has(id))).toEqual([]);
    const seeded = new Set(LIBRARY.map((e) => e.id));
    expect(TRE_ONLY.filter((id) => !seeded.has(id))).toEqual([]);
  });

  it.each(["condition_care", "desk_reset", "hip_opener"] as QuickStartKind[])("%s quick starts, 40 seeds", (kind) => {
    for (const seed of SEEDS) {
      const made = quickStartDoc(kind, EXERCISES, { ...CTX, seed });
      if (!("doc" in made)) throw new Error(made.reason);
      expect(moves(made.doc).filter((id) => TRE_ONLY.includes(id))).toEqual([]);
    }
  });

  it("a part's suggestions, 40 seeds", () => {
    const blank: WorkoutDoc = {
      version: 1,
      title: "Blank",
      intent: { summary: "Blank", goals: [], focus: FOCUS, effort: "recover" },
      parts: [
        { purpose: "warmup", format: "flow", items: [{ kind: "rest", seconds: 30 }] },
        { purpose: "activation", format: "flow", items: [{ kind: "rest", seconds: 30 }] },
        { purpose: "cooldown", format: "holds", items: [{ kind: "rest", seconds: 30 }] },
      ],
      source: { kind: "studio" },
    };
    for (const seed of SEEDS) {
      for (const part of [0, 1, 2]) {
        const offered = suggestForPart(blank, part, EXERCISES, { ...CTX, seed }).map((s) => s.libraryId);
        expect(offered.filter((id) => TRE_ONLY.includes(id))).toEqual([]);
      }
    }
  });

  // Made here, as adapt.test.ts makes them: 50 builds are seconds of work on a loaded runner, past a test's own timeout.
  const builds = seededBuilds(50);
  it("the day's build, 50 seeded builds", () => {
    for (const { plan } of builds) {
      expect(plan.items.map((i) => i.exercise.id).filter((id) => TRE_ONLY.includes(id))).toEqual([]);
    }
  });
});
