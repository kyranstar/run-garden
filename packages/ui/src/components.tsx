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
import type { CompletionState, WatchCoverageView, WorkoutSyncView } from "@rg/domain";
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
export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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

const COROS_PILL: Record<WorkoutSyncView, { label: string; cls: string; icon: ReactNode; title: string }> = {
  synced: { label: "Synced", cls: "pill-ok", icon: <IconCheck />, title: "This workout's date matches your COROS watch." },
  /* The state that had no pill because the derivation had no eyes: COROS has
     this session, on the right day, in the version Run Garden replaced. Not
     `pill-warn` — nothing is wrong and nothing failed; the coach changed the
     plan and the watch cannot be told. `pill-neutral` is the same weight
     `calendar_only` carries, and the two labels are deliberately the two
     different sentences an athlete needs to tell apart: "not sent yet" vs
     "sent, but that was the old one". */
  content_stale: {
    label: "Older on watch",
    cls: "pill-neutral",
    icon: <IconCalendarOnly />,
    title:
      "Your COROS watch has this session on the right day, but with the version Run Garden replaced. There is no way to rewrite a session's content on COROS, so the watch keeps the older one.",
  },
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

export function CorosPill({ state, hideWhenHealthy }: { state: WorkoutSyncView; hideWhenHealthy?: boolean }) {
  // `hideWhenHealthy` hides SYNCED and nothing else, which is the whole point
  // of the new state: a content-stale session used to derive as `synced` and
  // was therefore hidden by this line, leaving zero indicators anywhere.
  if (hideWhenHealthy && state === "synced") return null;
  const p = COROS_PILL[state];
  return (
    <span className={`pill ${p.cls}`} title={p.title}>
      {p.icon}
      {p.label}
    </span>
  );
}

// ── What the watch will show ────────────────────────────────────────────────

/**
 * THE COPY FOR A BOUNDARY, not for a bug.
 *
 * The app's one previous disclosure — "This lives in Run Garden and your
 * Calendar — it was never written to your COROS watch" — is true, reasonless,
 * and reads as a defect report. Every sentence below names the reason, in the
 * athlete's terms rather than the wire's, because a reason is what turns "the
 * app failed to do a thing" into "the watch cannot hold this kind of thing".
 *
 * One function, three surfaces (session sheet, Today card, proposal manifest),
 * so the words cannot drift between the place a decision is made and the place
 * it is lived with. `null` whenever there is nothing to say.
 */
export function watchCoverageSentences(view: WatchCoverageView | undefined): string[] {
  if (!view || view.coverage === "full") return [];
  const noun = view.discipline === "lift" ? "a lift" : view.discipline === "mobility" ? "a mobility session" : "this";
  const out: string[] = [];
  for (const gap of view.gaps) {
    switch (gap.code) {
      case "discipline_off_wire":
        out.push(
          `Your COROS watch won't show this — Run Garden writes timed running sessions to the watch and nothing else, so ${noun} lives here and in your Calendar.`,
        );
        break;
      case "distance_target":
        out.push(
          "Your COROS watch won't show this — it's measured in distance, and Run Garden only writes timed steps to the watch.",
        );
        break;
      case "empty_body":
        out.push("Your COROS watch won't show this — there's no timed structure for it to hold.");
        break;
      case "off_catalog": {
        const names = gap.names ?? [];
        if (names.length === 0) break;
        out.push(
          `Your watch's exercise library has no ${listPhrase(names)}, so ${names.length === 1 ? "it" : "they"} could never be written there by name either.`,
        );
        break;
      }
      case "pace_targets_owed":
        out.push(
          `Your watch will show the steps but no pace targets${gap.count ? ` on ${gap.count} of them` : ""} — Run Garden doesn't know your threshold pace yet.`,
        );
        break;
    }
  }
  return out;
}

/** The same fact in the space a card can spare — used where the long form
 * would outweigh everything around it (the Today card, a manifest line). */
export function watchCoverageShort(view: WatchCoverageView | undefined): string | null {
  if (!view || view.coverage === "full") return null;
  const lead = view.gaps[0]?.code;
  if (lead === "distance_target") return "Not on your watch — measured in distance";
  if (lead === "empty_body") return "Not on your watch — nothing timed to send";
  if (lead === "pace_targets_owed") return "On your watch, without pace targets";
  return view.discipline === "run"
    ? "Not on your watch — lives here and in Calendar"
    : `Not on your watch — ${view.discipline === "lift" ? "a lift" : "a mobility session"} lives here and in Calendar`;
}

/** "Skier hops", "Skier hops and Copenhagen planks", "A, B and C". */
function listPhrase(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The disclosure itself: a `.note`, which is this app's primitive for "a
 * sentence that just says something" (System 1 — a `.pill` is `nowrap` by
 * contract and prose does not go in one, and a `Banner` is for a state the
 * reader may need to act on). Renders nothing at all when coverage is full,
 * which is what keeps a normal synced run exactly as quiet as it was.
 */
export function WatchCoverageNote({ view }: { view: WatchCoverageView | undefined }) {
  const sentences = watchCoverageSentences(view);
  if (sentences.length === 0) return null;
  return (
    <div className="note watch-note">
      {sentences.map((s) => (
        <p key={s}>{s}</p>
      ))}
    </div>
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
  /**
   * THE LINE STOPPED CLAIMING THE WATCH.
   *
   * "Calendar, COROS and watch in sync" was three claims and the app could
   * support one and a half of them. It counted in-flight write jobs and failed
   * jobs with an open MOVE intent, so it read "in sync" while two sessions
   * differed from the watch in content and fifteen were missing locally. Two
   * separate over-claims, and they have separate answers:
   *
   *  · The watch itself is never verified. `WatchSyncState` says so in the
   *    domain ("we can verify the COROS calendar, not the watch") and the
   *    connection only ever proves what COROS's own calendar holds. The word
   *    is gone from the healthy line; nothing else changes about it.
   *  · Content divergence IS knowable — an approved ease records an open
   *    `content` intent that never resolves — so the line learns exactly that
   *    one fact and states it. It is not folded into `issueCount` and does not
   *    change `state`, because those drive a Retry button and there is no
   *    content-write job for a retry to enqueue. A count with no action is a
   *    sentence, not a badge.
   *
   * What it still cannot see (rows COROS holds that Run Garden has never
   * imported) it now simply does not speak for: "Calendar and COROS in sync"
   * is a claim about the two things this app reconciles.
   */
  const contentStale = status.contentStaleCount ?? 0;
  const staleLine = `Your watch has an older version of ${contentStale} session${contentStale === 1 ? "" : "s"}`;
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
      if (contentStale > 0) return staleLine;
      return `Synced with COROS${status.cloud.lastSyncAt ? ` · ${relativeTime(status.cloud.lastSyncAt)}` : " · first sync pending"}`;
    }
    if (contentStale > 0 && status.state === "in_sync") return staleLine;
    switch (status.state) {
      case "in_sync":
        return `Calendar and COROS in sync${status.lastCorosReadAt ? ` · ${relativeTime(status.lastCorosReadAt)}` : ""}`;
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

/**
 * UX System 4 — "a state change moves nothing at or above the thing you
 * touched". This is the half of that invariant a query can break with nobody
 * touching anything: render a conditional derived from an answer that has not
 * arrived, and the screen states something it is about to contradict, then
 * re-lays itself out under the reader's eyes.
 *
 * This codebase has hit that four times and every time it wore the same
 * clothes — `?? []`, `?? 0`, `?? false` standing in for an answer, feeding a
 * conditional render. The fix is not a better default. It is not deciding
 * yet. So the "not yet" has a name, one that greps and one that a test can
 * insist on: `settling(...)` is true while any of these queries is on its
 * FIRST load, which is the only moment the screen genuinely does not know.
 *
 * A background refetch is not settling. TanStack's `isLoading` is
 * `isPending && isFetching`, so a stale-while-revalidate pass paints from
 * cache immediately and nothing moves — which is exactly why this reads
 * `isLoading` and not `isFetching`, and why a query carrying
 * `placeholderData: keepPreviousData` stops settling after its first answer
 * and never blanks the screen again when its key changes.
 *
 * Pass the queries that decide whether a BLOCK EXISTS — is there a plan, is
 * there a race, is COROS connected. Not the ones that only fill in a number:
 * holding a whole screen hostage for a footnote is its own bad trade, and for
 * those the answer is a slot that already has the right height (see
 * `.act-status-slot` in styles.css).
 */
export function settling(
  ...queries: ReadonlyArray<{ isLoading: boolean } | null | undefined>
): boolean {
  return queries.some((q) => q?.isLoading === true);
}

/**
 * The scroll owner a node actually lives in — the nearest ancestor that both
 * clips and has something to clip. Falls back to the document scroller.
 *
 * The walk STOPS at a dialog. A nested sheet (the move sheet inside the
 * workout sheet) is a fixed box whose containing block is its parent sheet, so
 * an unbounded walk finds the PARENT's body, and scrolling that drags the
 * whole nested dialog with it — measured at 1440 as a −3px shift of the move
 * sheet's own title row, from 3px of overflow in a dialog behind it. Nothing
 * outside the dialog a block lives in is that block's scroller.
 */
function scrollOwnerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    const oy = `${s.overflowY} ${s.overflow}`;
    if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight + 1) return p;
    if (p.getAttribute("role") === "dialog") return null;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

/**
 * Bring a block the reader just revealed into the reader's view (System 4 R2).
 *
 * The half of the disclosure invariant that pinning the frame CREATED. Once a
 * bottom sheet's frame is frozen, growth lands in the body's scroll region and
 * stops being visible: measured at 390, "Choose another time" put 207px of
 * date and time fields with their bottom 87px past the body's fold, and "Full
 * structure" 2px past it. Nothing moved, and nothing appeared to happen.
 *
 * A bottom sheet's bottom edge is the viewport's, so the frame genuinely can
 * only freeze or move and freezing is right — which leaves bringing the
 * content to the reader as the only honest answer. This is NOT the involuntary
 * shift the invariant bans: it is a scroll, in a scroller the reader owns,
 * caused by the reader's own press, and it changes no layout at all — every
 * block keeps its position in the content, which is the frame the invariant is
 * measured in.
 *
 * Minimal movement, and never past the top: if the block is taller than the
 * window it gets its TOP aligned instead, because a reader who cannot see
 * where the new thing starts has been shown nothing.
 */
export function revealInView(el: HTMLElement | null | undefined, margin = 8): void {
  if (!el || typeof window === "undefined" || !el.isConnected) return;
  const owner = scrollOwnerOf(el);
  // Nothing inside the dialog scrolls — the frame grew to fit and the block is
  // already whole on screen. Nothing to bring anywhere.
  if (!owner) return;
  const er = el.getBoundingClientRect();
  if (er.height === 0) return;
  const or = owner === document.documentElement || owner === document.body
    ? { top: 0, bottom: window.innerHeight }
    : owner.getBoundingClientRect();
  let delta = Math.max(0, er.bottom + margin - or.bottom);
  if (er.top - delta < or.top + margin) delta = er.top - or.top - margin;
  if (Math.abs(delta) < 1) return;
  // The reader asked for this; a reader who has asked not to be moved gets it
  // instantly instead. Never a smooth scroll under `prefers-reduced-motion`.
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  owner.scrollBy({ top: delta, behavior: still ? "auto" : "smooth" });
}

/** `revealInView` on the transition into `open`, once the block exists. */
export function useRevealInView(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    revealInView(ref.current);
  }, [open, ref]);
}

