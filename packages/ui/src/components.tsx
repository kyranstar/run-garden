import { useEffect, type ReactNode } from "react";
import type { CorosSyncState, CompletionState } from "@rg/domain";
import type { SyncNoteDto, SyncStatusDto } from "@rg/api-client";
import {
  IconAlert,
  IconCalendarOnly,
  IconCheck,
  IconClock,
  IconClose,
  IconLaptop,
  IconSync,
} from "./icons.js";

// ── Formatting helpers ──────────────────────────────────────────────────────

export function formatMinutes(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return `${Math.round(seconds / 60)} min`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(date: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return { y: y!, m: m!, d: d!, dow };
}

export function formatDayLong(date: string): string {
  const p = parts(date);
  const dows = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const base = `${dows[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}`;
  // A date in another year must never masquerade as this year's.
  return p.y === new Date().getFullYear() ? base : `${base}, ${p.y}`;
}

export function monthTitle(date: string): { month: string; year: number } {
  const p = parts(date);
  return { month: MONTHS[p.m - 1]!, year: p.y };
}

export function formatDayShort(date: string): string {
  const p = parts(date);
  return `${WEEKDAYS[p.dow]} ${MONTHS[p.m - 1]!.slice(0, 3)} ${p.d}`;
}

export function weekdayShort(date: string): string {
  return WEEKDAYS[parts(date).dow]!;
}

export function dayOfMonth(date: string): number {
  return parts(date).d;
}

export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const am = h! < 12;
  const hh = h! % 12 === 0 ? 12 : h! % 12;
  return m === 0 ? `${hh} ${am ? "AM" : "PM"}` : `${hh}:${String(m).padStart(2, "0")} ${am ? "AM" : "PM"}`;
}

export function relativeDay(date: string, today: string): string {
  if (date === today) return "Today";
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return formatDayShort(date);
}

// ── Status pills ────────────────────────────────────────────────────────────

const COROS_PILL: Record<CorosSyncState, { label: string; cls: string; icon: ReactNode; title: string }> = {
  synced: { label: "Synced", cls: "pill-ok", icon: <IconCheck />, title: "This workout's date matches your COROS watch." },
  syncing: { label: "Syncing", cls: "pill-progress", icon: <IconSync />, title: "Sending this change to your COROS watch." },
  waiting_for_device: { label: "Waiting for Mac", cls: "pill-progress", icon: <IconLaptop />, title: "Queued — this will reach your COROS watch when the Mac companion app is running." },
  calendar_only: {
    label: "Not synced to COROS",
    cls: "pill-neutral",
    icon: <IconCalendarOnly />,
    title:
      "This date change lives in Run Garden and your Google Calendar only — your COROS watch still has the old date. Enable COROS sync in Settings (or retry) to push it.",
  },
  needs_attention: { label: "Needs attention", cls: "pill-warn", icon: <IconAlert />, title: "COROS and Run Garden disagree on this workout's date." },
  sync_issue: {
    label: "Sync issue",
    cls: "pill-danger",
    icon: <IconAlert />,
    title: "The last write to your COROS watch failed. Retry from the workout to try again.",
  },
};

export function CorosPill({ state, hideWhenHealthy }: { state: CorosSyncState; hideWhenHealthy?: boolean }) {
  if (hideWhenHealthy && state === "synced") return null;
  const p = COROS_PILL[state];
  return (
    <span className={`pill ${p.cls}`} title={p.title}>
      {p.icon}
      {p.label}
    </span>
  );
}

/** "2m ago" / "3h ago" / "5d ago" — coarse enough that a 30s status poll
 * never needs to re-render it, precise enough to reassure "this is fresh". */
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The single account-wide sync line (sync-transparency Task 12) — replaces
 * every screen's own bespoke read of the legacy `TodayResponse.sync` shape
 * with one quiet sentence backed by `GET /api/sync/status`. `onRetry` is only
 * ever invoked from the `sync_issue` state; wiring it to `readNow()` + a
 * status refetch is the caller's job (this component is presentational).
 */
