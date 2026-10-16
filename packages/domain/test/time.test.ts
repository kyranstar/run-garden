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

  it("keeps one formatter per timezone: a second today in the same zone builds none (building one is the costly part)", () => {
    const Real = Intl.DateTimeFormat;
    let built = 0;
    const counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1;
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Object.assign(counting, Real);
    Intl.DateTimeFormat = counting;
    try {
      const now = new Date("2026-08-01T05:30:00Z");
      todayInZone("Asia/Kathmandu", now);
      const first = built;
      for (let i = 0; i < 50; i++) {
        expect(todayInZone("Asia/Kathmandu", new Date(now.getTime() + i * 3_600_000))).toBe(new Real("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now.getTime() + i * 3_600_000)));
      }
      expect(built - first).toBe(0);
    } finally {
      Intl.DateTimeFormat = Real;
    }
  });

  it("answers exactly what a fresh formatter does, in every zone the runtime knows, across DST edges and day lines", () => {
    // The uncached reference: a formatter built for each call, as todayInZone did before it kept them.
    const fresh = (tz: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    const edges = [
      "2026-03-08T09:59:59.999Z", "2026-03-08T10:00:00Z", // US spring forward (02:00 PST)
      "2026-11-01T08:59:59.999Z", "2026-11-01T09:00:00Z", // US fall back (02:00 PDT)
      "2026-03-29T00:59:59.999Z", "2026-03-29T01:00:00Z", // EU spring forward
      "2026-10-25T00:59:59.999Z", "2026-10-25T01:00:00Z", // EU fall back
      "2026-04-04T15:00:00Z", "2026-04-04T15:30:00Z", // Lord Howe's half hour back
      "2026-10-03T15:30:00Z", "2026-10-03T16:00:00Z", // southern spring
      "2011-12-29T09:59:59Z", "2011-12-30T10:00:00Z", // Samoa skipped a day
      "2026-12-31T09:59:59Z", "2026-12-31T10:00:00Z", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00Z",
      "2024-02-29T12:00:00Z", "1970-01-01T00:00:00Z", "2099-12-31T23:59:59Z",
    ].map((s) => new Date(s));
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const instants = [...edges, ...Array.from({ length: 24 }, () => new Date(Date.UTC(1990, 0, 1) + Math.floor(random() * 60 * 365 * 86_400_000)))];
    const zones = [...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/GMT+12", "Etc/GMT-14", "america/los_angeles"];
    expect(zones.length).toBeGreaterThan(300);
    for (const at of instants) {
      // Interleaved: each instant in every zone, so a zone's kept formatter is never another's.
      for (const tz of zones) expect(todayInZone(tz, at), `${tz} ${at.toISOString()}`).toBe(fresh(tz, at));
    }
  });

  it("refuses a zone the runtime doesn't know, every time — as a fresh formatter does (nothing kept for it)", () => {
    for (let i = 0; i < 2; i++) expect(() => todayInZone("Not/AZone")).toThrow(RangeError);
    expect(todayInZone("UTC", new Date("2026-08-01T23:30:00Z"))).toBe("2026-08-01");
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
