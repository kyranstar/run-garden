import type { DurationEstimate, PlannedStage, WorkoutCategory } from "@rg/domain";
import { deriveWorkoutSeconds, type PaceResolutionContext } from "./stages.js";

export const ESTIMATOR_VERSION = "1.0.0";

export interface EstimateInput {
  /** COROS-native estimate from the planned workout, when present. */
  sourceEstimatedDurationSeconds?: number;
  /** Result of the COROS workout-calculation endpoint, when available. */
  corosCalculatedSeconds?: number;
  stages?: PlannedStage[];
  category: WorkoutCategory;
  /** Median duration of comparable completed workouts (same category). */
  historicalMedianSeconds?: number;
  paceContext: PaceResolutionContext;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

const DEFAULT_FALLBACK_SECONDS: Record<WorkoutCategory, number> = {
  recovery: 35 * 60,
  easy: 50 * 60,
  long: 100 * 60,
  quality: 60 * 60,
  race: 60 * 60,
  cross_training: 45 * 60,
  strength: 40 * 60,
  yoga: 45 * 60,
  rest: 0,
  unknown: 50 * 60,
};

/**
 * Duration estimate priority (never replace a valid COROS estimate):
 *  1. COROS native estimate  2. COROS calculation endpoint
 *  3. Stage derivation       4. Historical median  5. Conservative default
 */
export function estimateDuration(input: EstimateInput): DurationEstimate {
  const pad = (input.bufferBeforeMinutes + input.bufferAfterMinutes) * 60;
  const make = (
    workoutSeconds: number,
    source: DurationEstimate["source"],
    confidence: DurationEstimate["confidence"],
    assumptions: string[],
  ): DurationEstimate => ({
    workoutSeconds: Math.round(workoutSeconds),
    calendarSeconds: Math.round(workoutSeconds) + pad,
    source,
    confidence,
    assumptions,
    estimatorVersion: ESTIMATOR_VERSION,
  });

  if (input.sourceEstimatedDurationSeconds && input.sourceEstimatedDurationSeconds > 0) {
    return make(input.sourceEstimatedDurationSeconds, "coros_native", "high", []);
  }
  if (input.corosCalculatedSeconds && input.corosCalculatedSeconds > 0) {
    return make(input.corosCalculatedSeconds, "coros_calculated", "high", []);
  }
  if (input.stages && input.stages.length > 0) {
    const derived = deriveWorkoutSeconds(input.stages, input.paceContext);
    if (derived.seconds > 0) {
      const confidence = derived.assumptions.length === 0 ? "high" : "medium";
      return make(derived.seconds, "derived_from_stages", confidence, derived.assumptions);
    }
  }
  if (input.historicalMedianSeconds && input.historicalMedianSeconds > 0) {
    return make(input.historicalMedianSeconds, "historical_fallback", "medium", [
      "Used the median duration of your comparable completed workouts",
    ]);
  }
  const fallback = DEFAULT_FALLBACK_SECONDS[input.category];
  return make(fallback, "default_fallback", "low", [
    `Used a conservative default for a ${input.category} workout`,
  ]);
}
