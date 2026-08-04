import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { mean, populationStdDev, roundTo } from "./stats.js";

/** Training-load metrics. Load is COROS training load per day (or run duration
 * when load is missing); the caller aggregates by day and discloses the basis.
 * All three metrics gate on daily history since the earliest positive-load
 * (or positive-seconds) entry, so a metric is only ever reported once there's
 * enough real training behind it to make the comparison honest. */

const DAY = 86_400_000;

function cutoff(today: string, daysBack: number): string {
  return new Date(Date.parse(today) - daysBack * DAY).toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

/** Dense daily values from `from` to `to` inclusive; days with no entry at all
 * are 0. Same-day entries are summed as given — this function does no sign
 * filtering, so a day whose only entries are negative sums to a negative
 * value, not to 0. (Callers pass durations and provider loads, which are
 * non-negative by construction.) */
function zeroFillDays(entries: ReadonlyArray<{ date: string; value: number }>, from: string, to: string): number[] {
  const byDate = new Map<string, number>();
  for (const e of entries) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.value);
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(byDate.get(d) ?? 0);
  return out;
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface LoadRatioValue {
  /** EWMA(7) / EWMA(28), 2dp. */
  ratio: number;
  /** Math.round((ratio - 1) * 100). */
  pctVsNorm: number;
  /** Last 56 computed days. */
  series: Array<{ date: string; ratio: number }>;
}

/** Acute:chronic training-load ratio using exponentially-weighted moving
 * averages (Williams et al.), instead of a rolling-window average — this
 * avoids the "phantom spike/drop" artifacts a simple rolling ACWR produces
 * when a big training day rolls out of the window. */
export function computeLoadRatio(
  loadsByDay: ReadonlyArray<{ date: string; load: number }>,
  today: string,
): MetricResult<LoadRatioValue> {
  const positive = loadsByDay.filter((e) => e.load > 0 && e.date <= today);
  if (positive.length === 0) {
    return insufficient(28, 0, "The load ratio needs about four weeks of recorded runs.");
  }
  const earliest = positive.reduce((min, e) => (e.date < min ? e.date : min), today);
  const daysOfHistory = daysBetween(earliest, today) + 1;
  if (daysOfHistory < 28) {
    return insufficient(
      28,
      daysOfHistory,
      `The load ratio needs about four weeks of history; you have ${daysOfHistory} days.`,
    );
  }

  // A metric spanning months of history but with nothing in the last four
  // weeks has no recent baseline to compare against — a literal ratio here
  // would look like a confident measurement of stress that isn't there.
  const recentStart = cutoff(today, 27);
  const hasRecentLoad = loadsByDay.some((e) => e.load > 0 && e.date >= recentStart && e.date <= today);
  if (!hasRecentLoad) {
    return insufficient(28, 0, "The load ratio needs runs in the last four weeks to form a baseline.");
  }

  const values = zeroFillDays(
    positive.map((e) => ({ date: e.date, value: e.load })),
    earliest,
    today,
  );
  const dates = datesBetween(earliest, today);
  const lambda7 = 2 / (7 + 1);
  const lambda28 = 2 / (28 + 1);

  let ewma7 = values[0]!;
  let ewma28 = values[0]!;
  const series: Array<{ date: string; ratio: number }> = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      ewma7 = lambda7 * values[i]! + (1 - lambda7) * ewma7;
      ewma28 = lambda28 * values[i]! + (1 - lambda28) * ewma28;
    }
    // Guard against a near-zero chronic average producing a meaningless or
    // divide-by-near-zero ratio for very early/degenerate days.
    if (ewma28 < 1e-6) continue;
    series.push({ date: dates[i]!, ratio: roundTo(ewma7 / ewma28, 2) });
  }
  if (series.length === 0 || ewma28 < 1e-6) {
    return insufficient(28, 0, "The load ratio needs runs in the last four weeks to form a baseline.");
  }

  const ratio = series[series.length - 1]!.ratio;
  return ok(
    { ratio, pctVsNorm: Math.round((ratio - 1) * 100), series: series.slice(-56) },
    positive.length,
    "EWMA(7) acute load over EWMA(28) chronic load — a smoothed acute:chronic training-load ratio.",
  );
}

