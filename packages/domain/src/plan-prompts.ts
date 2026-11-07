import { onEndAllowed, type PlanOnEnd, type ProgramKind } from "./program.js";
import { addDays, daysBetween, isLocalDate } from "./time.js";
import { lineSentenceName } from "./training-lines.js";

/**
 * WHEN A PLAN ASKS WHAT COMES NEXT (plans with a purpose §4): one rule, read by today's "needs you" chip and by the
 * plan's row in Your Plans, so the two never disagree.
 *
 * A plan prompts when it is running and not paused, it ends by asking (`ask`) or by continuing (`continue`, a coach
 * plan's, until the coach drafts for it), and its LAST SESSION is within `PLAN_PROMPT_DAYS` days of today:
 * ahead ("it ends in 12 days") or, once it has run out, behind ("it ended 3 days ago"), when the question stays quietly
 * available (spec §4.1(4)); past that it says nothing. `lastSessionDate`
 * is the later of the plan's last session and its last outline week, which the caller works out from the rows and
 * the blocks (nothing is stored): a plan with a phase or an outline week still ahead is not ending. A retired plan,
 * a paused one, one that finishes, a course and a programme never prompt. A plan with a draft ready (`hasDraft`)
 * prompts to review it, whatever its end.
 *
 * Its words are the app's: the plan's sport as the chip has always said it ("my running plan"), or the plan's own
 * name when it has none. Nothing here is a plan's: no course, no person.
 */

/** How far ahead a plan's last session may be for the plan to be "ending": the chip's horizon. */
export const PLAN_PROMPT_DAYS = 21;

/**
 * The kinds of plan that can ask what comes next. Every other kind (a programme, a course, the one-off bucket) never
 * does. The one place the kinds are named: the rule below and the worker's reads both use it, and a test lists every
 * kind, so a new one has to be placed here before it can be read as having no end.
 */
export const PLAN_PROMPT_KINDS = ["coach", "coros_import"] as const satisfies readonly ProgramKind[];

export interface PlanPromptInput {
  kind: ProgramKind;
  onEnd: PlanOnEnd;
  status: "active" | "retired";
  /** The day the plan is paused until; one before today is no pause. */
  pausedUntil: string | null;
  name: string;
  /** The plan's sport as a training line names it; null when it has none the words know (the name stands in). */
  discipline: "run" | "lift" | "mobility" | null;
  /** The later of the plan's last session and its last outline week; null when it has neither. */
  lastSessionDate: string | null;
  hasDraft: boolean;
}

export interface PlanPrompt {
  kind: "whats_next" | "draft_ready";
  label: string;
  request: string;
}

const inDays = (days: number): string => (days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`);

const ago = (days: number): string => (days === 1 ? "yesterday" : `${days} days ago`);

export function planPrompt(plan: PlanPromptInput, today: string): PlanPrompt | null {
  if (plan.status === "retired") return null;
  if (plan.pausedUntil !== null && plan.pausedUntil >= today) return null;
  // A programme and a course make their sessions for free and never ask; a plan that finishes is done at its end.
  if (!(PLAN_PROMPT_KINDS as readonly ProgramKind[]).includes(plan.kind)) return null;
  if (plan.onEnd === "finish" || !onEndAllowed(plan.kind, plan.onEnd)) return null;
  const it = plan.discipline ? lineSentenceName(plan.discipline) : plan.name;
  if (plan.hasDraft) {
    const label = `Review the draft for ${it}`;
    return { kind: "draft_ready", label, request: `${label}.` };
  }
  const last = plan.lastSessionDate;
  if (last === null || !isLocalDate(last) || last < addDays(today, -PLAN_PROMPT_DAYS) || last > addDays(today, PLAN_PROMPT_DAYS)) return null;
  const label = `Plan what comes after ${it}`;
  const days = daysBetween(today, last);
  // A plan that has run out stays available, quietly: nothing is marked missed and nothing scolds (spec §4.1).
  return { kind: "whats_next", label, request: `${label} — it ${days < 0 ? `ended ${ago(-days)}` : `ends ${inDays(days)}`}.` };
}
