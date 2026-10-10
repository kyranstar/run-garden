import { describe, expect, it } from "vitest";
import type { ExerciseRecord } from "@rg/exercise-library";
import type { WorkoutDoc, WorkoutItem, WorkoutPart } from "@rg/domain";
import { deriveDoc, derivePerformed, effortOfMode, modeOfEffort } from "../src/index.js";

// Minimal library records, with every number below worked out by hand.
type Over = Record<string, unknown>;
function rec(id: string, o: Over): ExerciseRecord {
  return {
    id, legacyIds: [], name: id, family: id, patterns: [], regions: [], roles: [], equipment: { all: [], oneOf: [] },
    position: "standing", laterality: "bilateral", load: "none", dose: { type: "reps", range: [8, 12] }, difficulty: 1,
    easier: [], harder: [], tags: [], contraction: ["isotonic"], muscles: { primary: [], secondary: [] }, purposes: [],
    themes: [], text: {}, conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    ...o,
  } as unknown as ExerciseRecord;
}

const LIB: ExerciseRecord[] = [
  rec("catCow", { regions: ["low-back"], muscles: { primary: ["erector-spinae"], secondary: ["rectus-abdominis"] }, purposes: ["mobility"], dose: { type: "time", range: [30, 60] } }),
  rec("pigeon", { contraction: ["passive"], regions: ["hips"], purposes: ["stretch", "mobility"], equipment: { all: ["mat"], oneOf: [] }, muscles: { primary: ["deep-hip-rotators"], secondary: ["glute-max"] }, dose: { type: "time", range: [30, 60] }, conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } } }),
  rec("slowBreathing", { contraction: ["passive"], regions: ["core"], purposes: ["recovery"], muscles: { primary: ["diaphragm"], secondary: [] }, dose: { type: "breaths", range: [5, 10] } }),
  rec("bridge", { regions: ["glutes"], purposes: ["activation"], muscles: { primary: ["glute-max"], secondary: ["hamstrings"] }, dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 30 } }),
  rec("swing", { regions: ["glutes", "hamstrings"], purposes: ["power", "strength"], equipment: { all: [], oneOf: ["kettlebell", "dumbbells"] }, muscles: { primary: ["glute-max"], secondary: ["hamstrings"] }, dose: { type: "reps", range: [10, 15], secsPerRep: 2, restSec: 60 }, conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } } }),
  rec("wallSit", { contraction: ["isometric"], regions: ["quads"], purposes: ["strength"], muscles: { primary: ["quads"], secondary: [] }, dose: { type: "time", range: [20, 40] } }),
  rec("boxHop", { contraction: ["plyometric"], regions: ["quads"], purposes: ["power"], muscles: { primary: ["quads"], secondary: [] }, dose: { type: "reps", range: [3, 6], secsPerRep: 1 }, conditions: { tmj: { clench: 2, neckLoad: 0, faceDown: false } } }),
  rec("nordic", { contraction: ["eccentric", "isotonic"], regions: ["hamstrings"], purposes: ["strength"], muscles: { primary: ["hamstrings"], secondary: [] }, dose: { type: "reps", range: [4, 8], secsPerRep: 4 } }),
  rec("ninetyNinety", { regions: ["hips"], purposes: ["mobility"], muscles: { primary: ["deep-hip-rotators"], secondary: [] }, dose: { type: "time", range: [30, 90] } }),
  rec("renamed", { id: "renamed", legacyIds: ["oldName"], regions: ["glutes"], purposes: ["strength"], muscles: { primary: ["glute-max"], secondary: [] }, dose: { type: "reps", range: [10, 10], secsPerRep: 2 } }),
];

const ex = (libraryId: string, dose: Over, extra: Over = {}): WorkoutItem => ({ kind: "exercise", libraryId, dose, ...extra }) as WorkoutItem;
const run = (effort: string, target: Over): WorkoutItem => ({ kind: "run", effort, target }) as WorkoutItem;
const part = (purpose: string, format: string, items: WorkoutItem[], extra: Over = {}): WorkoutPart => ({ purpose, format, items, ...extra }) as WorkoutPart;
const doc = (parts: WorkoutPart[], effort: WorkoutDoc["intent"]["effort"] = "maintain"): WorkoutDoc => ({
  version: 1, title: "t", intent: { summary: "s", goals: [], focus: [], effort }, parts, source: { kind: "studio" },
});