/**
 * Hold one element still across a state change that removes layout around it
 * (System 4 R3).
 *
 * Collapsing a panel deletes content, and something has to move: the invariant
 * says the things ABOVE the control stay and the things below rise into the
 * gap. Chrome's scroll anchoring decides the opposite — it picks an anchor
 * below the deleted box and keeps THAT still, which pays for it by scrolling
 * the page. Measured on the garden dock at 390: pressing "Minimize" with the
 * button at mid-viewport moved `window.scrollY` 657 → 113 with nothing near a
 * clamp, throwing the dock pill 544px down the screen and losing the reader's
 * place completely. `overflow-anchor` cannot fix this — excluding one element
 * only makes the browser choose another — so the adjustment is undone here.
 *
 * Read and corrected in a LAYOUT effect: the browser applies its anchoring
 * during layout, and `getBoundingClientRect` forces that layout, so the number
 * read here already includes it and the correction lands before paint.
 *
 * Best effort by construction: if the document is now too short to hold the
 * position (the reader was at the very bottom), the scroll clamps and the
 * element moves as far as the page allows. No viewport can preserve a position
 * that no longer exists.
 */
export function useHeldInPlace(dep: unknown, find: () => HTMLElement | null): () => void {
  const finder = useRef(find);
  finder.current = find;
  const want = useRef<number | null>(null);
  const hold = useCallback(() => {
    want.current = finder.current()?.getBoundingClientRect().top ?? null;
  }, []);
  useIsomorphicLayoutEffect(() => {
    const target = want.current;
    want.current = null;
    if (target == null || typeof window === "undefined") return;
    const el = finder.current();
    if (!el) return;
    const delta = el.getBoundingClientRect().top - target;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  }, [dep]);
  return hold;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Everything currently claiming Escape, most-recently-opened last.
 * Module-level rather than per-hook state because Escape has to be resolved
 * across ALL of them at once, not just the one whose effect happens to run
 * (audit M17).
 */
const openDialogTokens: symbol[] = [];

/** True when `token` is the top (most recently opened, still-open) dialog. */
export function isTopDialog(stack: readonly symbol[], token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/**
 * ESCAPE BELONGS TO THE TOP THING, and this is the only way to ask for it.
 *
 * Two stacked dialogs (the garden's species sheet opened from inside the
 * Collection drawer) used to both close on one press — every mounted instance
 * listened on `document` independently with no notion of which was on top
 * (audit M17). The stack fixed that for Sheet and Drawer, and then the coach
 * WINDOW opted out of it: being a non-modal panel rather than a dialog, it
 * listened on `document` itself and guarded with a `dialogOpen` boolean the
 * page had to compute and keep current. That boolean cannot say WHICH thing
 * is on top, and every dialog opened anywhere inside the coach panel had to
 * remember to tell the page it existed — a chain of `onDialogChange` props
 * threaded three components deep just to keep one boolean true (2026-08-17).
 * A non-modal panel can take a token like anything else; only the modal half
 * (focus trap, scroll lock) belongs to `useDialogFocus`.
 *
 * THE STACK IS ORDERED BY WHEN SOMETHING OPENED, not by when its parent last
 * re-rendered. `onClose` used to be in the dependency list, and almost every
 * caller passes an inline arrow — `onClose={() => setCoachOpen(false)}` — so a
 * new identity arrived on every render of the page. The effect tore down and
 * re-registered, which spliced that dialog's token out and pushed it back on
 * TOP. Opening a nested dialog re-renders the page that owns the outer one, so
 * the outer dialog reliably jumped above the inner one and one Escape closed
 * the wrong thing: the coach proposal's detail sheet, opened inside the mobile
 * coach sheet, took the whole coach sheet down with it. The handler lives in a
 * ref instead, so it stays current without the effect depending on it.
 */
export function useEscapeKey(open: boolean, onEscape: () => void): void {
  const fire = useRef(onEscape);
  fire.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const token = Symbol("escape");
    openDialogTokens.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopDialog(openDialogTokens, token)) fire.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = openDialogTokens.indexOf(token);
      if (idx !== -1) openDialogTokens.splice(idx, 1);
    };
  }, [open]);
}

