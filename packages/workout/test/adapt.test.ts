/**
 * ADAPTERS OUT (programme spec §3.3): the document back to the calendar's stages and to the player's steps. The player's
 * steps are the document's steps (principles §3.2, one builder per output): for 50 seeded engine builds, the steps the
 * document plays are the steps the build plays — order, moves, sides, sets, seconds, reps, weights, rests, formats and
 * reasons.
 */
import { describe, expect, it } from "vitest";
import { workoutDocSchema, type PlannedStage, type WorkoutDoc } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import type { Step } from "@rg/session-engine";
import { docFromBuild, playerStepsFromDoc, stagesFromDoc } from "../src/index.js";
import { LIBRARY, seededBuilds, stored } from "./seeded-builds.js";

/** What a step plays: everything but its slot key (the document numbers slots by play order) and the new-move flag. */
function played(s: Step) {
  return {
    kind: s.kind, block: s.block, exerciseId: s.exerciseId, side: s.side, setIndex: s.setIndex, setCount: s.setCount,
    seconds: s.seconds, prepGap: s.prepGap, log: s.log, format: s.format, why: s.why,
    target: s.target === null ? null : { reps: s.target.reps ?? null, w: s.target.w ?? null, ...(s.kind === "set" ? { secs: s.target.secs ?? null } : {}) },
  };
}

describe("playerStepsFromDoc(docFromBuild(b)) is the build's own steps — 50 seeded builds", () => {
  const builds = seededBuilds(50);

  it("every build, step for step", () => {
    for (const { label, plan } of builds) {
      const doc = docFromBuild(stored(plan));
      expect(workoutDocSchema.safeParse(doc).success, label).toBe(true);
      expect(playerStepsFromDoc(doc, LIBRARY).map(played), label).toEqual(plan.steps.map(played));
    }
  });

  it("the builds cover every format, both sides, swaps, loads in both units, and rests", () => {
    const steps = builds.flatMap((b) => b.plan.steps);
    expect(new Set(steps.map((s) => s.format.id))).toEqual(new Set(["straight", "superset", "circuit", "ladder", "flow", "holds"]));
    expect(steps.some((s) => s.side === "Left")).toBe(true);
    expect(steps.some((s) => s.kind === "rest")).toBe(true);
    expect(new Set(steps.flatMap((s) => (s.target?.w ? [s.target.w.u] : [])))).toEqual(new Set(["lb", "kg"]));
    expect(builds.some((b) => b.label.includes("swap"))).toBe(true);
  });

  it("a slot's steps keep play order slot keys within each block", () => {
    const { plan } = builds[0]!;
    const steps = playerStepsFromDoc(docFromBuild(stored(plan)), LIBRARY);
    const work = steps.filter((s) => s.kind !== "rest");
    for (const s of work) expect(s.slotKey.startsWith(`${s.block}:`)).toBe(true);
  });
});

// ── Any document, not only an engine build ────────────────────────────────────────────────────────────────────────

const rec = (over: Partial<ExerciseRecord> & { id: string }): ExerciseRecord =>
  ({
    legacyIds: [], name: over.id, family: over.id, patterns: [], regions: [], roles: [], equipment: { all: [], oneOf: [] },
    position: "standing", laterality: "bilateral", load: "external", dose: { type: "reps", range: [8, 12], restSec: 60 }, difficulty: 2,
    easier: [], harder: [], tags: [], contraction: ["isotonic"], muscles: { primary: [], secondary: [] }, purposes: ["strength"], themes: [],
    text: { summary: "", setup: [], steps: [], focus: ["Focus."], mistakes: [], breathing: "", why: "", conditions: {} }, conditions: {},
    ...over,
  }) as ExerciseRecord;

const LIB: ExerciseRecord[] = [
  rec({ id: "gobletSquat", name: "Goblet squat", legacyIds: ["kbGobletSquat"] }),
  rec({ id: "sidePlank", name: "Side plank", laterality: "unilateral", load: "bodyweight", dose: { type: "time", range: [20, 40] } }),
];

const doc = (parts: WorkoutDoc["parts"]): WorkoutDoc =>
  workoutDocSchema.parse({ version: 1, title: "T", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, parts, source: { kind: "coach" } });