// A. Easy run + strides + mobility.
const EASY_RUN = doc([
  part("warmup", "flow", [ex("catCow", { holdSec: 60 })]),
  part("run", "steady", [run("easy", { durationSec: 1800 })]),
  part("run", "intervals", [run("strides", { durationSec: 20 }), { kind: "rest", seconds: 40 }], { rounds: 4 }),
  part("cooldown", "flow", [ex("pigeon", { holdSec: 50, perSide: true })]),
]);
// B. Activation -> hinge -> power -> hip opening lift.
const LIFT = doc(
  [
    part("activation", "straight", [ex("bridge", { sets: 2, reps: 10, restSec: 30 })]),
    part("main", "straight", [
      ex("swing", { sets: 3, reps: 12, restSec: 60 }),
      ex("wallSit", { sets: 2, holdSec: 30, restSec: 30 }),
      ex("boxHop", { sets: 3, reps: 5, restSec: 30 }),
      ex("nordic", { sets: 2, reps: 6 }),
    ]),
    part("cooldown", "flow", [ex("ninetyNinety", { holdSec: 60, perSide: true })]),
  ],
  "develop",
);
// C. A recovery flow, mostly passive.
const FLOW = doc(
  [
    part("arrive", "flow", [ex("slowBreathing", { breaths: 10 })]),
    part("care", "flow", [ex("catCow", { holdSec: 30 }), ex("pigeon", { holdSec: 45, perSide: true })], { rounds: 2, restBetweenRoundsSec: 20 }),
    part("cooldown", "flow", [{ kind: "rest", seconds: 30 }]),
  ],
  "recover",
);

const ZERO = { isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 0, recoverySec: 0 };

describe("deriveDoc: easy run with strides and mobility", () => {
  const d = deriveDoc(EASY_RUN, LIB);
  it("adds the minutes up", () => {
    // 60 + 1800 + 4 x (20 + 40) + 2 x 50 = 2200 s = 36.7 min
    expect(d.estimatedMinutes).toBe(37);
  });
  it("counts run seconds as aerobic and mobility-purpose seconds as mobility; passive counts no contraction", () => {
    // aerobic 1800 + 4 x 20; mobility 60 + 2 x 50
    expect(d.balance).toEqual({ ...ZERO, aerobicSec: 1880, mobilitySec: 160 });
  });
  it("is a run, easy, consistent, with yoga second", () => {
    expect(d.discipline).toBe("run");
    expect(d.disciplines).toEqual(["run", "yoga"]);
    expect(d.category).toBe("easy");
    expect(d.mode).toBe("consistent");
  });
  it("exposes regions in sets and muscles at 1 / 0.5", () => {
    expect(d.regionExposure).toEqual({ "low-back": 1, hips: 1 });
    expect(d.muscleExposure).toEqual({ "erector-spinae": 1, "rectus-abdominis": 0.5, "deep-hip-rotators": 1, "glute-max": 0.5 });
  });
  it("lists equipment, condition maxima and watch steps", () => {
    expect(d.equipment).toEqual({ all: ["mat"], oneOf: [] });
    expect(d.conditionMax).toEqual({ tmj: { clench: 1, neckLoad: 0, faceDown: 0 } });
    // cat-cow 1, easy run 1, strides 4, pigeon 2 (per side); the rest is not a step
    expect(d.watchStepCount).toBe(8);
  });
});

