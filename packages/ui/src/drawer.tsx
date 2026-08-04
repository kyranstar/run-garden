import { useId, useRef, type ReactNode } from "react";
import { IconClose } from "./icons.js";
import { useDialogFocus } from "./components.js";

/**
 * A right-docked glass panel that slides in over the garden stage — the
 * Sheet's dialog contract (focus trap, Escape, backdrop click, focus
 * restore) in drawer clothing. Desktop-stage only; mobile keeps its cards.
 */
export function Drawer({
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
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="drawer"
        tabIndex={-1}
      >
        <div className="row-between drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
