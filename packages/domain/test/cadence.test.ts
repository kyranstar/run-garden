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

describe("a programme's rhythm (the twin)", () => {
  it("an empty config is still every default, with no rhythm keys", () => {
    expect(Object.keys(adaptiveConfigSchema.parse({}))).not.toContain("everyWeeks");
    expect(cadenceOf(adaptiveConfigSchema.parse({}))).toEqual({ everyWeeks: 1, from: null });
  });
  it("takes the same two keys, held to the same rules", () => {
    expect(adaptiveConfigSchema.safeParse({ everyWeeks: 2, cadenceFrom: "2026-11-23" }).success).toBe(true);
    expect(adaptiveConfigSchema.safeParse({ everyWeeks: 2 }).success).toBe(false);
    expect(adaptiveConfigSchema.safeParse({ everyWeeks: 5, cadenceFrom: "2026-11-23" }).success).toBe(false);
  });
  it("the settings route's partial still builds from its fields", () => {
    expect(adaptiveConfigFields.partial().strict().safeParse({ everyWeeks: 1 }).success).toBe(true);
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
  it("and the weeks before the anchor, in the same rhythm", () => {
    expect(onWeek("2026-11-16", every2)).toBe(false);
    expect(onWeek("2026-11-09", every2)).toBe(true);
    expect(onWeek("2026-10-26", { everyWeeks: 3, cadenceFrom: "2026-11-23" })).toBe(false);
    expect(onWeek("2026-11-02", { everyWeeks: 3, cadenceFrom: "2026-11-23" })).toBe(true);
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

describe("cadenceAnchor: the week the rhythm starts when nothing says", () => {
  it("the week of the next of its days, today included", () => {
    // Sunday 22 Nov: the next Monday is tomorrow, so the rhythm starts with it.
    expect(cadenceAnchor("2026-11-22", [0])).toBe("2026-11-23");
    // Wednesday: Friday is still to come this week.
    expect(cadenceAnchor("2026-11-25", [0, 4])).toBe("2026-11-23");
    // Monday itself.
    expect(cadenceAnchor("2026-11-23", [0])).toBe("2026-11-23");
    // Saturday, a Monday-only course: next week.
    expect(cadenceAnchor("2026-11-28", [0])).toBe("2026-11-30");
  });
});
