import { describe, expect, it } from "vitest";
import {
  computeEasyDiscipline,
  computeHardDayStacking,
  computeHrvTrend,
  computeLoadRatio,
  computeMonotony,
  computeRamp,
  computeRestingHr,
  interpret,
  zoneOf,
} from "../src/index.js";
import { insufficient, ok } from "../src/metric.js";

describe("interpret", () => {
  it("fills an ok metric from present() and carries the sample note", () => {
    const r = interpret("x", "X", ok(42, 5, "note"), (v) => ({ value: `${v}`, band: "healthy", meaning: "m" }));
    expect(r.status).toBe("ok");
    expect(r.value).toBe("42");
    expect(r.band).toBe("healthy");
    expect(r.sampleNote).toBe("note");
  });
  it("suppresses without a value", () => {
    const r = interpret("x", "X", insufficient(5, 2, "need 3 more"), () => ({ value: "", meaning: "" }));
    expect(r.status).toBe("insufficient_data");
    expect(r.value).toBeUndefined();
    expect(r.meaning).toBe("need 3 more");
    expect(r.sampleNote).toBe("Need 5; have 2.");
  });
});

describe("hr zones", () => {
  it("classifies by %HRmax", () => {
    expect(zoneOf(140, 190)).toBe(2); // 0.737
    expect(zoneOf(120, 190)).toBe(1); // 0.63
    expect(zoneOf(182, 190)).toBe(5); // 0.958
    expect(zoneOf(160, 190)).toBe(3); // 0.842
    expect(zoneOf(178, 190)).toBe(4); // 0.937
  });
});

describe("load", () => {
  it("computes the EWMA load ratio over sufficient history", () => {
    const today = "2026-08-01";
    const days: { date: string; load: number }[] = [];
    // 28 days, 50/day chronic, last 7 days bumped to ~57 each for a mild ramp.
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, load: i < 7 ? 57 : 50 });
    }
    const r = computeLoadRatio(days, today);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      // A mild bump above a steady baseline nudges the ratio a bit above parity,
      // well short of the >1.3 spike threshold.
      expect(r.value.ratio).toBeGreaterThan(1.0);
      expect(r.value.ratio).toBeLessThan(1.3);
    }
  });
  it("suppresses the load ratio without enough history", () => {
    const r = computeLoadRatio([{ date: "2026-08-01", load: 50 }], "2026-08-01");
    expect(r.status).toBe("insufficient_data");
  });
  it("ramp is this week vs. the prior 21-day norm", () => {
    const today = "2026-08-01";
    const days: { date: string; seconds: number }[] = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, seconds: i < 7 ? 3960 : 3600 });
    }
    const r = computeRamp(days, today);
    expect(r.status === "ok" && r.value.pct).toBe(10);
  });
  it("monotony/strain summarize the trailing week's variability", () => {
    const today = "2026-08-01";
    const days: { date: string; load: number }[] = [
      { date: "2026-07-01", load: 80 }, // clears the 14-day history gate
    ];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, load: i % 2 === 0 ? 100 : 0 });
    }
    const r = computeMonotony(days, today);
    if (r.status === "ok") {
      expect(r.value.strain).toBe(Math.round(r.value.weeklyLoad * r.value.monotony));
    }
  });
});

describe("recovery", () => {
  const TODAY = "2026-08-01";
  const health = (n: number, rhr: number, hrv: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.parse(TODAY) - i * 86_400_000).toISOString().slice(0, 10),
      restingHeartRate: rhr,
      hrv,
    }));
  it("resting HR delta vs baseline", () => {
    const rows = health(10, 50, 60);
    // Elevate the 3 most recent readings (current = median of the 3 most
    // recent, not just today's single reading, under the new semantics).
    rows[0]!.restingHeartRate = 56;
    rows[1]!.restingHeartRate = 56;
    rows[2]!.restingHeartRate = 56;
    const r = computeRestingHr(rows, TODAY);
    expect(r.status === "ok" && r.value.deltaBpm).toBe(6);
  });
  it("hrv trend needs 17 readings (7 recent + 10 baseline)", () => {
    const r = computeHrvTrend(health(16, 50, 60), TODAY);
    expect(r.status).toBe("insufficient_data");
    expect(r.status === "insufficient_data" && r.needed).toBe(17);
  });
  it("counts consecutive hard days", () => {
    const r = computeHardDayStacking(["2026-08-01", "2026-07-31", "2026-07-30", "2026-07-28"], TODAY);
    expect(r.status === "ok" && r.value.consecutive).toBe(3);
  });
});

describe("discipline + performance", () => {
  it("easy discipline is the Z1-2 share", () => {
    const runs = [
      { activityId: "a1", date: "2026-07-01", avgHr: 130 },
      { activityId: "a2", date: "2026-07-02", avgHr: 135 },
      { activityId: "a3", date: "2026-07-03", avgHr: 138 },
      { activityId: "a4", date: "2026-07-04", avgHr: 140 },
      { activityId: "a5", date: "2026-07-05", avgHr: 175 },
    ];
    const r = computeEasyDiscipline(runs, 190); // 0.80*190 = 152 cutoff; 4 of 5 under
    expect(r.status === "ok" && r.value.inEasyPct).toBe(80);
  });
});

describe("easyCeiling", () => {
  it("is the top of zone 2 (80% of HRmax)", async () => {
    const { easyCeiling, zoneOf } = await import("../src/hrZones.js");
    const hrMax = 190;
    const c = easyCeiling(hrMax);
    expect(c).toBe(152);
    // Everything at/below the ceiling is Z1–2; just above is Z3.
    expect(zoneOf(c - 1, hrMax)).toBeLessThanOrEqual(2);
    expect(zoneOf(c + 1, hrMax)).toBe(3);
  });
});

describe("load ratio honesty", () => {
  it("suppresses instead of reporting a confident-looking ratio when all history is stale", async () => {
    const { computeLoadRatio } = await import("../src/load.js");
    // Runs exist, but all of them are older than the 28-day recent window —
    // the old ACWR regime here would silently 2x-inflate a chronic average
    // computed from a mostly-empty window instead of admitting it has no
    // recent baseline.
    const stale = [
      { date: "2026-04-01", load: 80 },
      { date: "2026-04-10", load: 60 },
      { date: "2026-04-20", load: 70 },
    ];
    const r = computeLoadRatio(stale, "2026-08-01");
    expect(r.status).toBe("insufficient_data");
  });

  it("still computes a real ratio when the recent window has data", async () => {
    const { computeLoadRatio } = await import("../src/load.js");
    const days = [
      { date: "2026-07-05", load: 60 },
      { date: "2026-07-12", load: 70 },
      { date: "2026-07-20", load: 80 },
      { date: "2026-07-28", load: 90 },
      { date: "2026-08-01", load: 100 },
    ];
    const r = computeLoadRatio(days, "2026-08-01");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.value.ratio).toBeGreaterThan(0);
  });
});
