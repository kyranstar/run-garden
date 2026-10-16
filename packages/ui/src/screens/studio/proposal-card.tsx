/**
 * A DESIGNED SUGGESTION'S CARD (Stage 3 spec §8, §10; Task 9): what the coach suggests — new or revised workouts, and
 * changes to sessions already on the plan (Task 8b) — read from the server's manifest (`GET /api/coach/proposals/:id`:
 * computed from the documents, never from prose), decided workout by workout.
 *
 *  - Each workout: its title; its day and time, minutes, effort word, place and review mean; one tap opens its review
 *    (each dimension's score and note, what changed between drafts) and the validator's costs for the day. Edit opens
 *    the draft in the builder (Task 8's route): saving it there approves the athlete's version.
 *  - Each change: its own plain line ("Tue: Strength — skipped — why"), its own checkbox, no Edit.
 *  - With more than one to decide, each has a checkbox, all chosen at first. Approve sends the chosen ones (none named:
 *    all) and asks again while the server says some `remaining` — at most APPROVE_ROUNDS_MAX times — once more after a
 *    409 `proposal_changed`, the suggestion read again first. Decline takes an optional reason (the athlete's words).
 *  - What is still open is read from each line's own outcome, never from the suggestion's status: an applied workout says
 *    where it went ("On your plan for Thu 6 PM", a link to that day on the Plan); a refused one why, in plain words
 *    (its code's words; the server's why, as text, where it adds to them).
 *  - A stop's note (the suggestion's flags) heads the card: what was reviewed before the coach stopped.
 *
 * The server books the calendar after the last approve (Task 9) and the api client drains the watch writes a change
 * queued (`coachDrain`). No internal words: "suggestion", "workout", "plan".
 */
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type DesignApproveRequest,
  type DesignApproveResponse,
  type DesignChangeLineDto,
  type DesignLineDto,
} from "@rg/api-client";
import { editDraftHref } from "./build-model.js";
import { dayAndTime, planDayHref, refusedLine } from "./run-model.js";

/** A designed suggestion's read. */
export const designProposalQuery = (id: string) => ["coach-design-proposal", id] as const;

/** Approve requests one tap may make: a week's seven workouts and its changes take at most six (Task 8b), doubled. */
export const APPROVE_ROUNDS_MAX = 12;

/** The suggestion is the athlete's in these; never shown in the others (closed with its run, or never theirs). */
const HIDDEN_STATUSES = new Set(["unreviewed", "cancelled", "rehearsal"]);

type Outcome = DesignLineDto["outcome"] | DesignChangeLineDto["outcome"];
/**
 * Still the athlete's to decide: no outcome; refused (it stays open: the day can change); or a change an approve is
 * applying (Task 8b: claimed, in flight — Approve asked again finishes it; it can't be declined).
 */
export const isOpen = (o: Outcome): boolean => o === null || o.status === "refused" || o.status === "applying";

/** A change an approve is applying can't be declined: said by the ops a decline named. */
export const IN_FLIGHT_LINE = "Already being added — it can't be declined now.";

/**
 * Approve the chosen ops (none named: all) until nothing remains: each answer's `remaining` asked for again; a 409
 * `proposal_changed` (another request wrote first) once more after `reread`. Answers every answer, in order.
 */
export async function approveUntilDone(
  approve: (body: DesignApproveRequest) => Promise<DesignApproveResponse>,
  opIds: readonly string[] | undefined,
  reread: () => Promise<unknown>,
): Promise<DesignApproveResponse[]> {
  const answers: DesignApproveResponse[] = [];
  let body: DesignApproveRequest = opIds ? { opIds: [...opIds] } : {};
  let retried = false;
  for (let i = 0; i < APPROVE_ROUNDS_MAX; i++) {
    let res: DesignApproveResponse;
    try {
      res = await approve(body);
    } catch (e) {
      if (!retried && e instanceof ApiError && e.status === 409 && (e.body as { error?: unknown } | null)?.error === "proposal_changed") {
        retried = true;
        await reread();
        continue;
      }
      throw e;
    }
    answers.push(res);
    if (res.remaining.length === 0) return answers;
    body = { opIds: res.remaining };
  }
  throw new Error("approve_unfinished");
}

