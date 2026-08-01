import type { ActivityLap, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { activityLocalDate, leastSquares, roundTo, weightedMean } from "./stats.js";

/**
 * Aerobic efficiency: speed-to-heart-rate ratio on comparable easy runs,
 * expressed as meters travelled per heart beat. Only easy/recovery runs of
 * 25+ minutes with average HR are compared; runs with heavy pausing are
 * excluded. When lap data exists, only the middle laps are used so warm-up
 * and cool-down do not distort the ratio.
 */

const MIN_RUNS = 3;
const MIN_DURATION_SECONDS = 25 * 60;
const MAX_PAUSE_FRACTION = 0.15;

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
  /** Least-squares fitted % change in efficiency across the window. */
  trendPct: number;
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

/** Efficiency for one eligible run, or null when speed cannot be derived. */
function runEfficiency(run: EfficiencyRunInput): number | null {
  const { activity, laps } = run;

  // Middle laps only when laps are present (drop first + last).
  if (laps.length >= 3) {
    const middle = [...laps].sort((a, b) => a.lapIndex - b.lapIndex).slice(1, -1);
    const time = middle.reduce((s, l) => s + l.durationSeconds, 0);
    const distance = middle.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
    const hrLaps = middle.filter((l) => l.avgHeartRate != null && l.avgHeartRate > 0);
    if (time > 0 && distance > 0) {
      const hr =
        hrLaps.length > 0
          ? weightedMean(hrLaps.map((l) => ({ value: l.avgHeartRate!, weight: l.durationSeconds })))
          : activity.avgHeartRate!;
      if (hr > 0) return roundTo((distance / time / hr) * 60, 4);
    }
    // Fall through to whole-run figures when middle laps lack distance/time.
  }

  if (activity.distanceMeters == null || activity.distanceMeters <= 0) return null;
  if (activity.durationSeconds <= 0) return null;
  return roundTo((activity.distanceMeters / activity.durationSeconds / activity.avgHeartRate!) * 60, 4);
}

export function computeAerobicEfficiency(
  runs: EfficiencyRunInput[],
): MetricResult<AerobicEfficiencyValue> {
  const perRun: EfficiencyPoint[] = [];
  for (const run of runs) {
    if (!isEligible(run)) continue;
    const efficiency = runEfficiency(run);
    if (efficiency == null) continue;
    perRun.push({ activityId: run.activity.id, date: activityLocalDate(run.activity), efficiency });
  }
  perRun.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1));

  if (perRun.length < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      perRun.length,
      `Aerobic efficiency needs at least ${MIN_RUNS} comparable easy/recovery runs of 25+ minutes with heart rate; only ${perRun.length} qualify.`,
    );
  }

  const { slope, intercept } = leastSquares(perRun.map((p) => p.efficiency));
  const fittedStart = intercept;
  const fittedEnd = intercept + slope * (perRun.length - 1);
  const trendPct = fittedStart !== 0 ? roundTo(((fittedEnd - fittedStart) / fittedStart) * 100, 2) : 0;

  return ok(
    { perRun, trendPct },
    perRun.length,
    "Meters per heart beat on easy/recovery runs of 25+ minutes; runs paused more than 15% are excluded, middle laps are used when lap data exists, and heart-rate coverage is assumed adequate whenever an average HR above 0 was recorded.",
  );
}
