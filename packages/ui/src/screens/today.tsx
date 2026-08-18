import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@rg/api-client";
import { reviewUnseen } from "../charts-math.js";
import { shouldInvalidateGarden } from "./arrival.js";
import { Banner, SyncNotesStack, SyncStatusLine } from "../components.js";

/**
 * Shared plumbing for the screens that route (this module's old TodayScreen
 * is gone, and System 1 v2 moved its cards too: the Today card is assembled
 * in garden.tsx, readiness lives in the Readiness sheet there, and the
 * evidence line joined the "Lately" strip). What remains here is the shared
 * sync/status furniture rendered by garden.tsx and/or plan.tsx.
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
  // Content divergence is not "healthy": `state` deliberately stays `in_sync`
  // for it (there is no job and no retry), so the quiet gate has to read the
  // count itself or the plan page would silently swallow the one line that
  // says the watch is holding old sessions.
  if (
    quietWhenHealthy &&
    (status.data.state === "in_sync" || cloudHealthy) &&
    (status.data.contentStaleCount ?? 0) === 0 &&
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
      <Link to="/runs" onClick={markSeen}>
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
