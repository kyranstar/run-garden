import type { ActivityLap, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { activityLocalDate, roundTo, theilSen, weightedMean } from "./stats.js";

/**
 * Aerobic efficiency: speed-to-heart-rate ratio on comparable easy runs,
 * expressed as meters travelled per heart beat. Only easy/recovery runs of
 * 25+ minutes with average HR are compared; runs with heavy pausing are
 * excluded. Every run is scored on the same lap basis (see runEfficiency)
 * so warm-up/cool-down never distort the ratio and there is no whole-run
 * fallback — a run without usable laps simply does not count.
 */

const MIN_RUNS = 3;
const MIN_DURATION_SECONDS = 25 * 60;
const MAX_PAUSE_FRACTION = 0.15;
const MIN_TREND_RUNS = 6;
/** Laps ending at or before this many cumulative seconds are warm-up and dropped. */
const WARMUP_TRIM_SECONDS = 600;

export interface EfficiencyRunInput {
  activity: NormalizedActivity;
  laps: ActivityLap[];
  category: WorkoutCategory;
}

export interface EfficiencyPoint {
  activityId: string;
  /** LocalDate of the run. */
  date: string;
  /** Meters per heart beat: (speed m/s) / avgHR * 60. */
  efficiency: number;
}

export interface AerobicEfficiencyValue {
  perRun: EfficiencyPoint[];
  /** Theil–Sen trend over day-index; only present once perRun has 6+ points. */
  trend?: { pct: number; n: number };
  /** Eligible-category runs dropped for lacking usable laps. */
  excludedCount: number;
}

function isEligible(run: EfficiencyRunInput): boolean {
  const { activity, category } = run;
  if (category !== "easy" && category !== "recovery") return false;
  if (activity.durationSeconds < MIN_DURATION_SECONDS) return false;
  if (activity.avgHeartRate == null || activity.avgHeartRate <= 0) return false;
  if (activity.elapsedSeconds != null && activity.elapsedSeconds > 0) {
    const pauseFraction =
      (activity.elapsedSeconds - activity.durationSeconds) / activity.elapsedSeconds;
    if (pauseFraction > MAX_PAUSE_FRACTION) return false;
  }
  return true;
}

/**
 * Laps used for the efficiency ratio: sorted by lapIndex, with any lap that
 * ends at or before the first 600s of cumulative time dropped (a lap
 * straddling the 600s mark is kept), and the final lap always dropped too —
 * so warm-up and cool-down never influence the ratio.
 */
function trimmedLaps(laps: ActivityLap[]): ActivityLap[] {
  const sorted = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);
  let cumulative = 0;
  const kept: ActivityLap[] = [];
  for (const lap of sorted) {
    cumulative += lap.durationSeconds;
    if (cumulative <= WARMUP_TRIM_SECONDS) continue;
    kept.push(lap);
  }
  kept.pop();
  return kept;
}

/** Efficiency for one eligible run, or null when usable laps are lacking. */
function runEfficiency(run: EfficiencyRunInput): number | null {
  const usable = trimmedLaps(run.laps).filter(
    (l) => (l.distanceMeters ?? 0) > 0 && l.durationSeconds > 0,
  );
  if (usable.length < 2) return null;
  const hrLaps = usable.filter((l) => l.avgHeartRate != null && l.avgHeartRate > 0);
  if (hrLaps.length < 1) return null;

  const time = usable.reduce((s, l) => s + l.durationSeconds, 0);
  const distance = usable.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
  const hr = weightedMean(hrLaps.map((l) => ({ value: l.avgHeartRate!, weight: l.durationSeconds })));
  if (time <= 0 || distance <= 0 || hr <= 0) return null;
  return roundTo((distance / time / hr) * 60, 4);
}

/** Whole days between two LocalDate strings ("YYYY-MM-DD"). */
function daysSince(first: string, date: string): number {
  return Math.round((Date.parse(date) - Date.parse(first)) / 86_400_000);
}

export function computeAerobicEfficiency(
  runs: EfficiencyRunInput[],
): MetricResult<AerobicEfficiencyValue> {
  const perRun: EfficiencyPoint[] = [];
  let excludedCount = 0;
  for (const run of runs) {
    if (!isEligible(run)) continue;
    const efficiency = runEfficiency(run);
    if (efficiency == null) {
      excludedCount++;
      continue;
    }
    perRun.push({ activityId: run.activity.id, date: activityLocalDate(run.activity), efficiency });
  }
  perRun.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1));

  if (perRun.length < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      perRun.length,
      `Aerobic efficiency needs at least ${MIN_RUNS} comparable easy/recovery runs of 25+ minutes with usable laps and heart rate; only ${perRun.length} qualify.`,
    );
  }

  let trend: { pct: number; n: number } | undefined;
  if (perRun.length >= MIN_TREND_RUNS) {
    const first = perRun[0]!.date;
    const points = perRun.map((p) => ({ x: daysSince(first, p.date), y: p.efficiency }));
    const { slope, intercept } = theilSen(points);
    const xLast = points[points.length - 1]!.x;
    const pct = intercept !== 0 ? roundTo(((slope * xLast) / intercept) * 100, 1) : 0;
    trend = { pct, n: perRun.length };
  }

  return ok(
    { perRun, trend, excludedCount },
    perRun.length,
    "Meters per heart beat on easy/recovery runs of 25+ minutes; runs paused more than 15% are excluded, and every run is scored on the same lap-trimmed basis (warm-up and cool-down laps dropped) with no whole-run fallback.",
  );
}
