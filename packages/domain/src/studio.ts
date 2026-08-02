import { z } from "zod";
import { isLocalDate, type LocalDate } from "./time.js";

/**
 * Plan Studio domain shapes.
 * Spec: docs/superpowers/specs/2026-08-03-plan-studio-design.md §1.
 *
 * All object schemas are `.strict()`: an unknown field is a validation error,
 * not a silently-dropped key, so stale LLM output or a client/server drift
 * surfaces immediately instead of quietly losing data.
 */

export const STUDIO_GOALS = ["strength", "hypertrophy", "general"] as const;
export type StudioGoal = (typeof STUDIO_GOALS)[number];

// Caps the spec leaves to the implementer's judgment (documented here, never
// silent): a set/rep/weight/rest range wide enough for any real lifting plan.
const MAX_SETS = 10;
const MAX_REPS = 50;
const MAX_WEIGHT_KG = 500;
/** 15 minutes — generous ceiling for a single set's rest period. */
const MAX_REST_SECONDS = 900;

export const planBriefSchema = z
  .object({
    goal: z.enum(STUDIO_GOALS),
    durationWeeks: z.number().int().min(2).max(16),
    sessionsPerWeek: z.number().int().min(1).max(6),
    /** ISO weekday 1 (Mon) .. 7 (Sun); length must equal sessionsPerWeek. */
    preferredDays: z.array(z.number().int().min(1).max(7)),
    sessionMinutes: z.number().int().min(20).max(120),
    equipment: z.string(),
    constraints: z.string(),
    notes: z.string(),
    startDate: z.string().refine(isLocalDate, {
      message: "startDate must be a YYYY-MM-DD calendar date",
    }),
  })
  .strict()
  .refine((brief) => brief.preferredDays.length === brief.sessionsPerWeek, {
    message: "preferredDays length must equal sessionsPerWeek",
    path: ["preferredDays"],
  });
export type PlanBrief = z.infer<typeof planBriefSchema> & { startDate: LocalDate };

export const studioWeightSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bodyweight") }).strict(),
  z.object({ type: z.literal("kg"), value: z.number().min(0).max(MAX_WEIGHT_KG) }).strict(),
]);
export type StudioWeight = z.infer<typeof studioWeightSchema>;

export const studioExerciseSchema = z
  .object({
    /** Must exist in the synced COROS catalog (coros_exercises.id). */
    originId: z.string().min(1),
    /** Display name, taken from the catalog at generation time. */
    name: z.string().min(1),
    sets: z.number().int().min(1).max(MAX_SETS),
    reps: z.number().int().min(1).max(MAX_REPS),
    weight: studioWeightSchema,
    restSeconds: z.number().int().min(0).max(MAX_REST_SECONDS),
    note: z.string().optional(),
  })
  .strict();
export type StudioExercise = z.infer<typeof studioExerciseSchema>;

export const studioSessionSchema = z
  .object({
    title: z.string().min(1),
    /** ISO weekday 1 (Mon) .. 7 (Sun). */
    weekday: z.number().int().min(1).max(7),
    exercises: z.array(studioExerciseSchema),
  })
  .strict();
export type StudioSession = z.infer<typeof studioSessionSchema>;

export const studioWeekSchema = z
  .object({
    sessions: z.array(studioSessionSchema),
  })
  .strict();
export type StudioWeek = z.infer<typeof studioWeekSchema>;

/**
 * `weeks` is bounded twice, and both bounds are load-bearing:
 *
 *  - `.max(16)` matches `durationWeeks`'s own ceiling. Every week becomes real
 *    workouts on the user's COROS calendar, so an LLM that returned 200 weeks
 *    would become hundreds of writes; the array is capped where the brief is.
 *  - `weeks.length === brief.durationWeeks` — the brief is what the user
 *    agreed to. A plan whose body disagrees with its own brief is not a plan
 *    the user approved, and the difference is silently pushed otherwise.
 */
export const liftingPlanSchema = z
  .object({
    name: z.string().min(1),
    brief: planBriefSchema,
    weeks: z.array(studioWeekSchema).max(16),
  })
  .strict()
  .refine((plan) => plan.weeks.length === plan.brief.durationWeeks, {
    message: "weeks length must equal brief.durationWeeks",
    path: ["weeks"],
  });
export type LiftingPlan = z.infer<typeof liftingPlanSchema> & { brief: PlanBrief };

/** studio_plan_pushes.status lifecycle (spec §2). */
export const STUDIO_PLAN_PUSH_STATUSES = ["pending", "verified", "failed", "deleted"] as const;
export type StudioPlanPushStatus = (typeof STUDIO_PLAN_PUSH_STATUSES)[number];
