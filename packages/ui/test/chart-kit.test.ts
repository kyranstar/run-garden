import { describe, expect, it } from "vitest";
import { dateX, niceTicks, rollingMedian } from "../src/chart-kit.js";

describe("niceTicks", () => {
  it("steps by 0.05 across a tight pace-like range (default count ~3)", () => {
    // lo/hi straddle a 0.12 span; the nicest step in {1,2,2.5,5,10}x10^k for
    // a ~2-interval target is 0.05 (residual 6 falls in the "5" bucket).
    expect(niceTicks(1.07, 1.19)).toEqual([1.05, 1.1, 1.15, 1.2]);
  });

  it("covers an hours axis starting at zero", () => {
    expect(niceTicks(0, 7.3)).toEqual([0, 5, 10]);
  });

  it("returns the single value for a degenerate lo === hi range", () => {
    expect(niceTicks(42, 42)).toEqual([42]);
    expect(niceTicks(0, 0)).toEqual([0]);
  });

  it("honors an explicit tick count", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
  });

  it("lands on the 2.5-family step for a symmetric negative/positive range", () => {
    expect(niceTicks(-3, 3)).toEqual([-5, -2.5, 0, 2.5, 5]);
  });

  it("produces a clean half-step for a 0..1 range", () => {
    expect(niceTicks(0, 1)).toEqual([0, 0.5, 1]);
  });

  it("keeps two-decimal precision for a quarter-step range", () => {
    expect(niceTicks(5, 5.6)).toEqual([5, 5.25, 5.5, 5.75]);
  });

  it("always returns ascending ticks that fully cover [lo, hi]", () => {
    const ticks = niceTicks(3.4, 91.2, 4);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    }
    expect(ticks[0]!).toBeLessThanOrEqual(3.4);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(91.2);
  });

  it("is defensive about a reversed lo/hi argument order", () => {
    expect(niceTicks(7.3, 0)).toEqual(niceTicks(0, 7.3));
  });
});

describe("rollingMedian", () => {
  it("stays flat through an alternating [1,9,1,9,1] with the default window of 5", () => {
    // Centered, symmetrically-shrinking window (see file header for the
    // exact rule): every index's window is dominated by the three 1s, so
    // the median is 1 everywhere.
    expect(rollingMedian([1, 9, 1, 9, 1])).toEqual([1, 1, 1, 1, 1]);
    expect(rollingMedian([1, 9, 1, 9, 1], 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("shrinks the window symmetrically at the edges for window=3", () => {
    // i=0: k=min(1,0,6)=0 -> [5]                -> 5
    // i=1: k=min(1,1,5)=1 -> [5,3,8]  sorted 3,5,8 -> 5
    // i=2: k=min(1,2,4)=1 -> [3,8,1]  sorted 1,3,8 -> 3
    // i=3: k=min(1,3,3)=1 -> [8,1,9]  sorted 1,8,9 -> 8
    // i=4: k=min(1,4,2)=1 -> [1,9,2]  sorted 1,2,9 -> 2
    // i=5: k=min(1,5,1)=1 -> [9,2,7]  sorted 2,7,9 -> 7
    // i=6: k=min(1,6,0)=0 -> [7]                -> 7
    expect(rollingMedian([5, 3, 8, 1, 9, 2, 7], 3)).toEqual([5, 5, 3, 8, 2, 7, 7]);
  });

  it("returns the input unchanged when window can never exceed 1 element on either side", () => {
    expect(rollingMedian([4], 5)).toEqual([4]);
    expect(rollingMedian([1, 2], 5)).toEqual([1, 2]);
  });

  it("returns an empty array for an empty input", () => {
    expect(rollingMedian([], 5)).toEqual([]);
  });

  it("never yields undefined entries for a misuse-only negative window (half-width clamps to 0)", () => {
    const result = rollingMedian([1, 2, 3, 4, 5], -3);
    expect(result).toEqual([1, 2, 3, 4, 5]);
    expect(result.every((v) => typeof v === "number")).toBe(true);
  });

  it("always returns the same length as the input", () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    expect(rollingMedian(values).length).toBe(values.length);
    expect(rollingMedian(values, 3).length).toBe(values.length);
  });
});

describe("dateX", () => {
  it("spaces points proportionally to elapsed time, not index", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-05"];
    const x = dateX(dates, 100, 0);
    // 1 day of 4 total -> 25; 4 days of 4 total -> 100.
    expect(x("2026-01-01")).toBe(0);
    expect(x("2026-01-02")).toBe(25);
    expect(x("2026-01-05")).toBe(100);
  });

  it("offsets by `left`", () => {
    const dates = ["2026-01-01", "2026-01-05"];
    const x = dateX(dates, 100, 10);
    expect(x("2026-01-01")).toBe(10);
    expect(x("2026-01-05")).toBe(110);
  });

  it("centers a single-date domain regardless of `left`/innerW", () => {
    const x = dateX(["2026-03-10"], 100, 10);
    expect(x("2026-03-10")).toBe(60);
  });

  it("centers an empty domain", () => {
    const x = dateX([], 100, 10);
    expect(x("2026-01-01")).toBe(60);
  });

  it("centers when every date in the domain is identical (zero span)", () => {
    const x = dateX(["2026-02-01", "2026-02-01", "2026-02-01"], 40, 0);
    expect(x("2026-02-01")).toBe(20);
  });
});
