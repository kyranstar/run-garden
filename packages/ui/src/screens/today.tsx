import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type TodayResponse, type WorkoutDto } from "@rg/api-client";
import { GARDEN_CONDITION_LABELS } from "@rg/domain";
import {
  Banner,
  Card,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  CorosPill,
  EmptyState,
  formatDayLong,
  formatDayShort,
  formatMinutes,
  formatTime,
  relativeDay,
  Spinner,
  SyncNotesStack,
  SyncStatusLine,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";

/**
 * Shared sync status + notes (sync-transparency Task 12) — mounted once per
 * screen (Today, Garden, Plan, Studio) so the account's sync state boils
 * down to one line + one dismissible notes feed everywhere, backed by
 * `GET /api/sync/status` and `GET /api/sync/notes` rather than each screen's
 * own read of the legacy `TodayResponse.sync` shape.
 */
export function SyncPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["sync-status"], queryFn: api.syncStatus, refetchInterval: 30_000 });
  const notes = useQuery({ queryKey: ["sync-notes"], queryFn: api.syncNotes, refetchInterval: 30_000 });
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});

  const invalidateAfterUndo = () => {
    void qc.invalidateQueries({ queryKey: ["sync-status"] });
    void qc.invalidateQueries({ queryKey: ["sync-notes"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["studio"] });
  };

  const retry = useMutation({
    mutationFn: api.readNow,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sync-status"] }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissSyncNote(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sync-notes"] }),
  });
  const undo = useMutation({
    mutationFn: (id: string) => api.undoSyncNote(id),
    onSuccess: (_data, id) => {
      setUndoErrors((e) => {
        if (!(id in e)) return e;
        const next = { ...e };
        delete next[id];
        return next;
      });
      invalidateAfterUndo();
    },
    onError: (err: unknown, id: string) => {
      // adopted_coros_edit/removal notes forward to the same studio-adoption
      // undo the Studio screen's per-row button uses — a renamed-on-COROS row
      // 409s the same way there (studio.tsx's `undoAdoption` mutation).
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

  if (!status.data) return null;

  return (
    <div className="stack" style={{ gap: "0.5rem" }} aria-live="polite">
      <SyncStatusLine status={status.data} onRetry={() => retry.mutate()} />
      <SyncNotesStack
        notes={notes.data?.notes ?? []}
        onDismiss={(id) => dismiss.mutate(id)}
        onUndo={(id) => undo.mutate(id)}
        undoPendingId={undo.isPending ? undo.variables : null}
        undoErrors={undoErrors}
      />
    </div>
  );
}

export function NextWorkout({ w, today }: { w: WorkoutDto; today: string }) {
  const [moving, setMoving] = useState(false);
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryCoros(w.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["today"] }),
  });
  // Derived view (sync-transparency Task 10) takes precedence; the stored
  // legacy column is the fallback for any DTO that hasn't opted into it.
  const syncView = w.corosSyncView ?? w.corosSyncState;

  if (w.category === "rest") {
    return (
      <Card title="Next up" className="card-next">
        <h2 className="hero-title">Rest day</h2>
        <p className="hero-when">{relativeDay(w.effectiveDate, today)}</p>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          A planned rest day. The garden rests with you — soil health improves today.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Next workout" className="card-next">
      <div className="row" style={{ marginBottom: "0.2rem" }}>
        <CategoryDot category={w.category} />
        <span className="faint">{CATEGORY_LABELS[w.category] ?? w.category}</span>
        <CorosPill state={syncView} hideWhenHealthy />
      </div>
      <h2 className="hero-title">{w.title}</h2>
      <p className="hero-when">
        {relativeDay(w.effectiveDate, today)} at {formatTime(w.effectiveTime)}
      </p>
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
      <div className="btn-row">
        <Link className="btn btn-primary" to={`/plan?workout=${w.id}`}>
          View workout
        </Link>
        <button className="btn" onClick={() => setMoving(true)}>
          Move
        </button>
        {syncView === "needs_attention" || syncView === "calendar_only" || syncView === "sync_issue" ? (
          <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
            Sync to COROS
          </button>
        ) : null}
      </div>
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
    </Card>
  );
}

export function UnresolvedCard({ w }: { w: WorkoutDto }) {
  const qc = useQueryClient();
  const [matching, setMatching] = useState(false);
  const [moving, setMoving] = useState(false);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["plan"] });
  };
  const skip = useMutation({ mutationFn: () => api.skip(w.id), onSuccess: invalidate });
  const defer = useMutation({ mutationFn: () => api.defer(w.id), onSuccess: invalidate });

  return (
    <Card title="Did this run happen?" className="card-prompt">
      <div className="row" style={{ marginBottom: "0.4rem" }}>
        <CategoryDot category={w.category} />
        <strong>{w.title}</strong>
        <span className="muted">{formatDayLong(w.effectiveDate)}</span>
      </div>
      <p className="muted" style={{ marginBottom: "0.7rem" }}>
        No matching activity has arrived yet. A slow sync is never counted against you.
      </p>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => setMatching(true)}>
          Yes, match an activity
        </button>
        <button className="btn" onClick={() => setMoving(true)}>
          Move it
        </button>
        <button className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
          Skip it
        </button>
        <button className="btn" disabled={defer.isPending} onClick={() => defer.mutate()}>
          Not yet
        </button>
      </div>
      <MatchSheet workout={w} open={matching} onClose={() => setMatching(false)} />
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
    </Card>
  );
}

