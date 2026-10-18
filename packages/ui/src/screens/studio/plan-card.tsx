/**
 * A WHOLE PLAN, IN THE CONVERSATION (§8 §5, stream W). When the coach builds, extends, firms up, winds down or retires
 * a plan, the turn shows ONE card: a whole plan is one intention, never a checklist.
 *
 *   10K build                                  ← the plan's name, or what changes ("Extend 10K build")
 *   4 weeks · 4 sessions to start · race Sun 14 Jun
 *   · Mon 18 May · New plan: 10K build · …     ← what it holds, the coach's own lines (at most 8, "and N more")
 *   [ Approve plan ]  [ Not now ]
 *
 *  - Approve plan approves it — its own op, never the suggestion's other cards' workouts or changes — and keeps asking
 *    while the server says some remains (a plan goes on a part at a time); meanwhile the card says so ("Adding to your
 *    plan…"). Done: "Added to your plan" and a link to Plan.
 *  - A plan already part added (the app closed half way) says so and offers to finish ("Finish adding"); it is never
 *    declined half made, so Not now goes.
 *  - Not now declines it (its own op). What came of it otherwise in one plain line: not added, replaced, its day passed.
 *  - An older turn's card that is closed: one line of what came of it, its lines one tap down.
 *
 * Its state is the suggestion's own read (`GET /api/coach/proposals/:id`, the `plans` part), shared with the other
 * cards under one query key. Every text the coach wrote is data: rendered as text.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachConversationCardDto, type DesignApproveRequest, type DesignApproveResponse, type DesignPlanLineDto } from "@rg/api-client";
import { CONVERSATION_QUERY } from "./coach-conversation-model.js";
import { readProposal } from "./coach-tolerance.js";
import { designProposalQuery } from "./proposal-card.js";
import { COACH_CURRENT_QUERY } from "./run-keeper.js";
import { useOneTap } from "./use-one-tap.js";

/** The most approves one tap asks: a plan of forty sessions takes a handful; past this, the card asks for another tap. */
export const PLAN_APPROVE_ROUNDS_MAX = 40;
export const PLAN_ADDED = "Added to your plan";
export const PLAN_ADDING = "Adding to your plan…";
export const PLAN_PART_ADDED = "Part of it is on your plan already.";
export const PLAN_COULDNT = "Couldn't reach the coach — try again.";
/** A plan change's op id (the worker's `PLAN_STRUCTURE_ID`): the card's own when its read hasn't said yet. */
export const PLAN_OP_ID = "plan";

/** Approve the plan's own ops (`opIds`, never `{}`: the suggestion may hold other cards' workouts and changes) until
 * nothing remains: every answer, in order. A write that met another (409 `proposal_changed`) is read again and asked once
 * more; one being applied elsewhere (409 `in_flight`) ends it, as an answer that names it. Past PLAN_APPROVE_ROUNDS_MAX:
 * "approve_unfinished". */
export async function approvePlanUntilDone(
  approve: (body: DesignApproveRequest) => Promise<DesignApproveResponse>,
  reread: () => Promise<unknown>,
  opIds: readonly string[],
  rounds = PLAN_APPROVE_ROUNDS_MAX,
): Promise<DesignApproveResponse[]> {
  const answers: DesignApproveResponse[] = [];
  let body: DesignApproveRequest = { opIds: [...opIds] };
  let retried = 0;
  for (let i = 0; i < rounds; i++) {
    let res: DesignApproveResponse;
    try {
      res = await approve(body);
    } catch (e) {
      const error = e instanceof ApiError && e.status === 409 ? (e.body as { error?: unknown; opIds?: unknown; status?: unknown } | null) : null;
      if (error?.error === "proposal_changed" && retried < 2) {
        retried += 1;
        await reread();
        continue;
      }
      if (error?.error === "in_flight" && Array.isArray(error.opIds)) {
        const status = typeof error.status === "string" ? (error.status as DesignApproveResponse["status"]) : "pending";
        answers.push({ ok: true, status, applied: [], changed: [], refused: [], settled: [], remaining: [], inFlight: error.opIds.filter((x): x is string => typeof x === "string") });
        return answers;
      }
      throw e;
    }
    answers.push(res);
    if (res.remaining.length === 0) return answers;
    body = { opIds: res.remaining };
  }
  throw new Error("approve_unfinished");
}

/** What came of a plan, in one line — or null while it is the athlete's to decide. */
export function planOutcomeLine(status: string, plan: DesignPlanLineDto | null): string | null {
  const o = plan?.outcome ?? null;
  if (o?.status === "applied" || status === "approved") return PLAN_ADDED;
  if (o?.status === "refused") return o.why || "It couldn't be added.";
  if (o?.status === "declined" || status === "declined") return "Not added";
  if (o?.status === "superseded" || status === "superseded") return "Replaced by a newer plan";
  if (status === "expired") return "Its day passed";
  if (status === "pending" || status === "partially_approved") return null;
  return status.replace(/[_-]+/g, " ").trim() || null;
}

