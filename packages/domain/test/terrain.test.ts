/**
 * Terrain comparison (2026-08-14). The athlete's real numbers: recent runs
 * sit between 1 and 22 m/km, so both the flat-noise floor and the genuinely
 * hilly case are live concerns, not hypotheticals.
 */
import { describe, expect, it } from "vitest";
import { compareTerrain, metresPerKm, raceMetresPerKm } from "../src/terrain.js";

describe("metresPerKm", () => {
  it("is climb over distance, and refuses to judge a jog round the block", () => {
    // Live prod row: 9.5 km with 119 m of climb.
    expect(metresPerKm(119, 9500)).toBeCloseTo(12.5, 1);
    expect(metresPerKm(8, 7900)).toBeCloseTo(1, 1);
    expect(metresPerKm(10, 400)).toBeNull();
    expect(metresPerKm(Number.NaN, 5000)).toBeNull();
  });
});

describe("raceMetresPerKm", () => {
  it("prefers the course's real climb over a category guess", () => {
    expect(raceMetresPerKm(120, "flat", 10)).toBe(12);
    expect(raceMetresPerKm(null, "rolling", 10)).toBe(12);
    expect(raceMetresPerKm(null, "hilly", 10)).toBe(25);
    // A climb figure without a distance can't become a rate.
    expect(raceMetresPerKm(120, null, null)).toBeNull();
    expect(raceMetresPerKm(null, null, 10)).toBeNull();
  });
});

describe("compareTerrain", () => {
  it("flags training that is materially flatter than the course", () => {
    const c = compareTerrain(6, 12)!;
    expect(c.ratio).toBe(2);
    expect(c.verdict).toBe("under_prepared");
  });

  it("leaves a reasonable match alone", () => {
    expect(compareTerrain(10, 12)!.verdict).toBe("matched");
    expect(compareTerrain(12, 10)!.verdict).toBe("matched");
  });

  it("notices training hillier than the race", () => {
    expect(compareTerrain(22, 4)!.verdict).toBe("over_prepared");
  });

  it("two flat things are matched, not a divide-by-almost-zero drama", () => {
    const c = compareTerrain(0.4, 1)!;
    expect(c.verdict).toBe("matched");
    expect(c.ratio).toBeNull();
  });

  it("flat training for a climbing course is under-prepared without a ratio", () => {
    const c = compareTerrain(0.8, 14)!;
    expect(c.verdict).toBe("under_prepared");
    expect(c.ratio).toBeNull();
  });

  it("returns null when either side is unknown", () => {
    expect(compareTerrain(null, 12)).toBeNull();
    expect(compareTerrain(6, null)).toBeNull();
  });
});