/** What went wrong with an approve or a decline, in plain words. */
function decisionError(e: unknown): string {
  if (e instanceof ApiError) {
    const error = (e.body as { error?: unknown } | null)?.error;
    if (error === "not_pending" || error === "not_yet") return "This suggestion isn't open any more.";
    if (error === "in_flight") return "One of these is being added right now — look again in a moment.";
    if (error === "proposal_changed") return "This suggestion changed meanwhile — look again and try once more.";
  }
  if (e instanceof Error && e.message === "approve_unfinished") return "Not everything was added yet — try again.";
  return "Couldn't reach the coach — try again.";
}

export function ProposalCard({ proposalId, flags = [] }: { proposalId: string; flags?: readonly string[] }) {
  const qc = useQueryClient();
  const headingId = useId();
  const read = useQuery({ queryKey: designProposalQuery(proposalId), queryFn: () => api.coachProposal(proposalId), retry: false });
  /** The athlete's choice; null: every open one (the default). */
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  /** Changes a decline met in flight (an approve is applying them): never declined, said on their lines. */
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const reread = () => qc.invalidateQueries({ queryKey: designProposalQuery(proposalId) });
  const afterDecision = async () => {
    setChosen(null);
    await reread();
    for (const key of ["plan", "plan-week", "today", "coach-state"]) void qc.invalidateQueries({ queryKey: [key] });
  };
  const approve = useMutation({
    mutationFn: (opIds: string[] | undefined) => {
      setInFlight(new Set());
      return approveUntilDone((body) => api.coachDesignApprove(proposalId, body), opIds, reread);
    },
    onSettled: afterDecision,
  });
  const decline = useMutation({
    mutationFn: (v: { opIds: string[] | undefined; reason: string }) =>
      api.coachDesignDecline(proposalId, { ...(v.opIds ? { opIds: v.opIds } : {}), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) }),
    onSuccess: (res) => {
      setDeclining(false);
      setReason("");
      setInFlight(new Set(res.inFlight ?? []));
    },
    onError: (e) => {
      // Every one named was in flight: nothing declined (409 in_flight, naming them).
      const opIds = e instanceof ApiError ? (e.body as { error?: unknown; opIds?: unknown } | null) : null;
      if (opIds?.error === "in_flight" && Array.isArray(opIds.opIds)) setInFlight(new Set(opIds.opIds.filter((x): x is string => typeof x === "string")));
    },
    onSettled: afterDecision,
  });

  const data = read.data;
  if (!data || HIDDEN_STATUSES.has(data.status)) return null;
  const lines = data.lines ?? [];
  const changes = data.changes ?? [];
  if (lines.length === 0 && changes.length === 0) return null;
  // In the card's order: the changes first (the server applies them first too), then the workouts.
  const openIds = [...changes.filter((c) => isOpen(c.outcome)).map((c) => c.opId), ...lines.filter((l) => isOpen(l.outcome)).map((l) => l.opId)];
  // The suggestion as the server holds it: closed whole (expired, or every one decided) when nothing is open in a status
  // the athlete still decides in.
  const decidable = (data.status === "pending" || data.status === "partially_approved") && openIds.length > 0;
  const picking = decidable && openIds.length > 1;
  const picked = chosen === null ? openIds : openIds.filter((id) => chosen.has(id));
  const toggle = (opId: string) => setChosen(new Set(picked.includes(opId) ? picked.filter((x) => x !== opId) : [...picked, opId]));
  const busy = approve.isPending || decline.isPending;
  const some = picked.length < openIds.length ? picked : undefined;
  // A decline that met every one in flight says so on their lines, not here.
  const error = approve.isError ? decisionError(approve.error) : decline.isError && inFlight.size === 0 ? decisionError(decline.error) : null;
  return (
    <section className="coach-pc" aria-labelledby={headingId}>
      <h2 id={headingId} className="coach-pc-title-h">
        The coach suggests
      </h2>
      {flags.map((f, i) => (
        <p key={i} className="coach-pc-flag">
          {f}
        </p>
      ))}
      {data.status === "expired" ? <p className="coach-pc-flag">This suggestion's day has passed.</p> : null}
      <ul className="coach-pc-list">
        {changes.map((c) => (
          <ChangeItem
            key={c.opId}
            line={c}
            picking={picking && isOpen(c.outcome)}
            checked={picked.includes(c.opId)}
            onToggle={() => toggle(c.opId)}
            busy={busy}
            inFlight={inFlight.has(c.opId)}
          />
        ))}
        {lines.map((l) => (
          <WorkoutItem
            key={l.opId}
            proposalId={proposalId}
            line={l}
            editable={decidable && isOpen(l.outcome)}
            picking={picking && isOpen(l.outcome)}
            checked={picked.includes(l.opId)}
            onToggle={() => toggle(l.opId)}
            busy={busy}
          />
        ))}
      </ul>
      {error ? (
        <p className="coach-pc-error" role="status">
          {error}
        </p>
      ) : null}
      {decidable ? (
        declining ? (
          <div className="coach-pc-decline">
            <label className="coach-pc-label" htmlFor={`${headingId}-why`}>
              Why not? (optional)
            </label>
            <textarea
              id={`${headingId}-why`}
              className="stu-field"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy || picked.length === 0} onClick={() => decline.mutate({ opIds: some, reason })}>
                Decline
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setDeclining(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="btn-row coach-pc-actions">
            <button type="button" className="btn btn-primary" disabled={busy || picked.length === 0} onClick={() => approve.mutate(some)}>
              {some ? `Approve ${some.length}` : "Approve"}
            </button>
            <button type="button" className="btn" disabled={busy || picked.length === 0} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}

function Pick({ label, checked, onToggle, busy }: { label: string; checked: boolean; onToggle: () => void; busy: boolean }) {
  return (
    <label className="coach-pc-pick">
      <input type="checkbox" checked={checked} disabled={busy} onChange={onToggle} />
      <span className="visually-hidden">{label}</span>
    </label>
  );
}

/** How a decided line ended, in plain words; the open ones, nothing. */
function OutcomeLine({ outcome, applied }: { outcome: Outcome; applied: { date: string; time: string | null; workoutId: string; edited?: boolean } | null }) {
  if (!outcome) return null;
  switch (outcome.status) {
    case "applied":
      return applied ? (
        <p className="coach-pc-outcome coach-pc-outcome--done">
          <span aria-hidden="true">✓ </span>
          <Link to={planDayHref(applied.workoutId, applied.date)}>On your plan for {dayAndTime(applied.date, applied.time)}</Link>
          {applied.edited ? " · your version" : null}
        </p>
      ) : (
        <p className="coach-pc-outcome coach-pc-outcome--done">
          <span aria-hidden="true">✓ </span>Done
        </p>
      );
    case "refused": {
      const r = refusedLine(outcome);
      return (
        <p className="coach-pc-outcome coach-pc-outcome--refused">
          <span aria-hidden="true">! </span>
          Not added: {r.lead}
          {r.detail ? <span className="coach-pc-why"> {r.detail}</span> : null}
        </p>
      );
    }
    case "declined":
      return <p className="coach-pc-outcome">Not added</p>;
    case "superseded":
      return <p className="coach-pc-outcome">Replaced by a newer suggestion</p>;
    case "applying":
      return <p className="coach-pc-outcome">Being added</p>;
  }
}

function WorkoutItem({
  proposalId,
  line,
  editable,
  picking,
  checked,
  onToggle,
  busy,
}: {
  proposalId: string;
  line: DesignLineDto;
  editable: boolean;
  picking: boolean;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const facts = [
    dayAndTime(line.date, line.time),
    `${line.minutes} min`,
    line.effort,
    line.place,
    line.reviewMean !== null ? `Review ${line.reviewMean.toFixed(1)}` : null,
  ].filter((x): x is string => !!x);
  const applied =
    line.outcome?.status === "applied"
      ? { date: line.written?.date ?? line.date, time: line.written?.time ?? line.time, workoutId: line.outcome.workoutId, edited: line.written?.edited }
      : null;
  return (
    <li className="coach-pc-item">
      {picking ? <Pick label={`Include ${line.title}`} checked={checked} onToggle={onToggle} busy={busy} /> : null}
      <div className="coach-pc-main">
        <button type="button" className="coach-pc-name" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
          {line.title}
        </button>
        <p className="coach-pc-facts">{facts.join(" · ")}</p>
        <OutcomeLine outcome={line.outcome} applied={applied} />
        {editable ? (
          <Link className="linklike coach-pc-edit tap-pad" to={editDraftHref(proposalId, line.opId)}>
            Edit
          </Link>
        ) : null}
        <div id={detailId} className="coach-pc-detail" hidden={!open}>
          {line.parts.length > 0 ? <p className="coach-pc-parts">{line.parts.join(" · ")}</p> : null}
          {line.detail.length > 0 ? (
            <ul className="coach-pc-moves">
              {line.detail.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
          <ReviewDetail line={line} />
        </div>
      </div>
    </li>
  );
}

function ReviewDetail({ line }: { line: DesignLineDto }) {
  const r = line.review;
  return (
    <>
      {r ? (
        <div className="coach-detail">
          <h3 className="coach-detail-title">Review</h3>
          {r.note ? <p className="coach-pc-note">{r.note}</p> : null}
          {r.dimensions.length > 0 ? (
            <dl className="coach-detail-rows">
              {r.dimensions.map((d) => (
                <div key={d.id} className="coach-detail-row">
                  <dt>{d.label}</dt>
                  <dd>
                    {d.score !== null ? `${d.score} of 5` : "—"}
                    {d.note ? ` · ${d.note}` : ""}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {([
            ["What changed", r.changes],
            ["Must fix", r.mustFix],
            ["Could be better", r.improvements],
            ["Kept as you asked", r.accepted],
          ] as const).map(([title, items]) =>
            items.length > 0 ? (
              <div key={title} className="coach-pc-sub">
                <h4 className="coach-detail-title">{title}</h4>
                <ul>
                  {items.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
      {line.issues.length > 0 ? (
        <div className="coach-detail">
          <h3 className="coach-detail-title">Worth knowing</h3>
          <ul>
            {line.issues.map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ChangeItem({
  line,
  picking,
  checked,
  onToggle,
  busy,
  inFlight,
}: {
  line: DesignChangeLineDto;
  picking: boolean;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  /** A decline met it in flight: it can't be declined now. */
  inFlight: boolean;
}) {
  const day = line.date ? dayAndTime(line.date, line.time) : null;
  const text = [day ? `${day}: ${line.summary}` : line.summary, line.was ? `was ${line.was}` : null, line.effect].filter(Boolean).join(" · ");
  const before = line.outcome?.status === "applied" ? line.outcome.before : null;
  return (
    <li className="coach-pc-item coach-pc-item--change">
      {picking ? <Pick label={`Include: ${line.summary}`} checked={checked} onToggle={onToggle} busy={busy} /> : null}
      <div className="coach-pc-main">
        <p className="coach-pc-change">
          {text}
          {line.why ? <span className="coach-pc-why"> — {line.why}</span> : null}
        </p>
        {before ? (
          <p className="coach-pc-outcome coach-pc-outcome--done">
            <span aria-hidden="true">✓ </span>
            Done · it was {dayAndTime(before.date, before.time)}
            {before.minutes !== null ? `, ${before.minutes} min` : ""}
          </p>
        ) : (
          <OutcomeLine outcome={line.outcome} applied={null} />
        )}
        {inFlight ? <p className="coach-pc-outcome coach-pc-outcome--refused">{IN_FLIGHT_LINE}</p> : null}
        {(line.issues ?? []).map((i, k) => (
          <p key={k} className="coach-pc-note">
            {i.message}
          </p>
        ))}
      </div>
    </li>
  );
}
