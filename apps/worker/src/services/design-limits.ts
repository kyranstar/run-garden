/**
 * Limits the coach designer's loop enforces and its prompt states, defined once so the two cannot drift.
 *
 * A module of its own, with no imports: the prompt (design-prompt.ts) and the opening context (design-context.ts) read
 * it, and the step loop (coach-runs.ts) imports them both — so neither may import the loop, and this module may import
 * nothing that could lead back to it (fix wave 3A round 2, B-M9: the role caps moved here from the loop).
 */

/** Tool calls one model turn may ask for; past this each gets an error result and nothing runs (coach-runs.ts). */
export const MAX_TOOL_CALLS_PER_TURN = 12;

/** Model calls a reviewer run may make (`RUN_LIMITS.reviewer`); its review packet says so (design-review.ts). */
export const REVIEWER_MAX_CALLS = 3;

/** The effort a model call asks for (llm-messages.ts `Effort`, named here again: this module imports nothing). */
type RunEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A run's limits by role: model calls (the step cap — each role block states it: design-context.ts), the effort every
 * call asks for, the output ceiling per call. Effort is always sent: omitted, Opus 5.5 takes `medium`. The loop
 * (coach-runs.ts) re-exports it.
 */
export const RUN_LIMITS: Readonly<Record<"main" | "designer" | "reviewer", { maxCalls: number; effort: RunEffort; maxTokens: number }>> = {
  main: { maxCalls: 12, effort: "high", maxTokens: 16_000 },
  designer: { maxCalls: 10, effort: "high", maxTokens: 16_000 },
  reviewer: { maxCalls: REVIEWER_MAX_CALLS, effort: "high", maxTokens: 16_000 },
};

/** The most workouts one set plans (a week, or the next N whatever N is: design-orchestrate.ts). */
export const SET_MAX_WORKOUTS = 7;

/** Rounds of redo a set's main coach may ask for after its first plan: plan_set once more, for specific keys. */
export const SET_REDO_ROUNDS = 1;

/** What one workout's designer, its reviewers included, may spend (micros): what a single workout's run may
 * (coach-runs.ts `RUN_CEILING_MICROS.now`). The set's main run holds the whole set's ceiling above it. */
export const DESIGNER_CEILING_MICROS = 1_500_000;

/** What a set's plan keeps back for the main coach's own calls after its designers (judging the set, a redo's plan,
 * the finish): plan_set refuses a plan whose estimate and this don't fit what the ceiling has left (micros). */
export const SET_MAIN_RESERVE_MICROS = 750_000;
