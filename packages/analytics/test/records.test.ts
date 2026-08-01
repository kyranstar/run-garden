import { describe, expect, it } from "vitest";
import type { ExecutionInput } from "../src/execution.js";
import type { RecordsInput, RunSample } from "../src/records.js";
import { computeRecords } from "../src/records.js";
import { mkActivity, mkLap, mkStage, mkWorkout } from "./builders.js";

function easyRun(id: string, date: string, hr: number, pace = 300): RunSample {
  return {
    activity: mkActivity({
      id,
      startTimeLocal: `${date}T07:00:00`,
      durationSeconds: 1800,
      distanceMeters: 6000,
      avgHeartRate: hr,
      avgPaceSecPerKm: pace,
    }),
    laps: [],
    category: "easy",
  };
}

function intervalExecution(id: string, date: string, workPaces: number[]): ExecutionInput {
  const workout = mkWorkout({
    id,
    effectiveDate: date,
    category: "quality",
    stages: [
      mkStage({ id: `${id}-rep`, order: 0, kind: "repeat", repeatCount: workPaces.length, durationType: "none" }),
      mkStage({ id: `${id}-work`, order: 0, parentStageId: `${id}-rep`, kind: "work", durationSeconds: 300 }),
    ],
  });
  return { workout, laps: workPaces.map((p, i) => mkLap(id, i, { avgPaceSecPerKm: p })) };
}

const fullInput: RecordsInput = {
  runs: [
    easyRun("r1", "2026-01-05", 150),
    easyRun("r2", "2026-01-07", 148),
    easyRun("r3", "2026-01-09", 152),
    easyRun("r4", "2026-01-11", 145),
    easyRun("r5", "2026-01-13", 149),
  ],
  executions: [
    intervalExecution("e1", "2026-01-06", [240, 240, 240, 240]),
    intervalExecution("e2", "2026-01-13", [240, 250, 240, 250]),
    intervalExecution("e3", "2026-01-20", [240, 260, 250, 255]),
  ],
  weeklyAdherence: [
    { weekStart: "2026-01-05", adherence: 1 },
    { weekStart: "2026-01-12", adherence: 0.8 },
    { weekStart: "2026-01-19", adherence: 1 },
    { weekStart: "2026-01-26", adherence: 1 },
    { weekStart: "2026-02-02", adherence: 0.75 },
    { weekStart: "2026-02-09", adherence: 1 },
    { weekStart: "2026-02-16", adherence: 1 },
    { weekStart: "2026-02-23", adherence: 1 },
  ],
  completedRunDates: ["2026-01-01", "2026-01-03", "2026-01-15", "2026-01-17", "2026-01-19"],
};

describe("computeRecords", () => {
  it("produces every record when enough history exists, with deterministic rules", () => {
    const records = computeRecords(fullInput);
    expect(records.map((r) => r.id)).toEqual([
      "best_aerobic_efficiency",
      "lowest_hr_at_comparable_pace",
      "most_even_interval_set",
      "most_consistent_four_weeks",
      "fastest_comeback_days",
    ]);

    const byId = new Map(records.map((r) => [r.id, r]));
    // Best efficiency: (6000/1800)/145 * 60 = 1.379... on the hr-145 run
    expect(byId.get("best_aerobic_efficiency")).toMatchObject({
      value: "1.38 m/beat",
      achievedOn: "2026-01-11",
    });
    expect(byId.get("lowest_hr_at_comparable_pace")).toMatchObject({
      value: "145 bpm at 5:00/km",
      achievedOn: "2026-01-11",
    });
    expect(byId.get("most_even_interval_set")).toMatchObject({
      value: "0.0% pace variation",
      achievedOn: "2026-01-06",
    });
    expect(byId.get("most_consistent_four_weeks")).toMatchObject({
      value: "80% adherence in the weakest week",
      achievedOn: "2026-02-01",
    });
    expect(byId.get("fastest_comeback_days")).toMatchObject({
      value: "4 days",
      achievedOn: "2026-01-19",
    });
    for (const r of records) expect(r.rule.length).toBeGreaterThan(20);
  });

  it("omits records lacking data — no fake records", () => {
    const thin: RecordsInput = {
      runs: fullInput.runs.slice(0, 4), // < 5 eligible runs
      executions: fullInput.executions.slice(0, 2), // < 3 interval workouts
      weeklyAdherence: fullInput.weeklyAdherence.slice(0, 7), // < 8 weeks
      completedRunDates: ["2026-01-01", "2026-01-04", "2026-01-07"], // no 7-day break
    };
    expect(computeRecords(thin)).toEqual([]);
  });

  it("is deterministic across two calls", () => {
    const a = computeRecords(fullInput);
    const b = computeRecords(fullInput);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
