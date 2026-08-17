import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type TodayResponse, type WorkoutDto } from "@rg/api-client";
import { reviewUnseen } from "../charts-math.js";
import { shouldInvalidateGarden } from "./arrival.js";
import {
  Banner,
  Card,
  CategoryDot,
  CATEGORY_LABELS,
  CorosPill,
  formatDayLong,
  formatDayShort,
  formatMinutes,
  formatTime,
  relativeDay,
  SyncNotesStack,
  SyncStatusLine,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";

/**
 * Shared cards for the screens that route (this module's old TodayScreen is
 * gone — the router mounts Garden/Plan/Runs/Insights/Settings, and Garden
 * absorbed the landing-screen role). Everything exported here is rendered
 * by garden.tsx and/or plan.tsx.
 */

/**
 * Shared sync status + notes (sync-transparency Task 12) — mounted once per
 * screen (Garden, Plan, Studio) so the account's sync state boils
 * down to one line + one dismissible notes feed everywhere, backed by
 * `GET /api/sync/status` and `GET /api/sync/notes` rather than each screen's
 * own read of the legacy `TodayResponse.sync` shape.
 */
export function SyncPanel({ quietWhenHealthy = false }: { quietWhenHealthy?: boolean } = {}) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["sync-status"], queryFn: api.syncStatus, refetchInterval: 30_000 });
  const notes = useQuery({ queryKey: ["sync-notes"], queryFn: api.syncNotes, refetchInterval: 30_000 });
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});

  // Freshness (reward-loop spec §1): a COROS read landing means new
  // activities/completions may have grown the garden — refetch it while the
  // user is looking instead of waiting for a remount. This panel already
  // polls sync status every 30s on Garden/Today/Plan/Studio, so the watch
  // costs nothing extra.
  const lastRead = status.data?.lastCorosReadAt ?? null;
  const prevReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (shouldInvalidateGarden(prevReadRef.current, lastRead)) {
      void qc.invalidateQueries({ queryKey: ["garden"] });
      void qc.invalidateQueries({ queryKey: ["garden-timeline"] });
    }
    prevReadRef.current = lastRead;
  }, [lastRead, qc]);

  const invalidateAfterUndo = () => {
    void qc.invalidateQueries({ queryKey: ["sync-status"] });
    void qc.invalidateQueries({ queryKey: ["sync-notes"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["studio"] });
  };

  const retry = useMutation({
    // Actually retries the failed writes `issueCount` is made of (superseded
    // jobs re-applied, failed studio rows re-pushed) — `readNow()` used to be
    // wired here, but a read can never clear a write failure (see retrySync's
    // own doc comment, apps/worker/src/routes/sync.ts).
    mutationFn: api.retrySync,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sync-status"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["studio"] });
    },
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
  // Rework spec §6: on the plan page the sync line only exists when something
  // needs attention or an undoable note is pending — healthy is silence.
  const cloudHealthy =
    status.data.cloud != null && status.data.cloud.connected && !status.data.cloud.error && status.data.issueCount === 0;
  if (
    quietWhenHealthy &&
    (status.data.state === "in_sync" || cloudHealthy) &&
    (notes.data?.notes ?? []).length === 0
  ) {
    return null;
  }

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }} aria-live="polite">
      <SyncStatusLine status={status.data} onRetry={() => retry.mutate()} retrying={retry.isPending} />
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
        <h3 className="hero-title">Rest day</h3>
        <p className="hero-when">{relativeDay(w.effectiveDate, today)}</p>
        <p className="muted" style={{ marginTop: "var(--space-4)" }}>
          A planned rest day. The garden rests with you — soil health improves today.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Next workout" className="card-next">
      <div className="row" style={{ marginBottom: "var(--space-2)" }}>
        <CategoryDot category={w.category} />
        <span className="faint">{CATEGORY_LABELS[w.category] ?? w.category}</span>
        <CorosPill state={syncView} hideWhenHealthy />
      </div>
      <h3 className="hero-title">{w.title}</h3>
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
      {(w.exercises?.length ?? 0) > 0 ? (
        <div className="exercise-prescription">
          {w.exerciseRounds ? <span className="rounds">{w.exerciseRounds} rounds of:</span> : null}
          <ul className="exercise-list">
            {w.exercises!.map((e) => (
              <li key={e.line}>{e.line}</li>
            ))}
          </ul>
        </div>
      ) : w.stageSummary ? (
        <div className="stage-summary">{w.stageSummary}</div>
      ) : null}
      <div className="btn-row">
        <Link className="btn btn-primary" to={`/plan?workout=${w.id}`}>
          View workout
        </Link>
        <button className="btn" onClick={() => setMoving(true)}>
          Move
        </button>
        {/* Not offered on an exercise session: the create executor builds a
            structured RUN program and nothing else, so there is nothing a
            retry could send (2026-08-16 — same reasoning as plan.tsx). */}
        {(syncView === "needs_attention" || syncView === "calendar_only" || syncView === "sync_issue") &&
        (w.exercises?.length ?? 0) === 0 ? (
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
    void qc.invalidateQueries({ queryKey: ["garden"] });
  };
  const skip = useMutation({ mutationFn: () => api.skip(w.id), onSuccess: invalidate });
  const defer = useMutation({ mutationFn: () => api.defer(w.id), onSuccess: invalidate });

  return (
    <Card title="Did this run happen?" className="card-prompt">
      <div className="row" style={{ marginBottom: "var(--space-3)" }}>
        <CategoryDot category={w.category} />
        <strong>{w.title}</strong>
        <span className="muted">{formatDayLong(w.effectiveDate)}</span>
      </div>
      <p className="muted" style={{ marginBottom: "var(--space-5)" }}>
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

/**
 * Both numbers, and what they're measured against, on the face of the card.
 *
 * "Resting heart rate is 7 bpm above your recent median" said neither what
 * the reading was nor what "recent" meant — and Insights, which compares its
 * own (longer, differently-shaped) windows, could truthfully headline the
 * same signal with the opposite sign on the same day. The comparison here is
 * exactly what `/api/today` sends: ONE morning's reading (`latest`, dated)
 * against the median of the `sampleDays` days of COROS data behind it
 * (`baseline`). Naming both is the difference between two surfaces that
 * disagree and two surfaces that measure different things.
 */
export function Readiness({ readiness }: { readiness: TodayResponse["readiness"] }) {
  if (!readiness.latest || readiness.sampleDays < 3) return null;
  const l = readiness.latest;
  const b = readiness.baseline;
  const lines: string[] = [];
  // Set by any line that compares the reading with the baseline median, so
  // the footnote only explains a comparison the card actually made.
  let compared = false;
  if (l.restingHeartRate != null && b?.restingHeartRate != null) {
    const diff = Math.round(l.restingHeartRate - b.restingHeartRate);
    if (Math.abs(diff) >= 2) {
      compared = true;
      lines.push(
        `Resting heart rate ${Math.round(l.restingHeartRate)} bpm — ${Math.abs(diff)} ${
          diff > 0 ? "above" : "below"
        } your ${Math.round(b.restingHeartRate)} bpm median.`,
      );
    }
  }
  if (l.hrv != null && b?.hrv != null) {
    const diff = Math.round(l.hrv - b.hrv);
    if (Math.abs(diff) >= 5) {
      compared = true;
      lines.push(
        `HRV ${Math.round(l.hrv)} ms — ${Math.abs(diff)} ${diff > 0 ? "above" : "below"} your ${Math.round(
          b.hrv,
        )} ms median.`,
      );
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
      <p className="faint" style={{ marginTop: "var(--space-3)" }}>
        {asOf ? `From COROS, as of ${formatDayShort(asOf)}. ` : ""}
        {compared
          ? `That single reading against the median of your last ${readiness.sampleDays} days of COROS data — ` +
            `Insights compares a longer window, so its numbers read differently. `
          : ""}
        Context, not instructions — you know your body best.
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
      <p className="faint" style={{ margin: "var(--space-3) 0 var(--space-4)" }}>{card.sampleNote}</p>
      <button className="btn btn-small" onClick={() => dismiss.mutate(card.id)}>
        Dismiss
      </button>
    </Card>
  );
}

/**
 * The weekly review's discovery line (earned-moments spec §2): shown on the
 * landing screen when a review the user hasn't opened exists. Client-side
 * seen mark — repetition on another device is harmless, unlike ceremonies.
 */
export function ReviewPull() {
  const insights = useQuery({
    queryKey: ["insights"],
    queryFn: () => api.insights(),
    staleTime: 5 * 60_000,
  });
  const latest = insights.data?.reviews?.[0] ?? null;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem("rg-review-seen");
  } catch {
    stored = null;
  }
  if (!latest?.narrative || !reviewUnseen(latest.weekStart, stored)) return null;
  const markSeen = () => {
    try {
      window.localStorage.setItem("rg-review-seen", latest.weekStart);
    } catch {
      // Storage unavailable — the pull will simply show again.
    }
  };
  return (
    <p className="review-pull">
      The week's story is written —{" "}
      <Link to="/insights" onClick={markSeen}>
        read it →
      </Link>
    </p>
  );
}

/** The current UTC offset a zone observes right now ("GMT-7") — travel
 * detection compares OFFSETS, not zone names, so America/Vancouver vs
 * America/Los_Angeles (same clock) never nags (audit#3 T2). */
function offsetNow(timeZone: string): string | null {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Travel nudge: prefs.timezone anchors every "today" in the product (garden
 * day rollover, coach dossier, plan week), but it only ever changes by hand —
 * prod data shows months of watch offsets disagreeing with it. One tap fixes
 * the anchor; dismissal is remembered per device zone for the session.
 * Rendered by garden.tsx at the top of the landing screen's plumbing stack.
 */
export function TimezoneNudge() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [dismissed, setDismissed] = useState(false);
  const adopt = useMutation({
    mutationFn: (timezone: string) => api.updateSettings({ timezone }),
    onSuccess: () => {
      for (const k of ["settings", "today", "plan-week", "plan", "garden"])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prefsTz = settings.data?.prefs.timezone;
  if (!deviceTz || !prefsTz || dismissed) return null;
  const storageKey = `tz-nudge-dismissed:${deviceTz}`;
  if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(storageKey)) return null;
  const deviceOffset = offsetNow(deviceTz);
  const prefsOffset = offsetNow(prefsTz);
  if (!deviceOffset || !prefsOffset || deviceOffset === prefsOffset) return null;
  return (
    <Banner kind="info">
      Your device clock says {deviceTz} ({deviceOffset}), but your days here run on {prefsTz} (
      {prefsOffset}) — traveling?
      {/* Actions, and an IANA zone id can be long ("America/Argentina/
          Buenos_Aires") — `.btn-wrap` so a long zone wraps inside the banner
          instead of a nowrap pill widening the page.

          They live in their OWN container, not loose in the banner's prose.
          Loose, they were two inline buttons in a text flow with `row-gap:
          normal` — a 0px visual gap — and each one's 44px hit pad reached
          2.2px into the other's visible box: a tap on the bottom edge of
          "Switch to …" adopted nothing and dismissed the prompt instead. The
          two choices are mutually exclusive, so `.tap-clear` grants the gap
          and licenses the pads. */}
      <span className="banner-actions tap-clear">
        <button
          type="button"
          className="btn btn-small btn-wrap"
          disabled={adopt.isPending}
          onClick={() => adopt.mutate(deviceTz)}
        >
          Switch to {deviceTz}
        </button>
        <button
          type="button"
          className="btn btn-small btn-wrap"
          onClick={() => {
            try {
              sessionStorage.setItem(storageKey, "1");
            } catch {
              /* private mode — in-memory dismissal still applies */
            }
            setDismissed(true);
          }}
        >
          Keep {prefsTz}
        </button>
      </span>
    </Banner>
  );
}
