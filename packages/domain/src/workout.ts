import { z } from "zod";
import type { LocalDate, LocalTime } from "./time.js";
import type { CalendarSyncState, CompletionState, CorosSyncState } from "./states.js";

export const WORKOUT_CATEGORIES = [
  "recovery",
  "easy",
  "long",
  "quality",
  "race",
  "cross_training",
  "strength",
  "rest",
  "unknown",
] as const;
export type WorkoutCategory = (typeof WORKOUT_CATEGORIES)[number];

export const QUALITY_SUBTYPES = [
  "threshold",
  "tempo",
  "intervals",
  "vo2",
  "hills",
  "other",
] as const;
export type QualitySubtype = (typeof QUALITY_SUBTYPES)[number];

/** Normalized structured-workout stage. Nested repeats via parentStageId. */
export const plannedStageSchema = z.object({
  id: z.string(),
  parentStageId: z.string().nullable().optional(),
  order: z.number().int(),
  kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest", "repeat", "open"]),
  /** Only for kind === "repeat". */
  repeatCount: z.number().int().positive().optional(),
  durationType: z.enum(["time", "distance", "open", "lap_button", "none"]),
  durationSeconds: z.number().nonnegative().optional(),
  distanceMeters: z.number().nonnegative().optional(),
  targetType: z.enum(["pace", "heart_rate", "effort", "power", "none"]).optional(),
  /** pace: seconds per km (low = faster bound); hr: bpm; effort/power: native units */
  targetLow: z.number().optional(),
  targetHigh: z.number().optional(),
  paceZone: z.number().int().optional(),
  hrZone: z.number().int().optional(),
  label: z.string().optional(),
});
export type PlannedStage = z.infer<typeof plannedStageSchema>;

export const durationEstimateSchema = z.object({
  workoutSeconds: z.number().nonnegative(),
  calendarSeconds: z.number().nonnegative(),
  source: z.enum([
    "coros_native",
    "coros_calculated",
    "derived_from_stages",
    "historical_fallback",
    "default_fallback",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  assumptions: z.array(z.string()),
  estimatorVersion: z.string(),
});
export type DurationEstimate = z.infer<typeof durationEstimateSchema>;

/**
 * A planned workout keeps three distinct date concepts (never collapsed):
 *  - originalPlanDate: where the plan originally put it
 *  - lastVerifiedCorosDate: where COROS was last VERIFIED to have it
 *  - effectiveDate/effectiveTime: where Run Garden intends it (drives Calendar)
 */
export const plannedWorkoutSchema = z.object({
  id: z.string(),
  sourceProvider: z.literal("coros"),
  sourcePlanId: z.string(),
  sourceWorkoutId: z.string(),
  sourceProgramId: z.string().optional(),
  sourceIdInPlan: z.string().optional(),

  title: z.string(),
  category: z.enum(WORKOUT_CATEGORIES),
  qualitySubtype: z.enum(QUALITY_SUBTYPES).optional(),
  sport: z.string().default("run"),

  originalPlanDate: z.string(),
  lastVerifiedCorosDate: z.string(),
  effectiveDate: z.string(),
  effectiveTime: z.string(),

  sourceContentFingerprint: z.string(),
  sourceVersion: z.string().optional(),

  sourceEstimatedDurationSeconds: z.number().optional(),
  fallbackEstimatedDurationSeconds: z.number().optional(),
  calendarBlockDurationSeconds: z.number(),
  durationEstimate: durationEstimateSchema.optional(),

  expectedDistanceMeters: z.number().optional(),
  stageSummary: z.string().optional(),
  stages: z.array(plannedStageSchema).default([]),

  calendarSyncState: z.custom<CalendarSyncState>((v) => typeof v === "string"),
  corosSyncState: z.custom<CorosSyncState>((v) => typeof v === "string"),
  completionState: z.custom<CompletionState>((v) => typeof v === "string"),

  /** Set when the plan version this workout belonged to was archived. */
  archivedAt: z.string().nullable().optional(),
});
export type PlannedWorkout = z.infer<typeof plannedWorkoutSchema> & {
  originalPlanDate: LocalDate;
  lastVerifiedCorosDate: LocalDate;
  effectiveDate: LocalDate;
  effectiveTime: LocalTime;
};

export function isQuality(w: Pick<PlannedWorkout, "category">): boolean {
  return w.category === "quality" || w.category === "race";
}

export function isRunning(w: Pick<PlannedWorkout, "category">): boolean {
  return w.category !== "rest" && w.category !== "cross_training" && w.category !== "strength";
}
