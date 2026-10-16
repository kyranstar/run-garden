/**
 * SETTINGS → COACH (Stage 3 Task 10): the coach designer's settings, stored as `coach` in the user's preferences.
 *
 *  - Every field is optional; an absent one is its default (scope now, three workouts, no times, $1.50 and $6).
 *  - A limit may be lowered, never raised past its default, and never below the floor.
 *  - A stored value that no longer reads is no settings at all: the defaults — never a failure of the preferences it
 *    sits in (the timezone, the units and everything else still read).
 */
import { describe, expect, it } from "vitest";
import {
  COACH_CEILING_DEFAULTS_USD,
  COACH_CEILING_MIN_USD,
  COACH_NEXT_N,
  ceilingKindOf,
  coachPreferencesSchema,
  coachSettings,
  DEFAULT_USER_PREFERENCES,
  userPreferencesSchema,
} from "../src/index.js";

describe("the coach's settings", () => {
  it("default to now, three workouts, no times, and the full limits", () => {
    expect(coachSettings(undefined)).toEqual({
      defaultScope: "now",
      nextN: 3,
      trainingTimes: [],
      ceilingsUsd: { day: 1.5, set: 6 },
    });
    expect(COACH_NEXT_N).toEqual({ min: 1, max: 7, default: 3 });
    expect(COACH_CEILING_DEFAULTS_USD).toEqual({ day: 1.5, set: 6 });
  });

  it("read what the athlete set, field by field", () => {
    expect(
      coachSettings({ defaultScope: "week", nextN: 5, trainingTimes: ["07:00", "18:30"], ceilingsUsd: { set: 4 } }),
    ).toEqual({ defaultScope: "week", nextN: 5, trainingTimes: ["07:00", "18:30"], ceilingsUsd: { day: 1.5, set: 4 } });
  });

  it("a limit may be lowered, never raised past its default, and not below the floor", () => {
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: 1 } }).success).toBe(true);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: 1.5, set: 6 } }).success).toBe(true);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: 1.51 } }).success).toBe(false);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { set: 6.01 } }).success).toBe(false);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: COACH_CEILING_MIN_USD } }).success).toBe(true);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: COACH_CEILING_MIN_USD - 0.01 } }).success).toBe(false);
    expect(coachPreferencesSchema.safeParse({ ceilingsUsd: { day: 1.005 } }).success).toBe(false);
    // Read back, a value past a default (a default lowered since) is held to it.
    expect(coachSettings({ ceilingsUsd: { day: 9 } } as never).ceilingsUsd.day).toBe(1.5);
  });

  it("refuses what isn't a setting: a scope it doesn't know, N outside 1–7, more than three times, a time twice", () => {
    for (const bad of [
      { defaultScope: "forever" },
      { nextN: 0 },
      { nextN: 8 },
      { nextN: 2.5 },
      { trainingTimes: ["07:00", "12:00", "18:00", "20:00"] },
      { trainingTimes: ["07:00", "07:00"] },
      { trainingTimes: ["7am"] },
      { trainingTimes: ["24:00"] },
      { ceilingsUsd: { now: 1 } },
      { model: "another" },
    ]) {
      expect(coachPreferencesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a scope's limit: one workout's for now and later today, a set's for a week or the next workouts", () => {
    expect(ceilingKindOf("now")).toBe("day");
    expect(ceilingKindOf("later_today")).toBe("day");
    expect(ceilingKindOf("week")).toBe("set");
    expect(ceilingKindOf("next_n")).toBe("set");
  });
});

describe("stored in the user's preferences", () => {
  it("the defaults carry no coach settings: nothing is written until the athlete sets one", () => {
    expect("coach" in DEFAULT_USER_PREFERENCES).toBe(false);
    expect("coach" in userPreferencesSchema.parse({ timezone: "UTC" })).toBe(false);
  });

  it("kept through a read, so a save of other settings never drops them", () => {
    const prefs = userPreferencesSchema.parse({ timezone: "UTC", coach: { nextN: 4 } });
    expect(prefs.coach).toEqual({ nextN: 4 });
    expect(userPreferencesSchema.parse({ ...prefs, units: "mi" }).coach).toEqual({ nextN: 4 });
  });

  it("a stored value that doesn't read is the defaults, and the rest of the preferences still read", () => {
    const prefs = userPreferencesSchema.parse({ timezone: "Europe/Paris", units: "mi", coach: { nextN: 99, defaultScope: "week" } });
    expect(prefs.timezone).toBe("Europe/Paris");
    expect(prefs.units).toBe("mi");
    expect(prefs.coach).toBeUndefined();
    expect(coachSettings(prefs.coach).defaultScope).toBe("now");
  });
});
