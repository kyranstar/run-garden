import { useEffect, type ReactNode } from "react";

/**
 * The floating coach window (rework spec §6, desktop ≥1024px only — the page
 * renders the pill + Sheet below that): the plan always owns the full width,
 * and the coach overlays it, non-modal, when open. Controlled — the page owns
 * open state, the last-seen watermark, and localStorage persistence, so a
 * ghost tap and new-activity auto-open live beside the other page state.
 */
export function CoachWindow({
  open,
  pendingCount,
  onOpen,
  onMinimize,
  dialogOpen,
  children,
}: {
  open: boolean;
  pendingCount: number;
  onOpen: () => void;
  /** Minimizing marks everything seen (the page advances its watermark). */
  onMinimize: () => void;
  /** True while any Sheet/dialog is up — Esc then belongs to the dialog. */
  dialogOpen: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open || dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onMinimize();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dialogOpen, onMinimize]);

  if (!open) {
    return (
      <button
        type="button"
        className="coach-pill coach-pill--desktop"
        aria-expanded={false}
        onClick={onOpen}
      >
        <span aria-hidden="true" className="coach-pill-caret">
          ▴
        </span>
        Coach{pendingCount > 0 ? ` · ${pendingCount}` : ""}
      </button>
    );
  }
  return (
    <div className="coach-window" role="complementary" aria-label="Coach">
      <button
        type="button"
        className="btn btn-small coach-window-min"
        aria-label="Minimize the coach"
        onClick={onMinimize}
      >
        —
      </button>
      {children}
    </div>
  );
}
