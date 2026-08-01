import { describe, expect, it } from "vitest";
import type { EvidenceInput } from "../src/evidence.js";
import { pickEvidenceCard } from "../src/evidence.js";
import type { PersonalRecord } from "../src/records.js";
import type { TimeOfDayPair } from "../src/timeOfDay.js";
import { mkWorkout } from "./builders.js";

const range = { start: "2026-01-01", end: "2026-03-31" };

function morningPairs(completed: number, missed: number): TimeOfDayPair[] {
  const pairs: TimeOfDayPair[] = [];
  for (let i = 0; i < completed + missed; i++) {
    pairs.push({
      workout: mkWorkout({
        id: `m${i}`,
        effectiveDate: "2026-02-02",
        effectiveTime: "07:00",
        completionState: i < completed ? "completed" : "missed",
      }),
    });
  }
  return pairs;
}

const comebackRecord: PersonalRecord = {
  id: "fastest_comeback_days",
  title: "Fastest comeback",
  value: "4 days",
  achievedOn: "2026-01-19",
  rule: "Fewest days from the first run after a break of 7+ days until three runs each within 3 days of the previous.",
};

describe("pickEvidenceCard", () => {
  it("returns null with thin data — no platitudes", () => {
    expect(
      pickEvidenceCard({ workouts: [], range, timeOfDayPairs: [], records: [] }),
    ).toBeNull();
  });

  it("returns the morning-completion card with rich data, in the exact factual format", () => {
    const card = pickEvidenceCard({
      workouts: [],
      range,
      timeOfDayPairs: morningPairs(10, 2),
      records: [],
    });
    expect(card).not.toBeNull();
    expect(card!.text).toBe("You complete 83% of morning runs (10 of 12 scheduled before noon).");
    expect(card!.sampleNote).toBe("Sample: 12 scheduled morning runs.");
    expect(card!.dismissible).toBe(true);
  });

  it("suppresses the morning card below 10 scheduled morning runs or below 70% completion", () => {
    expect(
      pickEvidenceCard({ workouts: [], range, timeOfDayPairs: morningPairs(8, 1), records: [] }),
    ).toBeNull();
    expect(
      pickEvidenceCard({ workouts: [], range, timeOfDayPairs: morningPairs(7, 5), records: [] }),
    ).toBeNull();
  });

  it("prefers the comeback pattern over the morning card", () => {
    const input: EvidenceInput = {
      workouts: [],
      range,
      timeOfDayPairs: morningPairs(10, 2),
      records: [comebackRecord],
    };
    const card = pickEvidenceCard(input);
    expect(card!.text).toBe(
      "After a break of 7 or more days, your fastest return to three runs took 4 days.",
    );
    expect(card!.sampleNote).toBe(comebackRecord.rule);
  });

  it("falls back to easy-run consistency when time-of-day data is not morning-heavy", () => {
    const workouts = Array.from({ length: 12 }, (_, i) =>
      mkWorkout({
        id: `easy${i}`,
        category: "easy",
        effectiveDate: "2026-02-03",
        completionState: i < 10 ? "completed" : "missed",
      }),
    );
    const card = pickEvidenceCard({ workouts, range, timeOfDayPairs: [], records: [] });
    expect(card!.text).toBe("You completed 10 of 12 planned easy runs (83%).");
  });

  it("gives cards a stable id derived from kind and value", () => {
    const input: EvidenceInput = {
      workouts: [],
      range,
      timeOfDayPairs: morningPairs(10, 2),
      records: [],
    };
    const a = pickEvidenceCard(input);
    const b = pickEvidenceCard(input);
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toMatch(/^ev-[0-9a-f]+$/);
  });
});
