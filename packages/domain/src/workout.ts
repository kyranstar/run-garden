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
  "yoga",
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

  /**
   * THE STRENGTH HALF OF A STAGE (2026-08-17). Five fields, all optional,
   * because a run stage has none of them and every row written before today has
   * none either.
   *
   * They exist because the COROS wire carries all five and the reader threw
   * three of them away: `normalize.ts` mapped `targetType: 3` (reps) to
   * `durationType: "none"` and kept no value, and ignored `intensityValue` for
   * weight and both rest columns outright. The athlete's own Goblet Squat
   * therefore rendered as a bare movement name — no sets, no reps, no load —
   * while the coach's dossier, reading `structured_json` for coach-authored
   * sessions, could see the whole prescription. A prescription the coach can
   * read and the athlete cannot is the defect this pass exists to close, and
   * for imported strength work these columns are where the missing half lives.
   *
   * `durationType` stays the measure of TIME and DISTANCE only. Reps are a third
   * dimension, not a duration, and folding them in would have made every
   * consumer of `durationSeconds` guess which unit it held.
   */
  /** Reps per set (COROS `targetType: 3`). PER SIDE when `note` says so. */
  reps: z.number().int().positive().optional(),
  /** Prescribed load in kg (COROS `intensityType: 1`, kg × 1000 on the wire). */
  loadKg: z.number().positive().optional(),
  /** Bodyweight is a real prescription and NOT the absence of a load: without
   * this, "3×8 bodyweight" and "3×8, load unknown" are one row. */
  loadBodyweight: z.boolean().optional(),
  /** Seconds between sets (COROS `restType: 1` / `restValue`). Zero is a real
   * prescription — a circuit that does not pause — so it is distinct from
   * absent. */
  restSeconds: z.number().nonnegative().optional(),
  /**
   * The step's free text (COROS `overview`), which is where the prescriptions
   * the wire has no field for actually ride: "each side", "4s down", and any cue
   * the coach wrote. It is the ONLY carrier for per-side work and eccentric
   * tempo, so dropping it lost them entirely — see the wire ledger's
   * `wire_drops_per_side_flag` and `wire_drops_eccentric_tempo`.
   */
  note: z.string().optional(),
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

/** User-facing category labels — shared by worker summaries and the UI so a
 * COROS code-title falls back to the same words everywhere. */
export const WORKOUT_CATEGORY_LABELS: Record<WorkoutCategory, string> = {
  recovery: "Recovery",
  easy: "Easy run",
  long: "Long run",
  quality: "Quality",
  race: "Race",
  cross_training: "Cross-training",
  strength: "Strength",
  yoga: "Yoga",
  rest: "Rest",
  unknown: "Run",
};

export const QUALITY_SUBTYPE_LABELS: Record<QualitySubtype, string> = {
  threshold: "Threshold",
  tempo: "Tempo",
  intervals: "Intervals",
  vo2: "VO₂ intervals",
  hills: "Hills",
  other: "Quality",
};

/**
 * COROS structured-workout names are frequently opaque codes ("T1004",
 * "R2-1", "W03_A"): short, code-shaped, meaningless to a human. A title is
 * code-like when, stripped of separators, it's ≤8 chars of letters+digits
 * with at least one digit and no more than 3 letters ("Tempo 5k" survives,
 * "T1004" doesn't).
 */
export function looksLikeCodeTitle(title: string): boolean {
  const t = title.trim();
  if (t.length === 0) return true;
  const stripped = t.replace(/[\s\-_./#]/g, "");
  if (stripped.length > 8 || !/^[A-Za-z0-9]*$/.test(stripped)) return false;
  const letters = (stripped.match(/[A-Za-z]/g) ?? []).length;
  const digits = (stripped.match(/[0-9]/g) ?? []).length;
  return digits >= 1 && letters <= 3;
}

/** The display title for a planned workout: the real name when it has one,
 * else the category (with quality subtype when known) in plain words. */
export function humanizeWorkoutTitle(
  title: string,
  category: WorkoutCategory | string,
  qualitySubtype?: QualitySubtype | string | null,
): string {
  if (!looksLikeCodeTitle(title)) return title;
  if (category === "quality" && qualitySubtype && qualitySubtype in QUALITY_SUBTYPE_LABELS) {
    return QUALITY_SUBTYPE_LABELS[qualitySubtype as QualitySubtype];
  }
  return WORKOUT_CATEGORY_LABELS[category as WorkoutCategory] ?? title;
}
