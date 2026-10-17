/**
 * THE COACH IN THE STUDIO (Stage 3 spec §10; Task 9): the composer at the top of the Studio home, and in its place, while
 * the coach works, the run view.
 *
 *   ASK THE COACH
 *   [ What would help today?                       ]
 *   [ Now ]  [ Later today ]  [ Plan ahead ▾ ]          ← Next 7 days · Next N workouts
 *
 *  - Settings → Coach (Task 10) decides the primary button — the athlete's default scope — and N. For the next 7 days
 *    or the next workouts it is one tap named for what it starts ("Plan the next 7 days"), a ▾ beside it for the menu,
 *    its item marked, and what such a plan usually costs right under it (fix wave 3B, M4, M10; the re-review). Any
 *    other default: Plan ahead opens the menu, and no set's cost is said. Unreadable (a 404, offline): Now, and the
 *    next three.
 *  - Opening the Studio finds the athlete's run (`GET /api/coach/runs/current`): a live one shows in place of the empty
 *    composer and goes on stepping; one that is over with a suggestion still open shows under the composer, its card
 *    with it. Rehearsals never come back.
 *  - Now / Later today / a scope from the menu start a run with the field's words. When the athlete already has the coach
 *    working on something, the server answers that run (`existing`): it opens, with one line saying so, and the words
 *    this tap carried are offered back into the field — never dropped silently.
 *  - A set (this week, the next workouts) shows its estimate once its plan made one, beside the limit — or beside what
 *    the week has left, when that is the tighter limit (Task 13, D11); Cancel is there.
 *  - The week's AI budget (the spend Settings shows; Task 13, R11/M6): past its cutoff, one plain line where the ways to
 *    start were; a start the server refuses for it (409 `week_budget`) one plain line, the words kept in the field.
 *  - A run that stops says what stopped it and what happens next; its suggestion's card follows when it proposed what was
 *    reviewed, and otherwise up to three ways to train now.
 *  - Under the card, "Also waiting": the other suggestions still open (the current read's `alsoOpen`, Task 13 R2), a
 *    compact line each that opens its own card.
 *  - A 404 from the coach's routes: the server's coach is off. One quiet line, and nothing asked again.
 *
 * Shown only with the coach designer on (`coachOn`): the Studio home renders this in its slot — and the app's coach sheet
 * renders the same area anywhere (`CoachArea`, coach-sheet.tsx; coach everywhere, A3), with what the athlete asked from
 * as a chip on the composer, and the card's "Change something…" follow-up (A2).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CoachOpenProposalDto, type CoachRunDto, type CoachRunEventDto, type CoachRunFocus, type CoachRunScope } from "@rg/api-client";
import { COACH_NEXT_N, coachSettings, type CoachScopeKind } from "@rg/domain";
import { useEscapeKey } from "../../components.js";
import { COACH_PREFERENCES_QUERY } from "../settings/coach-settings.js";
import { IconChevron, IconClose } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { AlsoWaiting } from "./also-waiting.js";
import { CoachBoundary } from "./coach-boundary.js";
import { focusOfWire, focusRefusal, focusScope, type CoachFocus } from "./coach-focus.js";
import { readCurrent, readProposal } from "./coach-tolerance.js";
import type { StudioCtx } from "./model.js";
import { cardShows, designProposalQuery, ProposalCard } from "./proposal-card.js";
import { COACH_CURRENT_QUERY, currentRetry } from "./run-keeper.js";
import {
  existingLine,
  failureOf,
  fallbackTiles,
  isLive,
  isNotAvailable,
  isSetScope,
  NOT_AVAILABLE_LINE,
  usd,
  WEEK_USED_UP_LINE,
  weekBudgetOf,
  weekBudgetRefusal,
  type ExistingOffer,
  type FallbackTile,
  type WeekBudget,
} from "./run-model.js";
import { RunView, StoppedLine } from "./run-view.js";
import { quickTiles, sortTemplates, templateHref, templateShape } from "./templates-model.js";
import { useCoachRun, type LoopDeps } from "./use-coach-run.js";
import { useOneTap } from "./use-one-tap.js";

/** The server's own cap on a request's words (coach-runs.ts REQUEST_MAX_CHARS). */
export const REQUEST_MAX_CHARS = 2_000;
/** The counter shows from here. */
export const COUNTER_FROM = 1_800;
/** How many workouts "Next N" plans until Settings → Coach says otherwise (Task 10). */
export const NEXT_N_DEFAULT = COACH_NEXT_N.default;

