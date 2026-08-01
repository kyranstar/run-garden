import { describe, expect, it } from "vitest";
import type { TimeOfDayPair } from "../src/timeOfDay.js";
import { computeTimeOfDay } from "../src/timeOfDay.js";
import { mkActivity, mkWorkout } from "./builders.js";

function pair(
  id: string,
  date: string,
  time: string,
  state: "completed" | "missed" | "skipped" | "scheduled",
  actualStartLocal?: string,
): TimeOfDayPair {
  const p: TimeOfDayPair = {
    workout: mkWorkout({ id, effectiveDate: date, effectiveTime: time, completionState: state }),
  };
  if (actualStartLocal) p.activity = mkActivity({ id: `act-${id}`, startTimeLocal: actualStartLocal });
  return p;
}

describe("computeTimeOfDay", () => {
  const richPairs: TimeOfDayPair[] = [
    pair("m1", "2026-03-02", "07:00", "completed", "2026-03-02T07:20:00"),
    pair("m2", "2026-03-03", "07:00", "completed", "2026-03-03T06:50:00"),
    pair("m3", "2026-03-04", "07:00", "completed"),
    pair("m4", "2026-03-05", "07:00", "missed"),
    pair("e1", "2026-03-02", "18:00", "completed"),
    pair("e2", "2026-03-03", "18:00", "completed"),
    pair("e3", "2026-03-04", "18:00", "skipped"),
    pair("e4", "2026-03-05", "18:00", "missed"),
  ];

  it("computes morning vs evening completion rates", () => {
    const result = computeTimeOfDay(richPairs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.morning).toEqual({ planned: 4, completed: 3, rate: 0.75 });
    expect(result.value.evening).toEqual({ planned: 4, completed: 2, rate: 0.5 });
    expect(result.sampleSize).toBe(8);
  });

  it("makes no physiological claims: the note is exactly the factual comparison", () => {
    const result = computeTimeOfDay(richPairs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.comparisonNote).toBe(
      "You complete 75% of morning runs vs 50% of evening runs.",
    );
  });

  it("computes the median |actual - scheduled| minutes from local times, skipping pairs without them", () => {
    const result = computeTimeOfDay(richPairs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // m1: 20 min late, m2: 10 min early -> median 15; others lack startTimeLocal
    expect(result.value.medianStartDeltaMinutes).toBe(15);
  });

  it("suppresses below 6 resolved planned workouts", () => {
    const thin = richPairs.slice(0, 5);
    expect(computeTimeOfDay(thin)).toMatchObject({ status: "insufficient_data", needed: 6, have: 5 });
  });

  it("ignores rest days and still-future workouts when counting samples", () => {
    const withNoise = [
      ...richPairs,
      pair("future", "2026-04-01", "07:00", "scheduled"),
      { workout: mkWorkout({ id: "rest", category: "rest", completionState: "missed" }) },
    ];
    const result = computeTimeOfDay(withNoise);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.sampleSize).toBe(8);
  });
});
