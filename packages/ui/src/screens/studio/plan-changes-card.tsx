/**
 * CHANGES TO THE PLAN, IN THE CONVERSATION (the new shape §5: "plan changes — '3 changes to your week', Approve all /
 * Look closer"). A run that changes the plan (skip, move, ease, swap, a length…) shows them as one card under its line:
 *
 *  - how many, in the server's one line ("3 changes to your week");
 *  - Approve all: every change still open, by its own id — never the run's workout beside them, which is its own card;
 *    the approve asks again while the server says some remain (`approveUntilDone`);
 *  - Look closer: each change, its own line, its own checkbox, Approve and Decline (the suggestion's card, its changes
 *    alone). After Approve all, a change the plan refused opens the closer look, where it says why.
 *  - Once nothing is open: what came of them, in one line ("✓ 3 changes made", "Left as planned").
 *
 * The suggestion's read is the card's own (`GET /api/coach/proposals/:id`), shared with the workout's card.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CoachConversationCardDto } from "@rg/api-client";
import { CONVERSATION_QUERY } from "./coach-conversation-model.js";
import { readProposal } from "./coach-tolerance.js";
import { approveUntilDone, designProposalQuery, isOpen, LEFT_AS_PLANNED, ProposalCard } from "./proposal-card.js";
import { COACH_CURRENT_QUERY } from "./run-keeper.js";
import { useOneTap } from "./use-one-tap.js";

/** What came of the changes once none is open. */
export function changesOutcome(made: number, of: number): string {
  if (made === 0) return LEFT_AS_PLANNED;
  if (made === of) return of === 1 ? "✓ 1 change made" : `✓ ${of} changes made`;
  return `✓ ${made} of ${of} changes made`;
}

export function PlanChangesCard({ card, today = null }: { card: Pick<CoachConversationCardDto, "proposalId" | "title" | "summary">; today?: string | null }) {
  const qc = useQueryClient();
  const headingId = useId();
  const closerId = useId();
  const oneTap = useOneTap();
  const [closer, setCloser] = useState(false);
  // Look closer's button goes as the changes open: the focus goes to them, never to the page.
  const closerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (closer && closerRef.current?.contains(document.activeElement) === false) closerRef.current.focus();
  }, [closer]);
  const read = useQuery({ queryKey: designProposalQuery(card.proposalId), queryFn: () => readProposal(card.proposalId), retry: false });
  // After Approve all: the focus to what came of them, once the read again says it.
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const [toOutcome, setToOutcome] = useState(false);
  useEffect(() => {
    if (!toOutcome || !outcomeRef.current) return;
    outcomeRef.current.focus();
    setToOutcome(false);
  });
  const changes = read.data?.changes ?? [];
  const openIds = changes.filter((c) => isOpen(c.outcome)).map((c) => c.opId);
  const status = read.data?.status;
  const decidable = (status === "pending" || status === "partially_approved") && openIds.length > 0;
  const reread = () => qc.invalidateQueries({ queryKey: designProposalQuery(card.proposalId) });
  const approve = useMutation({
    networkMode: "always",
    mutationFn: (ids: string[]) => approveUntilDone((body) => api.coachDesignApprove(card.proposalId, body), ids, reread),
    onSuccess: (answers) => {
      // One the plan refused says why on its own line: the closer look. Else what came of them takes the focus (the
      // button it was pressed on is gone).
      if (answers.some((a) => a.refused.length > 0)) setCloser(true);
      else setToOutcome(true);
    },
    onSettled: async () => {
      await reread();
      for (const key of ["plan", "plan-week", "today", "coach-state"]) void qc.invalidateQueries({ queryKey: [key] });
      void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
      void qc.invalidateQueries({ queryKey: CONVERSATION_QUERY });
    },
  });
  const made = changes.filter((c) => c.outcome?.status === "applied").length;
  return (
    <section className="coach-changes" aria-labelledby={headingId}>
      <h3 id={headingId} className="coach-changes-title">
        {card.title}
      </h3>
      {card.summary ? <p className="coach-changes-summary">{card.summary}</p> : null}
      {read.data && !decidable && changes.length > 0 ? (
        <p ref={outcomeRef} className="coach-changes-outcome" role="status" tabIndex={-1}>
          {changesOutcome(made, changes.length)}
        </p>
      ) : null}
      {approve.isError ? (
        <p className="coach-pc-error" role="status">
          Couldn't reach the coach — try again.
        </p>
      ) : null}
      {closer ? null : (
        <div className="btn-row coach-changes-actions">
          {decidable || !read.data ? (
            <button type="button" className="btn btn-primary" disabled={!decidable || approve.isPending} onClick={() => oneTap(() => approve.mutateAsync(openIds))}>
              Approve all
            </button>
          ) : null}
          <button type="button" className="btn" aria-expanded={false} aria-controls={closerId} disabled={!read.data} onClick={() => setCloser(true)}>
            Look closer
          </button>
        </div>
      )}
      <div id={closerId} ref={closerRef} className="coach-changes-closer" hidden={!closer} tabIndex={-1}>
        {closer ? <ProposalCard proposalId={card.proposalId} today={today} part="changes" /> : null}
      </div>
    </section>
  );
}
