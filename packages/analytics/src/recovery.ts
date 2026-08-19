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

/** `current` is only built from readings this recent. */
const RECENT_WINDOW_DAYS = 5;
/** …and needs at least this many of them (a median of one is just a reading). */
const MIN_RECENT_READINGS = 2;
/** Minimum readings in the 30-day pool the baseline median is taken from. */
const MIN_BASELINE_READINGS = 7;

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
  /** Median of the 3 most recent readings, all of them within 5 days of `today`. */
  current: number;
  /** Median of readings within the last 30 days (>= 7 of them; may overlap `current`'s window). */
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
 * week-old-or-older data isn't current.
 *
 * Both halves of the comparison are separately recency-gated, because
 * "enough readings somewhere in the window" is not the same claim as
 * "enough readings recently enough to describe now":
 *  - `current` is the median of up to 3 readings **from the last 5 days**,
 *    and needs at least 2 of them. One fresh reading beside a cluster from
 *    seven weeks ago would otherwise let `slice(0, 3)` reach back across the
 *    gap and blend a 47 with two 58s into a "58 bpm — watch" verdict that
 *    describes neither.
 *  - the 30-day baseline pool needs at least 7 readings. A baseline built
 *    from one or two survivors is a coin flip the card would print as a
 *    number.
 * (Mirrors `computeHrvTrend`'s recent-window span gate below.) */
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

  // Filter to the recent window BEFORE slicing: slicing first would take the
  // 3 newest readings whatever their age, so a single fresh reading next to a
  // seven-week-old cluster would produce a "current" median made mostly of the
  // cluster. `valid` is newest-first, so this window is a prefix of it.
  const recentStart = addDays(today, -RECENT_WINDOW_DAYS);
  const recentPool = valid.filter((r) => r.date >= recentStart);
  if (recentPool.length < MIN_RECENT_READINGS) {
    const nextOlder = valid[recentPool.length];
    const gap = nextOlder ? ` — the next-oldest is ${daysBetween(nextOlder.date, today)} days old` : "";
    // Its own counts, not the module's staleness convention of `have: 0`:
    // this is a COUNT gate on the recent window, so `have` is smaller than
    // `needed` already and reporting it keeps "Need 2; have 1." agreeing with
    // the explanation beside it. (`have: 0` here rendered "Need 7; have 0."
    // over prose about 1 reading and a threshold of 2 — three numbers, none
    // of which matched.) Same shape as the baseline-pool gate below.
    return insufficient(
      MIN_RECENT_READINGS,
      recentPool.length,
      `Only ${recentPool.length} resting heart-rate reading${recentPool.length === 1 ? "" : "s"} in the last ` +
        `${RECENT_WINDOW_DAYS} days${gap}; a current value needs at least ${MIN_RECENT_READINGS} from that window.`,
    );
  }
  const current = Math.round(median(recentPool.slice(0, 3).map((r) => r.restingHeartRate)));

  const baselineStart = addDays(today, -29);
  const baselinePool = valid.filter((r) => r.date >= baselineStart);
  if (baselinePool.length < MIN_BASELINE_READINGS) {
    return insufficient(
      MIN_BASELINE_READINGS,
      baselinePool.length,
      `Resting heart-rate baseline needs at least ${MIN_BASELINE_READINGS} readings in the last 30 days; ` +
        `you have ${baselinePool.length}.`,
    );
  }
  const baseline = Math.round(median(baselinePool.map((r) => r.restingHeartRate)));

  const series = [...valid].reverse().map((r) => ({ date: r.date, value: r.restingHeartRate }));

  return ok(
    { current, baseline, deltaBpm: current - baseline, staleDays, series },
    valid.length,
    "Median of your 3 most recent resting heart-rate readings (all from the last 5 days) versus your 30-day median.",
  );
}

export interface HrvValue {
  /** Median of the 7 most recent readings (all within 14 days of `today`). */
  recent: number;
  /** Median of readings ranked 8..37 (30-reading window, no overlap with `recent`). */
  baseline: number;
  /** 1dp. */
  pctVsBaseline: number;
  /** clamp(0.5 * CV% of baseline readings, 5, 15); 10 when the baseline has no variability to measure. */
  thresholdPct: number;
  /** Where the band came from: the watch's own base ± sd ("coros") or our
   * derived median + smallest-worthwhile-change ("derived") (0020). */
  bandSource: "coros" | "derived";
  staleDays: number;
  /** Last 60 days of valid readings, ascending. */
  series: Array<{ date: string; value: number }>;
}

/** HRV trend vs. an uncontaminated baseline: unlike the old implementation
 * (which took a 7-day median for "recent" and a 30-day median for "baseline"
 * out of the *same* overlapping pool of readings, so the baseline was
 * partly made of the very readings it was being compared against and pulled
 * toward "recent"), the baseline here is built exclusively from readings
 * ranked 8th-37th-most-recent — a disjoint, fixed-size 30-reading window.
 * (Deliberately capped, not "everything past rank 7": for a daily-syncing
 * user, an uncapped baseline would silently drift into an all-time average
 * after ~6 weeks, which defeats detecting a real recovery-trend shift.) */
