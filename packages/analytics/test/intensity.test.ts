import { describe, expect, it } from "vitest";
import { computeEasyDiscipline } from "../src/easyDiscipline.js";
import { easyCeiling, estimateHrMax, isEasyHr, watchEasyCeiling } from "../src/hrZones.js";
import type { IntensityRunInput } from "../src/lowIntensityShare.js";
import {
  computeLowIntensityShare,
  intensityBand,
  intensityBandStable,
} from "../src/lowIntensityShare.js";
import { mkActivity } from "./builders.js";

// audit#2 (a3): the estimator is corroborated-top with a 5-reading floor.
describe("estimateHrMax", () => {
  const readings = (maxes: number[]) =>
    maxes.map((maxHeartRate, i) => mkActivity({ id: `a${i}`, maxHeartRate }));

  it("uses the TOP reading when the second corroborates it within 12 bpm", () => {
    // The audit's live failure: second-highest-of-sparse-readings built a
    // ceiling of 144 under a watch that draws it at 155. 186 and 180 are two
    // hard days, not a glitch and its shadow — the top reading stands.
    expect(estimateHrMax(readings([186, 180, 172, 168, 160]))).toBe(186);
  });

  it("falls back to the runner-up when the top reading stands alone (a 30+ bpm spike)", () => {
    expect(estimateHrMax(readings([215, 182, 178, 174, 170]))).toBe(182);
  });

  it("treats exactly 12 bpm of separation as corroborated, 13 as a spike", () => {
    expect(estimateHrMax(readings([192, 180, 175, 172, 168]))).toBe(192);
    expect(estimateHrMax(readings([193, 180, 175, 172, 168]))).toBe(180);
  });

  it("emits no ceiling at all below 5 qualifying readings", () => {
    expect(estimateHrMax([])).toBeNull();
    expect(estimateHrMax([mkActivity({ id: "a0" })])).toBeNull();
    expect(estimateHrMax(readings([190]))).toBeNull();
    expect(estimateHrMax(readings([188, 186, 184, 182]))).toBeNull();
    expect(estimateHrMax(readings([188, 186, 184, 182, 180]))).toBe(188);
  });

  it("ignores implausible low max readings (a 90bpm 'max' from a walk doesn't count)", () => {
    // The walk's 90bpm "max" neither counts toward the 5-reading floor nor
    // becomes the runner-up.
    const four = readings([90, 185, 183, 181, 179]);
    expect(estimateHrMax(four)).toBeNull();
    const five = readings([90, 185, 183, 181, 179, 177]);
    expect(estimateHrMax(five)).toBe(185);
  });
});