/**
 * How many MODAL dialogs are open. Separate from the Escape stack because a
 * non-modal panel (the coach window) claims Escape without locking the page
 * behind it — counting tokens for the lock would leave the body unscrollable
 * for as long as that panel stayed open.
 */
let modalDepth = 0;

/**
 * Dialog focus contract shared by Sheet and Drawer: move focus into the
 * dialog on open, keep Tab cycling inside it, close on Escape (via
 * `useEscapeKey`, so a nested dialog wins the press), and restore focus to the
 * opener on close. Body scroll locks while any MODAL dialog is open and lifts
 * only when the last one closes — dismissing an inner sheet must not unlock
 * scroll while the drawer underneath is still up (audit M17).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEscapeKey(open, onClose);
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.focus();
    const onKey = (e: KeyboardEvent) => {
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
    modalDepth += 1;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      modalDepth -= 1;
      if (modalDepth === 0) document.body.style.overflow = "";
      opener?.focus();
    };
  }, [ref, open]);
}

/**
 * ONE RULE, BOTH WIDTHS: an open dialog's FRAME is stable, and growth inside
 * it goes to the body's scroll region (System 1 §5, System 4 F3).
 *
 * Why a dialog moves at all is different at each width, but it is the same
 * defect. A centred desktop dialog re-centres as it grows, so opening "Full
 * structure" inside one pushed the dialog up by half the growth and its
 * action row down by the other half — 128px of relative motion under a reader
 * who pressed one summary. A mobile sheet is bottom-anchored
 * (`align-items: flex-end`), so ALL of the growth comes off the top edge: at
 * 390 the move sheet's "Choose another time" lifted the sheet's head 223px,
 * the workout sheet's "Full structure" 129px, and "Remove from plan" 17px —
 * every in-flow disclosure in every sheet in the app, because the pin was
 * scoped `min-width: 1024px` and the phone had no equivalent at all.
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
 * early, so nothing is measured until the reader acts. (That is also why this
 * is not, and cannot be, pure CSS: CSS has no way to say "the size you were
 * before this click". What it CAN be is measured at a moment with nothing
 * transient about it — the reader has the finished dialog on screen and is
 * pressing something in it.)
 *
 * The listener is capture-phase on the dialog: it runs before React's own
 * delegated handler at the root, so it reads the layout the reader is looking
 * at rather than the one the click is about to produce. Two numbers are taken
 * together — the top edge (`--sheet-pin`) and the height (`--sheet-hold`) —
 * and styles.css spends them differently per width, because a different edge
 * is free:
 *
 *   • Centred (lg+): `margin-top: --sheet-pin` fixes the TOP and the dialog
 *     GROWS DOWNWARD into the free backdrop below it, capped by the viewport
 *     (System 4 R1). The bottom edge is free, so a re-collapsed disclosure
 *     shrinks back rather than leaving a hole.
 *   • Bottom sheet (below lg): the bottom edge is the viewport's and cannot
 *     move, so `height: --sheet-hold` freezes the frame outright. Collapsing
 *     a disclosure leaves its room inside the scroller instead of dropping
 *     the top edge back down onto the reader.
 *
 * A third number, and only sometimes: `--sheet-body-hold`. Letting a centred
 * dialog grow downward raises its ceiling from 80dvh to the viewport, and a
 * dialog whose body was ALREADY clipped answers that by growing on the press
 * itself — the studio modal went 720 → 786px at 1440 on a click that disclosed
 * nothing, which moved its pinned action row (and "Retire…" and "Rename" with
 * it) down 10px. So a body that was already scrolling keeps the size it had,
 * and the dialog then grows only by what a disclosure actually adds. A body
 * that was NOT scrolling is left free, which is the whole point of R1: there
 * is room below, and the reader should get the content in it rather than a
 * scrollbar. One flag, `data-body-held`, so the rule is legible in the DOM.
 *
 * A window resize releases the pin — the frozen numbers describe a viewport
 * that no longer exists, the layout is being reflowed anyway, and a rotation
 * across 1024 would otherwise apply one width's numbers under the other
 * width's rules. No-ops without a DOM (static render).
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
    if (!back || !el || typeof window === "undefined") return;
    const release = () => {
      delete back.dataset.pinned;
      delete back.dataset.bodyHeld;
      el.style.removeProperty("--sheet-pin");
      el.style.removeProperty("--sheet-hold");
      el.style.removeProperty("--sheet-body-hold");
    };
    const pin = () => {
      if (back.dataset.pinned) return;
      const r = el.getBoundingClientRect();
      const top = r.top - back.getBoundingClientRect().top;
      el.style.setProperty("--sheet-pin", `${Math.max(0, Math.round(top))}px`);
      el.style.setProperty("--sheet-hold", `${Math.round(r.height)}px`);
      const body = el.querySelector<HTMLElement>(".sheet-body");
      if (body && body.scrollHeight > body.clientHeight + 1) {
        el.style.setProperty("--sheet-body-hold", `${Math.round(body.clientHeight)}px`);
        back.dataset.bodyHeld = "true";
      }
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
  centered,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Pinned action row, kept visible below the scrolling body. */
  footer?: ReactNode;
  /** The child is a column that scrolls itself; give it a definite height. */
  fill?: boolean;
  /**
   * Centre it below lg too, instead of anchoring it to the fold. For a short
   * modal QUESTION (see `ConfirmDialog`) — a bottom-anchored one puts its
   * buttons in the same band as the action row that opened it.
   */
  centered?: boolean;
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
      className={`sheet-backdrop${centered ? " sheet-backdrop--centered" : ""}`}
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
 * The app's destructive confirm: a nested dialog, at every width (System 4
 * P2).
 *
 * It used to be an inline disclosure in the sheet's pinned foot, and the foot
 * is `column-reverse` below lg so the growth would land on the far side of the
 * action row rather than under the finger that pressed it. That solved the
 * finger and created a worse problem: the confirm no longer read as belonging
 * to its trigger. Measured, four combinations of width × wrapped-row:
 *
 *   390, row wraps to 2 lines  "Remove from plan" y=784, confirm y=658.8
 *                              — 169.2px ABOVE, Match activity / Move it /
 *                                Skip it in between
 *   390, row on 1 line         117.2px above, "Move" in between
 *   1440, row on 1 line        12px below the row — reads perfectly
 *   1440, row wraps (studio)   "Retire…" on line 1 of 2, confirm 64px below
 *                              with "Talk to your coach about this plan"
 *                                in between
 *
 * One of four. The inline form only reads correctly when the direction is
 * `column` AND the action row happens to fit on one line, and neither is a
 * property the foot can promise — the row wraps on content, at any width.
 *
 * A dialog has no such condition. It is over the trigger, it names the thing
 * it will do in its own title, it cannot render off-screen, and it re-uses the
 * most-measured primitive in this codebase: the Sheet's focus trap, focus
 * restore and 0px-shift positioning, which the regression check confirmed
 * resolve against the VIEWPORT for a nested sheet rather than against the
 * parent.
 *
 * `centered`, and that part is not cosmetic. The first cut of this used a
 * plain Sheet, which is bottom-anchored below lg — and a bottom-anchored
 * confirm puts its buttons in the same band the pinned action row occupies.
 * Measured at 390: the dialog's "Remove from plan" landed at y 784–828, the
 * trigger's own box, centre-to-centre 0.0px, and `elementFromPoint` at the
 * pre-press point came back "Remove from plan". That is the under-the-finger
 * defect the foot exists to prevent, arriving by a different door.
 *
 * The dialog is NOT auto-focused onto its destructive button — `useDialogFocus`
 * focuses the dialog element itself, so the confirm still takes a deliberate
 * press (or a Tab) and Escape/backdrop is always the cheap way out.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  /** Names the action, as a question: "Remove this workout?" */
  title: string;
  /** What it will and will not touch, in the reader's words. */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      centered
      footer={
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p>{children}</p>
    </Sheet>
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

export function Banner({
  kind,
  children,
  id,
}: {
  kind: "warn" | "info";
  children: ReactNode;
  /** So a disclosure trigger can `aria-controls` the banner it reveals. */
  id?: string;
}) {
  // Wrap in a single element so multi-part prose (bold words, links) flows as
  // text instead of each run becoming its own flex item.
  return (
    <div className={`banner banner-${kind}`} id={id}>
      <span>{children}</span>
    </div>
  );
}
