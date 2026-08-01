import { useEffect, type ReactNode } from "react";
import type { CorosSyncState, CompletionState } from "@rg/domain";
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
  return `${dows[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}`;
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

const COROS_PILL: Record<CorosSyncState, { label: string; cls: string; icon: ReactNode }> = {
  synced: { label: "Synced", cls: "pill-ok", icon: <IconCheck /> },
  syncing: { label: "Syncing", cls: "pill-progress", icon: <IconSync /> },
  waiting_for_device: { label: "Waiting for Mac", cls: "pill-progress", icon: <IconLaptop /> },
  calendar_only: { label: "Calendar only", cls: "pill-neutral", icon: <IconCalendarOnly /> },
  needs_attention: { label: "Needs attention", cls: "pill-warn", icon: <IconAlert /> },
};

export function CorosPill({ state, hideWhenHealthy }: { state: CorosSyncState; hideWhenHealthy?: boolean }) {
  if (hideWhenHealthy && state === "synced") return null;
  const p = COROS_PILL[state];
  return (
    <span className={`pill ${p.cls}`}>
      {p.icon}
      {p.label}
    </span>
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
  return <div className={`banner banner-${kind}`}>{children}</div>;
}
