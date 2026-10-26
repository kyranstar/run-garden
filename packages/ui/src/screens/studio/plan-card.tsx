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
 *
 * A PROGRAMME CHANGE (§8 §5) is the same card in its own words (`PROGRAMME_WORDS`): "Mobility: new days", its new
 * pattern, a line a setting and where its next sessions go; Approve and Not now, each its own op (`card.opId`: a
 * suggestion may change two programmes); "Moving your sessions…" while its sessions are placed a request at a time;
 * "Programme updated" when done. Its state is the read's `programmes` part, its own line by its op.
 *
 * THE PINS (saved-posts import, Task 18) are the same card in theirs (`PINS_WORDS`): the coach's title, line and lines —
 * one a placement, one a saved move left out — Approve and Not now, its own op; "Programme's pool updated" when done,
 * with a line for each move it left (archived since, not pinned) and no link: nothing of it is on Plan. Its state is
 * the read's `pins` part, its own line by its op.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type CoachConversationCardDto,
  type DesignApproveRequest,
  type DesignApproveResponse,
  type DesignPinsLineDto,
  type DesignPlanLineDto,
  type DesignProgrammeLineDto,
} from "@rg/api-client";
import { CONVERSATION_QUERY } from "./coach-conversation-model.js";
import { readProposal } from "./coach-tolerance.js";
import { decisionError, designProposalQuery } from "./proposal-card.js";
import { COACH_CURRENT_QUERY } from "./run-keeper.js";
import { useOneTap } from "./use-one-tap.js";

/** The most approves one tap asks: a plan of forty sessions takes a handful; past this, the card asks for another tap. */
export const PLAN_APPROVE_ROUNDS_MAX = 40;
export const PLAN_ADDED = "Added to your plan";
export const PLAN_ADDING = "Adding to your plan…";
export const PLAN_PART_ADDED = "Part of it is on your plan already.";
export const PLAN_COULDNT = "Couldn't reach the coach — try again.";
/** A plan another request is adding: Finish adding goes on from where it got to. */
export const PLAN_IN_FLIGHT = "It's being added right now — Finish adding takes it on from there.";
/** A plan's note (the plan checks' words, stored as they wrote them) with its first letter a capital. */
export const noteWords = (message: string): string => message.charAt(0).toUpperCase() + message.slice(1);
/** A plan change's op id (the worker's `PLAN_STRUCTURE_ID`): the card's own when its read hasn't said yet. */
export const PLAN_OP_ID = "plan";

/** What a card of this shape says, for a whole plan or a programme change. */
export interface PlanCardWords {
  /** Done: "✓ <done>" and a link to Plan. */
  done: string;
  /** While its approves run. */
  doing: string;
  /** Part of it applied (the app closed half way), offered to finish. */
  part: string;
  /** Another request is applying it. */
  inFlight: string;
  approve: string;
  finish: string;
  /** Asked past the most rounds one tap asks. */
  unfinished: string;
  declined: string;
  superseded: string;
  /** Refused, the server's words missing. */
  refused: string;
  /** Done: where to see it ("See it on Plan"); null when nothing of it is on a screen of its own. */
  link: { to: string; label: string } | null;
}

const SEE_PLAN = { to: "/plan", label: "See it on Plan" };

export const PLAN_WORDS: PlanCardWords = {
  done: PLAN_ADDED,
  doing: PLAN_ADDING,
  part: PLAN_PART_ADDED,
  inFlight: PLAN_IN_FLIGHT,
  approve: "Approve plan",
  finish: "Finish adding",
  unfinished: "Not all of it was added yet — tap again to finish.",
  declined: "Not added",
  superseded: "Replaced by a newer plan",
  refused: "It couldn't be added.",
  link: SEE_PLAN,
};

/** A programme change's words (§8 §5): its sessions are moved, as the settings sheet's own save says. */
export const PROGRAMME_WORDS: PlanCardWords = {
  done: "Programme updated",
  doing: "Moving your sessions…",
  part: "Its settings are saved; some sessions are still to move.",
  inFlight: "It's being applied right now — Finish takes it on from there.",
  approve: "Approve",
  finish: "Finish",
  unfinished: "Not all of its sessions moved yet — tap again to finish.",
  declined: "Not changed",
  superseded: "Replaced by a newer change",
  refused: "It couldn't be changed.",
  link: SEE_PLAN,
};

/** The pins' words (saved-posts import, Task 18): one write, done at once — one an approve claimed and didn't finish (the
 * app closed) is finished by Approve; nothing of it is on Plan. A pin puts a move in the pool the programme plans from
 * (a core lift stays; other moves become eligible): it schedules nothing. */
export const PINS_WORDS: PlanCardWords = {
  done: "Programme's pool updated",
  doing: "Updating your programme's pool…",
  part: "It was interrupted — Finish saves it.",
  inFlight: "It's being saved right now — Finish takes it on from there.",
  approve: "Approve",
  finish: "Finish",
  unfinished: "It isn't done yet — tap again.",
  declined: "Not changed",
  superseded: "Replaced by a newer suggestion",
  refused: "It couldn't be saved.",
  link: null,
};

/** What the card reads of its op's line: a plan's, a programme change's or the moves in rotation's (whose applied
 * outcome has its lines: a move left). */
type CardLine = Pick<DesignPlanLineDto | DesignProgrammeLineDto | DesignPinsLineDto, "opId" | "lines" | "issues"> & {
  outcome: { status: string; why?: string; lines?: string[] } | null;
};

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

