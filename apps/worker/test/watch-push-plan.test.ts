/**
 * A LOCKED BUILD'S STEPS AS THE WATCH WILL HOLD THEM (Phase 3 Task 4; spec §3,
 * §4.2; rulings 3-R1, 3-R5, 3-R6). Pure: the build in, the resolved watch steps
 * out — catalog steps where the athlete's catalog holds the move's T-code, free
 * text on `originId "0"` everywhere else — and the stamp the push will carry.
 * Synthetic builds, library move names only.
 */
import { describe, expect, it } from "vitest";
import { WATCH_MAX_STEPS, WATCH_NAME_MAX, WATCH_OVERVIEW_MAX, WATCH_STAMP_MAX, type Weight } from "@rg/domain";
import type { Step } from "@rg/session-engine";
import type { BuildPayload, ExerciseSlice } from "../src/services/session-build.js";
import { cutAtWord, programStamp, watchStepsFromBuild, type WatchPlanDeps } from "../src/services/watch-push.js";

const GOBLET_CATALOG_ID = "4258276155475001301";

/** A library slice with only what the watch reads: the name, the first focus cue and the laterality. */
const slice = (id: string, name: string, focus: string, laterality = "bilateral"): ExerciseSlice =>
  ({ id, name, laterality, text: { focus: [focus] } }) as unknown as ExerciseSlice;

const EXERCISES: Record<string, ExerciseSlice> = {
  gobletSquat: slice("gobletSquat", "Goblet squat", "Knees track over your toes."),
  chinTuck: slice("chinTuck", "Chin tuck hold", "Long neck, eyes level."),
  slRdl: slice("slRdl", "Single-leg Romanian deadlift with reach", "Hips stay square to the floor while the free leg reaches long behind you."),
  bandRow: slice("bandRow", "Band row", "Squeeze the shoulder blades."),
  sidePlank: slice("sidePlank", "Side plank", "Hips high.", "unilateral"),
  oneArmRow: slice("oneArmRow", "One-arm row", "The shoulder blade moves.", "unilateral"),
  splitSquat: slice("splitSquat", "Split squat hold", "Front shin stays tall.", "unilateral"),
  deadBug: slice("deadBug", "Dead bug", "Low back stays down.", "alternating"),
};

const step = (over: Partial<Step>): Step => ({
  kind: "set",
  slotKey: "s1",
  block: "strength" as Step["block"],
  exerciseId: "gobletSquat",
  side: null,
  setIndex: 0,
  setCount: 3,
  seconds: 40,
  prepGap: 0,
  target: null,
  format: { id: "straight" as Step["format"]["id"], group: null, round: null },
  why: [],
  isNew: false,
  log: true,
  ...over,
});
const rest = (seconds: number): Step => step({ kind: "rest", exerciseId: null, seconds, log: false, setIndex: null, setCount: null });

const build = (steps: Step[], exercises: Record<string, ExerciseSlice> = EXERCISES): BuildPayload =>
  ({ buildId: "b-1", version: 1, date: "2026-10-09", steps, exercises }) as unknown as BuildPayload;

/** The athlete's catalog holds Goblet Squat (T1301); the library maps gobletSquat → T1301 and sidePlank → T1185. */
const deps: WatchPlanDeps = {
  catalogIdByKey: new Map([["T1301", GOBLET_CATALOG_ID]]),
  keyOf: (id) => ({ gobletSquat: "T1301", sidePlank: "T1185" })[id] ?? null,
};

describe("watchStepsFromBuild — targets", () => {
  it("a timed step is a hold of its seconds", () => {
    const plan = watchStepsFromBuild(build([step({ kind: "timed", exerciseId: "chinTuck", seconds: 30 })]), deps);
    expect(plan.steps[0]!.target).toEqual({ kind: "hold", seconds: 30 });
  });

  it("a set with reps → reps; with seconds and no reps → hold; with neither → open", () => {
    const plan = watchStepsFromBuild(
      build([
        step({ target: { reps: 8 } }),
        step({ exerciseId: "bandRow", target: { secs: 45 } }),
        step({ exerciseId: "bandRow", target: null }),
      ]),
      deps,
    );
    expect(plan.steps.map((s) => s.target)).toEqual([{ kind: "reps", reps: 8 }, { kind: "hold", seconds: 45 }, { kind: "open" }]);
  });

  it("weight: 25 lb → 11340 g; no weight → bodyweight (null)", () => {
    const w: Weight = { v: 25, u: "lb" };
    const plan = watchStepsFromBuild(build([step({ target: { reps: 8, w } }), step({ exerciseId: "bandRow", target: { reps: 10 } })]), deps);
    expect(plan.steps.map((s) => s.grams)).toEqual([11_340, null]);
  });
});

