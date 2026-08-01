import { DateTime } from "luxon";
import type { Instant, LocalDate, LocalTime, SchedulingPreferences } from "@rg/domain";
import { isWeekend } from "@rg/domain";

export type DayWindow = "morning" | "evening";

/** Preferred wall-clock start time for a window on a given date. */
export function preferredTimeFor(
  date: LocalDate,
  window: DayWindow,
  prefs: SchedulingPreferences,
): LocalTime {
  if (window === "evening") return prefs.weekdayEveningTime;
  return isWeekend(date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
}

/** A wall-clock time on a date in the user's zone, as a UTC instant. DST-safe via Luxon. */
export function zonedInstant(date: LocalDate, time: LocalTime, timezone: string): Instant {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!dt.isValid) throw new Error(`Invalid zoned datetime ${date}T${time} in ${timezone}`);
  return dt.toUTC().toISO({ suppressMilliseconds: true })!;
}

export function instantToZoned(instant: Instant, timezone: string): DateTime {
  return DateTime.fromISO(instant, { zone: "utc" }).setZone(timezone);
}

export function windowOfTime(time: LocalTime): DayWindow {
  return time < "12:00" ? "morning" : "evening";
}

export interface ScheduledBlock {
  startInstant: Instant;
  endInstant: Instant;
  workoutStartInstant: Instant;
  workoutEndInstant: Instant;
}

/** Compute the padded calendar block for a workout placement. */
export function computeBlock(
  date: LocalDate,
  time: LocalTime,
  workoutSeconds: number,
  prefs: SchedulingPreferences,
): ScheduledBlock {
  const workoutStart = DateTime.fromISO(`${date}T${time}`, { zone: prefs.timezone });
  const blockStart = workoutStart.minus({ minutes: prefs.bufferBeforeMinutes });
  const workoutEnd = workoutStart.plus({ seconds: workoutSeconds });
  const blockEnd = workoutEnd.plus({ minutes: prefs.bufferAfterMinutes });
  const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true })!;
  return {
    startInstant: iso(blockStart),
    endInstant: iso(blockEnd),
    workoutStartInstant: iso(workoutStart),
    workoutEndInstant: iso(workoutEnd),
  };
}

/** Would an evening placement finish by the configured latest evening finish? */
export function fitsEvening(
  date: LocalDate,
  time: LocalTime,
  workoutSeconds: number,
  prefs: SchedulingPreferences,
): boolean {
  const start = DateTime.fromISO(`${date}T${time}`, { zone: prefs.timezone });
  const finish = start.plus({ seconds: workoutSeconds, minutes: prefs.bufferAfterMinutes });
  const latest = DateTime.fromISO(`${date}T${prefs.latestEveningFinish}`, { zone: prefs.timezone });
  return finish <= latest;
}

export interface BusyInterval {
  start: Instant;
  end: Instant;
  title?: string;
}

export function overlapsBusy(block: ScheduledBlock, busy: BusyInterval[]): BusyInterval[] {
  return busy.filter((b) => b.start < block.endInstant && b.end > block.startInstant);
}

/** Latest busy-interval end on the evening before `date` (for late-night detection). */
export function latestEveningEndBefore(
  date: LocalDate,
  busy: BusyInterval[],
  timezone: string,
): DateTime | undefined {
  const prevStart = DateTime.fromISO(`${date}T00:00`, { zone: timezone }).minus({ hours: 6 });
  const dayStart = DateTime.fromISO(`${date}T00:00`, { zone: timezone }).plus({ hours: 4 });
  let latest: DateTime | undefined;
  for (const b of busy) {
    const end = DateTime.fromISO(b.end, { zone: "utc" }).setZone(timezone);
    if (end > prevStart && end < dayStart) {
      if (!latest || end > latest) latest = end;
    }
  }
  return latest;
}
