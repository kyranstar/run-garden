/**
 * THE COACH IN THE STUDIO (Stage 3 spec §10; Task 9): the composer at the top of the Studio home, and in its place, while
 * the coach works, the run view.
 *
 *   [ What would help today?                       ]
 *   [ Now ]  [ Later today ]  [ Plan ahead ▾ ]          ← This week · Next 3 workouts
 *
 *  - Opening the Studio finds the athlete's run (`GET /api/coach/runs/current`): a live one shows in place of the empty
 *    composer and goes on stepping; one that is over with a suggestion still open shows under the composer, its card
 *    with it. Rehearsals never come back.
 *  - Now / Later today / a scope from the menu start a run with the field's words. When the athlete already has the coach
 *    working on something, the server answers that run (`existing`): it opens, with one line saying so, and the words
 *    this tap carried are offered back into the field — never dropped silently.
 *  - A set (this week, the next workouts) shows its estimate once its plan made one, beside the limit; Cancel is there.
 *  - A run that stops says what stopped it and what happens next; its suggestion's card follows when it proposed what was
 *    reviewed, and otherwise up to three ways to train now.
 *  - A 404 from the coach's routes: the server's coach is off. One quiet line, and nothing asked again.
 *
 * Shown only with the coach designer on (`coachOn`): the Studio home renders this in its slot.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CoachOpenProposalDto, type CoachRunDto, type CoachRunEventDto, type CoachRunScope } from "@rg/api-client";
import { useEscapeKey } from "../../components.js";
import { IconChevron } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import type { StudioCtx } from "./model.js";
import { cardShows, designProposalQuery, ProposalCard } from "./proposal-card.js";
import {
  EXISTING_LINE,
  failureOf,
  fallbackTiles,
  isLive,
  isNotAvailable,
  NOT_AVAILABLE_LINE,
  type FallbackTile,
} from "./run-model.js";
import { RunView, StoppedLine } from "./run-view.js";
import { quickTiles, sortTemplates, templateHref, templateShape } from "./templates-model.js";
import { useCoachRun, type LoopDeps } from "./use-coach-run.js";

/** The server's own cap on a request's words (coach-runs.ts REQUEST_MAX_CHARS). */
export const REQUEST_MAX_CHARS = 2_000;
/** The counter shows from here. */
export const COUNTER_FROM = 1_800;
/** How many workouts "Next N" plans until Settings → Coach says (Task 10). */
export const NEXT_N_DEFAULT = 3;

/** The current run's read. */
export const COACH_CURRENT_QUERY = ["coach-run-current"] as const;

/** What the Studio's location may carry: the Plan coach sheet's link asks for the composer, focused. */
export interface CoachArrival {
  coach?: "compose";
}

/** The run the area shows, with its trail when known (an `existing` answer comes without it: the loop reads it). */
interface Shown {
  run: CoachRunDto;
  events?: CoachRunEventDto[];
}

/**
 * The suggestion a run holds: the current read's (with its flags), else the run's own; else — once the run is over —
 * the newest line naming one. While the run works a line naming it (a set's designers do) is no reason to read it: it
 * isn't the athlete's yet (fix round, Important 1).
 */
