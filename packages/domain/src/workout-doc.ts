/**
 * The workout document, v1 (2026-10-10): the one rich definition every workout
 * (engine, coach, Studio, COROS import, templates) is stored as. Computed
 * fields (durations, balance, watch steps) are never authored here.
 *
 * Versioning: vocabulary (enum) additions after v1 require `version: 2` and a
 * converter, because older cached clients parse strictly. Unknown optional
 * keys are stripped, not rejected (zod default). Rest-day rows carry no
 * document.
 */
import { z } from "zod";

export const WORKOUT_DOC_VERSION = 1;

export const GOAL_IDS = ["ski", "posture", "athleticism", "alignment", "condition-care", "aerobic-base", "speed", "strength", "mobility", "recovery"] as const;
/** Each goal in plain words, for every screen that names one (never the id itself). */
export const GOAL_LABELS: Record<(typeof GOAL_IDS)[number], string> = {
  ski: "Ski",
  posture: "Posture",
  athleticism: "Athleticism",
  alignment: "Alignment",
  "condition-care": "Condition care",
  "aerobic-base": "Aerobic base",
  speed: "Speed",
  strength: "Strength",
  mobility: "Mobility",
  recovery: "Recovery",
};
export const PART_PURPOSES = ["arrive", "warmup", "activation", "main", "power", "accessory", "conditioning", "run", "care", "cooldown"] as const;
export const PART_FORMATS = ["straight", "superset", "circuit", "flow", "intervals", "steady", "ladder", "holds"] as const;
export const RUN_EFFORTS = ["easy", "recovery", "steady", "long", "tempo", "threshold", "interval", "hills", "strides", "race", "by_feel"] as const;
/** Each run effort in plain words, for every screen that names one (designed runs, §8 §3). */
export const RUN_EFFORT_LABELS: Record<(typeof RUN_EFFORTS)[number], string> = {
  easy: "Easy",
  recovery: "Recovery",
  steady: "Steady",
  long: "Long",
  tempo: "Tempo",
  threshold: "Threshold",
  interval: "Interval",
  hills: "Hills",
  strides: "Strides",
  race: "Race pace",
  by_feel: "By feel",
};
export const EFFORT_LEVELS = ["recover", "maintain", "develop", "peak"] as const;
export const DOC_SOURCES = ["engine", "coach", "studio", "coros_import", "standalone_import", "athlete", "template"] as const;
export const BASED_ON_KINDS = ["workout", "template", "performed", "proposal"] as const;
/** `setting.placeId` for "No equipment": bodyweight only, wherever it is done (CUJ R8). Never a place's own id. */
export const NO_EQUIPMENT_PLACE = "none";

// An empty dose is deliberately NOT a schema error: a stored document must never vanish on parse for a soft problem. Task 8's validator warns on it.
export const doseSchema = z.object({
  sets: z.number().int().min(1).max(20).optional(),
  reps: z.union([z.number().int().min(1).max(200), z.object({ min: z.number().int().min(1).max(200), max: z.number().int().min(1).max(200) }).refine((r) => r.min <= r.max, "reps min must not exceed max")]).optional(),
  holdSec: z.number().min(1).max(3600).optional(),
  breaths: z.number().int().min(1).max(200).optional(),
  carryM: z.number().min(1).max(5000).optional(),
  perSide: z.boolean().optional(),
  /** "to max": holdSec / reps become a floor or target, not a cap. */
  max: z.literal(true).optional(),
  tempo: z.object({ eccentricSec: z.number().min(0).max(20).optional(), pauseSec: z.number().min(0).max(30).optional(), concentricSec: z.number().min(0).max(20).optional() }).optional(),
  load: z.union([z.object({ typed: z.string().min(1).max(20), kg: z.number().min(0).max(500) }), z.literal("bodyweight")]).optional(),
  restSec: z.number().min(0).max(900).optional(),
});