/** What came of a plan (or a programme change, in its words), in one line — or null while it is the athlete's to decide. */
export function planOutcomeLine(status: string, plan: CardLine | null, w: PlanCardWords = PLAN_WORDS): string | null {
  const o = plan?.outcome ?? null;
  if (o?.status === "applied" || status === "approved") return w.done;
  if (o?.status === "refused") return o.why || w.refused;
  if (o?.status === "declined" || status === "declined") return w.declined;
  if (o?.status === "superseded" || status === "superseded") return w.superseded;
  if (status === "expired") return "Its day passed";
  if (status === "pending" || status === "partially_approved") return null;
  return status.replace(/[_-]+/g, " ").trim() || null;
}

type PlanCardInput = Pick<CoachConversationCardDto, "proposalId" | "title" | "summary" | "status" | "lines"> &
  Partial<Pick<CoachConversationCardDto, "kind" | "opId">>;

export function PlanCard({ card, closed = false }: { card: PlanCardInput; closed?: boolean }) {
  const qc = useQueryClient();
  const headingId = useId();
  const linesId = useId();
  const oneTap = useOneTap();
  const read = useQuery({ queryKey: designProposalQuery(card.proposalId), queryFn: () => readProposal(card.proposalId), retry: false });
  const programme = card.kind === "programme";
  const pins = card.kind === "pins";
  const w = programme ? PROGRAMME_WORDS : pins ? PINS_WORDS : PLAN_WORDS;
  // A programme change's line is its own op's (a suggestion may change two programmes) — the moves in rotation's too; a
  // plan's, the suggestion's one.
  const own = <T extends { opId: string }>(xs: readonly T[] | undefined): T | null => xs?.find((g) => g.opId === card.opId) ?? (card.opId ? null : (xs?.[0] ?? null));
  const plan: CardLine | null = programme ? own(read.data?.programmes) : pins ? own(read.data?.pins) : (read.data?.plans?.[0] ?? null);
  /** The card's own op: what its buttons approve and decline, nothing else of the suggestion. */
  const opIds = [plan?.opId ?? card.opId ?? PLAN_OP_ID];
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
    mutationFn: () => approvePlanUntilDone((body) => api.coachDesignApprove(card.proposalId, body), reread, opIds),
    onSuccess: (answers) => setBusyLine(answers.some((a) => (a.inFlight ?? []).length > 0) ? w.inFlight : null),
    onSettled: after,
  });
  const decline = useMutation({
    networkMode: "always",
    mutationFn: () => api.coachDesignDecline(card.proposalId, { opIds }),
    onSettled: after,
  });
  // Once decided, the focus goes to what came of it (the buttons it was pressed on are gone).
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const [toOutcome, setToOutcome] = useState(false);
  useEffect(() => {
    if (!toOutcome) return;
    // Disarmed after every request that settles (review-3): with no outcome to show (met in flight), nothing takes the
    // focus later, when one does.
    outcomeRef.current?.focus();
    setToOutcome(false);
  });
  const [open, setOpen] = useState(false);

  const outcome = planOutcomeLine(status, plan, w);
  const started = plan?.outcome?.status === "applying";
  const decidable = outcome === null && (status === "pending" || status === "partially_approved");
  const lines = card.lines && card.lines.length > 0 ? card.lines : (plan?.lines ?? []);
  /** What the approve left (the moves in rotation's: a move archived since, an unpin of one not in rotation). */
  const left = plan?.outcome?.status === "applied" ? (plan.outcome.lines ?? []) : [];
  const working = approve.isPending;

  if (closed) {
    return (
      <div className="coach-card-closed">
        <p className="coach-card-closed-line">
          {[card.title, card.summary.trim() || null].filter(Boolean).join(" · ")} — {outcome ?? (started ? (programme ? "Part applied" : "Part added") : "Open")}{" "}
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
            <li key={k}>{noteWords(i.message)}</li>
          ))}
        </ul>
      ) : null}
      {working ? (
        <p className="coach-changes-outcome" role="status">
          {w.doing}
        </p>
      ) : outcome !== null ? (
        <p ref={outcomeRef} className="coach-changes-outcome" role="status" tabIndex={-1}>
          {outcome === w.done ? `✓ ${w.done}` : outcome}
          {outcome === w.done && w.link ? (
            <>
              {" "}
              <Link className="linklike tap-pad" to={w.link.to}>
                {w.link.label}
              </Link>
            </>
          ) : null}
        </p>
      ) : started ? (
        <p className="coach-changes-outcome" role="status">
          {w.part}
        </p>
      ) : null}
      {left.length > 0 && !working ? (
        <ul className="coach-plan-notes">
          {left.map((l, k) => (
            <li key={k}>{l}</li>
          ))}
        </ul>
      ) : null}
      {busyLine && !working ? (
        <p className="coach-changes-outcome" role="status">
          {busyLine}
        </p>
      ) : null}
      {/* What went wrong, in the cards' shared words — none beside what came of it (a suggestion gone says its outcome). */}
      {(approve.isError || decline.isError) && outcome === null ? (
        <p className="coach-pc-error" role="status">
          {decisionError(approve.error ?? decline.error, { inFlight: w.inFlight, unfinished: w.unfinished })}
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
            {started ? w.finish : w.approve}
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