describe("deriveDoc: activation, hinge, power, hip-opening lift", () => {
  const d = deriveDoc(LIFT, LIB);
  it("adds the minutes up", () => {
    // bridge 2 x 30 + 30 rest = 90; swing 3 x 24 + 120 = 192; wall sit 60 + 30 = 90; hops 3 x 5 + 60 = 75; nordic 2 x 24
    // + the 60 s a lift that names no rest is assumed to take = 108; 90/90 2 x 60 = 120; six items x 15 s transition = 90
    expect(d.estimatedMinutes).toBe(13); // 765 s
  });
  it("counts every contraction the record lists", () => {
    expect(d.balance).toEqual({ ...ZERO, isometricSec: 60, isotonicReps: 20 + 36 + 12, eccentricReps: 12, plyoContacts: 15, mobilitySec: 120 });
  });
  it("is strength, strength category, build mode", () => {
    expect(d.discipline).toBe("strength");
    expect(d.disciplines).toEqual(["strength", "yoga"]);
    expect(d.category).toBe("strength");
    expect(d.mode).toBe("build");
  });
  it("weights exposure by sets", () => {
    expect(d.regionExposure).toEqual({ glutes: 5, hamstrings: 5, quads: 5, hips: 1 });
    expect(d.muscleExposure).toEqual({ "glute-max": 5, hamstrings: 1 + 1.5 + 2, quads: 5, "deep-hip-rotators": 1 });
  });
  it("lists a one-of group once, takes condition maxima and counts steps", () => {
    expect(d.equipment).toEqual({ all: [], oneOf: [["dumbbells", "kettlebell"]] });
    expect(d.conditionMax).toEqual({ tmj: { clench: 2, neckLoad: 0, faceDown: 0 } });
    expect(d.watchStepCount).toBe(2 + 3 + 2 + 3 + 2 + 2);
  });
});

describe("deriveDoc: a passive-heavy recovery flow", () => {
  const d = deriveDoc(FLOW, LIB);
  it("books passive seconds as mobility or recovery time, never a contraction", () => {
    // breathing 10 x 6 s = 60 recovery; per round cat-cow 30 + pigeon 2 x 45; two rounds -> mobility 2 x (30 + 90) = 240
    expect(d.balance).toEqual({ ...ZERO, recoverySec: 60, mobilitySec: 240 });
  });
  it("adds the minutes: 60 + 240 + 20 between rounds + 30 rest + 5 plays x 15 s transition", () => {
    expect(d.estimatedMinutes).toBe(7); // 425 s
  });
  it("is yoga, recovery, with rounds multiplying the steps", () => {
    expect(d.discipline).toBe("yoga");
    expect(d.category).toBe("yoga");
    expect(d.mode).toBe("recovery");
    expect(d.watchStepCount).toBe(1 + 2 + 4);
    expect(d.muscleExposure).toEqual({ diaphragm: 1, "erector-spinae": 2, "rectus-abdominis": 1, "deep-hip-rotators": 2, "glute-max": 1 });
  });
});

describe("deriveDoc: categories", () => {
  const cat = (items: WorkoutItem[], effort: WorkoutDoc["intent"]["effort"] = "maintain") => deriveDoc(doc([part("run", "steady", items)], effort), LIB).category;
  it("reads run efforts", () => {
    expect(cat([run("tempo", { durationSec: 1200 })])).toBe("quality");
    expect(cat([run("hills", { durationSec: 600 })])).toBe("quality");
    expect(cat([run("race", { distanceM: 5000 })])).toBe("race");
    expect(cat([run("long", { durationSec: 5400 })])).toBe("long");
    expect(cat([run("easy", { durationSec: 74 * 60 })])).toBe("easy");
    expect(cat([run("easy", { durationSec: 75 * 60 })])).toBe("long");
    expect(cat([run("recovery", { durationSec: 1500 })])).toBe("recovery");
  });
  it("turns a distance into time at 6:00/km when no pace is given", () => {
    expect(deriveDoc(doc([part("run", "steady", [run("easy", { distanceM: 5000 })])]), LIB).balance.aerobicSec).toBe(1800);
  });
});

