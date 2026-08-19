import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";
import type {
  CoachMessageDto,
  CoachProposalDto,
  CoachQuestionDto,
} from "@rg/api-client";
import { describeOps, type CoachOp, type OpLine, type PlannedRef } from "@rg/domain";
import {
  countNoun,
  formatDayLong,
  dayOfMonth,
  revealInView,
  Sheet,
  useIsomorphicLayoutEffect,
  WatchCoverageNote,
  watchCoverageShort,
  weekdayShort,
} from "../components.js";

/**
 * The coach panel: ONE timeline. Messages, receipts and proposals are the
 * same conversation in the same scroller, in the order they happened, and it
 * opens at the bottom of it (rework 2026-08-17).
 *
 * It used to be two regions — a pinned "Needs you · N" tray of proposal cards
 * above an inert thread — and the split cost three separate things:
 *
 *   · the tray had to win the opening scroll, so the panel opened 1,143px
 *     above the newest message on a phone and every poll that changed the
 *     tray's height re-argued the point;
 *   · a proposal had no place in time. It appeared above a conversation it
 *     was part of, and when it resolved it vanished from the tray and left
 *     a one-line receipt at the far end of the thread;
 *   · and the card described three operations with the single word "Mixed".
 *
 * Now: proposals are messages (`buildThread`), a resolved one stays where it
 * settled and goes quiet instead of disappearing, the bottom is the resting
 * place (`useBottomAnchor`), and every card renders the manifest —
 * `describeOps`, the domain's one answer to "what will this do to my
 * calendar" — three lines at a glance with the whole thing one tap away in a
 * Sheet, which is the disclosure family that measures 0px of displacement.
 *
 * Presentational only — every callback is injected, so the whole surface is
 * static-markup testable (the arrival-block.tsx pattern).
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

/**
 * How a proposal ended — the label on a settled card, and nothing structural.
 *
 * WHAT MAKES A RECEIPT A SETTLED PROPOSAL IS `refs.proposalId`, not this.
 * The worker attaches that ref to exactly the four receipts that resolve one
 * (approve, decline, expiry sweep, supersede) and to no other receipt, so
 * "this receipt is a proposal's ending" is already a fact in the data. The
 * sentences are only how it is worded, and wording is what changes: keying
 * the CARD on a regex over worker prose meant a copy edit in another package
 * — a recased word, a different dash — would silently revert every settled
 * proposal in the thread to a one-line receipt, with nothing to fail.
 *
 * So an unrecognised sentence still gets a card; it just carries the
 * worker's own line instead of a word and a title, which reads correctly for
 * anything the worker might say next.
 */
export interface SettledMark {
  /** Shares the DTO's own vocabulary so the two cannot drift. `undefined`
   * when the receipt's wording is not one this build knows. */
  status?: Exclude<CoachProposalDto["status"], "pending">;
  /** "Approved", "Left as planned", "Expired", "Replaced", "Not applied" —
   * absent when the wording is unknown, in which case `title` is the whole
   * receipt. */
  word?: string;
  /** The proposal's title, as the receipt carried it. */
  title: string;
  /** Why it ended this way, when the receipt says. Only a rejection does: the
   * other four endings are the athlete's own doing or the clock's, and need
   * no explanation. */
  reason?: string;
}

/** `[shape, status, word, reasonGroup?]`. Group 1 is always the title. */
const SETTLED_SHAPES: Array<[RegExp, NonNullable<SettledMark["status"]>, string, number?]> = [
  [/^✓ approved — (.+)$/s, "approved", "Approved"],
  [/^Left as planned — (.+)$/s, "declined", "Left as planned"],
  [/^Expired — the moment passed: (.+)$/s, "expired", "Expired"],
  [/^Superseded: (.+)$/s, "superseded", "Replaced"],
  // "Not applied — “Ski legs” (3 adds, 1 skip): <why>. Nothing changed, …"
  // The op summary is dropped on the floor here — the card renders the real
  // manifest — and the reason becomes its own line.
  [/^Not applied — “(.+?)”(?: \(.+?\))?: ([^]+)$/, "rejected", "Not applied", 2],
];

/**
 * Split a proposal receipt into its outcome word and the proposal's title.
 * Total: an unknown wording comes back as the whole body under no word.
 */
export function settledFromReceipt(body: string): SettledMark {
  for (const [re, status, word, reasonGroup] of SETTLED_SHAPES) {
    const m = re.exec(body);
    if (m) return { status, word, title: m[1]!, reason: reasonGroup ? m[reasonGroup] : undefined };
  }
  return { title: body };
}

