/**
 * THE COACH DESIGNER'S TOOLS (Stage 3 spec §4): the one registry the step loop is given (`RunDeps.tools`). Each tool
 * carries its name, its input's JSON schema, its declared statement cost, the roles that may call it, and its
 * handler (types.ts). The loop sends every tool to every role — one shared cache prefix — and answers a call a role
 * may not make with an error.
 *
 * The names, and what each tool is for, are the ones the prompt promises (design-prompt.ts `PROMPT_TOOL_NAMES` and
 * "Using the tools well"); the descriptions stay short because the prompt already explains when to reach for which.
 * The read tools serve all three roles; the act tools follow them (`ACT_TOOLS`, each with its own roles), the
 * reviewer's `submit_review` (design-review.ts) among them. One tool the prompt names arrives with a later task —
 * `plan_set` (Task 7) — and is listed in `PENDING_TOOL_NAMES` until it does, so a test holds the registry plus that
 * list to the prompt's names exactly.
 */
import { submitReview } from "../design-review.js";
import { askAthlete } from "./ask.js";
import { finish } from "./finish.js";
import { proposeWorkout } from "./propose.js";
import { readAnswers } from "./read-answers.js";
import { readBalance } from "./read-balance.js";
import { readDay } from "./read-day.js";
import { readHistory } from "./read-history.js";
import { getExercise, searchLibraryTool } from "./read-library.js";
import { recallMemory } from "./read-memory.js";
import { readObjectives } from "./read-objectives.js";
import { readPlan } from "./read-plan.js";
import { readProfile } from "./read-profile.js";
import { readProposals } from "./read-proposals.js";
import { readReadiness } from "./read-readiness.js";
import { listTemplates } from "./read-templates.js";
import { getWorkout, listWorkouts } from "./read-workouts.js";
import { recordAnswer } from "./record-answer.js";
import { remember } from "./remember.js";
import type { DesignTool } from "./types.js";
import { validateWorkout } from "./validate.js";

/** The read tools, in the prompt's order. */
export const READ_TOOLS: DesignTool[] = [
  readProfile,
  readDay,
  readPlan,
  listWorkouts,
  getWorkout,
  readHistory,
  readBalance,
  readReadiness,
  readAnswers,
  readObjectives,
  searchLibraryTool,
  getExercise,
  listTemplates,
  readProposals,
  recallMemory,
];

/** The act tools, in the prompt's order. */
export const ACT_TOOLS: DesignTool[] = [validateWorkout, askAthlete, recordAnswer, remember, proposeWorkout, submitReview, finish];

/** Tools the prompt names that later tasks add: each leaves this list when it joins the registry. */
export const PENDING_TOOL_NAMES = ["plan_set"] as const;

/** Every tool a run is offered. */
export function allTools(): DesignTool[] {
  return [...READ_TOOLS, ...ACT_TOOLS];
}