describe("deriveDoc: library resolution", () => {
  it("resolves legacy ids and still counts time for a move the library lacks", () => {
    const d = deriveDoc(doc([part("main", "straight", [ex("oldName", { reps: 10 }), ex("unknown", { sets: 2, reps: 10 }), { kind: "free_exercise", name: "x", dose: { holdSec: 30 } } as WorkoutItem])]), LIB);
    expect(d.balance.isotonicReps).toBe(10);
    expect(d.regionExposure).toEqual({ glutes: 1 });
    // 10 x 2 s + 2 x 10 x 3 s + 30 s = 110 s; the unknown move, two sets in main straight sets (a lift), rests an
    // assumed 60 s; three items x 15 s transition: 215 s
    expect(d.estimatedMinutes).toBe(4);
    expect(d.watchStepCount).toBe(4);
  });
  it("a free-text move in a main flow is yoga, in main straight sets strength (a mobility session's unknown moves are not lifting)", () => {
    const free: WorkoutItem = { kind: "free_exercise", name: "Ankle rocks", dose: { sets: 2, holdSec: 60 } };
    expect(deriveDoc(doc([part("main", "flow", [free])]), LIB).discipline).toBe("yoga");
    expect(deriveDoc(doc([part("main", "straight", [free])]), LIB).discipline).toBe("strength");
    expect(deriveDoc(doc([part("cooldown", "straight", [free])]), LIB).discipline).toBe("yoga");
    // Only the main part's flow is a mobility session's: a flow of power, accessory, conditioning or activation work is
    // still that work.
    for (const purpose of ["power", "accessory", "conditioning", "activation"] as const) {
      expect(deriveDoc(doc([part(purpose, "flow", [free])]), LIB).discipline, purpose).toBe("strength");
    }
  });
  it("converts mode and effort both ways", () => {
    expect(modeOfEffort("recover")).toBe("recovery");
    expect(modeOfEffort("maintain")).toBe("consistent");
    expect(modeOfEffort("develop")).toBe("build");
    expect(modeOfEffort("peak")).toBe("build");
    expect(effortOfMode("recovery")).toBe("recover");
    expect(effortOfMode("consistent")).toBe("maintain");
    expect(effortOfMode("build")).toBe("develop");
  });
});

const sets = (n: number, s: { reps?: number; seconds?: number }) => Array.from({ length: n }, () => ({ reps: s.reps ?? null, seconds: s.seconds ?? null, loadKg: null, done: true, flags: [] as string[] }));

describe("derivePerformed", () => {
  it("derives the same balance as the document when a session is done exactly as prescribed", () => {
    const p = derivePerformed(
      {
        entries: [
          { exerciseId: "bridge", perSide: false, sets: sets(2, { reps: 10 }) },
          { exerciseId: "swing", perSide: false, sets: sets(3, { reps: 12 }) },
          { exerciseId: "wallSit", perSide: false, sets: sets(2, { seconds: 30 }) },
          { exerciseId: "boxHop", perSide: false, sets: sets(3, { reps: 5 }) },
          { exerciseId: "nordic", perSide: false, sets: sets(2, { reps: 6 }) },
          { exerciseId: "ninetyNinety", perSide: true, sets: sets(1, { seconds: 60 }) },
        ],
        movesDone: [],
      },
      LIB,
    );
    expect(p.balance).toEqual(deriveDoc(LIFT, LIB).balance);
    expect(p.regionExposure).toEqual(deriveDoc(LIFT, LIB).regionExposure);
    expect(p.muscleExposure).toEqual(deriveDoc(LIFT, LIB).muscleExposure);
    expect(p.discipline).toBe("strength");
    expect(p.disciplines).toEqual(["strength", "yoga"]);
  });
  it("matches the recovery flow from timed moves", () => {
    const p = derivePerformed(
      { entries: [], movesDone: [{ exerciseId: "slowBreathing", seconds: 60 }, { exerciseId: "catCow", seconds: 30 }, { exerciseId: "pigeon", seconds: 90 }, { exerciseId: "catCow", seconds: 30 }, { exerciseId: "pigeon", seconds: 90 }] },
      LIB,
    );
    expect(p.balance).toEqual(deriveDoc(FLOW, LIB).balance);
    expect(p.discipline).toBe("yoga");
  });
  it("counts only the sets that were done, and an activity as aerobic work", () => {
    const p = derivePerformed(
      {
        entries: [{ exerciseId: "bridge", perSide: false, sets: [...sets(2, { reps: 10 }), { reps: 10, seconds: null, loadKg: null, done: false, flags: [] }] }],
        movesDone: [],
        activity: { sport: "run", durationSeconds: 1800, distanceMeters: 5000 },
      },
      LIB,
    );
    expect(p.balance).toEqual({ ...ZERO, isotonicReps: 20, aerobicSec: 1800 });
    expect(p.discipline).toBe("run");
    expect(p.estimatedMinutes).toBe(31); // 60 s of lifting + 1800 s
  });
});