export function proposalIdOf(run: CoachRunDto, events: readonly CoachRunEventDto[], open: CoachOpenProposalDto | null, over: boolean): string | null {
  if (open) return open.id;
  if (run.proposalId) return run.proposalId;
  if (!over) return null;
  for (const e of [...events].sort((a, b) => b.seq - a.seq)) {
    const id = (e.payload as { proposalId?: unknown } | null)?.proposalId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export function StudioCoach({ ctx, loopDeps }: { ctx: StudioCtx; loopDeps?: () => LoopDeps }) {
  const qc = useQueryClient();
  const location = useLocation();
  const compose = (location.state as CoachArrival | null)?.coach === "compose";
  const current = useQuery({ queryKey: COACH_CURRENT_QUERY, queryFn: api.coachRunCurrent, retry: false, staleTime: 0 });
  const [shown, setShown] = useState<Shown | null>(null);
  const [draft, setDraft] = useState("");
  /** The run an `existing` answer opened: its line shows while it is live. */
  const [existingRun, setExistingRun] = useState<string | null>(null);
  /** The words a tap carried that the coach didn't start: offered back until taken, or a new run starts (M4). */
  const [ignored, setIgnored] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Only a read made since this screen opened decides what it shows — a kept one may be a run long over (fix round,
  // Important 2). The first fresh read gives the run shown; a later one, a live run that isn't it (started on another
  // device, or after the one shown ended), takes its place.
  const found = current.isFetchedAfterMount && current.data && current.data.run ? current.data : null;
  useEffect(() => {
    if (!found) return;
    if (!shown || (found.run.id !== shown.run.id && isLive(found.run.status))) setShown({ run: found.run, events: found.events });
  }, [found, shown]);
  const { snapshot, loop } = useCoachRun(shown?.run.id ?? null, shown ?? {}, loopDeps);
  const run = snapshot?.run ?? shown?.run ?? null;
  const status = snapshot?.status ?? run?.status ?? null;
  const events = snapshot?.events ?? shown?.events ?? [];
  const live = status !== null && isLive(status);
  const open = found && run && found.run.id === run.id ? found.proposal : null;

  // A run that is over: read current again (the suggestion it holds open, its flags — or a live run elsewhere), and the
  // suggestion's own read, which may be one kept from while it was unreviewed.
  const over = run !== null && status !== null && !live;
  useEffect(() => {
    if (!over) return;
    void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    void qc.invalidateQueries({ queryKey: ["coach-design-proposal"] });
  }, [over, run?.id, qc]);

  const start = useMutation({
    networkMode: "always",
    mutationFn: (scope: CoachRunScope) => api.coachRunCreate({ scope, request: draft.trim() || null }),
    onSuccess: (res) => {
      setStartError(null);
      // A new run has no trail yet; the live run an `existing` answer opens has one, which its loop reads.
      setShown(res.existing ? { run: res.run } : { run: res.run, events: [] });
      // The words went with the tap; a live run already there answers instead, and they are offered back.
      setDraft("");
      setExistingRun(res.existing ? res.run.id : null);
      setIgnored(res.existing ? res.ignoredRequest.request : null);
      void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    },
    onError: (e) => {
      if (isNotAvailable(e)) setUnavailable(true);
      else setStartError("Couldn't reach the coach — try again.");
    },
  });

  // Whether the coach proposed something is the suggestion's own read: shown, or not (fix round, Important 1).
  const proposalId = run ? proposalIdOf(run, events, open, over) : null;
  const proposalRead = useQuery({
    queryKey: designProposalQuery(proposalId ?? ""),
    queryFn: () => api.coachProposal(proposalId!),
    enabled: proposalId !== null,
    retry: false,
  });
  const proposed = cardShows(proposalRead.data);
  const proposalKnown = proposalId === null || proposalRead.isSuccess || proposalRead.isError;

  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000, enabled: over });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today, enabled: over });
  const tiles = useMemo<FallbackTile[]>(() => {
    if (!over) return [];
    const own = sortTemplates((templates.data?.templates ?? []).filter((t) => t.doc !== null)).map((t) => ({
      key: `template:${t.id}`,
      title: t.name,
      minutes: templateShape(t).minutes,
      href: templateHref(t.id),
    }));
    return fallbackTiles({ today: today.data, quick: quickTiles(ctx, templates.data?.templates), templates: own });
  }, [over, ctx, templates.data, today.data]);

  if (unavailable || isNotAvailable(current.error)) {
    return (
      <p className="coach-off" role="status">
        {NOT_AVAILABLE_LINE}
      </p>
    );
  }
  // A moment while the current run is read for this screen: no composer flashing before the run it would give way to,
  // and no run kept from before shown in its place. A kept "no run" is shown at once — a fresh read adopts any run.
  const keptNoRun = current.data !== undefined && current.data.run === null;
  if (!current.isFetchedAfterMount && !shown && !current.isError && !keptNoRun) return null;

  const offerWords = ignored !== null && ignored.trim() !== "" && ignored !== draft;
  const wordsBack = offerWords ? (
    <button
      type="button"
      className="linklike tap-pad"
      onClick={() => {
        setDraft(ignored ?? "");
        setIgnored(null);
      }}
    >
      Copy my words back
    </button>
  ) : null;
  const existingLive = existingRun !== null && run?.id === existingRun && live;
  const notice = existingLive ? (
    <p className="coach-run-notice" role="status">
      {EXISTING_LINE}
      {wordsBack ? <> {wordsBack}</> : null}
    </p>
  ) : null;
  const failure = run && over ? failureOf({ status: status!, error: run.error }) : null;
  // The ways to train now wait for the reads they are made from, so the tiles never change under the athlete's finger.
  const tilesReady = !templates.isPending && !today.isPending;
  return (
    <div className="coach-area">
      {!live || existingLive ? (
        <Composer
          draft={draft}
          onDraft={setDraft}
          onStart={(scope) => start.mutate(scope)}
          busy={start.isPending}
          error={startError}
          focus={compose && !live}
          wordsBack={existingLive ? null : wordsBack}
        />
      ) : null}
      {run && status ? (
        <RunView
          run={run}
          status={status}
          events={events}
          inFlight={snapshot?.inFlight ?? false}
          dueRole={snapshot?.dueRole ?? null}
          lost={snapshot?.lost ?? false}
          onRetry={() => loop?.retry()}
          onRun={(r) => loop?.setRun(r)}
          onRefresh={() => void loop?.refresh()}
          notice={notice}
        />
      ) : null}
      {failure && proposalKnown && (proposed || tilesReady) ? <StoppedLine failure={failure} proposed={proposed} tiles={tiles} /> : null}
      {/* Whatever the run's status (fix A2): a suggestion the athlete can't decide yet (unreviewed while the coach works,
          closed with a cancel) is no card — the card hides it. */}
      {proposalId ? <ProposalCard proposalId={proposalId} flags={open?.flags ?? []} /> : null}
    </div>
  );
}

