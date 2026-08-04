import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { mean, median, populationStdDev, roundTo } from "./stats.js";

/** Recovery/readiness metrics from COROS daily health. Rows may arrive in any
 * order; each function sorts newest-first internally.
 *
 * Every metric here is staleness-aware: it's not enough to have had 7 (or 17)
 * good readings at some point — the newest reading has to be recent, or the
 * "current" number would be describing a stranger's Tuesday. When staleness
 * is the actual problem, `have` is reported as 0 rather than the (larger,
 * gate-passing) total reading count — "Need 7; have 12" reads as
 * self-contradictory, so the day-count instead goes in the explanation text
 * (mirrors the load-ratio/ramp "no recent baseline" convention from Task A1). */

const DAY = 86_400_000;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export interface RestingHrValue {
  /** Median of the 3 most recent readings. */
  current: number;
  /** Median of readings within the last 30 days (may overlap `current`'s window). */
  baseline: number;
  deltaBpm: number;
  /** Whole days between the newest reading's date and `today`. */
  staleDays: number;
  /** Last 60 days of valid readings, ascending. */
  series: Array<{ date: string; value: number }>;
}

/** Resting heart rate vs. its 30-day baseline. Suppressed when there isn't
 * enough recent history (<7 valid readings in the last 60 days) or when the
 * newest reading is more than a week old — a "current" value built from
 * week-old-or-older data isn't current. */
