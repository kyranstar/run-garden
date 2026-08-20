import { type ReactNode } from "react";
import { useEscapeKey } from "../components.js";
import { IconCoach } from "../icons.js";

/**
 * The floating coach window (rework spec §6, desktop ≥1024px only — the page
 * renders the pill + Sheet below that): the plan always owns the full width,
 * and the coach overlays it, non-modal, when open. Controlled — the page owns
 * open state, the last-seen watermark, and localStorage persistence, so a
 * ghost tap and new-activity auto-open live beside the other page state.
 *
 * Escape goes through the shared dialog stack (`useEscapeKey`). It used to be
 * a `document` listener of its own, guarded by a `dialogOpen` boolean the page
 * computed — which meant every dialog opened anywhere inside the panel had to
 * report itself back up to the page or one press would close it AND minimise
 * the window behind it (2026-08-17). A token orders itself.
 */
export function CoachWindow({
  open,
  pendingCount,
  onOpen,
  onMinimize,
  children,
}: {
  open: boolean;
  pendingCount: number;
  onOpen: () => void;
  /** Minimizing marks everything seen (the page advances its watermark). */
  onMinimize: () => void;
  children: ReactNode;
}) {
  useEscapeKey(open, onMinimize);

  if (!open) {
    return (
      <button
        type="button"
        className="coach-pill coach-pill--desktop"
        aria-expanded={false}
        onClick={onOpen}
      >
        <IconCoach size={20} />
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
