import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type WorkoutDto } from "@rg/api-client";
import { addDays, startOfIsoWeek } from "@rg/domain";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  CorosPill,
  dayOfMonth,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatTime,
  monthTitle,
  Sheet,
  Spinner,
  SyncNotesStack,
  useIsDesktop,
} from "../components.js";
import { IconAlert, IconCheck, IconClock } from "../icons.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";
import { StudioSection } from "./studio.js";
import { SyncPanel } from "./today.js";
import { CoachPanel, ManagePlans, pendingByDate } from "./coach-panel.js";
import { CoachRead } from "./coach-read.js";

/**
 * "Did this run happen?" only ever makes sense for a date that has passed.
 * A workout can sit in `unresolved` with a future date briefly (it was
 * rescheduled after the question was raised); render it as scheduled.
 */
function askable(w: WorkoutDto, today: string): boolean {
  return w.completionState === "unresolved" && w.effectiveDate <= today;
}

function displayCompletionState(w: WorkoutDto, today: string): WorkoutDto["completionState"] {
  return w.completionState === "unresolved" && !askable(w, today) ? "scheduled" : w.completionState;
}

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

  return (
    <Sheet open onClose={onClose} title={w.title}>
      <div className="stack">
        <div className="row">
          <CategoryDot category={w.category} />
          <span className="muted">{CATEGORY_LABELS[w.category] ?? w.category}</span>
          <CompletionPill state={completion} />
          <CorosPill state={syncView} hideWhenHealthy />
        </div>
        <p>
          {formatDayLong(w.effectiveDate)} at {formatTime(w.effectiveTime)}
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

// ── Calendar assembly ────────────────────────────────────────────────────────

interface CalDay {
  date: string;
  items: WorkoutDto[];
}
interface CalWeek {
  weekStart: string;
  days: CalDay[];
}
interface CalMonth {
  key: string;
  month: string;
  year: number;
  weeks: CalWeek[];
}

/** Continuous ISO weeks spanning the plan (and today), grouped by the month
 * their Monday falls in — gaps render as quiet empty cells, like an almanac. */
function buildMonths(workouts: WorkoutDto[], today: string | undefined): CalMonth[] {
  const byDate = new Map<string, WorkoutDto[]>();
  for (const w of workouts) {
    const list = byDate.get(w.effectiveDate) ?? [];
    list.push(w);
    byDate.set(w.effectiveDate, list);
  }
  if (byDate.size === 0) return [];
  const dates = [...byDate.keys()].sort();
  let start = startOfIsoWeek(dates[0]!);
  let end = startOfIsoWeek(dates[dates.length - 1]!);
  if (today) {
    const tw = startOfIsoWeek(today);
    if (tw < start) start = tw;
    if (tw > end) end = tw;
  }

  const months: CalMonth[] = [];
  for (let ws = start, guard = 0; ws <= end && guard < 80; ws = addDays(ws, 7), guard++) {
    const { month, year } = monthTitle(ws);
    const key = `${year}-${month}`;
    if (months.length === 0 || months[months.length - 1]!.key !== key) {
      months.push({ key, month, year, weeks: [] });
    }
    months[months.length - 1]!.weeks.push({
      weekStart: ws,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(ws, i);
        return { date, items: byDate.get(date) ?? [] };
      }),
    });
  }
  return months;
}

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WorkoutCell({
  w,
  today,
  onOpen,
}: {
  w: WorkoutDto;
  today: string;
  onOpen: () => void;
}) {
  const completion = displayCompletionState(w, today);
  const done = completion === "completed";
  const faded = completion === "skipped" || completion === "missed";
  const asks = askable(w, today);
  const syncView = w.corosSyncView ?? w.corosSyncState;
  const attention = syncView === "needs_attention" || syncView === "sync_issue";

  if (w.category === "rest") {
    return (
      <button className="cal-card cal-rest" onClick={onOpen}>
        <span className="cal-card-title">Rest</span>
      </button>
    );
  }
  return (
    <button
      className={`cal-card ${done ? "done" : ""} ${faded ? "faded" : ""} ${asks ? "asks" : ""}`}
      onClick={onOpen}
      title={w.title}
    >
      <i className={`cal-card-edge cat-${w.category}`} aria-hidden />
      <span className="cal-card-title">{w.title}</span>
      <span className="cal-card-meta">
        <span>{formatMinutes(w.workoutSeconds)}</span>
        {done ? (
          <span className="cal-glyph ok" title="Completed">
            <IconCheck size={11} />
          </span>
        ) : null}
        {asks ? (
          <span className="cal-glyph ask" title="Did this happen?">
            <IconClock size={11} />
          </span>
        ) : null}
        {attention ? (
          <span className="cal-glyph warn" title="Needs attention">
            <IconAlert size={11} />
          </span>
        ) : null}
        {completion === "skipped" ? <span className="cal-note">skipped</span> : null}
        {completion === "missed" ? <span className="cal-note">missed</span> : null}
      </span>
    </button>
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
 * the panel AND the calendar's ghost diffs. On mount, a wake fires only when
 * the server says it's worth it (wakeAdvised) — quiet opens stay free.
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
      for (const k of ["plan", "today", "garden"]) void qc.invalidateQueries({ queryKey: [k] });
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

/** DOM id prefix for the mobile sheet's copy of the coach panel — the
 * inline panel (hidden below 1024px, audit C6) uses no prefix, so the two
 * mounts never collide on the same id. */
const SHEET_ID_PREFIX = "sheet-";

/** Scroll a proposal card into view and flash it (calendar ghost tap).
 * Audit C27: `idPrefix` picks the copy that's actually visible at this
 * width — without it, `getElementById` always resolved to the inline
 * panel's node (first in DOM order) even when only the sheet was showing.
 * Audit C27 followup: on desktop the coach column is `position: sticky`
 * (C5), so it's already on screen — scrollIntoView-ing an element inside a
 * sticky ancestor drags the whole PAGE to re-center it, an unwanted second
 * scroll jump. `skipScroll` leaves the page alone there; the flash alone is
 * enough since the panel never left the viewport. */
function focusProposal(id: string, idPrefix: string, skipScroll: boolean): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(`proposal-${idPrefix}${id}`);
    if (!el) return;
    if (!skipScroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("coach-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("coach-flash");
  });
}

export function PlanScreen() {
  const [params, setParams] = useSearchParams();
  // Explicit horizon: the server's default window (8 weeks ahead) is shorter
  // than the longest lifting plan (16 weeks) — without this, a synced plan's
  // back half was visible nowhere in the app.
  const plan = useQuery({
    queryKey: ["plan"],
    queryFn: () => {
      const d = new Date();
      const iso = (x: Date) => x.toISOString().slice(0, 10);
      const start = new Date(d);
      start.setDate(start.getDate() - 8 * 7);
      const end = new Date(d);
      end.setDate(end.getDate() + 18 * 7);
      return api.workouts(iso(start), iso(end));
    },
  });
  const selectedId = params.get("workout");
  const todayRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);
  const today = plan.data?.today;
  const todayWeek = today ? startOfIsoWeek(today) : null;

  const coach = usePlanCoach();
  const coachPlans = useQuery({ queryKey: ["coach-plans"], queryFn: api.coachPlans });
  const isDesktop = useIsDesktop();
  const [coachOpen, setCoachOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const qc = useQueryClient();
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.coachPlanRename(v.id, v.name),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["coach-plans"] }),
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.coachPlanRetire(id),
    onSettled: () => {
      for (const k of ["coach-plans", "plan", "coach-state"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  // Audit C27 followup: same duplicate-modal shape as onGhostTap — the
  // inline panel is always visible and sticky on desktop, so opening the
  // sheet there is a redundant second "Coach" surface, not the intentional
  // hand-off it is on mobile (where the sheet is the only coach surface).
  const cannedSend = (body: string) => {
    setManageOpen(false);
    if (!isDesktop) setCoachOpen(true);
    coach.send(body);
  };
  const ghostsByDate = useMemo(() => {
    const dates = new Map((plan.data?.workouts ?? []).map((w) => [w.id, w.effectiveDate]));
    return pendingByDate(coach.state.data?.pendingProposals ?? [], dates);
  }, [plan.data?.workouts, coach.state.data?.pendingProposals]);
  // Audit C27: this used to open the coach Sheet on every width, on the
  // (false) assumption it was a visual no-op on desktop — Sheet renders as
  // a centered dialog at every breakpoint, so desktop got a redundant
  // second "Coach" modal covering the calendar. Below 1024px the inline
  // panel is hidden (C6), so the sheet is the only visible surface there;
  // above it, the always-visible inline panel is enough — just scroll to it.
  const onGhostTap = (proposalId: string) => {
    if (!isDesktop) setCoachOpen(true);
    focusProposal(proposalId, isDesktop ? "" : SHEET_ID_PREFIX, isDesktop);
  };

  // Land on the current week on first load, so today's work is front and
  // centre instead of buried under weeks of history.
  useEffect(() => {
    if (plan.data && !scrolled.current && todayRef.current) {
      scrolled.current = true;
      todayRef.current.scrollIntoView({ block: "center" });
    }
  }, [plan.data]);

  const months = useMemo(
    () => buildMonths(plan.data?.workouts ?? [], plan.data?.today),
    [plan.data],
  );

  if (plan.isLoading) return <Spinner label="Loading plan" />;
  if (!plan.data) return <EmptyState title="Couldn't load the plan" />;

  const selected = plan.data.workouts.find((w) => w.id === selectedId);
  const openWorkout = (id: string) => setParams({ workout: id });

  // Shared between the inline panel and the mobile sheet fallback (audit
  // C6 followup: the sheet used to render nothing at all here — loading or
  // errored, it just went blank, and it's now the ONLY mobile coach surface).
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

  const pendingCount = coach.state.data?.pendingProposals.length ?? 0;
  const activeCoachPlans = (coachPlans.data?.plans ?? []).filter(
    (p) => p.status === "active" && p.source !== "studio",
  );

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Plan</h1>
        <div className="row">
          {plan.data.plan ? <span className="muted">{plan.data.plan.name}</span> : null}
          <button className="btn btn-small" onClick={() => setManageOpen(true)}>
            Manage plans ▾
          </button>
          {plan.data.workouts.length > 0 ? (
            <button
              className="btn btn-small"
              onClick={() => todayRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })}
            >
              Today
            </button>
          ) : null}
        </div>
      </div>
      <div className="plan-split">
        <div className="plan-split-coach">{coachPanelEl}</div>
        <div>
          <SyncPanel />
          {plan.data.workouts.length === 0 ? (
        <EmptyState art="🗓" title="No active COROS training plan was found">
          Start a plan in COROS, then refresh from the desktop app.
        </EmptyState>
      ) : (
        months.map((m) => (
          <section key={m.key} className="cal-month">
            <h2 className="cal-month-title">
              {m.month} <span className="cal-year">{m.year}</span>
            </h2>
            <div className="cal-weekdays" aria-hidden>
              {WEEKDAY_HEADERS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            {m.weeks.map((week) => (
              <div
                key={week.weekStart}
                className={`cal-week ${week.weekStart === todayWeek ? "current" : ""}`}
                ref={week.weekStart === todayWeek ? todayRef : undefined}
              >
                {week.days.map((day) => {
                  const isToday = day.date === today;
                  const isPast = !!today && day.date < today;
                  // Audit C22: a coach proposal that adds a session to an
                  // otherwise-empty day used to be invisible on mobile — the
                  // agenda view hides any day lacking `has-items`, and that
                  // class only ever looked at real workouts, never ghosts.
                  // Kept as its own `has-ghosts` class (not folded into
                  // `has-items`, audit C22 followup) so a ghost-only day
                  // still renders but keeps its dashed "nothing scheduled
                  // yet" look instead of borrowing the solid real-workout
                  // treatment.
                  const hasGhosts = (ghostsByDate.get(day.date)?.length ?? 0) > 0;
                  return (
                    <div
                      key={day.date}
                      className={`cal-day ${isToday ? "is-today" : ""} ${isPast ? "is-past" : ""} ${day.items.length > 0 ? "has-items" : ""} ${hasGhosts ? "has-ghosts" : ""}`}
                    >
                      <div className="cal-date">
                        <span className="cal-dow">{WEEKDAY_HEADERS[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7]}</span>
                        <span className="cal-dom">{dayOfMonth(day.date)}</span>
                      </div>
                      {day.items.map((w) => (
                        <WorkoutCell key={w.id} w={w} today={today!} onOpen={() => openWorkout(w.id)} />
                      ))}
                      {(ghostsByDate.get(day.date) ?? []).map((g, i) => (
                        <button
                          key={`${g.proposalId}-${i}`}
                          type="button"
                          className={`cal-ghost cal-ghost-${g.kind}`}
                          onClick={() => onGhostTap(g.proposalId)}
                          title={g.title}
                        >
                          {g.label}
                          <span className="cal-ghost-reason">{g.title} · pending</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        ))
      )}
      {activeCoachPlans.length > 0 ? (
        <button
          type="button"
          className="cal-extend-row"
          onClick={() =>
            cannedSend(`Extend "${activeCoachPlans[0]!.name}" — draft the next weeks in the same shape.`)
          }
        >
          + extend {activeCoachPlans[0]!.name} — the coach drafts the next weeks
        </button>
      ) : null}
      <StudioSection />
        </div>
      </div>

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
              idPrefix={SHEET_ID_PREFIX}
            />
          ) : (
            // The sheet already carries "Coach" as its own dialog title, so
            // no second head here — but loading/errored must still say
            // something instead of leaving the only mobile coach surface
            // blank.
            <section className="coach-panel" aria-label="Coach">
              <div className="coach-thread">
                <p className="muted">{coachUnavailableCopy}</p>
              </div>
            </section>
          )}
        </div>
      </Sheet>
      <Sheet open={manageOpen} onClose={() => setManageOpen(false)} title="Manage plans">
        <ManagePlans
          plans={coachPlans.data?.plans ?? []}
          onCanned={cannedSend}
          onRetire={(id) => retire.mutate(id)}
          onRename={(id, name) => rename.mutate({ id, name })}
        />
      </Sheet>
      {selected && today ? (
        <WorkoutDetail
          w={selected}
          today={today}
          corosWritesEnabled={plan.data.corosWritesEnabled ?? false}
          onClose={() => setParams({})}
        />
      ) : null}
    </div>
  );
}
