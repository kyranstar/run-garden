import { describe, expect, it } from "vitest";
import type { PlannedStage } from "@rg/domain";
import { computeExecution } from "../src/execution.js";
import { mkLap, mkStage, mkWorkout } from "./builders.js";

function intervalStages(repeatCount = 4, target?: { low: number; high: number }): PlannedStage[] {
  return [
    mkStage({ id: "wu", order: 0, kind: "warmup", durationSeconds: 600 }),
    mkStage({ id: "rep", order: 1, kind: "repeat", repeatCount, durationType: "none" }),
    mkStage({
      id: "work",
      order: 0,
      parentStageId: "rep",
      kind: "work",
      durationSeconds: 300,
      ...(target ? { targetType: "pace" as const, targetLow: target.low, targetHigh: target.high } : {}),
    }),
    mkStage({ id: "rec", order: 1, parentStageId: "rep", kind: "recovery", durationSeconds: 120 }),
    mkStage({ id: "cd", order: 2, kind: "cooldown", durationSeconds: 600 }),
  ];
}

function lapsWithWorkPaces(workPaces: number[]) {
  const laps = [mkLap("act", 0, { avgPaceSecPerKm: 360 })];
  workPaces.forEach((pace, i) => laps.push(mkLap("act", i + 1, { avgPaceSecPerKm: pace })));
  laps.push(mkLap("act", workPaces.length + 1, { avgPaceSecPerKm: 370 }));
  return laps;
}

describe("computeExecution", () => {
  it("scores even intervals with a low coefficient of variation", () => {
    const workout = mkWorkout({ id: "w", stages: intervalStages(4, { low: 240, high: 255 }) });
    const result = computeExecution({ workout, laps: lapsWithWorkPaces([245, 247, 246, 248]) });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.plannedWorkIntervals).toBe(4);
    expect(result.value.workLapCount).toBe(4);
    expect(result.value.partial).toBe(false);
    expect(result.value.stagesCompleted).toBe(true);
    expect(result.value.intervalConsistencyCvPct).toBeLessThan(1);
    expect(result.value.targetAdherence).toBe(1);
    expect(result.value.controlled).toBe(true);
  });

  it("never rewards exceeding targets: a faster-than-prescribed lap is NOT adherent", () => {
    const workout = mkWorkout({ id: "w", stages: intervalStages(4, { low: 240, high: 255 }) });
    // 230 s/km is faster than 240 * 0.97 = 232.8 -> outside the band on the fast side
    const result = computeExecution({ workout, laps: lapsWithWorkPaces([230, 245, 246, 247]) });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.fasterThanPrescribed).toBe(1);
    expect(result.value.targetAdherence).toBe(0.75);
    expect(result.comparisonNote).toContain("faster than prescribed");
  });

  it("marks the set uncontrolled when the last work lap fades more than 5%", () => {
    const workout = mkWorkout({ id: "w", stages: intervalStages(4) });
    // median work pace 240; last chronological work lap 270 > 240 * 1.05
    const result = computeExecution({ workout, laps: lapsWithWorkPaces([240, 240, 240, 270]) });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.controlled).toBe(false);
  });

  it("returns a partial read when fewer paced laps exist than planned intervals", () => {
    const workout = mkWorkout({ id: "w", stages: intervalStages(4) });
    const result = computeExecution({
      workout,
      laps: [240, 241, 242].map((pace, i) => mkLap("act", i, { avgPaceSecPerKm: pace })),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.partial).toBe(true);
    expect(result.value.workLapCount).toBe(3);
    expect(result.value.stagesCompleted).toBe(false);
  });

  it("expands nested repeats when counting planned work intervals", () => {
    const workout = mkWorkout({
      id: "w",
      stages: [
        mkStage({ id: "outer", order: 0, kind: "repeat", repeatCount: 2, durationType: "none" }),
        mkStage({ id: "inner", order: 0, parentStageId: "outer", kind: "repeat", repeatCount: 3, durationType: "none" }),
        mkStage({ id: "work", order: 0, parentStageId: "inner", kind: "work", durationSeconds: 60 }),
      ],
    });
    const laps = Array.from({ length: 6 }, (_, i) => mkLap("act", i, { avgPaceSecPerKm: 250 + i }));
    const result = computeExecution({ workout, laps });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.plannedWorkIntervals).toBe(6);
  });

  it("suppresses when the workout has no work stages or no laps", () => {
    const restish = mkWorkout({ id: "w", stages: [mkStage({ id: "open", order: 0, kind: "open" })] });
    expect(computeExecution({ workout: restish, laps: [mkLap("a", 0)] }).status).toBe(
      "insufficient_data",
    );
    const structured = mkWorkout({ id: "w2", stages: intervalStages(4) });
    expect(computeExecution({ workout: structured, laps: [] }).status).toBe("insufficient_data");
  });
});