/** The current run's read (the app's run keeper reads it too). */
export { COACH_CURRENT_QUERY };

/** What the Studio's location may carry: the Plan coach sheet's link asks for the composer, focused. */
export interface CoachArrival {
  coach?: "compose";
  /** Words to start from (the objectives board's "Ask the coach for a test", fix wave 3B, B-I11): the athlete's to send. */
  request?: string;
}

/** A set as it is named on its one-tap button (the re-review): "Plan the next 7 days", "Plan the next 3 workouts". */
export function setScopeWords(scope: CoachScopeKind, nextN: number): string | null {
  return scope === "week" ? "the next 7 days" : scope === "next_n" ? `the next ${nextN} workouts` : null;
}

/**
 * What the default set usually costs, beside the button that starts it in one tap (fix wave 3B, M4; the re-review):
 * "A plan for the next 7 days usually costs about $3–5." — and, when the week has less left than a set's own limit
 * (Task 13, D11), "…; $2.10 left this week." None when the default is no set.
 */
export function setCostLine(scope: CoachScopeKind, nextN: number, weekLeftUsd: number | null = null, setCeilingUsd = Infinity): string | null {
  const words = setScopeWords(scope, nextN);
  if (!words) return null;
  const line = `A plan for ${words} usually costs about $3–5`;
  return weekLeftUsd !== null && weekLeftUsd < setCeilingUsd ? `${line}; ${usd(weekLeftUsd)} left this week.` : `${line}.`;
}

/** The spend's read (Settings → Coach reads it too). */
export const COACH_SPEND_QUERY = ["coach-spend"] as const;

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

/** The Studio home's coach: the area, with what the location brought (the Plan coach sheet's link, the old arrivals). */
export function StudioCoach({ ctx, loopDeps }: { ctx: StudioCtx; loopDeps?: () => LoopDeps }) {
  const location = useLocation();
  const arrival = location.state as CoachArrival | null;
  return (
    <CoachArea
      ctx={ctx}
      loopDeps={loopDeps}
      arrival={{ request: typeof arrival?.request === "string" ? arrival.request : null, compose: arrival?.coach === "compose" }}
    />
  );
}

/** What the coach area opens with: the words to start from, what it is about (a chip), a scope, and whether the field
 * takes the focus. */
export interface CoachAreaArrival {
  focus?: CoachFocus | null;
  request?: string | null;
  scope?: CoachScopeKind | null;
  compose?: boolean;
}

/** What a start sends: a scope (none: the athlete's default, or a follow-up's suggestion's own), the words, a focus. */
interface StartVars {
  scope?: CoachRunScope;
  request: string | null;
  focus?: CoachRunFocus | null;
  /** A follow-up from the card (A2): the composer's own words stay where they are. */
  followUp?: boolean;
}

/**
 * THE COACH'S AREA — the composer, the live run view, the suggestion's card — in the Studio home (`place: "studio"`)
 * and in the app's coach sheet (`place: "sheet"`, coach-sheet.tsx; coach everywhere, A3), the same components in both:
 *
 *  - A focus the area opens with is a chip on the composer ("About: …"), its ✕ takes it off; the start carries it as
 *    `{ kind, id }` and the focus's scope is the primary button (coach-focus.ts `focusScope`) — else the athlete's own
 *    default. A focus the server refuses (gone, a day out of reach, a set's suggestion) is said in plain words.
 *  - The suggestion's card offers "Change something…" under a pending single-workout suggestion: a follow-up, the
 *    suggestion as its focus and the words as its request, no scope (the server takes the suggestion's own); its run's
 *    trail takes the card's place, and its suggestion replaces the old one (A2).
 *  - In the sheet, the current run is shown only while it is live (one run at a time: a new ask there would only be
 *    answered by it); a run over is the Studio's to show, with "Also waiting".
 */