describe("deriveDoc: rests a dose leaves out, and transitions (controller ruling 2026-10-10)", () => {
  const minutes = (parts: WorkoutPart[]) => deriveDoc(doc(parts), LIB).estimatedMinutes;
  it("a lift that names no rest rests 60 s between sets; any other move 20 s; a free-text move in a strength part is a lift", () => {
    // nordic (strength): 3 x 6 x 4 s = 72 + 2 x 60 + 15 = 207 s -> 3 min
    expect(minutes([part("main", "straight", [ex("nordic", { sets: 3, reps: 6 })])])).toBe(3);
    // the same with its own rest of 10 s: 72 + 20 + 15 = 107 s -> 2 min
    expect(minutes([part("main", "straight", [ex("nordic", { sets: 3, reps: 6, restSec: 10 })])])).toBe(2);
    // cat-cow (mobility): 3 x 60 + 2 x 20 + 15 = 235 s -> 4 min
    expect(minutes([part("warmup", "straight", [ex("catCow", { sets: 3, holdSec: 60 })])])).toBe(4);
    // bridge (activation) keeps its record's 30 s: 3 x 10 x 3 = 90 + 2 x 30 + 15 = 165 s -> 3 min
    expect(minutes([part("activation", "straight", [ex("bridge", { sets: 3, reps: 10 })])])).toBe(3);
    // free text, 4 x 50 s: in main straight sets a lift (3 x 60 rest) = 395 s -> 7; in a main flow not (3 x 20) = 275 s -> 5
    const free: WorkoutItem = { kind: "free_exercise", name: "x", dose: { sets: 4, holdSec: 50 } };
    expect(minutes([part("main", "straight", [free])])).toBe(7);
    expect(minutes([part("main", "flow", [free])])).toBe(5);
  });
  it("every play of an exercise item costs 15 s: rounds multiply it; runs and rest items have none", () => {
    // a circuit of two 40 s stations, 3 rounds: 6 x 40 + 6 x 15 = 330 s -> 6 min (one set each: no rest between sets)
    expect(minutes([part("main", "circuit", [ex("wallSit", { sets: 1, holdSec: 40 }), ex("catCow", { sets: 1, holdSec: 40 })], { rounds: 3 })])).toBe(6);
    // a run and a rest item: 600 + 60 s, no transition -> 11 min
    expect(minutes([part("run", "steady", [run("easy", { durationSec: 600 }), { kind: "rest", seconds: 60 }])])).toBe(11);
  });
});

