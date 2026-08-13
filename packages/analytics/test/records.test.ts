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
    { weekStart: "2026-01-05", adherence: 1, planned: 3 },
    { weekStart: "2026-01-12", adherence: 0.8, planned: 5 },
    { weekStart: "2026-01-19", adherence: 1, planned: 3 },
    { weekStart: "2026-01-26", adherence: 1, planned: 3 },
    { weekStart: "2026-02-02", adherence: 0.75, planned: 4 },
    { weekStart: "2026-02-09", adherence: 1, planned: 3 },
    { weekStart: "2026-02-16", adherence: 1, planned: 3 },
    { weekStart: "2026-02-23", adherence: 1, planned: 3 },
  ],
  completedRunDates: ["2026-01-01", "2026-01-03", "2026-01-15", "2026-01-17", "2026-01-19"],
  discipline: "run",
};

describe("computeRecords", () => {
  it("produces every record when enough history exists, with deterministic rules", () => {
    const records = computeRecords(fullInput);
    // Ids are namespaced by discipline: mergeRecords keys on id, so sharing one
    // across disciplines would let a run's longest session hide a yoga one.
    expect(records.map((r) => r.id)).toEqual([
      "run:best_aerobic_efficiency",
      "run:most_consistent_four_weeks",
      "run:fastest_comeback_days",
      "run:longest_session",
      "run:most_sessions_in_a_week",
      "run:longest_streak",
    ]);

    const byId = new Map(records.map((r) => [r.id, r]));
    // Best efficiency: (3000/900)/145 * 60 = 1.3793... on the hr-145 run,
    // rounded to 4 decimals by runEfficiency().
    expect(byId.get("run:best_aerobic_efficiency")).toMatchObject({
      value: "1.38 m/beat",
      achievedOn: "2026-01-11",
      numeric: 1.3793,
    });
    expect(byId.get("run:most_consistent_four_weeks")).toMatchObject({
      value: "80% adherence in the weakest week",
      achievedOn: "2026-02-01",
      numeric: 0.8,
    });
    expect(byId.get("run:fastest_comeback_days")).toMatchObject({
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
      // No 7-day break, and below MIN_SESSIONS_FOR_RECORD so the "longest"
      // and "most" records stay silent too.
      completedRunDates: ["2026-01-01", "2026-01-04", "2026-01-07"],
      discipline: "run",
    };
    expect(computeRecords(thin)).toEqual([]);
  });

  it("stamps single-activity records with their source activityId, so a heal can invalidate them", () => {
    const byId = new Map(computeRecords(fullInput).map((r) => [r.id, r]));
    // The hr-145 run "r4" is both the most efficient and (tied) longest;
    // longest-session ties resolve to the first run in input order, "r1".
    expect(byId.get("run:best_aerobic_efficiency")!.activityId).toBe("r4");
    expect(byId.get("run:longest_session")!.activityId).toBe("r1");
    // Aggregate records describe many days — no single activity to blame.
    expect(byId.get("run:most_consistent_four_weeks")!.activityId).toBeUndefined();
    expect(byId.get("run:longest_streak")!.activityId).toBeUndefined();
  });

  // ── audit#2 #17: the consistency-record notability floor ────────────────────
  describe("most consistent four weeks floor", () => {
    const weeks = (
      entries: Array<[string, number, number]>,
    ): RecordsInput["weeklyAdherence"] =>
      entries.map(([weekStart, adherence, planned]) => ({ weekStart, adherence, planned }));

    it("never mints a record over a window containing a week with nothing planned", () => {
      // Eight consecutive weeks, perfect adherence wherever anything was
      // planned — but every 4-week window crosses at least one plan-less
      // week. The old code scored those weeks adherence 0 and then named the
      // best-of-the-worst a personal record: "0% adherence in the weakest
      // week", dated before any plan existed.
      const input: RecordsInput = {
        ...fullInput,
        weeklyAdherence: weeks([
          ["2026-01-05", 1, 3],
          ["2026-01-12", 1, 3],
          ["2026-01-19", 0, 0], // no plan this week
          ["2026-01-26", 1, 3],
          ["2026-02-02", 1, 3],
          ["2026-02-09", 0, 0], // no plan this week
          ["2026-02-16", 1, 3],
          ["2026-02-23", 1, 3],
        ]),
      };
      const ids = computeRecords(input).map((r) => r.id);
      expect(ids).not.toContain("run:most_consistent_four_weeks");
    });

    it("returns no record when every eligible window's weakest week sits under the 0.25 floor", () => {
      const input: RecordsInput = {
        ...fullInput,
        weeklyAdherence: weeks([
          ["2026-01-05", 1, 4],
          ["2026-01-12", 0.2, 5], // weakest week of every window it touches
          ["2026-01-19", 1, 4],
          ["2026-01-26", 0.2, 5],
          ["2026-02-02", 1, 4],
          ["2026-02-09", 0, 4], // planned but nothing done: 0 is not notable
          ["2026-02-16", 1, 4],
          ["2026-02-23", 0.2, 5],
        ]),
      };
      const ids = computeRecords(input).map((r) => r.id);
      expect(ids).not.toContain("run:most_consistent_four_weeks");
    });

    it("skips sub-floor windows but still names a clean window elsewhere in the series", () => {
      const input: RecordsInput = {
        ...fullInput,
        weeklyAdherence: weeks([
          ["2026-01-05", 0, 0], // plan-less: disqualifies windows touching it
          ["2026-01-12", 1, 3],
          ["2026-01-19", 1, 3],
          ["2026-01-26", 0.75, 4],
          ["2026-02-02", 1, 3],
          ["2026-02-09", 1, 3],
          ["2026-02-16", 1, 3],
          ["2026-02-23", 0.2, 5], // sub-floor: disqualifies its windows too
        ]),
      };
      const record = computeRecords(input).find(
        (r) => r.id === "run:most_consistent_four_weeks",
      );
      expect(record).toBeDefined();
      // The only clean window is 01-12..02-02 (min 0.75) and 01-19..02-09
      // (min 0.75) — either way the weakest week is 75%.
      expect(record!.numeric).toBe(0.75);
      expect(record!.value).toBe("75% adherence in the weakest week");
    });

    it("accepts a weakest week exactly at the 0.25 floor", () => {
      const input: RecordsInput = {
        ...fullInput,
        weeklyAdherence: weeks([
          ["2026-01-05", 1, 4],
          ["2026-01-12", 0.25, 4],
          ["2026-01-19", 1, 4],
          ["2026-01-26", 1, 4],
          ["2026-02-02", 0, 0],
          ["2026-02-09", 0, 0],
          ["2026-02-16", 0, 0],
          ["2026-02-23", 0, 0],
        ]),
      };
      const record = computeRecords(input).find(
        (r) => r.id === "run:most_consistent_four_weeks",
      );
      expect(record).toBeDefined();
      expect(record!.numeric).toBe(0.25);
    });
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

  it("carries a fresh record's activityId into the persisted shape", () => {
    const result = mergeRecords([fresh("run:longest_session", 5, { activityId: "act-9" })], []);
    expect(result[0]!.activityId).toBe("act-9");
    // …and omits the key entirely when the record has none, keeping the
    // stored JSON free of explicit undefineds.
    const bare = mergeRecords([fresh("run:longest_streak", 4)], []);
    expect("activityId" in bare[0]!).toBe(false);
  });

  // ── audit#2 #17: the merge itself refuses degenerate consistency records ────
  it("cannot re-mint a sub-floor most_consistent_four_weeks entry after the stored rows are cleaned", () => {
    // The prod cleanup deletes the numeric-0 rows; if a caller then replays a
    // fresh set still carrying one (an old cache, an upstream regression),
    // the merge must drop it on the floor rather than persist it again.
    const degenerate = fresh("run:most_consistent_four_weeks", 0);
    expect(mergeRecords([degenerate], [])).toEqual([]);
    const subFloor = fresh("yoga:most_consistent_four_weeks", 0.2);
    expect(mergeRecords([subFloor], [])).toEqual([]);
  });

  it("still admits an at-floor-or-better consistency record, and never touches stored entries", () => {
    const legit = fresh("run:most_consistent_four_weeks", 0.8);
    expect(mergeRecords([legit], []).map((r) => r.numeric)).toEqual([0.8]);
    // Stored rows pass through untouched — stripping persisted entries is the
    // orchestrated data cleanup's job, not merge logic.
    const storedDegenerate = stored("run:most_consistent_four_weeks", 0);
    expect(mergeRecords([], [storedDegenerate])).toEqual([storedDegenerate]);
  });
});
