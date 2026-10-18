import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachMessageDto, type PlanDetailResponse, type WorkoutDto } from "@rg/api-client";
import { addDays, humanizeWorkoutTitle, startOfIsoWeek, type PlannedRef } from "@rg/domain";
import { approveProposal } from "../coach-approve.js";
import {
  CategoryDot,
  workoutKindLabel,
  CompletionPill,
  ConfirmDialog,
  CorosPill,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatDistance,
  formatTime,
  accountTodayGuess,
  revealInView,
  settling,
  Sheet,
  Spinner,
  SyncActionNote,
  SyncNotesStack,
  WatchCoverageNote,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";
import { SyncPanel, undoRefusalText } from "./today.js";
import { pendingByDate } from "./coach-panel.js";
import { CoachRead } from "./coach-read.js";
import { RaceMismatchNotice, WeeklyBrief } from "./plan-brief.js";
import { RaceStrip, useRaceHub } from "./race-strip.js";
import { leafStageCount, StageStructure } from "./stage-structure.js";
import { useUnits } from "../use-units.js";
import { YourPlans } from "./plan-cards.js";
import { PlanSheet } from "./plan-sheet.js";
import { ThreadCoachCards } from "./thread-coach-cards.js";
import { askable, displayCompletionState, WeekView, weekPlanName, weekRangeLabel } from "./week-view.js";
import { useCorosReadNow } from "./use-coros-read.js";
import { CorosCheck } from "./coros-check.js";
import { SessionSheet } from "../components/session-sheet.js";
import { isAppSession } from "../components/today-program.js";
import { AskCoach, useCoachSeeing } from "./studio/coach-ask.js";
import { workoutFocus } from "./studio/coach-focus.js";

/**
 * What "Remove from plan" does, said before the athlete confirms. A session the
 * APP put on the watch comes back off it — the same remove the coach performs
 * (Ruling A1) — while an imported COROS session's watch copy is left alone, and
 * the sentence has to say which, because the two now differ.
 */
export function removeConfirmCopy(displayTitle: string, appPushed: boolean): string {
  return appPushed
    ? `“${displayTitle}” is cleared from Run Garden, from your Calendar and from your COROS watch.`
    : `“${displayTitle}” is cleared from Run Garden and from your Calendar. Your COROS watch is untouched.`;
}

/**
 * The sheet's sentence about what COROS holds, when its date disagrees with the app's. `lastVerifiedCorosDate` is ""
 * when COROS has never seen the row — every coach-created session, a designed run among them — and every dated branch
 * formats that date, so the never-on-the-watch case is said first; but by its state (review-3): one on its way says
 * so, not "COROS has never been given it" beside a "Syncing" pill, and one whose send failed says it failed. A COROS
 * copy saved differently (`watch_copy_differs`) is a date that agrees: its action says it, with no sentence here.
 */
export function corosReasonSentence(v: { syncView: string; lastVerifiedCorosDate: string; effectiveDate: string }): string {
  if (v.lastVerifiedCorosDate === "") {
    if (v.syncView === "syncing") return "On its way to your COROS watch.";
    if (v.syncView === "sync_issue") return "Sending this to your COROS watch failed. It's in Run Garden and your Google Calendar.";
    return "This lives in Run Garden and your Google Calendar. COROS has never been given it.";
  }
  return v.syncView === "needs_attention"
    ? `COROS has this on ${formatDayLong(v.lastVerifiedCorosDate)}; Run Garden has ${formatDayLong(v.effectiveDate)}.`
    : v.syncView === "calendar_only"
      ? `Your COROS watch still has this on ${formatDayLong(v.lastVerifiedCorosDate)} — this move hasn't been written to COROS.`
      : v.syncView === "sync_issue"
        ? `The last update to COROS failed — your watch still shows ${formatDayLong(v.lastVerifiedCorosDate)}.`
        : `COROS still shows ${formatDayLong(v.lastVerifiedCorosDate)} — the update is on its way.`;
}

/**
 * The workout sheet. A program slot (or an on-demand session) opens the session sheet — its pre-check, what was
 * built and the moves (Phase 2a) — and every other workout the sheet it always had.
 */
export function WorkoutDetail(props: {
  w: WorkoutDto;
  today: string;
  corosWritesEnabled: boolean;
  onClose: () => void;
}) {
  return isAppSession(props.w) ? (
    <SessionSheet w={props.w} today={props.today} onClose={props.onClose} />
  ) : (
    <RunWorkoutDetail {...props} />
  );
}

/** The sheet every workout but an app session opens (exported for its tests). */
export function RunWorkoutDetail({
  w,
  today,
  corosWritesEnabled,
  onClose,
}: {
  w: WorkoutDto;
  today: string;
  corosWritesEnabled: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const units = useUnits();
  const [moving, setMoving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  /** The stages list "Full structure" reveals — scrolled to, not jumped to. */
  const structureRef = useRef<HTMLUListElement>(null);
  const detail = useQuery({
    queryKey: ["workout", w.id],
    queryFn: () => api.workout(w.id),
  });
  // Same queryKey/queryFn as today.tsx's SyncPanel, so this shares its cache
  // rather than firing a second independent fetch for the same data.
  const notes = useQuery({ queryKey: ["sync-notes"], queryFn: api.syncNotes, refetchInterval: 30_000 });
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});
  const workoutNotes = (notes.data?.notes ?? []).filter((n) => n.workoutId === w.id);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["plan-week"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["workout", w.id] });
    // Completion-state changes feed the garden simulation directly.
    void qc.invalidateQueries({ queryKey: ["garden"] });
  };
  const dismissNote = useMutation({
    mutationFn: (id: string) => api.dismissSyncNote(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sync-notes"] }),
  });
  const undoNote = useMutation({
    mutationFn: (id: string) => api.undoSyncNote(id),
    onSuccess: (_data, id) => {
      setUndoErrors((e) => {
        if (!(id in e)) return e;
        const next = { ...e };
        delete next[id];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ["sync-notes"] });
      void qc.invalidateQueries({ queryKey: ["sync-status"] });
      invalidate();
    },
    onError: (err: unknown, id: string) => {
      // Same copy as today.tsx's SyncPanel: adopted_coros_edit/removal notes
      // forward to the studio-adoption undo, which 409s the same way on a
      // renamed-on-COROS row.
      setUndoErrors((e) => ({ ...e, [id]: undoRefusalText(err) }));
    },
  });
  const retry = useMutation({ mutationFn: () => api.retryCoros(w.id), onSuccess: invalidate });
  const restore = useMutation({ mutationFn: () => api.restoreCalendar(w.id), onSuccess: invalidate });
  const unmatch = useMutation({ mutationFn: () => api.unmatch(w.id), onSuccess: invalidate });
  const skip = useMutation({ mutationFn: () => api.skip(w.id), onSuccess: invalidate });
  const unskip = useMutation({ mutationFn: () => api.unskipWorkout(w.id), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: () => api.removeWorkout(w.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const stages = (detail.data?.stages ?? []) as Array<Record<string, unknown>>;
  const match = detail.data?.match as { activity?: Record<string, unknown> } | null | undefined;
  const asks = askable(w, today);
  const completion = displayCompletionState(w, today);
  // Derived view (sync-transparency Task 10) takes precedence; the stored
  // legacy column is the fallback for any DTO that hasn't opted into it.
  const syncView = w.corosSyncView ?? w.corosSyncState;
  // "" = COROS has never verified this row (coach-apply.ts) — the session was
  // authored here, not imported. That is a different fact from "your move
  // hasn't reached the watch yet", and it gets different words below.
  const neverOnWatch = w.lastVerifiedCorosDate === "";
  const outOfSync = syncView === "needs_attention" || syncView === "calendar_only" || syncView === "sync_issue";
  /* THE BUTTON EXISTS IFF THE ACTION SAYS A CONTROL DOES (2026-08-17).
     This was four hand-rolled conditions — out of sync, writes on, no
     exercises, coverage not "none" — and it had already been wrong twice: once
     offering a retry on a distance-measured run whose push could only fail, and
     once (`content_stale`) offering one whose press enqueues a move to the day
     the session is already on. `syncAction` answers the same question in one
     place, for the sheet, the Today card and the copy beside them, so the button
     and the sentence explaining it cannot disagree again.
     Falls back to the old predicate only for a DTO with no action field. */
  const canSyncToCoros = w.syncAction
    ? w.syncAction.control === "retry"
    : outOfSync && corosWritesEnabled && (w.exercises?.length ?? 0) === 0 && w.watchCoverage?.coverage !== "none";
  // The banner is for COROS's DISAGREEMENT with the app — a wrong date or a
  // stale copy. It is no longer the carrier of the app-only story: that is a
  // standing property of the session, not a state, and it has its own note.
  //
  // And when the note has already said "your watch won't show this, it lives
  // here and in your Calendar", the banner's never-on-watch sentence is the
  // same sentence with the reason removed. One telling, not two.
  /* …and it is about a DATE. The content-stale branch moved out on 2026-08-17:
     the action note above now says what is true about a stale copy AND what to
     do about it, and this banner's version said neither correctly — it claimed
     "COROS has no way to be told a session's new content", which stopped being
     true the day the content-rewrite lane landed. Two tellings of one fact, one
     of them stale, is exactly what the action layer exists to end. */
  const corosDisagrees =
    w.effectiveDate !== w.lastVerifiedCorosDate &&
    syncView !== "content_stale" &&
    !(neverOnWatch && w.watchCoverage?.coverage === "none");

  const displayTitle = humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype);
  const canMove = completion === "scheduled" && w.category !== "rest";
  const canRemove = w.completionState !== "completed";
  const hasActions =
    canMove ||
    asks ||
    canSyncToCoros ||
    w.calendarSyncState === "user_deleted" ||
    w.completionState === "completed" ||
    w.completionState === "skipped" ||
    canRemove;

  /* Every action in the sheet's pinned foot (System 4 R2, System 1 §2). Two
     measured reasons, both at 390:

     1. An action row has to live somewhere always visible. In the scrolling
        body it obeyed the invariant and said nothing — the frame is frozen, so
        a confirm rendered 77.4px past the fold of a body that had no scrollbar
        a moment earlier (59.6px at 1440).
     2. The row was also one banner away from being invisible on its own: it
        ended at y=828 in a body whose fold was 828.

     The destructive confirm is NOT here any more; it is a nested dialog (see
     ConfirmDialog, and the four measurements in its doc comment). In the foot
     it was 117–169px from the trigger at 390 with unrelated actions in
     between, which is what "belongs to its trigger" fails to mean. */
  const footer = hasActions ? (
    <div className="btn-row">
      {canMove ? (
        <button className="btn btn-primary" onClick={() => setMoving(true)}>
          Move
        </button>
      ) : null}
      {asks ? (
        <>
          <button className="btn btn-primary" onClick={() => setMatching(true)}>
            Match activity
          </button>
          <button className="btn" onClick={() => setMoving(true)}>
            Move it
          </button>
          <button className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
            Skip it
          </button>
        </>
      ) : null}
      {/* `canSyncToCoros`, not `outOfSync`: offering a retry on a session
          that can never be written is the same dishonesty as dropping it
          silently. A lift or mobility session has no COROS representation
          the create executor can build, so the button is not shown. */}
      {canSyncToCoros ? (
        <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
          Sync to COROS
        </button>
      ) : null}
      {w.calendarSyncState === "user_deleted" ? (
        <button className="btn" disabled={restore.isPending} onClick={() => restore.mutate()}>
          Restore to Calendar
        </button>
      ) : null}
      {w.completionState === "completed" ? (
        <button className="btn" disabled={unmatch.isPending} onClick={() => unmatch.mutate()}>
          Undo match
        </button>
      ) : null}
      {w.completionState === "skipped" ? (
        <button className="btn" disabled={unskip.isPending} onClick={() => unskip.mutate()}>
          Un-skip
        </button>
      ) : null}
      {canRemove ? (
        <button
          className="btn"
          aria-haspopup="dialog"
          onClick={() => setConfirmRemove(true)}
        >
          Remove from plan
        </button>
      ) : null}
    </div>
  ) : null;
  return (
    <Sheet open onClose={onClose} title={displayTitle} footer={footer}>
      <div className="stack">
        <div className="row">
          <CategoryDot category={w.category} />
          <span className="muted">{workoutKindLabel(w.category, w) ?? w.category}</span>
          <CompletionPill state={completion} />
          <CorosPill state={syncView} hideWhenHealthy />
        </div>
        <p>
          {formatDayLong(w.effectiveDate)} at {formatTime(w.effectiveTime)}
          {w.corosName ? <span className="faint"> · COROS name: {w.corosName}</span> : null}
        </p>
        {/* A modal sheet hides the nav, so it keeps its own small Ask, seeing the workout (the integrated review, I3). */}
        <AskCoach focus={workoutFocus(w)} wrap="session-ask-row" />
        <SyncNotesStack
          notes={workoutNotes}
          onDismiss={(id) => dismissNote.mutate(id)}
          onUndo={(id) => undoNote.mutate(id)}
          undoPendingId={undoNote.isPending ? undoNote.variables : null}
          undoErrors={undoErrors}
        />
        {/* WHAT THE WATCH WILL SHOW — a standing property of the session,
            rendered as a `.note` (a sentence that just says something) rather
            than folded into the sync Banner (a state you may need to act on).
            They used to be the same element, which is how "it was never
            written to your COROS watch" came to be gated on a DATE comparison:
            a lift is app-only whether or not its date agrees with anything.
            Silent whenever the whole session crosses — the field is absent. */}
        <WatchCoverageNote view={w.watchCoverage} />
        {/* WHAT COROS HOLDS, AND WHAT TO DO ABOUT IT — one block, because they
            are one situation. The dated sentence and the to-do used to be two
            adjacent banners saying "COROS has never been given it." and "This
            hasn't reached your COROS watch yet.", which is two alerts for one
            fact. `SyncActionNote` renders the reason alone when there is no
            action (a past session's watch copy is history), and nothing at all
            when there is neither — so a synced session is exactly as quiet as
            it was before any of this existed. */}
        <SyncActionNote
          action={w.syncAction}
          kind={syncView === "needs_attention" || syncView === "sync_issue" ? "warn" : "info"}
          reason={
            corosDisagrees
              ? /* `lastVerifiedCorosDate` is "" when COROS has never seen this
                   row at all — every coach-created session. Every dated branch
                   formats that date, so the app told you your watch "still
                   has this on undefined, undefined NaN" (2026-08-16). */
                corosReasonSentence({ syncView, lastVerifiedCorosDate: w.lastVerifiedCorosDate, effectiveDate: w.effectiveDate })
              : undefined
          }
          /* The coverage note above is the reason for a wire limit, in full and
             by name; the action must not list the same four movements again. */
          reasonShown={!!w.watchCoverage}
          settingsLink={<Link to="/settings">Open Settings</Link>}
        />
        <div className="hero-durations">
          <div>
            <div className="num">{formatMinutes(w.workoutSeconds)}</div>
            <div className="lbl">Workout{w.estimateSource === "coros_native" ? " · COROS estimate" : ""}</div>
          </div>
          <div>
            <div className="num">{formatMinutes(w.calendarSeconds)}</div>
            <div className="lbl">Calendar block</div>
          </div>
        </div>
        {/* A lift or mobility session's real prescription. It used to reach
            the sheet only as the flattened `stageSummary` line, which cannot
            say which movements the watch's own library knows — and a hold,
            a per-side count and a tempo all had to survive that flattening
            intact. The lines are formatted server-side (`formatExercise`),
            so this list and the summary can never disagree. */}
        {(w.exercises?.length ?? 0) > 0 ? (
          <div className="exercise-prescription">
            {w.exerciseRounds ? (
              <span className="rounds">{w.exerciseRounds} rounds of:</span>
            ) : null}
            <ul className="exercise-list">
              {/* Index-keyed: two identical lines in one circuit are real. */}
              {w.exercises!.map((e, ei) => (
                <li key={`${ei}-${e.line}`}>
                  {e.line}
                  {e.onWatch ? null : (
                    /* Per-movement, and careful about what it claims: the
                       session is app-only because it is a lift, not because
                       of this name (the note above says so). What THIS says
                       is narrower and still worth saying — the library has no
                       such movement, which is the one thing a rename could
                       change. */
                    <span className="faint" title="Your COROS exercise library has no movement by this name.">
                      {" "}
                      · not in watch library
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : w.stageSummary ? (
          <div className="stage-summary">{w.stageSummary}</div>
        ) : null}
        {stages.length > 0 ? (
          /* Non-destructive growth inside a frozen frame has to be brought to
             the reader, or it is not a disclosure (System 4 R2). Opening this
             adds 108px of stages to a body that was already exactly full, so
             at 390 the list landed with its bottom 2.3px past the fold and at
             1440 53.6px past it. The frame still does not move; the body
             scrolls, by the reader's own press, and no further than it must. */
          <details onToggle={(e) => { if (e.currentTarget.open) revealInView(structureRef.current); }}>
            {/* `.tap-pad`, like the app's two other summary disclosures
                (System 4 P4). It shipped as a 358 × 21.6px target with
                `min-height: 0` because it was the one `<summary>` not in the
                pad list. The visible line does not move: its container is a
                `.stack` whose 16px gap is wider than the 11.2px the pad
                reaches, so the pad is not clamped and the box is not grown. */}
            <summary className="muted tap-pad" style={{ cursor: "pointer" }}>
              Full structure ({leafStageCount(stages)} stages)
            </summary>
            {/* The tree, not the flat list: a repeat's multiplier is attached
                to the stages it multiplies (nested `<ul>`), so its scope is in
                the DOM and not only in the styling. See stage-structure.tsx. */}
            <StageStructure stages={stages} units={units} listRef={structureRef} />
          </details>
        ) : null}
        {match?.activity ? (
          <>
            <p className="muted">
              Completed with “{(match.activity.title as string) ?? "activity"}” ·{" "}
              {formatMinutes(match.activity.durationSeconds as number)}
              {match.activity.distanceMeters
                ? ` · ${formatDistance(match.activity.distanceMeters as number, units)}`
                : ""}{" "}
              <button
                className="btn btn-small"
                aria-expanded={readOpen}
                onClick={() => setReadOpen((v) => !v)}
              >
                {readOpen ? "Hide read" : "✨ Coach's read"}
              </button>
            </p>
            {readOpen ? <CoachRead activityId={match.activity.id as string} /> : null}
          </>
        ) : null}

        {/* The settings nudge used to live here, with its own copy of the
            "session COROS could carry" predicate. It is the `syncAction` layer's
            `enable_coros_writes` now — one sentence, at the top of the sheet
            with the rest of the sync story, instead of a second telling at the
            bottom that only some of the eligible sessions got. */}
      </div>
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
      <MatchSheet workout={w} open={matching} onClose={() => setMatching(false)} />
      <ConfirmDialog
        open={confirmRemove && canRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove this from the plan?"
        confirmLabel="Remove from plan"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        {removeConfirmCopy(displayTitle, !!w.appPushed)}
      </ConfirmDialog>
    </Sheet>
  );
}

/** Turns a failed approve/decline into copy that says what actually
 * happened (audit C17) — a 409 not_pending means the proposal already
 * resolved (expired, or acted on from another tab), NOT that this tap did
 * anything. */
export function proposalActionErrorMessage(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "not_pending") return "This already resolved elsewhere — nothing changed here.";
  if (code === "not_found") return "This proposal is gone — nothing changed.";
  // A plan part-added (§8 §4): it can't be declined half-made, and its next approve finishes it.
  if (code === "in_flight") return "This plan is already being added — Approve finishes it.";
  return "Couldn't reach the coach — try again.";
}

/** How long "we just asked for a wake" counts as thinking on its own, before
 * the server's own answer takes over. Long enough for the request to reach
 * the route and for the 3s poll to read back what it wrote; short enough
 * that a send which never arrived clears itself. */
const WAKE_BRIDGE_MS = 15_000;

/**
 * Coach data wiring (Plan B Task B2): one shared ["coach-state"] query feeds
 * the thread coach's cards AND the week's ghost diffs.
 *
 * THE PLAN WAKES NO COACH (§8 §6). It used to fire a wake on mount whenever
 * the server advised one (`wakeAdvised`) — the thread coach's only automatic
 * spend, about $0.35 a Plan visit. The thread coach has stepped back: what it
 * left (its pending suggestions, its question) is still read and acted on
 * here, and nothing is sent to it — Extend, Wind down and a new plan open the
 * conversation instead. A wake is asked for only by the athlete's own Retry.
 */
export function usePlanCoach() {
  const qc = useQueryClient();
  // A wake we have just asked for, before the server has had the chance to
  // say it is thinking. The POST itself is fired and never waited on (see
  // `NO_DEADLINE`), so mutation state can't drive the spinner: a request
  // that never settles would pin "Coach is thinking…" on forever. Server
  // truth (`coachThinking`) drives it; this bridges the seconds before the
  // first read that can see the wake — including a read already in flight
  // when we fired, which would otherwise answer "not thinking" from before
  // our request and stop the poll dead.
  //
  // It expires on a timer rather than by comparing clocks at render time:
  // if the polled state stops changing, nothing re-renders, and a bridge
  // that can only end during a render would never end at all.
  const [bridging, setBridging] = useState(false);
  const [wakesAsked, setWakesAsked] = useState(0);
  const fired = () => {
    setBridging(true);
    setWakesAsked((n) => n + 1); // re-arms the timer below, even mid-bridge
  };
  useEffect(() => {
    if (wakesAsked === 0) return;
    const t = setTimeout(() => setBridging(false), WAKE_BRIDGE_MS);
    return () => clearTimeout(t);
  }, [wakesAsked]);
  const state = useQuery({
    queryKey: ["coach-state"],
    queryFn: () => api.coachState(),
    // While a wake runs server-side, poll until the reply lands — this is
    // what keeps "Coach is thinking…" true across page navigations, and what
    // carries every reply now that no response is waited on.
    refetchInterval: (q) => (q.state.data?.coachThinking || bridging ? 3_000 : false),
  });
  const thinking = (state.data?.coachThinking ?? false) || bridging;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["coach-state"] });
  // The AI account is out of credits (a 402): the wake that heard it is OVER —
  // it took a second — so the bridge has nothing left to cover. Ending it here
  // is what makes the chat say why at once instead of "thinking" for 15s.
  const endIfOutOfCredits = (status: string | undefined) => {
    if (status === "out_of_credits") setBridging(false);
  };
  const wakeMut = useMutation({
    mutationFn: (force: boolean) => api.coachWake(force),
    onMutate: fired,
    onSuccess: (res) => endIfOutOfCredits(res.status),
    // Settles when the wake FINISHES (minutes), or never. Either is fine —
    // the poll has already carried the reply by then.
    onSettled: invalidate,
  });
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>({});
  const clearProposalError = (id: string) =>
    setProposalErrors((e) => {
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  const approve = useMutation({
    // An applied proposal is never reported as a failure: a 409 that says `approved`, or a lost answer whose re-read
    // says so, resolves as done (2026-10-10, see `approveProposal`).
    mutationFn: (id: string) => approveProposal(id),
    onMutate: (id) => clearProposalError(id),
    // Audit C17: a 409 (proposal expired/resolved while the page sat open)
    // used to be swallowed by `onSettled: invalidate` alone — the refetch
    // simply omits the now-non-pending proposal, so the card vanishes
    // exactly like a success even though nothing was applied. Only
    // invalidate on success; on error, keep the card and say why.
    onError: (err, id) => setProposalErrors((e) => ({ ...e, [id]: proposalActionErrorMessage(err) })),
    onSuccess: () => {
      invalidate();
      for (const k of ["plan", "plan-week", "today", "garden"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const decline = useMutation({
    mutationFn: (id: string) => api.coachDecline(id),
    onMutate: (id) => clearProposalError(id),
    onError: (err, id) => setProposalErrors((e) => ({ ...e, [id]: proposalActionErrorMessage(err) })),
    onSuccess: invalidate,
  });
  const answer = useMutation({
    mutationFn: (v: { id: string; answer: string }) => api.coachAnswerQuestion(v.id, v.answer),
    onMutate: fired,
    onSuccess: (res) => endIfOutOfCredits(res.wake?.status),
    onSettled: invalidate,
  });
  const dismissQuestion = useMutation({
    mutationFn: (id: string) => api.coachDismissQuestion(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["coach-state"] }),
  });
  return {
    state,
    // Deliberately NOT the mutations' isPending: those requests have no
    // deadline, so one that never settles would disable the composer for
    // good. The server says when the coach is thinking, and stops saying it.
    busy: thinking,
    /** The AI account is out of credits (a 402 is on record). The panel says
     * so only while nothing is thinking. */
    outOfCredits: !!state.data?.outOfCredits,
    acting: approve.isPending || decline.isPending,
    proposalErrors,
    checkIn: () => wakeMut.mutate(true),
    approve: (id: string) => approve.mutate(id),
    decline: (id: string) => decline.mutate(id),
    answer: (id: string, a: string) => answer.mutate({ id, answer: a }),
    dismissQuestion: (id: string) => dismissQuestion.mutate(id),
  };
}

/**
 * ONE prop list for the panel's two mounts. They differ by `hideHead` and
 * nothing else, and every prop added to the surface used to have to be added in
 * both places or work at one width only. Undefined until the first state read.
 */
export function coachPanelProps(
  coach: ReturnType<typeof usePlanCoach>,
  planned: ReadonlyMap<string, PlannedRef>,
) {
  const data = coach.state.data;
  return (
    data && {
      messages: data.messages,
      proposals: data.pendingProposals,
      settledProposals: data.settledProposals,
      question: data.openQuestion,
      busy: coach.busy,
      acting: coach.acting,
      proposalErrors: coach.proposalErrors,
      planned,
      onApprove: coach.approve,
      onDecline: coach.decline,
      onAnswer: coach.answer,
      onDismiss: coach.dismissQuestion,
      onCheckIn: coach.checkIn,
      outOfCredits: coach.outOfCredits,
      // A check-in: the wake's dossier carries every message still owed a
      // reply, so asking again answers them once the credits are back.
      onRetry: coach.checkIn,
    }
  );
}

/**
 * The thread coach's last wake lost its work (the integrated review's minors): when the newest message is a receipt
 * that applied nothing, its words — "… Nothing was applied. Ask again …" — for the Plan's coach cards; else none. A
 * message from the athlete after it means they asked again, and the line goes.
 *
 * Unused since §8 §6 (the Plan sends the thread coach nothing, so it passes neither line); kept with the thread coach's
 * code until the owner's clean-up.
 */
export function nothingAppliedOf(messages: ReadonlyArray<Pick<CoachMessageDto, "role" | "body">>): string | null {
  const last = messages.at(-1);
  return last && last.role === "receipt" && last.body.includes("Nothing was applied") ? last.body : null;
}

/**
 * The thread coach's reply in words (C's `reply` on its cards): its newest message after the athlete's latest request
 * (Extend or Wind down answered with no suggestion). A receipt is not its words; nothing asked, or nothing said since:
 * none. Unused since §8 §6, as `nothingAppliedOf`.
 */
export function replyOf(messages: ReadonlyArray<Pick<CoachMessageDto, "role" | "body" | "at">>): { text: string; at: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") return null;
    if (msg.role === "coach") {
      // Its newest word counts only when the athlete asked something before it.
      return messages.slice(0, i).some((x) => x.role === "user") ? { text: msg.body, at: msg.at } : null;
    }
  }
  return null;
}

/** Flash a proposal card (a ghost's tap): the thread coach's card on the page, scrolled to. */
function focusProposal(id: string, skipScroll: boolean): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(`proposal-${id}`);
    if (!el) return;
    if (!skipScroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("coach-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("coach-flash");
  });
}


const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Retire a plan from its modal: one the retired generator made by its own route (what is ahead leaves the watch through
 * its push path), every other by the coach's.
 */
export function retirePlan(v: { id: string; source: "coach" | "studio" }): Promise<{ ok: boolean }> {
  return v.source === "studio" ? api.studioPlanRetire(v.id) : api.coachPlanRetire(v.id);
}

/** Why a Retire did not happen, in plain words — said in its confirmation, which stays open. */
export function retireRefusalText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Retiring needs a connection.";
  const code = (e.body as { error?: string } | null)?.error;
  if (code === "writes_disabled") return "Writing to COROS is switched off. Turn on “Write date changes back to COROS” in Settings, then retire it.";
  if (code === "plan_completed") return "This plan is already over.";
  if (code === "already_retired") return "This plan is already retired.";
  if (code === "not_current") return "A newer plan has replaced this one.";
  if (e.status === 404) return "That plan is gone.";
  return "Couldn't retire it. Try again.";
}

export function PlanScreen() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const corosCheck = useCorosReadNow();

  // ── The picked week ────────────────────────────────────────────────────
  const weekParam = params.get("week");
  const pickedWeek =
    weekParam && ISO_DATE.test(weekParam) && startOfIsoWeek(weekParam) === weekParam ? weekParam : null;
  const week = useQuery({
    queryKey: ["plan-week", pickedWeek ?? "current"],
    queryFn: () => api.planWeek(pickedWeek ?? undefined),
    // Week paging must not blank the page: keep showing the previous week
    // while the next one loads (the full-page spinner guards first load only).
    placeholderData: keepPreviousData,
  });
  // Week-paging cursor: updated synchronously on every click so a burst of
  // clicks accumulates instead of collapsing into one (live-verified).
  const weekCursor = useRef<string | null>(null);
  // Display units for the race (and anything else on this page that shows a
  // pace) — shares the Settings screen's query cache.
  const units = useUnits();
  // Two-race-dates resolution — the warning must be actionable where it
  // appears. Settings holds the race day, so it refetches too.
  const resolveRace = useMutation({
    mutationFn: (keep: "settings" | "plan") => api.resolveRaceConflict(keep),
    onSuccess: () => {
      for (const k of ["plan", "plan-week", "today", "preferences", "coach-state"])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  // Wider workout window (picked week ±4 weeks): ghost date resolution and
  // the workout-detail deep link both need more than seven days in hand.
  const windowAnchor = pickedWeek ?? week.data?.weekStart ?? null;
  const plan = useQuery({
    queryKey: ["plan", windowAnchor ?? "boot"],
    queryFn: () => {
      // Before its week is read: the account's today (a Today read's, else its clock), never the device's (CUJ J34).
      const anchor =
        windowAnchor ??
        accountTodayGuess(qc.getQueryData<{ today?: string }>(["today"])?.today, qc.getQueryData<{ prefs?: { timezone?: string } }>(["settings"])?.prefs?.timezone);
      return api.workouts(addDays(startOfIsoWeek(anchor), -28), addDays(startOfIsoWeek(anchor), 34));
    },
    // The window re-anchors as the user pages weeks — sliding it must reuse
    // the previous window's rows instead of emptying the grid.
    placeholderData: keepPreviousData,
  });

  const today = week.data ? (plan.data?.today ?? week.data.weekStart) : plan.data?.today;

  // ── Coach ──────────────────────────────────────────────────────────────
  // The thread coach's own outputs stay on the Plan (its pending suggestions, its question, the week's ghosts); its chat
  // is the one conversation now, opened from the nav (the new shape §5).
  const coach = usePlanCoach();
  const coachPlans = useQuery({ queryKey: ["coach-plans"], queryFn: api.coachPlans });
  // The adaptive programs (Phase 2a): in the gate, so a row never lands after the week above it. One attempt: a failure
  // shows the page without them at once rather than holding every account's first paint for retries.
  const programs = useQuery({ queryKey: ["programs"], queryFn: api.listPrograms, staleTime: 60_000, retry: false });
  // The race's countdown is on the week's line, so the first paint waits for it: the line never grows late.
  const raceHub = useRaceHub();
  const activePlans = useMemo(
    () =>
      (coachPlans.data?.plans ?? []).filter(
        // A loose-session container has no weeks: it names no week of its own.
        (p) => (p.status === "active" || p.status === "draft") && p.kind !== "loose",
      ),
    [coachPlans.data?.plans],
  );

  // ── What the plan holds today ──────────────────────────────────────────
  // ONE answer to "where does workout X sit, and what is it", read by two
  // consumers: the calendar ghosts and the proposal manifest. They used to
  // build one map each from the same array, one a strict subset of the other
  // — two answers that would drift the moment either gained a filter.
  //
  // An `ease` op carries the session a day BECOMES and nothing about what it
  // was, so without this the manifest can only say "rewrites the session
  // already planned", on no particular day; with it, "Threshold 5x5 → Easy
  // 35" on Tuesday.
  //
  // The TITLE, not `stageSummary`: the app's own name for the session on every
  // other surface (week grid, workout sheet, calendar ghost).
  const plannedRefs = useMemo(
    () =>
      new Map(
        (plan.data?.workouts ?? []).map((w) => [
          w.id,
          {
            date: w.effectiveDate,
            summary: w.title,
            ...(w.hasWatchAddress ? { onWatch: true } : {}),
            ...(w.appPushed ? { appPushed: true } : {}),
            ...(w.workoutSeconds != null
              ? { durationMinutes: Math.round(w.workoutSeconds / 60) }
              : {}),
          },
        ]),
      ),
    [plan.data?.workouts],
  );
  const ghostsByDate = useMemo(
    () => pendingByDate(coach.state.data?.pendingProposals ?? [], plannedRefs),
    [plannedRefs, coach.state.data?.pendingProposals],
  );
  // A ghost in the week is a suggestion's mark: its tap goes to the suggestion's card on the page.
  const onGhostTap = (proposalId: string) => focusProposal(proposalId, false);

  // ── Jump menu: the active plans' weeks, longest plan numbering the list ─
  const jumpWeeks = useMemo(() => {
    if (activePlans.length === 0) return [];
    const spans = activePlans.map((p) => ({
      start: startOfIsoWeek(p.startDate),
      end: startOfIsoWeek(p.endDate),
    }));
    const anchor = spans.reduce((a, b) =>
      Date.parse(b.end) - Date.parse(b.start) > Date.parse(a.end) - Date.parse(a.start) ? b : a,
    );
    const mondays = new Set<string>();
    for (const s of spans) {
      for (let m = s.start; m <= s.end; m = addDays(m, 7)) mondays.add(m);
    }
    return [...mondays].sort().map((monday) => {
      const idx = Math.floor((Date.parse(monday) - Date.parse(anchor.start)) / 604_800_000) + 1;
      const inAnchor = monday >= anchor.start && monday <= anchor.end;
      return { monday, label: `${inAnchor ? `wk ${idx} · ` : ""}${weekRangeLabel(monday)}` };
    });
  }, [activePlans]);

  const pickWeek = (monday: string) => {
    weekCursor.current = monday;
    const next = new URLSearchParams(params);
    if (today && monday === startOfIsoWeek(today)) next.delete("week");
    else next.set("week", monday);
    setParams(next);
  };
  /** ± a week from the last REQUESTED week. The cursor is written before
   * React re-renders, so five clicks in one tick move five weeks. */
  const stepWeek = (deltaDays: number) => {
    const base = weekCursor.current ?? pickedWeek ?? week.data?.weekStart;
    if (!base) return;
    pickWeek(addDays(base, deltaDays));
  };

  useEffect(() => {
    weekCursor.current = pickedWeek ?? week.data?.weekStart ?? null;
  }, [pickedWeek, week.data?.weekStart]);

  // ── Selection params ───────────────────────────────────────────────────
  const selectedId = params.get("workout");
  const selected = plan.data?.workouts.find((w) => w.id === selectedId);
  // What the coach sees from the Plan: the open workout's sheet (the nav's Coach button picks it up).
  useCoachSeeing(selected ? workoutFocus(selected) : null);
  const openWorkout = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("workout", id);
    setParams(next);
  };
  const closeWorkout = () => {
    const next = new URLSearchParams(params);
    next.delete("workout");
    setParams(next);
  };
  const planParam = params.get("plan");
  const openPlan = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("plan", id);
    setParams(next);
  };
  const closePlan = () => {
    const next = new URLSearchParams(params);
    next.delete("plan");
    setParams(next);
  };
  // The week's brief, opened from its line: the numbers, the coach's line, the race.
  const [briefOpen, setBriefOpen] = useState(false);

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.coachPlanRename(v.id, v.name),
    onSettled: () => {
      for (const k of ["coach-plans", "plan-detail"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const retire = useMutation({
    mutationFn: retirePlan,
    onSettled: () => {
      for (const k of ["coach-plans", "plan-detail", "plan", "plan-week", "coach-state"]) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
    },
  });

  // EVERY query that decides whether a block exists, not just the week's
  // (System 4 D1/D7a). `emptyPlan` below is an AND of two of them, so gating
  // on `week` alone let the page state "Nothing planned yet" to somebody who
  // has one: measured with /api/plan/workouts and /api/coach/plans delayed,
  // that sentence rendered for 3.5s and was then replaced by the week grid. A
  // false statement, not merely a shift. The race is in here for the same
  // reason one step milder: its countdown is on the week's line.
  //
  // All carry `placeholderData: keepPreviousData` or a stable key, so this
  // holds the FIRST paint only: paging weeks and background refetches still
  // render straight from cache.
  if (settling(week, plan, coachPlans, raceHub, programs) || (!week.data && week.isPending))
    return <Spinner label="Loading plan" />;
  if (!week.data) return <EmptyState title="Couldn't load the plan" />;

  const coachProps = coachPanelProps(coach, plannedRefs);

  // Claimed from two answers we actually hold. `?? 0` used to turn a query
  // that had not answered — or one that had FAILED — into "you have no plan".
  const emptyPlan =
    !!plan.data && !!coachPlans.data && plan.data.workouts.length === 0 && activePlans.length === 0;

  const race = raceHub.data?.race ?? null;
  const raceMismatch = week.data.raceMismatch ?? null;

  return (
    <div className="plan-page">
      <div className="row-between screen-title">
        <h1>Plan</h1>
        <CorosCheck state={corosCheck.state} />
      </div>
      <div className="plan-page-col">
        {/* Only when something is wrong: on a healthy day this is nothing. */}
        <SyncPanel quietWhenHealthy />
        {/* Two race dates: a warning that must be answerable where it appears. */}
        {raceMismatch ? (
          <div className="card plan-race-mismatch">
            <RaceMismatchNotice mismatch={raceMismatch} onResolve={(keep) => resolveRace.mutate(keep)} resolving={resolveRace.isPending} />
          </div>
        ) : null}
        {emptyPlan ? (
          <EmptyState art="🗓" title="Nothing planned yet">
            Ask the coach for a plan, or start one in COROS — it syncs in once COROS is connected in Settings.
          </EmptyState>
        ) : (
          <WeekView
            onStep={stepWeek}
            loading={week.isPlaceholderData}
            week={week.data}
            today={today ?? week.data.weekStart}
            ghostsByDate={ghostsByDate}
            jumpWeeks={jumpWeeks}
            onPick={pickWeek}
            onOpenWorkout={openWorkout}
            onGhostTap={onGhostTap}
            onBrief={() => setBriefOpen(true)}
            planName={weekPlanName(activePlans, week.data.weekStart)}
            race={race}
          />
        )}
        {/* The thread coach's pending suggestions and its question, in the page (no window, no chat box). */}
        {/* Its words to a request the Plan sent (`reply`, `nothingApplied`) are not passed: the Plan sends it none now,
            and an old one would stay on the page for good (§8 §6). */}
        {coachProps ? <ThreadCoachCards {...coachProps} /> : null}
        <YourPlans
          plans={coachPlans.data?.plans ?? []}
          programs={programs.data}
          today={today ?? week.data.weekStart}
          onOpenPlan={openPlan}
        />
      </div>

      {/* The week's brief, one tap down from its line: the week's numbers and the coach's line, then the race. */}
      <Sheet open={briefOpen} onClose={() => setBriefOpen(false)} title={week.data.weekIndex !== null && week.data.weekTotal !== null ? `Week ${week.data.weekIndex} of ${week.data.weekTotal}` : "This week"}>
        <div className="stack plan-brief-sheet">
          <WeeklyBrief week={week.data} today={today} />
          <RaceStrip units={units} />
        </div>
      </Sheet>

      {planParam ? (
        <PlanSheet
          planId={planParam}
          plans={coachPlans.data?.plans ?? []}
          onClose={closePlan}
          onRetire={async (id, source) => {
            try {
              await retire.mutateAsync({ id, source });
              closePlan();
              return null;
            } catch (e) {
              return retireRefusalText(e);
            }
          }}
          onRename={(id, name) => rename.mutate({ id, name })}
        />
      ) : null}

      {selected && today ? (
        <WorkoutDetail
          w={selected}
          today={today}
          corosWritesEnabled={plan.data?.corosWritesEnabled ?? false}
          onClose={closeWorkout}
        />
      ) : null}
    </div>
  );
}
