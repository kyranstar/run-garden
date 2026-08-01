import type { ActivityLap, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { activityLocalDate, median, roundTo, weightedMean } from "./stats.js";

/**
 * Heart-rate drift: second-half vs first-half average HR on steady runs.
 * Interval workouts are never included, and runs whose lap paces surge more
 * than 25% from the run median are excluded with an explicit reason.
 */

const MIN_RUNS = 3;
const MIN_DURATION_SECONDS = 30 * 60;
const MIN_HR_LAPS = 4;
const MAX_PACE_DEVIATION = 0.25;

const STEADY_CATEGORIES: ReadonlySet<WorkoutCategory> = new Set(["easy", "long", "recovery"]);

export interface HrDriftRunInput {
  activity: NormalizedActivity;
  laps: ActivityLap[];
  category: WorkoutCategory;
}

export interface HrDriftPoint {
  activityId: string;
  /** LocalDate of the run. */
  date: string;
  /** (secondHalfAvgHR / firstHalfAvgHR - 1) * 100. */
  driftPct: number;
}

export interface HrDriftValue {
  perRun: HrDriftPoint[];
  medianDriftPct: number;
  excludedRuns: Array<{ activityId: string; reason: string }>;
}

function exclusionReason(run: HrDriftRunInput): string | null {
  const { activity, laps, category } = run;
  if (!STEADY_CATEGORIES.has(category)) {
    return `category "${category}" is not a steady run (only easy, long, recovery qualify)`;
  }
  if (activity.durationSeconds < MIN_DURATION_SECONDS) return "shorter than 30 minutes";
  const hrLaps = laps.filter(
    (l) => l.avgHeartRate != null && l.avgHeartRate > 0 && l.durationSeconds > 0,
  );
  if (hrLaps.length < MIN_HR_LAPS) return `fewer than ${MIN_HR_LAPS} laps with heart rate`;
  const paces = laps
    .map((l) => l.avgPaceSecPerKm)
    .filter((p): p is number => p != null && p > 0);
  if (paces.length > 0) {
    const med = median(paces);
    if (med > 0 && paces.some((p) => Math.abs(p - med) / med > MAX_PACE_DEVIATION)) {
      return "lap pace varied more than 25% from the run median (surging)";
    }
  }
  return null;
}

/** Split laps into halves by cumulative time (lap belongs where its midpoint falls). */
function driftPct(run: HrDriftRunInput): number {
  const hrLaps = run.laps
    .filter((l) => l.avgHeartRate != null && l.avgHeartRate > 0 && l.durationSeconds > 0)
    .sort((a, b) => a.lapIndex - b.lapIndex);
  const total = hrLaps.reduce((s, l) => s + l.durationSeconds, 0);
  const first: Array<{ value: number; weight: number }> = [];
  const second: Array<{ value: number; weight: number }> = [];
  let elapsed = 0;
  for (const lap of hrLaps) {
    const midpoint = elapsed + lap.durationSeconds / 2;
    (midpoint < total / 2 ? first : second).push({
      value: lap.avgHeartRate!,
      weight: lap.durationSeconds,
    });
    elapsed += lap.durationSeconds;
  }
  const firstAvg = weightedMean(first);
  const secondAvg = weightedMean(second);
  if (firstAvg <= 0) return 0;
  return roundTo((secondAvg / firstAvg - 1) * 100, 2);
}

export function computeHrDrift(runs: HrDriftRunInput[]): MetricResult<HrDriftValue> {
  const perRun: HrDriftPoint[] = [];
  const excludedRuns: Array<{ activityId: string; reason: string }> = [];

  for (const run of runs) {
    const reason = exclusionReason(run);
    if (reason != null) {
      excludedRuns.push({ activityId: run.activity.id, reason });
      continue;
    }
    perRun.push({
      activityId: run.activity.id,
      date: activityLocalDate(run.activity),
      driftPct: driftPct(run),
    });
  }
  perRun.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1));

  if (perRun.length < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      perRun.length,
      `HR drift needs at least ${MIN_RUNS} steady runs of 30+ minutes with 4+ heart-rate laps and even pacing; only ${perRun.length} qualify (${excludedRuns.length} excluded).`,
    );
  }

  return ok(
    {
      perRun,
      medianDriftPct: roundTo(median(perRun.map((p) => p.driftPct)), 2),
      excludedRuns,
    },
    perRun.length,
    "Second-half vs first-half average heart rate on steady runs (easy, long, recovery) of 30+ minutes with even pacing; interval sessions and surging runs are excluded.",
  );
}
