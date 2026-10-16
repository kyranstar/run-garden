/**
 * Limits the coach designer's loop enforces and its prompt states, defined once so the two cannot drift.
 *
 * A module of its own (no imports): the prompt (design-prompt.ts) reads it at load time, and the step loop
 * (coach-runs.ts) imports the opening context, so the prompt importing the loop would be an import cycle.
 */

/** Tool calls one model turn may ask for; past this each gets an error result and nothing runs (coach-runs.ts). */
export const MAX_TOOL_CALLS_PER_TURN = 12;

/** Model calls a reviewer run may make (coach-runs.ts `RUN_LIMITS`); its review packet says so (design-review.ts). */
export const REVIEWER_MAX_CALLS = 3;

/** The most workouts one set plans (a week, or the next N whatever N is: design-orchestrate.ts). */
export const SET_MAX_WORKOUTS = 7;

/** Rounds of redo a set's main coach may ask for after its first plan: plan_set once more, for specific keys. */
export const SET_REDO_ROUNDS = 1;

/** What one workout's designer, its reviewers included, may spend (micros): what a single workout's run may
 * (coach-runs.ts `RUN_CEILING_MICROS.now`). The set's main run holds the whole set's ceiling above it. */
export const DESIGNER_CEILING_MICROS = 1_500_000;