describe("playerStepsFromDoc — any document", () => {
  it("a legacy id plays as the move it now is (Review Focus 1)", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "straight", items: [
      { kind: "exercise", libraryId: "kbGobletSquat", dose: { sets: 2, reps: 8, load: { typed: "35 lb", kg: 15.88 }, restSec: 90 } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.seconds])).toEqual([["set", "gobletSquat", 8 * 3 + 10], ["rest", null, 90], ["set", "gobletSquat", 34]]);
    // Review Focus 3: the weight comes back as typed.
    expect(steps[0]!.target).toMatchObject({ reps: 8, w: { v: 35, u: "lb" } });
  });

  it("a per-side hold plays a left and a right window; a free-text move and a run segment play with no move id", () => {
    const steps = playerStepsFromDoc(doc([
      { purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "sidePlank", dose: { sets: 1, holdSec: 30, perSide: true, load: "bodyweight" } },
        { kind: "free_exercise", name: "Copenhagen plank", dose: { sets: 1, holdSec: 20 } },
      ] },
      { purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 600 }, effort: "easy" }] },
    ]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.side, s.seconds])).toEqual([
      ["timed", "sidePlank", "Left", 30], ["timed", "sidePlank", "Right", 30], ["rest", null, null, 60],
      ["timed", null, null, 20],
      ["timed", null, null, 600],
    ]);
  });

  it("a superset plays round by round, resting the part's rest between rounds", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "superset", rounds: 2, restBetweenRoundsSec: 75, items: [
      { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 8, load: { typed: "16 kg", kg: 16 } } },
      { kind: "free_exercise", name: "Push-up", dose: { sets: 1, reps: 10, load: "bodyweight" } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.format.group, s.setIndex, s.seconds])).toEqual([
      ["set", "gobletSquat", "A", 0, 34], ["set", null, "B", 0, 40], ["rest", null, null, null, 75],
      ["set", "gobletSquat", "A", 1, 34], ["set", null, "B", 1, 40],
    ]);
  });

  it("a circuit plays its stations round by round with the document's rests", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "circuit", rounds: 2, restBetweenRoundsSec: 45, items: [
      { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, holdSec: 40 } },
      { kind: "rest", seconds: 15 },
      { kind: "free_exercise", name: "Plank", dose: { sets: 1, holdSec: 40 } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.seconds, s.format.round])).toEqual([
      ["timed", 40, 1], ["rest", 15, null], ["timed", 40, 1], ["rest", 45, null],
      ["timed", 40, 2], ["rest", 15, null], ["timed", 40, 2],
    ]);
  });
});

describe("stagesFromDoc — any document", () => {
  it("an engine build's document as stages: sets as repeats, holds as time, reps, loads and rests", () => {
    const { plan } = seededBuilds(2)[1]!;
    const stages = stagesFromDoc(docFromBuild(stored(plan)), LIBRARY);
    const top = stages.filter((s) => !s.parentStageId);
    expect(top.length).toBeGreaterThan(0);
    for (const s of stages) {
      if (s.kind === "repeat") expect(s.repeatCount).toBeGreaterThanOrEqual(1);
      if (s.parentStageId) expect(stages.some((p) => p.id === s.parentStageId && p.kind === "repeat")).toBe(true);
    }
    expect(stages.some((s) => s.reps !== undefined || s.durationType === "time")).toBe(true);
  });

  it("a legacy id comes back under the library's own name; per-side and a slow lowering ride the note", () => {
    const stages = stagesFromDoc(doc([{ purpose: "main", format: "straight", items: [
      { kind: "exercise", libraryId: "kbGobletSquat", dose: { sets: 3, reps: 8, perSide: true, tempo: { eccentricSec: 4 }, load: { typed: "35 lb", kg: 15.88 }, restSec: 90 }, cue: "chest tall" },
      { kind: "free_exercise", name: "Wall sit", dose: { holdSec: 45, load: "bodyweight" } },
    ] }]), LIB);
    const [repeat, goblet, wallSit] = stages as [PlannedStage, PlannedStage, PlannedStage];
    expect(repeat).toMatchObject({ kind: "repeat", repeatCount: 3 });
    expect(goblet).toMatchObject({
      parentStageId: repeat.id, kind: "work", label: "Goblet squat", durationType: "none", reps: 8, loadKg: 15.88, restSeconds: 90,
      note: "4s down · each side · chest tall",
    });
    expect(wallSit).toMatchObject({ parentStageId: null, label: "Wall sit", durationType: "time", durationSeconds: 45, loadBodyweight: true });
  });
});
