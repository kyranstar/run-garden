import { describe, expect, it } from "vitest";
import { computeEasyDiscipline } from "../src/easyDiscipline.js";
import { easyCeiling, estimateHrMax, isEasyHr } from "../src/hrZones.js";
import type { IntensityRunInput } from "../src/lowIntensityShare.js";
import { computeLowIntensityShare } from "../src/lowIntensityShare.js";
import { mkActivity } from "./builders.js";

describe("estimateHrMax", () => {
  it("takes the second-highest observed max, killing a one-off spike", () => {
    const activities = [188, 201, 186].map((maxHeartRate, i) =>
      mkActivity({ id: `a${i}`, maxHeartRate }),
    );
    expect(estimateHrMax(activities)).toBe(188);
  });

  it("uses the only reading when there is just one", () => {
    expect(estimateHrMax([mkActivity({ id: "a0", maxHeartRate: 190 })])).toBe(190);
  });

  it("returns null with no qualifying readings", () => {
    expect(estimateHrMax([])).toBeNull();
    expect(estimateHrMax([mkActivity({ id: "a0" })])).toBeNull();
  });

  it("ignores implausible low max readings (a 90bpm 'max' from a walk doesn't count)", () => {
    // Only one activity clears the >120 floor, so it alone sets the estimate;
    // the walk's 90bpm "max" is excluded rather than becoming the runner-up.
    const activities = [90, 185].map((maxHeartRate, i) => mkActivity({ id: `a${i}`, maxHeartRate }));
    expect(estimateHrMax(activities)).toBe(185);

    // All readings implausible -> nothing qualifies.
    const allLow = [90, 100, 60].map((maxHeartRate, i) => mkActivity({ id: `a${i}`, maxHeartRate }));
    expect(estimateHrMax(allLow)).toBeNull();
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

describe("computeLowIntensityShare", () => {
  it("buckets lap time and avg-only time by isEasyHr, rounding lowPct", () => {
    const hrMax = 190; // ceiling 152
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
    const r = computeLowIntensityShare(runs, hrMax);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.lowSeconds).toBe(3600 + 4 * 3600);
    expect(r.value.highSeconds).toBe(1200);
    expect(r.value.noHrSeconds).toBe(0);
    expect(r.value.lowPct).toBe(94); // 18000 / 19200 = 93.75 -> 94
    expect(r.value.perActivity["run-a"]).toEqual({ lowSeconds: 3600, highSeconds: 1200 });
    expect(r.value.perActivity["run-b"]).toEqual({ lowSeconds: 3600, highSeconds: 0 });
  });

  it("suppresses with fewer than 4 runs contributing heart-rate time", () => {
    const runs: IntensityRunInput[] = [
      avgOnlyRun("run-a", 140, 3600),
      avgOnlyRun("run-b", 140, 3600),
      avgOnlyRun("run-c", 140, 3600),
    ];
    const r = computeLowIntensityShare(runs, 190);
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
    const r = computeLowIntensityShare(runs, 190);
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
    const r = computeLowIntensityShare(runs, 190);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.noHrSeconds).toBe(1800);
    expect(r.value.lowSeconds).toBe(4 * 3600);
    expect(r.value.highSeconds).toBe(0);
    expect(r.value.lowPct).toBe(100);
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
  it("counts avgHr exactly at easyCeiling as EASY, in both pct and ticks (one shared predicate)", () => {
    const hrMax = 190; // previously failing: zoneOf(152, 190) is zone 3, not <=2
    const ceiling = easyCeiling(hrMax);
    expect(ceiling).toBe(152);
    const runs = [
      { activityId: "a1", date: "2026-07-01", avgHr: 130 },
      { activityId: "a2", date: "2026-07-02", avgHr: 135 },
      { activityId: "a3", date: "2026-07-03", avgHr: 140 },
      { activityId: "a4", date: "2026-07-04", avgHr: 145 },
      { activityId: "boundary", date: "2026-07-05", avgHr: ceiling },
    ];
    const r = computeEasyDiscipline(runs, hrMax);
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
    const r = computeEasyDiscipline(runs, 190); // ceiling 152; 160 is over
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.inEasyPct).toBe(80);
    expect(r.value.ticks.map((t) => t.activityId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(r.value.ticks[2]!.easy).toBe(false);
  });
});