/** The field and the ways to start: Now, Later today, and the scope menu. */
export function Composer({
  draft,
  onDraft,
  onStart,
  busy = false,
  error = null,
  focus = false,
  nextN = NEXT_N_DEFAULT,
  wordsBack = null,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onStart: (scope: CoachRunScope) => void;
  busy?: boolean;
  error?: string | null;
  /** Focus the field once (the Plan coach sheet's link). */
  focus?: boolean;
  nextN?: number;
  /** The words a tap carried that the coach didn't start, offered back ("Copy my words back"; M4). */
  wordsBack?: ReactNode;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);
  const near = draft.length >= COUNTER_FROM;
  return (
    <div className="coach-composer-box" role="group" aria-label="Ask the coach">
      <label className="visually-hidden" htmlFor={id}>
        What would help today?
      </label>
      <textarea
        ref={field}
        id={id}
        className="stu-field coach-composer-field"
        rows={2}
        maxLength={REQUEST_MAX_CHARS}
        placeholder="What would help today?"
        value={draft}
        disabled={busy}
        onChange={(e) => onDraft(e.target.value)}
      />
      {near ? (
        <span className="coach-composer-count" aria-live="polite">
          {draft.length} / {REQUEST_MAX_CHARS}
        </span>
      ) : null}
      {wordsBack ? <p className="coach-composer-back">{wordsBack}</p> : null}
      <div className="coach-composer-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStart({ kind: "now" })}>
          Now
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => onStart({ kind: "later_today" })}>
          Later today
        </button>
        <ScopeMenu nextN={nextN} busy={busy} onPick={onStart} />
      </div>
      {error ? (
        <p className="coach-composer-error" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The scope menu's least width (the save menu's 13rem) and the gutter it keeps from the viewport's edge. */
const SCOPE_MENU_MIN_PX = 208;
const SCOPE_MENU_GUTTER_PX = 16;

/** "Plan ahead": This week · Next N workouts — a menu as the Studio's others are (Escape, a tap elsewhere, the arrows). */
function ScopeMenu({ nextN, busy, onPick }: { nextN: number; busy: boolean; onPick: (scope: CoachRunScope) => void }) {
  const [open, setOpen] = useState(false);
  /** The menu opens toward the side with room: from the button's left edge, or — near the right edge — its right. */
  const [toEnd, setToEnd] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEscapeKey(open, () => {
    setOpen(false);
    button.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const choices: Array<{ label: string; scope: CoachRunScope }> = [
    { label: "This week", scope: { kind: "week" } },
    { label: `Next ${nextN} workouts`, scope: { kind: "next_n", n: nextN } },
  ];
  return (
    <div className="coach-scope" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={busy}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          // The menu is at least SCOPE_MENU_MIN_PX wide: past the viewport's edge from the left, it opens to the left.
          if (r && typeof window !== "undefined") setToEnd(r.left + SCOPE_MENU_MIN_PX > window.innerWidth - SCOPE_MENU_GUTTER_PX);
          setOpen((v) => !v);
        }}
      >
        Plan ahead
        <span className="coach-scope-chev" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>
      <div
        id={id}
        role="menu"
        aria-label="Plan ahead"
        className={`stu-save-menu coach-scope-menu${toEnd ? " coach-scope-menu--end" : ""}`}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
          const at = all.indexOf(document.activeElement as HTMLElement);
          all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
        }}
      >
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            role="menuitem"
            className="stu-save-item"
            onClick={() => {
              setOpen(false);
              onPick(c.scope);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
