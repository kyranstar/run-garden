import { describe, expect, it } from "vitest";
import type { PlannedStage } from "@rg/domain";
import { estimateDuration } from "../src/estimate.js";
import {
  deriveWorkoutSeconds,
  flattenStages,
  summarizeStageRows,
  summarizeStages,
} from "../src/stages.js";

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
  /**
   * `thresholdStages` carries no labels, so this is the fixture that exercises
   * the KIND fallback — an imported COROS row whose step names were i18n keys
   * `resolveLabel` dropped. The kind there is COROS's own `exerciseType`, which
   * is a classification a human can be shown.
   *
   * It is safe for coach-authored rows too, but only since `writeStages` started
   * deriving roles with `runBlockRoles` (2026-08-17): every non-`work` role that
   * derivation can produce requires a STATED intensity, and the intensity is the
   * label — so a coach row that reaches this branch has kind `work` and prints
   * nothing. Under the positional rule it printed "15 min warmup" here against
   * the approval card's "15 min", a role nobody wrote on a session the athlete
   * had already agreed to.
   */
  it("names a step by its own label, or by the kind the provider gave it", () => {
    expect(summarizeStages(thresholdStages)).toBe(
      "15 min warmup · 5 × 5 min / 2 min recovery · 10 min cooldown",
    );
    // A label always wins — this is what every real COROS row looks like.
    const named = thresholdStages.map((st) =>
      st.kind === "repeat" ? st : { ...st, label: st.kind === "work" ? "Training" : "Rest" },
    );
    expect(summarizeStages(named)).toBe(
      "15 min Rest · 5 × 5 min Training / 2 min Rest · 10 min Rest",
    );
    // …and a `work` step with no label is anonymous, which is what the approval
    // card says for the same block.
    expect(
      summarizeStages([
        { id: "a", order: 1, kind: "work", durationType: "time", durationSeconds: 900 },
      ]),
    ).toBe("15 min");
  });

  /**
   * The stored summary IS the prescription for the Today card, the plan sheet
   * and the coach's UPCOMING lines. It used to round every stage to whole
   * minutes, and prod's real interval sessions are where that breaks:
   * `9ca6bb02` (15s on / 45s off) was stored as "4 × 0 min Training / 1 min
   * Rest" — a prescription of zero, and a recovery that read the same as the
   * genuinely-60s cooldown one segment earlier.
   */
  it("writes a sub-minute stage in seconds, not as '0 min'", () => {
    const strides: PlannedStage[] = [
      { id: "w", order: 1, kind: "work", durationType: "time", durationSeconds: 2400, label: "Training" },
      { id: "c", order: 2, kind: "cooldown", durationType: "time", durationSeconds: 60, label: "Cool Down" },
      { id: "r", order: 3, kind: "repeat", repeatCount: 4, durationType: "none" },
      { id: "on", order: 1, parentStageId: "r", kind: "work", durationType: "time", durationSeconds: 15, label: "Training" },
      { id: "off", order: 2, parentStageId: "r", kind: "recovery", durationType: "time", durationSeconds: 45, label: "Rest" },
    ];
    expect(summarizeStages(strides)).toBe(
      "40 min Training · 1 min Cool Down · 4 × 15s Training / 45s Rest",
    );
    // Boundary-anchored: "40 min" contains "0 min", and a naive substring
    // check here passes for the wrong reason.
    expect(summarizeStages(strides)).not.toMatch(/(^|[ ·/])0 min/);
  });

  it("keeps a 30s/60s strides block's work:rest ratio readable", () => {
    // Live prod row 0a66a4b3: stored as "4 × 1 min Training / 1 min Rest",
    // which turns 1:2 into 1:1 — the one number the block is about.
    const hills: PlannedStage[] = [
      { id: "r", order: 1, kind: "repeat", repeatCount: 4, durationType: "none" },
      { id: "on", order: 1, parentStageId: "r", kind: "work", durationType: "time", durationSeconds: 30, label: "Training" },
      { id: "off", order: 2, parentStageId: "r", kind: "recovery", durationType: "time", durationSeconds: 60, label: "Rest" },
    ];
    expect(summarizeStages(hills)).toBe("4 × 30s Training / 1 min Rest");
  });

  it("says 90 seconds as the interval idiom, not as a rounded 2 min", () => {
    // Live prod row cfac25ab: 800m repeats off 90s recovery, stored "2 min".
    const repeats: PlannedStage[] = [
      { id: "r", order: 1, kind: "repeat", repeatCount: 4, durationType: "none" },
      { id: "on", order: 1, parentStageId: "r", kind: "work", durationType: "distance", distanceMeters: 804.67, label: "Training" },
      { id: "off", order: 2, parentStageId: "r", kind: "recovery", durationType: "time", durationSeconds: 90, label: "Rest" },
    ];
    expect(summarizeStages(repeats)).toBe("4 × 805 m Training / 90s Rest");
  });
});

describe("summarizeStageRows", () => {
  /**
   * The detail route re-derives the summary from the stored rows so the
   * sheet's summary line cannot contradict the stage list beside it. That only
   * holds if the two entry points produce the SAME string — this is the drift
   * guard for the row-shape adapter (`ord` vs `order`, nulls vs absent).
   */
  it("gives byte-identical output to summarizeStages for the same stages", () => {
    const rows = [
      { id: "w", ord: 16777216, kind: "work", durationType: "time", durationSeconds: 2400, label: "Training", parentStageId: null, repeatCount: null, distanceMeters: null },
      { id: "c", ord: 33554432, kind: "cooldown", durationType: "time", durationSeconds: 60, label: "Cool Down", parentStageId: null, repeatCount: null, distanceMeters: null },
      { id: "r", ord: 50331648, kind: "repeat", durationType: "none", repeatCount: 4, parentStageId: null, durationSeconds: null, distanceMeters: null, label: null },
      { id: "on", ord: 50397184, kind: "work", durationType: "time", durationSeconds: 15, label: "Training", parentStageId: "r", repeatCount: null, distanceMeters: null },
      { id: "off", ord: 50462720, kind: "recovery", durationType: "time", durationSeconds: 45, label: "Rest", parentStageId: "r", repeatCount: null, distanceMeters: null },
    ];
    // The exact shape prod stores for `9ca6bb02`, huge sortNo `ord`s and all.
    expect(summarizeStageRows(rows)).toBe(
      "40 min Training · 1 min Cool Down · 4 × 15s Training / 45s Rest",
    );
  });

  it("has no summary to give when a workout has no stage rows", () => {
    // Coach-authored sessions: the caller must fall back to the stored string.
    expect(summarizeStageRows([])).toBe("");
  });
});
