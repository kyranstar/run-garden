import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type PlanDetailResponse, type WorkoutDto } from "@rg/api-client";
import { addDays, humanizeWorkoutTitle, startOfIsoWeek } from "@rg/domain";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  ConfirmDialog,
  CorosPill,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatDistance,
  formatTime,
  localTodayGuess,
  revealInView,
  settling,
  Sheet,
  Spinner,
  SyncActionNote,
  SyncNotesStack,
  useIsDesktop,
  WatchCoverageNote,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";
import { SyncPanel } from "./today.js";
import { CoachPanel, pendingByDate } from "./coach-panel.js";
import { CoachRead } from "./coach-read.js";
import { CoachWindow } from "./coach-window.js";
import { WeeklyBrief } from "./plan-brief.js";
import { RaceStrip, useRaceHub } from "./race-strip.js";
import { leafStageCount, StageStructure } from "./stage-structure.js";
import { useUnits } from "../use-units.js";
import { PlanCards } from "./plan-cards.js";
import { StudioModal } from "./studio-modal.js";
import { askable, displayCompletionState, WeekView, weekRangeLabel } from "./week-view.js";
import { useCorosReadNow } from "./use-coros-read.js";
import { CorosCheck } from "./coros-check.js";

function WorkoutDetail({
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
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setUndoErrors((e) => ({
        ...e,
        [id]:
          code === "undo_unsupported_rename"
            ? "Renamed on COROS — delete it there to re-push."
            : "Couldn't undo — try again.",
      }));
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
          <span className="muted">{CATEGORY_LABELS[w.category] ?? w.category}</span>
          <CompletionPill state={completion} />
          <CorosPill state={syncView} hideWhenHealthy />
        </div>
        <p>
          {formatDayLong(w.effectiveDate)} at {formatTime(w.effectiveTime)}
          {w.corosName ? <span className="faint"> · COROS name: {w.corosName}</span> : null}
        </p>
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
        {corosDisagrees ? (
          <Banner kind={syncView === "needs_attention" || syncView === "sync_issue" ? "warn" : "info"}>
            {/* `lastVerifiedCorosDate` is "" when COROS has never seen this
                row at all — every coach-created session. Every dated branch
                below formats that date, so the app told you your watch "still
                has this on undefined, undefined NaN" (2026-08-16). A session
                that was never on the watch needs its own sentence, not a
                move-that-didn't-land sentence with a hole in it — and when the
                note above has already given the reason, this one says only the
                part the note doesn't: that Calendar has it and COROS doesn't. */}
            {neverOnWatch
              ? "This lives in Run Garden and your Google Calendar. COROS has never been given it."
              : syncView === "needs_attention"
                ? `COROS has this on ${formatDayLong(w.lastVerifiedCorosDate)}; Run Garden has ${formatDayLong(w.effectiveDate)}.`
                : syncView === "calendar_only"
                  ? `Your COROS watch still has this on ${formatDayLong(w.lastVerifiedCorosDate)} — this move hasn't been written to COROS.`
                  : syncView === "sync_issue"
                    ? `The last update to COROS failed — your watch still shows ${formatDayLong(w.lastVerifiedCorosDate)}.`
                    : `COROS still shows ${formatDayLong(w.lastVerifiedCorosDate)} — the update is on its way.`}
          </Banner>
        ) : null}
        {/* …AND WHAT TO DO ABOUT IT — last of the three, because it is the
            conclusion: the note above says what the watch can carry, the banner
            says what COROS currently holds, and this says who has to act and
            what the one thing is. Absent whenever the answer is "nothing", so a
            synced session renders exactly what it rendered before this existed. */}
        <SyncActionNote
          action={w.syncAction}
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
        “{displayTitle}” is cleared from Run Garden and from your Calendar. Your COROS watch is
        untouched.
      </ConfirmDialog>
    </Sheet>
  );
}

/** Client-only id for an optimistic echo — collision-safe enough for a
 * single browser tab composing messages one at a time. */
let localIdSeq = 0;
function newLocalId(): string {
  localIdSeq += 1;
  return `${Date.now()}-${localIdSeq}`;
}

