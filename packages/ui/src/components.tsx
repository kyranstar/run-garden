import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
} from "react";
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

/** ≥1024px — where the garden becomes a full-viewport stage and the plan
 * page's coach column becomes a persistent sidebar instead of a pill+sheet.
 * Shared (was garden.tsx-private) so the plan page's ghost-tap routing
 * (audit C27) can agree with the garden on what counts as "desktop". */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * "50 min" for anything under 90 minutes — plan-length workouts and most
 * runs. At 90+ minutes (audit M5: a 4h adventure hike used to render as a
 * bare "240 min", a seam of the adventures feature feeding long durations
 * into a runs-era formatter) switches to "Xh Ym" — hours are how a reader
 * actually thinks about a multi-hour outing.
 */
export function formatMinutes(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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

/**
 * "May 12" — THE date format for the chart layer, tooltips and hidden
 * summaries included. It exists to kill the three formats charts.tsx had
 * grown independently ("05/12" from a slice+replace, "05-12" from a bare
 * slice, and raw ISO in the accessible summaries), which made two charts
 * sitting side by side look like they came from different products.
 * No weekday (a bar already sits in a dated column) and no year (charts
 * cover weeks, not decades; the figure's own caption carries the period).
 */
export function formatShortDate(date: string): string {
  const p = parts(date);
  return `${MONTHS[p.m - 1]!.slice(0, 3)} ${p.d}`;
}

/** "May" — the month-boundary tick label on a date-scaled axis. */
export function formatShortMonth(date: string): string {
  return MONTHS[parts(date).m - 1]!.slice(0, 3);
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
export function relativeTime(iso: string): string {
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
 * ever invoked from the `sync_issue` state, wired to `POST /api/sync/retry` +
 * a status refetch (the caller's job — this component is presentational);
 * `retrying` disables the button and relabels it while that request is in
 * flight, so a press has visible effect even before the refetch lands.
 */
export function SyncStatusLine({
  status,
  onRetry,
  retrying,
}: {
  status: SyncStatusDto;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const line = (() => {
    // Cloud-direct COROS (spec §5): the connection's health outranks Mac
    // presence — "synced X ago" or an honest error, never a Mac mystery.
    if (status.cloud) {
      if (status.cloud.error === "bad_credentials") {
        return "COROS rejected the password — fix in Settings";
      }
      if (status.cloud.error) {
        return "COROS unreachable — retrying";
      }
      if (status.state === "sync_issue") {
        return `${status.issueCount} change${status.issueCount === 1 ? "" : "s"} couldn't sync`;
      }
      return `Synced with COROS${status.cloud.lastSyncAt ? ` · ${relativeTime(status.cloud.lastSyncAt)}` : " · first sync pending"}`;
    }
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
        <button className="btn btn-small" disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every currently-open dialog (Sheet or Drawer), most-recently-opened last.
 * Module-level rather than per-hook state because Escape and the body-scroll
 * lock need to reason about ALL open dialogs at once, not just the one whose
 * effect happens to run — see `useDialogFocus` (audit M17).
 */
const openDialogTokens: symbol[] = [];

/** True when `token` is the top (most recently opened, still-open) dialog. */
export function isTopDialog(stack: readonly symbol[], token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/**
 * Dialog focus contract shared by Sheet and Drawer: move focus into the
 * dialog on open, keep Tab cycling inside it, close on Escape, and restore
 * focus to the opener on close. Body scroll locks while any dialog is open.
 *
 * Two stacked dialogs (e.g. the garden's species sheet opened from inside
 * the Collection drawer) used to both close on one Escape press — every
 * mounted instance listened on `document` independently with no notion of
 * which one was "on top". A module-level stack (`openDialogTokens`) fixes
 * both halves of that: Escape only calls `onClose` for the top-of-stack
 * dialog, and the body-scroll lock only lifts once the stack empties, so
 * dismissing the inner sheet no longer unlocks scroll while the drawer
 * underneath is still open (audit M17).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const token = Symbol("dialog");
    openDialogTokens.push(token);
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTopDialog(openDialogTokens, token)) onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = openDialogTokens.indexOf(token);
      if (idx !== -1) openDialogTokens.splice(idx, 1);
      if (openDialogTokens.length === 0) document.body.style.overflow = "";
      opener?.focus();
    };
  }, [ref, open, onClose]);
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
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, open, onClose);

  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="sheet"
        tabIndex={-1}
      >
        <div className="sheet-handle" aria-hidden />
        <div className="row-between" style={{ marginBottom: "0.7rem" }}>
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Per-screen error boundary: one screen failing to render must not blank the
 * whole app. Class component because that is still the only way to catch a
 * render error in React 18 — there is no hook equivalent.
 *
 * `onRetry` is the caller's re-fetch (a `queryClient` invalidation). It may
 * return a `Promise` — when it does, the error state is cleared only once
 * that promise SETTLES, not synchronously. Resetting `error` up front and
 * firing the refetch alongside it (the original approach) remounts the
 * subtree immediately against the *same* stale/bad cached payload: for a
 * data-driven crash (bad shape, not a code bug) that re-throws before the
 * fresh data lands, so the first Retry press silently fails and looks like
 * it needs a second press. Waiting for the promise means the remount only
 * happens once there is something new to render against. There is no
 * `resetKey`: the boundary is mounted as a route element, so navigating away
 * unmounts it and coming back gets a clean instance.
 */
interface ErrorBoundaryProps {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void | Promise<unknown>;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry in this app (see docs/SECURITY.md — nothing leaves the
    // device it wasn't asked to). The console is the only sink, and a
    // swallowed stack trace is worse than a noisy one.
    console.error("Screen failed to render:", error, info.componentStack);
  }

  private readonly retry = (): void => {
    let result: void | Promise<unknown>;
    try {
      result = this.props.onRetry?.();
    } catch {
      // A synchronous throw from onRetry is still a settled outcome — clear
      // the error state so the crashed subtree gets a chance to remount
      // (against whatever the query cache already holds) rather than being
      // stuck on the boundary forever.
      this.setState({ error: null });
      return;
    }
    if (result && typeof (result as Promise<unknown>).finally === "function") {
      // Clear on both success AND failure: a rejected refetch still settles,
      // and getting stuck on the boundary because a retry attempt itself
      // failed would be worse than remounting against the old data once more.
      (result as Promise<unknown>).finally(() => this.setState({ error: null }));
    } else {
      this.setState({ error: null });
    }
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="stack">
        <EmptyState art="⚠" title={this.props.title ?? "Couldn't render this screen"}>
          Something here failed to draw. Your data is safe — this is a display problem.
        </EmptyState>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="btn" onClick={this.retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
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
