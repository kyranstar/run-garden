/**
 * A MOVE'S TWO SIDES, THROUGH THE DOCUMENT (the 2026-11-05 audit). A one-sided move plays a Left and a Right window; an
 * alternating move plays one window that holds both sides, already timed for them, never labelled by side.
 */
import { describe, expect, it } from "vitest";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { playerStepsFromDoc, validateWorkoutDoc } from "../src/index.js";
import { doseFor } from "../src/editor.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const holds = (libraryId: string, dose: Record<string, unknown>): WorkoutDoc =>
  workoutDocSchema.parse({
    version: 1,
    title: "Sides",
    intent: { summary: "Both sides.", goals: ["mobility"], focus: [], effort: "maintain" },
    parts: [{ purpose: "cooldown", format: "holds", items: [{ kind: "exercise", libraryId, dose }] }],
    source: { kind: "studio" },
  });
const worked = (doc: WorkoutDoc) => playerStepsFromDoc(doc, EXERCISES).filter((s) => s.kind !== "rest");

describe("doseFor: the dose a library move starts with", () => {
  it("a one-sided move is per side, on a clock or counted, including the owner's example", () => {
    expect(doseFor(rec("wallRotation"), "warmup").perSide).toBe(true);
    expect(doseFor(rec("figureFour"), "cooldown").perSide).toBe(true);
  });

  it("an alternating move is per side when counted; on a clock its one window holds both sides", () => {
    expect(doseFor(rec("deadBug"), "main").perSide).toBe(true);
    expect(doseFor(rec("thoracicFlow"), "warmup").perSide).toBeUndefined();
    expect(doseFor(rec("wallSitSingleLegShift"), "main").perSide).toBeUndefined();
  });

  it("a symmetric move has no sides", () => {
    expect(doseFor(rec("catCow"), "warmup").perSide).toBeUndefined();
  });
});

describe("a saved workout that names a retired move", () => {
  const doc = workoutDocSchema.parse({
    version: 1,
    title: "Posterior chain",
    intent: { summary: "Saved before the audit.", goals: ["strength"], focus: [], effort: "maintain" },
    parts: [
      { purpose: "warmup", format: "straight", items: [{ kind: "exercise", libraryId: "wallHipTurns", dose: { sets: 1, reps: 6, perSide: true }, cue: "Turn from the hip, not the low back." }] },
      { purpose: "cooldown", format: "holds", items: [{ kind: "exercise", libraryId: "lowLungeBlock", dose: { holdSec: 50, perSide: true } }] },
    ],
    source: { kind: "coach" },
  });

  it("plays its survivor, on both sides, with the coach's own dose and cue", () => {
    const steps = worked(doc);
    expect(steps.filter((s) => s.slotKey.startsWith("prep")).map((s) => s.exerciseId)).toEqual(["hip9090"]);
    expect(steps.filter((s) => s.block === "cooldown").map((s) => [s.exerciseId, s.side, s.seconds])).toEqual([
      ["lowLunge", "Left", 50],
      ["lowLunge", "Right", 50],
    ]);
    expect(steps[0]).toMatchObject({ kind: "set", target: { reps: 6 } });
  });

  it("isn't refused: the document validator only offers the current id", () => {
    const issues = validateWorkoutDoc(doc, { library: EXERCISES, activeProfiles: [], excluded: [] });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.filter((i) => i.code === "legacy_id").map((i) => i.fix)).toEqual(["hip9090", "lowLunge"]);
  });
});

describe("playing a held part", () => {
  it("a one-sided move plays a Left and a Right window", () => {
    expect(worked(holds("figureFour", { holdSec: 30, perSide: true })).map((s) => s.side)).toEqual(["Left", "Right"]);
  });

  it("an alternating move plays one window, unlabelled, timed for both sides", () => {
    const steps = worked(holds("neckRotations", { reps: 5, perSide: true }));
    expect(steps.map((s) => s.side)).toEqual([null]);
    // Five each way at six seconds a rep: one window of a minute, not a minute a side.
    expect(steps[0]!.seconds).toBe(60);
  });
});
