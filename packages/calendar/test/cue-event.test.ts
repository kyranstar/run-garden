import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  buildCueEvent,
  CUE_PROPERTY,
  CUE_RECURRENCE,
  cueDescription,
  cueProfileFromEvent,
  cueSearch,
  cueStartDate,
  cueWallTimeOf,
  wallClock,
} from "../src/cue-event.js";
import { workoutIdFromEvent } from "../src/event-body.js";

// A condition's daytime cue as one recurring calendar event per time of day (condition care gaps, Task 3). Synthetic
// zones, dates and times throughout.

const input = (over: Partial<Parameters<typeof buildCueEvent>[0]> = {}) => ({
  profileId: "jawcare",
  words: "Shoulders down, breathe",
  label: "Jaw care",
  time: "07:15",
  startDate: "2030-04-01",
  timezone: "America/Denver",
  appUrl: "https://rg.example.com/some/path",
  ...over,
});

describe("buildCueEvent", () => {
  it("is five minutes from the wall-clock time, in the zone, free, one alert at its start, on the first seven days of each month", () => {
    expect(buildCueEvent(input())).toEqual({
      summary: "Shoulders down, breathe",
      // How to stop it that is always true: no screen or coach reaches the cue's switch yet, and deleting it does.
      description: "Run Garden's daytime cue for Jaw care. To stop it, delete this event and all its repeats.",
      start: { dateTime: "2030-04-01T07:15:00", timeZone: "America/Denver" },
      end: { dateTime: "2030-04-01T07:20:00", timeZone: "America/Denver" },
      recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7"],
      transparency: "transparent",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
      extendedProperties: { private: { rgCue: "jawcare", rgApp: "Run Garden", rgOrigin: "https://rg.example.com" } },
    });
  });

  it("a cue just before midnight ends on the next day's clock, not 24:02", () => {
    const e = buildCueEvent(input({ time: "23:57", startDate: "2030-12-31" }));
    expect(e.start.dateTime).toBe("2030-12-31T23:57:00");
    expect(e.end.dateTime).toBe("2031-01-01T00:02:00");
  });

  it("carries a wall clock and a zone, never an offset or an instant: Google keeps the clock time across a change of clocks", () => {
    const e = buildCueEvent(input({ timezone: "America/Chicago", startDate: "2030-03-01" }));
    for (const t of [e.start.dateTime, e.end.dateTime]) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  });

  it("is never one of the session mirror's: no workout id, so a calendar sync never reads it as its own", () => {
    const e = buildCueEvent(input());
    expect(workoutIdFromEvent(e.extendedProperties)).toBeUndefined();
    expect(cueProfileFromEvent(e.extendedProperties)).toBe("jawcare");
    expect(cueSearch("jawcare")).toBe(`${CUE_PROPERTY}=jawcare`);
    expect(e.recurrence).toEqual([CUE_RECURRENCE]);
  });

  it("an app address with no origin stamps none", () => {
    expect(buildCueEvent(input({ appUrl: "" })).extendedProperties.private).toEqual({ rgCue: "jawcare", rgApp: "Run Garden" });
  });

  it("the description is one line", () => {
    expect(cueDescription("Jaw care")).not.toContain("\n");
  });
});

describe("cueStartDate: the first day it sounds", () => {
  it.each([
    ["one of the first seven days, the time still ahead: today", "2030-05-03", "06:00", "07:15", "2030-05-03"],
    ["one of the first seven days, the time passed: tomorrow", "2030-05-03", "08:00", "07:15", "2030-05-04"],
    ["exactly at the time counts as passed", "2030-05-01", "07:15", "07:15", "2030-05-02"],
    ["the seventh, the time ahead: today", "2030-05-07", "06:59", "07:15", "2030-05-07"],
    ["the seventh, the time passed: the first of next month", "2030-05-07", "07:16", "07:15", "2030-06-01"],
    ["the eighth: the first of next month", "2030-05-08", "00:00", "07:15", "2030-06-01"],
    ["the last day of a month: the first of the next", "2030-04-30", "23:59", "07:15", "2030-05-01"],
    ["late December: the first of January, next year", "2030-12-20", "12:00", "07:15", "2031-01-01"],
  ])("%s", (_why, today, clock, time, expected) => {
    expect(cueStartDate(today, clock, time)).toBe(expected);
  });
});

describe("wallClock", () => {
  it("is the date and time on the zone's clock, not UTC's", () => {
    // 02:00 UTC on the 8th is 16:00 on the 7th in Honolulu (UTC−10, no change of clocks).
    expect(wallClock(new Date("2030-05-08T02:00:00Z"), "Pacific/Honolulu")).toEqual({ date: "2030-05-07", time: "16:00" });
  });
});

describe("cueWallTimeOf: a listed event's clock time, as Google answers it", () => {
  it("reads a wall-clock start as sent, and one Google gives back with an offset, in the event's zone", () => {
    expect(cueWallTimeOf({ start: { dateTime: "2030-04-01T07:15:00", timeZone: "America/Denver" } })).toEqual({ time: "07:15", timezone: "America/Denver" });
    const offset = DateTime.fromISO("2030-04-01T07:15:00", { zone: "America/Denver" }).toISO()!;
    expect(cueWallTimeOf({ start: { dateTime: offset, timeZone: "America/Denver" } })).toEqual({ time: "07:15", timezone: "America/Denver" });
  });

  it("an event with no start time or no zone has none", () => {
    expect(cueWallTimeOf({ start: { date: "2030-04-01" } })).toBeNull();
    expect(cueWallTimeOf({ start: { dateTime: "2030-04-01T07:15:00" } })).toBeNull();
    expect(cueWallTimeOf({})).toBeNull();
  });
});
