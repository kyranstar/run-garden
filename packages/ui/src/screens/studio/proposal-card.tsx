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
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  DESIGN_APPLYING_STALE_MS,
  type DesignApproveRequest,
  type DesignApproveResponse,
  type DesignChangeLineDto,
  type DesignLineDto,
} from "@rg/api-client";
import { features } from "../../features.js";
import { editDraftHref } from "./build-model.js";
import { appliedChangeLine, dayAndTime, planDayHref, refusedLine, reviewLabel } from "./run-model.js";

/** What became of the suggestion once nothing in it is open (fix wave 3B, M3); while something is, what it is. */
export function cardHeader(lines: readonly Pick<DesignLineDto, "outcome">[], changes: readonly Pick<DesignChangeLineDto, "outcome">[]): string {
  const outcomes = [...changes.map((c) => c.outcome), ...lines.map((l) => l.outcome)];
  if (outcomes.length === 0 || outcomes.some(isOpen)) return "The coach suggests";
  const added = outcomes.filter((o) => o?.status === "applied").length;
  return added === outcomes.length ? "Added to your plan" : added === 0 ? "Not added" : "Some added";
}

/** A change left as it stood — refused or declined — reads as it does in the thread coach's receipts (M8). */
export const LEFT_AS_PLANNED = "Left as planned";
/** The athlete's edit of a coach's draft, wherever it shows (M8). */
export const YOUR_VERSION = "(your version)";

/** A designed suggestion's read. */
export const designProposalQuery = (id: string) => ["coach-design-proposal", id] as const;

/** Approve requests one tap may make: a week's seven workouts and its changes take at most six (Task 8b), doubled. */
export const APPROVE_ROUNDS_MAX = 12;

/** The suggestion is the athlete's in these; never shown in the others (closed with its run, or never theirs). */
const HIDDEN_STATUSES = new Set(["unreviewed", "cancelled", "rehearsal"]);

type Outcome = DesignLineDto["outcome"] | DesignChangeLineDto["outcome"];
/** Which decision met a change in flight (another approve applying it). */
type InFlightBy = "approve" | "decline";
/**
 * Still the athlete's to decide: no outcome; refused (it stays open: the day can change); or a change an approve is
 * applying (Task 8b: claimed, in flight — Approve asked again finishes it; it can't be declined).
 */
export const isOpen = (o: Outcome): boolean => o === null || o.status === "refused" || o.status === "applying";

/** A designed suggestion's read (`GET /api/coach/proposals/:id`). */
export type ProposalRead = Awaited<ReturnType<typeof api.coachProposal>>;

/**
 * Whether the card shows for this read — what "the coach proposed something" means to the Studio (fix round,
 * Important 1): a suggestion the athlete can see (not closed with its run, never theirs, or a rehearsal's) that holds a
 * workout or a change. A run whose suggestion doesn't show offers the ways to train now instead.
 */
export function cardShows(data: ProposalRead | null | undefined): boolean {
  if (!data || HIDDEN_STATUSES.has(data.status)) return false;
  return (data.lines?.length ?? 0) + (data.changes?.length ?? 0) > 0;
}

/** A change an approve is applying can't be declined: said by the ops a decline named. */
export const IN_FLIGHT_LINE = "Already being changed — it can't be declined now.";

/**
 * Approve the chosen ops (none named: all) until nothing remains: each answer's `remaining` asked for again; a 409
 * `proposal_changed` (another request wrote first) once more after `reread`; a 409 `in_flight` (every one named is being
 * applied by another approve — Task 8b) is an answer, not a failure: those ops in its `inFlight`, nothing else done.
 * Answers every answer, in order.
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
      const flying = inFlightOf(e);
      if (flying) {
        answers.push(flying);
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

/** A 409 `in_flight` read as the answer it is (nothing done, these ops being applied elsewhere); anything else, null. */
function inFlightOf(e: unknown): DesignApproveResponse | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as { error?: unknown; opIds?: unknown; status?: unknown } | null;
  if (body?.error !== "in_flight" || !Array.isArray(body.opIds)) return null;
  const status = typeof body.status === "string" ? (body.status as DesignApproveResponse["status"]) : "pending";
  const inFlight = body.opIds.filter((x): x is string => typeof x === "string");
  return { ok: true, status, applied: [], changed: [], refused: [], settled: [], remaining: [], inFlight };
}

/** What went wrong with an approve or a decline, in plain words. */
function decisionError(e: unknown): string {
  if (e instanceof ApiError) {
    const error = (e.body as { error?: unknown } | null)?.error;
    if (error === "not_pending" || error === "not_yet") return "This suggestion isn't open any more.";
    // Read as an answer wherever it names its ops (`inFlightOf`); this is one that named none.
    if (error === "in_flight") return "One of these is being changed right now — look again in a moment.";
    if (error === "proposal_changed") return "This suggestion changed meanwhile — look again and try once more.";
  }
  if (e instanceof Error && e.message === "approve_unfinished") return "Not everything was added yet — try again.";
  return "Couldn't reach the coach — try again.";
}

