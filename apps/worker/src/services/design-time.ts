/**
 * A DESIGNED WORKOUT'S TIME, NEVER ONE ALREADY PAST (fix wave 3B, B-I1). One rule for the three places that need it —
 * propose_workout (design-tools/propose.ts), the approve (design-approve.ts) and the manifest's line (design-manifest.ts)
 * — so the card always says the time the approve would use.
 *
 *  - LATER TODAY: the main coach's new workout carries a time at least LATER_LEAD_MIN after now in the athlete's zone
 *    (`laterTodayRefusal`; the refusal names the earliest time that works, or says no time is left today).
 *  - ANY DESIGN: a new workout for today at a time already past is refused (`pastTimeRefusal`, code `past_time`).
 *  - NOW: a new workout for today with no time is marked `atNow` at propose, and placed at the moment of the approve,
 *    rounded up to NOW_ROUND_MIN.
 *  - APPROVE: a new workout for today with no time whose usual time (the athlete's window: day-placement.ts
 *    `windowTimeFor`) has passed is placed at the next SLOT_MIN slot from now, never in the past; its own time, if it
 *    has passed since, is refused (`past_time`); and with no slot left before midnight it is refused the same way.
 *    Otherwise a workout with no time goes to the athlete's window, as a Studio save places one.
 */
import { minutesFromLocalTime, type SchedulingPreferences } from "@rg/domain";
import { windowTimeFor } from "./day-placement.js";

/** How far ahead of now a later-today workout's time must be (minutes). */
export const LATER_LEAD_MIN = 15;
/** A today workout with no time, its usual time gone by: placed at the next slot of this many minutes. */
export const SLOT_MIN = 15;
/** A "now" design with no time: placed at now, rounded up to this many minutes. */
export const NOW_ROUND_MIN = 5;
const DAY_MIN = 24 * 60;

/** The athlete's wall clock at `now`: their local date, and the minute of their day with its seconds as a fraction. */
export function clockIn(tz: string, now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")) + Number(get("second")) / 60,
  };
}

/** "HH:MM" for a minute of the day; null past the day's last minute. */
function clockTime(minutes: number): string | null {
  if (minutes >= DAY_MIN) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The first minute at or after `minutes` on a `step`-minute boundary, as "HH:MM"; null when none is left today. */
export function slotAtOrAfter(minutes: number, step: number): string | null {
  return clockTime(Math.ceil(minutes / step - 1e-9) * step);
}

/** Has "HH:MM" on `date` gone by at the clock `at`? */
const passed = (time: string, at: { date: string; minutes: number }, date: string): boolean => date === at.date && minutesFromLocalTime(time) < Math.floor(at.minutes);

/** The words of a past-time refusal, for the coach and the athlete alike. */
export const pastTimeWhy = (time: string): string => `${time} today has passed.`;
export const NO_TIME_LEFT = "There's no time left today.";

/** A new workout for today at a time already past: why, or null. */
export function pastTime(date: string, time: string | undefined, at: { date: string; minutes: number }): string | null {
  return time && passed(time, at, date) ? pastTimeWhy(time) : null;
}

/** Later today's rule for the main coach's new workout: null when its time works, else the refusal's parts. */
export function laterTodayRefusal(
  date: string,
  time: string | undefined,
  at: { date: string; minutes: number },
): { error: "needs_time" | "time_too_soon"; why: string; fix: string } | null {
  const earliest = clockTime(Math.ceil(at.minutes + LATER_LEAD_MIN - 1e-9));
  const nowWords = clockTime(Math.floor(at.minutes));
  const noneLeft = `No time is left today: it is ${nowWords} where the athlete is. Propose it for another day, or finish and say so.`;
  if (!time) {
    if (!earliest) return { error: "needs_time", why: `Later today needs a time, and ${NO_TIME_LEFT.toLowerCase()}`, fix: noneLeft };
    return {
      error: "needs_time",
      why: `Later today needs a time, at least ${LATER_LEAD_MIN} minutes from now: ${earliest} or later where the athlete is (it is ${nowWords} there).`,
      fix: `Give target.time (HH:MM), ${earliest} or later — the athlete's usual time if it is still ahead, or the next free slot.`,
    };
  }
  if (date !== at.date || minutesFromLocalTime(time) >= at.minutes + LATER_LEAD_MIN) return null;
  if (!earliest) return { error: "time_too_soon", why: `${time} is less than ${LATER_LEAD_MIN} minutes from now.`, fix: noneLeft };
  return {
    error: "time_too_soon",
    why: `${time} is less than ${LATER_LEAD_MIN} minutes from now (it is ${nowWords} where the athlete is).`,
    fix: `Give target.time ${earliest} or later.`,
  };
}

/** A new workout's day, its time if it has one, and whether a "now" design left it untimed. */
export interface NewTarget {
  date: string;
  time?: string;
  atNow?: true;
}

/**
 * The time the approve gives a new workout of the coach's (see the module comment), at `now` for an athlete with
 * `prefs`: `{ time, pinned: true }` a time asked for or placed now — pinned, as a time asked for always is; `{ time,
 * pinned: false }` the athlete's window, where a Studio save places an untimed workout (its collision pass may still
 * move it); or `{ refused }` — a time already past, or none left today.
 */
export function approveTimeOf(
  target: NewTarget,
  category: string,
  o: { now: Date; prefs: SchedulingPreferences },
): { time: string; pinned: boolean } | { refused: string } {
  const at = clockIn(o.prefs.timezone || "UTC", o.now);
  if (target.time) {
    const why = pastTime(target.date, target.time, at);
    return why ? { refused: why } : { time: target.time, pinned: true };
  }
  const usual = windowTimeFor({ category, date: target.date }, o.prefs);
  if (target.date !== at.date) return { time: usual, pinned: false };
  if (target.atNow) {
    const time = slotAtOrAfter(at.minutes, NOW_ROUND_MIN);
    return time ? { time, pinned: true } : { refused: NO_TIME_LEFT };
  }
  if (minutesFromLocalTime(usual) >= at.minutes) return { time: usual, pinned: false };
  const time = slotAtOrAfter(at.minutes, SLOT_MIN);
  return time ? { time, pinned: true } : { refused: NO_TIME_LEFT };
}
