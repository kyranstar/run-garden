import { describe, expect, it } from "vitest";
import { disciplineOf, sessionNoun, supportsMetric } from "../src/discipline.js";
import { computeRecords, type RunSample } from "../src/records.js";

function sample(id: string, date: string, seconds: number, sport = "strength"): RunSample {
  return {
    activity: {
      id,
      startTime: `${date}T07:00:00Z`,
      startTimeLocal: `${date}T07:00:00`,
      sport,
      durationSeconds: seconds,
      sourceMergeConfidence: 1,
    },
    laps: [],
    category: sport === "strength" ? "strength" : "yoga",
  };
}

describe("sessionNoun", () => {
  it("never calls a lift or a yoga session a run", () => {
    expect(sessionNoun("run", true)).toBe("runs");
    expect(sessionNoun("strength", true)).toBe("lifts");
    expect(sessionNoun("yoga", true)).toBe("yoga sessions");
  });

  it("has a singular form too", () => {
    expect(sessionNoun("run")).toBe("run");
    expect(sessionNoun("strength")).toBe("lift");
    expect(sessionNoun("yoga")).toBe("yoga session");
  });
});

describe("supportsMetric", () => {
  it("keeps pace-based metrics for runs only", () => {
    expect(supportsMetric("run", "aerobicEfficiency")).toBe(true);
    expect(supportsMetric("yoga", "aerobicEfficiency")).toBe(false);
    expect(supportsMetric("strength", "decoupling")).toBe(false);
  });

  it("allows discipline-agnostic metrics everywhere", () => {
    expect(supportsMetric("yoga", "consistency")).toBe(true);
    expect(supportsMetric("strength", "timeOfDay")).toBe(true);
  });
});

describe("computeRecords", () => {
  const dates = ["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-10"];

  /** Five sessions — the floor at which "longest" and "most" mean anything. */
  const yogaSamples = dates.map((d, i) => sample(`y${i}`, d, 2700 + i * 60, "yoga"));

  it("namespaces record ids by discipline so one cannot suppress another", () => {
    const records = computeRecords({
      runs: yogaSamples,
      weeklyAdherence: [],
      completedRunDates: dates,
      discipline: "yoga",
    });
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.id.startsWith("yoga:")).toBe(true);
  });

  it("gives strength and yoga a longest-session record", () => {
    const strengthDates = ["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-10"];
    const records = computeRecords({
      runs: [
        sample("s1", "2026-06-01", 4200),
        ...strengthDates.slice(1).map((d, i) => sample(`s${i + 2}`, d, 3000)),
      ],
      weeklyAdherence: [],
      completedRunDates: strengthDates,
      discipline: "strength",
    });
    const longest = records.find((r) => r.id === "strength:longest_session");
    expect(longest).toBeDefined();
    expect(longest!.value).toBe("1h 10m");
    expect(longest!.achievedOn).toBe("2026-06-01");
    expect(longest!.title).toBe("Longest lift");
  });

  it("counts the busiest rolling week", () => {
    const busyDates = ["2026-06-01", "2026-06-02", "2026-06-04", "2026-07-20", "2026-07-28"];
    const records = computeRecords({
      runs: busyDates.map((d, i) => sample(`s${i}`, d, 3600)),
      weeklyAdherence: [],
      completedRunDates: busyDates,
      discipline: "strength",
    });
    const busiest = records.find((r) => r.id === "strength:most_sessions_in_a_week");
    expect(busiest).toBeDefined();
    expect(busiest!.value).toBe("3");
  });

  it("stays silent on thin history rather than naming the biggest of three", () => {
    const records = computeRecords({
      runs: yogaSamples.slice(0, 3),
      weeklyAdherence: [],
      completedRunDates: dates.slice(0, 3),
      discipline: "yoga",
    });
    expect(records).toEqual([]);
  });

  it("omits pace-based records for yoga rather than inventing them", () => {
    const records = computeRecords({
      runs: yogaSamples,
      weeklyAdherence: [],
      completedRunDates: dates,
      discipline: "yoga",
    });
    expect(records.some((r) => r.id.includes("aerobic_efficiency"))).toBe(false);
  });

  it("still computes the run records for the run discipline", () => {
    const records = computeRecords({
      runs: [],
      weeklyAdherence: [],
      completedRunDates: dates,
      discipline: "run",
    });
    // fastestComebackDays needs a break; with none, no record — but every id
    // that IS produced must carry the run namespace.
    for (const r of records) expect(r.id.startsWith("run:")).toBe(true);
  });
});

describe("disciplineOf", () => {
  it("reads a planned yoga session from its category, since COROS has no yoga sport type", () => {
    // COROS's plan namespace is 1=run 2=bike 3=swim 4=strength, so a scheduled
    // yoga session arrives as sport "run" and only the classifier's category
    // identifies it. Trusting `sport` alone files it under running.
    expect(disciplineOf("yoga", "run")).toBe("yoga");
  });

  it("reads strength from either category or sport", () => {
    expect(disciplineOf("strength", "run")).toBe("strength");
    expect(disciplineOf("easy", "strength")).toBe("strength");
  });

  it("defaults to run", () => {
    expect(disciplineOf("easy", "run")).toBe("run");
    expect(disciplineOf("long", "run")).toBe("run");
    expect(disciplineOf("unknown", "")).toBe("run");
  });
});
