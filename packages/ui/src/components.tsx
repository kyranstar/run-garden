import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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

/** `useLayoutEffect` on the client, `useEffect` on the server. The dialogs
 * here measure their own layout, which only exists in a browser; React warns
 * (loudly, and our smoke tests read warnings as failures) about the layout
 * variant during `renderToStaticMarkup`. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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

/**
 * Publishes how much page sits ABOVE this element as `--space-above` on it,
 * so a box can be sized against the space it actually has instead of against
 * the window (System 1 §4). `height: 100dvh` is a lie for any box that does
 * not start at y=0: one fixture-mode banner above the garden stage pushed the
 * whole bottom HUD row below the fold. CSS cannot ask "where do I start?", so
 * this measures it and re-measures whenever the layout above changes.
 *
 * Returns a CALLBACK REF, and that is the whole point of the shape. The first
 * cut took a `useRef` object and measured in an effect with `[ref]` deps: the
 * screen renders a `<Spinner>` while its query loads, so the effect ran once
 * against `ref.current === null`, registered nothing, and — its one dep being
 * a stable object — never ran again once the real box mounted. Measured
 * result: `--space-above` empty, the fix entirely inert. A callback ref fires
 * when the NODE attaches, which is the only moment there is anything to
 * measure.
 *
 * What can change the answer, and what watches for it:
 *  - the box's own arrival → the callback ref itself;
 *  - a banner/notice above it GROWING or WRAPPING → a `ResizeObserver` on
 *    every ancestor up to `<body>` and on every earlier sibling at each of
 *    those levels (a banner that wraps to two lines is a resize);
 *  - a banner APPEARING or VANISHING → a `MutationObserver` (childList) on
 *    those same ancestors, which re-attaches the observers and re-measures.
 *    A `/api/me` that resolves after the screen's own query does exactly
 *    this, and a ResizeObserver alone cannot see a node that did not exist;
 *  - the window resizing → a `resize` listener.
 *
 * Cheap by construction: one property write, only when the value changes, and
 * nothing at all on a static render (no `window`).
 */
export function useSpaceAbove(): (el: HTMLElement | null) => void {
  const teardown = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    // React calls the callback with `null` on detach (and before a re-attach).
    teardown.current?.();
    teardown.current = null;
    if (!el || typeof window === "undefined") return;

    let last = -1;
    const measure = () => {
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
      if (top === last) return;
      last = top;
      el.style.setProperty("--space-above", `${top}px`);
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            watch();
            measure();
          })
        : null;
    const watch = () => {
      ro?.disconnect();
      mo?.disconnect();
      for (let node: HTMLElement = el; ; ) {
        const parent = node.parentElement;
        if (!parent) break;
        mo?.observe(parent, { childList: true });
        ro?.observe(parent);
        for (let sib = parent.firstElementChild; sib && sib !== node; sib = sib.nextElementSibling) {
          ro?.observe(sib);
        }
        if (parent === document.body) break;
        node = parent;
      }
    };

    watch();
    measure();
    window.addEventListener("resize", measure);
    teardown.current = () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      mo?.disconnect();
      el.style.removeProperty("--space-above");
    };
  }, []);
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

/**
 * "1 run" · "3 runs" — a count with its noun agreeing with it. Deployed
 * Insights read "0.9h over 1 runs" in a chart description; every count this
 * app interpolates into a sentence goes through here instead. Irregular
 * plurals pass their own (`countNoun(1, "yoga session", "yoga sessions")`).
 */
