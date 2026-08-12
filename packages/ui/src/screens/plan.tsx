import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type PlanDetailResponse, type WorkoutDto } from "@rg/api-client";
import { addDays, humanizeWorkoutTitle, startOfIsoWeek } from "@rg/domain";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  CorosPill,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatTime,
  Sheet,
  Spinner,
  SyncNotesStack,
  useIsDesktop,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";
import { SyncPanel } from "./today.js";
import { CoachPanel, pendingByDate } from "./coach-panel.js";
import { CoachRead } from "./coach-read.js";
import { CoachWindow } from "./coach-window.js";
import { WeeklyBrief } from "./plan-brief.js";
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
  const [moving, setMoving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
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
  const outOfSync = syncView === "needs_attention" || syncView === "calendar_only" || syncView === "sync_issue";

  const displayTitle = humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype);
  return (
    <Sheet open onClose={onClose} title={displayTitle}>
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
        {w.effectiveDate !== w.lastVerifiedCorosDate ? (
          <Banner kind={syncView === "needs_attention" || syncView === "sync_issue" ? "warn" : "info"}>
            {syncView === "needs_attention"
              ? `COROS has this on ${formatDayLong(w.lastVerifiedCorosDate)}; Run Garden has ${formatDayLong(w.effectiveDate)}. Pick where it should live.`
              : syncView === "calendar_only"
                ? `Your COROS watch still has this on ${formatDayLong(w.lastVerifiedCorosDate)} — this move hasn't been written to COROS.`
                : syncView === "sync_issue"
                  ? `The last update to COROS failed — your watch still shows ${formatDayLong(w.lastVerifiedCorosDate)}. Retry below.`
                  : `COROS still shows ${formatDayLong(w.lastVerifiedCorosDate)} — the update is on its way.`}
          </Banner>
        ) : null}
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
        {w.stageSummary ? <div className="stage-summary">{w.stageSummary}</div> : null}
        {stages.length > 0 ? (
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Full structure ({stages.filter((s) => s.kind !== "repeat").length} stages)
            </summary>
            <ul className="muted" style={{ paddingLeft: "1.2rem", marginTop: "0.4rem" }}>
              {stages.map((s) => (
                <li key={s.id as string}>
                  {s.kind as string}
                  {s.repeatCount ? ` × ${s.repeatCount}` : ""}
                  {s.durationSeconds ? ` — ${Math.round((s.durationSeconds as number) / 60)} min` : ""}
                  {s.distanceMeters ? ` — ${((s.distanceMeters as number) / 1000).toFixed(2)} km` : ""}
                  {s.label ? ` (${s.label})` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {match?.activity ? (
          <>
            <p className="muted">
              Completed with “{(match.activity.title as string) ?? "activity"}” ·{" "}
              {formatMinutes(match.activity.durationSeconds as number)}
              {match.activity.distanceMeters
                ? ` · ${((match.activity.distanceMeters as number) / 1000).toFixed(1)} km`
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

        <div className="btn-row">
          {completion === "scheduled" && w.category !== "rest" ? (
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
          {outOfSync && corosWritesEnabled ? (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Sync to COROS
            </button>
          ) : null}
          {w.calendarSyncState === "user_deleted" ? (
            <button className="btn" disabled={restore.isPending} onClick={() => restore.mutate()}>
              Restore to Calendar
            </button>
          ) : null}
          {(w.completionState === "completed") ? (
            <button className="btn" disabled={unmatch.isPending} onClick={() => unmatch.mutate()}>
              Undo match
            </button>
          ) : null}
          {w.completionState === "skipped" ? (
            <button className="btn" disabled={unskip.isPending} onClick={() => unskip.mutate()}>
              Un-skip
            </button>
          ) : null}
          {w.completionState !== "completed" ? (
            !confirmRemove ? (
              <button className="btn" onClick={() => setConfirmRemove(true)}>
                Remove from plan
              </button>
            ) : (
              <button className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Really remove — clears it from Run Garden and Calendar (COROS untouched)
              </button>
            )
          ) : null}
        </div>
        {outOfSync && !corosWritesEnabled ? (
          <p className="faint">
            COROS sync is off, so this can't be pushed to your watch.{" "}
            <Link to="/settings">Enable it in Settings</Link>.
          </p>
        ) : null}
      </div>
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
      <MatchSheet workout={w} open={matching} onClose={() => setMatching(false)} />
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

/**
 * Coach data wiring (Plan B Task B2): one shared ["coach-state"] query feeds
 * the panel AND the week's ghost diffs. On mount, a wake fires only when
 * the server says it's worth it (wakeAdvised) — quiet opens stay free, and
 * the server's single-flight lock makes racing tabs harmless.
 */
function usePlanCoach() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["coach-state"], queryFn: () => api.coachState() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["coach-state"] });
  const wakeMut = useMutation({ mutationFn: (force: boolean) => api.coachWake(force), onSettled: invalidate });
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
    onMutate: (v) => echo(v.localId, v.body),
    // Audit C16: a network-failed send used to silently vanish — the draft
    // was cleared on submit, and `onSettled: invalidate` (which ran even on
    // error) replaced the cache with the server's truth, which never saw
    // the message. Only invalidate on success now; on failure, mark the
    // optimistic echo itself so CoachThread can offer a retry instead of
    // erasing it.
    onError: (err, v) => {
      // Audit C16 residual: the 320s timeout can fire AFTER the request
      // reached the server — coach-wake.ts persists the user's message
      // before anything else can fail, so an abort doesn't prove the words
      // were lost the way a network error (never left the browser) does.
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
    onSuccess: invalidate,
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
    onSettled: invalidate,
  });
  return {
    state,
    busy: wakeMut.isPending || send.isPending || answer.isPending,
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
  });

  // Wider workout window (picked week ±4 weeks): ghost date resolution and
  // the workout-detail deep link both need more than seven days in hand.
  const windowAnchor = pickedWeek ?? week.data?.weekStart ?? null;
  const plan = useQuery({
    queryKey: ["plan", windowAnchor ?? "boot"],
    queryFn: () => {
      const anchor = windowAnchor ?? new Date().toISOString().slice(0, 10);
      return api.workouts(addDays(startOfIsoWeek(anchor), -28), addDays(startOfIsoWeek(anchor), 34));
    },
  });

  const today = week.data ? (plan.data?.today ?? week.data.weekStart) : plan.data?.today;

  // ── Coach ──────────────────────────────────────────────────────────────
  const coach = usePlanCoach();
  const coachPlans = useQuery({ queryKey: ["coach-plans"], queryFn: api.coachPlans });
  const activePlans = useMemo(
    () => (coachPlans.data?.plans ?? []).filter((p) => p.status === "active" || p.status === "draft"),
    [coachPlans.data?.plans],
  );
  const details = useQueries({
    queries: activePlans.map((p) => ({
      queryKey: ["plan-detail", p.id],
      queryFn: () => api.planDetail(p.id),
      staleTime: 60_000,
      // COROS-imported plans have no studio/coach detail behind them —
      // fetching would just 404 on every Plan visit.
      enabled: p.source !== "coros",
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

  // ── Ghosts ─────────────────────────────────────────────────────────────
  const ghostsByDate = useMemo(() => {
    const dates = new Map((plan.data?.workouts ?? []).map((w) => [w.id, w.effectiveDate]));
    return pendingByDate(coach.state.data?.pendingProposals ?? [], dates);
  }, [plan.data?.workouts, coach.state.data?.pendingProposals]);
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
    const next = new URLSearchParams(params);
    if (today && monday === startOfIsoWeek(today)) next.delete("week");
    else next.set("week", monday);
    setParams(next);
  };

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

  if (week.isLoading || (!week.data && week.isPending)) return <Spinner label="Loading plan" />;
  if (!week.data) return <EmptyState title="Couldn't load the plan" />;

  // Shared between the window and the mobile sheet (audit C6 followup: the
  // only visible coach surface must say SOMETHING when loading/errored).
  const coachUnavailableCopy = coach.state.isLoading
    ? "Reading your week…"
    : "The coach is unreachable — manual controls all work.";
  const coachPanelEl = coach.state.data ? (
    <CoachPanel
      messages={coach.state.data.messages}
      proposals={coach.state.data.pendingProposals}
      question={coach.state.data.openQuestion}
      busy={coach.busy}
      acting={coach.acting}
      proposalErrors={coach.proposalErrors}
      onSend={coach.send}
      onApprove={coach.approve}
      onDecline={coach.decline}
      onAnswer={coach.answer}
      onCheckIn={coach.checkIn}
      onRetrySend={coach.resend}
    />
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

  const anyDialogOpen = !!selected || !!planParam || coachOpen;
  const emptyPlan = (plan.data?.workouts.length ?? 0) === 0 && activePlans.length === 0;

  return (
    <div className="plan-page">
      <div className="row-between screen-title">
        <h1>Plan</h1>
        <CorosCheck state={corosCheck.state} />
      </div>
      <div className="plan-page-col">
        <SyncPanel quietWhenHealthy />
        <WeeklyBrief week={week.data} pendingCount={pendingCount} onNeedsYou={openCoachSurface} />
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
          dialogOpen={anyDialogOpen}
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
          <Sheet open={coachOpen} onClose={() => setCoachOpen(false)} title="Coach">
            <div className="coach-sheet-panel">
              {coach.state.data ? (
                <CoachPanel
                  hideHead
                  messages={coach.state.data.messages}
                  proposals={coach.state.data.pendingProposals}
                  question={coach.state.data.openQuestion}
                  busy={coach.busy}
                  acting={coach.acting}
                  proposalErrors={coach.proposalErrors}
                  onSend={coach.send}
                  onApprove={coach.approve}
                  onDecline={coach.decline}
                  onAnswer={coach.answer}
                  onCheckIn={coach.checkIn}
                  onRetrySend={coach.resend}
                />
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
