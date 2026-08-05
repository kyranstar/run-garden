import type { NormalizedActivity, PlannedWorkout } from "@rg/domain";
import { daysBetween, isLocalDate, isLocalTime, minutesFromLocalTime } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { median, roundTo } from "./stats.js";

/**
 * Scheduled vs actual time of day. Purely descriptive: the comparison note
 * reports completion rates and never claims one time of day is physiologically
 * better than another.
 */

const MIN_SAMPLES = 6;
const NOON = "12:00";

export interface TimeOfDayPair {
  workout: PlannedWorkout;
  activity?: NormalizedActivity;
}

export interface WindowStats {
  planned: number;
  completed: number;
  rate: number;
}

export interface TimeOfDayValue {
  /** Workouts scheduled with effectiveTime before 12:00. */
  morning: WindowStats;
  /** Workouts scheduled at or after 12:00. */
  evening: WindowStats;
  /** Median |actual start - scheduled start| in minutes for completed workouts
   * whose activity carries a local start time; null when none qualify. */
  medianStartDeltaMinutes: number | null;
}

function isCompleted(w: PlannedWorkout): boolean {
  return w.completionState === "completed";
}

/** Naive local-time difference in minutes; null when the pair cannot be compared. */
function startDeltaMinutes(pair: TimeOfDayPair): number | null {
  const local = pair.activity?.startTimeLocal;
  if (!local) return null;
  const date = local.slice(0, 10);
  const time = local.slice(11, 16);
  if (!isLocalDate(date) || !isLocalTime(time)) return null;
  const delta =
    daysBetween(pair.workout.effectiveDate, date) * 1440 +
    minutesFromLocalTime(time) -
    minutesFromLocalTime(pair.workout.effectiveTime);
  return Math.abs(delta);
}

export function computeTimeOfDay(pairs: TimeOfDayPair[]): MetricResult<TimeOfDayValue> {
  // Rest days and still-future workouts say nothing about follow-through.
  const samples = pairs.filter(
    (p) => p.workout.category !== "rest" && p.workout.completionState !== "scheduled",
  );

  if (samples.length < MIN_SAMPLES) {
    return insufficient(
      MIN_SAMPLES,
      samples.length,
      `Time-of-day comparison needs at least ${MIN_SAMPLES} resolved planned workouts; only ${samples.length} available.`,
    );
  }

  const windowStats = (subset: TimeOfDayPair[]): WindowStats => {
    const completed = subset.filter((p) => isCompleted(p.workout)).length;
    return {
      planned: subset.length,
      completed,
      rate: subset.length > 0 ? completed / subset.length : 0,
    };
  };

  const morning = windowStats(samples.filter((p) => p.workout.effectiveTime < NOON));
  const evening = windowStats(samples.filter((p) => p.workout.effectiveTime >= NOON));

  const deltas: number[] = [];
  for (const pair of samples) {
    if (!isCompleted(pair.workout)) continue;
    const delta = startDeltaMinutes(pair);
    if (delta != null) deltas.push(delta);
  }

  return ok(
    {
      morning,
      evening,
      medianStartDeltaMinutes: deltas.length > 0 ? roundTo(median(deltas), 1) : null,
    },
    samples.length,
    `You complete ${Math.round(morning.rate * 100)}% of morning runs vs ${Math.round(evening.rate * 100)}% of evening runs.`,
  );
}