/**
 * A proposal that has been decided. Still in the conversation, at the moment
 * it settled, visibly done: no controls that ask for anything, and the way
 * back into what it actually did.
 *
 * IT IS ALSO WHERE A REJECTED DRAFT LIVES (2026-08-17). When the guardrails
 * find something FATAL in a proposal and the coach's convergence retries
 * cannot fix it, the ops are not thrown away — they are stored as a `rejected`
 * proposal and land here, with the reason on the card and the whole manifest
 * behind "What it would have done". The alternative, and what this replaces,
 * was a sentence of prose describing seven operations the athlete could not
 * see. No new surface was invented for it: a rejection is an ending like any
 * other, and this card already renders endings.
 */
export function SettledProposalCard({
  mark,
  proposal,
  planned,
  domId,
}: {
  mark: SettledMark;
  /** Null only when this build's thread page doesn't carry it — `/api/coach/
   * state` resolves every proposal its receipts refer to, so a settled card
   * keeps its manifest across a reload. */
  proposal: CoachProposalDto | null;
  planned?: ReadonlyMap<string, PlannedRef>;
  /** The receipt's own id — the only stable handle a settled card has. */
  domId: string;
}) {
  // The snapshot taken when it APPLIED (manifest 0019) outranks the live
  // plan: recomputing "before" from the post-apply plan is how every applied
  // ease came to render X → X.
  const appliedMap = useMemo(
    () => (proposal?.appliedRefs ? new Map(Object.entries(proposal.appliedRefs)) : undefined),
    [proposal?.appliedRefs],
  );
  const manifest = useManifest(proposal, appliedMap ?? planned);
  // One settled look whichever way it went — the outcome shows through the
  // pill, so the card carries no per-status modifier for nothing to style.
  return (
    <div className="coach-prop coach-prop--settled" id={`proposal-${domId}`}>
      <div className="coach-prop-settled-head">
        {mark.word ? (
          <span className={`pill ${mark.status === "approved" ? "pill-ok" : "pill-neutral"}`}>
            {mark.word}
          </span>
        ) : null}
        <strong className="coach-prop-title">{mark.title}</strong>
      </div>
      {/* Why, when there is a why — a rejection is the only ending the athlete
          did not choose, so it is the only one that owes them a sentence. */}
      {mark.reason ? <p className="coach-prop-evidence faint">{mark.reason}</p> : null}
      {manifest.lines.length > 0 ? (
        <OpenManifest
          label={
            mark.status === "approved"
              ? `What it did — ${verbCounts(manifest.lines)}`
              : "What it would have done"
          }
          onClick={manifest.onOpen}
        />
      ) : null}
      {manifest.open ? (
        <ProposalDetailSheet
          title={mark.title}
          lines={manifest.lines}
          open
          onClose={manifest.onClose}
          lede={
            mark.status === "approved"
              ? `applied ${proposal?.resolvedAt ? formatDayLong(proposal.resolvedAt.slice(0, 10)) : "earlier"}`
              : "was never applied"
          }
        />
      ) : null}
    </div>
  );
}

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
      {/* WHAT IT DOES, before what it costs, before the buttons. The card
          used to go straight from the evidence line to "Make it so". */}
      <ProposalGlance lines={manifest.lines} onOpenAll={manifest.onOpen} />
      <TradeOffNote flags={proposal.flags} />
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

// ── The one timeline ───────────────────────────────────────────────────────

export type ThreadItem =
  | { kind: "message"; id: string; at: string; message: CoachMessageDto }
  | { kind: "pending"; id: string; at: string; proposal: CoachProposalDto }
  | {
      kind: "settled";
      id: string;
      at: string;
      mark: SettledMark;
      /** The proposal the receipt refers to, if this session still holds it. */
      proposal: CoachProposalDto | null;
    };

/**
 * Repeats of the SAME wake-failure receipt ("couldn't think" / "resting")
 * collapse to one (audit C4/C14): the server now dedupes its own writes,
 * but this also heals any duplicate rows a thread already accumulated
 * before that fix shipped. Scoped to `refs.wakeFailure` specifically
 * (audit C4/C14 followup) — an ordinary receipt (an "Expired: …" or
 * "✓ approved — …" line) that happens to share body text with another one
 * is NOT the same event and must never be merged away. Also not limited to
 * ADJACENT repeats: an unrelated receipt landing between two identical
 * failures (e.g. an expiry sweep firing mid-outage) shouldn't break the
 * dedupe, so this tracks the last-KEPT failure body across the whole
 * thread rather than just comparing neighbors.
 */
