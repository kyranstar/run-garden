/**
 * A PLAN'S RHYTHM LONGER THAN A WEEK (R1.6): a course or a programme on its days every 1 to 4 weeks, from an anchor Monday.
 * The keys are stored only when they say something (every 2 weeks or more), so a row an older worker reads is unchanged.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { adaptiveConfigFields, adaptiveConfigSchema, cadenceAnchor, cadenceOf, courseConfigFields, courseConfigSchema, onWeek, withCadence } from "../src/index.js";

const TRE = { course: "tre", weekdays: [0, 4], time: "19:30", quietDaysBeforeRace: 7, placementWeeksAhead: 2, easeNext: false };

describe("a course's rhythm", () => {
  it("an old config parses unchanged, and reads as every week", () => {
    const parsed = courseConfigSchema.parse(TRE);
    expect(parsed).toEqual(TRE);
    expect("everyWeeks" in parsed).toBe(false);
    expect(cadenceOf(parsed)).toEqual({ everyWeeks: 1, from: null });
  });

  it("takes every 2 to 4 weeks from a Monday", () => {
    for (const n of [2, 3, 4]) {
      const parsed = courseConfigSchema.parse({ ...TRE, everyWeeks: n, cadenceFrom: "2026-11-23" });
      expect(cadenceOf(parsed)).toEqual({ everyWeeks: n, from: "2026-11-23" });
    }
  });

  it.each([
    ["0 weeks", { everyWeeks: 0, cadenceFrom: "2026-11-23" }],
    ["5 weeks", { everyWeeks: 5, cadenceFrom: "2026-11-23" }],
    ["a fraction", { everyWeeks: 1.5, cadenceFrom: "2026-11-23" }],
    ["no anchor", { everyWeeks: 2 }],
    ["an anchor that isn't a Monday", { everyWeeks: 2, cadenceFrom: "2026-11-24" }],
    ["an anchor that isn't a date", { everyWeeks: 2, cadenceFrom: "next week" }],
    ["every week written out", { everyWeeks: 1 }],
    ["an anchor with no rhythm", { cadenceFrom: "2026-11-23" }],
  ])("refuses %s", (_what, extra) => {
    expect(courseConfigSchema.safeParse({ ...TRE, ...extra }).success).toBe(false);
  });

  it("the start route's fields still pick from the course's own", () => {
    expect(courseConfigFields.pick({ course: true, weekdays: true, time: true }).strict().safeParse({ course: "tre", weekdays: [0], time: "19:30" }).success).toBe(true);
  });
});

// Fix round 1 (the review's MAJOR 1): a programme's goal is read per week everywhere (its row, its build's mode), so a rhythm
// there would read as falling behind. Gated for this release: a programme's settings hold no rhythm, and nothing writes one.
describe("a programme runs every week (gated, fix round 1)", () => {
  it("an empty config is every default, with no rhythm keys, and reads as every week", () => {
    expect(Object.keys(adaptiveConfigSchema.parse({}))).not.toContain("everyWeeks");
    expect(cadenceOf(adaptiveConfigSchema.parse({}))).toEqual({ everyWeeks: 1, from: null });
  });
  it("refuses either key, whatever its value", () => {
    expect(adaptiveConfigSchema.safeParse({ everyWeeks: 2, cadenceFrom: "2026-11-23" }).success).toBe(false);
    expect(adaptiveConfigSchema.safeParse({ everyWeeks: 1 }).success).toBe(false);
    expect(adaptiveConfigSchema.safeParse({ cadenceFrom: "2026-11-23" }).success).toBe(false);
    expect(adaptiveConfigFields.partial().strict().safeParse({ everyWeeks: 2 }).success).toBe(false);
  });
});

describe("onWeek: whether a week is one the rhythm uses", () => {
  const every2 = { everyWeeks: 2, cadenceFrom: "2026-11-23" };
  it("every week, whatever the date", () => {
    expect(onWeek("2026-11-30", {})).toBe(true);
    expect(onWeek("1999-01-04", { everyWeeks: 1 })).toBe(true);
  });
  it("every 2 weeks: the anchor's week and every other one after it", () => {
    expect(onWeek("2026-11-23", every2)).toBe(true);
    expect(onWeek("2026-11-30", every2)).toBe(false);
    expect(onWeek("2026-12-07", every2)).toBe(true);
    expect(onWeek("2026-12-14", every2)).toBe(false);
    expect(onWeek("2026-12-21", every2)).toBe(true);
  });
  // Fix round 1 (the review's MINOR 3): an anchor is where the rhythm starts, so "from 7 Dec" places nothing before it.
  it("no week before the anchor is one of its weeks: the rhythm starts there", () => {
    expect(onWeek("2026-11-16", every2)).toBe(false);
    expect(onWeek("2026-11-09", every2)).toBe(false);
    expect(onWeek("2026-11-02", { everyWeeks: 3, cadenceFrom: "2026-11-23" })).toBe(false);
    expect(onWeek("2026-11-22", every2)).toBe(false);
    expect(onWeek("2026-11-23", every2)).toBe(true);
  });
  it("any day of a week answers for its week", () => {
    expect(onWeek("2026-12-11", every2)).toBe(true);
    expect(onWeek("2026-12-13", every2)).toBe(true);
    expect(onWeek("2026-12-14", every2)).toBe(false);
  });
  it("every 4 weeks across a year end and a clock change", () => {
    const every4 = { everyWeeks: 4, cadenceFrom: "2026-10-26" };
    expect(onWeek("2026-11-23", every4)).toBe(true);
    expect(onWeek("2026-12-21", every4)).toBe(true);
    expect(onWeek("2027-01-18", every4)).toBe(true);
    expect(onWeek("2027-01-11", every4)).toBe(false);
    expect(onWeek("2026-03-30", every4)).toBe(onWeek("2026-03-30", every4));
  });
});

describe("withCadence: the keys written only when they say something", () => {
  it("sets both for every 2 weeks or more", () => {
    expect(withCadence(TRE, 2, "2026-11-23")).toEqual({ ...TRE, everyWeeks: 2, cadenceFrom: "2026-11-23" });
  });
  it("removes both for every week", () => {
    const set = { ...TRE, everyWeeks: 3, cadenceFrom: "2026-11-23" };
    const back = withCadence(set, 1, null);
    expect(back).toEqual(TRE);
    expect(Object.keys(back)).not.toContain("everyWeeks");
    expect(Object.keys(back)).not.toContain("cadenceFrom");
  });
  it("leaves the config it was given as it was", () => {
    const set = { ...TRE, everyWeeks: 3, cadenceFrom: "2026-11-23" };
    withCadence(set, 1, null);
    expect(set.everyWeeks).toBe(3);
  });
  it("puts an anchor on its week's Monday", () => {
    expect(withCadence(TRE, 2, "2026-11-26")).toMatchObject({ cadenceFrom: "2026-11-23" });
  });
});

// Fix round 2 (FIX2-RULINGS 2): (a) this week while it still holds one of the plan's sessions to come; else (b) the week of
// its latest done session; else (c) the week of its next day from today.
describe("cadenceAnchor: the week the rhythm counts from when nothing says", () => {
  const MON = [0];
  it("(a) this week, while a session of the plan is still to come in it", () => {
    // Mon 23 Nov 08:00, today's still to do, last done 16 Nov: this week, so every 2 weeks is 23 Nov, then 7 Dec.
    expect(cadenceAnchor({ today: "2026-11-23", days: MON, toCome: true, lastDone: "2026-11-16" })).toBe("2026-11-23");
    // Asked on a Sunday with Sunday's to come, nothing done.
    expect(cadenceAnchor({ today: "2026-11-29", days: [6], toCome: true, lastDone: null })).toBe("2026-11-23");
  });
  it("(b) else the week of the plan's latest done session", () => {
    // Done Monday 23 Nov, asked Tuesday: that week, so every 2 weeks next falls on 7 Dec.
    expect(cadenceAnchor({ today: "2026-11-24", days: MON, toCome: false, lastDone: "2026-11-23" })).toBe("2026-11-23");
    // Done Monday 7 Dec, asked Wednesday 9 Dec: every 3 weeks from that week.
    expect(cadenceAnchor({ today: "2026-12-09", days: MON, toCome: false, lastDone: "2026-12-07" })).toBe("2026-12-07");
    // Done on a Friday: its week's Monday.
    expect(cadenceAnchor({ today: "2026-11-24", days: [0, 4], toCome: false, lastDone: "2026-11-20" })).toBe("2026-11-16");
  });
  it("(c) none done and none to come: the week of its next day from today, today included", () => {
    // Sunday 22 Nov, Mondays: tomorrow's week.
    expect(cadenceAnchor({ today: "2026-11-22", days: MON, toCome: false, lastDone: null })).toBe("2026-11-23");
    // Wednesday 25 Nov, Fridays: this week's Friday.
    expect(cadenceAnchor({ today: "2026-11-25", days: [4], toCome: false, lastDone: null })).toBe("2026-11-23");
    // Wednesday 25 Nov, Mondays and Tuesdays: next week's Monday.
    expect(cadenceAnchor({ today: "2026-11-25", days: [0, 1], toCome: false, lastDone: null })).toBe("2026-11-30");
    // Monday 23 Nov, Mondays: today's own week.
    expect(cadenceAnchor({ today: "2026-11-23", days: MON, toCome: false, lastDone: null })).toBe("2026-11-23");
    // Sunday 22 Nov, Sundays: today.
    expect(cadenceAnchor({ today: "2026-11-22", days: [6], toCome: false, lastDone: null })).toBe("2026-11-16");
  });
});