export function computeRestingHr(
  rows: ReadonlyArray<{ date: string; restingHeartRate: number | null }>,
  today: string,
): MetricResult<RestingHrValue> {
  const windowStart = addDays(today, -59);
  const valid = rows
    .filter((r): r is { date: string; restingHeartRate: number } => r.restingHeartRate != null && r.restingHeartRate > 0)
    .filter((r) => r.date >= windowStart && r.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  if (valid.length < 7) {
    return insufficient(
      7,
      valid.length,
      `Resting heart-rate trend needs at least 7 valid COROS readings in the last 60 days; you have ${valid.length}.`,
    );
  }

  const newestDate = valid[0]!.date;
  const staleDays = daysBetween(newestDate, today);
  if (staleDays > 7) {
    return insufficient(
      7,
      0,
      `Your newest COROS resting heart-rate reading is ${staleDays} days old; resting heart-rate trend needs a reading from the last 7 days.`,
    );
  }

  const current = Math.round(median(valid.slice(0, 3).map((r) => r.restingHeartRate)));
  const baselineStart = addDays(today, -29);
  const baselinePool = valid.filter((r) => r.date >= baselineStart);
  const baseline = Math.round(median(baselinePool.map((r) => r.restingHeartRate)));

  const series = [...valid].reverse().map((r) => ({ date: r.date, value: r.restingHeartRate }));

  return ok(
    { current, baseline, deltaBpm: current - baseline, staleDays, series },
    valid.length,
    "Median of your 3 most recent resting heart-rate readings versus your 30-day median.",
  );
}

export interface HrvValue {
  /** Median of the 7 most recent readings (all within 14 days of `today`). */
  recent: number;
  /** Median of readings ranked 8+ (everything past the recent window — no overlap). */
  baseline: number;
  /** 1dp. */
  pctVsBaseline: number;
  /** clamp(0.5 * CV% of baseline readings, 5, 15); 10 when the baseline has no variability to measure. */
  thresholdPct: number;
  staleDays: number;
  /** Last 60 days of valid readings, ascending. */
  series: Array<{ date: string; value: number }>;
}

/** HRV trend vs. an uncontaminated baseline: unlike the old implementation
 * (which took a 7-day median for "recent" and a 30-day median for "baseline"
 * out of the *same* overlapping pool of readings, so the baseline was
 * partly made of the very readings it was being compared against and pulled
 * toward "recent"), the baseline here is built exclusively from readings
 * ranked 8th-most-recent and older — a disjoint pool. */
export function computeHrvTrend(
  rows: ReadonlyArray<{ date: string; hrv: number | null }>,
  today: string,
): MetricResult<HrvValue> {
  const valid = rows
    .filter((r): r is { date: string; hrv: number } => r.hrv != null && r.hrv > 0)
    .filter((r) => r.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  if (valid.length < 17) {
    return insufficient(
      17,
      valid.length,
      `HRV trend needs at least 17 valid COROS readings (7 recent + 10 baseline); you have ${valid.length}.`,
    );
  }

  const newestDate = valid[0]!.date;
  const staleDays = daysBetween(newestDate, today);
  if (staleDays > 7) {
    return insufficient(
      17,
      0,
      `Your newest COROS HRV reading is ${staleDays} days old; HRV trend needs a reading from the last 7 days.`,
    );
  }

  const recentReadings = valid.slice(0, 7);
  const oldestRecentDays = daysBetween(recentReadings[recentReadings.length - 1]!.date, today);
  if (oldestRecentDays > 14) {
    return insufficient(
      17,
      0,
      `Your 7 most recent HRV readings span ${oldestRecentDays} days; HRV trend needs all of them within a 14-day window.`,
    );
  }

  const baselineReadings = valid.slice(7); // guaranteed >= 10 given the length-17 gate above
  const recent = median(recentReadings.map((r) => r.hrv));
  const baseline = median(baselineReadings.map((r) => r.hrv));
  const pctVsBaseline = baseline > 0 ? roundTo(((recent - baseline) / baseline) * 100, 1) : 0;

  const baselineValues = baselineReadings.map((r) => r.hrv);
  const baselineMean = mean(baselineValues);
  const baselineSd = populationStdDev(baselineValues);
  // A baseline with zero observed variability can't produce a meaningful
  // smallest-worthwhile-change threshold (clamping 0 up to the floor of 5
  // would imply more confidence than the data supports), so fall back to a
  // sensible default instead.
  const thresholdPct =
    baselineMean > 0 && baselineSd > 0 ? roundTo(clamp(0.5 * ((baselineSd / baselineMean) * 100), 5, 15), 1) : 10;

  const windowStart = addDays(today, -59);
  const series = [...valid]
    .filter((r) => r.date >= windowStart)
    .reverse()
    .map((r) => ({ date: r.date, value: r.hrv }));

  return ok(
    { recent: Math.round(recent), baseline: Math.round(baseline), pctVsBaseline, thresholdPct, staleDays, series },
    valid.length,
    "Median of your 7 most recent HRV readings versus a baseline from earlier, non-overlapping readings.",
  );
}

export interface HardStackValue {
  consecutive: number;
  /** Last 7 days, ascending. */
  strip: Array<{ date: string; hard: boolean }>;
}

function streakEndingAt(hardDates: ReadonlySet<string>, end: string): number {
  let count = 0;
  let cursor = end;
  while (hardDates.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** Consecutive days of a quality/race effort. A streak that ended yesterday
 * is still live-feeling context even if today hasn't happened yet (or was a
 * rest day) — so this reports whichever is longer: the streak ending today,
 * or the streak ending yesterday. 0 is a valid answer (not suppressed). */
export function computeHardDayStacking(
  hardDates: readonly string[],
  today: string,
): MetricResult<HardStackValue> {
  const set = new Set(hardDates);
  const yesterday = addDays(today, -1);
  const consecutive = Math.max(streakEndingAt(set, today), streakEndingAt(set, yesterday));

  const stripStart = addDays(today, -6);
  const strip: Array<{ date: string; hard: boolean }> = [];
  for (let d = stripStart; d <= today; d = addDays(d, 1)) {
    strip.push({ date: d, hard: set.has(d) });
  }

  return ok(
    { consecutive, strip },
    hardDates.length,
    "Consecutive days with a quality or race effort, counting a streak ending yesterday if today hasn't had one yet.",
  );
}
