/**
 * A CHANGE TO A PLAN'S PURPOSE, BRIEF, ENDING OR PAUSE, IN THE CONVERSATION (plans with a purpose, Stage 1): the plan
 * card's logic for the coach's `change_plan` — pure, so the card (plan-card.tsx) stays a thin view.
 *
 *   Base block: new purpose and brief          ← the plan's name and what changes
 *   Ending: Continue · paused until Wed 21 Oct ← the plan after the change
 *   · Purpose: Run a first 10K                 ← a line a changed field, in plain words (the server's)
 *   · When it ends: Ask me → Continue
 *   [ Approve ]  [ Not now ]
 *
 * Approve and Not now each decide this change's own op (`card.opId`: a suggestion may change two plans). It is one
 * short write, so it never shows as half done: "Plan updated" when it is, the server's words when it was refused
 * (`stale`: the athlete edited the plan since; a pause that has gone by), "Not changed" when declined. Its state is the
 * suggestion read's `planChanges` part, its own line by its op. Every text is data: rendered as text.
 */
import type { DesignPlanChangeLineDto } from "@rg/api-client";
import type { PlanCardWords } from "./plan-card.js";

/** A plan change's words: one write, done at once; nothing of it is on a screen of its own but the plan's sheet. */
export const PLAN_CHANGE_WORDS: PlanCardWords = {
  done: "Plan updated",
  doing: "Updating your plan…",
  part: "It was interrupted — Finish saves it.",
  inFlight: "It's being saved right now — Finish takes it on from there.",
  approve: "Approve",
  finish: "Finish",
  unfinished: "It isn't done yet — tap again.",
  declined: "Not changed",
  superseded: "Replaced by a newer change",
  refused: "It couldn't be changed.",
  link: { to: "/plan", label: "See it on Plan" },
};

/** A card's own line among the suggestion's plan changes: the one its op names; with no op named, the first. */
export function ownPlanChange(planChanges: readonly DesignPlanChangeLineDto[] | undefined, opId: string | undefined): DesignPlanChangeLineDto | null {
  return planChanges?.find((g) => g.opId === opId) ?? (opId ? null : (planChanges?.[0] ?? null));
}
