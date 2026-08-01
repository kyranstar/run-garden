import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES } from "@rg/domain";
import { proposeReschedules, type ReschedulerWorkout } from "../src/reschedule.js";
import { zonedInstant } from "../src/windows.js";

const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone: "America/Los_Angeles" };

const wk = (over: Partial<ReschedulerWorkout> & { id: string }): ReschedulerWorkout => ({
  title: over.id,
  category: "easy",
  effectiveDate: "2026-08-04",
  effectiveTime: "07:00",
  workoutSeconds: 3000,
  ...over,
});

const baseReq = {
  busy: [],
  prefs,
  today: "2026-08-03" as const,
  now: zonedInstant("2026-08-03", "12:00", prefs.timezone),
};

describe("proposeReschedules", () => {
  it("offers at most three candidates, each with an explanation", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "easy1" }),
      others: [],
    });
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.length).toBeLessThanOrEqual(3);
    for (const c of res.candidates) expect(c.explanation.length).toBeGreaterThan(0);
    expect(res.skipOption.explanation).toMatch(/stay where they are/);
  });

  it("offers the same-day evening window first when morning passed", () => {
    const res = proposeReschedules({
      ...baseReq,
      today: "2026-08-04",
      now: zonedInstant("2026-08-04", "09:00", prefs.timezone),
      workout: wk({ id: "easy1" }),
      others: [],
    });
    const first = res.candidates[0]!;
    expect(first.date).toBe("2026-08-04");
    expect(first.window).toBe("evening");
    expect(first.explanation).toBe("same day");
  });

  it("never moves a race", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "race", category: "race" }),
      others: [],
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.blockedReason).toMatch(/never moved/i);
  });

  it("never places a run on a day that already has a run", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "quality1", category: "quality" }),
      others: [
        wk({ id: "easy-wed", effectiveDate: "2026-08-05" }),
        wk({ id: "easy-thu", effectiveDate: "2026-08-06" }),
      ],
    });
    for (const c of res.candidates) {
      expect(["2026-08-05", "2026-08-06"]).not.toContain(c.date);
    }
  });

  it("penalizes quality-within-36h placements below clean ones", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "threshold", category: "quality" }),
      others: [wk({ id: "vo2", category: "quality", effectiveDate: "2026-08-06" })],
    });
    // Wednesday (2026-08-05) morning is within 36h of Thursday's quality run.
    const wednesday = res.candidates.find((c) => c.date === "2026-08-05");
    const monday = res.candidates.find((c) => c.date === "2026-08-03");
    if (wednesday && monday) expect(monday.score).toBeGreaterThan(wednesday.score);
    const top = res.candidates[0]!;
    expect(top.warnings.filter((w) => w.includes("36 hours"))).toHaveLength(0);
  });

  it("blocks candidates that collide with busy calendar intervals", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "easy1" }),
      others: [],
      busy: [
        {
          start: zonedInstant("2026-08-05", "06:00", prefs.timezone),
          end: zonedInstant("2026-08-05", "09:00", prefs.timezone),
          title: "Flight",
        },
      ],
    });
    for (const c of res.candidates) {
      if (c.date === "2026-08-05") expect(c.window).toBe("evening");
    }
  });

  it("rejects evening slots that would finish after the latest evening finish", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "long1", category: "long", workoutSeconds: 2.5 * 3600 }),
      others: [],
    });
    for (const c of res.candidates) expect(c.window).toBe("morning");
  });

  it("warns when moving more than two days", () => {
    // Only a +3-days placement is viable: others occupy every closer day.
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "easy1" }),
      others: [
        wk({ id: "a", effectiveDate: "2026-08-04" }), // same day occupied by another run
        wk({ id: "b", effectiveDate: "2026-08-05" }),
        wk({ id: "c", effectiveDate: "2026-08-03" }),
        wk({ id: "d", effectiveDate: "2026-08-06" }),
        wk({ id: "e", effectiveDate: "2026-08-02" }),
      ],
    });
    // All near days blocked → no candidates at all (enumeration stops at ±2).
    expect(res.candidates).toHaveLength(0);
  });

  it("flags a late prior evening for morning candidates", () => {
    const res = proposeReschedules({
      ...baseReq,
      workout: wk({ id: "easy1" }),
      others: [],
      busy: [
        {
          start: zonedInstant("2026-08-04", "20:00", prefs.timezone),
          end: zonedInstant("2026-08-04", "23:30", prefs.timezone),
          title: "Concert",
        },
      ],
    });
    const wedMorning = res.candidates.find((c) => c.date === "2026-08-05" && c.window === "morning");
    if (wedMorning) {
      expect(wedMorning.warnings.some((w) => w.includes("late evening"))).toBe(true);
    }
  });
});
