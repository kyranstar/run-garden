import { z } from "zod";
import { sessionModeSchema } from "./program.js";
import { isLocalDate } from "./time.js";

// What a performed session saves (one-workout-system spec §8.3, §10.5–10.6; Phase 1 spec §6).
//
// `performedSessionSaveSchema` is THE wire contract (ruling P1-R3): the payload the player's outbox holds and
// `PUT /api/sessions/performed/:id` accepts. Its shape follows the rows a save writes — `performed_sessions`, one
// `performed_sets` row per set, `condition_checks` — plus the review decisions applied on save. The session
// engine's recorder output (`PerformedSessionSave` in @rg/session-engine) maps to it through one function there,
// `toPerformedSave`; `historyFromPerformed` maps it back to the history the engine reads.

const localDate = z.string().refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" });
const instant = z.string().datetime({ offset: true });
const id = z.string().min(1).max(200);
const count = z.number().int().min(0);

/** Upper bounds that only refuse junk: a real session is far inside every one. */
export const PERFORMED_LIMITS = { entries: 100, setsPerEntry: 50, movesDone: 200, checks: 20, flags: 10, note: 2000 } as const;

/**
 * The sources a save may carry. A stored row may also say `watch`: the COROS ingest derives that session from a watch
 * strength activity (Phase 2a+), and it never arrives on the save wire.
 */
export const PERFORMED_SOURCES = ["app", "watch_review", "import"] as const;
export const performedSourceSchema = z.enum(PERFORMED_SOURCES);
export type PerformedSource = z.infer<typeof performedSourceSchema>;

export const CHECK_KINDS = ["pre", "post", "daily"] as const;
export const checkKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof checkKindSchema>;

/**
 * The library's set formats. The library owns them (`FORMAT_IDS` in @rg/exercise-library); a session-engine test
 * keeps the two lists equal.
 */
export const SESSION_FORMATS = ["straight", "superset", "circuit", "ladder", "flow", "holds"] as const;
export const sessionFormatSchema = z.enum(SESSION_FORMATS);
export type SessionFormat = z.infer<typeof sessionFormatSchema>;

/** A weight exactly as entered: `{ v: 25, u: "lb" }` (see weights.ts). The server derives `load_kg`. */
export const weightSchema = z.object({ v: z.number().positive().finite(), u: z.enum(["lb", "kg"]) }).strict();

/** One set — one `performed_sets` row. */
export const performedSetSchema = z
  .object({
    /** Position among the entry's sets, from 0. */
    setIndex: count,
    /** For a set logged per side; null when one set covers both (the app's own sessions). */
    side: z.enum(["left", "right"]).nullable().default(null),
    reps: count.nullable(),
    seconds: count.nullable(),
    load: weightSchema.nullable(),
    /** False only for a set kept as not done (a watch review's skipped set). */
    done: z.boolean().default(true),
    /** Condition-profile flag ids on this exercise (a profile's `setFlag.id`). */
    flags: z.array(z.string().min(1).max(60)).max(PERFORMED_LIMITS.flags).default([]),
  })
  .strict();
export type PerformedSet = z.infer<typeof performedSetSchema>;

/** One exercise logged in the session; its sets become rows sharing this entry's index. */
export const performedEntrySchema = z
  .object({
    exerciseId: id,
    implement: z.string().min(1).max(60).nullable(),
    format: sessionFormatSchema.nullable(),
    perSide: z.boolean(),
    sets: z.array(performedSetSchema).min(1).max(PERFORMED_LIMITS.setsPerEntry),
  })
  .strict();
export type PerformedEntry = z.infer<typeof performedEntrySchema>;

/** One condition check — one `condition_checks` row (its date, session and workout come from where it is sent). */
export const conditionCheckSchema = z
  .object({
    profileId: z.string().min(1).max(60),
    kind: checkKindSchema,
    /** 0–10; null when the person said how they felt without a number (feeling off). */
    value: z.number().int().min(0).max(10).nullable(),
    feelingOff: z.boolean().default(false),
    at: instant,
  })
  .strict();
export type ConditionCheck = z.infer<typeof conditionCheckSchema>;

/** The review screen's decisions, applied on save — never while reviewing (Phase 1 spec §5 change 4). */
export const reviewChangesSchema = z
  .object({
    /** +1 / -1, or null to clear a rating, per exercise id. */
    ratings: z.record(id, z.union([z.literal(1), z.literal(-1), z.null()])).default({}),
    /** "Not for me" set (true) or lifted (false), per exercise id. */
    excluded: z.record(id, z.boolean()).default({}),
    /** Accepted graduation offers: the core family and the harder move it moves to. */
    graduations: z.array(z.object({ family: z.string().min(1), to: id }).strict()).default([]),
  })
  .strict();
export type ReviewChanges = z.infer<typeof reviewChangesSchema>;

export const performedSessionSaveSchema = z
  .object({
    /** Client-generated; the idempotency key (the same id with a different payload is refused, never merged). */
    id,
    source: performedSourceSchema,
    /** The source's own session id: required for imports (they merge by it), null for the app's own saves. */
    sourceRef: id.nullable(),
    /** The planned workout (slot) this session performed, if any. */
    workoutId: id.nullable(),
    buildId: id.nullable(),
    localDate,
    startedAt: instant.nullable(),
    endedAt: instant.nullable(),
    /** Time actually running, in seconds. */
    seconds: count,
    plannedSeconds: count.nullable(),
    /** The session length asked for. */
    minutes: count.nullable(),
    mode: sessionModeSchema.nullable(),
    /** Theme id. */
    theme: z.string().min(1).max(60).nullable(),
    locationId: id.nullable(),
    /** The training block the session belonged to (`program_blocks.id`) and its number then. */
    blockRef: id.nullable(),
    blockNumber: count.nullable(),
    completed: z.boolean(),
    stepsTotal: count.nullable(),
    stepsDone: count.nullable(),
    /** Every move reached, logged or not, with the seconds spent on it (`performed_sessions.moves_done`). */
    movesDone: z
      .array(z.object({ exerciseId: id, seconds: count }).strict())
      .max(PERFORMED_LIMITS.movesDone)
      .default([]),
    note: z.string().max(PERFORMED_LIMITS.note).nullable(),
    /** The move introduced in this session, if any. */
    newMove: id.nullable(),
    entries: z.array(performedEntrySchema).max(PERFORMED_LIMITS.entries),
    /** The session's own checks: `pre` and `post` only, at most one of each per profile. */
    checks: z.array(conditionCheckSchema).max(PERFORMED_LIMITS.checks).default([]),
    review: reviewChangesSchema.default({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.source === "import" && s.sourceRef === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRef"], message: "an import names its source session" });
    }
    const seen = new Set<string>();
    s.checks.forEach((c, i) => {
      if (c.kind === "daily") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", i, "kind"], message: "a session's checks are pre or post" });
      }
      const key = `${c.profileId}\u0000${c.kind}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", i], message: `a second ${c.kind} check for ${c.profileId}` });
      }
      seen.add(key);
    });
  });
/** The parsed payload (defaults filled). */
export type PerformedSessionWire = z.infer<typeof performedSessionSaveSchema>;
/** What a sender may omit (fields with defaults). */
export type PerformedSessionWireInput = z.input<typeof performedSessionSaveSchema>;
