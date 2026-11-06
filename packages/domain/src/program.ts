import { z } from "zod";
import { isLocalDate } from "./time.js";

// Programs: the one registry of plans (one-workout-system spec §8.1, Phase 1 spec §6). `programs.config` and
// `program_blocks.intent` are JSON columns; these are what they hold.

const localDate = z.string().refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" });
const unique = <T>(xs: readonly T[]): boolean => new Set(xs).size === xs.length;

export const PROGRAM_KINDS = ["adaptive", "coros_import", "coach", "studio", "course"] as const;
export const programKindSchema = z.enum(PROGRAM_KINDS);
export type ProgramKind = z.infer<typeof programKindSchema>;

/**
 * What happens when a plan's last session passes (`programs.on_end`): `ask` the athlete what comes next,
 * `continue` by making more sessions, or `finish`. Each kind allows only some of them.
 */
export const PLAN_ON_END = ["ask", "continue", "finish"] as const;
export const planOnEndSchema = z.enum(PLAN_ON_END);
export type PlanOnEnd = z.infer<typeof planOnEndSchema>;

const ON_END_ALLOWED: Record<ProgramKind, readonly PlanOnEnd[]> = {
  adaptive: ["continue"],
  course: ["continue", "finish"],
  coach: ["ask", "continue", "finish"],
  coros_import: ["ask", "finish"],
  studio: [],
};

/** Whether a plan of this kind may end that way. A programme or a course makes sessions for free, so it never asks. */
export function onEndAllowed(kind: ProgramKind, onEnd: PlanOnEnd): boolean {
  return ON_END_ALLOWED[kind].includes(onEnd);
}

/**
 * How a plan ends when nothing says: running asks (what comes after a race or a phase is the athlete's call),
 * most else continues. A COROS import's sessions aren't ours to extend, so one without running has nothing to
 * continue and finishes. A studio plan allows no ending; it reads as finished.
 */
export function defaultOnEnd(kind: ProgramKind, disciplines: readonly string[]): PlanOnEnd {
  const runs = disciplines.includes("run");
  switch (kind) {
    case "coach":
      return runs ? "ask" : "continue";
    case "coros_import":
      return runs ? "ask" : "finish";
    case "studio":
      return "finish";
    default:
      return "continue";
  }
}

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

/**
 * A course's settings (`programs.config` for `kind = "course"`): a fixed course of sessions placed on set
 * weekdays at a set time.
 */
export const courseConfigSchema = z
  .object({
    /** Which course (its definition's id). */
    course: z.string().min(1),
    /** Days sessions go on: 0 = Monday … 6 = Sunday, the same numbering as `adaptiveConfigSchema.preferredDays`. */
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine(unique, { message: "weekdays repeats a day" }),
    /** Local time of day, 24-hour "HH:MM". */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "must be a 24-hour HH:MM time" }),
    /** Days before a race with no sessions. */
    quietDaysBeforeRace: z.number().int().min(0).max(21).default(7),
    /** How many weeks ahead sessions are placed. */
    placementWeeksAhead: z.number().int().min(1).max(4).default(2),
    /** Whether the next session is eased. */
    easeNext: z.boolean().default(false),
  })
  .strict();
export type CourseConfig = z.infer<typeof courseConfigSchema>;

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