describe("watchStepsFromBuild — sides, rests and names", () => {
  it("Left then Right → two steps, sides left/right, overviews naming the side", () => {
    const plan = watchStepsFromBuild(
      build([step({ kind: "timed", exerciseId: "sidePlank", side: "Left", seconds: 30 }), step({ kind: "timed", exerciseId: "sidePlank", side: "Right", seconds: 30 })]),
      deps,
    );
    expect(plan.steps.map((s) => s.side)).toEqual(["left", "right"]);
    expect(plan.steps[0]!.overview).toBe("left side · Hips high.");
    expect(plan.steps[1]!.overview).toBe("right side · Hips high.");
  });

  it("consecutive rests add onto the previous step (capped at 900); a leading rest is dropped", () => {
    const plan = watchStepsFromBuild(
      build([rest(60), step({ target: { reps: 8 } }), rest(60), rest(30), step({ exerciseId: "bandRow" }), rest(600), rest(600)]),
      deps,
    );
    expect(plan.steps.map((s) => s.restSeconds)).toEqual([90, 900]);
  });

  it("a move whose key the catalog holds → its catalog id and the T-code; otherwise free text with the library name", () => {
    const plan = watchStepsFromBuild(
      build([step({ target: { reps: 8 } }), step({ kind: "timed", exerciseId: "sidePlank", seconds: 30 }), step({ kind: "timed", exerciseId: "chinTuck", seconds: 30 })]),
      deps,
    );
    expect(plan.steps.map((s) => [s.originId, s.name])).toEqual([
      [GOBLET_CATALOG_ID, "T1301"],
      ["0", "Side plank"], // mapped (T1185), but the athlete's catalog lacks it
      ["0", "Chin tuck hold"], // unmapped
    ]);
    expect(plan.freeText).toBe(2);
  });

  it("a free-text name is cut to 30 characters at a whole word; the overview to 80", () => {
    const plan = watchStepsFromBuild(build([step({ exerciseId: "slRdl", side: "Left", target: { reps: 6 } })]), deps);
    const [s] = plan.steps;
    expect(s!.name).toBe("Single-leg Romanian deadlift");
    expect(s!.name.length).toBeLessThanOrEqual(WATCH_NAME_MAX);
    expect(s!.overview.length).toBeLessThanOrEqual(WATCH_OVERVIEW_MAX);
    expect(s!.overview).toBe("left side · Hips stay square to the floor while the free leg reaches long behind");
    expect(s!.overview.startsWith("left side · ")).toBe(true);
  });

  it("skips steps with no move or a move the build does not carry", () => {
    const plan = watchStepsFromBuild(build([step({ exerciseId: null }), step({ exerciseId: "ghost" }), step({ target: { reps: 5 } })]), deps);
    expect(plan.steps).toHaveLength(1);
  });
});

