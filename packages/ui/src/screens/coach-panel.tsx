import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  CoachMessageDto,
  CoachPlanDto,
  CoachProposalDto,
  CoachQuestionDto,
} from "@rg/api-client";

/**
 * The coach panel (Plan B, spec: 2026-08-06-coach-ux-design.md §2): pinned
 * self-expiring proposal tray, thread with inert receipts, one composer.
 * Presentational only — every callback is injected, so the whole surface is
 * static-markup testable (the arrival-block.tsx pattern).
 */

const TRAY_CAP = 4;

/** Which discipline(s) a proposal touches, from its ops' sessions. */
export function proposalDiscipline(p: CoachProposalDto): "run" | "lift" | "both" | null {
  let run = false;
  let lift = false;
  for (const op of p.ops as Array<Record<string, unknown>>) {
    const sessions: Array<Record<string, unknown>> = [];
    const one = op.session as Record<string, unknown> | undefined;
    if (one) sessions.push(one);
    for (const s of (op.sessions as Array<{ session: Record<string, unknown> }> | undefined) ?? []) {
      sessions.push(s.session);
    }
    for (const s of (op.firmSessions as Array<{ session: Record<string, unknown> }> | undefined) ?? []) {
      sessions.push(s.session);
    }
    for (const s of sessions) {
      if (s.lift) lift = true;
      else if (s.run) run = true;
    }
    if (op.kind === "createPlan" || op.kind === "retirePlan" || op.kind === "extendPlan") {
      if ((op.discipline as string) === "lift") lift = true;
      if ((op.discipline as string) === "run") run = true;
    }
  }
  if (run && lift) return "both";
  if (lift) return "lift";
  if (run) return "run";
  return null;
}

/** Per-date calendar ghosts derived from pending proposals (Plan B Task B3). */
export interface PendingGhost {
  kind: "rewrite" | "incoming" | "outgoing" | "skip";
  label: string;
  proposalId: string;
  title: string;
}

export function pendingByDate(
  proposals: CoachProposalDto[],
  workoutDates: Map<string, string>,
): Map<string, PendingGhost[]> {
  const out = new Map<string, PendingGhost[]>();
  const push = (date: string | undefined, g: PendingGhost) => {
    if (!date) return;
    out.set(date, [...(out.get(date) ?? []), g]);
  };
  for (const p of proposals.filter((x) => x.status === "pending")) {
    for (const op of p.ops as Array<Record<string, unknown>>) {
      const kind = op.kind as string;
      const session = op.session as { title?: string } | undefined;
      if (kind === "ease") {
        push(workoutDates.get(op.workoutId as string), {
          kind: "rewrite",
          label: session?.title ?? "changed",
          proposalId: p.id,
          title: p.title,
        });
      } else if (kind === "move") {
        push(workoutDates.get(op.workoutId as string), {
          kind: "outgoing",
          label: "moves away",
          proposalId: p.id,
          title: p.title,
        });
        push(op.toDate as string, { kind: "incoming", label: "arrives here", proposalId: p.id, title: p.title });
      } else if (kind === "skip") {
        push(workoutDates.get(op.workoutId as string), {
          kind: "skip",
          label: "skipped",
          proposalId: p.id,
          title: p.title,
        });
      } else if (kind === "add") {
        push(op.date as string, {
          kind: "incoming",
          label: session?.title ?? "new session",
          proposalId: p.id,
          title: p.title,
        });
      } else if (kind === "firmUp" || kind === "reshapeWeek" || kind === "windDown") {
        for (const s of (op.sessions as Array<{ date: string; session: { title?: string } }>) ?? []) {
          push(s.date, {
            kind: "incoming",
            label: s.session.title ?? "session",
            proposalId: p.id,
            title: p.title,
          });
        }
      } else if (kind === "createPlan") {
        for (const s of (op.firmSessions as Array<{ date: string; session: { title?: string } }>) ?? []) {
          push(s.date, {
            kind: "incoming",
            label: s.session.title ?? "session",
            proposalId: p.id,
            title: p.title,
          });
        }
      }
    }
  }
  return out;
}

