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
import { programStamp, watchStepsFromBuild, type WatchPlanDeps } from "../src/services/watch-push.js";

const GOBLET_CATALOG_ID = "4258276155475001301";

/** A library slice with only what the watch reads: the name and the first focus cue. */
const slice = (id: string, name: string, focus: string): ExerciseSlice =>
  ({ id, name, text: { focus: [focus] } }) as unknown as ExerciseSlice;

const EXERCISES: Record<string, ExerciseSlice> = {
  gobletSquat: slice("gobletSquat", "Goblet squat", "Knees track over your toes."),
  chinTuck: slice("chinTuck", "Chin tuck hold", "Long neck, eyes level."),
  slRdl: slice("slRdl", "Single-leg Romanian deadlift with reach", "Hips stay square to the floor while the free leg reaches long behind you."),
  bandRow: slice("bandRow", "Band row", "Squeeze the shoulder blades."),
  sidePlank: slice("sidePlank", "Side plank", "Hips high."),
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