/** Turns a failed approve/decline into copy that says what actually
 * happened (audit C17) — a 409 not_pending means the proposal already
 * resolved (expired, or acted on from another tab), NOT that this tap did
 * anything. */
function proposalActionErrorMessage(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "not_pending") return "This already resolved elsewhere — nothing changed here.";
  if (code === "not_found") return "This proposal is gone — nothing changed.";
  return "Couldn't reach the coach — try again.";
}

/** How long "we just asked for a wake" counts as thinking on its own, before
 * the server's own answer takes over. Long enough for the request to reach
 * the route and for the 3s poll to read back what it wrote; short enough
 * that a send which never arrived clears itself. */
const WAKE_BRIDGE_MS = 15_000;

/**
 * Coach data wiring (Plan B Task B2): one shared ["coach-state"] query feeds
 * the panel AND the week's ghost diffs. On mount, a wake fires only when
 * the server says it's worth it (wakeAdvised) — quiet opens stay free, and
 * the server's single-flight lock makes racing tabs harmless.
 */
function usePlanCoach() {
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
  const wakeMut = useMutation({
    mutationFn: (force: boolean) => api.coachWake(force),
    onMutate: fired,
    // Settles when the wake FINISHES (minutes), or never. Either is fine —
    // the poll has already carried the reply by then.
    onSettled: invalidate,
  });
  const wakeFired = useRef(false);
  useEffect(() => {
    if (state.data?.wakeAdvised && !wakeFired.current) {
      wakeFired.current = true;
      wakeMut.mutate(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data?.wakeAdvised]);

  const echo = (localId: string, body: string) => {
    // Optimistic echo: the athlete's words appear instantly.
    qc.setQueryData(["coach-state"], (cur: unknown) => {
      const c = cur as { messages?: Array<Record<string, unknown>> } | undefined;
      if (!c?.messages) return cur;
      return {
        ...c,
        messages: [
          ...c.messages,
          { id: localId, role: "user", body, refs: {}, at: new Date().toISOString() },
        ],
      };
    });
  };
  const markSendFailed = (localId: string, body: string) => {
    qc.setQueryData(["coach-state"], (cur: unknown) => {
      const c = cur as { messages?: Array<Record<string, unknown>> } | undefined;
      if (!c?.messages) return cur;
      // The echo may already be gone (e.g. a refetch replaced it) — if so,
      // re-add it rather than silently dropping the failure.
      if (c.messages.some((m) => m.id === localId)) {
        return { ...c, messages: c.messages.map((m) => (m.id === localId ? { ...m, failed: true } : m)) };
      }
      return {
        ...c,
        messages: [...c.messages, { id: localId, role: "user", body, refs: {}, at: new Date().toISOString(), failed: true }],
      };
    });
  };
  const send = useMutation({
    mutationFn: (v: { localId: string; body: string }) => api.coachMessage(v.body),
    onMutate: (v) => {
      echo(v.localId, v.body);
      fired();
    },
    // Audit C16: a network-failed send used to silently vanish — the draft
    // was cleared on submit, and `onSettled: invalidate` (which ran even on
    // error) replaced the cache with the server's truth, which never saw
    // the message. Only invalidate on success now; on failure, mark the
    // optimistic echo itself so CoachThread can offer a retry instead of
    // erasing it.
    onError: (err, v) => {
      // Audit C16 residual: an abort can fire AFTER the request reached the
      // server — the route persists the athlete's message before the wake
      // spends a second thinking, so an abort doesn't prove the words were
      // lost the way a network error (never left the browser) does. The send
      // carries no deadline of its own any more, but a navigation or an
      // unload still aborts it in flight.
      // Refetch first and only mark it failed if it's genuinely absent.
      const isAbort = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
      if (isAbort) {
        void qc.invalidateQueries({ queryKey: ["coach-state"] }).then(() => {
          const cur = qc.getQueryData(["coach-state"]) as
            | { messages?: Array<{ role: string; body: string }> }
            | undefined;
          const persisted = cur?.messages?.some((m) => m.role === "user" && m.body === v.body);
          if (persisted) return; // it sent — the refetch already carries it
          markSendFailed(v.localId, v.body);
        });
        return;
      }
      markSendFailed(v.localId, v.body);
    },
    onSuccess: (res, v) => {
      // Opportunistic, never depended on — this lands when the wake is done,
      // long after the poll has shown the reply.
      // "busy": another wake held the lock past our patience — the message
      // IS saved server-side, but no reply came. Mark the echo so the
      // existing retry affordance offers to ask again (audit finding 16).
      if (res.status === "busy") {
        markSendFailed(v.localId, v.body);
        return;
      }
      invalidate();
    },
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
    mutationFn: (id: string) => api.coachApprove(id),
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
    acting: approve.isPending || decline.isPending,
    proposalErrors,
    send: (b: string) => send.mutate({ localId: `local-${newLocalId()}`, body: b }),
    resend: (localId: string, body: string) => {
      qc.setQueryData(["coach-state"], (cur: unknown) => {
        const c = cur as { messages?: Array<Record<string, unknown>> } | undefined;
        if (!c?.messages) return cur;
        return { ...c, messages: c.messages.filter((m) => m.id !== localId) };
      });
      send.mutate({ localId: `local-${newLocalId()}`, body });
    },
    checkIn: () => wakeMut.mutate(true),
    approve: (id: string) => approve.mutate(id),
    decline: (id: string) => decline.mutate(id),
    answer: (id: string, a: string) => answer.mutate({ id, answer: a }),
    dismissQuestion: (id: string) => dismissQuestion.mutate(id),
  };
}

/** Flash a proposal card (ghost tap). One CoachPanel mount now, so plain
 * ids — the old idPrefix threading (audit C27) retired with the dual mount.
 * `skipScroll` still applies on desktop: the window is an overlay whose tray
 * sits at the top, already visible the moment it opens. */
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

const WINDOW_OPEN_KEY = "rg.coachWindow.open";
const WINDOW_SEEN_KEY = "rg.coachWindow.seen";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the window simply doesn't persist */
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function PlanScreen() {
  const [params, setParams] = useSearchParams();
  const isDesktop = useIsDesktop();
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
  // Display units for the race strip (and anything else on this page that
  // shows a pace) — shares the Settings screen's query cache.
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
      const anchor = windowAnchor ?? localTodayGuess();
      return api.workouts(addDays(startOfIsoWeek(anchor), -28), addDays(startOfIsoWeek(anchor), 34));
    },
    // The window re-anchors as the user pages weeks — sliding it must reuse
    // the previous window's rows instead of emptying the grid.
    placeholderData: keepPreviousData,
  });

  const today = week.data ? (plan.data?.today ?? week.data.weekStart) : plan.data?.today;

  // ── Coach ──────────────────────────────────────────────────────────────
  const coach = usePlanCoach();
  const coachPlans = useQuery({ queryKey: ["coach-plans"], queryFn: api.coachPlans });
  // Subscribed here, rendered by `<RaceStrip>` — one fetch, shared key. The
  // page's first paint waits for it, so the strip never arrives late.
  const raceHub = useRaceHub();
  const activePlans = useMemo(
    () =>
      (coachPlans.data?.plans ?? []).filter(
        // A loose-session container has no weeks and no progressions to fetch —
        // its card renders from what the list already says it holds.
        (p) => (p.status === "active" || p.status === "draft") && p.kind !== "loose",
      ),
    [coachPlans.data?.plans],
  );
  const details = useQueries({
    queries: activePlans.map((p) => ({
      queryKey: ["plan-detail", p.id],
      queryFn: () => api.planDetail(p.id),
      staleTime: 60_000,
    })),
  });
  const detailById = useMemo(() => {
    const m = new Map<string, PlanDetailResponse | undefined>();
    activePlans.forEach((p, i) => m.set(p.id, details[i]?.data));
    return m;
  }, [activePlans, details]);

  const pendingCount = coach.state.data?.pendingProposals.length ?? 0;

  // ── Coach window state (desktop): open on pill/ghost tap or new coach
  // activity since last-seen; minimizing marks-seen (rework spec §6). ──────
  const watermark = coach.state.data
    ? `${coach.state.data.lastCoachAt ?? ""}:${pendingCount}:${coach.state.data.openQuestion?.id ?? ""}`
    : null;
  const [winOpen, setWinOpen] = useState(() => readStorage(WINDOW_OPEN_KEY) === "1");
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!isDesktop || !watermark || autoOpened.current) return;
    const seen = readStorage(WINDOW_SEEN_KEY);
    const hasActivity = pendingCount > 0 || !!coach.state.data?.openQuestion;
    if (watermark !== seen && hasActivity && !winOpen) {
      autoOpened.current = true;
      setWinOpen(true);
      writeStorage(WINDOW_OPEN_KEY, "1");
    }
  }, [isDesktop, watermark, pendingCount, coach.state.data?.openQuestion, winOpen]);
  const openWindow = () => {
    setWinOpen(true);
    writeStorage(WINDOW_OPEN_KEY, "1");
  };
  const minimizeWindow = () => {
    setWinOpen(false);
    writeStorage(WINDOW_OPEN_KEY, "0");
    if (watermark) writeStorage(WINDOW_SEEN_KEY, watermark);
  };

  const [coachOpen, setCoachOpen] = useState(false); // mobile sheet

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
  // The TITLE, not `stageSummary`. The stage line is richer where a session
  // has structure and worthless where it does not — the fixture's recovery
  // run carries "30 min", which turned the manifest's skip line into
  // "30 min — skipped" and named nothing at all. The title is the app's own
  // name for the session on every other surface (week grid, workout sheet,
  // calendar ghost), so the manifest calls it the same thing they do.
  const plannedRefs = useMemo(
    () =>
      new Map(
        (plan.data?.workouts ?? []).map((w) => [w.id, { date: w.effectiveDate, summary: w.title }]),
      ),
    [plan.data?.workouts],
  );
  const ghostsByDate = useMemo(
    () => pendingByDate(coach.state.data?.pendingProposals ?? [], plannedRefs),
    [plannedRefs, coach.state.data?.pendingProposals],
  );
  const onGhostTap = (proposalId: string) => {
    if (isDesktop) {
      openWindow();
      focusProposal(proposalId, true);
    } else {
      setCoachOpen(true);
      focusProposal(proposalId, false);
    }
  };
  const openCoachSurface = () => (isDesktop ? openWindow() : setCoachOpen(true));

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

  const cannedSend = (body: string) => {
    openCoachSurface();
    coach.send(body);
  };

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.coachPlanRename(v.id, v.name),
    onSettled: () => {
      for (const k of ["coach-plans", "plan-detail"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.coachPlanRetire(id),
    onSettled: () => {
      for (const k of ["coach-plans", "plan-detail", "plan", "plan-week", "coach-state"]) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
    },
  });

  // EVERY query that decides whether a block exists, not just the week's
  // (System 4 D1/D7a). `emptyPlan` below is an AND of two of them, so gating
  // on `week` alone let the page state "Nothing planned yet — ask your coach
  // for a plan" to somebody who has one: measured with /api/plan/workouts and
  // /api/coach/plans delayed, that sentence rendered for 3.5s and was then
  // replaced by the week grid. A false statement, not merely a shift. The
  // race strip is in here for the same reason one step milder — arriving late
  // it pushed the brief, the plan cards and the whole grid 80px down.
  //
  // All four carry `placeholderData: keepPreviousData` or a stable key, so
  // this holds the FIRST paint only: paging weeks and background refetches
  // still render straight from cache.
  if (settling(week, plan, coachPlans, raceHub) || (!week.data && week.isPending))
    return <Spinner label="Loading plan" />;
  if (!week.data) return <EmptyState title="Couldn't load the plan" />;

  // Shared between the window and the mobile sheet (audit C6 followup: the
  // only visible coach surface must say SOMETHING when loading/errored).
  const coachUnavailableCopy = coach.state.isLoading
    ? "Reading your week…"
    : "The coach is unreachable — manual controls all work.";
  // ONE prop list for the panel's two mounts. They differ by `hideHead` and
  // nothing else, and every prop added to the surface used to have to be
  // added in both places or work at one width only.
  const coachProps = coach.state.data && {
    messages: coach.state.data.messages,
    proposals: coach.state.data.pendingProposals,
    settledProposals: coach.state.data.settledProposals,
    question: coach.state.data.openQuestion,
    busy: coach.busy,
    acting: coach.acting,
    proposalErrors: coach.proposalErrors,
    planned: plannedRefs,
    onSend: coach.send,
    onApprove: coach.approve,
    onDecline: coach.decline,
    onAnswer: coach.answer,
    onDismiss: coach.dismissQuestion,
    onCheckIn: coach.checkIn,
    onRetrySend: coach.resend,
  };
  const coachPanelEl = coachProps ? (
    <CoachPanel {...coachProps} />
  ) : (
    <section className="coach-panel" aria-label="Coach">
      <div className="coach-panel-head">
        <h2>Coach</h2>
      </div>
      <div className="coach-thread">
        <p className="muted">{coachUnavailableCopy}</p>
      </div>
    </section>
  );

  // Claimed from two answers we actually hold. `?? 0` used to turn a query
  // that had not answered — or one that had FAILED — into "you have no plan".
  const emptyPlan =
    !!plan.data && !!coachPlans.data && plan.data.workouts.length === 0 && activePlans.length === 0;

  // One width contract (System 1 §6): while the coach window is up the page
  // yields exactly the gutter the window occupies (`--coach-w`, declared once
  // in styles.css and read by both), so the overlay stops covering 106px of
  // every card — and minimizing gives the column its width straight back
  // rather than leaving an empty 310px gutter.
  const coachReservesWidth = isDesktop && winOpen;
  return (
    <div className={`plan-page${coachReservesWidth ? " plan-page--coach-open" : ""}`}>
      <div className="row-between screen-title">
        <h1>Plan</h1>
        <CorosCheck state={corosCheck.state} />
      </div>
      <div className="plan-page-col">
        <SyncPanel quietWhenHealthy />
        <RaceStrip units={units} />
        <WeeklyBrief
          week={week.data}
          today={today}
          pendingCount={pendingCount}
          onNeedsYou={openCoachSurface}
          onResolveRace={(keep) => resolveRace.mutate(keep)}
          resolvingRace={resolveRace.isPending}
        />
        <PlanCards
          plans={coachPlans.data?.plans ?? []}
          details={detailById}
          onOpen={openPlan}
          onNew={(d) => openPlan(d === "run" ? "new-run" : "new-lift")}
        />
        {emptyPlan ? (
          <EmptyState art="🗓" title="Nothing planned yet">
            Ask your coach for a plan above, or start one in COROS — it syncs in automatically once
            COROS is connected in Settings.
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
          />
        )}
      </div>

      {isDesktop ? (
        <CoachWindow
          open={winOpen}
          pendingCount={pendingCount}
          onOpen={openWindow}
          onMinimize={minimizeWindow}
        >
          {coachPanelEl}
        </CoachWindow>
      ) : (
        <>
          <button
            type="button"
            className="coach-pill"
            aria-expanded={coachOpen}
            onClick={() => setCoachOpen(true)}
          >
            <span aria-hidden="true" className="coach-pill-caret">
              ▴
            </span>
            Coach{pendingCount > 0 ? ` · ${pendingCount}` : ""}
          </button>
          {/* `fill`: the coach panel owns its own scroll region, so the sheet
              hands it a definite height instead of letting it size to the
              viewport and paint outside the sheet (System 1 §2). */}
          <Sheet open={coachOpen} onClose={() => setCoachOpen(false)} title="Coach" fill>
            <div className="coach-sheet-panel">
              {coachProps ? (
                <CoachPanel hideHead {...coachProps} />
              ) : (
                <section className="coach-panel" aria-label="Coach">
                  <div className="coach-thread">
                    <p className="muted">{coachUnavailableCopy}</p>
                  </div>
                </section>
              )}
            </div>
          </Sheet>
        </>
      )}

      {planParam ? (
        <StudioModal
          planId={planParam}
          plans={coachPlans.data?.plans ?? []}
          onClose={closePlan}
          onCanned={(body) => {
            closePlan();
            cannedSend(body);
          }}
          onRetire={(id) => {
            retire.mutate(id);
            closePlan();
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
