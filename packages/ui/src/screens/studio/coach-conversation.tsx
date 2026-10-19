/**
 * THE COACH, A CONVERSATION (the new shape §5, 2026-10-17; the owner: "this is a general coach that should be able to
 * help with anything"). The app's coach sheet holds one conversation per athlete, read from the server
 * (`GET /api/coach/conversation`) every time it opens — so it continues across screens, reloads and devices:
 *
 *   Something for my hips                         ← the athlete's words, right
 *   🌱 Here's a gentle one for your hips.         ← the coach's line or answer, left, with its mark
 *      [ the suggestion's card ]                  ← cards inline: a workout, changes to the plan, a set
 *      How the coach made this ▸                  ← its trail, one tap down
 *   make it 10 minutes
 *      Coach · designing ── ✓ … ● Reviewing…      ← while a run works, its trail, quieter; a question's answers
 *   Seeing: Sun 18 Oct · Long run ✕               ← what it was opened from: a hint, dismissible
 *   [ Reply                                  (↑) ]
 *
 *  - Each message is one run with no scope (an auto run: the coach decides whether to answer, design, change the plan
 *    or plan a week), the conversation it continues, and what the coach sees as its focus. No time-frame buttons.
 *  - With nothing to show yet, the opening screen (coach-opening.tsx): a line from the day, starter chips, and ways to
 *    start yourself.
 *  - A single question answers with one tap, or in the athlete's own words in the box.
 *  - One run at a time: while the coach works nothing more is sent; the run already there (`existing`) shows, with one
 *    line, the words kept. The week's budget, a refused focus, no connection: one plain line each, the words kept. The
 *    coach off (a 404): one quiet line, and no box.
 *  - The focus: the box takes it as the sheet opens on a new conversation (or with words written for the athlete) —
 *    once; a send moves it to the run; a run ending moves it to the coach's line, never into the box (a phone's
 *    keyboard, a screen reader).
 *
 * The run goes on when the sheet closes: the app's run keeper steps it on any screen.
 */
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type CoachConversationCardDto,
  type CoachConversationTurnDto,
  type CoachRunDto,
  type CoachRunEventDto,
} from "@rg/api-client";
import { IconArrowUp, IconClose } from "../../icons.js";
import { useBottomAnchor } from "../coach-panel.js";
import { useCoachSeen } from "./coach-ask.js";
import { CoachBoundary } from "./coach-boundary.js";
import {
  boxPlaceholder,
  cardIsOpen,
  closedCardLine,
  CONVERSATION_QUERY,
  NUDGES_QUERY,
  conversationToSend,
  turnsShown,
  turnStopLine,
  type ProvisionalTurn,
} from "./coach-conversation-model.js";
import { focusOfWire, focusRefusal, type CoachFocus } from "./coach-focus.js";
import { CoachOpening, CoachSays } from "./coach-opening.js";
import { readConversation, readCurrent } from "./coach-tolerance.js";
import type { StudioCtx } from "./model.js";
import { PlanCard } from "./plan-card.js";
import { PlanChangesCard } from "./plan-changes-card.js";
import { ProposalCard } from "./proposal-card.js";
import { COACH_CURRENT_QUERY, currentRetry } from "./run-keeper.js";
import {
  answerOf,
  askedOf,
  existingLine,
  isLive,
  isNotAvailable,
  NOT_AVAILABLE_LINE,
  STILL_WORKING_LINE,
  WEEK_USED_UP_LINE,
  weekBudgetOf,
  weekBudgetRefusal,
  type ExistingOffer,
} from "./run-model.js";
import { RunView, TurnTrail } from "./run-view.js";
import { useCoachRun, type LoopDeps } from "./use-coach-run.js";
import { useOneTap } from "./use-one-tap.js";

/** The server's own cap on a request's words (coach-runs.ts REQUEST_MAX_CHARS). */
export const REQUEST_MAX_CHARS = 2_000;
/** The counter shows from here. */
export const COUNTER_FROM = 1_800;
/** The spend's read (Settings → Coach reads it too). */
export const COACH_SPEND_QUERY = ["coach-spend"] as const;
/** The box, while the coach waits on one question: the athlete's own words answer it. */
export const BOX_PLACEHOLDER_ANSWER = "Answer in your own words";
/** A send that didn't reach the coach. */
export const COULDNT_REACH_LINE = "Couldn't reach the coach — try again.";