export interface RampValue {
  deltaSeconds: number;
  pct: number;
}

/** Trailing 7-day running volume vs the prior 21-day weekly norm. */
export function computeRamp(
  secondsByDay: ReadonlyArray<{ date: string; seconds: number }>,
  today: string,
): MetricResult<RampValue> {
  const positive = secondsByDay.filter((e) => e.seconds > 0 && e.date <= today);
  if (positive.length === 0) {
    return insufficient(28, 0, "Ramp needs about four weeks of recorded runs.");
  }
  const earliest = positive.reduce((min, e) => (e.date < min ? e.date : min), today);
  const daysOfHistory = daysBetween(earliest, today) + 1;
  if (daysOfHistory < 28) {
    return insufficient(28, daysOfHistory, `Ramp needs about four weeks of history; you have ${daysOfHistory} days.`);
  }

  const acuteStart = cutoff(today, 6);
  const priorStart = cutoff(today, 27);
  const priorEnd = cutoff(today, 7);
  const acute = secondsByDay
    .filter((e) => e.date >= acuteStart && e.date <= today)
    .reduce((s, e) => s + e.seconds, 0);
  const priorSum = secondsByDay
    .filter((e) => e.date >= priorStart && e.date <= priorEnd)
    .reduce((s, e) => s + e.seconds, 0);
  const norm = priorSum / 3;

  if (norm <= 0) {
    // History clears the 28-day gate, but nothing in the prior-21-day norm
    // window — the thing that's missing is recent running, not history
    // length, so "have" reports that (0), not daysOfHistory.
    return insufficient(28, 0, "Ramp needs a recent baseline — you're returning from a break, build back gradually.");
  }

  return ok(
    { deltaSeconds: Math.round(acute - norm), pct: Math.round(((acute - norm) / norm) * 100) },
    positive.length,
    "Last 7 days of running time vs. the prior 21-day weekly average.",
  );
}

export interface MonotonyValue {
  monotony: number;
  strain: number;
  weeklyLoad: number;
}

/** Day-to-day training-load variability (Foster's monotony/strain): a high
 * ratio of mean to standard deviation means every day looks the same —
 * repetitive load with no easy days built in, which strain then scales by
 * the week's total volume. */
export function computeMonotony(
  loadsByDay: ReadonlyArray<{ date: string; load: number }>,
  today: string,
): MetricResult<MonotonyValue> {
  const positive = loadsByDay.filter((e) => e.load > 0 && e.date <= today);
  if (positive.length === 0) {
    return insufficient(14, 0, "Monotony needs about two weeks of recorded runs.");
  }
  const earliest = positive.reduce((min, e) => (e.date < min ? e.date : min), today);
  const daysOfHistory = daysBetween(earliest, today) + 1;
  if (daysOfHistory < 14) {
    return insufficient(
      14,
      daysOfHistory,
      `Monotony needs about two weeks of history; you have ${daysOfHistory} days.`,
    );
  }

  const weekStart = cutoff(today, 6);
  const activeDaysLast7 = new Set(
    loadsByDay.filter((e) => e.load > 0 && e.date >= weekStart && e.date <= today).map((e) => e.date),
  ).size;
  if (activeDaysLast7 < 4) {
    return insufficient(4, activeDaysLast7, "Monotony needs at least 4 active days in the trailing week.");
  }

  const values = zeroFillDays(
    loadsByDay.map((e) => ({ date: e.date, value: e.load })),
    weekStart,
    today,
  );
  const weeklyLoad = values.reduce((s, v) => s + v, 0);
  const sd = populationStdDev(values);
  const monotony = sd > 0 ? roundTo(mean(values) / sd, 2) : 5;
  const strain = Math.round(weeklyLoad * monotony);

  return ok(
    { monotony, strain, weeklyLoad: Math.round(weeklyLoad) },
    activeDaysLast7,
    "Mean daily load divided by its standard deviation over the last 7 days; strain is weekly load × monotony.",
  );
}
