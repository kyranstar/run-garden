import { DateTime } from "luxon";
import { CALENDAR_EVENT_PROPERTY_NS, PRODUCT_NAME } from "@rg/domain";
import { appOrigin } from "./event-body.js";

/**
 * A condition's daytime cue as a Google Calendar event (condition care gaps, Task 3): one recurring event per time of
 * day, five minutes long, marked free, one alert at its start, on the first seven days of every month. Its start is the
 * athlete's wall-clock time with their IANA zone — never an instant or an offset — so Google keeps the clock time when
 * the clocks change. The title is the profile's cue words; the description, one line, says where it came from and how to
 * turn it off.
 *
 * It carries the private property `rgCue` (the profile's id), the app's name and its origin — and never `rgWorkoutId`:
 * the session mirror (the worker's calendar-sync.ts) takes an event for its own only by `rgWorkoutId`, so no sync lists,
 * moves, re-times or deletes a cue, nor any occurrence of one (an occurrence carries its series' properties).
 */

export const CUE_RECURRENCE = "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7";
/** The cue sounds on days 1 to CUE_LAST_DAY of each month (the rule above). */
export const CUE_LAST_DAY = 7;
export const CUE_MINUTES = 5;
/** The private extended property that marks a cue event, its value the profile's id. */
export const CUE_PROPERTY = `${CALENDAR_EVENT_PROPERTY_NS}Cue`;

export interface CueEventResource {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence: string[];
  transparency: "transparent";
  reminders: { useDefault: false; overrides: Array<{ method: "popup"; minutes: number }> };
  extendedProperties: { private: Record<string, string> };
}

export interface CueEventInput {
  profileId: string;
  /** The profile's cue words: the title. */
  words: string;
  /** The profile's name: where the cue came from. */
  label: string;
  /** "HH:MM" on the athlete's clock. */
  time: string;
  /** The first day it sounds (`cueStartDate`). */
  startDate: string;
  timezone: string;
  /** The app's address; its origin is stamped, as the session events' is. */
  appUrl: string;
}

/** One line: where the cue came from, and how to turn it off. */
export function cueDescription(label: string): string {
  return `${PRODUCT_NAME}'s daytime cue for ${label}: ask the coach or the app to turn these off.`;
}

const WALL = "yyyy-MM-dd'T'HH:mm:ss";

export function buildCueEvent(input: CueEventInput): CueEventResource {
  const start = `${input.startDate}T${input.time}:00`;
  // Five minutes on the wall clock (read as UTC, so no zone's change of clocks enters the sum).
  const end = DateTime.fromISO(start, { zone: "UTC" }).plus({ minutes: CUE_MINUTES }).toFormat(WALL);
  const origin = appOrigin(input.appUrl);
  return {
    summary: input.words,
    description: cueDescription(input.label),
    start: { dateTime: start, timeZone: input.timezone },
    end: { dateTime: end, timeZone: input.timezone },
    recurrence: [CUE_RECURRENCE],
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    extendedProperties: {
      private: {
        [CUE_PROPERTY]: input.profileId,
        [`${CALENDAR_EVENT_PROPERTY_NS}App`]: PRODUCT_NAME,
        ...(origin ? { [`${CALENDAR_EVENT_PROPERTY_NS}Origin`]: origin } : {}),
      },
    },
  };
}

/** The date and the "HH:MM" on the zone's clock at `now`. */
export function wallClock(now: Date, timezone: string): { date: string; time: string } {
  const at = DateTime.fromJSDate(now, { zone: timezone });
  return { date: at.toFormat("yyyy-MM-dd"), time: at.toFormat("HH:mm") };
}

/**
 * The first day a cue at `time` sounds, from the athlete's `today` and `clock`: today, when today is one of the rule's
 * days and the time is still ahead; else the next of the rule's days — tomorrow, or the 1st of next month. Google
 * counts the start as the first occurrence, so a start off the rule's days would sound once where the rule never does.
 */
export function cueStartDate(today: string, clock: string, time: string): string {
  const day = Number(today.slice(8, 10));
  if (day <= CUE_LAST_DAY && time > clock) return today;
  if (day < CUE_LAST_DAY) return DateTime.fromISO(today, { zone: "UTC" }).plus({ days: 1 }).toFormat("yyyy-MM-dd");
  return DateTime.fromISO(today, { zone: "UTC" }).startOf("month").plus({ months: 1 }).toFormat("yyyy-MM-dd");
}

/** The profile a cue event is for, if it is one. */
export function cueProfileFromEvent(extendedProperties?: { private?: Record<string, string> }): string | undefined {
  return extendedProperties?.private?.[CUE_PROPERTY];
}

/** The calendar search for a profile's cue events (a private extended property, "key=value"). */
export const cueSearch = (profileId: string): string => `${CUE_PROPERTY}=${profileId}`;

/**
 * A listed event's clock time and zone: its start in its own zone, whether Google answers it as the wall clock sent or
 * with the zone's offset. Null without a timed start or a zone.
 */
export function cueWallTimeOf(event: { start?: { dateTime?: string; timeZone?: string; date?: string } }): { time: string; timezone: string } | null {
  const dateTime = event.start?.dateTime;
  const timezone = event.start?.timeZone;
  if (!dateTime || !timezone) return null;
  const at = DateTime.fromISO(dateTime, { zone: timezone });
  return at.isValid ? { time: at.toFormat("HH:mm"), timezone } : null;
}
