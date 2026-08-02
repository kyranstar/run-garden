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
/**
 * Found unbounded during Task 4 review: an LLM could emit 50 exercises in one
 * session with nothing to stop it. 10 is a generous real-world ceiling — no
 * legitimate lifting session runs longer than that — and every exercise
 * becomes real COROS program content on push, so an unbounded array is the
 * same "runaway generation → runaway writes" shape `weeks.max(16)` below
 * already guards against, just one level down.
 */
const MAX_EXERCISES_PER_SESSION = 10;
/**
 * Found unbounded during whole-branch review: `title` becomes the ownership
 * stamp on the COROS wire (`sessionStamp` in studio-push.ts appends " — wk N"
 * on top of it) — that stamp is how a later push run recognizes and verifies
 * a session it created. An over-long title that COROS truncates or otherwise
 * normalizes on its end breaks that verify-by-stamp match, and the mismatch
 * becomes an *unmanaged* calendar entry: the studio's own bookkeeping no
 * longer recognizes it as one of its rows, so it can never be found and
 * deleted again. 80 is a generous real title length with headroom to spare.
 */
const MAX_TITLE_LENGTH = 80;
/**
 * Same wire-identity reasoning as MAX_TITLE_LENGTH above — the plan `name` is
 * user/LLM-facing display text, not itself part of the COROS stamp, but an
 * unbounded name is the same "runaway LLM output with nothing stopping it"
 * shape as every other cap in this file, so it gets the same ceiling.
 */
const MAX_PLAN_NAME_LENGTH = 80;
/**
 * Matches `planBriefSchema.sessionsPerWeek`'s own ceiling (min(1).max(6))
 * below. Found unbounded during whole-branch review: nothing stopped an LLM
 * from emitting a week with far more sessions than the brief asked for —
 * every session becomes a real COROS scheduled-workout write on push, so a
 * 16-week plan with, say, 100 sessions/week would become 1600 real writes
 * despite `weeks.max(16)` already capping the week count. The
 * `sessions.length === brief.sessionsPerWeek` invariant elsewhere in this
 * module (documented on `PLAN_HARD_RULES` in studio-llm.ts, though not
 * zod-enforced at the schema level the way `weeks.length` is) is a *prompted*
 * expectation, not a validated one — this cap is the actual backstop.
 */
const MAX_SESSIONS_PER_WEEK = 6;

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
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    /** ISO weekday 1 (Mon) .. 7 (Sun). */
    weekday: z.number().int().min(1).max(7),
    exercises: z.array(studioExerciseSchema).max(MAX_EXERCISES_PER_SESSION),
  })
  .strict();
export type StudioSession = z.infer<typeof studioSessionSchema>;

export const studioWeekSchema = z
  .object({
    sessions: z.array(studioSessionSchema).max(MAX_SESSIONS_PER_WEEK),
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
    name: z.string().min(1).max(MAX_PLAN_NAME_LENGTH),
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