export function Readiness({ readiness }: { readiness: TodayResponse["readiness"] }) {
  if (!readiness.latest || readiness.sampleDays < 3) return null;
  const l = readiness.latest;
  const b = readiness.baseline;
  const lines: string[] = [];
  if (l.restingHeartRate != null && b?.restingHeartRate != null) {
    const diff = Math.round(l.restingHeartRate - b.restingHeartRate);
    if (Math.abs(diff) >= 2) {
      lines.push(
        `Resting heart rate is ${Math.abs(diff)} bpm ${diff > 0 ? "above" : "below"} your recent median.`,
      );
    }
  }
  if (l.hrv != null && b?.hrv != null) {
    const diff = Math.round(l.hrv - b.hrv);
    if (Math.abs(diff) >= 5) {
      lines.push(`HRV is ${Math.abs(diff)} ms ${diff > 0 ? "above" : "below"} your recent median.`);
    }
  }
  if (l.recoveryScore != null) lines.push(`COROS recovery: ${Math.round(l.recoveryScore)}%.`);
  if (lines.length === 0) lines.push("Recovery signals look typical for you.");
  const asOf = (l as { date?: string }).date;
  return (
    <Card title="Readiness">
      {lines.slice(0, 3).map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
      <p className="faint" style={{ marginTop: "0.4rem" }}>
        {asOf ? `From COROS, as of ${formatDayShort(asOf)}. ` : ""}Context, not instructions — you know
        your body best.
      </p>
    </Card>
  );
}

export function EvidenceCard() {
  const qc = useQueryClient();
  const insights = useQuery({
    queryKey: ["insights"],
    queryFn: () => api.insights(),
    staleTime: 5 * 60_000,
  });
  const dismiss = useMutation({
    mutationFn: (cardId: string) => api.dismissInsight(cardId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["insights"] }),
  });
  const card = insights.data?.evidence as { id: string; text: string; sampleNote: string } | null | undefined;
  if (!card) return null;
  return (
    <Card title="Worth knowing">
      <p>{card.text}</p>
      <p className="faint" style={{ margin: "0.35rem 0 0.6rem" }}>{card.sampleNote}</p>
      <button className="btn btn-small" onClick={() => dismiss.mutate(card.id)}>
        Dismiss
      </button>
    </Card>
  );
}

function GardenPreview({ garden }: { garden: NonNullable<TodayResponse["garden"]> }) {
  const recent = garden.recentEvents.find((e) => e.kind === "run_completed" || e.kind === "plant_added");
  const sentence =
    recent?.kind === "plant_added"
      ? "A recent workout planted something new."
      : garden.wateredYesterday
        ? "Yesterday's run restored moisture across the garden."
        : garden.condition === "in_drought"
          ? "The garden is dry — your next run brings the rain."
          : garden.condition === "a_little_dry"
            ? "The garden could use a run soon."
            : "The garden is quietly growing.";
  return (
    <Card title="Garden">
      <div className="row-between">
        <div>
          <p style={{ fontWeight: 650 }}>{GARDEN_CONDITION_LABELS[garden.condition]}</p>
          <p className="muted">{sentence}</p>
        </div>
        <Link to="/garden" className="btn btn-small">
          Visit
        </Link>
      </div>
    </Card>
  );
}

export function TodayScreen() {
  const today = useQuery({ queryKey: ["today"], queryFn: api.today, refetchInterval: 60_000 });

  // App-open freshness: nudge a COROS read the moment this screen mounts, so
  // today's plan is maximally current. Server-side deduped (a recent-enough
  // successful read, or one already in flight, both short-circuit to a
  // no-op) — safe to fire on every mount, errors ignored.
  useEffect(() => {
    void api.readNow().catch(() => undefined);
  }, []);

  if (today.isLoading) return <Spinner label="Loading today" />;
  if (today.isError || !today.data) {
    return (
      <EmptyState title="Couldn't load your plan">
        Check your connection and try again.
      </EmptyState>
    );
  }
  const d = today.data;

  return (
    <div className="stack">
      <h1 className="visually-hidden">Today</h1>
      {d.nextWorkout ? (
        <NextWorkout w={d.nextWorkout} today={d.today} />
      ) : (
        <EmptyState art="🌿" title="No active COROS training plan was found">
          Start a plan in COROS, then refresh from the desktop app.
        </EmptyState>
      )}
      {d.sync.calendarConnected ? (
        <SyncPanel />
      ) : (
        <Banner kind="info">Your training plan is safe, but Calendar mirroring is paused.</Banner>
      )}
      {d.sync.stravaStatus === "error" ? (
        <Banner kind="info">
          Strava access has stopped (its subscription may have lapsed). Completed runs still sync
          from COROS — just a little slower. Route details and instant completions pause until you{" "}
          <Link to="/settings">reconnect Strava</Link>.
        </Banner>
      ) : null}
      {d.needsAttention.length > 0 ? (
        <Banner kind="warn">
          {d.needsAttention.length === 1
            ? `“${d.needsAttention[0]!.title}” needs attention — COROS and Run Garden disagree.`
            : `${d.needsAttention.length} workouts need attention.`}{" "}
          <Link to="/plan">Review</Link>
        </Banner>
      ) : null}
      {d.unresolved.map((w) => (
        <UnresolvedCard key={w.id} w={w} />
      ))}
      <Readiness readiness={d.readiness} />
      <EvidenceCard />
      {d.garden ? <GardenPreview garden={d.garden} /> : null}
    </div>
  );
}
