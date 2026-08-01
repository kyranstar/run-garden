import { describe, expect, it } from "vitest";
import type { HrDriftRunInput } from "../src/hrDrift.js";
import { computeHrDrift } from "../src/hrDrift.js";
import { mkActivity, mkLap } from "./builders.js";

function steadyRun(
  id: string,
  date: string,
  hrs: number[],
  opts: { category?: HrDriftRunInput["category"]; paces?: number[] } = {},
): HrDriftRunInput {
  const { category = "easy", paces } = opts;
  return {
    activity: mkActivity({
      id,
      startTimeLocal: `${date}T07:00:00`,
      durationSeconds: 600 * hrs.length,
      avgHeartRate: 145,
    }),
    laps: hrs.map((hr, i) =>
      mkLap(id, i, {
        durationSeconds: 600,
        avgHeartRate: hr,
        avgPaceSecPerKm: paces?.[i] ?? 300,
      }),
    ),
    category,
  };
}

describe("computeHrDrift", () => {
  it("computes drift from constructed halves: 140 -> 147 is 5.0%", () => {
    const result = computeHrDrift([
      steadyRun("a", "2026-03-02", [140, 140, 147, 147]),
      steadyRun("b", "2026-03-04", [140, 140, 140, 140]),
      steadyRun("c", "2026-03-06", [140, 140, 154, 154]),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const a = result.value.perRun.find((p) => p.activityId === "a")!;
    expect(a.driftPct).toBe(5);
    expect(result.value.perRun.find((p) => p.activityId === "b")!.driftPct).toBe(0);
    expect(result.value.perRun.find((p) => p.activityId === "c")!.driftPct).toBe(10);
    expect(result.value.medianDriftPct).toBe(5);
  });

  it("never includes interval workouts and records the reason", () => {
    const result = computeHrDrift([
      steadyRun("a", "2026-03-02", [140, 140, 147, 147]),
      steadyRun("b", "2026-03-04", [140, 141, 142, 143]),
      steadyRun("c", "2026-03-06", [140, 140, 145, 145]),
      steadyRun("intervals", "2026-03-07", [150, 160, 150, 160], { category: "quality" }),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sampleSize).toBe(3);
    expect(result.value.excludedRuns).toEqual([
      { activityId: "intervals", reason: 'category "quality" is not a steady run (only easy, long, recovery qualify)' },
    ]);
  });

  it("excludes surging runs (lap pace > 25% from run median) with a reason", () => {
    const result = computeHrDrift([
      steadyRun("a", "2026-03-02", [140, 140, 147, 147]),
      steadyRun("b", "2026-03-04", [140, 141, 142, 143]),
      steadyRun("c", "2026-03-06", [140, 140, 145, 145]),
      steadyRun("surge", "2026-03-07", [140, 150, 140, 150], { paces: [300, 300, 420, 300] }),
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const excluded = result.value.excludedRuns.find((e) => e.activityId === "surge")!;
    expect(excluded.reason).toContain("surging");
    expect(result.value.perRun.some((p) => p.activityId === "surge")).toBe(false);
  });

  it("excludes short runs and runs with too few HR laps, then suppresses below 3", () => {
    const short = steadyRun("short", "2026-03-02", [140, 140]); // 1200 s
    const fewLaps: HrDriftRunInput = {
      activity: mkActivity({ id: "few", durationSeconds: 2400 }),
      laps: [mkLap("few", 0, { durationSeconds: 1200, avgHeartRate: 140 })],
      category: "easy",
    };
    const result = computeHrDrift([short, fewLaps, steadyRun("ok", "2026-03-05", [140, 140, 141, 141])]);
    expect(result).toMatchObject({ status: "insufficient_data", needed: 3, have: 1 });
  });
});