export function computeHrvTrend(
  rows: ReadonlyArray<{
    date: string;
    hrv: number | null;
    /** COROS's own per-night baseline ± sd, when the feed carries it (0020).
     * With a watch-provided band the 17-reading self-baseline gate relaxes:
     * the band was computed on-wrist from data we never saw, so five of our
     * own readings are enough to have something to compare against it. */
    sleepHrvBase?: number | null;
    sleepHrvSd?: number | null;
  }>,
  today: string,
): MetricResult<HrvValue> {
  const valid = rows
    .filter((r): r is { date: string; hrv: number; sleepHrvBase?: number | null; sleepHrvSd?: number | null } =>
      r.hrv != null && r.hrv > 0)
    .filter((r) => r.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  const corosRow = rows
    .filter((r) => r.date <= today && r.sleepHrvBase != null && r.sleepHrvBase > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const corosBase = corosRow?.sleepHrvBase ?? null;

  const needed = corosBase != null ? 5 : 17;
  if (valid.length < needed) {
    return insufficient(
      needed,
      valid.length,
      corosBase != null
        ? `Sleep HRV needs at least 5 valid overnight readings; you have ${valid.length}.`
        : `HRV trend needs at least 17 valid COROS readings (7 recent + 10 baseline); you have ${valid.length}.`,
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
  if (corosBase == null && oldestRecentDays > 14) {
    return insufficient(
      17,
      0,
      `Your 7 most recent HRV readings span ${oldestRecentDays} days; HRV trend needs all of them within a 14-day window.`,
    );
  }

  const recent = median(recentReadings.map((r) => r.hrv));
  let baseline: number;
  let thresholdPct: number;
  let bandSource: "coros" | "derived";
  if (corosBase != null) {
    // The watch's own band: base ± sd, as a percentage of base so the rest
    // of the math (and the gauge, drawn in %) is unchanged.
    baseline = corosBase;
    const sd = corosRow?.sleepHrvSd ?? null;
    thresholdPct =
      sd != null && sd > 0 ? roundTo(clamp((sd / corosBase) * 100, 5, 15), 1) : 10;
    bandSource = "coros";
  } else {
    const baselineReadings = valid.slice(7, 37); // ranks 8..37; guaranteed >= 10 given the length-17 gate above
    baseline = median(baselineReadings.map((r) => r.hrv));
    const baselineValues = baselineReadings.map((r) => r.hrv);
    const baselineMean = mean(baselineValues);
    const baselineSd = populationStdDev(baselineValues);
    // A baseline with zero observed variability can't produce a meaningful
    // smallest-worthwhile-change threshold (clamping 0 up to the floor of 5
    // would imply more confidence than the data supports), so fall back to a
    // sensible default instead.
    thresholdPct =
      baselineMean > 0 && baselineSd > 0 ? roundTo(clamp(0.5 * ((baselineSd / baselineMean) * 100), 5, 15), 1) : 10;
    bandSource = "derived";
  }
  const pctVsBaseline = baseline > 0 ? roundTo(((recent - baseline) / baseline) * 100, 1) : 0;

  const windowStart = addDays(today, -59);
  const series = [...valid]
    .filter((r) => r.date >= windowStart)
    .reverse()
    .map((r) => ({ date: r.date, value: r.hrv }));

  return ok(
    {
      recent: Math.round(recent),
      baseline: Math.round(baseline),
      pctVsBaseline,
      thresholdPct,
      staleDays,
      series,
      bandSource,
    },
    valid.length,
    bandSource === "coros"
      ? "Median of your 7 most recent overnight readings versus the band your own watch computed."
      : "Median of your 7 most recent HRV readings versus a baseline from earlier, non-overlapping readings.",
  );
}

export interface SleepNightsValue {
  /** Last night's (or the newest) duration, seconds. */
  latestSeconds: number;
  latestDate: string;
  /** 30-day mean nightly duration, seconds. */
  meanSeconds: number;
  /** Nights in the window, oldest first. */
  nights: Array<{
    date: string;
    totalSeconds: number;
    deepSeconds: number | null;
    remSeconds: number | null;
    lightSeconds: number | null;
  }>;
  series: Array<{ date: string; value: number }>;
  staleDays: number;
}

/**
 * Nightly sleep duration + stages (0020). Prod carries no sleep records until
 * the COROS sleep connection ships, so this metric simply doesn't exist for
 * most athletes yet — the worker only emits it when the data does.
 */
export function computeSleepNights(
  rows: ReadonlyArray<{
    date: string;
    durationSeconds: number;
    deepSeconds: number | null;
    remSeconds: number | null;
    lightSeconds: number | null;
  }>,
  today: string,
): MetricResult<SleepNightsValue> {
  const valid = rows
    .filter((r) => r.durationSeconds > 0 && r.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest first
  if (valid.length < 3) {
    return insufficient(
      3,
      valid.length,
      `Sleep needs at least 3 recorded nights in the last 30 days; you have ${valid.length}.`,
    );
  }
  const newest = valid[valid.length - 1]!;
  const staleDays = daysBetween(newest.date, today);
  if (staleDays > 7) {
    return insufficient(3, 0, `Your newest sleep record is ${staleDays} days old.`);
  }
  const meanSeconds = mean(valid.map((r) => r.durationSeconds));
  return ok(
    {
      latestSeconds: newest.durationSeconds,
      latestDate: newest.date,
      meanSeconds,
      nights: valid.map((r) => ({
        date: r.date,
        totalSeconds: r.durationSeconds,
        deepSeconds: r.deepSeconds,
        remSeconds: r.remSeconds,
        lightSeconds: r.lightSeconds,
      })),
      series: valid.map((r) => ({ date: r.date, value: roundTo(r.durationSeconds / 3600, 1) })),
      staleDays,
    },
    valid.length,
    "Each recorded night in the last 30 days, straight off the watch.",
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
