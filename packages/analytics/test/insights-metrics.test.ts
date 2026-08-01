import { describe, expect, it } from "vitest";
import {
  computeAcwr,
  computeBalance,
  computeEasyDiscipline,
  computeHardDayStacking,
  computeHrvTrend,
  computeRampRate,
  computeRestingHr,
  interpret,
  negativeSplit,
  predictRaces,
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
  it("computes ACWR over sufficient history", () => {
    const today = "2026-08-01";
    const days: { date: string; load: number }[] = [];
    // 28 days, 50/day chronic, last 7 days bumped to ~57 each for a mild ramp.
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, load: i < 7 ? 57 : 50 });
    }
    const r = computeAcwr(days, today);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      // acute = 7*57 = 399; chronic = (7*57 + 21*50)/4 = (399+1050)/4 = 362.25
      expect(r.value.acwr).toBeCloseTo(399 / 362.25, 2);
    }
  });
  it("suppresses ACWR without enough history", () => {
    const r = computeAcwr([{ date: "2026-08-01", load: 50 }], "2026-08-01");
    expect(r.status).toBe("insufficient_data");
  });
  it("ramp rate is week over week", () => {
    const r = computeRampRate([3600, 3600, 3960]);
    expect(r.status === "ok" && r.value.pct).toBe(10);
  });
  it("balance sums to ~100%", () => {
    const r = computeBalance({ easy: 6000, quality: 2000, long: 2000 }, 6);
    if (r.status === "ok") {
      expect(r.value.easyPct + r.value.qualityPct + r.value.longPct).toBe(100);
      expect(r.value.easyPct).toBe(60);
    }
  });
});

describe("recovery", () => {
  const health = (n: number, rhr: number, hrv: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.parse("2026-08-01") - i * 86_400_000).toISOString().slice(0, 10),
      restingHeartRate: rhr,
      hrv,
    }));
  it("resting HR delta vs baseline", () => {
    const rows = health(10, 50, 60);
    rows[0]!.restingHeartRate = 56; // today elevated
    const r = computeRestingHr(rows);
    expect(r.status === "ok" && r.value.deltaBpm).toBe(6);
  });
  it("hrv trend needs 7 days", () => {
    expect(computeHrvTrend(health(3, 50, 60)).status).toBe("insufficient_data");
  });
  it("counts consecutive hard days", () => {
    const r = computeHardDayStacking(["2026-08-01", "2026-07-31", "2026-07-30", "2026-07-28"], "2026-08-01");
    expect(r.status === "ok" && r.value.consecutive).toBe(3);
  });
});

describe("discipline + performance", () => {
  it("easy discipline is the Z1-2 share", () => {
    const runs = [{ avgHr: 130 }, { avgHr: 135 }, { avgHr: 138 }, { avgHr: 140 }, { avgHr: 175 }];
    const r = computeEasyDiscipline(runs, 190); // 0.80*190 = 152 cutoff; 4 of 5 under
    expect(r.status === "ok" && r.value.inEasyPct).toBe(80);
  });
  it("riegel scales 5k to longer", () => {
    const r = predictRaces({ distanceMeters: 5000, durationSeconds: 1200 }); // 20:00 5k
    if (r.status === "ok") {
      expect(r.value.k10).toBeGreaterThan(2400); // >2x due to fatigue exponent
      expect(r.value.k10).toBeLessThan(2600);
    }
  });
  it("negative split fraction", () => {
    const runs = [
      { firstHalfPace: 300, secondHalfPace: 290 },
      { firstHalfPace: 300, secondHalfPace: 310 },
      { firstHalfPace: 300, secondHalfPace: 295 },
      { firstHalfPace: 300, secondHalfPace: 305 },
    ];
    expect(negativeSplit(runs).status === "ok" && negativeSplit(runs).status === "ok").toBe(true);
    const r = negativeSplit(runs);
    expect(r.status === "ok" && r.value.negativePct).toBe(50);
  });
});
