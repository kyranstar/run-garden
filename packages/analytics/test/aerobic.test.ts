import type { WorkoutCategory } from "@rg/domain";
import { describe, expect, it } from "vitest";
import type { DecouplingRunInput } from "../src/decoupling.js";
import { computeDecoupling } from "../src/decoupling.js";
import type { EfficiencyRunInput } from "../src/aerobicEfficiency.js";
import { computeAerobicEfficiency } from "../src/aerobicEfficiency.js";
import { theilSen } from "../src/stats.js";
import { mkActivity, mkLap } from "./builders.js";

describe("theilSen", () => {
  it("recovers an exact line: y = 2x + 1", () => {
    const points = Array.from({ length: 8 }, (_, x) => ({ x, y: 2 * x + 1 }));
    const { slope, intercept } = theilSen(points);
    expect(slope).toBeCloseTo(2, 6);
    expect(intercept).toBeCloseTo(1, 6);
  });

  it("barely moves the slope when one of 8 points is a wild outlier", () => {
    const points = Array.from({ length: 7 }, (_, x) => ({ x, y: 2 * x + 1 }));
    points.push({ x: 7, y: 1000 }); // wildly off the line
    const { slope } = theilSen(points);
    expect(Math.abs(slope - 2)).toBeLessThan(0.2);
  });
});

