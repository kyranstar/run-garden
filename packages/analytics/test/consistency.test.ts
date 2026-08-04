import { describe, expect, it } from "vitest";
import { computeConsistency } from "../src/consistency.js";
import { mkWorkout } from "./builders.js";

const range = { start: "2026-03-02", end: "2026-03-08" };
const today = "2026-03-08";

describe("computeConsistency", () => {
  it("counts moved-but-completed as both completed and moved, not a failure", () => {
    const report = computeConsistency(
      [
        mkWorkout({
          id: "w1",
          originalPlanDate: "2026-03-03",
          effectiveDate: "2026-03-05",
          completionState: "completed",
        }),
      ],
      range,
      today,
    );
    expect(report.planned).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.moved).toBe(1);
    expect(report.adherenceRate).toBe(1);
  });

  it("excludes rest-day workouts from planned counts", () => {
    const report = computeConsistency(
      [
        mkWorkout({ id: "w1", effectiveDate: "2026-03-02", completionState: "completed" }),
        mkWorkout({ id: "r1", effectiveDate: "2026-03-03", category: "rest", completionState: "missed" }),
      ],
      range,
      today,
    );
    expect(report.planned).toBe(1);
    expect(report.missed).toBe(0);
    expect(report.adherenceRate).toBe(1);
  });

  it("does not count still-future workouts against adherence", () => {
    const report = computeConsistency(
      [
        mkWorkout({ id: "w1", effectiveDate: "2026-03-02", completionState: "completed" }),
        mkWorkout({ id: "w2", effectiveDate: "2026-03-03", completionState: "skipped" }),
        mkWorkout({ id: "w3", effectiveDate: "2026-03-07", completionState: "scheduled" }),
        mkWorkout({ id: "w4", effectiveDate: "2026-03-08", completionState: "scheduled" }),
      ],
      range,
      today,
    );
    expect(report.planned).toBe(4);
    expect(report.completed).toBe(1);
    expect(report.skipped).toBe(1);
    // denominator is 2 resolved workouts, not 4
    expect(report.adherenceRate).toBe(0.5);
  });

  it("guards division by zero when everything is still in the future", () => {
    const report = computeConsistency(
      [mkWorkout({ id: "w1", effectiveDate: "2026-03-05", completionState: "scheduled" })],
      range,
      today,
    );
    expect(report.adherenceRate).toBe(0);
  });

  it("tallies unresolved and missed states", () => {
    const report = computeConsistency(
      [
        mkWorkout({ id: "w1", effectiveDate: "2026-03-02", completionState: "unresolved" }),
        mkWorkout({ id: "w2", effectiveDate: "2026-03-03", completionState: "missed" }),
        mkWorkout({ id: "w3", effectiveDate: "2026-03-04", completionState: "provisionally_completed" }),
      ],
      range,
      today,
    );
    expect(report.unresolved).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.missed).toBe(1);
    expect(report.completed).toBe(1); // provisionally completed counts as completed
  });

  it("builds a correct weekly breakdown across a month boundary", () => {
    // Two ISO weeks: Mon 2026-03-23..Sun 2026-03-29 and Mon 2026-03-30..Sun 2026-04-05.
    const monthRange = { start: "2026-03-23", end: "2026-04-05" };
    const report = computeConsistency(
      [
        mkWorkout({ id: "a", effectiveDate: "2026-03-24", completionState: "completed" }),
        mkWorkout({ id: "b", effectiveDate: "2026-03-28", completionState: "missed" }),
        mkWorkout({ id: "c", effectiveDate: "2026-03-31", completionState: "completed" }),
        mkWorkout({ id: "d", effectiveDate: "2026-04-02", completionState: "completed" }),
        mkWorkout({ id: "e", effectiveDate: "2026-04-04", completionState: "skipped" }),
      ],
      monthRange,
      "2026-04-05",
    );
    expect(report.weeklyBreakdown).toEqual([
      { weekStart: "2026-03-23", planned: 2, completed: 1, adherence: 0.5 },
      { weekStart: "2026-03-30", planned: 3, completed: 2, adherence: 2 / 3 },
    ]);
  });

  it("supports 12-week adherence by passing a 12-week range", () => {
    const start = "2026-01-05"; // a Monday
    const workouts = Array.from({ length: 12 }, (_, i) =>
      mkWorkout({ id: `w${i}`, effectiveDate: addDaysLocal(start, i * 7 + 1), completionState: "completed" }),
    );
    const report = computeConsistency(workouts, { start, end: "2026-03-29" }, "2026-03-29");
    expect(report.weeklyBreakdown).toHaveLength(12);
    expect(report.weeklyBreakdown.every((w) => w.adherence === 1)).toBe(true);
  });
});

function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
