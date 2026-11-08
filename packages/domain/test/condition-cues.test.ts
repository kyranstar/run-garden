/**
 * A CONDITION'S DAYTIME CUES (condition care gaps, Task 3): the times asked for, and what the preferences keep of the
 * calendar events made for them, by profile.
 *
 *  - Times are 24-hour "HH:MM", none twice, at most four; each refusal is in plain words.
 *  - The kept state is each event's time, id, calendar and zone, and when this account last settled it.
 *  - A stored value that no longer reads is none (the cue service then reads the calendar for the truth), never a
 *    failure of every other preference read with it.
 */
import { describe, expect, it } from "vitest";
import { CONDITION_CUE_TIMES_MAX, conditionCueTimesSchema, DEFAULT_USER_PREFERENCES, userPreferencesSchema } from "../src/index.js";

const message = (times: unknown): string | undefined => {
  const r = conditionCueTimesSchema.safeParse(times);
  return r.success ? undefined : r.error.issues[0]!.message;
};

describe("the cue times asked for", () => {
  it("take up to four 24-hour times", () => {
    expect(CONDITION_CUE_TIMES_MAX).toBe(4);
    expect(conditionCueTimesSchema.parse(["00:00", "07:15", "13:40", "23:59"])).toEqual(["00:00", "07:15", "13:40", "23:59"]);
    expect(conditionCueTimesSchema.parse([])).toEqual([]);
  });

  it.each([["7:15"], ["24:00"], ["07:60"], ["7.15"], ["07:15 "], [""]])("refuse %j: not HH:MM", (t) => {
    expect(message([t])).toBe('a time is 24-hour "HH:MM", like "07:15"');
  });

  it("refuse a time listed twice", () => {
    expect(message(["07:15", "13:40", "07:15"])).toBe("a time is listed twice");
  });

  it("refuse more than four", () => {
    expect(message(["01:00", "02:00", "03:00", "04:00", "05:00"])).toBe("at most 4 times");
  });

  it("refuse what is not a list of times", () => {
    expect(conditionCueTimesSchema.safeParse("07:15").success).toBe(false);
    expect(conditionCueTimesSchema.safeParse([715]).success).toBe(false);
  });
});

describe("the cues kept in the preferences", () => {
  const state = {
    events: [{ time: "07:15", eventId: "ev1", calendarId: "cal", timezone: "America/Denver" }],
    settledAt: "2030-04-01T00:00:00.000Z",
  };

  it("are absent until a cue is set", () => {
    expect(DEFAULT_USER_PREFERENCES.conditionCues).toBeUndefined();
  });

  it("read back by profile, as stored", () => {
    expect(userPreferencesSchema.parse({ conditionCues: { jawcare: state } }).conditionCues).toEqual({ jawcare: state });
    expect(userPreferencesSchema.parse({ conditionCues: { jawcare: { events: [], settledAt: null } } }).conditionCues).toEqual({
      jawcare: { events: [], settledAt: null },
    });
  });

  it("a stored value that no longer reads is none, and every other preference still reads", () => {
    const parsed = userPreferencesSchema.parse({ timezone: "America/Denver", conditionCues: { jawcare: { events: [{ time: "7:15" }] } } });
    expect(parsed.conditionCues).toBeUndefined();
    expect(parsed.timezone).toBe("America/Denver");
  });
});
