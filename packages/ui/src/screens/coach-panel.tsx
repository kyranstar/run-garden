import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoachProposalDto, CoachQuestionDto } from "@rg/api-client";
import { describeOps, type CoachOp, type OpLine, type PlannedRef } from "@rg/domain";
import {
  countNoun,
  dayOfMonth,
  Sheet,
  useIsomorphicLayoutEffect,
  WatchCoverageNote,
  watchCoverageShort,
  weekdayShort,
} from "../components.js";

/**
 * THE THREAD COACH'S PIECES THE APP STILL SHOWS (the new shape §5, 2026-10-17). The Plan's floating coach window and
 * its chat are gone — the coach is one conversation, opened from the nav — but what the thread coach puts on the Plan
 * by itself stays: its suggestion's card with the manifest (`ProposalCard`, `describeOps`: what it will do to the
 * calendar, three lines at a glance, the whole one tap away in a Sheet), its ghosts on the week (`pendingByDate`), and
 * its open question's row (`CoachQuestionRow`) — gathered on the Plan by thread-coach-cards.tsx. And the bottom anchor
 * the conversation scrolls by (`useBottomAnchor`).
 *
 * Presentational only — every callback is injected, so the whole surface is static-markup testable.
 */

/** Op lines shown on the card itself; the rest are behind the Sheet. Small
 * on purpose: a twelve-op plan must not turn a message into a page. */
const GLANCE_LINES = 3;

/** How close to the bottom still counts as "at the bottom" — one line of
 * slack, so a stray wheel tick doesn't unstick the thread. */
const STICK_SLACK_PX = 48;

/** After new content arrives, keep re-pinning for this long while the layout
 * settles (a late font, a wrapped line, a query answering a beat after the
 * sheet opened). Outside this window, growth is the reader's own doing — a
 * disclosure they opened — and must not move them. */
const SETTLE_MS = 1200;

/** Which discipline(s) a proposal touches, from its ops' sessions. Mobility
 * sessions read as "Mobility" rather than falling through to "Run" — the
 * same lie the sport mapping used to tell (2026-08-16). */
