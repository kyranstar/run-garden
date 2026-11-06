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

/**
 * ONE CARD, NEVER TWO: a plan change in the same suggestion as a whole plan (a new goal updates the brief with the next
 * phase) rides on the plan's card — the server's card names every op in `opIds`, and its one Approve and Not now decide them
 * all. A split pair once left one half approved and the other never seen. The ops a card decides: its `opIds`, else the one.
 */
export const cardOpIds = (card: { opIds?: readonly string[] }, own: string): string[] => (card.opIds && card.opIds.length > 0 ? [...card.opIds] : [own]);

/** The plan changes a plan's merged card decides: the suggestion's lines its `opIds` name (none on a plan alone). */
export function mergedPlanChanges(planChanges: readonly DesignPlanChangeLineDto[] | undefined, opIds: readonly string[] | undefined): DesignPlanChangeLineDto[] {
  return (planChanges ?? []).filter((g) => (opIds ?? []).includes(g.opId));
}

/** What a merged card reads of an op's line. */
interface FoldLine {
  lines: ReadonlyArray<unknown>;
  issues: Array<{ code: string; message: string }>;
  outcome: { status: string; why?: string } | null;
}

/** "Added to your plan; the change to its details couldn't be saved: its settings changed since this was suggested." */
export function landedButWords(done: string, why: string | undefined): string {
  const reason = (why ?? "").trim().replace(/:\s*ask the coach again\.?$/i, "").replace(/\.$/, "");
  const lower = reason ? `${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : "";
  return `${done}; the change to its details couldn't be saved${lower ? `: ${lower}` : ""}.`;
}

/**
 * The plan's line with its plan changes folded in: their lines after its own, their notes with its; and ONE outcome for
 * the card — the plan's while it is being added or when every op ended the same way, the first refusal's when one was
 * refused (its words are the athlete's to read), and none while any op is still the athlete's to decide, so the card keeps its
 * buttons for what remains. With no change to fold, the plan's line as it is.
 */
export function foldPlanChanges<P extends FoldLine, C extends FoldLine>(plan: P | null, changes: readonly C[], plansDone = "Added to your plan"): P | null {
  if (!plan || changes.length === 0) return plan;
  const outcomes = [plan.outcome, ...changes.map((c) => c.outcome)];
  const status = (o: { status: string } | null) => o?.status ?? "open";
  let outcome: P["outcome"];
  const refusedChange = changes.find((c) => c.outcome?.status === "refused")?.outcome;
  if (plan.outcome?.status === "applying") outcome = plan.outcome;
  // The plan landed and its change did not: say both, so the card never reads as if nothing was added.
  else if (plan.outcome?.status === "applied" && refusedChange) outcome = { ...refusedChange, why: landedButWords(plansDone, refusedChange.why) } as P["outcome"];
  else if (outcomes.some((o) => o?.status === "refused")) outcome = outcomes.find((o) => o?.status === "refused") as P["outcome"];
  else if (outcomes.every((o) => status(o) === status(plan.outcome))) outcome = plan.outcome;
  else outcome = null;
  return { ...plan, lines: [...plan.lines, ...changes.flatMap((c) => c.lines)], issues: [...plan.issues, ...changes.flatMap((c) => c.issues)], outcome };
}

/** A card's own line among the suggestion's plan changes: the one its op names; with no op named, the first. */
export function ownPlanChange(planChanges: readonly DesignPlanChangeLineDto[] | undefined, opId: string | undefined): DesignPlanChangeLineDto | null {
  return planChanges?.find((g) => g.opId === opId) ?? (opId ? null : (planChanges?.[0] ?? null));
}
