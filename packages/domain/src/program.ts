import { z } from "zod";
import { isLocalDate } from "./time.js";

// Programs: the one registry of plans (one-workout-system spec §8.1, Phase 1 spec §6). `programs.config` and
// `program_blocks.intent` are JSON columns; these are what they hold.

const localDate = z.string().refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" });
const unique = <T>(xs: readonly T[]): boolean => new Set(xs).size === xs.length;

export const PROGRAM_KINDS = ["adaptive", "coros_import", "coach", "studio"] as const;
export const programKindSchema = z.enum(PROGRAM_KINDS);
export type ProgramKind = z.infer<typeof programKindSchema>;

export const PROGRAM_STATUSES = ["draft", "active", "completed", "retired", "archived"] as const;
export const programStatusSchema = z.enum(PROGRAM_STATUSES);
export type ProgramStatus = z.infer<typeof programStatusSchema>;

/**
 * The session engine's modes. The library owns them (`MODE_IDS` in @rg/exercise-library, which this package
 * cannot import); a session-engine test keeps the two lists equal.
 */
export const SESSION_MODES = ["recovery", "consistent", "build"] as const;
export const sessionModeSchema = z.enum(SESSION_MODES);
export type SessionMode = z.infer<typeof sessionModeSchema>;

/**
 * An adaptive program's settings (`programs.config` for `kind = "adaptive"`). Every field has a default, so
 * `adaptiveConfigSchema.parse({})` is a complete config.
 */
export const adaptiveConfigSchema = z
  .object({
    /** Sessions a week the program aims for. */
    weeklyGoal: z.number().int().min(1).max(7).default(4),
    /**
     * Days sessions go on first, in order of preference, as days after the ISO week's Monday: 0 = Monday …
     * 6 = Sunday (`addDays(startOfIsoWeek(d), day)`). Placement fills the rest of the week Monday → Sunday.
     */
    preferredDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine(unique, { message: "preferredDays repeats a day" })
      .default([]),
    /** Session length when nothing else says. */
    defaultMinutes: z.number().int().min(10).max(90).default(30),
    /** `locations.id` sessions happen at unless overridden; null = the account's default place. */
    defaultLocationId: z.string().min(1).nullable().default(null),
    /** Weeks per training block (one core lift per family per block). */
    blockWeeks: z.number().int().min(4).max(6).default(5),
    /** The modes the program may propose. */
    modes: z
      .array(sessionModeSchema)
      .min(1)
      .refine(unique, { message: "modes repeats a mode" })
      .default([...SESSION_MODES]),
    /** Condition profile ids whose care content (care block, coverage targets) this program includes. */
    careProfiles: z
      .array(z.string().min(1))
      .refine(unique, { message: "careProfiles repeats a profile" })
      .default([]),
    /** How many weeks ahead slots are placed. */
    placementWeeksAhead: z.number().int().min(1).max(4).default(2),
  })
  .strict();
export type AdaptiveConfig = z.infer<typeof adaptiveConfigSchema>;

export const BLOCK_KINDS = ["core_block", "firm_week", "shape_week"] as const;
export const blockKindSchema = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof blockKindSchema>;

/** A core lift changed mid-block (the engine's `Rotation`). */
export const blockRotationSchema = z
  .object({
    family: z.string().min(1),
    /** The lift it replaced; null when the family had none. */
    from: z.string().min(1).nullable(),
    to: z.string().min(1),
    date: localDate,
    why: z.string(),
  })
  .strict();
export type BlockRotation = z.infer<typeof blockRotationSchema>;

/**
 * A core block's intent: the core lift per family (null = none yet) and the rotations so far. With the row's
 * `id`, `number`, `start_date` and `weeks` it is the engine's `Block`.
 */
export const coreBlockIntentSchema = z
  .object({
    core: z.record(z.string().min(1), z.string().min(1).nullable()),
    rotations: z.array(blockRotationSchema).default([]),
  })
  .strict();

/** A shape week's intent: an outline (the coach's `{volumeTarget, keySessions}`). */
export const shapeWeekIntentSchema = z
  .object({
    volumeTarget: z.string(),
    keySessions: z.array(z.string()),
  })
  .strict();

/** A firm week's intent is empty: its sessions are its planned workouts. (`intent` is NOT NULL, so `{}`.) */
export const firmWeekIntentSchema = z.object({}).strict();

export const BLOCK_INTENT_SCHEMAS = {
  core_block: coreBlockIntentSchema,
  firm_week: firmWeekIntentSchema,
  shape_week: shapeWeekIntentSchema,
} as const satisfies Record<BlockKind, z.ZodTypeAny>;

/** Any block's intent. `parseBlockIntent` also checks it is the intent of the row's `kind`. */
export const blockIntentSchema = z.union([coreBlockIntentSchema, shapeWeekIntentSchema, firmWeekIntentSchema]);
export type BlockIntent = z.infer<typeof blockIntentSchema>;
export type BlockIntentOf<K extends BlockKind> = z.infer<(typeof BLOCK_INTENT_SCHEMAS)[K]>;

/** Parse a `program_blocks.intent` against the schema for that row's `kind`; throws on a mismatch. */
export function parseBlockIntent<K extends BlockKind>(kind: K, value: unknown): BlockIntentOf<K> {
  return BLOCK_INTENT_SCHEMAS[kind].parse(value) as BlockIntentOf<K>;
}