type PlanCardInput = Pick<CoachConversationCardDto, "proposalId" | "title" | "summary" | "status" | "lines">;

export function PlanCard({ card, closed = false }: { card: PlanCardInput; closed?: boolean }) {
  const qc = useQueryClient();
  const headingId = useId();
  const linesId = useId();
  const oneTap = useOneTap();
  const read = useQuery({ queryKey: designProposalQuery(card.proposalId), queryFn: () => readProposal(card.proposalId), retry: false });
  const plan = read.data?.plans?.[0] ?? null;
  /** The card's own op: what its buttons approve and decline, nothing else of the suggestion. */
  const own = [plan?.opId ?? PLAN_OP_ID];
  const status = read.data?.status ?? card.status;
  const reread = () => qc.invalidateQueries({ queryKey: designProposalQuery(card.proposalId) });
  const after = async () => {
    await reread();
    for (const key of ["plan", "plan-week", "today", "coach-state", "coach-plans", "garden"]) void qc.invalidateQueries({ queryKey: [key] });
    void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    void qc.invalidateQueries({ queryKey: CONVERSATION_QUERY });
  };
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const approve = useMutation({
    networkMode: "always",
    mutationFn: () => approvePlanUntilDone((body) => api.coachDesignApprove(card.proposalId, body), reread, own),
    onSuccess: (answers) => setBusyLine(answers.some((a) => (a.inFlight ?? []).length > 0) ? "It's being added right now — look again in a moment." : null),
    onSettled: after,
  });
  const decline = useMutation({
    networkMode: "always",
    mutationFn: () => api.coachDesignDecline(card.proposalId, { opIds: own }),
    onSettled: after,
  });
  // Once decided, the focus goes to what came of it (the buttons it was pressed on are gone).
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const [toOutcome, setToOutcome] = useState(false);
  useEffect(() => {
    if (!toOutcome || !outcomeRef.current) return;
    outcomeRef.current.focus();
    setToOutcome(false);
  });
  const [open, setOpen] = useState(false);

  const outcome = planOutcomeLine(status, plan);
  const started = plan?.outcome?.status === "applying";
  const decidable = outcome === null && (status === "pending" || status === "partially_approved");
  const lines = card.lines && card.lines.length > 0 ? card.lines : (plan?.lines ?? []);
  const working = approve.isPending;

  if (closed) {
    return (
      <div className="coach-card-closed">
        <p className="coach-card-closed-line">
          {[card.title, card.summary.trim() || null].filter(Boolean).join(" · ")} — {outcome ?? (started ? "Part added" : "Open")}{" "}
          <button type="button" className="linklike tap-pad" aria-expanded={open} aria-controls={linesId} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"}
          </button>
        </p>
        <ul id={linesId} className="coach-plan-lines" hidden={!open}>
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <section className="coach-changes coach-plan" aria-labelledby={headingId}>
      <h3 id={headingId} className="coach-changes-title">
        {card.title}
      </h3>
      {card.summary ? <p className="coach-changes-summary">{card.summary}</p> : null}
      {lines.length > 0 ? (
        <ul className="coach-plan-lines">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      {plan && plan.issues.length > 0 && decidable ? (
        <ul className="coach-plan-notes">
          {plan.issues.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      ) : null}
      {working ? (
        <p className="coach-changes-outcome" role="status">
          {PLAN_ADDING}
        </p>
      ) : outcome !== null ? (
        <p ref={outcomeRef} className="coach-changes-outcome" role="status" tabIndex={-1}>
          {outcome === PLAN_ADDED ? `✓ ${PLAN_ADDED}` : outcome}
          {outcome === PLAN_ADDED ? (
            <>
              {" "}
              <Link className="linklike tap-pad" to="/plan">
                See it on Plan
              </Link>
            </>
          ) : null}
        </p>
      ) : started ? (
        <p className="coach-changes-outcome" role="status">
          {PLAN_PART_ADDED}
        </p>
      ) : null}
      {busyLine && !working ? (
        <p className="coach-changes-outcome" role="status">
          {busyLine}
        </p>
      ) : null}
      {approve.isError || decline.isError ? (
        <p className="coach-pc-error" role="status">
          {approve.error instanceof Error && approve.error.message === "approve_unfinished" ? "Not all of it was added yet — tap again to finish." : PLAN_COULDNT}
        </p>
      ) : null}
      {decidable ? (
        <div className="btn-row coach-changes-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={working || decline.isPending || !read.data}
            onClick={() => oneTap(() => approve.mutateAsync().then(() => setToOutcome(true)))}
          >
            {started ? "Finish adding" : "Approve plan"}
          </button>
          {started ? null : (
            <button type="button" className="btn" disabled={working || decline.isPending || !read.data} onClick={() => oneTap(() => decline.mutateAsync().then(() => setToOutcome(true)))}>
              Not now
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
