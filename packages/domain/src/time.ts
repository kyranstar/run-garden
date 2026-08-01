/**
 * Date/time conventions used across the codebase:
 *  - LocalDate: "YYYY-MM-DD" calendar date with no timezone.
 *  - LocalTime: "HH:MM" 24-hour wall-clock time.
 *  - Instant:   ISO 8601 UTC timestamp string ("...Z").
 * Timezone-aware math (event start/end instants, DST) lives in @rg/scheduling
 * which uses Luxon; this module is pure string/UTC arithmetic that is safe in
 * any runtime.
 */

export type LocalDate = string;
export type LocalTime = string;
export type Instant = string;

export interface DateRange {
  /** inclusive */
  start: LocalDate;
  /** inclusive */
  end: LocalDate;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    dt.getUTCFullYear() === Number(y) &&
    dt.getUTCMonth() === Number(mo) - 1 &&
    dt.getUTCDate() === Number(d)
  );
}

export function isLocalTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function assertLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) throw new Error(`Invalid LocalDate: ${value}`);
  return value;
}

function toUtc(date: LocalDate): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid LocalDate: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): LocalDate {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** b - a in whole days (positive when b is after a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minLocalDate(a: LocalDate, b: LocalDate): LocalDate {
  return a <= b ? a : b;
}

export function maxLocalDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const wd = toUtc(date).getUTCDay(); // 0 = Sunday
  return wd === 0 ? 7 : wd;
}

export function isWeekend(date: LocalDate): boolean {
  const wd = isoWeekday(date);
  return wd === 6 || wd === 7;
}

/** Monday of the ISO week containing `date`. */
export function startOfIsoWeek(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}

export function eachDay(range: DateRange): LocalDate[] {
  const out: LocalDate[] = [];
  const n = daysBetween(range.start, range.end);
  for (let i = 0; i <= n; i++) out.push(addDays(range.start, i));
  return out;
}

export function inRange(date: LocalDate, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

/** Current calendar date in an IANA timezone. */
export function todayInZone(timezone: string, now: Date = new Date()): LocalDate {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // en-CA yields YYYY-MM-DD
}

export function nowInstant(now: Date = new Date()): Instant {
  return now.toISOString();
}

export function minutesFromLocalTime(time: LocalTime): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid LocalTime: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function localTimeFromMinutes(minutes: number): LocalTime {
  const clamped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60).toString().padStart(2, "0");
  const mm = (clamped % 60).toString().padStart(2, "0");
  return `${h}:${mm}`;
}