describe("watchStepsFromBuild — a one-sided set is a Left/Right pair (audit W-1)", () => {
  // The engine prices a unilateral set as both sides (`setSeconds` × 2) and the player says "8 each side"; only a
  // timed window carries its side. One watch step would prescribe half the work — the coach lane's lesson (d52833e).
  it("a unilateral move's set with no side → left then right: same move, target and weight; the rest on the right", () => {
    const plan = watchStepsFromBuild(build([step({ exerciseId: "oneArmRow", target: { reps: 8, w: { v: 25, u: "lb" } } }), rest(75)]), deps);
    const pair = { originId: "0", name: "One-arm row", target: { kind: "reps", reps: 8 }, grams: 11_340 };
    expect(plan.steps).toEqual([
      { ...pair, restSeconds: 0, overview: "left side · The shoulder blade moves.", side: "left" },
      { ...pair, restSeconds: 75, overview: "right side · The shoulder blade moves.", side: "right" },
    ]);
  });

  it("a bodyweight one-sided hold set is a pair too; a catalog move keeps its catalog id on both", () => {
    const plan = watchStepsFromBuild(
      build([step({ exerciseId: "splitSquat", target: { secs: 30 } }), step({ exerciseId: "sidePlank", target: { reps: 5 } })]),
      { ...deps, catalogIdByKey: new Map([["T1185", "4258276155475001185"]]) },
    );
    expect(plan.steps.map((s) => [s.name, s.side, s.target, s.grams])).toEqual([
      ["Split squat hold", "left", { kind: "hold", seconds: 30 }, null],
      ["Split squat hold", "right", { kind: "hold", seconds: 30 }, null],
      ["T1185", "left", { kind: "reps", reps: 5 }, null],
      ["T1185", "right", { kind: "reps", reps: 5 }, null],
    ]);
    expect(plan.steps.slice(2).every((s) => s.originId === "4258276155475001185")).toBe(true);
  });

  it("stays one step: an alternating or bilateral move's set, a set that names its side, a timed window", () => {
    const plan = watchStepsFromBuild(
      build([
        step({ exerciseId: "deadBug", target: { reps: 10 } }),
        step({ target: { reps: 8 } }),
        step({ exerciseId: "oneArmRow", side: "Left", target: { reps: 8 } }),
        step({ kind: "timed", exerciseId: "sidePlank", side: "Right", seconds: 30 }),
      ]),
      deps,
    );
    expect(plan.steps.map((s) => s.side)).toEqual([null, null, "left", "right"]);
  });

  it("the pair counts as two steps toward the watch's limit", () => {
    const sets = (n: number) => Array.from({ length: n }, () => step({ exerciseId: "oneArmRow", target: { reps: 8 } }));
    expect(watchStepsFromBuild(build(sets(WATCH_MAX_STEPS / 2)), deps).steps).toHaveLength(WATCH_MAX_STEPS);
    expect(watchStepsFromBuild(build(sets(WATCH_MAX_STEPS / 2)), deps).refusal).toBeNull();
    expect(watchStepsFromBuild(build(sets(WATCH_MAX_STEPS / 2 + 1)), deps).refusal).toBe("too_long");
  });
});

describe("watchStepsFromBuild — refusals and determinism", () => {
  it("more than 200 work steps → too_long; none → empty", () => {
    const many = Array.from({ length: WATCH_MAX_STEPS + 1 }, () => step({ target: { reps: 5 } }));
    expect(watchStepsFromBuild(build(many), deps).refusal).toBe("too_long");
    expect(watchStepsFromBuild(build(many.slice(1)), deps).refusal).toBeNull();
    expect(watchStepsFromBuild(build([rest(60)]), deps).refusal).toBe("empty");
    expect(watchStepsFromBuild(build([]), deps).refusal).toBe("empty");
  });

  it("the same build twice gives the same steps", () => {
    const b = build([step({ target: { reps: 8, w: { v: 12, u: "kg" } } }), rest(90), step({ kind: "timed", exerciseId: "chinTuck", seconds: 30 })]);
    expect(watchStepsFromBuild(b, deps)).toEqual(watchStepsFromBuild(structuredClone(b), deps));
  });
});

describe("programStamp", () => {
  it("is the program name and the date", () => {
    expect(programStamp("Strength program", "2026-10-09", new Set())).toBe("Strength program — 2026-10-09");
  });

  it("cuts a long name so the stamp is at most 36 characters, keeping the separator and the date", () => {
    const name = "Strength and conditioning for the hills"; // 39 characters
    const stamp = programStamp(name, "2026-10-09", new Set());
    expect(stamp.length).toBeLessThanOrEqual(WATCH_STAMP_MAX);
    expect(stamp.endsWith(" — 2026-10-09")).toBe(true);
    expect(name.startsWith(stamp.slice(0, -" — 2026-10-09".length))).toBe(true);
  });

  it("adds (2), then (3), while the stamp is taken — still at most 36 characters", () => {
    const base = programStamp("Strength program", "2026-10-09", new Set());
    expect(programStamp("Strength program", "2026-10-09", new Set([base]))).toBe("Strength program — 2026-10-09 (2)");
    expect(programStamp("Strength program", "2026-10-09", new Set([base, `${base} (2)`]))).toBe("Strength program — 2026-10-09 (3)");
    const long = "Strength and conditioning for the hills";
    const first = programStamp(long, "2026-10-09", new Set());
    const second = programStamp(long, "2026-10-09", new Set([first]));
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(WATCH_STAMP_MAX);
    expect(second.endsWith(" — 2026-10-09 (2)")).toBe(true);
  });
});

