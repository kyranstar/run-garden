import { describe, expect, it } from "vitest";
import type { PlannedStage } from "@rg/domain";
import { estimateDuration } from "../src/estimate.js";
import { deriveWorkoutSeconds, flattenStages, summarizeStages } from "../src/stages.js";

const paceContext = { defaultPaceSecPerKm: 390 };

const thresholdStages: PlannedStage[] = [
  { id: "w", order: 1, kind: "warmup", durationType: "time", durationSeconds: 900 },
  { id: "r", order: 2, kind: "repeat", repeatCount: 5, durationType: "none" },
  { id: "work", order: 1, parentStageId: "r", kind: "work", durationType: "time", durationSeconds: 300 },
  { id: "rec", order: 2, parentStageId: "r", kind: "recovery", durationType: "time", durationSeconds: 120 },
  { id: "c", order: 3, kind: "cooldown", durationType: "time", durationSeconds: 600 },
];

describe("stage flattening", () => {
  it("expands repeats", () => {
    const flat = flattenStages(thresholdStages);
    // warmup + 5*(work+recovery) + cooldown = 12 leaf stages
    expect(flat).toHaveLength(12);
  });

  it("expands nested repeats", () => {
    const stages: PlannedStage[] = [
      { id: "outer", order: 1, kind: "repeat", repeatCount: 2, durationType: "none" },
      { id: "inner", order: 1, parentStageId: "outer", kind: "repeat", repeatCount: 3, durationType: "none" },
      { id: "work", order: 1, parentStageId: "inner", kind: "work", durationType: "time", durationSeconds: 60 },
      { id: "rest", order: 2, parentStageId: "outer", kind: "rest", durationType: "time", durationSeconds: 180 },
    ];
    const d = deriveWorkoutSeconds(stages, paceContext);
    // 2 * (3*60 + 180) = 720
    expect(d.seconds).toBe(720);
  });

  it("derives time+recovery sums exactly with no assumptions", () => {
    const d = deriveWorkoutSeconds(thresholdStages, paceContext);
    expect(d.seconds).toBe(900 + 5 * (300 + 120) + 600); // 3600
    expect(d.assumptions).toHaveLength(0);
  });

  it("uses pace targets for distance stages", () => {
    const stages: PlannedStage[] = [
      {
        id: "a",
        order: 1,
        kind: "work",
        durationType: "distance",
        distanceMeters: 10_000,
        targetType: "pace",
        targetLow: 330,
        targetHigh: 350,
      },
    ];
    const d = deriveWorkoutSeconds(stages, paceContext);
    expect(d.seconds).toBe(3400); // 10 km at 340 s/km midpoint
  });

  it("falls through pace zones → historical → default with assumptions", () => {
    const stages: PlannedStage[] = [
      { id: "a", order: 1, kind: "work", durationType: "distance", distanceMeters: 5000, paceZone: 2 },
    ];
    const withZones = deriveWorkoutSeconds(stages, {
      defaultPaceSecPerKm: 390,
      paceZones: { 2: { low: 350, high: 370 } },
    });
    expect(withZones.seconds).toBe(1800);
    expect(withZones.assumptions[0]).toMatch(/pace zone 2/);

    const withHistory = deriveWorkoutSeconds(stages, {
      defaultPaceSecPerKm: 390,
      historicalPaceForCategory: 360,
    });
    expect(withHistory.seconds).toBe(1800);
    expect(withHistory.assumptions[0]).toMatch(/median pace/);

    const withDefault = deriveWorkoutSeconds(stages, paceContext);
    expect(withDefault.seconds).toBe(1950);
    expect(withDefault.assumptions[0]).toMatch(/conservative default/);
  });

  it("handles open stages with recorded assumptions", () => {
    const stages: PlannedStage[] = [
      { id: "a", order: 1, kind: "warmup", durationType: "open" },
      { id: "b", order: 2, kind: "work", durationType: "time", durationSeconds: 1200 },
    ];
    const d = deriveWorkoutSeconds(stages, paceContext);
    expect(d.seconds).toBe(600 + 1200);
    expect(d.assumptions[0]).toMatch(/open warmup/);
  });
});

describe("estimateDuration priority", () => {
  const base = {
    category: "quality" as const,
    paceContext,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
  };

  it("uses the COROS native estimate first and pads the calendar block", () => {
    const e = estimateDuration({ ...base, sourceEstimatedDurationSeconds: 3240, stages: thresholdStages });
    expect(e.source).toBe("coros_native");
    expect(e.workoutSeconds).toBe(3240);
    expect(e.calendarSeconds).toBe(3240 + 25 * 60);
    expect(e.confidence).toBe("high");
  });

  it("uses the calculation endpoint result second", () => {
    const e = estimateDuration({ ...base, corosCalculatedSeconds: 3300, stages: thresholdStages });
    expect(e.source).toBe("coros_calculated");
  });

  it("derives from stages third", () => {
    const e = estimateDuration({ ...base, stages: thresholdStages });
    expect(e.source).toBe("derived_from_stages");
    expect(e.workoutSeconds).toBe(3600);
    expect(e.confidence).toBe("high"); // fully time-based, no assumptions
  });

  it("uses history fourth and default last", () => {
    const h = estimateDuration({ ...base, historicalMedianSeconds: 3500 });
    expect(h.source).toBe("historical_fallback");
    const d = estimateDuration({ ...base });
    expect(d.source).toBe("default_fallback");
    expect(d.confidence).toBe("low");
  });
});

describe("summarizeStages", () => {
  it("produces a compact readable summary", () => {
    const s = summarizeStages(thresholdStages);
    expect(s).toBe("15 min warmup · 5 × 5 min / 2 min recovery · 10 min cooldown");
  });
});