export interface CoachConversationProps {
  ctx: StudioCtx;
  loopDeps?: () => LoopDeps;
  /** Words written in the box for the athlete to send (`open({ request })`). */
  request?: string | null;
  /** What the coach sees as the sheet opens: the "Seeing" hint. */
  seeing?: CoachFocus | null;
  /** Opened with nothing named (the nav's Coach): what the screen registers is what it sees, until dropped. */
  followSeen?: boolean;
  /** The conversation the athlete left ("New conversation"): not shown, and a send starts a new one. */
  left?: string | null;
}

/** The coach's words, as paragraphs (an answer may hold a few). */
function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => <p key={i}>{p}</p>);
}

export function CoachConversation({ ctx, loopDeps, request = null, seeing: seenAtOpen = null, followSeen = false, left = null }: CoachConversationProps) {
  const qc = useQueryClient();
  const conv = useQuery({ queryKey: CONVERSATION_QUERY, queryFn: readConversation, retry: currentRetry, staleTime: 0 });
  // The current run: a live one the conversation doesn't hold (an older client's), the suggestions still open, and a
  // 404 that says the coach is off. Read tolerantly, and only a read made since the sheet opened decides.
  const current = useQuery({ queryKey: COACH_CURRENT_QUERY, queryFn: readCurrent, retry: currentRetry, staleTime: 0 });
  const spend = useQuery({ queryKey: COACH_SPEND_QUERY, queryFn: api.coachSpend, retry: false });
  const budget = weekBudgetOf(spend.data);

  const [draft, setDraft] = useState(() => (request ?? "").slice(0, REQUEST_MAX_CHARS));
  // What it sees: what it was opened with — or, opened with nothing named, what the screen registers (a screen still
  // loading its data registers a moment after the tap) — until the athlete's ✕ drops it.
  const registered = useCoachSeen();
  const [dropped, setDropped] = useState(false);
  const seeing = dropped ? null : followSeen ? (registered ?? seenAtOpen) : seenAtOpen;
  const setSeeing = (f: null) => setDropped(f === null);
  /** Turns a send here started, until the read has them. */
  const [sent, setSent] = useState<ProvisionalTurn[]>([]);
  /** The conversation the server last named for a send. */
  const [created, setCreated] = useState<string | null>(null);
  /** The run a send here started (or the one already there), with what the screen holds of it. */
  const [seed, setSeed] = useState<{ run: CoachRunDto; events?: CoachRunEventDto[] } | null>(null);
  const [existing, setExisting] = useState<{ runId: string; offer: ExistingOffer } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [budgetLine, setBudgetLine] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** The run a send here started: its heading takes the focus (the box it was sent from stays, but the run is news). */
  const [started, setStarted] = useState<string | null>(null);

  const foundLive = current.isFetchedAfterMount && current.data?.run && isLive(current.data.run.status) ? current.data : null;
  const extra = useMemo<ProvisionalTurn[]>(() => {
    const out = [...sent];
    if (foundLive && !out.some((s) => s.runId === foundLive.run.id)) {
      out.push({ runId: foundLive.run.id, words: foundLive.run.request, at: foundLive.run.createdAt, status: foundLive.run.status });
    }
    return out;
  }, [sent, foundLive]);
  const turns = turnsShown(conv.data, left, extra);

  // The live run: the newest turn the read says is at work (one run at a time).
  const liveTurn = [...turns].reverse().find((t) => isLive(t.status)) ?? null;
  const liveId = liveTurn?.runId ?? null;
  const loopSeed = liveId && foundLive?.run.id === liveId ? { run: foundLive.run, events: foundLive.events } : seed && seed.run.id === liveId ? seed : {};
  const { snapshot, loop } = useCoachRun(liveId, loopSeed, loopDeps);
  const liveRun = snapshot?.run ?? (seed?.run.id === liveId ? seed.run : null) ?? (foundLive?.run.id === liveId ? foundLive.run : null);
  const liveStatus = snapshot?.status ?? liveTurn?.status ?? null;
  const working = liveId !== null && liveStatus !== null && isLive(liveStatus);

  // A run over: the conversation read again (its line, its cards), the current run, the suggestions, the spend.
  const over = liveId !== null && liveStatus !== null && !isLive(liveStatus);
  useEffect(() => {
    if (!over) return;
    void qc.invalidateQueries({ queryKey: CONVERSATION_QUERY });
    void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
    void qc.invalidateQueries({ queryKey: ["coach-design-proposal"] });
    void qc.invalidateQueries({ queryKey: COACH_SPEND_QUERY });
  }, [over, liveId, qc]);

  // A run that ended in words (an answer, the new shape §5): the coach's words at once, whole — the conversation's read
  // of its line may come a moment later.
  const liveAnswer = liveId !== null && !working ? answerOf(snapshot?.events ?? []) : null;
  /** A turn shown as over: the read says so, or the live run ended in words. */
  const turnOver = (t: CoachConversationTurnDto): boolean => !isLive(t.status) || (t.runId === liveId && liveAnswer !== null);

  // The single question the run waits on: the box answers it in the athlete's own words.
  const asked = liveStatus === "waiting_athlete" ? askedOf(snapshot?.events ?? []) : null;
  const answering = asked?.kind === "questions" && asked.questions.length === 1;

  const oneTap = useOneTap();
  const start = useMutation({
    networkMode: "always",
    mutationFn: (words: string) => {
      const conversationId = conversationToSend({ read: conv.data, readFailed: conv.isError, created, left });
      return api.coachRunCreate({
        request: words,
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(seeing ? { focus: focusOfWire(seeing) } : {}),
      });
    },
    onSuccess: (res, words) => {
      setLine(null);
      setBudgetLine(null);
      if (res.conversationId) setCreated(res.conversationId);
      // The run already there answered: it shows, one line says so, and the words stay in the box.
      setExisting(res.existing ? { runId: res.run.id, offer: res.offer } : null);
      if (!res.existing) setDraft("");
      setStarted(res.existing ? null : res.run.id);
      // A new run has no trail yet; the one already there has one, which its loop reads.
      setSeed(res.existing ? { run: res.run } : { run: res.run, events: [] });
      setSent((s) =>
        s.some((x) => x.runId === res.run.id)
          ? s
          : [...s, { runId: res.run.id, words: res.existing ? res.run.request : words, at: res.run.createdAt, status: res.run.status }],
      );
      void qc.invalidateQueries({ queryKey: CONVERSATION_QUERY });
      void qc.invalidateQueries({ queryKey: COACH_CURRENT_QUERY });
      // A turn sent may have asked what a "needs you" chip offers (review-3 I1): the chips are read again now, though no
      // opening shows them — the next opening never shows a stale one first.
      void qc.invalidateQueries({ queryKey: NUDGES_QUERY, refetchType: "all" });
    },
    onError: (e) => {
      // The week can't pay for it (§2.11): a fact, in the ink a status is — the words kept.
      const refused = weekBudgetRefusal(e);
      setBudgetLine(refused);
      // What it sees isn't one the server takes: said plainly — before a 404 is read as the coach off.
      const focusLine = focusRefusal(e);
      if (refused) {
        setLine(null);
        void qc.invalidateQueries({ queryKey: COACH_SPEND_QUERY });
      } else if (focusLine) setLine(focusLine);
      else if (isNotAvailable(e)) setUnavailable(true);
      else setLine(COULDNT_REACH_LINE);
    },
  });
  const answer = useMutation({
    networkMode: "always",
    mutationFn: (v: { runId: string; words: string }) => api.coachRunAnswer(v.runId, { answers: [v.words] }),
    onSuccess: (res) => {
      setDraft("");
      setLine(null);
      loop?.setRun(res.run);
      void qc.invalidateQueries({ queryKey: NUDGES_QUERY, refetchType: "all" });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        setLine("The coach isn't waiting on this any more.");
        void loop?.refresh();
      } else {
        const why = e instanceof ApiError && e.status === 400 ? (e.body as { why?: unknown } | null)?.why : null;
        setLine(typeof why === "string" ? why : "Couldn't send that — try again.");
      }
    },
  });

  const usedUp = budget?.usedUp === true;
  const busy = start.isPending || answer.isPending;
  const canSend = draft.trim() !== "" && !busy && !usedUp && (!working || answering);
  const send = (words: string) => {
    const said = words.trim();
    if (!said || busy || usedUp) return;
    if (working) {
      if (answering && liveId) void oneTap(() => answer.mutateAsync({ runId: liveId, words: said }));
      return;
    }
    void oneTap(() => start.mutateAsync(said));
  };

  // ── The focus ──
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const settled = conv.isFetchedAfterMount || conv.isError;
  /** The box takes the focus once: as the sheet opens on nothing to show yet, or with words written for the athlete. */
  const focusDecided = useRef(false);
  useEffect(() => {
    if (focusDecided.current || !settled) return;
    focusDecided.current = true;
    if (!(request || turns.length === 0)) return;
    boxRef.current?.focus();
    // …and once more after the dialog has taken the focus itself (its effect runs after this one).
    const t = setTimeout(() => boxRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [settled, request, turns.length]);
  // A run that ends here: the focus goes to what the coach said — never into the box.
  const watched = useRef<string | null>(null);
  const [focusTurn, setFocusTurn] = useState<string | null>(null);
  useEffect(() => {
    if (working && liveId) watched.current = liveId;
  }, [working, liveId]);
  useEffect(() => {
    const id = watched.current;
    const t = id ? turns.find((x) => x.runId === id) : null;
    if (!id || !t || !turnOver(t)) return;
    watched.current = null;
    setFocusTurn(id);
  });
  useEffect(() => {
    if (!focusTurn) return;
    const root = scroller.current;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return setFocusTurn(null);
    const said = [...(root?.querySelectorAll<HTMLElement>("[data-turn]") ?? [])].find((el) => el.dataset.turn === focusTurn);
    const reply = [...(root?.querySelectorAll<HTMLElement>("[data-turn-reply]") ?? [])].find((el) => el.dataset.turnReply === focusTurn);
    const to = said ?? reply;
    if (!to) return;
    to.focus();
    setFocusTurn(null);
  });

  // ── The scroll: the newest at the bottom, kept there as turns arrive (never while the athlete reads up) ──
  const signature = `${turns.map((t) => `${t.runId}:${t.status}:${t.line?.length ?? 0}:${t.cards.length}`).join(",")}|${snapshot?.events.length ?? 0}`;
  // The opening screen reads from its first line down (the coach's line above its chips); a conversation from its newest.
  const anchor = useBottomAnchor(signature, settled && turns.length === 0);
  const setScroller = (el: HTMLDivElement | null) => {
    scroller.current = el;
    anchor.ref.current = el;
  };

  if (unavailable || isNotAvailable(conv.error) || isNotAvailable(current.error)) {
    return (
      <div className="sheet-body scroller coach-convo-scroll">
        <p className="coach-off" role="status">
          {NOT_AVAILABLE_LINE}
        </p>
      </div>
    );
  }

  const opening = settled && turns.length === 0;
  const alsoOpen = current.isFetchedAfterMount ? (current.data?.alsoOpen ?? []) : [];
  // The opening draws once this read has answered since the sheet opened, or failed (after its retries): "Also waiting"
  // never arrives late. (Offline the conversation's own read hasn't answered either, and no opening is drawn.)
  const alsoKnown = current.isFetchedAfterMount;
  const existingLive = existing !== null && existing.runId === liveId && working;
  const placeholder = working && answering ? BOX_PLACEHOLDER_ANSWER : boxPlaceholder(turns.length);
  const lastIndex = turns.length - 1;
  return (
    <>
      <div ref={setScroller} className="sheet-body scroller coach-convo-scroll" onScroll={anchor.onScroll} onPointerDownCapture={anchor.onInteract} onKeyDownCapture={anchor.onInteract}>
        <div className="coach-convo">
          {opening ? (
            <CoachBoundary>
              <CoachOpening ctx={ctx} seeing={seeing} alsoOpen={alsoOpen} alsoKnown={alsoKnown} busy={busy || usedUp} onAsk={send} />
            </CoachBoundary>
          ) : null}
          {turns.length > 0 ? (
            <ol className="coach-turns">
              {turns.map((t, i) => (
                <li key={t.runId} className="coach-turn">
                  {t.words ? <p className="coach-msg coach-msg--athlete">{t.words}</p> : null}
                  {t.runId === liveId && (working || isLive(t.status)) && liveAnswer === null ? (
                    <CoachBoundary>
                      {liveRun && liveStatus ? (
                        <RunView
                          run={liveRun}
                          status={liveStatus}
                          events={snapshot?.events ?? []}
                          inFlight={snapshot?.inFlight ?? false}
                          dueRole={snapshot?.dueRole ?? null}
                          lost={snapshot?.lost ?? false}
                          workingSince={snapshot?.workingSince ?? null}
                          onRetry={() => loop?.retry()}
                          onRun={(r) => loop?.setRun(r)}
                          onRefresh={() => void loop?.refresh()}
                          focusKey={started !== null && liveRun.id === started ? started : null}
                          weekLeftUsd={budget?.leftUsd ?? null}
                          today={ctx.today}
                          timeZone={ctx.timeZone}
                          quiet
                        />
                      ) : (
                        <p className="coach-run-note" role="status">
                          {STILL_WORKING_LINE}
                        </p>
                      )}
                    </CoachBoundary>
                  ) : (
                    <TurnReply
                      turn={t.runId === liveId && liveAnswer !== null && !t.line ? { ...t, status: liveStatus ?? t.status, line: liveAnswer } : t}
                      latest={i === lastIndex}
                      today={ctx.today}
                      timeZone={ctx.timeZone}
                    />
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
      <div className="coach-convo-foot">
        {existingLive ? (
          <p className="coach-run-notice" role="status">
            {existingLine(existing.offer, liveStatus)}
          </p>
        ) : null}
        {usedUp ? (
          <p className="coach-composer-used" role="status">
            {WEEK_USED_UP_LINE}
          </p>
        ) : null}
        {budgetLine && !usedUp ? (
          <p className="coach-composer-used" role="status">
            {budgetLine}
          </p>
        ) : null}
        {line ? (
          <p className="coach-composer-error" role="status">
            {line}
          </p>
        ) : null}
        <CoachBox
          boxRef={boxRef}
          draft={draft}
          onDraft={setDraft}
          placeholder={placeholder}
          canSend={canSend}
          onSend={() => send(draft)}
          seeing={seeing}
          onDropSeeing={() => {
            setSeeing(null);
            // The ✕ goes with the line: the focus to the box, never to the page.
            boxRef.current?.focus();
          }}
          held={request !== null && draft === request.slice(0, REQUEST_MAX_CHARS)}
        />
      </div>
    </>
  );
}

/** A turn over: what the coach said (or how it stopped), its cards, its trail one tap down. */
function TurnReply({ turn, latest, today, timeZone }: { turn: CoachConversationTurnDto; latest: boolean; today: string | null; timeZone: string | null }) {
  const said = turn.line?.trim() || (turn.cards.length === 0 ? turnStopLine(turn.status) : null);
  return (
    <div className="coach-turn-reply" data-turn-reply={turn.runId} tabIndex={-1}>
      {said ? (
        <CoachSays turn={turn.runId} focusable>
          {paragraphs(said)}
        </CoachSays>
      ) : null}
      {turn.cards.length > 0 ? (
        <div className="coach-turn-cards">
          <TurnCards cards={turn.cards} latest={latest} today={today} />
        </div>
      ) : null}
      <TurnTrail runId={turn.runId} today={today} timeZone={timeZone} />
    </div>
  );
}

/**
 * A turn's cards: a suggestion still open is its full card — a workout's (its changes to the plan its own card beside
 * it), a set's — and the newest turn's are full whatever came of them, so a decision's outcome stays in view; an older
 * one closed is one line of what came of it, its card one tap down. Each in its own boundary.
 */
function TurnCards({ cards, latest, today }: { cards: readonly CoachConversationCardDto[]; latest: boolean; today: string | null }) {
  const changesOf = new Set(cards.filter((c) => c.kind === "plan_changes").map((c) => c.proposalId));
  return (
    <>
      {cards.map((card) => {
        // A programme change's card is one a programme (§8 §5): its op tells two apart.
        const key = `${card.kind}:${card.proposalId}${card.opId ? `:${card.opId}` : ""}`;
        const part = card.kind === "plan_changes" ? "changes" : card.kind === "workout" && changesOf.has(card.proposalId) ? "workouts" : undefined;
        let body;
        // A whole plan (§8 §5): its own card, closed as one line of what came of it when an older turn's is done.
        if (card.kind === "plan" || card.kind === "programme") body = <PlanCard card={card} closed={!latest && !cardIsOpen(card)} />;
        else if (!latest && !cardIsOpen(card)) body = <ClosedCard card={card} today={today} part={part} />;
        else if (card.kind === "plan_changes") body = <PlanChangesCard card={card} today={today} />;
        // A designed run (§8 §3): the workout card, its body the run's steps and its watch line (the line's `run`).
        else if (card.kind === "workout" && card.sport === "run") body = <ProposalCard proposalId={card.proposalId} today={today} part={part} />;
        else if (card.kind === "workout" || card.kind === "set") body = <ProposalCard proposalId={card.proposalId} today={today} part={part} />;
        // A kind this bundle doesn't know: its one line, its card one tap down.
        else body = <ClosedCard card={card} today={today} />;
        return (
          <Fragment key={key}>
            <CoachBoundary>{body}</CoachBoundary>
          </Fragment>
        );
      })}
    </>
  );
}

/** One line of what came of a suggestion; its card one tap down. */
function ClosedCard({ card, today, part }: { card: CoachConversationCardDto; today: string | null; part?: "workouts" | "changes" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="coach-card-closed">
      <p className="coach-card-closed-line">
        {closedCardLine(card)}{" "}
        <button type="button" className="linklike tap-pad" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </p>
      <div id={id} hidden={!open}>
        {open ? <ProposalCard proposalId={card.proposalId} today={today} part={part} /> : null}
      </div>
    </div>
  );
}

/** The box's height at most (about six lines), when the stylesheet's own max-height can't be read. */
export const BOX_MAX_HEIGHT_PX = 150;

/** The device's primary pointer is a touch screen: its Return is a new line, and the button sends. */
export const touchFirst = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/** The box as tall as its words, up to its max-height (then it scrolls): never a grip to drag. */
function fit(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const max = Number.parseFloat(getComputedStyle(el).maxHeight) || BOX_MAX_HEIGHT_PX;
  // The border too: the field's box is its border's.
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${Math.min(el.scrollHeight + (border > 0 ? border : 0), max)}px`;
}

/**
 * The box: "Ask anything" (or "Reply"), a round send button, and over it what the coach sees — muted, with ✕ to drop it.
 * It grows with its words up to about six lines. With a keyboard, Return sends and Shift+Return is a new line; on a
 * touch screen Return is a new line and the button sends. Words an action wrote (`held`: `open({ request })`) are never
 * sent by a stray Return — only by the button, or once the athlete has changed them. An empty box sends nothing.
 */
export function CoachBox({
  boxRef,
  draft,
  onDraft,
  placeholder,
  canSend,
  onSend,
  seeing,
  onDropSeeing,
  held = false,
}: {
  boxRef: RefObject<HTMLTextAreaElement>;
  draft: string;
  onDraft: (v: string) => void;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  seeing: CoachFocus | null;
  onDropSeeing: () => void;
  /** The words are an action's, as it wrote them: Return doesn't send them. */
  held?: boolean;
}) {
  const id = useId();
  const near = draft.length >= COUNTER_FROM;
  useLayoutEffect(() => fit(boxRef.current), [draft, boxRef]);
  return (
    <form
      className="coach-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      {seeing ? (
        <p className="coach-seeing">
          <span className="coach-seeing-label">{`Seeing: ${seeing.label}`}</span>
          <button type="button" className="coach-seeing-drop tap-pad" aria-label={`Stop showing the coach “${seeing.label}”`} onClick={onDropSeeing}>
            <IconClose size={14} />
          </button>
        </p>
      ) : null}
      <div className="coach-box-row">
        <label className="visually-hidden" htmlFor={id}>
          {placeholder}
        </label>
        <textarea
          ref={boxRef}
          id={id}
          className="stu-field coach-box-field"
          rows={1}
          maxLength={REQUEST_MAX_CHARS}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            // A touch screen's Return is a new line: the button sends.
            if (touchFirst()) return;
            e.preventDefault();
            if (canSend && !held) onSend();
          }}
        />
        <button type="submit" className="coach-send" aria-label="Send" disabled={!canSend}>
          <IconArrowUp size={18} />
        </button>
      </div>
      {near ? (
        <span className="coach-composer-count" aria-live="polite">
          {draft.length} / {REQUEST_MAX_CHARS}
        </span>
      ) : null}
    </form>
  );
}
