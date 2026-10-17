/**
 * THE THREAD COACH'S CARDS ON THE PLAN (the new shape, 2026-10-17). The Plan's floating coach window and its pill are
 * gone — the coach's chat is the one conversation now, opened from the nav — but what the thread coach still puts on
 * the Plan by itself stays there, in the page:
 *
 *  - its pending suggestions, each the card it always was (`ProposalCard`, with its `proposal-<id>` anchor, so a tap on
 *    its ghost in the week scrolls to it and flashes it);
 *  - its open question, with the tappable answers and ✕.
 *
 * No box to type in. Nothing pending and no question: nothing drawn, no heading over an empty space.
 *
 * Takes the window's panel's props (`coachPanelProps` in plan.tsx), so the Plan hands it the same object.
 */
import { useId } from "react";
import type { CoachProposalDto, CoachQuestionDto } from "@rg/api-client";
import type { PlannedRef } from "@rg/domain";
import { CoachQuestionRow, ProposalCard } from "./coach-panel.js";

/** The heading over the cards. */
export const THREAD_COACH_HEADING = "From your coach";

export interface ThreadCoachCardsProps {
  proposals: CoachProposalDto[];
  question: CoachQuestionDto | null;
  busy?: boolean;
  /** An approve or decline is in flight: every card's buttons wait. */
  acting?: boolean;
  /** proposal id → why its last approve or decline failed. */
  proposalErrors?: Record<string, string>;
  /** workoutId → what the plan holds there, so a card's lines can name their day. */
  planned?: ReadonlyMap<string, PlannedRef>;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
}

export function ThreadCoachCards({
  proposals,
  question,
  busy,
  acting,
  proposalErrors,
  planned,
  onApprove,
  onDecline,
  onAnswer,
  onDismiss,
}: ThreadCoachCardsProps) {
  const headingId = useId();
  if (proposals.length === 0 && !question) return null;
  return (
    <section className="thread-coach-cards" aria-labelledby={headingId}>
      <h2 id={headingId} className="eyebrow">
        {THREAD_COACH_HEADING}
      </h2>
      {question ? <CoachQuestionRow question={question} onAnswer={onAnswer} onDismiss={onDismiss} busy={busy} /> : null}
      {proposals.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          onApprove={onApprove}
          onDecline={onDecline}
          busy={busy}
          acting={acting}
          error={proposalErrors?.[p.id]}
          planned={planned}
        />
      ))}
    </section>
  );
}