export function ProposalCard({
  proposal,
  onApprove,
  onDecline,
  busy,
}: {
  proposal: CoachProposalDto;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  busy?: boolean;
}) {
  const [why, setWhy] = useState(false);
  const discipline = proposalDiscipline(proposal);
  const isSkip = (proposal.ops as Array<{ kind?: string }>).some((o) => o.kind === "skip");
  return (
    <div className="coach-prop" id={`proposal-${proposal.id}`}>
      <div className="row" style={{ gap: "0.45rem" }}>
        {discipline ? (
          <span className={`pill ${discipline === "lift" ? "pill-lift" : "pill-run"}`}>
            {discipline === "both" ? "Run + Lift" : discipline === "lift" ? "Lift" : "Run"}
          </span>
        ) : null}
        <strong className="coach-prop-title">{proposal.title}</strong>
      </div>
      <p className="coach-prop-evidence faint">{proposal.evidence}</p>
      {proposal.flags.length > 0 ? (
        <div className="coach-prop-flags">
          {proposal.flags.map((f) => (
            <span key={f} className="pill pill-warnsoft">
              breaks a rule: {f}
            </span>
          ))}
        </div>
      ) : null}
      {why ? <p className="coach-prop-why muted">{proposal.rationale}</p> : null}
      <div className="row" style={{ gap: "0.45rem", marginTop: "0.45rem" }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy}
          onClick={() => onApprove(proposal.id)}
        >
          Make it so
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => onDecline(proposal.id)}
        >
          {isSkip ? "Keep it planned" : "Leave it"}
        </button>
        <button type="button" className="linklike" onClick={() => setWhy((v) => !v)}>
          {why ? "Hide" : "Why?"}
        </button>
      </div>
    </div>
  );
}

