import { describe, expect, it } from "vitest";
import { computeLoadRatio, computeMonotony, computeRamp, loadCoverage } from "../src/load.js";

const DAY = 86_400_000;
const TODAY = "2026-08-01";

function daysAgo(n: number, from = TODAY): string {
  return new Date(Date.parse(from) - n * DAY).toISOString().slice(0, 10);
}

describe("computeLoadRatio", () => {
  it("60 days of steady 100/day load settles at ratio ~1.00 with no signal", () => {
    const days = Array.from({ length: 60 }, (_, i) => ({ date: daysAgo(i), load: 100 }));
    const r = computeLoadRatio(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.ratio).toBeCloseTo(1.0, 1); // within 0.02 in practice
    expect(r.value.pctVsNorm).toBe(0);
    expect(r.value.series.length).toBe(56);
  });

  it("suppresses with only 14 days of history, needing 28", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({ date: daysAgo(i), load: 60 }));
    const r = computeLoadRatio(days, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(28);
  });

  it("28 days at 50/day then a 7-day spike to 150/day pushes the ratio above 1.3", () => {
    const days: { date: string; load: number }[] = [];
    for (let i = 0; i < 35; i++) {
      // i=0 is today; the most recent 7 days (i<7) are the spike, the older 28 (i=7..34) are baseline.
      days.push({ date: daysAgo(i), load: i < 7 ? 150 : 50 });
    }
    const r = computeLoadRatio(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.ratio).toBeGreaterThan(1.3);
  });

  it("suppresses when the last run was 40 days ago and nothing since (no recent baseline)", () => {
    // A single run far enough back to clear the 28-day history gate, then nothing —
    // including nothing in the trailing 28-day window itself.
    const days = [{ date: daysAgo(40), load: 100 }];
    const r = computeLoadRatio(days, TODAY);
    expect(r.status).toBe("insufficient_data");
  });
});

describe("computeRamp", () => {
  it("28 days of steady 3600s/day has zero ramp", () => {
    const days = Array.from({ length: 28 }, (_, i) => ({ date: daysAgo(i), seconds: 3600 }));
    const r = computeRamp(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.pct).toBe(0);
    expect(r.value.deltaSeconds).toBe(0);
  });

  it("doubling from a 1800s/day norm to 3600s/day this week is a +100% ramp", () => {
    const days: { date: string; seconds: number }[] = [];
    for (let i = 0; i < 28; i++) {
      days.push({ date: daysAgo(i), seconds: i < 7 ? 3600 : 1800 });
    }
    const r = computeRamp(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.pct).toBe(100);
  });

  it("suppresses instead of dividing by zero when returning from a break", () => {
    // Old history clears the 28-day gate, then a 21-day gap with no running,
    // then running resumes this week — there is no recent norm to ramp against.
    const days = [
      { date: daysAgo(40), seconds: 3600 },
      ...Array.from({ length: 7 }, (_, i) => ({ date: daysAgo(i), seconds: 3600 })),
    ];
    const r = computeRamp(days, TODAY);
    expect(r.status).toBe("insufficient_data");
    // The gap is in recent running, not total history — "have" must report
    // what's actually missing (0), not the (larger, gate-passing) history
    // length, or "Need 28; have 41" reads as self-contradictory.
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(28);
    expect(r.have).toBe(0);
  });
});

// audit#2 (b): coverage over the trailing 28 days the load metrics weight.
describe("loadCoverage", () => {
  const act = (date: string, durationSeconds: number, trainingLoad: number | null) => ({
    date,
    durationSeconds,
    trainingLoad,
  });

  it("ignores pre-window legacy runs — the audit's exact failure shape", () => {
    // Three old load-less runs once dragged 12-week coverage to 0.83 < 0.9,
    // flipping the whole basis to minutes. They are outside the 28 days the
    // metrics weight, so they must not count against coverage at all.
    const rows = [
      act(daysAgo(60), 3600, null),
      act(daysAgo(45), 3600, null),
      act(daysAgo(30), 3600, null),
      // The recent month is fully covered.
      act(daysAgo(20), 3600, 55),
      act(daysAgo(10), 3600, 60),
      act(daysAgo(2), 3600, 40),
    ];
    const c = loadCoverage(rows, TODAY);
    expect(c.fraction).toBe(1);
    expect(c.totalSeconds).toBe(3 * 3600);
    expect(c.coveredSeconds).toBe(3 * 3600);
  });

  it("weights coverage by duration inside the window", () => {
    const rows = [
      act(daysAgo(5), 3 * 3600, 80), // 3h covered
      act(daysAgo(3), 3600, null), // 1h uncovered
    ];
    const c = loadCoverage(rows, TODAY);
    expect(c.fraction).toBe(0.75);
  });

  it("includes both window edges: today and exactly 27 days back", () => {
    const rows = [
      act(daysAgo(27), 3600, 50), // last day inside
      act(daysAgo(28), 3600, null), // first day outside — must not dilute
      act(TODAY, 3600, 50),
    ];
    const c = loadCoverage(rows, TODAY);
    expect(c.totalSeconds).toBe(2 * 3600);
    expect(c.fraction).toBe(1);
  });

  it("ignores future-dated rows and reports 0 for an empty window", () => {
    expect(loadCoverage([], TODAY)).toEqual({ coveredSeconds: 0, totalSeconds: 0, fraction: 0 });
    const c = loadCoverage([act(daysAgo(-1), 3600, 50)], TODAY);
    expect(c.totalSeconds).toBe(0);
    expect(c.fraction).toBe(0);
  });

  it("a zero training load still counts as covered — 0 is a reading, not an absence", () => {
    const c = loadCoverage([act(daysAgo(1), 3600, 0)], TODAY);
    expect(c.fraction).toBe(1);
  });
});

describe("computeMonotony", () => {
  it("alternating hard/rest days (200,0,200,0,200,0,200) gives monotony near 1", () => {
    const pattern = [200, 0, 200, 0, 200, 0, 200]; // index 0 = 6 days ago ... index 6 = today
    const days = [
      { date: daysAgo(20), load: 80 }, // clears the 14-day history gate
      ...pattern.map((load, i) => ({ date: daysAgo(6 - i), load })),
    ];
    const r = computeMonotony(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.monotony).toBeGreaterThan(0.9);
    expect(r.value.monotony).toBeLessThan(1.3);
  });

  it("seven identical 100-load days caps monotony at 5 and strain at 3500", () => {
    const days = [
      { date: daysAgo(20), load: 80 }, // clears the 14-day history gate
      ...Array.from({ length: 7 }, (_, i) => ({ date: daysAgo(i), load: 100 })),
    ];
    const r = computeMonotony(days, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.monotony).toBe(5);
    expect(r.value.strain).toBe(3500);
    expect(r.value.weeklyLoad).toBe(700);
  });

  it("suppresses with only 2 active days in the trailing week", () => {
    const days = [
      { date: daysAgo(20), load: 80 }, // clears the 14-day history gate
      { date: daysAgo(0), load: 100 },
      { date: daysAgo(3), load: 100 },
    ];
    const r = computeMonotony(days, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(4);
  });
});