describe("cuts never leave half a character (audit W-3, lane L-6, lane U-4)", () => {
  /** A lone surrogate does not survive UTF-8: what COROS would store is not what the read-back looks for. */
  const wellFormed = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  /** The spike's stamp, "RG SPIKE — SAFE TO DELETE 2026-10-04": 36 characters, 38 UTF-8 bytes (the em dash is 3). */
  const PROVEN_STAMP_BYTES = 38;
  const FAMILY = "👨‍👩‍👧"; // one character on screen: three emoji joined by two zero-width joiners

  it("a stamp cut inside a run of emoji keeps whole emoji: at most 36 characters and 38 UTF-8 bytes", () => {
    for (const name of ["💪".repeat(16), `Strength${"💪".repeat(10)}`, `S${"💪".repeat(12)}`]) {
      for (const taken of [new Set<string>(), new Set([programStamp(name, "2026-10-09", new Set())])]) {
        const stamp = programStamp(name, "2026-10-09", taken);
        expect(wellFormed(stamp), stamp).toBe(true);
        expect(stamp.length).toBeLessThanOrEqual(WATCH_STAMP_MAX);
        expect(bytes(stamp), stamp).toBeLessThanOrEqual(PROVEN_STAMP_BYTES);
        expect(stamp).toMatch(/^(Strength|S)?(💪)+ — 2026-10-09( \(2\))?$/u);
      }
    }
  });

  it("a stamp of a name in accented letters stays within the proven 38 bytes; a plain ASCII one is cut as before", () => {
    const stamp = programStamp("Entraînement général à la maison", "2026-10-09", new Set());
    expect(bytes(stamp)).toBeLessThanOrEqual(PROVEN_STAMP_BYTES);
    expect(stamp).toBe("Entraînement général — 2026-10-09");
    expect(programStamp("Strength and conditioning for the hills", "2026-10-09", new Set())).toBe("Strength and — 2026-10-09");
    const word = "Supercalifragilisticexpialidocious";
    expect(programStamp(word, "2026-10-09", new Set())).toBe("Supercalifragilisticexp — 2026-10-09");
    expect(programStamp(word, "2026-10-09", new Set(["Supercalifragilisticexp — 2026-10-09"]))).toBe("Supercalifragilisti — 2026-10-09 (2)");
  });

  it("a joined emoji is one character: the cut keeps it whole or drops it, never a dangling joiner", () => {
    expect(programStamp(FAMILY.repeat(5), "2026-10-09", new Set())).toBe(`${FAMILY} — 2026-10-09`);
    expect(cutAtWord(FAMILY.repeat(4), 20)).toBe(FAMILY.repeat(2)); // 8 UTF-16 units each
    expect(cutAtWord(`Row ${FAMILY.repeat(4)}`, 20)).toBe("Row"); // one word too long: cut back to the word before
  });

  it("a step name or overview cut inside an emoji is whole emoji only", () => {
    const name = cutAtWord(`Kettlebell${"😀".repeat(20)}`, WATCH_NAME_MAX);
    expect(wellFormed(name)).toBe(true);
    expect(name).toBe(`Kettlebell${"😀".repeat(10)}`);
    const emoji: Record<string, ExerciseSlice> = { e: slice("e", `Swing${"🔥".repeat(20)}`, `Hips${"🔥".repeat(60)}`) };
    const [s] = watchStepsFromBuild(build([step({ exerciseId: "e", target: { reps: 5 } })], emoji), deps).steps;
    expect(wellFormed(s!.name) && wellFormed(s!.overview)).toBe(true);
    expect(s!.name.length).toBeLessThanOrEqual(WATCH_NAME_MAX);
    expect(s!.overview.length).toBeLessThanOrEqual(WATCH_OVERVIEW_MAX);
  });
});