export const runTargetSchema = z
  .object({
    durationSec: z.number().min(1).max(86400).optional(),
    distanceM: z.number().min(1).max(500000).optional(),
    /** The distance as typed, e.g. "3 mi". */
    typed: z.string().max(20).optional(),
    /** Open-ended segment ended by the lap button. */
    open: z.literal(true).optional(),
    pace: z
      .object({ fastSecPerKm: z.number().finite().min(120).max(1800), slowSecPerKm: z.number().finite().min(120).max(1800) })
      .refine((p) => p.fastSecPerKm <= p.slowSecPerKm, "fast pace must not be slower than slow pace")
      .optional(),
    hr: z
      .object({ low: z.number().int().min(30).max(230), high: z.number().int().min(30).max(230) })
      .refine((h) => h.low <= h.high, "hr low must not exceed high")
      .optional(),
    zone: z.object({ kind: z.enum(["pace", "hr"]), index: z.number().int().min(1).max(6) }).optional(),
  })
  .refine((t) => t.durationSec !== undefined || t.distanceM !== undefined || t.open === true, "a run segment needs a duration, a distance or open");

export const itemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exercise"),
    /** May be a legacy id; resolution happens in the validator, not here. */
    libraryId: z.string().min(1).max(80),
    dose: doseSchema,
    side: z.enum(["left", "right"]).optional(),
    why: z.string().max(160).optional(),
    progression: z.string().max(120).optional(),
    cue: z.string().max(160).optional(),
    alternates: z.array(z.object({ libraryId: z.string().min(1).max(80), why: z.string().max(120).optional() })).max(3).optional(),
    test: z.object({ keyResultId: z.string().min(1).max(80).optional() }).optional(),
  }),
  z.object({
    kind: z.literal("free_exercise"),
    name: z.string().min(1).max(80),
    dose: doseSchema,
    why: z.string().max(160).optional(),
    cue: z.string().max(160).optional(),
    coros: z.object({ key: z.string().max(20).optional() }).optional(),
  }),
  z.object({
    kind: z.literal("run"),
    target: runTargetSchema,
    effort: z.enum(RUN_EFFORTS),
    why: z.string().max(160).optional(),
    cue: z.string().max(160).optional(),
  }),
  z.object({ kind: z.literal("rest"), seconds: z.number().min(1).max(3600) }),
]);

export const partSchema = z.object({
  purpose: z.enum(PART_PURPOSES),
  why: z.string().max(160).optional(),
  format: z.enum(PART_FORMATS),
  rounds: z.number().int().min(1).max(50).optional(),
  restBetweenRoundsSec: z.number().min(0).max(900).optional(),
  items: z.array(itemSchema).min(1).max(60),
});

export const workoutDocSchema = z.object({
  version: z.literal(WORKOUT_DOC_VERSION),
  title: z.string().min(1).max(80),
  intent: z.object({
    summary: z.string().min(1).max(200),
    goals: z.array(z.enum(GOAL_IDS)).max(6),
    /** Region or muscle ids — checked against the library vocabularies by `validateWorkoutDoc`. */
    focus: z.array(z.string().min(1).max(40)).max(12),
    effort: z.enum(EFFORT_LEVELS),
    objectiveIds: z.array(z.string().min(1).max(80)).max(10).optional(),
  }),
  setting: z
    .object({
      placeId: z.string().min(1).max(80).optional(),
      /** Equipment ids; checked against the library's equipment by the validator. */
      equipment: z.array(z.string().min(1).max(40)).max(20).optional(),
      targetMinutes: z.number().min(1).max(600).optional(),
    })
    .optional(),
  parts: z.array(partSchema).min(1).max(20),
  /** Who wrote it. */
  source: z.object({ kind: z.enum(DOC_SOURCES), ref: z.string().max(200).optional() }),
  /** Lineage: what it was derived from. A coach's proposal names the op (one designed workout) it approved: `opId`. */
  basedOn: z
    .object({ kind: z.enum(BASED_ON_KINDS), id: z.string().min(1).max(80), rev: z.number().int().min(0).optional(), opId: z.string().min(1).max(120).optional() })
    .optional(),
  notes: z.string().max(500).optional(),
});

export type WorkoutDoc = z.infer<typeof workoutDocSchema>;
export type WorkoutPart = z.infer<typeof partSchema>;
export type WorkoutItem = z.infer<typeof itemSchema>;
export type WorkoutDose = z.infer<typeof doseSchema>;
export type WorkoutRunTarget = z.infer<typeof runTargetSchema>;

/** Parse a stored column: null or invalid → null (never throws; callers fall back to the old format). */
export function parseStoredWorkoutDoc(raw: unknown): WorkoutDoc | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    // A double-encoded column hands back a JSON string of a JSON string.
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
  }
  const r = workoutDocSchema.safeParse(value);
  return r.success ? r.data : null;
}