export function CoachArea({
  ctx,
  loopDeps,
  arrival = {},
  place = "studio",
}: {
  ctx: StudioCtx;
  loopDeps?: () => LoopDeps;
  arrival?: CoachAreaArrival;
  place?: "studio" | "sheet";
}) {
  const qc = useQueryClient();
  const inSheet = place === "sheet";
  // Read tolerantly (a newer server's fields), and asked again on a passing failure — never on a 404 (the coach is off).
  const current = useQuery({ queryKey: COACH_CURRENT_QUERY, queryFn: readCurrent, retry: currentRetry, staleTime: 0 });
  // Settings → Coach's read (Task 10), shared with its card: a 404 (or no read yet) is the defaults.
  const prefs = useQuery({ queryKey: COACH_PREFERENCES_QUERY, queryFn: api.coachPreferences, retry: false });
  const settings = prefs.data?.settings ?? coachSettings(null);
  // The week's AI budget (Task 13: R11, M6, D11): what Settings shows. Unreadable, nothing is said and nothing held back.
  const spend = useQuery({ queryKey: COACH_SPEND_QUERY, queryFn: api.coachSpend, retry: false });
  const budget = weekBudgetOf(spend.data);
  const [shown, setShown] = useState<Shown | null>(null);
  const [draft, setDraft] = useState(() => (typeof arrival.request === "string" ? arrival.request.slice(0, REQUEST_MAX_CHARS) : ""));
  /** What the athlete asked from (A3): the composer's chip until its ✕ takes it off. */
  const [about, setAbout] = useState<CoachFocus | null>(() => arrival.focus ?? null);
  /** The run an `existing` answer opened: its line shows while it is live. */
  const [existingRun, setExistingRun] = useState<{ id: string; offer: ExistingOffer } | null>(null);
  /** The words a tap carried that the coach didn't start: offered back until taken, or a new run starts (M4). */
  const [ignored, setIgnored] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The server's refusal of a start the week can't pay for (409 `week_budget`), in one plain line. */
  const [budgetLine, setBudgetLine] = useState<string | null>(null);
  /** The run a tap just started: the composer it was tapped in gives way, so the focus goes to the run (B-I9). */
  const [started, setStarted] = useState<string | null>(null);
  /**
   * The field takes the focus once: as the area first opens with no run to show (the sheet's open, the Plan coach link's
   * arrival) — never again once a start went out, or a live run was shown: a run that ends draws the composer again,
   * and the focus stays with its result (the review, I2: a screen reader moved off it, a phone's keyboard raised).
   */
  const [fieldFocus, setFieldFocus] = useState(() => arrival.compose === true || inSheet);
  /** The suggestion a follow-up was asked from (A2): shown again when the follow-up ends with none (the review, minor 3). */
  const [followedFrom, setFollowedFrom] = useState<string | null>(null);

  // Only a read made since this screen opened decides what it shows — a kept one may be a run long over (fix round,
  // Important 2). The first fresh read gives the run shown; a later one, a live run that isn't it (started on another
  // device, or after the one shown ended), takes its place. The sheet shows a run only while it is live.
  const found = current.isFetchedAfterMount && current.data && current.data.run && (!inSheet || isLive(current.data.run.status)) ? current.data : null;
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
  // A live run found as the area opens is about to be shown in the composer's place: no composer drawn (or focused) for
  // the moment before it is; and once one is shown, the field never takes the focus by itself (the review, I2).
  const adopting = shown === null && found !== null && isLive(found.run.status);
  useEffect(() => {
    if (live || adopting) setFieldFocus(false);
  }, [live, adopting]);

  // A run that is over: read current again (the suggestion it holds open, its flags — or a live run elsewhere), and the
  // suggestion's own read, which may be one kept from while it was unreviewed.
  const over = run !== null && status !== null && !live;
  useEffect(() => {
    if (!over) return;
    void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    void qc.invalidateQueries({ queryKey: ["coach-design-proposal"] });
    void qc.invalidateQueries({ queryKey: COACH_SPEND_QUERY });
  }, [over, run?.id, qc]);
  // A live set's estimate says what the week has left beside it (D11): read again as the set spends.
  const setCost = run && live && isSetScope(run) ? run.costUsd : null;
  useEffect(() => {
    if (setCost !== null) void qc.invalidateQueries({ queryKey: COACH_SPEND_QUERY });
  }, [setCost, qc]);

  // A double or triple tap on Now starts one run (the robustness pass): never a second create answered `existing`.
  const oneTap = useOneTap();
  const start = useMutation({
    networkMode: "always",
    mutationFn: (v: StartVars) =>
      api.coachRunCreate({ ...(v.scope ? { scope: v.scope } : {}), request: v.request, ...(v.focus ? { focus: v.focus } : {}) }),
    onSuccess: (res, v) => {
      setFollowedFrom(v.followUp && v.focus ? v.focus.id : null);
      setStartError(null);
      setBudgetLine(null);
      // A new run has no trail yet; the live run an `existing` answer opens has one, which its loop reads.
      setShown(res.existing ? { run: res.run } : { run: res.run, events: [] });
      // The words went with the tap; a live run already there answers instead, and they are offered back. A follow-up's
      // words were the card's: the composer's stay.
      if (!v.followUp) setDraft("");
      setExistingRun(res.existing ? { id: res.run.id, offer: res.offer } : null);
      setIgnored(res.existing ? res.ignoredRequest.request : null);
      // A live run already there keeps the composer on screen, the focus where it was.
      setStarted(res.existing ? null : res.run.id);
      void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    },
    onError: (e) => {
      // The week can't pay for it (§2.11): one plain line, the words kept in the field.
      // Said as a fact, in the ink a status is, never as a failure.
      const refused = weekBudgetRefusal(e);
      setBudgetLine(refused);
      // What it was asked about isn't one the server takes (A1): said plainly — before a 404 is read as the coach off.
      const focusLine = focusRefusal(e);
      if (refused) {
        setStartError(null);
        void qc.invalidateQueries({ queryKey: COACH_SPEND_QUERY });
      } else if (focusLine) setStartError(focusLine);
      else if (isNotAvailable(e)) setUnavailable(true);
      else setStartError("Couldn't reach the coach — try again.");
    },
  });

  // Whether the coach proposed something is the suggestion's own read: shown, or not (fix round, Important 1).
  const proposalId = run ? proposalIdOf(run, events, open, over) : null;
  const proposalRead = useQuery({
    queryKey: designProposalQuery(proposalId ?? ""),
    queryFn: () => readProposal(proposalId!),
    enabled: proposalId !== null,
    retry: false,
  });
  const proposed = cardShows(proposalRead.data);
  const proposalKnown = proposalId === null || proposalRead.isSuccess || proposalRead.isError;
  // The other suggestions still open (R2), from a read made since this screen opened — never the one the run shows.
  const alsoOpen = (current.isFetchedAfterMount ? (current.data?.alsoOpen ?? []) : []).filter((a) => a.proposalId !== proposalId);

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
  const existingLive = existingRun !== null && run?.id === existingRun.id && live;
  const notice = existingLive ? (
    <p className="coach-run-notice" role="status">
      {existingLine(existingRun.offer, status)}
      {wordsBack ? <> {wordsBack}</> : null}
    </p>
  ) : null;
  // A run that proposed is answered by its card (R3): never "Try a shorter request" over it.
  const failure = run && over ? failureOf({ status: status!, error: run.error }, { proposed }) : null;
  // The ways to train now wait for the reads they are made from, so the tiles never change under the athlete's finger.
  const tilesReady = !templates.isPending && !today.isPending;
  // The focus's scope is the primary way to start (A3); without one, the athlete's own default.
  const defaultScope = (arrival.scope ?? (about ? focusScope(about) : null)) || settings.defaultScope;
  // A follow-up that ended with no suggestion of its own — it failed, or was cancelled: the one it was asked from is
  // still the athlete's, and its card comes back (the review, minor 3).
  const followedBack = followedFrom !== null && over && proposalKnown && !proposed ? followedFrom : null;
  // A follow-up's failure is said on the card it was sent from; the composer's own, on the composer.
  const followUpFailed = start.isError && start.variables?.followUp === true;
  // A follow-up from the card (A2): the suggestion as the focus, the card's words as the request, no scope.
  const followUp = (id: string) => (words: string) =>
    oneTap(() => start.mutateAsync({ request: words, focus: { kind: "proposal", id }, followUp: true }));
  // Each piece in a boundary of its own (the robustness pass): one that fails to draw says so, the others stand.
  return (
    <div className="coach-area">
      {(!live || existingLive) && !adopting ? (
        <CoachBoundary>
          <Composer
            draft={draft}
            onDraft={setDraft}
            onStart={(scope) => oneTap(() => start.mutateAsync({ scope, request: draft.trim() || null, focus: about ? focusOfWire(about) : null }))}
            busy={start.isPending}
            error={followUpFailed ? null : startError}
            focus={fieldFocus && !live}
            defaultScope={defaultScope}
            nextN={settings.nextN}
            wordsBack={existingLive ? null : wordsBack}
            budget={budget}
            setCeilingUsd={settings.ceilingsUsd.set}
            budgetLine={budgetLine}
            about={about}
            onClearAbout={() => setAbout(null)}
          />
        </CoachBoundary>
      ) : null}
      {run && status ? (
        <CoachBoundary>
          <RunView
            run={run}
            status={status}
            events={events}
            inFlight={snapshot?.inFlight ?? false}
            dueRole={snapshot?.dueRole ?? null}
            lost={snapshot?.lost ?? false}
            workingSince={snapshot?.workingSince ?? null}
            onRetry={() => loop?.retry()}
            onRun={(r) => loop?.setRun(r)}
            onRefresh={() => void loop?.refresh()}
            notice={notice}
            focusKey={started !== null && run.id === started ? started : null}
            weekLeftUsd={budget?.leftUsd ?? null}
            today={ctx.today}
            timeZone={ctx.timeZone}
          />
        </CoachBoundary>
      ) : null}
      {failure && proposalKnown && (proposed || tilesReady) ? (
        <CoachBoundary>
          <StoppedLine failure={failure} proposed={proposed} tiles={tiles} />
        </CoachBoundary>
      ) : null}
      {/* Whatever the run's status (fix A2): a suggestion the athlete can't decide yet (unreviewed while the coach works,
          closed with a cancel) is no card — the card hides it. */}
      {proposalId ? (
        <CoachBoundary>
          <ProposalCard
            proposalId={proposalId}
            flags={open?.flags ?? []}
            today={ctx.today}
            onFollowUp={followUp(proposalId)}
            followUpBusy={start.isPending}
            followUpError={followUpFailed ? startError : null}
          />
        </CoachBoundary>
      ) : null}
      {followedBack ? (
        <CoachBoundary>
          <ProposalCard proposalId={followedBack} today={ctx.today} onFollowUp={followUp(followedBack)} followUpBusy={start.isPending} />
        </CoachBoundary>
      ) : null}
      {/* Always here in the Studio, so a card opened in it stays while it is open, even once its suggestion leaves the
          list (round 2). The sheet is about what it was opened from: the Studio says what else is waiting. */}
      {inSheet ? null : (
        <CoachBoundary>
          <AlsoWaiting items={alsoOpen} today={ctx.today} />
        </CoachBoundary>
      )}
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
  defaultScope = "now",
  nextN = NEXT_N_DEFAULT,
  wordsBack = null,
  budget = null,
  setCeilingUsd = Infinity,
  budgetLine = null,
  about = null,
  onClearAbout,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onStart: (scope: CoachRunScope) => void;
  busy?: boolean;
  error?: string | null;
  /** Focus the field once (the Plan coach sheet's link). */
  focus?: boolean;
  /** The athlete's default (Settings → Coach): its button is the primary one — Plan ahead's for a set, its item marked. */
  defaultScope?: CoachScopeKind;
  /** How many "Next N workouts" plans (Settings → Coach). */
  nextN?: number;
  /** The words a tap carried that the coach didn't start, offered back ("Copy my words back"; M4). */
  wordsBack?: ReactNode;
  /** The week's AI budget (Task 13): used up, one line where the ways to start were; tight, its left beside a set's cost. */
  budget?: WeekBudget | null;
  /** A set's own spending limit (Settings → Coach): the week is the tighter limit below it. */
  setCeilingUsd?: number;
  /** A start the week couldn't pay for, in one plain line (409 `week_budget`): a fact, never an error's red. */
  budgetLine?: string | null;
  /** What the athlete asked from (coach everywhere, A3): its chip, "About: …", over the field. */
  about?: CoachFocus | null;
  /** The chip's ✕: the start then carries no focus. */
  onClearAbout?: () => void;
}) {
  const id = useId();
  const headingId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focus) return;
    field.current?.focus();
    // …and once more after a dialog it opened in has taken the focus itself (the coach sheet: its effect runs after this
    // one).
    const t = setTimeout(() => field.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [focus]);
  const near = draft.length >= COUNTER_FROM;
  const cost = setCostLine(defaultScope, nextN, budget?.leftUsd ?? null, setCeilingUsd);
  const usedUp = budget?.usedUp === true;
  return (
    <div className="coach-composer-box" role="group" aria-labelledby={headingId}>
      {/* Named as the Studio's sections are, in their eyebrow (fix wave 3B, B-I10). */}
      <h2 id={headingId} className="eyebrow">
        Ask the coach
      </h2>
      {about ? (
        <p className="coach-about">
          <span className="coach-about-label">{`About: ${about.label}`}</span>
          {onClearAbout ? (
            <button type="button" className="coach-about-clear tap-pad" aria-label={`Remove “${about.label}”`} disabled={busy} onClick={onClearAbout}>
              <IconClose size={14} />
            </button>
          ) : null}
        </p>
      ) : null}
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
      {usedUp ? (
        // Past the week's cutoff (R11, M6): the line, instead of a run that would stop at once.
        <p className="coach-composer-used" role="status">
          {WEEK_USED_UP_LINE}
        </p>
      ) : (
        <>
          <div className="coach-composer-actions">
            <button type="button" className={btnFor(defaultScope === "now")} disabled={busy} onClick={() => onStart({ kind: "now" })}>
              Now
            </button>
            <button type="button" className={btnFor(defaultScope === "later_today")} disabled={busy} onClick={() => onStart({ kind: "later_today" })}>
              Later today
            </button>
            <ScopeMenu nextN={nextN} defaultScope={defaultScope} busy={busy} onPick={onStart} />
          </div>
          {cost ? <p className="coach-composer-cost">{cost}</p> : null}
        </>
      )}
      {budgetLine && !usedUp ? (
        <p className="coach-composer-used" role="status">
          {budgetLine}
        </p>
      ) : null}
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

/** A scope's button: the primary one for the athlete's default. */
const btnFor = (isDefault: boolean): string => (isDefault ? "btn btn-primary" : "btn");

/**
 * "Plan ahead": Next 7 days · Next N workouts — a menu as the Studio's others are (Escape, a tap elsewhere, the arrows).
 * The athlete's default a set (fix wave 3B, M10): Plan ahead is the primary button and one tap — it starts that set at
 * once — and a small ▾ beside it opens the menu, the default's item saying so.
 */
function ScopeMenu({
  nextN,
  defaultScope,
  busy,
  onPick,
}: {
  nextN: number;
  defaultScope: CoachScopeKind;
  busy: boolean;
  onPick: (scope: CoachRunScope) => void;
}) {
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
    { label: "Next 7 days", scope: { kind: "week" } },
    { label: `Next ${nextN} workouts`, scope: { kind: "next_n", n: nextN } },
  ];
  const setDefault = choices.find((c) => c.scope.kind === defaultScope)?.scope ?? null;
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    // The menu is at least SCOPE_MENU_MIN_PX wide: past the viewport's edge from the left, it opens to the left.
    if (r && typeof window !== "undefined") setToEnd(r.left + SCOPE_MENU_MIN_PX > window.innerWidth - SCOPE_MENU_GUTTER_PX);
    setOpen((v) => !v);
  };
  const chevron = (
    <span className="coach-scope-chev" aria-hidden="true">
      <IconChevron size={14} />
    </span>
  );
  return (
    <div className={`coach-scope${setDefault ? " coach-scope--split" : ""}`} ref={wrap}>
      {setDefault ? (
        <>
          {/* Named for what one tap starts (the re-review). */}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onPick(setDefault)}>
            {`Plan ${setScopeWords(defaultScope, nextN)}`}
          </button>
          <button
            ref={button}
            type="button"
            className="btn coach-scope-more"
            aria-label="More ways to plan ahead"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={id}
            disabled={busy}
            onClick={toggle}
          >
            {chevron}
          </button>
        </>
      ) : (
        <button ref={button} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} disabled={busy} onClick={toggle}>
          Plan ahead
          {chevron}
        </button>
      )}
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
            aria-current={c.scope.kind === defaultScope ? true : undefined}
            onClick={() => {
              setOpen(false);
              onPick(c.scope);
            }}
          >
            {c.label}
            {c.scope.kind === defaultScope ? <span className="coach-scope-default"> · your default</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
