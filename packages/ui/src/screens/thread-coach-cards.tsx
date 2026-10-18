/**
 * THE THREAD COACH'S CARDS ON THE PLAN (the new shape, 2026-10-17). The Plan's floating coach window and its pill are
 * gone — the coach is one conversation, opened from the nav — but what the thread coach still puts on the Plan by
 * itself stays there, in the page:
 *
 *  - its pending suggestions, each the card it always was (`ProposalCard`, with its `proposal-<id>` anchor, so a tap on
 *    its ghost in the week scrolls to it and flashes it);
 *  - its open question, with the tappable answers and ✕;
 *  - and what it has to say when it can't: its AI account out of credits (one line, with Retry — never while a wake is
 *    running), and the last wake's lost work, in its own words ("… Nothing was applied. Ask again …");
 *  - and its reply in words, when it answers the athlete's request (Extend, Wind down) with no suggestion: its newest
 *    message after that request, one quiet paragraph, clipped at a sentence to about 600 characters.
 *
 * No box to type in. Nothing to show: nothing drawn, no heading over an empty space.
 *
 * Takes the window's panel's props (`coachPanelProps` in plan.tsx), so the Plan hands it the same object, and the
 * lines' own.
 */
import { useId } from "react";
import type { CoachProposalDto, CoachQuestionDto } from "@rg/api-client";
import type { PlannedRef } from "@rg/domain";
import { OUT_OF_CREDITS_LINE } from "../ai-credits.js";
import { CoachQuestionRow, ProposalCard } from "./coach-panel.js";

/** The heading over the cards. */
export const THREAD_COACH_HEADING = "From your coach";

/** The reply's length at most: it is clipped at a sentence to about this. */
export const REPLY_MAX_CHARS = 600;

/**
 * The thread coach's words as one plain paragraph of at most `max` characters: its spacing and lines run together, and
 * a longer one is cut after its last sentence that fits — or, with none far enough in, at a word, with "…".
 */
export function clipReply(text: string, max = REPLY_MAX_CHARS): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  let end = 0;
  // A sentence's end: . ! or ?, any closing quote or bracket, then a space (or the end).
  for (const m of plain.matchAll(/[.!?]["'”’)\]]*(?= |$)/g)) {
    const at = m.index + m[0].length;
    if (at > max) break;
    end = at;
  }
  // Far enough in to say something: else a cut at a word reads better than one short sentence.
  if (end >= max * 0.4) return plain.slice(0, end);
  const space = plain.lastIndexOf(" ", max - 1);
  return `${plain.slice(0, space > 0 ? space : max - 1)}…`;
}

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
  /** The thread coach's AI account is out of credits: one line — unless a wake is running (`busy`), which may find
   * them back. */
  outOfCredits?: boolean;
  /** Ask the thread coach again (its check-in): the out-of-credits line's Retry. */
  onRetry?: () => void;
  /** The last wake's lost work, in its own words ("… Nothing was applied. Ask again …"); none, or blank: no line. */
  nothingApplied?: string | null;
  /** The thread coach's newest message after the athlete's latest request (Extend or Wind down answered in words, not
   * a suggestion): one quiet paragraph, newest only. None, or blank: no line. */
  reply?: { text: string; at: string } | null;
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
  outOfCredits = false,
  onRetry,
  nothingApplied = null,
  reply = null,
}: ThreadCoachCardsProps) {
  const headingId = useId();
  const credits = outOfCredits && !busy;
  const lost = nothingApplied?.trim() || null;
  const said = clipReply(reply?.text ?? "");
  if (proposals.length === 0 && !question && !credits && !lost && !said) return null;
  return (
    <section className="thread-coach-cards" aria-labelledby={headingId}>
      <h2 id={headingId} className="eyebrow">
        {THREAD_COACH_HEADING}
      </h2>
      {credits ? (
        <div className="ai-credits ai-credits-note thread-coach-note" role="status">
          <span>{OUT_OF_CREDITS_LINE}</span>
          {onRetry ? (
            <button type="button" className="btn btn-small" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {said ? (
        <p className="thread-coach-reply" role="status">
          {said}
        </p>
      ) : null}
      {lost ? (
        <p className="thread-coach-lost" role="status">
          {lost}
        </p>
      ) : null}
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
