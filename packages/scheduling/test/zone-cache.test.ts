/**
 * A ZONE'S OFFSETS ARE LOOKED UP ONCE PER DAY (cron reliability, 2026-10-08).
 *
 * The calendar sync builds every mirrored session's event on every run — 70 to 120 of them — and each build placed
 * the block and its reminders through Luxon with the zone given by name. Every Luxon DateTime made, moved or read in
 * a named zone asks Intl for that instant's offset (`formatToParts`), about a dozen times a session: ~60 µs a
 * session warm and several times that cold, the largest part of a steady sync's CPU on Workers Free.
 *
 * Now the scheduling functions use a zone that works out each UTC day's offset once — the offset at the day's first
 * and last millisecond; equal means the day has no transition, and only a transition day asks per instant. The
 * results are Luxon's own: checked here against the old code, across zones with half-hour DST, 45-minute offsets
 * and DST that is suspended for Ramadan.
 */
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, DEFAULT_SCHEDULING_PREFERENCES, type SchedulingPreferences } from "@rg/domain";
import { computeBlock, fitsEvening, instantToZoned, latestEveningEndBefore, zonedInstant } from "../src/windows.js";
import { planReminders } from "../src/reminders.js";

/** computeBlock as it was: Luxon with the zone by name. */
function referenceBlock(date: string, time: string, workoutSeconds: number, prefs: SchedulingPreferences) {
  const workoutStart = DateTime.fromISO(`${date}T${time}`, { zone: prefs.timezone });
  const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true })!;
  const workoutEnd = workoutStart.plus({ seconds: workoutSeconds });
  return {
    startInstant: iso(workoutStart.minus({ minutes: prefs.bufferBeforeMinutes })),
    endInstant: iso(workoutEnd.plus({ minutes: prefs.bufferAfterMinutes })),
    workoutStartInstant: iso(workoutStart),
    workoutEndInstant: iso(workoutEnd),
  };
}

/** planReminders' zone work as it was (the morning branch). */
function referenceReminders(date: string, time: string, eventStartInstant: string, prefs: SchedulingPreferences) {
  const eventStart = DateTime.fromISO(eventStartInstant, { zone: "utc" }).setZone(prefs.timezone);
  const prevEvening = DateTime.fromISO(`${date}T${prefs.eveningReminderTime}`, { zone: prefs.timezone }).minus({ days: 1 });
  const minutesBefore = Math.round(eventStart.diff(prevEvening, "minutes").minutes);
  const runStart = DateTime.fromISO(`${date}T${time}`, { zone: prefs.timezone });
  return {
    minutesBefore,
    sleepInstant: prevEvening.toUTC().toISO({ suppressMilliseconds: true }),
    label: runStart.toFormat(runStart.minute === 0 ? "h a" : "h:mm a"),
  };
}

const ZONES = [
  "America/Los_Angeles",
  "Europe/London",
  "Australia/Lord_Howe", // DST of half an hour
  "Asia/Kathmandu", // +05:45
  "Pacific/Chatham", // +12:45 / +13:45
  "Africa/Casablanca", // DST suspended for Ramadan: two transitions a month apart
  "America/Santiago",
  "Asia/Tokyo",
];
const TIMES = ["00:30", "01:30", "02:00", "02:30", "07:00", "23:50"];

afterEach(() => vi.restoreAllMocks());

describe("the scheduling zone (offsets once per day)", () => {
  it("places blocks, reminders and zoned instants exactly as Luxon's named zone did", { timeout: 30_000 }, () => {
    const mismatches: string[] = [];
    for (const timezone of ZONES) {
      const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone };
      for (let d = 0; d < 400; d++) {
        const date = addDays("2026-01-01", d);
        for (const time of TIMES) {
          const block = computeBlock(date, time, 3000, prefs);
          const ref = referenceBlock(date, time, 3000, prefs);
          if (JSON.stringify(block) !== JSON.stringify(ref)) mismatches.push(`block ${timezone} ${date} ${time}`);
          if (zonedInstant(date, time, timezone) !== ref.workoutStartInstant) mismatches.push(`instant ${timezone} ${date} ${time}`);
          if (time < "12:00") {
            const plan = planReminders(date, time, block.startInstant, prefs);
            const r = referenceReminders(date, time, block.startInstant, prefs);
            const expected = r.minutesBefore > 0 && r.minutesBefore <= 40_320;
            if (expected !== plan.overrideMinutes.includes(r.minutesBefore)) mismatches.push(`reminder ${timezone} ${date} ${time}`);
            if (expected && plan.sleepReminderInstant !== r.sleepInstant) mismatches.push(`sleep ${timezone} ${date} ${time}`);
            if (!plan.sleepReminderText?.includes(` at ${r.label}.`)) mismatches.push(`label ${timezone} ${date} ${time}`);
          }
          const zoned = instantToZoned(ref.workoutStartInstant, timezone);
          const refZoned = DateTime.fromISO(ref.workoutStartInstant, { zone: "utc" }).setZone(timezone);
          if (zoned.toISO() !== refZoned.toISO()) mismatches.push(`zoned ${timezone} ${date} ${time}`);
        }
        if (fitsEvening(date, "19:00", 3600, prefs) !== referenceFits(date, prefs)) mismatches.push(`fits ${timezone} ${date}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("an invalid or fixed zone behaves as before", () => {
    for (const timezone of ["UTC", "utc", "UTC+3", "Etc/GMT+5"]) {
      const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone };
      expect(computeBlock("2026-03-08", "02:30", 3000, prefs)).toEqual(referenceBlock("2026-03-08", "02:30", 3000, prefs));
    }
    expect(() => zonedInstant("2026-03-08", "07:00", "Fantasia/Castle")).toThrow(/Invalid zoned datetime/);
    const busy = [{ start: "2026-03-08T05:00:00Z", end: "2026-03-08T06:30:00Z" }];
    expect(latestEveningEndBefore("2026-03-08", busy, "America/Los_Angeles")?.toISO()).toBe(
      DateTime.fromISO("2026-03-08T06:30:00Z", { zone: "utc" }).setZone("America/Los_Angeles").toISO(),
    );
  });

  it("asks Intl for a day's offset about twice, not about twenty times a session", () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    // A zone no other test here touched, so nothing is cached yet.
    const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone: "America/Denver" };
    const days = 70;
    const run = () => {
      for (let d = 0; d < days; d++) {
        const date = addDays("2026-09-27", d);
        const block = computeBlock(date, "07:00", 3000, prefs);
        planReminders(date, "07:00", block.startInstant, prefs);
      }
    };
    run();
    // Two asks per UTC day touched (each session's and the evening before's), plus a transition day's own asks:
    // under three a session, where Luxon's named zone asked about twenty (1,366 for these 70, measured).
    expect(parts.mock.calls.length).toBeLessThanOrEqual(3 * days);
    parts.mockClear();
    run();
    // Again, only the transition day (2026-11-01) asks: its instants are not cached.
    expect(parts.mock.calls.length).toBeLessThanOrEqual(24);
  });
});

function referenceFits(date: string, prefs: SchedulingPreferences): boolean {
  const start = DateTime.fromISO(`${date}T19:00`, { zone: prefs.timezone });
  const finish = start.plus({ seconds: 3600, minutes: prefs.bufferAfterMinutes });
  const latest = DateTime.fromISO(`${date}T${prefs.latestEveningFinish}`, { zone: prefs.timezone });
  return finish <= latest;
}
