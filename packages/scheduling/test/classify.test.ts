import { describe, expect, it } from "vitest";
import { classifyWorkout } from "../src/classify.js";
import type { PlannedStage } from "@rg/domain";

const stage = (p: Partial<PlannedStage> & { id: string; order: number }): PlannedStage => ({
  kind: "work",
  durationType: "time",
  ...p,
});

describe("classifyWorkout", () => {
  it("classifies rest, race, recovery, long from titles", () => {
    expect(classifyWorkout({ title: "Rest" }).category).toBe("rest");
    expect(classifyWorkout({ title: "10K Race" }).category).toBe("race");
    expect(classifyWorkout({ title: "Recovery Run" }).category).toBe("recovery");
    expect(classifyWorkout({ title: "Long Run" }).category).toBe("long");
  });

  it("prefers structure over title for quality", () => {
    const c = classifyWorkout({
      title: "Tuesday Session",
      stages: [
        stage({ id: "w", order: 1, kind: "warmup", durationSeconds: 900 }),
        stage({ id: "r", order: 2, kind: "repeat", repeatCount: 5, durationType: "none" }),
        stage({ id: "work", order: 1, parentStageId: "r", durationSeconds: 300, paceZone: 4 }),
        stage({ id: "rec", order: 2, parentStageId: "r", kind: "recovery", durationSeconds: 120 }),
        stage({ id: "c", order: 3, kind: "cooldown", durationSeconds: 600 }),
      ],
    });
    expect(c.category).toBe("quality");
    expect(c.basis).toBe("structure");
    expect(c.qualitySubtype).toBe("threshold"); // 5-min bouts
  });

  it("detects vo2 from short hard bouts", () => {
    const c = classifyWorkout({
      title: "Workout",
      stages: [
        stage({ id: "r", order: 1, kind: "repeat", repeatCount: 8, durationType: "none" }),
        stage({ id: "work", order: 1, parentStageId: "r", durationSeconds: 120, hrZone: 5 }),
        stage({ id: "rec", order: 2, parentStageId: "r", kind: "recovery", durationSeconds: 120 }),
      ],
    });
    expect(c.qualitySubtype).toBe("vo2");
  });

  it("classifies long by duration even without the word", () => {
    expect(classifyWorkout({ title: "Sunday Run", plannedDurationSeconds: 6600 }).category).toBe("long");
    expect(classifyWorkout({ title: "Sunday Run", plannedDistanceMeters: 18_000 }).category).toBe("long");
  });

  it("classifies threshold/tempo/hills/intervals from title", () => {
    expect(classifyWorkout({ title: "Threshold 3x10" }).qualitySubtype).toBe("threshold");
    expect(classifyWorkout({ title: "Tempo Run" }).qualitySubtype).toBe("tempo");
    expect(classifyWorkout({ title: "Hill Repeats" }).qualitySubtype).toBe("hills");
    expect(classifyWorkout({ title: "6 x 800m" }).qualitySubtype).toBe("intervals");
  });

  it("handles cross-training and strength sports", () => {
    expect(classifyWorkout({ title: "Spin", sport: "bike" }).category).toBe("cross_training");
    expect(classifyWorkout({ title: "Core", sport: "strength" }).category).toBe("strength");
  });

  it("falls back to easy for plain runs and unknown for empty", () => {
    expect(classifyWorkout({ title: "Morning Run", plannedDurationSeconds: 3000 }).category).toBe("easy");
    expect(classifyWorkout({ title: "???" }).category).toBe("unknown");
  });
});
