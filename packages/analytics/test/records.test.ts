import { describe, expect, it } from "vitest";
import type { RecordsInput, RunSample, ScoredRecord, StoredRecord } from "../src/records.js";
import { computeRecords, mergeRecords } from "../src/records.js";
import { mkActivity, mkLap } from "./builders.js";

function easyRun(id: string, date: string, hr: number, pace = 300): RunSample {
  // Aerobic efficiency now requires laps (no whole-run fallback): 4 laps of
  // 450s at a uniform pace so the trimmed middle two laps (900s, 3000m)
  // reproduce the same speed/HR ratio as the whole-run figures below.
  const laps = [
    mkLap(id, 0, { durationSeconds: 450, distanceMeters: 1500, avgHeartRate: hr }), // dropped: warm-up
    mkLap(id, 1, { durationSeconds: 450, distanceMeters: 1500, avgHeartRate: hr }),
    mkLap(id, 2, { durationSeconds: 450, distanceMeters: 1500, avgHeartRate: hr }),
    mkLap(id, 3, { durationSeconds: 450, distanceMeters: 1500, avgHeartRate: hr }), // dropped: final lap
  ];
  return {
    activity: mkActivity({
      id,
      startTimeLocal: `${date}T07:00:00`,
      durationSeconds: 1800,
      distanceMeters: 6000,
      avgHeartRate: hr,
      avgPaceSecPerKm: pace,
    }),
    laps,
    category: "easy",
  };
}

const fullInput: RecordsInput = {
  runs: [
    easyRun("r1", "2026-01-05", 150),
    easyRun("r2", "2026-01-07", 148),
    easyRun("r3", "2026-01-09", 152),
    easyRun("r4", "2026-01-11", 145),
    easyRun("r5", "2026-01-13", 149),
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
      "most_consistent_four_weeks",
      "fastest_comeback_days",
    ]);

    const byId = new Map(records.map((r) => [r.id, r]));
    // Best efficiency: (3000/900)/145 * 60 = 1.3793... on the hr-145 run,
    // rounded to 4 decimals by runEfficiency().
    expect(byId.get("best_aerobic_efficiency")).toMatchObject({
      value: "1.38 m/beat",
      achievedOn: "2026-01-11",
      numeric: 1.3793,
    });
    expect(byId.get("most_consistent_four_weeks")).toMatchObject({
      value: "80% adherence in the weakest week",
      achievedOn: "2026-02-01",
      numeric: 0.8,
    });
    expect(byId.get("fastest_comeback_days")).toMatchObject({
      value: "4 days",
      achievedOn: "2026-01-19",
      // Faster comebacks must score higher, so the stored value is negated.
      numeric: -4,
    });
    for (const r of records) expect(r.rule.length).toBeGreaterThan(20);
  });

  it("omits records lacking data — no fake records", () => {
    const thin: RecordsInput = {
      runs: fullInput.runs.slice(0, 4), // < 5 eligible runs
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

function stored(id: string, numeric: number, overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    title: `Stored ${id}`,
    value: `stored-${numeric}`,
    achievedOn: "2026-01-01",
    rule: "stored rule",
    numeric,
    ...overrides,
  };
}

function fresh(id: string, numeric: number, overrides: Partial<ScoredRecord> = {}): ScoredRecord {
  return {
    id,
    title: `Fresh ${id}`,
    value: `fresh-${numeric}`,
    achievedOn: "2026-02-01",
    rule: "fresh rule",
    numeric,
    ...overrides,
  };
}

describe("mergeRecords", () => {
  it("replaces a stored record when the fresh one has a higher numeric value", () => {
    const result = mergeRecords([fresh("a", 5)], [stored("a", 3)]);
    expect(result).toEqual([stored("a", 5, { title: "Fresh a", value: "fresh-5", achievedOn: "2026-02-01", rule: "fresh rule" })]);
  });

  it("keeps the stored record when the fresh one is worse (never regress)", () => {
    const result = mergeRecords([fresh("a", 2)], [stored("a", 3)]);
    expect(result).toEqual([stored("a", 3)]);
  });

  it("keeps the stored record on a tie", () => {
    const result = mergeRecords([fresh("a", 3)], [stored("a", 3)]);
    expect(result).toEqual([stored("a", 3)]);
  });

  it("keeps a stored record with no fresh counterpart", () => {
    const result = mergeRecords([], [stored("a", 3)]);
    expect(result).toEqual([stored("a", 3)]);
  });

  it("adds a fresh record with no stored counterpart", () => {
    const result = mergeRecords([fresh("b", 1)], []);
    expect(result).toEqual([stored("b", 1, { title: "Fresh b", value: "fresh-1", achievedOn: "2026-02-01", rule: "fresh rule" })]);
  });

  it("merges a disjoint union and sorts the result by id", () => {
    const result = mergeRecords(
      [fresh("c", 10), fresh("a", 20)],
      [stored("b", 30), stored("a", 1)],
    );
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(result.find((r) => r.id === "a")!.numeric).toBe(20); // fresh beat stored 1 -> 20
    expect(result.find((r) => r.id === "b")!.numeric).toBe(30); // no fresh counterpart -> survives
    expect(result.find((r) => r.id === "c")!.numeric).toBe(10); // no stored counterpart -> enters
  });

  it("is deterministic across two calls", () => {
    const a = mergeRecords([fresh("a", 5), fresh("z", 1)], [stored("m", 2)]);
    const b = mergeRecords([fresh("a", 5), fresh("z", 1)], [stored("m", 2)]);
    expect(a).toEqual(b);
  });
});
