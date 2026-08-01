import { describe, expect, it } from "vitest";
import type { EfficiencyRunInput } from "../src/aerobicEfficiency.js";
import { computeAerobicEfficiency } from "../src/aerobicEfficiency.js";
import { mkActivity, mkLap } from "./builders.js";

function easyRun(
  id: string,
  date: string,
  opts: { dur?: number; dist?: number; hr?: number; elapsed?: number } = {},
): EfficiencyRunInput {
  const { dur = 1800, dist = 5400, hr = 140, elapsed } = opts;
  return {
    activity: mkActivity({
      id,
      startTimeLocal: `${date}T07:00:00`,
      durationSeconds: dur,
      distanceMeters: dist,
      avgHeartRate: hr,
      ...(elapsed != null ? { elapsedSeconds: elapsed } : {}),
    }),
    laps: [],
    category: "easy",
  };
}

describe("computeAerobicEfficiency", () => {
  it("suppresses honestly at 2 eligible runs", () => {
    const result = computeAerobicEfficiency([
      easyRun("a", "2026-03-02"),
      easyRun("b", "2026-03-04"),
      // ineligible: not an easy/recovery run
      { ...easyRun("c", "2026-03-06"), category: "quality" },
    ]);
    expect(result).toMatchObject({ status: "insufficient_data", needed: 3, have: 2 });
  });

  it("excludes runs shorter than 25 minutes, without HR, or paused more than 15%", () => {
    const result = computeAerobicEfficiency([
      easyRun("short", "2026-03-01", { dur: 1200 }),
      { ...easyRun("nohr", "2026-03-02"), activity: mkActivity({ id: "nohr", durationSeconds: 1800 }) },
      easyRun("paused", "2026-03-03", { dur: 1800, elapsed: 2400 }), // 25% paused
      easyRun("ok", "2026-03-04"),
    ]);
    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") expect(result.have).toBe(1);
  });

  it("reports a positive trend when efficiency improves", () => {
    const result = computeAerobicEfficiency([
      easyRun("a", "2026-03-02", { dist: 5400 }), // 3.0 m/s
      easyRun("b", "2026-03-04", { dist: 5580 }), // 3.1 m/s
      easyRun("c", "2026-03-06", { dist: 5760 }), // 3.2 m/s
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sampleSize).toBe(3);
    expect(result.value.perRun.map((p) => p.activityId)).toEqual(["a", "b", "c"]);
    expect(result.value.trendPct).toBeGreaterThan(0);
    // (speed / HR) * 60 = meters per beat
    expect(result.value.perRun[0]!.efficiency).toBeCloseTo((3.0 / 140) * 60, 3);
  });

  it("mentions the HR-coverage assumption in the comparison note", () => {
    const result = computeAerobicEfficiency([
      easyRun("a", "2026-03-02"),
      easyRun("b", "2026-03-04"),
      easyRun("c", "2026-03-06"),
    ]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.comparisonNote).toContain("assumed adequate");
  });

  it("uses only middle laps when laps are present (drops first and last)", () => {
    const withLaps: EfficiencyRunInput = {
      activity: mkActivity({
        id: "laps",
        startTimeLocal: "2026-03-08T07:00:00",
        durationSeconds: 1800,
        distanceMeters: 4600,
        avgHeartRate: 150, // whole-run HR differs from middle-lap HR
      }),
      laps: [
        mkLap("laps", 0, { durationSeconds: 300, distanceMeters: 800 }), // warm-up
        mkLap("laps", 1, { durationSeconds: 300, distanceMeters: 1000, avgHeartRate: 140 }),
        mkLap("laps", 2, { durationSeconds: 300, distanceMeters: 1000, avgHeartRate: 140 }),
        mkLap("laps", 3, { durationSeconds: 300, distanceMeters: 800 }), // cool-down
      ],
      category: "easy",
    };
    const result = computeAerobicEfficiency([
      easyRun("a", "2026-03-02"),
      easyRun("b", "2026-03-04"),
      withLaps,
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const point = result.value.perRun.find((p) => p.activityId === "laps")!;
    // middle laps: 2000 m in 600 s at 140 bpm -> (3.3333 / 140) * 60
    expect(point.efficiency).toBeCloseTo((2000 / 600 / 140) * 60, 3);
    // and NOT the whole-run figure
    expect(point.efficiency).not.toBeCloseTo((4600 / 1800 / 150) * 60, 2);
  });
});
