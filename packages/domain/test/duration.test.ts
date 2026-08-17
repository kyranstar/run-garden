/**
 * The one vocabulary for a prescribed duration.
 *
 * These cases are prod's own stage durations, measured 2026-08-17 across the
 * athlete's whole library (244 time-based stages): 15s ×10, 30s ×10, 45s ×12,
 * 60s ×18, 90s ×13, 120s ×6, and 181 other whole minutes. Every value below
 * that used to be wrong is named here, because the old assertions pinned the
 * bug ("0 min") rather than the contract.
 */
import { describe, expect, it } from "vitest";
import { formatDurationShort, formatStageDuration } from "../src/duration.js";

describe("formatStageDuration", () => {
  it("says seconds under a minute — a 15s stride is not '0 min'", () => {
    expect(formatStageDuration(15)).toBe("15s");
    expect(formatStageDuration(30)).toBe("30s");
    expect(formatStageDuration(45)).toBe("45s");
    expect(formatStageDuration(59)).toBe("59s");
  });

  it("gives a 45s recovery and a 60s cooldown DIFFERENT strings", () => {
    // Both were "1 min", so prod's stored summary said "1 min Cool Down" and
    // "1 min Rest" for stages that differ by a third.
    expect(formatStageDuration(45)).not.toBe(formatStageDuration(60));
  });

  it("keeps a 30s/60s strides block's 1:2 ratio visible", () => {
    // Live prod row 0a66a4b3 (2026-09-24): rounding printed "1 min / 1 min".
    expect(formatStageDuration(30)).toBe("30s");
    expect(formatStageDuration(60)).toBe("1 min");
  });

  it("spells whole minutes exactly as it always did", () => {
    // 181 of prod's 244 time stages. The fix must not churn a single one.
    expect(formatStageDuration(60)).toBe("1 min");
    expect(formatStageDuration(120)).toBe("2 min");
    expect(formatStageDuration(300)).toBe("5 min");
    expect(formatStageDuration(900)).toBe("15 min");
    expect(formatStageDuration(2400)).toBe("40 min");
  });

  it("keeps the interval idiom up to 90s, then goes to minutes and seconds", () => {
    expect(formatStageDuration(90)).toBe("90s"); // 13 prod recovery stages
    expect(formatStageDuration(91)).toBe("1:31");
    expect(formatStageDuration(105)).toBe("1:45");
    expect(formatStageDuration(150)).toBe("2:30");
    expect(formatStageDuration(255)).toBe("4:15");
    expect(formatStageDuration(3661)).toBe("61:01");
  });

  it("pads the seconds so 2:05 can never read as 2:5", () => {
    expect(formatStageDuration(125)).toBe("2:05");
  });

  it("never invents a duration for zero or nonsense", () => {
    expect(formatStageDuration(0)).toBe("0s");
    expect(formatStageDuration(-30)).toBe("0s");
    expect(formatStageDuration(14.6)).toBe("15s");
  });
});

describe("formatDurationShort", () => {
  it("spells sub-minute spans the same way the stage formatter does", () => {
    expect(formatDurationShort(45)).toBe("45s");
  });

  it("still rolls an elapsed span into hours", () => {
    expect(formatDurationShort(3240)).toBe("54 min");
    expect(formatDurationShort(4740)).toBe("1 h 19 min");
    expect(formatDurationShort(7200)).toBe("2 h");
  });
});
