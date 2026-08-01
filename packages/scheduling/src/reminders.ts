import { DateTime } from "luxon";
import type { Instant, LocalDate, LocalTime, SchedulingPreferences } from "@rg/domain";
import { windowOfTime } from "./windows.js";

/**
 * Reminder policy:
 *  - Morning run: a previous-evening reminder at the configured wall-clock time
 *    ("protect tonight's sleep") plus a normal pre-run reminder (default 30 min).
 *  - Evening run: a single reminder 60 minutes before; no sleep reminder.
 * Google Calendar expresses reminders as minutes-before-start, so the
 * previous-evening reminder is converted using real elapsed minutes (DST-safe).
 */

export interface ReminderPlan {
  /** Google Calendar reminder overrides, minutes before event start. */
  overrideMinutes: number[];
  /** The instant the sleep-protection reminder will fire, when applicable. */
  sleepReminderInstant?: Instant;
  sleepReminderText?: string;
}

const GOOGLE_MAX_REMINDER_MINUTES = 40_320; // 4 weeks, API limit

export function planReminders(
  date: LocalDate,
  workoutStartTime: LocalTime,
  eventStartInstant: Instant,
  prefs: SchedulingPreferences,
): ReminderPlan {
  const window = windowOfTime(workoutStartTime);
  if (window === "evening") {
    return { overrideMinutes: [prefs.eveningPreRunReminderMinutes] };
  }

  const eventStart = DateTime.fromISO(eventStartInstant, { zone: "utc" }).setZone(prefs.timezone);
  const prevEvening = DateTime.fromISO(`${date}T${prefs.eveningReminderTime}`, {
    zone: prefs.timezone,
  }).minus({ days: 1 });

  const minutesBefore = Math.round(eventStart.diff(prevEvening, "minutes").minutes);
  const overrides = [prefs.preRunReminderMinutes];
  let sleepInstant: Instant | undefined;
  if (minutesBefore > 0 && minutesBefore <= GOOGLE_MAX_REMINDER_MINUTES) {
    overrides.push(minutesBefore);
    sleepInstant = prevEvening.toUTC().toISO({ suppressMilliseconds: true })!;
  }

  // The message references the workout start (not the padded block start).
  const runStart = DateTime.fromISO(`${date}T${workoutStartTime}`, { zone: prefs.timezone });
  const timeLabel = runStart.toFormat(runStart.minute === 0 ? "h a" : "h:mm a");

  return {
    overrideMinutes: dedupeSorted(overrides),
    sleepReminderInstant: sleepInstant,
    sleepReminderText: `Morning run tomorrow at ${timeLabel}. Protect tonight's sleep.`,
  };
}

function dedupeSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}
