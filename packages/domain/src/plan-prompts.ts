import { onEndAllowed, type PlanOnEnd, type ProgramKind } from "./program.js";
import { addDays, daysBetween, isLocalDate } from "./time.js";
import { lineSentenceName } from "./training-lines.js";

/**
 * WHEN A PLAN ASKS WHAT COMES NEXT (plans with a purpose §4): one rule, read by today's "needs you" chip and by the
 * plan's row in Your Plans, so the two never disagree.
 *
 * A plan prompts when it is running and not paused, it ends by asking (`ask`) or by continuing (`continue`, a coach
 * plan's, until the coach drafts for it), and its LAST SESSION is within `PLAN_PROMPT_DAYS` days ahead of today
 * ("it ends in 12 days"). A plan that ASKS, once it has run out, is also asked about up to `PLAN_PROMPT_DAYS` days
 * behind ("it ended 3 days ago"), when the question stays quietly available (spec §4.1(4)); a plan that CONTINUES has
 * nothing to ask once it has run out (its sheet says it continues on its own), so it prompts only while its last day is
 * today or ahead. Past that it says nothing. `lastSessionDate`
 * is the later of the plan's last session and its last outline week, which the caller works out from the rows and
 * the blocks (nothing is stored): a plan with a phase or an outline week still ahead is not ending. A retired plan,
 * a paused one, one that finishes, a course and a programme never prompt. A plan with its next stretch ready
 * (`hasDraft`: a proposal that names it waits for the athlete) says so, whatever its end: "Next stretch ready for my
 * lifting plan". That line is never sent as a request: a tap opens where the proposal already is.
 *
 * WITH DRAFTS ON (plans with a purpose §4.2), a coach plan that continues is drafted for, once an ending, by the hourly
 * pass, and the caller says where this ending's draft stands (`draft`): while it is due or its run is at work the plan
 * asks nothing; held back by a suggestion of the athlete's, it asks as before; once it is over without a proposal waiting
 * the question comes back, and says plainly what happened (`note`, also carried in its request): the week's budget spent,
 * or no proposal came of it. `hasDraft` is the caller's: the plan's own draft left a proposal still open (R58). A plan that
 * asks, and every other kind, never drafts: `draft` absent is the rule as it was, word for word (drafts off).
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
  /** The plan's own draft left a proposal that waits for the athlete: its next stretch is ready to review. */
  hasDraft: boolean;
  /**
   * With drafts on, a coach plan that continues: where this ending's draft stands. Absent: drafts are off, or the plan
   * doesn't draft — the rule as it was. Ignored for any plan but a coach plan that continues.
   */
  draft?: PlanDraftState;
}

/**
 * Where a plan's draft for its ending stands (plans with a purpose §4.2), as the caller reads it from the draft's key and
 * its run: none yet (`due`: the hourly pass starts one), none yet but held back by a suggestion of the athlete's filed
 * under the plan, which they decide first (`held`: the question shows meanwhile, nothing goes quiet), its run at work
 * (`live`), or over with no proposal waiting — because the week couldn't pay for it, no proposal came of it, or the
 * athlete has decided what it proposed.
 */
export type PlanDraftState = { kind: "due" } | { kind: "held" } | { kind: "live" } | { kind: "over"; outcome: PlanDraftOutcome };
export type PlanDraftOutcome = "week_budget" | "no_proposal" | "decided";

/** What a plan's question says of a draft that came to nothing, plainly (spec §4.2): the row shows it, the request carries it. */
export const PLAN_DRAFT_NOTES: Readonly<Record<Exclude<PlanDraftOutcome, "decided">, string>> = {
  week_budget: "The coach didn't draft it: this week's AI budget was spent.",
  no_proposal: "The coach's draft ended without a suggestion.",
};

export interface PlanPrompt {
  kind: "whats_next" | "draft_ready";
  label: string;
  request: string;
  /** What happened to the plan's draft, in plain words, when it came to nothing; null otherwise. */
  note: string | null;
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
    const label = `Next stretch ready for ${it}`;
    return { kind: "draft_ready", label, request: `${label}.`, note: null };
  }
  const last = plan.lastSessionDate;
  if (last === null || !isLocalDate(last) || last > addDays(today, PLAN_PROMPT_DAYS)) return null;
  // The tail after the end is for a plan that asks: a plan that continues on its own has nothing to ask once it has run
  // out (its sheet says "Continues on its own"), so it prompts only while its last day is today or ahead (ruling R8).
  if (last < addDays(today, plan.onEnd === "ask" ? -PLAN_PROMPT_DAYS : 0)) return null;
  // A coach plan that continues, with drafts on: nothing to ask while its draft is due or at work; held back, or over
  // without a proposal waiting, the question — once over, with what happened.
  const draft = plan.kind === "coach" && plan.onEnd === "continue" ? plan.draft : undefined;
  if (draft && (draft.kind === "due" || draft.kind === "live")) return null;
  const note = draft?.kind === "over" && draft.outcome !== "decided" ? PLAN_DRAFT_NOTES[draft.outcome] : null;
  const label = `Plan what comes after ${it}`;
  const days = daysBetween(today, last);
  // A plan that has run out stays available, quietly: nothing is marked missed and nothing scolds (spec §4.1).
  const request = `${label} — it ${days < 0 ? `ended ${ago(-days)}` : `ends ${inDays(days)}`}.`;
  return { kind: "whats_next", label, request: note ? `${request} ${note}` : request, note };
}
