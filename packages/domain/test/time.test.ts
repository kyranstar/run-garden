import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  eachDay,
  isLocalDate,
  isoWeekday,
  isWeekend,
  localTimeFromMinutes,
  minutesFromLocalTime,
  startOfIsoWeek,
  todayInZone,
} from "../src/time.js";
import { fingerprint } from "../src/fingerprint.js";

describe("LocalDate math", () => {
  it("validates dates", () => {
    expect(isLocalDate("2026-08-01")).toBe(true);
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDate("2026-8-1")).toBe(false);
  });

  it("adds days across month/year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // leap year
  });

  it("is DST-independent (pure calendar math)", () => {
    // US DST spring forward 2026-03-08
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetween("2026-03-07", "2026-03-10")).toBe(3);
  });

  it("computes weekdays", () => {
    expect(isoWeekday("2026-08-01")).toBe(6); // Saturday
    expect(isoWeekday("2026-08-03")).toBe(1); // Monday
    expect(isWeekend("2026-08-02")).toBe(true);
    expect(isWeekend("2026-08-03")).toBe(false);
    expect(startOfIsoWeek("2026-08-01")).toBe("2026-07-27");
    expect(startOfIsoWeek("2026-07-27")).toBe("2026-07-27");
  });

  it("enumerates ranges", () => {
    expect(eachDay({ start: "2026-08-30", end: "2026-09-02" })).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("resolves today in a timezone", () => {
    const now = new Date("2026-08-01T05:30:00Z");
    expect(todayInZone("America/Los_Angeles", now)).toBe("2026-07-31");
    expect(todayInZone("Europe/Berlin", now)).toBe("2026-08-01");
  });

  it("converts local times", () => {
    expect(minutesFromLocalTime("07:00")).toBe(420);
    expect(localTimeFromMinutes(420)).toBe("07:00");
    expect(localTimeFromMinutes(420 - 630)).toBe("20:30"); // wraps to previous evening
  });
});

describe("fingerprint", () => {
  it("is stable across key order", () => {
    expect(fingerprint({ a: 1, b: [1, 2] })).toBe(fingerprint({ b: [1, 2], a: 1 }));
  });
  it("changes when content changes", () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
  it("ignores undefined fields", () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });
});
