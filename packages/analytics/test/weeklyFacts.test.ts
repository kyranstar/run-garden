import { describe, expect, it } from "vitest";
import { computeWeeklyFacts } from "../src/weeklyFacts.js";
import { mkActivity, mkWorkout } from "./builders.js";

const range = { start: "2026-03-02", end: "2026-03-08" };

describe("computeWeeklyFacts", () => {
  it("returns the exact fact object for a constructed week", () => {
    const facts = computeWeeklyFacts({
      range,
      workouts: [
        mkWorkout({ id: "easy", category: "easy", effectiveDate: "2026-03-02", completionState: "skipped" }),
        mkWorkout({
          id: "long",
          category: "long",
          originalPlanDate: "2026-03-07",
          effectiveDate: "2026-03-08",
          completionState: "completed",
        }),
        mkWorkout({ id: "quality", category: "quality", effectiveDate: "2026-03-04", completionState: "completed" }),
        mkWorkout({ id: "rest", category: "rest", effectiveDate: "2026-03-06", completionState: "missed" }),
      ],
      activities: [
        mkActivity({ id: "a1", durationSeconds: 3600, distanceMeters: 10_000 }),
        mkActivity({ id: "a2", durationSeconds: 5400, distanceMeters: 16_000 }),
      ],
      garden: { plantsAdded: 2, wildlife: 1 },
      records: [
        {
          id: "fastest_comeback_days",
          title: "Fastest comeback",
          value: "4 days",
          achievedOn: "2026-03-07",
          rule: "Fewest days from the first run after a break of 7+ days until three runs each within 3 days of the previous.",
        },
      ],
    });

    expect(facts).toEqual({
      weekStart: "2026-03-02",
      planned: 3,
      completed: 2,
      moved: 1,
      skipped: 1,
      totalDurationSeconds: 9000,
      totalDistanceMeters: 26_000,
      qualitySessions: 1,
      longRunCompleted: true,
      adherencePct: 67,
      notableRecord: "Fastest comeback: 4 days",
      gardenSummary: "2 new plants took root; 1 wildlife visitor arrived",
    });
  });

  it("stays deterministic and quiet when nothing happened", () => {
    const facts = computeWeeklyFacts({
      range,
      workouts: [],
      activities: [],
      garden: { plantsAdded: 0, wildlife: 0 },
    });
    expect(facts.planned).toBe(0);
    expect(facts.adherencePct).toBe(0);
    expect(facts.longRunCompleted).toBe(false);
    expect(facts.notableRecord).toBeUndefined();
    expect(facts.gardenSummary).toBe("A quiet week in the garden");
  });

  it("ignores records achieved outside the week", () => {
    const facts = computeWeeklyFacts({
      range,
      workouts: [],
      activities: [],
      garden: { plantsAdded: 1, wildlife: 0 },
      records: [
        {
          id: "best_aerobic_efficiency",
          title: "Best aerobic efficiency",
          value: "1.38 m/beat",
          achievedOn: "2026-02-01",
          rule: "Highest meters per heart beat on eligible easy runs.",
        },
      ],
    });
    expect(facts.notableRecord).toBeUndefined();
    expect(facts.gardenSummary).toBe("1 new plant took root");
  });
});
