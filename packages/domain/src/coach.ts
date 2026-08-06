import { z } from "zod";
import { studioExerciseSchema } from "./studio.js";

/**
 * The coach's typed vocabulary (spec: docs/superpowers/specs/2026-08-06-
 * coach-intelligence-design.md §3). Everything the model may output is
 * bounded and strict — the wake pipeline parses with one repair retry and
 * the guardrail validator runs on ops before anything persists.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One structured run block — the COROS-write-confirmed topology. */
export const coachRunBlockSchema = z
  .object({
    kind: z.enum(["duration", "distance"]),
    /** Minutes for duration blocks; meters for distance blocks. */
    value: z.number().int().min(1).max(100_000),
    intensity: z.enum(["easy", "steady", "threshold", "interval", "rest"]).optional(),
  })
  .strict();

/** A discipline-generic planned session. Exactly one discipline body. */
export const coachSessionSchema = z
  .object({
    category: z.enum(["easy", "long", "quality", "recovery", "race", "rest", "strength"]),
    title: z.string().min(1).max(80),
    durationMinutes: z.number().int().min(5).max(360),
    run: z.object({ blocks: z.array(coachRunBlockSchema).min(1).max(12) }).strict().optional(),
    lift: z.object({ exercises: z.array(studioExerciseSchema).min(1).max(12) }).strict().optional(),
  })
  .strict()
  .refine((s) => !(s.run && s.lift), { message: "session cannot be both run and lift" });
export type CoachSession = z.infer<typeof coachSessionSchema>;

const datedSession = z.object({ date: isoDate, session: coachSessionSchema }).strict();

export const coachShapeWeekSchema = z
  .object({
    weekStart: isoDate,
    volumeTarget: z.string().min(1).max(40),
    keySessions: z.array(z.string().min(1).max(60)).max(4),
  })
  .strict();
export type CoachShapeWeek = z.infer<typeof coachShapeWeekSchema>;

/** The ONLY ways the coach can touch a plan. */
export const coachOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ease"), workoutId: z.string(), session: coachSessionSchema }).strict(),
  z.object({ kind: z.literal("move"), workoutId: z.string(), toDate: isoDate }).strict(),
  z.object({ kind: z.literal("swap"), dayA: isoDate, dayB: isoDate }).strict(),
  z.object({ kind: z.literal("skip"), workoutId: z.string(), reason: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("add"), date: isoDate, session: coachSessionSchema }).strict(),
  z
    .object({
      kind: z.literal("reshapeWeek"),
      planId: z.string(),
      weekStart: isoDate,
      sessions: z.array(datedSession).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("firmUp"),
      planId: z.string(),
      weekStart: isoDate,
      sessions: z.array(datedSession).min(1).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extendPlan"),
      planId: z.string(),
      shapeWeeks: z.array(coachShapeWeekSchema).min(1).max(8),
    })
    .strict(),
  z.object({ kind: z.literal("windDown"), planId: z.string(), sessions: z.array(datedSession).max(10) }).strict(),
  z
    .object({
      kind: z.literal("createPlan"),
      discipline: z.enum(["run", "lift"]),
      name: z.string().min(1).max(60),
      startDate: isoDate,
      endDate: isoDate,
      raceDate: isoDate.optional(),
      firmSessions: z.array(datedSession).min(1).max(30),
      shapeWeeks: z.array(coachShapeWeekSchema).max(14),
    })
    .strict(),
  z.object({ kind: z.literal("retirePlan"), planId: z.string() }).strict(),
]);
export type CoachOp = z.infer<typeof coachOpSchema>;

export const coachProposalDraftSchema = z
  .object({
    title: z.string().min(1).max(80),
    evidence: z.string().min(1).max(200),
    rationale: z.string().min(1).max(2000),
    /** min(end of first affected day, +72h) — enforced downstream too. */
    expiresAt: isoDate,
    flags: z.array(z.string().max(120)).max(6),
    ops: z.array(coachOpSchema).min(1).max(20),
  })
  .strict();
export type CoachProposalDraft = z.infer<typeof coachProposalDraftSchema>;

export const coachMemoryOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      kind: z.enum(["fact", "rule", "note"]),
      text: z.string().min(1).max(300),
      expiresAt: isoDate.optional(),
    })
    .strict(),
  z.object({ op: z.literal("update"), id: z.string(), text: z.string().min(1).max(300) }).strict(),
  z.object({ op: z.literal("expire"), id: z.string() }).strict(),
]);
export type CoachMemoryOp = z.infer<typeof coachMemoryOpSchema>;

/** One wake's complete structured output. Restraint is first-class: an
 * all-null/empty output is a fully successful wake. */
export const wakeOutputSchema = z
  .object({
    briefing: z.string().max(4000).nullable(),
    proposals: z.array(coachProposalDraftSchema).max(6),
    question: z
      .object({ text: z.string().min(1).max(300), chips: z.array(z.string().min(1).max(60)).max(5) })
      .strict()
      .nullable(),
    memoryOps: z.array(coachMemoryOpSchema).max(12),
  })
  .strict();
export type WakeOutput = z.infer<typeof wakeOutputSchema>;
