import { z } from "zod";
import { daysBetween, isLocalDate, isoWeekday, startOfIsoWeek } from "./time.js";

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

/** What a plan's words may hold: its purpose a sentence, its brief the rules for its next sessions, and its objectives. */
export const PLAN_PURPOSE_MAX = 200;
export const PLAN_BRIEF_MAX = 1000;
export const PLAN_OBJECTIVES_MAX = 12;

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
 * A COURSE'S RHYTHM LONGER THAN A WEEK (R1.6): its days every `everyWeeks` weeks (2 to 4), counted from `cadenceFrom`, the Monday
 * of the first week it uses. Both keys are stored only when they say something: every week is neither key, never
 * `everyWeeks: 1`, so a row an older worker reads (its schema is strict) is the row it always was. `withCadence` is the one way
 * to write them. Placement asks `onWeek` of each ISO week; a week it doesn't use holds none of the plan's sessions. A course's
 * alone: a programme runs every week (`adaptiveConfigSchema`).
 */
export const EVERY_WEEKS_MAX = 4;
const cadenceKeys = {
  /** Its days every this many weeks, 2 to 4; absent: every week. */
  everyWeeks: z.number().int().min(1).max(EVERY_WEEKS_MAX).optional(),
  /** The Monday of a week the rhythm uses; present exactly when `everyWeeks` is. */
  cadenceFrom: localDate.optional(),
};

/** The rhythm's rule on a course's config: an anchor Monday with every 2 weeks or more, neither key for every week. */
function cadenceRule(c: { everyWeeks?: number | undefined; cadenceFrom?: string | undefined }, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (c.everyWeeks === 1) issue("everyWeeks", "every week is the default: leave everyWeeks out");
  if (c.everyWeeks !== undefined && c.everyWeeks > 1 && c.cadenceFrom === undefined) issue("cadenceFrom", "a rhythm of 2 weeks or more needs the Monday it counts from");
  if (c.cadenceFrom !== undefined && (c.everyWeeks ?? 1) <= 1) issue("cadenceFrom", "cadenceFrom goes with everyWeeks 2 to 4");
  if (c.cadenceFrom !== undefined && isLocalDate(c.cadenceFrom) && isoWeekday(c.cadenceFrom) !== 1) issue("cadenceFrom", "cadenceFrom must be a Monday");
}

/** A plan's rhythm as placement reads it: every week unless both keys say otherwise. */
export interface Cadence {
  everyWeeks: number;
  /** The Monday it counts from; null: every week. */
  from: string | null;
}
export function cadenceOf(c: { everyWeeks?: number | undefined; cadenceFrom?: string | undefined }): Cadence {
  const n = c.everyWeeks ?? 1;
  return n > 1 && c.cadenceFrom ? { everyWeeks: n, from: c.cadenceFrom } : { everyWeeks: 1, from: null };
}

/**
 * Whether the ISO week holding `date` is one the rhythm uses: every week, or a whole number of rhythms on from its anchor. The
 * anchor is where the rhythm starts (fix round 1): no week before it is one of its weeks, so "from 7 Dec" set on 22 Nov places
 * nothing before 7 Dec.
 */
export function onWeek(date: string, c: { everyWeeks?: number | undefined; cadenceFrom?: string | undefined }): boolean {
  const { everyWeeks: n, from } = cadenceOf(c);
  if (n === 1 || from === null) return true;
  const weeks = Math.round(daysBetween(startOfIsoWeek(from), startOfIsoWeek(date)) / 7);
  return weeks >= 0 && weeks % n === 0;
}

/**
 * A config with its rhythm set, as a new object: every 2 weeks or more writes both keys (the anchor on its week's Monday), every
 * week removes both, so nothing is stored that an older worker would refuse.
 */
export function withCadence<T extends object>(config: T, everyWeeks: number, from: string | null): T {
  const { everyWeeks: _n, cadenceFrom: _f, ...rest } = config as T & { everyWeeks?: unknown; cadenceFrom?: unknown };
  if (everyWeeks <= 1 || from === null) return rest as T;
  return { ...rest, everyWeeks, cadenceFrom: startOfIsoWeek(from) } as T;
}

/**
 * The Monday a new rhythm counts from when nothing says (fix round 1, the review's MAJOR 2): the week of the plan's latest done
 * session, so the next one falls a rhythm after it ("every 2 weeks" the day after Monday's session: the Monday two weeks on);
 * none done, the current week.
 */
export function cadenceAnchor(today: string, lastDone: string | null): string {
  return startOfIsoWeek(lastDone ?? today);
}

/**
 * An adaptive program's settings (`programs.config` for `kind = "adaptive"`). Every field has a default, so
 * `adaptiveConfigSchema.parse({})` is a complete config. NO RHYTHM (R1.6 fix round 1): a programme's goal is read per week
 * wherever it is shown or built from (its row's "1 of 3 this week", its build's mode), so a rhythm longer than a week would read
 * as falling behind. A programme runs every week; its schema takes neither rhythm key, so nothing writes one. A course can be
 * spaced out. `adaptiveConfigFields` is the same object, the name a route's partial takes.
 */
export const adaptiveConfigFields = z
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
export const adaptiveConfigSchema = adaptiveConfigFields;
/** Why a programme takes no rhythm, in the coach's words (change_programme's refusal, the settings route's 422). */
export const PROGRAMME_EVERY_WEEK = "A programme runs every week; a course can be spaced out.";
export type AdaptiveConfig = z.infer<typeof adaptiveConfigSchema>;

/**
 * A course's settings (`programs.config` for `kind = "course"`): a fixed course of sessions placed on set weekdays at a set
 * time, every week or every few (`everyWeeks`). `courseConfigFields` is the object before the rhythm's rule, for a route's pick.
 */
export const courseConfigFields = z
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
    /**
     * A start or a stop part way (`course-plans.ts`): set with its first send, cleared by the write that finds nothing left.
     * Set, the hourly pass carries it on, and "start" holds the plan's fill.
     */
    finishing: z.enum(["start", "stop"]).optional(),
    ...cadenceKeys,
  })
  .strict();
export const courseConfigSchema = courseConfigFields.superRefine(cadenceRule);
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