export function countNoun(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
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

/** The device's local calendar date. NEVER use `toISOString().slice(0,10)`
 * for a "today" — that's the UTC date, which is tomorrow every evening west
 * of Greenwich (audit#3 T3). A guess only: the server's `today` (account
 * timezone) is authoritative wherever a response already carries it. */
export function localTodayGuess(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Display units (2026-08-14) ────────────────────────────────────────────
// Stored values are ALWAYS metric (meters, sec/km); prefs.units converts at
// the display edge only. Every distance/pace the user sees goes through
// these two helpers — that is the whole consistency guarantee.

export type Units = "km" | "mi";
const KM_PER_MI = 1.609344;

/** "4:49 /km" or "7:45 /mi" from a metric pace. */
export function formatPace(secPerKm: number, units: Units): string {
  const sec = units === "mi" ? secPerKm * KM_PER_MI : secPerKm;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  const mm = s === 60 ? m + 1 : m;
  const ss = s === 60 ? 0 : s;
  return `${mm}:${String(ss).padStart(2, "0")} /${units}`;
}

/** "10.0 km" or "6.2 mi" from meters. Whole numbers drop the decimal. */
export function formatDistance(meters: number, units: Units, digits = 1): string {
  const v = units === "mi" ? meters / 1000 / KM_PER_MI : meters / 1000;
  const rounded = v.toFixed(digits);
  const clean = rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
  return `${clean} ${units}`;
}

/** "48:10" or "1:12:05" from seconds — race times and durations. */
export function formatClock(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
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
  waiting_for_device: { label: "Waiting for COROS", cls: "pill-progress", icon: <IconSync />, title: "Queued — this reaches your watch once COROS is connected in Settings." },
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
      case "not_synced":
        return status.registered
          ? "COROS updates are off — enable in Settings"
          : "COROS not connected — connect in Settings";
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
    case "race_move_rejected":
      return "Races can't be moved from the calendar — the event was left where the plan has it. If the race date is wrong, update Race day in Settings.";
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
    <div className="stack" style={{ gap: "var(--space-3)" }}>
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

/**
 * A card, and — when it has a title — a real SECTION heading (System 2).
 *
 * `<Card title>` renders 33 times across the app and used to emit a bare
 * `<div className="card-title">`, so 33 sections had no heading semantics at
 * all: a screen reader's rotor listed one `<h1>` and nothing under it, and the
 * document outline of every screen was a single flat level. The element is an
 * `<h2>` by default and `level` moves it, for the cards that nest inside
 * another heading's region (a `<Sheet>` already owns an `<h2>`, so cards
 * inside one pass `level={3}`).
 *
 * The visual is unchanged: `.card-title` is the app's SECTION rank — the small
 * uppercase eyebrow — and it out-specifies the bare `h2`/`h3` element rules.
 * The section is `aria-labelledby` its own heading, so the region announces
 * with the name you can see.
 */
export function Card({
  title,
  children,
  className,
  level = 2,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  /** Heading level for `title`. 2 by default; 3 inside a dialog. */
  level?: 2 | 3 | 4;
}) {
  const id = useId();
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  return (
    <section className={`card ${className ?? ""}`} aria-labelledby={title ? id : undefined}>
      {title ? (
        <Heading id={id} className="card-title">
          {title}
        </Heading>
      ) : null}
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
      {children ? <p className="muted" style={{ marginTop: "var(--space-2)" }}>{children}</p> : null}
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

/**
 * Freezes a centred desktop dialog's geometry across a DISCLOSURE (System 1
 * §5). A `.sheet-backdrop` centres its dialog, so anything that expands
 * inside one pushes the dialog up by half the growth while pushing its own
 * action row down by the other half — 128px of relative motion under a
 * reader who pressed one summary.
 *
 * Pinned on the disclosure transition, NOT on open. The first cut measured
 * once on the layout pass right after open and then held that number, which
 * is a measurement of whatever the dialog happened to be at that instant —
 * and for any dialog whose content arrives with a query, that instant is the
 * loading state. Measured result on the desktop studio modal: a spinner-sized
 * dialog centred at y=400 froze the pin at 400, which capped the loaded
 * dialog at 476px of a 900px viewport, hid the W1–W8 weeks table it had shown
 * before, and left ~400px of dead backdrop above it. An open dialog must
 * never be smaller than its content needs merely because it was measured
 * early, so nothing is measured until the reader acts.
 *
 * The listener is capture-phase on the dialog: it runs before React's own
 * delegated handler at the root, so it reads the layout the reader is looking
 * at rather than the one the click is about to produce. Two numbers are taken
 * together — the top edge (`--sheet-pin`) and the height (`--sheet-hold`, a
 * max, so a re-collapsed disclosure still shrinks back cleanly). Holding both
 * means the growth lands entirely in the body's scroll region: top edge,
 * title row and pinned action row all stay exactly where they were.
 *
 * A window resize releases the pin — the frozen numbers describe a viewport
 * that no longer exists, and the layout is being reflowed anyway. Mobile
 * sheets are bottom-anchored and are not pinned. No-ops without a DOM (static
 * render) or `matchMedia`.
 */
function usePinnedTop(
  backdrop: RefObject<HTMLElement | null>,
  dialog: RefObject<HTMLElement | null>,
  open: boolean,
) {
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const back = backdrop.current;
    const el = dialog.current;
    if (!back || !el || typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    const release = () => {
      delete back.dataset.pinned;
      el.style.removeProperty("--sheet-pin");
      el.style.removeProperty("--sheet-hold");
    };
    const pin = () => {
      if (back.dataset.pinned) return;
      const r = el.getBoundingClientRect();
      const top = r.top - back.getBoundingClientRect().top;
      el.style.setProperty("--sheet-pin", `${Math.max(0, Math.round(top))}px`);
      el.style.setProperty("--sheet-hold", `${Math.round(r.height)}px`);
      back.dataset.pinned = "true";
    };
    el.addEventListener("click", pin, true);
    window.addEventListener("resize", release);
    return () => {
      el.removeEventListener("click", pin, true);
      window.removeEventListener("resize", release);
      release();
    };
  }, [backdrop, dialog, open]);
}

/**
 * Bottom sheet on mobile, centered dialog on desktop — and the app's one
 * dialog container contract (System 1 §2): a flex column of head · body ·
 * foot where ONLY the body scrolls. The title row and ✕ can never scroll
 * away, an action row passed as `footer` can never fall below an invisible
 * fold, and the body announces its own clipping because it is a `.scroller`.
 *
 * `fill` is for content that owns its own scroll region (the coach panel):
 * the sheet takes a definite height so that child has something real to size
 * against, and the body stops being a scroller — one scroll owner, still.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  fill,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Pinned action row, kept visible below the scrolling body. */
  footer?: ReactNode;
  /** The child is a column that scrolls itself; give it a definite height. */
  fill?: boolean;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, open, onClose);
  usePinnedTop(backdropRef, ref, open);

  if (!open) return null;
  return (
    <div
      ref={backdropRef}
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
        className={`sheet${fill ? " sheet--fill" : ""}`}
        tabIndex={-1}
      >
        <div className="sheet-handle" aria-hidden />
        <div className="row-between sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className={`sheet-body${fill ? "" : " scroller"}`}>{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
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
