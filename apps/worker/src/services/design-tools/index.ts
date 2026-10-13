/**
 * THE COACH DESIGNER'S TOOLS (Stage 3 spec §4): the one registry the step loop is given (`RunDeps.tools`). Each tool
 * carries its name, its input's JSON schema, its declared statement cost, the roles that may call it, and its
 * handler (types.ts). The loop sends every tool to every role — one shared cache prefix — and answers a call a role
 * may not make with an error.
 *
 * The names, and what each tool is for, are the ones the prompt promises (design-prompt.ts `PROMPT_TOOL_NAMES` and
 * "Using the tools well"); the descriptions stay short because the prompt already explains when to reach for which.
 * The read tools serve all three roles; the act tools (Task 5) join `allTools()`.
 */
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
import type { DesignTool } from "./types.js";

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

/** Every tool a run is offered. */
export function allTools(): DesignTool[] {
  return [...READ_TOOLS];
}