export function ProposalCard({ proposalId, flags = [], today = null }: { proposalId: string; flags?: readonly string[]; today?: string | null }) {
  const qc = useQueryClient();
  const headingId = useId();
  const card = useRef<HTMLElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const read = useQuery({ queryKey: designProposalQuery(proposalId), queryFn: () => api.coachProposal(proposalId), retry: false });
  /** The athlete's choice; null: every open one (the default). */
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  /**
   * After Approve, the focus goes to the outcome line of the first op it decided (fix wave 3B, B-I9) — once the
   * suggestion is read again and that line says how it ended.
   */
  const decided = useRef<string | null>(null);
  const [focusOp, setFocusOp] = useState<string | null>(null);
  useEffect(() => {
    if (!focusOp) return;
    const item = [...(card.current?.querySelectorAll<HTMLElement>("[data-op]") ?? [])].find((el) => el.dataset.op === focusOp);
    const outcome = item?.querySelector<HTMLElement>(".coach-pc-outcome");
    if (!outcome) return;
    outcome.focus();
    setFocusOp(null);
  });
  // Decline's reason field takes the focus as it opens (B-I9).
  useEffect(() => {
    if (declining) reasonField.current?.focus();
  }, [declining]);
  /**
   * Changes a decision met in flight (another approve is applying them), by the decision that met them: an approve's are
   * being changed, on the server's word; a decline's can't be declined now. Said on their lines until the next decision.
   */
  const [met, setMet] = useState<ReadonlyMap<string, InFlightBy>>(new Map());
  const meeting = (by: InFlightBy, ids: readonly string[] | undefined) => setMet(new Map((ids ?? []).map((id) => [id, by])));
  const reread = () => qc.invalidateQueries({ queryKey: designProposalQuery(proposalId) });
  const afterDecision = async () => {
    setChosen(null);
    await reread();
    for (const key of ["plan", "plan-week", "today", "coach-state"]) void qc.invalidateQueries({ queryKey: [key] });
  };
  const approve = useMutation({
    networkMode: "always",
    mutationFn: (opIds: string[] | undefined) => {
      setMet(new Map());
      decided.current = null;
      return approveUntilDone((body) => api.coachDesignApprove(proposalId, body), opIds, reread);
    },
    // Met in flight (a 200's `inFlight`, or the 409 that named every one): being changed — never failed.
    onSuccess: (answers) => {
      meeting("approve", answers.flatMap((a) => a.inFlight ?? []));
      decided.current = answers.flatMap((a) => [...a.applied.map((x) => x.opId), ...a.changed.map((x) => x.opId), ...a.refused.map((x) => x.opId)])[0] ?? null;
    },
    onSettled: async () => {
      await afterDecision();
      if (decided.current) setFocusOp(decided.current);
    },
  });
  const decline = useMutation({
    networkMode: "always",
    mutationFn: (v: { opIds: string[] | undefined; reason: string }) => {
      setMet(new Map());
      return api.coachDesignDecline(proposalId, { ...(v.opIds ? { opIds: v.opIds } : {}), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) });
    },
    onSuccess: (res) => {
      setDeclining(false);
      setReason("");
      meeting("decline", res.inFlight);
    },
    onError: (e) => {
      // Every one named was in flight: nothing declined (409 in_flight, naming them).
      const flying = inFlightOf(e);
      if (flying) meeting("decline", flying.inFlight);
    },
    onSettled: afterDecision,
  });

  const data = read.data;
  if (!data || !cardShows(data)) return null;
  const lines = data.lines ?? [];
  const changes = data.changes ?? [];
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
  const error = approve.isError ? decisionError(approve.error) : decline.isError && met.size === 0 ? decisionError(decline.error) : null;
  // By day, a set's changes among its workouts on their own day (M7); a change the server holds no day for, first.
  const items = [...changes.map((c) => ({ date: c.date ?? "", change: c, line: null })), ...lines.map((l) => ({ date: l.date, change: null, line: l }))].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return (
    <section ref={card} className="coach-pc" aria-labelledby={headingId}>
      <h2 id={headingId} className="coach-pc-title-h">
        {cardHeader(lines, changes)}
      </h2>
      {flags.map((f, i) => (
        <p key={i} className="coach-pc-flag">
          {f}
        </p>
      ))}
      {data.status === "expired" ? <p className="coach-pc-flag">This suggestion's day has passed.</p> : null}
      <ul className="coach-pc-list">
        {items.map(({ change: c, line: l }) =>
          c ? (
            <ChangeItem
              key={c.opId}
              line={c}
              picking={picking && isOpen(c.outcome)}
              checked={picked.includes(c.opId)}
              onToggle={() => toggle(c.opId)}
              busy={busy}
              inFlight={met.get(c.opId)}
            />
          ) : (
            <WorkoutItem
              key={l!.opId}
              proposalId={proposalId}
              line={l!}
              editable={decidable && isOpen(l!.outcome)}
              picking={picking && isOpen(l!.outcome)}
              checked={picked.includes(l!.opId)}
              onToggle={() => toggle(l!.opId)}
              busy={busy}
              today={today}
            />
          ),
        )}
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
              Anything the coach should know? (optional)
            </label>
            <textarea
              ref={reasonField}
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

/**
 * How a decided line ended, in plain words — a change's as a change ("Left as planned", "Being changed"); open,
 * nothing. Each can take the focus (after Approve, B-I9). A decline's reason is the athlete's words, echoed (M10).
 */
function OutcomeLine({
  outcome,
  applied,
  change = false,
}: {
  outcome: Outcome;
  applied: { date: string; time: string | null; workoutId: string; edited?: boolean } | null;
  change?: boolean;
}) {
  if (!outcome) return null;
  const not = change ? LEFT_AS_PLANNED : "Not added";
  switch (outcome.status) {
    case "applied":
      return applied ? (
        <p className="coach-pc-outcome coach-pc-outcome--done" tabIndex={-1}>
          <span aria-hidden="true">✓ </span>
          <Link to={planDayHref(applied.workoutId, applied.date)}>On your plan for {dayAndTime(applied.date, applied.time)}</Link>
          {applied.edited ? ` ${YOUR_VERSION}` : null}
        </p>
      ) : (
        <p className="coach-pc-outcome coach-pc-outcome--done" tabIndex={-1}>
          <span aria-hidden="true">✓ </span>Done
        </p>
      );
    case "refused": {
      const r = refusedLine(outcome);
      return (
        <p className="coach-pc-outcome coach-pc-outcome--refused" tabIndex={-1}>
          <span aria-hidden="true">! </span>
          {not}: {r.lead}
          {r.detail ? <span className="coach-pc-why"> {r.detail}</span> : null}
        </p>
      );
    }
    case "declined":
      return (
        <p className="coach-pc-outcome" tabIndex={-1}>
          {outcome.reason?.trim() ? `${not} · “${outcome.reason.trim()}”` : not}
        </p>
      );
    case "superseded":
      return (
        <p className="coach-pc-outcome" tabIndex={-1}>
          Replaced by a newer suggestion
        </p>
      );
    case "applying":
      // An approve's claim past its time: that approve died, and the change didn't finish (the 8b recovery).
      if (!(Date.now() - Date.parse(outcome.at) < DESIGN_APPLYING_STALE_MS)) {
        return (
          <p className="coach-pc-outcome coach-pc-outcome--refused" tabIndex={-1}>
            <span aria-hidden="true">! </span>
            Didn't finish — approve or decline
          </p>
        );
      }
      return (
        <p className="coach-pc-outcome" tabIndex={-1}>
          {change ? "Being changed" : "Being added"}
        </p>
      );
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
  today,
}: {
  proposalId: string;
  line: DesignLineDto;
  editable: boolean;
  picking: boolean;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  /** The athlete's today: a workout approved for it offers Start. */
  today: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [seeReview, setSeeReview] = useState(false);
  const detailId = useId();
  const reviewId = useId();
  const r = line.review;
  const hasReview = !!r && (r.dimensions.length > 0 || r.changes.length > 0 || r.mustFix.length > 0 || r.accepted.length > 0 || !!r.note);
  const applied =
    line.outcome?.status === "applied"
      ? { date: line.written?.date ?? line.date, time: line.written?.time ?? line.time, workoutId: line.outcome.workoutId, edited: line.written?.edited }
      : null;
  // Once applied, the plan's own figures: the athlete's version's minutes after an edit (M3).
  const minutes = applied && line.written ? line.written.minutes : line.minutes;
  const facts = [
    dayAndTime(line.date, line.time),
    `${minutes} min`,
    line.effort,
    line.place,
    line.reviewMean !== null ? `Reviewed ${line.reviewMean.toFixed(1)} of 5` : null,
  ].filter((x): x is string => !!x);
  // A workout approved for today starts as the Plan's does: its sheet, where Start is (M3).
  const startable = applied !== null && today !== null && applied.date === today && features.player;
  return (
    <li className="coach-pc-item" data-op={line.opId}>
      {picking ? <Pick label={`Include ${line.title}`} checked={checked} onToggle={onToggle} busy={busy} /> : null}
      <div className="coach-pc-main">
        <button type="button" className="coach-pc-name" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
          {line.title}
        </button>
        <p className="coach-pc-facts">{facts.join(" · ")}</p>
        <OutcomeLine outcome={line.outcome} applied={applied} />
        {/* On the card, no tap (lead's QA, Q1): a tip from the review, and the day's costs — the two alike (M1, M7). */}
        {r && r.improvements.length > 0 ? (
          <div className="coach-pc-sub">
            <h3 className="coach-detail-title">Tip</h3>
            <ul className="coach-pc-better">
              {r.improvements.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {line.issues.length > 0 ? (
          <div className="coach-pc-sub">
            <h3 className="coach-detail-title">Worth knowing</h3>
            <ul className="coach-pc-better">
              {line.issues.map((i, k) => (
                <li key={k}>{i.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="coach-pc-links">
          {startable && applied ? (
            <Link className="linklike coach-pc-start tap-pad" to={`/plan?workout=${encodeURIComponent(applied.workoutId)}`}>
              Start
            </Link>
          ) : null}
          {editable ? (
            <Link className="linklike coach-pc-edit tap-pad" to={editDraftHref(proposalId, line.opId)}>
              Edit
            </Link>
          ) : null}
          {hasReview ? (
            <button type="button" className="linklike coach-pc-see tap-pad" aria-expanded={seeReview} aria-controls={reviewId} onClick={() => setSeeReview((v) => !v)}>
              {seeReview ? "Hide" : "See the review"}
            </button>
          ) : null}
        </div>
        <div id={detailId} className="coach-pc-detail" hidden={!open}>
          {line.parts.length > 0 ? <p className="coach-pc-parts">{line.parts.join(" · ")}</p> : null}
          {line.detail.length > 0 ? (
            <ul className="coach-pc-moves">
              {line.detail.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {hasReview ? (
          <div id={reviewId} className="coach-pc-review" hidden={!seeReview}>
            <ReviewDetail review={r!} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The review, one tap down: every dimension's score and note — under its heading, in the rubric's plainer words (M2) —
 * what changed between drafts, must-fix, kept costs.
 */
function ReviewDetail({ review: r }: { review: NonNullable<DesignLineDto["review"]> }) {
  return (
    <div className="coach-detail">
      {r.note ? <p className="coach-pc-note">{r.note}</p> : null}
      {r.dimensions.length > 0 ? <h4 className="coach-detail-title">How the coach's reviewer scored it</h4> : null}
      {r.dimensions.length > 0 ? (
        <dl className="coach-detail-rows">
          {r.dimensions.map((d) => (
            <div key={d.id} className="coach-detail-row">
              <dt>{reviewLabel(d.id, d.label)}</dt>
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
  /**
   * A decision met it in flight — the server's word, whatever this device's clock makes of the claim — so, while the
   * read still has it open, it is being changed; a decline's also can't be declined now.
   */
  inFlight: InFlightBy | undefined;
}) {
  const day = line.date ? dayAndTime(line.date, line.time) : null;
  const text = [day ? `${day}: ${line.summary}` : line.summary, line.was ? `was ${line.was}` : null].filter(Boolean).join(" · ");
  // One reason line (B-I5): the coach's why; the change's own reason only when there is no why — never both stacked.
  const reason = line.why.trim() || line.effect?.trim() || null;
  const before = line.outcome?.status === "applied" ? line.outcome.before : null;
  const flying = inFlight !== undefined && isOpen(line.outcome);
  return (
    <li className="coach-pc-item coach-pc-item--change" data-op={line.opId}>
      {picking ? <Pick label={`Include: ${line.summary}`} checked={checked} onToggle={onToggle} busy={busy} /> : null}
      <div className="coach-pc-main">
        <p className="coach-pc-change">{text}</p>
        {reason ? <p className="coach-pc-why">{reason}</p> : null}
        {before ? (
          // What it did, and how the session stood (B-I5): "Skipped · was Sun 8:55 AM, 30 min".
          <p className="coach-pc-outcome coach-pc-outcome--done" tabIndex={-1}>
            <span aria-hidden="true">✓ </span>
            {appliedChangeLine(line.kind, before)}
          </p>
        ) : flying ? (
          <p className="coach-pc-outcome" tabIndex={-1}>
            Being changed
          </p>
        ) : (
          <OutcomeLine outcome={line.outcome} applied={null} change />
        )}
        {inFlight === "decline" ? <p className="coach-pc-outcome coach-pc-outcome--refused">{IN_FLIGHT_LINE}</p> : null}
        {(line.issues ?? []).map((i, k) => (
          <p key={k} className="coach-pc-note">
            {i.message}
          </p>
        ))}
      </div>
    </li>
  );
}