// audit#2 (a2): the watch's own Z2 boundary outranks every estimate.
describe("watchEasyCeiling", () => {
  const zoned = (id: string, startTime: string, z2hi: number) =>
    mkActivity({
      id,
      startTime,
      telemetry: {
        hrZones: [
          { lo: 0, hi: 135, seconds: 600 },
          { lo: 136, hi: z2hi, seconds: 1200 },
          { lo: z2hi + 1, hi: 168, seconds: 300 },
          { lo: 169, hi: 180, seconds: 0 },
          { lo: 181, hi: 220, seconds: 0 },
        ],
      },
    });

  it("reads the Z2 upper bound off the most recent zone-carrying activity", () => {
    const acts = [
      zoned("old", "2026-07-01T07:00:00Z", 150),
      zoned("new", "2026-08-01T07:00:00Z", 155),
      mkActivity({ id: "zoneless", startTime: "2026-08-10T07:00:00Z" }),
    ];
    expect(watchEasyCeiling(acts)).toBe(155);
  });

  it("is order-independent — recency comes from startTime, not array position", () => {
    const acts = [
      zoned("new", "2026-08-01T07:00:00Z", 155),
      zoned("old", "2026-07-01T07:00:00Z", 150),
    ];
    expect(watchEasyCeiling(acts)).toBe(155);
    expect(watchEasyCeiling([...acts].reverse())).toBe(155);
  });

  it("returns null when no activity carries a usable zone record", () => {
    expect(watchEasyCeiling([])).toBeNull();
    expect(watchEasyCeiling([mkActivity({ id: "a" })])).toBeNull();
    // A degenerate record (missing Z2, or a zeroed bound) is not a ceiling.
    expect(
      watchEasyCeiling([
        mkActivity({ id: "b", telemetry: { hrZones: [{ lo: 0, hi: 135, seconds: 600 }] } }),
      ]),
    ).toBeNull();
    expect(
      watchEasyCeiling([
        mkActivity({
          id: "c",
          telemetry: {
            hrZones: [
              { lo: 0, hi: 135, seconds: 600 },
              { lo: 136, hi: 0, seconds: 0 },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });
});

function lapRun(
  activityId: string,
  laps: Array<{ avgHeartRate: number | null; durationSeconds: number }>,
): IntensityRunInput {
  return {
    activityId,
    durationSeconds: laps.reduce((s, l) => s + l.durationSeconds, 0),
    avgHeartRate: null,
    laps,
  };
}

function avgOnlyRun(activityId: string, avgHeartRate: number, durationSeconds: number): IntensityRunInput {
  return { activityId, durationSeconds, avgHeartRate, laps: [] };
}

/** A run classified by the watch's own time-in-zone record (Z1..Z5 seconds). */
function zonedRun(activityId: string, zoneSeconds: number[]): IntensityRunInput {
  return {
    activityId,
    durationSeconds: zoneSeconds.reduce((s, z) => s + z, 0),
    avgHeartRate: null,
    laps: [],
    hrZones: zoneSeconds.map((seconds, i) => ({ lo: 100 + i * 15, hi: 115 + i * 15, seconds })),
  };
}

describe("computeLowIntensityShare", () => {
  const CEILING = 152; // easyCeiling(190)

  it("buckets lap time and avg-only time against the easy ceiling, rounding lowPct", () => {
    const runs: IntensityRunInput[] = [
      lapRun("run-a", [
        { avgHeartRate: 140, durationSeconds: 3600 }, // 60 min, easy (zone 2)
        { avgHeartRate: 160, durationSeconds: 1200 }, // 20 min, over ceiling (zone 3)
      ]),
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
      avgOnlyRun("run-d", 140, 3600),
      avgOnlyRun("run-e", 140, 3600),
    ];
    const r = computeLowIntensityShare(runs, CEILING);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.lowSeconds).toBe(3600 + 4 * 3600);
    expect(r.value.highSeconds).toBe(1200);
    expect(r.value.noHrSeconds).toBe(0);
    expect(r.value.lowPct).toBe(94); // 18000 / 19200 = 93.75 -> 94
    expect(r.value.perActivity["run-a"]).toEqual({ lowSeconds: 3600, highSeconds: 1200 });
    expect(r.value.perActivity["run-b"]).toEqual({ lowSeconds: 3600, highSeconds: 0 });
  });

  // audit#2 (a1): the watch's own record IS the classification.
  it("classifies a zone-carrying run from its hrZones record: Z1+Z2 low, Z3+ high", () => {
    const runs: IntensityRunInput[] = [
      zonedRun("run-a", [600, 1800, 900, 300, 0]), // low 2400, high 1200
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
      avgOnlyRun("run-d", 140, 3600),
    ];
    const r = computeLowIntensityShare(runs, CEILING);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.perActivity["run-a"]).toEqual({ lowSeconds: 2400, highSeconds: 1200 });
    expect(r.value.lowSeconds).toBe(2400 + 3 * 3600);
    expect(r.value.highSeconds).toBe(1200);
    expect(r.value.noHrSeconds).toBe(0);
  });

  it("lets hrZones outrank laps AND the ceiling — the audit's exact failure shape", () => {
    // A 147bpm aerobic run: the watch (easy boundary 155) files it in Z2,
    // but a broken 144 estimate files every lap as high. With the zone
    // record present the estimate must not matter at all.
    const runs: IntensityRunInput[] = [
      {
        activityId: "aerobic",
        durationSeconds: 3600,
        avgHeartRate: 147,
        laps: [{ avgHeartRate: 147, durationSeconds: 3600 }],
        hrZones: [
          { lo: 0, hi: 135, seconds: 0 },
          { lo: 136, hi: 155, seconds: 3600 }, // all of it Z2 per the watch
          { lo: 156, hi: 168, seconds: 0 },
        ],
      },
      avgOnlyRun("run-b", 130, 3600),
      avgOnlyRun("run-c", 130, 3600),
      avgOnlyRun("run-d", 130, 3600),
    ];
    const brokenCeiling = 144;
    const r = computeLowIntensityShare(runs, brokenCeiling);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.perActivity["aerobic"]).toEqual({ lowSeconds: 3600, highSeconds: 0 });
    expect(r.value.lowPct).toBe(100);
  });

  it("falls back to lap/avg bucketing when hrZones is absent or carries no time", () => {
    const emptyZones: IntensityRunInput = {
      ...avgOnlyRun("run-a", 160, 3600), // over the ceiling
      hrZones: [
        { lo: 0, hi: 135, seconds: 0 },
        { lo: 136, hi: 155, seconds: 0 },
      ],
    };
    const runs = [
      emptyZones,
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
      avgOnlyRun("run-d", 140, 3600),
    ];
    const r = computeLowIntensityShare(runs, 152);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // A zeroed record is no record: the 160bpm average decides, as high.
    expect(r.value.perActivity["run-a"]).toEqual({ lowSeconds: 0, highSeconds: 3600 });
  });

  it("suppresses with fewer than 4 runs contributing heart-rate time", () => {
    const runs: IntensityRunInput[] = [
      avgOnlyRun("run-a", 140, 3600),
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
    ];
    const r = computeLowIntensityShare(runs, CEILING);
    expect(r).toMatchObject({ status: "insufficient_data", needed: 4, have: 3 });
  });

  it("reports the total-time gate in HOURS, matching its own explanation's unit", () => {
    // 4 runs clears the run-count gate; 4 x 2250s = 9000s = 2.5h misses the
    // 4-hour one. `needed`/`have` used to be raw seconds (14400 / 9000), so
    // the UI printed "9000 of 14400 available so far" under a sentence about
    // 4 hours and 2.5 hours.
    const runs: IntensityRunInput[] = [
      avgOnlyRun("run-a", 140, 2250),
      avgOnlyRun("run-b", 140, 2250),
      avgOnlyRun("run-c", 140, 2250),
      avgOnlyRun("run-d", 140, 2250),
    ];
    const r = computeLowIntensityShare(runs, CEILING);
    expect(r).toMatchObject({ status: "insufficient_data", needed: 4, have: 2.5 });
    if (r.status !== "insufficient_data") return;
    expect(r.explanation).toContain("at least 4 hours");
    expect(r.explanation).toContain("only have 2.5 hours");
  });

  it("counts time with no heart rate at all as noHrSeconds and excludes it from the ratio", () => {
    const runs: IntensityRunInput[] = [
      avgOnlyRun("run-a", 140, 3600),
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
      avgOnlyRun("run-d", 140, 3600),
      { activityId: "run-e", durationSeconds: 1800, avgHeartRate: null, laps: [] },
    ];
    const r = computeLowIntensityShare(runs, CEILING);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.noHrSeconds).toBe(1800);
    expect(r.value.lowSeconds).toBe(4 * 3600);
    expect(r.value.highSeconds).toBe(0);
    expect(r.value.lowPct).toBe(100);
  });
});

describe("intensityBand", () => {
  it("maps lowPct to the same thresholds the card presents", () => {
    expect(intensityBand(64)).toBe("high");
    expect(intensityBand(65)).toBe("watch");
    expect(intensityBand(74)).toBe("watch");
    expect(intensityBand(75)).toBe("healthy");
    expect(intensityBand(100)).toBe("healthy");
  });
});

// audit#2 (a4): the band claim must survive the ceiling's own error bar.
describe("intensityBandStable", () => {
  it("flips — and reports unstable — when fallback-bucketed runs straddle ceiling ± 5", () => {
    // Four hour-long runs averaging 148 against a ceiling of 150: at 145 all
    // four read high (lowPct 0, band "high"), at 150+ they read low (band
    // "healthy"). That verdict is a fact about the ceiling, not the runner.
    const runs: IntensityRunInput[] = [
      avgOnlyRun("a", 148, 3600),
      avgOnlyRun("b", 148, 3600),
      avgOnlyRun("c", 148, 3600),
      avgOnlyRun("d", 148, 3600),
    ];
    expect(intensityBandStable(runs, 150)).toBe(false);
  });

  it("is stable when every run sits clear of the probed range", () => {
    const runs: IntensityRunInput[] = [
      avgOnlyRun("a", 130, 3600),
      avgOnlyRun("b", 130, 3600),
      avgOnlyRun("c", 130, 3600),
      avgOnlyRun("d", 165, 3600), // clearly high at 145, 150 and 155 alike
    ];
    expect(intensityBandStable(runs, 150)).toBe(true);
  });

  it("zone-backed time is immune: the watch's own seconds don't move with the ceiling", () => {
    // Identical zone records at every probed ceiling — a fully zone-backed
    // month always reads stable, even when the share sits on a band edge.
    const runs: IntensityRunInput[] = [
      zonedRun("a", [1800, 1800, 3600, 0, 0]), // 50% low: "high" at every ceiling
      zonedRun("b", [3600, 0, 3600, 0, 0]),
      zonedRun("c", [3600, 0, 0, 0, 0]),
      zonedRun("d", [3600, 0, 0, 0, 0]),
    ];
    expect(intensityBandStable(runs, 150)).toBe(true);
    expect(intensityBandStable(runs, 144)).toBe(true);
  });

  it("treats a not-computable probe point as unstable rather than claiming a band", () => {
    expect(intensityBandStable([], 150)).toBe(false);
  });
});

describe("isEasyHr", () => {
  it("agrees with easyCeiling's displayed integer bpm for every hrMax in 120..220", () => {
    // zoneOf's raw-fraction check disagrees with the rounded integer ceiling
    // for most hrMax values (rounding can push the ceiling to either side of
    // the 0.8 fraction boundary) — isEasyHr must always agree with the
    // ceiling bpm value shown in the drill-down UI, for every hrMax, not
    // just the ones where zoneOf happens to round the same way.
    for (let hrMax = 120; hrMax <= 220; hrMax++) {
      const ceiling = easyCeiling(hrMax);
      expect(isEasyHr(ceiling, hrMax)).toBe(true);
      expect(isEasyHr(ceiling + 1, hrMax)).toBe(false);
    }
  });
});

describe("computeEasyDiscipline", () => {
  it("counts avgHr exactly at the ceiling as EASY, in both pct and ticks (one shared predicate)", () => {
    const ceiling = easyCeiling(190); // previously failing: zoneOf(152, 190) is zone 3, not <=2
    expect(ceiling).toBe(152);
    const runs = [
      { activityId: "a1", date: "2026-07-01", avgHr: 130 },
      { activityId: "a2", date: "2026-07-02", avgHr: 135 },
      { activityId: "a3", date: "2026-07-03", avgHr: 140 },
      { activityId: "a4", date: "2026-07-04", avgHr: 145 },
      { activityId: "boundary", date: "2026-07-05", avgHr: ceiling },
    ];
    const r = computeEasyDiscipline(runs, ceiling);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.inEasyPct).toBe(100);
    const boundaryTick = r.value.ticks.find((t) => t.activityId === "boundary");
    expect(boundaryTick?.easy).toBe(true);
  });

  it("computes inEasyPct and chronological per-run ticks", () => {
    const runs = [
      { activityId: "r1", date: "2026-07-01", avgHr: 150 },
      { activityId: "r2", date: "2026-07-02", avgHr: 150 },
      { activityId: "r3", date: "2026-07-03", avgHr: 160 },
      { activityId: "r4", date: "2026-07-04", avgHr: 150 },
      { activityId: "r5", date: "2026-07-05", avgHr: 150 },
    ];
    const r = computeEasyDiscipline(runs, 152); // ceiling 152; 160 is over
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.inEasyPct).toBe(80);
    expect(r.value.ticks.map((t) => t.activityId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(r.value.ticks[2]!.easy).toBe(false);
  });

  it("measures against the watch ceiling when one is supplied — 147-153 aerobic runs stay easy at 155", () => {
    // The audit's user: aerobic runs at 147–153 against a watch boundary of
    // 155 — every one of them easy — versus the broken 144 estimate that
    // called them all hard.
    const runs = [
      { activityId: "r1", date: "2026-08-01", avgHr: 147 },
      { activityId: "r2", date: "2026-08-03", avgHr: 149 },
      { activityId: "r3", date: "2026-08-05", avgHr: 151 },
      { activityId: "r4", date: "2026-08-07", avgHr: 153 },
      { activityId: "r5", date: "2026-08-09", avgHr: 150 },
    ];
    const atWatchCeiling = computeEasyDiscipline(runs, 155);
    expect(atWatchCeiling.status === "ok" && atWatchCeiling.value.inEasyPct).toBe(100);
    const atBrokenEstimate = computeEasyDiscipline(runs, 144);
    expect(atBrokenEstimate.status === "ok" && atBrokenEstimate.value.inEasyPct).toBe(0);
  });
});