describe("deriveDoc: a lift makes a strength session (controller ruling 2026-10-10)", () => {
  const d = (parts: WorkoutPart[]) => deriveDoc(doc(parts), LIB);
  const mobility = part("cooldown", "flow", [ex("ninetyNinety", { holdSec: 600, perSide: true })]);
  it("a main or power part holding a strength or power move is strength, however much mobility surrounds it", () => {
    const x = d([part("warmup", "flow", [ex("catCow", { holdSec: 300 })]), part("main", "straight", [ex("nordic", { sets: 2, reps: 5, restSec: 60 })]), mobility]);
    expect(x.discipline).toBe("strength");
    expect(x.disciplines).toEqual(["strength", "yoga"]);
    expect(x.category).toBe("strength");
    expect(d([part("power", "straight", [ex("boxHop", { sets: 2, reps: 5 })]), mobility]).discipline).toBe("strength");
  });
  it("the same move in an accessory part, or a main part of non-lifts, is weighed by seconds", () => {
    expect(d([part("accessory", "straight", [ex("nordic", { sets: 2, reps: 5, restSec: 60 })]), mobility]).discipline).toBe("yoga");
    expect(d([part("main", "straight", [ex("bridge", { sets: 2, reps: 10 })]), mobility]).discipline).toBe("yoga");
    expect(d([part("accessory", "straight", [ex("nordic", { sets: 6, reps: 8, restSec: 90 })])]).discipline).toBe("strength");
  });
  it("a run that is half the session stays a run, lift or not", () => {
    const x = d([part("main", "straight", [ex("nordic", { sets: 2, reps: 5, restSec: 60 })]), part("run", "steady", [run("easy", { durationSec: 1800 })])]);
    expect(x.discipline).toBe("run");
    expect(x.disciplines).toEqual(["run", "strength"]);
  });
  it("what was done: a done set of a lift makes it strength, however many minutes of mobility were done", () => {
    const p = derivePerformed(
      { entries: [{ exerciseId: "nordic", perSide: false, sets: sets(1, { reps: 5 }) }], movesDone: [{ exerciseId: "ninetyNinety", seconds: 1200 }] },
      LIB,
    );
    expect(p.discipline).toBe("strength");
    expect(p.disciplines).toEqual(["strength", "yoga"]);
  });
});

describe("deriveDoc: open runs and category breadth", () => {
  const d = (parts: WorkoutPart[]) => deriveDoc(doc(parts), LIB);
  it("counts an open run segment as 10 minutes of run", () => {
    const x = d([part("run", "steady", [run("easy", { open: true })])]);
    expect(x.estimatedMinutes).toBe(10);
    expect(x.discipline).toBe("run");
    expect(x.category).toBe("easy");
    expect(x.balance.aerobicSec).toBe(600);
    expect(d([part("run", "steady", [run("tempo", { open: true })])]).category).toBe("quality");
  });
  it("handles an open warm-up with intervals and a run with mobility", () => {
    const x = d([part("run", "steady", [run("easy", { open: true })]), part("run", "intervals", [run("interval", { durationSec: 120 })], { rounds: 4 })]);
    expect(x.estimatedMinutes).toBe(18);
    expect(x.category).toBe("quality");
    const y = d([part("run", "steady", [run("easy", { open: true })]), part("cooldown", "flow", [ex("ninetyNinety", { holdSec: 585 })])]);
    expect(y.discipline).toBe("run"); // 600 s of run against 585 s of mobility and its 15 s transition: run is half
  });
  it("keeps a strength session with a short tempo finisher strength", () => {
    const x = d([part("main", "straight", [ex("swing", { sets: 3, reps: 12, restSec: 60 }), ex("wallSit", { sets: 4, holdSec: 60, restSec: 60 })]), part("run", "steady", [run("tempo", { durationSec: 120 })])]);
    expect(x.discipline).toBe("strength");
    expect(x.category).toBe("strength");
  });
  it("calls a run-led tempo session quality, and a strength session with a large race-pace segment race", () => {
    expect(d([part("run", "steady", [run("easy", { durationSec: 600 }), run("tempo", { durationSec: 1200 })])]).category).toBe("quality");
    // Wall sits 4 x 60 s, an assumed 3 x 60 s rest, a 15 s transition: 435 s; 200 s at race pace is a quarter of 635 s.
    const x = d([part("main", "straight", [ex("wallSit", { sets: 4, holdSec: 60 })]), part("run", "steady", [run("race", { durationSec: 200 })])]);
    expect(x.discipline).toBe("strength");
    expect(x.category).toBe("race");
  });
  it("never counts strides as hard", () => {
    const x = d([part("main", "straight", [ex("wallSit", { sets: 4, holdSec: 60 })]), part("run", "steady", [run("strides", { durationSec: 120 })])]);
    expect(x.category).toBe("strength");
  });
});
