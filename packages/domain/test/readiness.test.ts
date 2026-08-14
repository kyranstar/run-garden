/**
 * The readiness verdict (garden dock, 2026-08-14).
 *
 * Two things are load-bearing and get the most coverage: the WITHHOLD cases
 * (a verdict nobody can trust is worse than no card) and the zero/NaN guards
 * — COROS sends 0 for metrics it hasn't computed, and a 0 HRV read as a real
 * value would headline "poor" on a perfectly good morning.
 *
 * Numbers below are shaped after live prod rows (2026-08-14: HRV 64, RHR 47,
 * recovery 100, 14-day medians ≈ 62.5 HRV / 46.5 RHR).
 */
import { describe, expect, it } from "vitest";
import { readinessVerdict, type ReadinessSignals } from "../src/readiness.js";

const signals = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({
  hrv: 64,
  hrvBaseline: 62,
  restingHeartRate: 47,
  rhrBaseline: 46,
  recoveryScore: 100,
  sampleDays: 14,
  ...over,
});

describe("readinessVerdict — levels", () => {
  it("calls a normal morning good, and carries the numbers as evidence", () => {
    // Live prod shape: everything sits on its own baseline.
    expect(readinessVerdict(signals())).toEqual({
      level: "good",
      reasons: ["HRV 64 (base 62)", "RHR 47 (base 46)", "recovery 100%"],
    });
  });

  it("HRV a little under baseline is caution; well under is poor", () => {
    // 6% below (58/62) → caution; 11% below (55/62) → poor.
    expect(readinessVerdict(signals({ hrv: 58 }))).toMatchObject({ level: "caution" });
    expect(readinessVerdict(signals({ hrv: 55 }))).toMatchObject({
      level: "poor",
      reasons: ["HRV 11% below your baseline", "RHR 47 (base 46)", "recovery 100%"],
    });
  });

  it("resting HR elevation is measured in absolute bpm", () => {
    expect(readinessVerdict(signals({ restingHeartRate: 50 }))).toMatchObject({
      level: "caution",
      reasons: ["RHR 4 bpm above your baseline", "HRV 64 (base 62)", "recovery 100%"],
    });
    expect(readinessVerdict(signals({ restingHeartRate: 53 }))).toMatchObject({ level: "poor" });
    // Below baseline is never a warning — a low resting HR is a good morning.
    expect(readinessVerdict(signals({ restingHeartRate: 39 }))).toMatchObject({ level: "good" });
  });

  it("COROS recovery alone can set either warning level", () => {
    expect(readinessVerdict(signals({ recoveryScore: 55 }))).toMatchObject({
      level: "caution",
      reasons: ["recovery 55%", "HRV 64 (base 62)", "RHR 47 (base 46)"],
    });
    expect(readinessVerdict(signals({ recoveryScore: 20 }))).toMatchObject({ level: "poor" });
    expect(readinessVerdict(signals({ recoveryScore: 60 }))).toMatchObject({ level: "good" });
  });

  it("the worst signal wins, and it leads the reasons", () => {
    const v = readinessVerdict(signals({ hrv: 58, restingHeartRate: 55, recoveryScore: 90 }))!;
    expect(v.level).toBe("poor"); // RHR +9 outranks HRV's caution
    expect(v.reasons[0]).toBe("RHR 9 bpm above your baseline");
    expect(v.reasons[1]).toBe("HRV 6% below your baseline");
    expect(v.reasons[2]).toBe("recovery 90%");
  });

  it("thresholds sit exactly where they are documented", () => {
    // HRV: 5% caution, 10% poor (baseline 100 makes the percent literal).
    const hrvAt = (v: number) =>
      readinessVerdict({ hrv: v, hrvBaseline: 100, sampleDays: 14 })!.level;
    expect(hrvAt(96)).toBe("good");
    expect(hrvAt(95)).toBe("caution");
    expect(hrvAt(91)).toBe("caution");
    expect(hrvAt(90)).toBe("poor");
    // RHR: +4 caution, +7 poor.
    const rhrAt = (v: number) =>
      readinessVerdict({ restingHeartRate: v, rhrBaseline: 46, sampleDays: 14 })!.level;
    expect(rhrAt(49)).toBe("good");
    expect(rhrAt(50)).toBe("caution");
    expect(rhrAt(52)).toBe("caution");
    expect(rhrAt(53)).toBe("poor");
    // Recovery: <60 caution, <33 poor.
    const recAt = (v: number) => readinessVerdict({ recoveryScore: v, sampleDays: 14 })!.level;
    expect(recAt(60)).toBe("good");
    expect(recAt(59)).toBe("caution");
    expect(recAt(33)).toBe("caution");
    expect(recAt(32)).toBe("poor");
  });
});