export function SyncStatusLine({ status, onRetry }: { status: SyncStatusDto; onRetry?: () => void }) {
  const line = (() => {
    switch (status.state) {
      case "in_sync":
        return `Calendar, COROS and watch in sync${status.lastCorosReadAt ? ` · ${relativeTime(status.lastCorosReadAt)}` : ""}`;
      case "syncing":
        return `Syncing ${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"}…`;
      case "waiting_for_mac":
        return status.paused
          ? "Sync is paused — resume in Settings"
          : `${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"} waiting — wake your Mac to update your watch`;
      case "not_synced":
        return status.registered
          ? "COROS updates are off — enable in Settings"
          : "No Mac paired — pair in Settings to update COROS";
      case "sync_issue":
        return `${status.issueCount} change${status.issueCount === 1 ? "" : "s"} couldn't sync`;
    }
  })();
  return (
    <div className="row">
      <span className="muted">{line}</span>
      {status.state === "sync_issue" && onRetry ? (
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Copy per `SyncNoteDto.kind` (sync-transparency Task 3/10) — the payload
 * shapes here mirror exactly what `postSyncNote` callers write server-side
 * (import-plan.ts, jobs.ts, studio-push.ts); `null` for any kind this build
 * doesn't know how to render, so an unrecognized future kind fails quiet
 * rather than showing "undefined". */
function syncNoteText(note: SyncNoteDto): string | null {
  const p = (note.payload ?? {}) as Record<string, unknown>;
  switch (note.kind) {
    case "kept_local_change":
      return `Kept your ${formatDayShort(p.keptDate as string)} — COROS had moved it to ${formatDayShort(p.displacedDate as string)}`;
    case "adopted_coros_change":
      return `Moved to ${formatDayShort(p.newDate as string)} on COROS`;
    case "adopted_coros_edit":
      return `“${p.sessionTitle as string}” was edited on COROS — the studio stopped managing it`;
    case "adopted_coros_removal":
      return `“${p.sessionTitle as string}” was removed on COROS`;
    default:
      return null;
  }
}

/**
 * Dismissible feed of active sync notes (sync-transparency Task 12) —
 * presentational: the owning screen supplies the mutations. `undoErrors` is
 * keyed by note id so a 409 (`undo_unsupported_rename`, adopted_coros_edit/
 * removal only) explains itself inline on just that row instead of a generic
 * toast.
 */
export function SyncNotesStack({
  notes,
  onDismiss,
  onUndo,
  undoPendingId,
  undoErrors,
}: {
  notes: SyncNoteDto[];
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  undoPendingId?: string | null;
  undoErrors?: Record<string, string>;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      {notes.map((note) => {
        const text = syncNoteText(note);
        if (!text) return null;
        const err = undoErrors?.[note.id];
        return (
          <div key={note.id} className="sync-note row-between">
            <span>{text}</span>
            <div className="btn-row">
              {err ? (
                <span className="faint">{err}</span>
              ) : (
                <button
                  className="btn btn-small"
                  disabled={undoPendingId === note.id}
                  onClick={() => onUndo(note.id)}
                >
                  Undo
                </button>
              )}
              <button className="btn btn-small" onClick={() => onDismiss(note.id)} aria-label="Dismiss note">
                <IconClose size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CompletionPill({ state }: { state: CompletionState }) {
  switch (state) {
    case "completed":
      return (
        <span className="pill pill-ok">
          <IconCheck /> Completed
        </span>
      );
    case "provisionally_completed":
      return (
        <span className="pill pill-ok">
          <IconCheck /> Completed · syncing details
        </span>
      );
    case "unresolved":
      return (
        <span className="pill pill-warn">
          <IconClock /> Did this run happen?
        </span>
      );
    case "skipped":
      return <span className="pill pill-neutral">Skipped</span>;
    case "missed":
      return <span className="pill pill-neutral">Missed</span>;
    default:
      return null;
  }
}

export const CATEGORY_LABELS: Record<string, string> = {
  recovery: "Recovery",
  easy: "Easy",
  long: "Long run",
  quality: "Quality",
  race: "Race",
  cross_training: "Cross-training",
  strength: "Strength",
  yoga: "Yoga",
  rest: "Rest",
  unknown: "Run",
};

export function CategoryDot({ category }: { category: string }) {
  return <span className={`category-dot cat-${category}`} aria-hidden />;
}

// ── Layout primitives ───────────────────────────────────────────────────────

export function Card({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title ? <div className="card-title">{title}</div> : null}
      {children}
    </section>
  );
}

export function EmptyState({ art, title, children }: { art?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {art ? (
        <div className="art" aria-hidden>
          {art}
        </div>
      ) : null}
      <p style={{ fontWeight: 600 }}>{title}</p>
      {children ? <p className="muted" style={{ marginTop: "0.3rem" }}>{children}</p> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <div className="spinner" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

/** Bottom sheet on mobile, centered dialog on desktop. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="sheet">
        <div className="sheet-handle" aria-hidden />
        <div className="row-between" style={{ marginBottom: "0.7rem" }}>
          <h2>{title}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Banner({ kind, children }: { kind: "warn" | "info"; children: ReactNode }) {
  // Wrap in a single element so multi-part prose (bold words, links) flows as
  // text instead of each run becoming its own flex item.
  return (
    <div className={`banner banner-${kind}`}>
      <span>{children}</span>
    </div>
  );
}