function collapseRepeatedReceipts(messages: CoachMessageDto[]): CoachMessageDto[] {
  let lastFailureBody: string | null = null;
  return messages.filter((m) => {
    if (m.role !== "receipt" || !m.refs.wakeFailure) return true;
    if (m.body === lastFailureBody) return false;
    lastFailureBody = m.body;
    return true;
  });
}

/**
 * Messages and proposals, in the order they happened.
 *
 * A PENDING proposal sits at its `createdAt`, which is the moment the coach
 * raised it — almost always beside the briefing that explains it. A RESOLVED
 * one sits at its receipt, which is the moment it settled, and the receipt is
 * absorbed into the card rather than duplicated beside it. That is the one
 * anchor available both live and after a reload: `/api/coach/state` returns
 * pending proposals only, so a resolved proposal's whole surviving record is
 * the receipt line.
 *
 * `known` remembers every proposal this session has seen, so the card the
 * athlete just approved keeps its manifest instead of degrading to a title
 * the instant the refetch lands.
 */
export function buildThread(
  messages: CoachMessageDto[],
  proposals: CoachProposalDto[],
  known?: ReadonlyMap<string, CoachProposalDto>,
): ThreadItem[] {
  const items: ThreadItem[] = [];
  const resolved = new Set<string>();
  for (const m of collapseRepeatedReceipts(messages)) {
    // `refs.proposalId` on a receipt IS the settlement — the worker attaches
    // it to those four receipts and to nothing else. What the sentence SAYS
    // only decides the label (see `settledFromReceipt`).
    const proposalId = m.role === "receipt" ? m.refs.proposalId : undefined;
    if (proposalId) {
      resolved.add(proposalId);
      const known_ = known?.get(proposalId) ?? null;
      const mark = settledFromReceipt(m.body);
      items.push({
        kind: "settled",
        id: m.id,
        at: m.at,
        // The proposal's own title beats the one parsed out of prose.
        mark: known_ ? { ...mark, title: known_.title } : mark,
        proposal: known_,
      });
      continue;
    }
    items.push({ kind: "message", id: m.id, at: m.at, message: m });
  }
  for (const p of proposals) {
    // A proposal cannot be both pending and settled; if the receipt is
    // already in the thread the receipt wins, because it is the later truth.
    if (resolved.has(p.id)) continue;
    items.push({ kind: "pending", id: p.id, at: p.createdAt, proposal: p });
  }
  // `Array.prototype.sort` has been stable since ES2019, so same-instant items
  // keep the order they were pushed in — which puts a wake's briefing above
  // the proposals that wake created.
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
 */
export function useBottomAnchor(signature: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const settleUntil = useRef(0);

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
    settleUntil.current = Date.now() + SETTLE_MS;
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [signature]);

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

export function CoachThread({
  items,
  planned,
  onApprove = () => undefined,
  onDecline = () => undefined,
  busy,
  acting,
  errors,
  onRetrySend,
}: {
  /** The merged timeline. ONE derivation — `buildThread` is called once, by
   * the panel, which also reads its own scroll signature off the result. */
  items: ThreadItem[];
  planned?: ReadonlyMap<string, PlannedRef>;
  onApprove?: (id: string) => void;
  onDecline?: (id: string) => void;
  busy?: boolean;
  acting?: boolean;
  errors?: Record<string, string>;
  /** Resend a failed optimistic message (audit C16). */
  onRetrySend?: (localId: string, body: string) => void;
}) {
  return (
    <div className="coach-thread">
      {items.map((it) => {
        if (it.kind === "pending") {
          return (
            <ProposalCard
              key={it.id}
              proposal={it.proposal}
              planned={planned}
              onApprove={onApprove}
              onDecline={onDecline}
              busy={busy}
              acting={acting}
              error={errors?.[it.proposal.id]}
            />
          );
        }
        if (it.kind === "settled") {
          return (
            <SettledProposalCard
              key={it.id}
              mark={it.mark}
              proposal={it.proposal}
              planned={planned}
              domId={it.id}
            />
          );
        }
        const m = it.message;
        if (m.role === "receipt") {
          return (
            <div key={it.id} className="coach-receipt faint">
              {m.body}
            </div>
          );
        }
        return (
          <div
            key={it.id}
            className={`coach-msg coach-msg-${m.role}${m.failed ? " coach-msg-failed" : ""}`}
          >
            {m.refs.kind === "analysis" ? (
              <span className="tagchip" style={{ marginRight: "var(--space-3)" }}>
                effort read
              </span>
            ) : null}
            <span style={{ whiteSpace: "pre-wrap" }}>{m.body}</span>
            {m.role === "coach" && m.refs.memoryIds?.length ? (
              <span className="coach-memchips">
                {m.refs.memoryIds.map((mid) => (
                  <Link key={mid} to="/settings#coach-memory" className="tagchip">
                    noted ✓
                  </Link>
                ))}
              </span>
            ) : null}
            {m.failed ? (
              <button
                type="button"
                className="linklike coach-msg-retry"
                onClick={() => onRetrySend?.(it.id, m.body)}
              >
                Couldn't send — tap to retry
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Every pending proposal card currently in a scroller, in thread order. */
const pendingCardsIn = (root: HTMLElement | null): HTMLElement[] =>
  root ? [...root.querySelectorAll<HTMLElement>("[data-pending-proposal]")] : [];

/**
 * The nearest pending proposal that is off screen, and which way it lies.
 * Null when one of them is visible — there is nothing to point at.
 *
 * Live geometry, deliberately. An IntersectionObserver entry carries a rect
 * from the moment it last CROSSED the root's edge, and a card can go from
 * above the fold to below it in one jump (tapping the chip, or a `scrollTop`
 * assignment) without ever crossing — measured: after a jump from the bottom
 * of the thread to the top, the first card's cached direction still read "up"
 * while every card was below the fold, so the chip pointed the wrong way.
 * Five rects, read only when something actually changed.
 */
function nearestOffscreen(root: HTMLElement | null): { dir: "up" | "down"; el: HTMLElement } | null {
  const cards = pendingCardsIn(root);
  if (!root || cards.length === 0) return null;
  const rr = root.getBoundingClientRect();
  let best: { dir: "up" | "down"; el: HTMLElement; gap: number } | null = null;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    if (r.bottom > rr.top && r.top < rr.bottom) return null; // this one is in view
    const above = r.bottom <= rr.top;
    const gap = above ? rr.top - r.bottom : r.top - rr.bottom;
    if (!best || gap < best.gap) best = { dir: above ? "up" : "down", el, gap };
  }
  return best && { dir: best.dir, el: best.el };
}

/**
 * WHICH WAY THE PENDING PROPOSALS ARE, when none of them is on screen.
 *
 * The tray guaranteed findability by never moving; a chronological thread
 * cannot, so this takes over that one job.
 *
 * An IntersectionObserver drives it rather than a scroll handler: visibility
 * is exactly what it answers, it answers off the compositor, and it fires on
 * the two or three enter/exit transitions in a gesture instead of running on
 * all 120 frames of it. The scroll-handler version read `offsetTop` and
 * `offsetHeight` off every card on every tick — layout reads, in the one
 * interaction this rework is built around. Re-established on `signature`,
 * which is precisely when the set of cards can have changed.
 */
function usePendingOffscreen(
  scroller: RefObject<HTMLElement | null>,
  signature: string,
): "up" | "down" | null {
  const [away, setAway] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    const root = scroller.current;
    const cards = pendingCardsIn(root);
    if (!root || cards.length === 0 || typeof IntersectionObserver === "undefined") {
      setAway(null);
      return;
    }
    const io = new IntersectionObserver(() => setAway(nearestOffscreen(root)?.dir ?? null), { root });
    for (const c of cards) io.observe(c);
    return () => io.disconnect();
  }, [scroller, signature]);
  return away;
}

export function CoachComposer({
  onSend,
  question,
  onAnswer,
  onDismiss,
  busy,
}: {
  onSend: (body: string) => void;
  question: CoachQuestionDto | null;
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
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
          <span className="row" style={{ gap: "var(--space-3)" }}>
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
      ) : null}
    </div>
  );
}

export function CoachPanel({
  messages,
  proposals,
  settledProposals,
  question,
  busy,
  acting,
  proposalErrors,
  planned,
  onSend,
  onApprove,
  onDecline,
  onAnswer,
  onDismiss,
  onCheckIn,
  onRetrySend,
  header,
  hideHead,
}: {
  messages: CoachMessageDto[];
  proposals: CoachProposalDto[];
  /** Every proposal the thread's receipts refer to, whatever its status. It is
   * what lets a settled card — approved, declined, expired, replaced, or a
   * REJECTED draft that could not be applied — still open its manifest after
   * a reload. Never rendered as pending: `buildThread` keys on the receipt. */
  settledProposals?: CoachProposalDto[];
  question: CoachQuestionDto | null;
  busy?: boolean;
  /** An approve/decline is in flight (audit C17) — disables every card's
   * buttons so a slow request can't be double-tapped. */
  acting?: boolean;
  /** proposal id → why its last approve/decline failed (audit C17). */
  proposalErrors?: Record<string, string>;
  /** workoutId → what the plan holds there today (date + summary), so the
   * manifest can say what an `ease` replaces and on which day. */
  planned?: ReadonlyMap<string, PlannedRef>;
  onSend: (body: string) => void;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
  /** The manual "Check in" trigger — forces a wake past the skip rule. */
  onCheckIn?: () => void;
  /** Resend a failed optimistic message (audit C16). */
  onRetrySend?: (localId: string, body: string) => void;
  /** Extra header content (e.g. a close button on mobile). */
  header?: ReactNode;
  /** Skip the internal header (a wrapping Sheet already provides one). */
  hideHead?: boolean;
}) {
  // Every proposal this mount has seen. A card that resolves while the reader
  // is looking at it keeps its manifest; without this the refetch that drops
  // it from `pendingProposals` would leave only the receipt's title.
  const known = useRef(new Map<string, CoachProposalDto>()).current;

  // ONE derivation of the timeline, and it is not free: `messages` and
  // `proposals` keep their identity across a poll that changed nothing
  // (react-query's structural sharing), so a render caused by anything else
  // on the plan page — a media-query change, a week page, a dialog opening —
  // reuses this instead of re-walking the thread and re-parsing every
  // receipt. The `known` update belongs INSIDE, before the build reads it.
  const { items, signature } = useMemo(() => {
    // Settled first: a proposal that is somehow in both lists is pending, and
    // the pending copy is the newer truth.
    for (const p of settledProposals ?? []) known.set(p.id, p);
    for (const p of proposals) known.set(p.id, p);
    const built = buildThread(messages, proposals, known);
    // What "the conversation changed" means — not the array's identity (the
    // poll hands back a new one every time and nothing has happened) and not
    // its length (a proposal settling swaps one item for another).
    return { items: built, signature: built.map((i) => i.id).join(",") };
  }, [messages, proposals, settledProposals, known]);

  const { ref: scrollRef, onScroll, onInteract } = useBottomAnchor(signature);
  const away = usePendingOffscreen(scrollRef, signature);

  // The arrow and the tap answer from ONE function, so the chip can never
  // point one way and travel another. `revealInView` resolves the scroll
  // owner itself (stopping at the dialog, so the mobile sheet's scroller is
  // never the page's), moves the least it can, and honours
  // `prefers-reduced-motion`.
  const jump = () => revealInView(nearestOffscreen(scrollRef.current)?.el);

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
          <span className="row" style={{ gap: "var(--space-4)" }}>
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
      {/* One scroll owner for the panel (System 1 §2), and now one thing
          inside it. The wrapper exists so the jump chip can float over the
          scroll region without scrolling with it and without taking a single
          pixel of flow — a chip that appears on scroll and pushes the
          conversation would be the disclosure bug in a new hat. */}
      <div className="coach-scroll-wrap">
        <div
          className="coach-scroll scroller"
          ref={scrollRef}
          onScroll={onScroll}
          onPointerDownCapture={onInteract}
          onKeyDownCapture={onInteract}
        >
          <CoachThread
            items={items}
            planned={planned}
            onApprove={onApprove}
            onDecline={onDecline}
            busy={busy}
            acting={acting}
            errors={proposalErrors}
            onRetrySend={onRetrySend}
          />
        </div>
        {/* Absolutely positioned over the scroll region, never in flow: a
            control that appears the moment you scroll past the last open
            proposal must not shove the conversation around to do it. */}
        {away ? (
          <button type="button" className={`chipbtn coach-jump coach-jump--${away}`} onClick={jump}>
            Needs you · {proposals.length}
            <span aria-hidden> {away === "up" ? "↑" : "↓"}</span>
          </button>
        ) : null}
      </div>
      <CoachComposer onSend={onSend} question={question} onAnswer={onAnswer} onDismiss={onDismiss} busy={busy} />
    </section>
  );
}