export function PendingTray({
  proposals,
  onApprove,
  onDecline,
  busy,
}: {
  proposals: CoachProposalDto[];
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  busy?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  if (proposals.length === 0) return null;
  const visible = showAll ? proposals : proposals.slice(0, TRAY_CAP);
  return (
    <div className="coach-tray">
      <h3 className="coach-tray-head">Needs you · {proposals.length}</h3>
      {visible.map((p) => (
        <ProposalCard key={p.id} proposal={p} onApprove={onApprove} onDecline={onDecline} busy={busy} />
      ))}
      {proposals.length > TRAY_CAP && !showAll ? (
        <button type="button" className="linklike" onClick={() => setShowAll(true)}>
          and {proposals.length - TRAY_CAP} more…
        </button>
      ) : null}
    </div>
  );
}

export function CoachThread({ messages }: { messages: CoachMessageDto[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  return (
    <div className="coach-thread">
      {messages.map((m) =>
        m.role === "receipt" ? (
          <div key={m.id} className="coach-receipt faint">
            {m.body}
          </div>
        ) : (
          <div key={m.id} className={`coach-msg coach-msg-${m.role}`}>
            <span style={{ whiteSpace: "pre-wrap" }}>{m.body}</span>
            {m.role === "coach" && m.refs.memoryIds?.length ? (
              <span className="coach-memchips">
                {m.refs.memoryIds.map((id) => (
                  <Link key={id} to="/settings#coach-memory" className="tagchip">
                    noted ✓
                  </Link>
                ))}
              </span>
            ) : null}
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

export function CoachComposer({
  onSend,
  question,
  onAnswer,
  busy,
}: {
  onSend: (body: string) => void;
  question: CoachQuestionDto | null;
  onAnswer: (id: string, answer: string) => void;
  busy?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setDraft("");
    onSend(body);
  };
  return (
    <div className="coach-composer">
      <form className="coach-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={busy ? "Coach is thinking…" : "Tell your coach anything…"}
          aria-label="Message your coach"
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-small" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
      {question ? (
        <div className="coach-question" role="group" aria-label="Coach question">
          <span className="faint">{question.body}</span>
          <span className="row" style={{ gap: "0.35rem" }}>
            {question.chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chipbtn"
                disabled={busy}
                onClick={() => onAnswer(question.id, chip)}
              >
                {chip}
              </button>
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function CoachPanel({
  messages,
  proposals,
  question,
  busy,
  onSend,
  onApprove,
  onDecline,
  onAnswer,
  onCheckIn,
  header,
  hideHead,
}: {
  messages: CoachMessageDto[];
  proposals: CoachProposalDto[];
  question: CoachQuestionDto | null;
  busy?: boolean;
  onSend: (body: string) => void;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  /** The manual "Check in" trigger — forces a wake past the skip rule. */
  onCheckIn?: () => void;
  /** Extra header content (e.g. a close button on mobile). */
  header?: ReactNode;
  /** Skip the internal header (a wrapping Sheet already provides one). */
  hideHead?: boolean;
}) {
  return (
    <section className="coach-panel" aria-label="Coach">
      {hideHead ? (
        onCheckIn ? (
          <div className="coach-panel-head" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onCheckIn}>
              Check in
            </button>
          </div>
        ) : null
      ) : (
        <div className="coach-panel-head">
          <h2>Coach</h2>
          <span className="row" style={{ gap: "0.6rem" }}>
            {onCheckIn ? (
              <button type="button" className="btn btn-small" disabled={busy} onClick={onCheckIn}>
                Check in
              </button>
            ) : null}
            <Link className="linklike" to="/settings#coach-memory">
              what I know →
            </Link>
            {header}
          </span>
        </div>
      )}
      <PendingTray proposals={proposals} onApprove={onApprove} onDecline={onDecline} busy={busy} />
      <CoachThread messages={messages} />
      <CoachComposer onSend={onSend} question={question} onAnswer={onAnswer} busy={busy} />
    </section>
  );
}

/** Manage-plans sheet body (Task B4). */
export function ManagePlans({
  plans,
  onCanned,
  onRetire,
  onRename,
}: {
  plans: CoachPlanDto[];
  /** Sends a canned coach message (extend / wind down / new plan). */
  onCanned: (body: string) => void;
  onRetire: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const weekOf = (p: CoachPlanDto): string => {
    const total = Math.max(1, Math.round((Date.parse(p.endDate) - Date.parse(p.startDate)) / 604_800_000));
    const into = Math.min(
      total,
      Math.max(1, Math.ceil((Date.now() - Date.parse(p.startDate)) / 604_800_000)),
    );
    return `wk ${into}/${total}`;
  };
  return (
    <div className="stack">
      {plans.length === 0 ? (
        <p className="muted">No coached plans yet — ask for one below.</p>
      ) : (
        plans.map((p) => (
          <div key={p.id} className="coach-plan-card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="row" style={{ gap: "0.45rem" }}>
                <span className={`pill ${p.discipline === "lift" ? "pill-lift" : "pill-run"}`}>
                  {p.discipline === "lift" ? "Lift" : "Run"}
                </span>
                {renaming === p.id ? (
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Plan name"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && name.trim()) {
                        onRename(p.id, name.trim());
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <strong>{p.name}</strong>
                )}
                <span className="faint">
                  {p.status === "active" ? weekOf(p) : p.status}
                </span>
              </span>
            </div>
            {p.status === "active" ? (
              <div className="row" style={{ gap: "0.4rem", marginTop: "0.4rem" }}>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onCanned(`Extend "${p.name}" — draft the next weeks in the same shape.`)}
                >
                  Extend
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onCanned(`Wind down "${p.name}" — draft the final taper week.`)}
                >
                  Wind down
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setRenaming(p.id);
                    setName(p.name);
                  }}
                >
                  Rename
                </button>
                <button type="button" className="btn btn-small" onClick={() => onRetire(p.id)}>
                  Retire
                </button>
              </div>
            ) : null}
          </div>
        ))
      )}
      <div className="row" style={{ gap: "0.4rem" }}>
        <button
          type="button"
          className="btn"
          onClick={() => onCanned("I want a new running plan — interview me for what you need.")}
        >
          New running plan
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onCanned("I want a new lifting plan — interview me for what you need.")}
        >
          New lifting plan
        </button>
      </div>
    </div>
  );
}
