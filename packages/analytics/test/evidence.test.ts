import { describe, expect, it } from "vitest";
import type { EvidenceInput } from "../src/evidence.js";
import { pickEvidenceCard } from "../src/evidence.js";
import type { PersonalRecord } from "../src/records.js";
import type { TimeOfDayPair } from "../src/timeOfDay.js";
import { mkActivity, mkWorkout } from "./builders.js";

const range = { start: "2026-01-01", end: "2026-03-31" };

function pair(
  id: string,
  effectiveTime: string,
  state: "completed" | "missed",
  actualStartLocal?: string,
): TimeOfDayPair {
  const p: TimeOfDayPair = {
    workout: mkWorkout({
      id,
      effectiveDate: "2026-02-02",
      effectiveTime,
      completionState: state,
    }),
  };
  if (actualStartLocal) p.activity = mkActivity({ id: `act-${id}`, startTimeLocal: actualStartLocal });
  return p;
}

function windowPairs(prefix: string, time: string, completed: number, missed: number): TimeOfDayPair[] {
  const pairs: TimeOfDayPair[] = [];
  for (let i = 0; i < completed + missed; i++) {
    pairs.push(pair(`${prefix}${i}`, time, i < completed ? "completed" : "missed"));
  }
  return pairs;
}

/** Morning-heavy pairs with a comfortably-sized evening window too, so the
 * per-window comparison gate (>=3 planned per window) is satisfied and only
 * the morning-specific thresholds are under test. */
function morningPairs(completed: number, missed: number): TimeOfDayPair[] {
  return [...windowPairs("m", "07:00", completed, missed), ...windowPairs("e", "18:00", 3, 0)];
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

  it("suppresses the morning card when the evening window has fewer than 3 planned samples", () => {
    // Morning alone clears MIN_MORNING_PLANNED/MIN_MORNING_RATE (10 planned,
    // 100% complete), but comparative phrasing needs BOTH windows to have at
    // least 3 planned samples — evening has only 2 here.
    const pairs = [...windowPairs("m", "07:00", 10, 0), ...windowPairs("e", "18:00", 2, 0)];
    expect(
      pickEvidenceCard({ workouts: [], range, timeOfDayPairs: pairs, records: [] }),
    ).toBeNull();
  });

  it("suppresses the morning card when the morning window itself has fewer than 3 planned samples", () => {
    const pairs = [...windowPairs("m", "07:00", 2, 0), ...windowPairs("e", "18:00", 10, 0)];
    expect(
      pickEvidenceCard({ workouts: [], range, timeOfDayPairs: pairs, records: [] }),
    ).toBeNull();
  });

  it("includes the median start delta in the card text when available", () => {
    const morning = [
      pair("m0", "07:00", "completed", "2026-02-02T07:20:00"), // 20 min late
      pair("m1", "07:00", "completed", "2026-02-02T06:50:00"), // 10 min early -> median 15
      ...Array.from({ length: 8 }, (_, i) => pair(`m${i + 2}`, "07:00", "completed")),
    ];
    const pairs = [...morning, ...windowPairs("e", "18:00", 3, 0)];
    const card = pickEvidenceCard({ workouts: [], range, timeOfDayPairs: pairs, records: [] });
    expect(card).not.toBeNull();
    expect(card!.text).toBe(
      "You complete 100% of morning runs (10 of 10 scheduled before noon). You typically start within 15 minutes of plan.",
    );
  });

  it("omits the start-delta sentence when no completed workout carries a local start time", () => {
    const card = pickEvidenceCard({
      workouts: [],
      range,
      timeOfDayPairs: morningPairs(10, 2),
      records: [],
    });
    expect(card!.text).toBe("You complete 83% of morning runs (10 of 12 scheduled before noon).");
    expect(card!.text).not.toContain("typically start");
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