export function proposalDiscipline(p: CoachProposalDto): "run" | "lift" | "mobility" | "both" | null {
  let run = false;
  let lift = false;
  let mobility = false;
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
      else if (s.mobility) mobility = true;
      else if (s.run) run = true;
    }
    if (op.kind === "createPlan" || op.kind === "retirePlan" || op.kind === "extendPlan") {
      if ((op.discipline as string) === "lift") lift = true;
      if ((op.discipline as string) === "run") run = true;
    }
  }
  if ([run, lift, mobility].filter(Boolean).length > 1) return "both";
  if (lift) return "lift";
  if (mobility) return "mobility";
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
  /** The same workoutId → what-the-plan-holds map the manifest reads; only
   * the date is used here. */
  planned: ReadonlyMap<string, PlannedRef>,
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
        push(planned.get(op.workoutId as string)?.date, {
          kind: "rewrite",
          label: session?.title ?? "changed",
          proposalId: p.id,
          title: p.title,
        });
      } else if (kind === "move") {
        push(planned.get(op.workoutId as string)?.date, {
          kind: "outgoing",
          label: "moves away",
          proposalId: p.id,
          title: p.title,
        });
        push(op.toDate as string, { kind: "incoming", label: "arrives here", proposalId: p.id, title: p.title });
      } else if (kind === "skip") {
        push(planned.get(op.workoutId as string)?.date, {
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

// ── The manifest ───────────────────────────────────────────────────────────

/** "Tue 18" — the day column of a manifest line. The same two formatters the
 * week grid's own column headers use, so a day is named identically wherever
 * the app names one. (Both read the ISO string's own fields; neither lets a
 * bare date be parsed as UTC midnight and named as the day before.) */
export function opDayLabel(iso: string): string {
  return `${weekdayShort(iso)} ${dayOfMonth(iso)}`;
}

/** A manifest line's React key. One op can produce several lines on the same
 * day, so the index is part of it. */
const lineKey = (l: OpLine, i: number) => `${l.kind}-${l.date ?? "plan"}-${i}`;

/** The verb chip per op kind — colour-coded with EXISTING semantic classes,
 * so the manifest introduces no new colour vocabulary. */
export const OP_VERB: Record<OpLine["kind"], { word: string; tone: "eased" | "moved" | "added" | "quiet" }> = {
  ease: { word: "Eased", tone: "eased" },
  move: { word: "Moved", tone: "moved" },
  swap: { word: "Swapped", tone: "moved" },
  skip: { word: "Skipped", tone: "quiet" },
  add: { word: "Added", tone: "added" },
  reshapeWeek: { word: "Rewrote", tone: "eased" },
  firmUp: { word: "Firmed", tone: "added" },
  extendPlan: { word: "Extended", tone: "added" },
  windDown: { word: "Wound down", tone: "eased" },
  createPlan: { word: "Planned", tone: "added" },
  retirePlan: { word: "Retired", tone: "quiet" },
  resolveRaceConflict: { word: "Resolved", tone: "quiet" },
  // "Removed" is deliberately a different word AND a different tone from
  // "Skipped": one takes the session off the plan, the other records that it
  // did not happen, and the athlete needs to see which they are approving.
  remove: { word: "Removed", tone: "quiet" },
  restore: { word: "Restored", tone: "added" },
  adjust: { word: "Retimed", tone: "eased" },
};

/** "eased 2 · moved 1 · added 1" — the collapsed link's summary of a settled
 * manifest, counted from the lines themselves. */
export function verbCounts(lines: OpLine[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const word = OP_VERB[l.kind]?.word.toLowerCase() ?? l.kind;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].map(([w, n]) => `${w} ${n}`).join(" · ");
}

/** Lines grouped by day, chronological, plan-level last — the day is said
 * once, as a header, and never again inside a row. */
export function groupLinesByDay(lines: OpLine[]): Array<{ date: string | null; lines: OpLine[] }> {
  const out: Array<{ date: string | null; lines: OpLine[] }> = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.date === l.date) last.lines.push(l);
    else out.push({ date: l.date, lines: [l] });
  }
  return out;
}

/** The lines a proposal's ops come to. `planned` (workoutId → what the plan
 * holds today) is what lets an `ease` say "6×600m at 10K pace → Easy 35" on
 * the right day instead of an undated rewrite — the panel already builds that
 * map for the calendar's ghosts. Never throws: a proposal whose ops predate
 * the current op vocabulary must still render its title and its buttons. */
export function proposalLines(
  proposal: CoachProposalDto,
  planned?: ReadonlyMap<string, PlannedRef>,
): OpLine[] {
  try {
    return describeOps(proposal.ops as CoachOp[], planned);
  } catch {
    return [];
  }
}

function OpRow({ line, full = false }: { line: OpLine; full?: boolean }) {
  const verb = OP_VERB[line.kind] ?? { word: line.kind, tone: "quiet" as const };
  return (
    <li className={`coach-op coach-op--${verb.tone}`}>
      <span className={`coach-op-verb coach-op-verb--${verb.tone}`}>{verb.word}</span>
      <span className="coach-op-what">
        <span className="coach-op-summary">{line.summary}</span>
        {/* The old state, struck — only ever a real difference (never X → X;
            describeOps guarantees it). */}
        {line.was ? (
          <span className="coach-op-was">
            was <s>{line.was}</s>
          </span>
        ) : null}
        {line.change ? <span className="coach-op-change">{line.change}</span> : null}
        {full && line.detail.length > 0 ? (
          <ul className="coach-op-detail muted">
            {/* Index, not the string: a session can legitimately repeat a
                line ("400 m interval" twice), and a duplicate React key
                silently drops one of them from the very list whose whole
                job is to be complete. */}
            {line.detail.map((d, di) => (
              <li key={`${di}-${d}`}>{d}</li>
            ))}
          </ul>
        ) : null}
        {full ? (
          <WatchCoverageNote view={line.watch} />
        ) : watchCoverageShort(line.watch) ? (
          <span className="coach-op-watch">{watchCoverageShort(line.watch)}</span>
        ) : null}
      </span>
    </li>
  );
}

/** Day-grouped rows: the day said once as a header, `limit` rows in total
 * (the glance caps; the sheet renders every line with its detail). */
function GroupedOps({ lines, limit = Infinity, full = false }: { lines: OpLine[]; limit?: number; full?: boolean }) {
  const shown = Number.isFinite(limit) ? lines.slice(0, limit) : lines;
  return (
    <>
      {groupLinesByDay(shown).map((g, gi) => (
        <div key={`${g.date ?? "plan"}-${gi}`} className="coach-op-day-group">
          <div className="coach-op-day-h">{g.date ? opDayLabel(g.date) : "Plan"}</div>
          <ul className="coach-ops">
            {g.lines.map((l, i) => (
              <OpRow key={lineKey(l, i)} line={l} full={full} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * THE ONE LINE THE MANIFEST OWED THE ATHLETE BEFORE THEY PRESS "Make it so".
 *
 * The manifest's rule is that the model never states a fact the system can
 * compute — and "will this reach my watch" is exactly such a fact, computed by
 * `watchCoverage` from the same predicate that decides the push. It was
 * missing entirely: a proposal adding four mobility sessions rendered
 * identically to one adding four runs, and the difference surfaced days later,
 * one tap deep in a session sheet, as a sentence with no reason in it.
 *
 * Counted, not listed: the per-session reasons are on the lines themselves and
 * in full in the Sheet. Nothing renders when everything crosses, so an
 * ordinary running week gains no chrome at all.
 */
function WatchSummary({ lines }: { lines: OpLine[] }) {
  const offWatch = lines.filter((l) => l.watch?.coverage === "none").length;
  const partial = lines.filter((l) => l.watch?.coverage === "partial").length;
  if (offWatch === 0 && partial === 0) return null;
  const parts: string[] = [];
  if (offWatch > 0) {
    parts.push(
      `${offWatch === 1 ? "One of these sessions won't" : `${offWatch} of these sessions won't`} appear on your COROS watch`,
    );
  }
  if (partial > 0) {
    parts.push(`${partial === 1 ? "one arrives" : `${partial} arrive`} on the watch without pace targets`);
  }
  return (
    <p className="note watch-note coach-ops-watch">
      {parts.join(", and ")} — {offWatch > 0 ? "those live in Run Garden and your Google Calendar. " : ""}
      Open the manifest for the reason on each.
    </p>
  );
}

/** The one control that opens the whole manifest. Both cards use it, so the
 * caret and the affordance cannot drift apart between them. */
function OpenManifest({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="linklike coach-ops-all" onClick={onClick}>
      {label}
      <span className="disclosure-caret" aria-hidden>
        →
      </span>
    </button>
  );
}

/**
 * The glance: the first few lines of the manifest, plus the one control that
 * opens the whole thing.
 *
 * The control opens a Sheet, not an in-flow disclosure. Both were tried on
 * paper; the twelve-op plan settles it — twelve days with their exercise
 * lists is a page, and a page unfolding inside a message pushes the whole
 * conversation below it down by however long the proposal happens to be.
 * A Sheet displaces 0px by construction (System 4), and it can hold the
 * per-session detail the card has no room for at any length.
 */
function ProposalGlance({ lines, onOpenAll }: { lines: OpLine[]; onOpenAll: () => void }) {
  if (lines.length === 0) return null;
  const hidden = Math.max(0, lines.length - GLANCE_LINES);
  const hasDetail = lines.some((l) => l.detail.length > 0);
  return (
    <>
      <GroupedOps lines={lines} limit={GLANCE_LINES} />
      {/* Below the lines and above the control that opens the rest: the
          athlete reads down to the buttons, and this is the last thing that
          should reach them before "Make it so". It is a whole-proposal fact,
          so it is not attached to any one line. */}
      <WatchSummary lines={lines} />
      {hidden > 0 || hasDetail ? (
        <OpenManifest
          label={hidden > 0 ? `All ${countNoun(lines.length, "change")}` : "Session by session"}
          onClick={onOpenAll}
        />
      ) : null}
    </>
  );
}

/** The whole manifest, every line and every session's contents. */
export function ProposalDetailSheet({
  title,
  lines,
  open,
  onClose,
  lede,
}: {
  title: string;
  lines: OpLine[];
  open: boolean;
  onClose: () => void;
  /** Overrides the pending-tense lede — a settled sheet must not promise
   * "nothing is applied until you say so" under a "Made it so" pill. */
  lede?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="faint coach-ops-full-lede">
        {lede ?? `${countNoun(lines.length, "change")}, in full — nothing is applied until you say so.`}
      </p>
      <GroupedOps lines={lines} full />
    </Sheet>
  );
}

/**
 * A card's manifest and the Sheet that holds all of it. Shared by the pending
 * card and the settled one, which is the whole overlap between them.
 *
 * The Sheet is MOUNTED only while open. `Sheet` returns null when closed, but
 * the element tree is built before it can say so — for the twelve-op plan this
 * file is designed for that is ~140 React elements allocated and thrown away
 * on every render of a card nobody has opened.
 */
function useManifest(proposal: CoachProposalDto | null, planned?: ReadonlyMap<string, PlannedRef>) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(
    () => (proposal ? proposalLines(proposal, planned) : []),
    [proposal, planned],
  );
  return {
    lines,
    open,
    onOpen: useCallback(() => setOpen(true), []),
    onClose: useCallback(() => setOpen(false), []),
  };
}

/**
 * THE TRADE-OFF NOTE — what `flags` actually are.
 *
 * This rendered as "breaks a rule: eases Monday's 10K-pace intervals in a
 * build week" and the athlete was right to object: they had never stated a
 * rule, and easing a session in a build week is not a violation of anything
 * — it is a cost the coach decided was worth paying. Two shapes arrive in
 * `flags` and neither is an accusation: the model's own note about what its
 * proposal spends ("eases Monday's 10K-pace intervals in a build week") and
 * the guardrails' soft finding against a standing preference the athlete DID
 * state ("Long runs stay on Saturdays"). "The trade-off" is true of both and
 * accusatory in neither, and the reasoning it implies is one tap away where
 * it already lived — under "Why?", directly below.
 *
 * The strings themselves come from the model and are not ours to rewrite, so
 * the frame is what carries the tone. No severity levels, no second
 * explainer: the garden asks, it never accuses.
 */
function TradeOffNote({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="note note-warn coach-prop-tradeoff">
      {flags.length === 1 ? (
        <span>
          <span className="coach-prop-tradeoff-lede">The trade-off</span> — {flags[0]}
        </span>
      ) : (
        <>
          <span className="coach-prop-tradeoff-lede">The trade-offs</span>
          <ul>
            {flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Proposal cards ─────────────────────────────────────────────────────────

export function ProposalCard({
  proposal,
  onApprove,
  onDecline,
  busy,
  acting,
  error,
  planned,
}: {
  proposal: CoachProposalDto;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  busy?: boolean;
  /** approve/decline is in flight for SOME proposal (audit C17) — disables
   * this card's own buttons too, so a double-tap can't fire twice. */
  acting?: boolean;
  /** Why the last approve/decline on this card failed, if it did (C17). */
  error?: string;
  /** workoutId → what the plan holds there today, so `ease`/`move`/`skip`
   * lines can name their day and what they replace. */
  planned?: ReadonlyMap<string, PlannedRef>;
}) {
  const [why, setWhy] = useState(false);
  const manifest = useManifest(proposal, planned);
  // Everything else derived from the ops, on the same dependency as the
  // manifest — `proposalDiscipline` walks every op and allocates per op.
  const { discipline, isSkip } = useMemo(
    () => ({
      discipline: proposalDiscipline(proposal),
      isSkip: (proposal.ops as Array<{ kind?: string }>).some((o) => o.kind === "skip"),
    }),
    [proposal],
  );

  return (
    <div className="coach-prop coach-prop--pending" id={`proposal-${proposal.id}`} data-pending-proposal="">
      <div className="row" style={{ gap: "var(--space-4)" }}>
        {discipline ? (
          <span className={`pill ${discipline === "run" ? "pill-run" : "pill-lift"}`}>
            {discipline === "both"
              ? "Mixed"
              : discipline === "lift"
                ? "Lift"
                : discipline === "mobility"
                  ? "Mobility"
                  : "Run"}
          </span>
        ) : null}
        <strong className="coach-prop-title">{proposal.title}</strong>
      </div>
      <p className="coach-prop-evidence faint">{proposal.evidence}</p>
      {/* ONE REQUEST, NOT TWELVE EDITS. A selector op is stored expanded, so
          without this line a "move all my lifting a week later" reads as
          twelve unrelated moves and the athlete has to infer the pattern
          from the manifest. Computed from the selector, never narrated. */}
      {proposal.selectors?.length ? (
        <p className="coach-prop-selector">{proposal.selectors.join(" · ")}</p>
      ) : null}
      {/* WHAT IT DOES, before what it costs, before the buttons. The card
          used to go straight from the evidence line to "Make it so". */}
      <ProposalGlance lines={manifest.lines} onOpenAll={manifest.onOpen} />
      <TradeOffNote flags={proposal.flags} />
      {/* THE ASSUMPTION, where it can be rejected. 2026-09-19: the coach read
          a three-word reply as confirming a race date and built a whole block
          on it. The reasoning was sound; it was simply never shown, so the
          only way to reject the premise was to reject the plan. */}
      {proposal.premise ? (
        <p className="coach-prop-premise">
          <span className="coach-prop-premise-lede">Assuming</span> — {proposal.premise}
        </p>
      ) : null}
      {/* The actions row comes BEFORE everything it reveals (System 4 D3).
          The rationale used to render here, above its own trigger, so asking
          "Why?" pushed the button you had just pressed 114px down the phone
          (92px at 1440) and took "Make it so" and "Leave it" — two committing
          actions — with it: the answer arrived exactly where your thumb was
          about to land on something else. The proposal's own error line had
          the same shape, one tap earlier. Every other disclosure in this app
          renders after its trigger; these two now do too.

          `.tap-clear`: "Why?" is a 24px link between two 44px buttons, so its
          hit pad reaches 10px past its box on every side. The row grants the
          clearance (and the gap) that makes that pad legal — see "Touch
          floor" in styles.css. */}
      <div className="row proposal-actions tap-clear" style={{ marginTop: "var(--space-4)" }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy || acting}
          onClick={() => onApprove(proposal.id)}
        >
          Make it so
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy || acting}
          onClick={() => onDecline(proposal.id)}
        >
          {isSkip ? "Keep it planned" : "Leave it"}
        </button>
        <button
          type="button"
          className="linklike"
          aria-expanded={why}
          aria-controls={`proposal-why-${proposal.id}`}
          onClick={() => setWhy((v) => !v)}
        >
          {/* The word does not change, only the caret — the label used to go
              "Why?" (24px) → "Hide" (31px), the same species of moving
              geometry as the garden's in-prose toggle, just small enough to
              have been ignored. `aria-expanded` carries the state. */}
          Why?<span className="disclosure-caret" aria-hidden>{why ? "▾" : "▸"}</span>
        </button>
      </div>
      {why ? (
        <p id={`proposal-why-${proposal.id}`} className="coach-prop-why muted">
          {proposal.rationale}
        </p>
      ) : null}
      {error ? <p className="coach-prop-error">{error}</p> : null}
      {manifest.open ? (
        <ProposalDetailSheet
          title={proposal.title}
          lines={manifest.lines}
          open
          onClose={manifest.onClose}
        />
      ) : null}
    </div>
  );
}

/**
 * THE BOTTOM IS THE RESTING PLACE.
 *
 * Verbatim, from the athlete: "'Needs you' section forces scroll to the top,
 * and actually scrolls us to the top - it should always load the bottom of
 * the conversation, never scroll us back to the top."
 *
 * It did, and the reason was structural: the tray shared the scroller with
 * the thread, so "show the newest message" and "show the thing waiting on
 * you" were opposite instructions and the tray won — measured at 390, the
 * mobile sheet opened at scrollTop 0 with 1,143px of conversation below the
 * fold. With proposals IN the thread the two instructions are the same one.
 *
 * Two mechanisms, because there are two ways content arrives:
 *
 *   1. A layout effect on the timeline's signature — a new message, a new
 *      proposal, a proposal settling — pins to the bottom BEFORE paint if
 *      the reader was already there. A poll that changes nothing changes no
 *      signature and therefore scrolls nothing.
 *   2. A ResizeObserver for everything that lands after that effect ran: a
 *      query answering a beat after the sheet opened, a line rewrapping, a
 *      font. It re-pins only inside `SETTLE_MS` of a signature change —
 *      outside that window the growth is a disclosure the reader opened, and
 *      moving them would break the rule that nothing at or above a trigger
 *      moves.
 *
 * Scrolling ONE container's own `scrollTop` never touches an ancestor's, the
 * bug `endRef.scrollIntoView` shipped (audit C3): the coach panel sits at the
 * top of the document, so that call yanked the whole page up with it.
 *
 * `top`: nothing to follow yet — the coach's opening screen, read from its
 * first line down (stream H, 2026-10-19: pinned to the bottom, a phone's sheet
 * opened with the coach's line scrolled out of sight above the chips). It is
 * held at the top, and the first turn after it pins to the bottom again.
 */
export function useBottomAnchor(signature: string, top = false) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(!top);
  const settleUntil = useRef(0);
  const wasTop = useRef(top);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
  }, []);

  /**
   * The reader touched something in here, so whatever grows next grew
   * because they asked — end the settle window now rather than waiting it
   * out. Without this a message landing in the second before a press hands
   * that press's disclosure to the auto-scroll: measured at 390, opening
   * "Why?" 900ms after a receipt arrived moved its own trigger 164px.
   */
  const onInteract = useCallback(() => {
    settleUntil.current = 0;
  }, []);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (top) {
      wasTop.current = true;
      stuck.current = false;
      el.scrollTop = 0;
      return;
    }
    if (wasTop.current) {
      wasTop.current = false;
      stuck.current = true;
    }
    settleUntil.current = Date.now() + SETTLE_MS;
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [signature, top]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!stuck.current || Date.now() > settleUntil.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // The content, not just the box: the box's own height rarely changes.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  return { ref, onScroll, onInteract };
}

/** The thread coach's open question: its words, its tappable answers, and ✕ to dismiss it (the Plan shows it too). */
export function CoachQuestionRow({
  question,
  onAnswer,
  onDismiss,
  busy,
}: {
  question: CoachQuestionDto;
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
  busy?: boolean;
}) {
  return (
    <div className="coach-question" role="group" aria-label="Coach question">
      <span className="faint">{question.body}</span>
      <span className="row" style={{ gap: "var(--space-3)" }}>
        {question.chips.map((chip) => (
          <button key={chip} type="button" className="chipbtn" disabled={busy} onClick={() => onAnswer(question.id, chip)}>
            {chip}
          </button>
        ))}
        <button
          type="button"
          className="chipbtn"
          aria-label="Dismiss question"
          title="Dismiss — the coach can ask again later"
          disabled={busy}
          onClick={() => onDismiss(question.id)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