describe("computeAerobicEfficiency", () => {
  /**
   * Laps: 5min, 5min, 10min, 10min, 10min, 5min (cumulative ends at 300,
   * 600, 1200, 1800, 2400, 2700). The first two end at or before 600s
   * cumulative and are dropped as warm-up; the final lap is always dropped.
   * The three surviving 10-minute laps (30 minutes, 150 bpm, 6 km) are the
   * only ones the efficiency ratio is computed from.
   */
  function lapTrimRun(id: string, date: string): EfficiencyRunInput {
    const laps = [
      mkLap(id, 0, { durationSeconds: 300, distanceMeters: 900, avgHeartRate: 999 }),
      mkLap(id, 1, { durationSeconds: 300, distanceMeters: 900, avgHeartRate: 999 }),
      mkLap(id, 2, { durationSeconds: 600, distanceMeters: 2000, avgHeartRate: 150 }),
      mkLap(id, 3, { durationSeconds: 600, distanceMeters: 2000, avgHeartRate: 150 }),
      mkLap(id, 4, { durationSeconds: 600, distanceMeters: 2000, avgHeartRate: 150 }),
      mkLap(id, 5, { durationSeconds: 300, distanceMeters: 900, avgHeartRate: 999 }),
    ];
    return {
      activity: mkActivity({
        id,
        startTimeLocal: `${date}T07:00:00`,
        durationSeconds: laps.reduce((s, l) => s + l.durationSeconds, 0),
        distanceMeters: laps.reduce((s, l) => s + (l.distanceMeters ?? 0), 0),
        avgHeartRate: 999, // whole-run HR must NEVER be used
      }),
      laps,
      category: "easy",
    };
  }

  /**
   * A generic eligible/usable run: 4 laps of 450s. Cumulative ends at 450
   * (dropped, <=600s), 900, 1350, 1800 (dropped, final lap). The two
   * surviving middle laps (900s, `midHr`, `midDistancePerLap` each) drive
   * the efficiency figure.
   */
  function lapRun(
    id: string,
    date: string,
    opts: { midHr?: number; midDistancePerLap?: number; category?: WorkoutCategory } = {},
  ): EfficiencyRunInput {
    const { midHr = 145, midDistancePerLap = 1500, category = "easy" } = opts;
    const laps = [
      mkLap(id, 0, { durationSeconds: 450, distanceMeters: 1500 }),
      mkLap(id, 1, { durationSeconds: 450, distanceMeters: midDistancePerLap, avgHeartRate: midHr }),
      mkLap(id, 2, { durationSeconds: 450, distanceMeters: midDistancePerLap, avgHeartRate: midHr }),
      mkLap(id, 3, { durationSeconds: 450, distanceMeters: 1500 }),
    ];
    return {
      activity: mkActivity({
        id,
        startTimeLocal: `${date}T07:00:00`,
        durationSeconds: laps.reduce((s, l) => s + l.durationSeconds, 0),
        distanceMeters: laps.reduce((s, l) => s + (l.distanceMeters ?? 0), 0),
        avgHeartRate: midHr,
      }),
      laps,
      category,
    };
  }

  it("uses only the laps surviving warm-up and final-lap trim", () => {
    const result = computeAerobicEfficiency([
      lapTrimRun("a", "2026-03-02"),
      lapRun("b", "2026-03-04"),
      lapRun("c", "2026-03-06"),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const point = result.value.perRun.find((p) => p.activityId === "a")!;
    // 6000 m in 1800 s at 150 bpm -> (6000/1800/150)*60
    expect(point.efficiency).toBeCloseTo((6000 / 1800 / 150) * 60, 4);
  });

  it("excludes an eligible run with 0 laps instead of falling back to whole-run figures", () => {
    const zeroLaps: EfficiencyRunInput = {
      activity: mkActivity({
        id: "nolaps",
        startTimeLocal: "2026-03-08T07:00:00",
        durationSeconds: 1800,
        distanceMeters: 6000,
        avgHeartRate: 145,
      }),
      laps: [],
      category: "easy",
    };
    const result = computeAerobicEfficiency([
      lapRun("a", "2026-03-02"),
      lapRun("b", "2026-03-04"),
      lapRun("c", "2026-03-06"),
      zeroLaps,
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.excludedCount).toBe(1);
    expect(result.value.perRun.some((p) => p.activityId === "nolaps")).toBe(false);
  });

  it("leaves trend undefined below 6 points", () => {
    const result = computeAerobicEfficiency([
      lapRun("a", "2026-03-01"),
      lapRun("b", "2026-03-03"),
      lapRun("c", "2026-03-05"),
      lapRun("d", "2026-03-07"),
      lapRun("e", "2026-03-09"),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.perRun).toHaveLength(5);
    expect(result.value.trend).toBeUndefined();
  });

  it("reports a Theil-Sen trend once 6 points span a +10% linear rise", () => {
    const dates = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
    const runs = dates.map((date, i) =>
      lapRun(`r${i}`, date, { midDistancePerLap: 1500 * (1 + 0.1 * (i / (dates.length - 1))) }),
    );
    const result = computeAerobicEfficiency(runs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.trend).toBeDefined();
    expect(result.value.trend!.n).toBe(6);
    expect(result.value.trend!.pct).toBeGreaterThan(9);
    expect(result.value.trend!.pct).toBeLessThan(11);
  });

  it("excludes runs shorter than 25 minutes, without HR, or paused more than 15%", () => {
    const short = lapRun("short", "2026-03-01");
    short.activity = mkActivity({
      id: "short",
      startTimeLocal: "2026-03-01T07:00:00",
      durationSeconds: 1200,
      avgHeartRate: 145,
    });

    const nohr = lapRun("nohr", "2026-03-02");
    nohr.activity = mkActivity({
      id: "nohr",
      startTimeLocal: "2026-03-02T07:00:00",
      durationSeconds: 1800,
    });

    const paused = lapRun("paused", "2026-03-03");
    paused.activity = mkActivity({
      id: "paused",
      startTimeLocal: "2026-03-03T07:00:00",
      durationSeconds: 1800,
      elapsedSeconds: 2400, // 25% paused
      avgHeartRate: 145,
    });

    const ok = lapRun("ok", "2026-03-04");

    const result = computeAerobicEfficiency([short, nohr, paused, ok]);
    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") expect(result.have).toBe(1);
  });

  it("suppresses honestly below the 3-run minimum", () => {
    const result = computeAerobicEfficiency([
      lapRun("a", "2026-03-02"),
      lapRun("b", "2026-03-04"),
      // ineligible: not an easy/recovery run
      lapRun("c", "2026-03-06", { category: "quality" }),
    ]);
    expect(result).toMatchObject({ status: "insufficient_data", needed: 3, have: 2 });
  });
});

describe("computeDecoupling", () => {
  const STEADY: WorkoutCategory = "easy";

  /**
   * 5 laps of 600s (3000s / 50min total, clears the 40-minute gate).
   * Cumulative ends at 600 (dropped, warm-up), 1200, 1800, 2400, 3000. The
   * 4 surviving laps split evenly into two 1200s halves: [lap1, lap2] and
   * [lap3, lap4].
   */
  function steadyRun(
    id: string,
    date: string,
    opts: {
      firstHr?: number;
      secondHr?: number;
      firstPace?: number;
      secondPace?: number;
      category?: WorkoutCategory;
      durationSeconds?: number;
      paces?: number[];
    } = {},
  ): DecouplingRunInput {
    const {
      firstHr = 140,
      secondHr = 140,
      firstPace = 300,
      secondPace = 300,
      category = STEADY,
      paces,
    } = opts;
    const hrs = [999, firstHr, firstHr, secondHr, secondHr];
    const lapPaces = paces ?? [300, firstPace, firstPace, secondPace, secondPace];
    const laps = hrs.map((hr, i) =>
      mkLap(id, i, { durationSeconds: 600, avgHeartRate: hr, avgPaceSecPerKm: lapPaces[i] }),
    );
    return {
      activity: mkActivity({
        id,
        startTimeLocal: `${date}T07:00:00`,
        durationSeconds: opts.durationSeconds ?? laps.reduce((s, l) => s + l.durationSeconds, 0),
      }),
      laps,
      category,
    };
  }

  it("is 0% when pace and HR are constant after trim", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02"),
      steadyRun("b", "2026-03-04"),
      steadyRun("c", "2026-03-06"),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const p of result.value.perRun) expect(p.decouplingPct).toBeCloseTo(0, 6);
    expect(result.value.medianPct).toBeCloseTo(0, 6);
  });

  it("matches HR-only drift when pace is constant: 140 -> 147 is +5%", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02", { firstHr: 140, secondHr: 147 }),
      steadyRun("b", "2026-03-04"),
      steadyRun("c", "2026-03-06", { firstHr: 140, secondHr: 154 }),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.perRun.find((p) => p.activityId === "a")!.decouplingPct).toBeCloseTo(5, 2);
    expect(result.value.perRun.find((p) => p.activityId === "c")!.decouplingPct).toBeCloseTo(10, 2);
  });

  it("is the Pa:HR point: 5% slower pace AND 5% lower HR in H2 nets ~0%, not -5%", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02", { firstHr: 140, secondHr: 133, firstPace: 300, secondPace: 315 }),
      steadyRun("b", "2026-03-04"),
      steadyRun("c", "2026-03-06"),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const a = result.value.perRun.find((p) => p.activityId === "a")!;
    expect(Math.abs(a.decouplingPct)).toBeLessThan(1);
    expect(a.decouplingPct).not.toBeCloseTo(-5, 0);
  });

  it("excludes runs shorter than 40 minutes and interval workouts, with reasons", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02"),
      steadyRun("b", "2026-03-04"),
      steadyRun("c", "2026-03-06"),
      steadyRun("short", "2026-03-07", { durationSeconds: 2100 }),
      steadyRun("intervals", "2026-03-08", { category: "quality" }),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.perRun).toHaveLength(3);
    expect(result.value.excluded.count).toBe(2);
    expect(result.value.excluded.reasons.some((r) => r.includes("40 minutes"))).toBe(true);
    expect(
      result.value.excluded.reasons.some((r) => r.includes('category "quality" is not a steady run')),
    ).toBe(true);
  });

  it("excludes surging runs (lap pace > 25% from the run median) with a reason", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02"),
      steadyRun("b", "2026-03-04"),
      steadyRun("c", "2026-03-06"),
      steadyRun("surge", "2026-03-07", { paces: [300, 300, 300, 420, 300] }),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.perRun.some((p) => p.activityId === "surge")).toBe(false);
    expect(result.value.excluded.reasons.some((r) => r.includes("surging"))).toBe(true);
  });

  it("suppresses honestly below the 3-run minimum", () => {
    const result = computeDecoupling([
      steadyRun("a", "2026-03-02"),
      steadyRun("b", "2026-03-04"),
      steadyRun("intervals", "2026-03-06", { category: "quality" }),
    ]);
    expect(result).toMatchObject({ status: "insufficient_data", needed: 3, have: 2 });
  });
});