describe("readinessVerdict — withholding", () => {
  it("says nothing under three days of data, however good the numbers look", () => {
    expect(readinessVerdict(signals({ sampleDays: 2 }))).toBeNull();
    expect(readinessVerdict(signals({ sampleDays: 0 }))).toBeNull();
    expect(readinessVerdict(signals({ sampleDays: 3 }))).not.toBeNull();
  });

  it("says nothing with no reading at all", () => {
    expect(
      readinessVerdict({
        hrv: null,
        hrvBaseline: 62,
        restingHeartRate: null,
        rhrBaseline: 46,
        recoveryScore: null,
        sampleDays: 14,
      }),
    ).toBeNull();
    expect(readinessVerdict({ sampleDays: 14 })).toBeNull();
  });

  it("says nothing when the readings have nothing to be judged against", () => {
    // Numbers without baselines and without a COROS score are data, not a
    // verdict — this is the case that would otherwise print "Good to go" off
    // no comparison whatsoever.
    expect(
      readinessVerdict({ hrv: 64, restingHeartRate: 47, sampleDays: 14 }),
    ).toBeNull();
  });

  it("but shows those bare readings as context once something IS judgeable", () => {
    const v = readinessVerdict({ hrv: 64, restingHeartRate: 47, recoveryScore: 100, sampleDays: 14 })!;
    expect(v.level).toBe("good");
    expect(v.reasons).toEqual(["recovery 100%", "HRV 64", "RHR 47"]);
  });

  it("a nonsense sampleDays is thin evidence, not a pass", () => {
    expect(readinessVerdict(signals({ sampleDays: Number.NaN }))).toBeNull();
  });
});

describe("readinessVerdict — zero/NaN guards", () => {
  it("a COROS 0 is 'not computed', never a real value", () => {
    // 0 HRV against a 62 baseline would otherwise be a 100% drop → poor.
    expect(readinessVerdict(signals({ hrv: 0, recoveryScore: null, restingHeartRate: null }))).toBeNull();
    // 0 recovery is COROS's blank, not a rest-day emergency.
    expect(readinessVerdict({ recoveryScore: 0, sampleDays: 14 })).toBeNull();
    expect(readinessVerdict(signals({ recoveryScore: 0 }))).toMatchObject({ level: "good" });
    // A 0 BASELINE can't divide, and must not: no comparison, no claim.
    expect(
      readinessVerdict({ hrv: 64, hrvBaseline: 0, sampleDays: 14 }),
    ).toBeNull();
  });

  it("NaN/Infinity/negatives never reach a verdict", () => {
    for (const junk of [Number.NaN, Infinity, -Infinity, -12]) {
      expect(readinessVerdict({ hrv: junk, hrvBaseline: 62, sampleDays: 14 })).toBeNull();
      expect(readinessVerdict({ hrv: 64, hrvBaseline: junk, sampleDays: 14 })).toBeNull();
      expect(readinessVerdict({ restingHeartRate: junk, rhrBaseline: 46, sampleDays: 14 })).toBeNull();
      expect(readinessVerdict({ recoveryScore: junk, sampleDays: 14 })).toBeNull();
    }
  });

  it("physiologically impossible readings are dropped, not judged", () => {
    // A unit slip (HRV in seconds, HR in a corrupted row) must not headline.
    expect(readinessVerdict({ hrv: 4000, hrvBaseline: 62, sampleDays: 14 })).toBeNull();
    expect(readinessVerdict({ restingHeartRate: 300, rhrBaseline: 46, sampleDays: 14 })).toBeNull();
    expect(readinessVerdict({ recoveryScore: 900, sampleDays: 14 })).toBeNull();
    // And dropping one signal leaves the others to speak for themselves.
    expect(readinessVerdict(signals({ hrv: 4000 }))).toMatchObject({
      level: "good",
      reasons: ["RHR 47 (base 46)", "recovery 100%"],
    });
  });
});
