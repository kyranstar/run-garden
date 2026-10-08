import { FixedOffsetZone, IANAZone, type Zone } from "luxon";

/**
 * THE ZONE THE SCHEDULING FUNCTIONS PLACE THINGS IN (cron reliability, 2026-10-08).
 *
 * Luxon, handed a zone by name, asks Intl for the offset (`formatToParts`) on every DateTime it makes, moves or
 * reads — about twenty times for one session's block and reminders. The calendar sync builds every mirrored
 * session's event on every run (70–120 of them), so those asks were most of a steady sync's CPU on Workers Free.
 *
 * This zone answers the same offsets, worked out once per UTC day: the offsets at the day's first and last
 * millisecond, and when they are equal no transition falls in that day (zones change offset at most a few times a
 * year, never twice in a day), so every instant of it has that offset. A day with a transition asks Intl per
 * instant, as Luxon would. The days are kept for the isolate's life, up to a bound.
 */
class DayOffsetZone extends IANAZone {
  /** UTC day number → the day's single offset, or null for a day with a transition. */
  private readonly days = new Map<number, number | null>();

  override offset(ts: number): number {
    const day = Math.floor(ts / DAY_MS);
    let fixed = this.days.get(day);
    if (fixed === undefined) {
      const first = super.offset(day * DAY_MS);
      fixed = first === super.offset(day * DAY_MS + DAY_MS - 1) ? first : null;
      if (this.days.size >= MAX_DAYS) this.days.clear();
      this.days.set(day, fixed);
    }
    return fixed ?? super.offset(ts);
  }
}

const DAY_MS = 86_400_000;
/** About eleven years of days per zone before the cache starts over. */
const MAX_DAYS = 4096;
const zones = new Map<string, Zone | string>();

/**
 * The zone to hand Luxon for `timezone`: a day-offset zone for an IANA name, and the name itself for whatever Luxon
 * reads otherwise (UTC, GMT, "local", a fixed "UTC+3"), so those keep Luxon's own handling.
 */
export function schedulingZone(timezone: string): Zone | string {
  let zone = zones.get(timezone);
  if (zone === undefined) {
    const lowered = timezone.toLowerCase();
    const special =
      ["default", "local", "system", "utc", "gmt"].includes(lowered) || FixedOffsetZone.parseSpecifier(lowered) !== null;
    zone = special ? timezone : new DayOffsetZone(timezone);
    zones.set(timezone, zone);
  }
  return zone;
}
