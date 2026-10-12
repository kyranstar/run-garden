/**
 * A TERM THAT EXPLAINS ITSELF, ONE TAP DOWN (Stage 2 spec §5; principles §7). The word is a button: a tap — or Enter or
 * Space, which a button turns into a click — opens a small popover with one plain sentence, and a second tap, Escape or
 * a tap anywhere else closes it. Nothing about it is hover-only: a pointer hovering over the word does nothing, so a
 * phone and a mouse get the same thing, and the sentence is never the only way to learn something the page needs.
 *
 * The pattern is a disclosure, not an ARIA `tooltip` (which is a hover/focus hint): `aria-expanded` says whether it is
 * open and `aria-controls` names the popover, which stays in the DOM while closed so the reference always resolves
 * (the same rule as `.disclosure-body`). It sits right after the button, so the next thing a screen reader reads is
 * the sentence.
 *
 * Escape goes through `useEscapeKey`, so it belongs to the top thing: a tooltip open inside a sheet closes first, and
 * the sheet only on the next press. One tooltip is open at a time — opening another closes the last.
 *
 * The popover is placed under the word and measured on open: if it would cross the viewport's right edge it shifts
 * back inside (`--tip-shift`), because the shell clips anything wider than the page rather than scrolling to it.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useEscapeKey, useIsomorphicLayoutEffect } from "../components.js";

/** The open tooltip's closer, so opening another closes it. */
let closeOpen: (() => void) | null = null;

/** How close to the viewport's edge a popover may come, in CSS px. */
const EDGE = 12;

export function Tooltip({
  term,
  tip,
  className,
  children,
}: {
  /** The word, and the popover's heading. */
  term: string;
  /** One plain sentence. */
  tip: string;
  /** Extra classes for the button (a status colour, say). */
  className?: string;
  /** The button's content when it is more than the word (an icon beside it). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEscapeKey(open, close);

  useEffect(() => {
    if (!open) return;
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      if (closeOpen === close) closeOpen = null;
    };
  }, [open, close]);

  useIsomorphicLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el || typeof window === "undefined") return;
    el.style.removeProperty("--tip-shift");
    const r = el.getBoundingClientRect();
    const right = document.documentElement.clientWidth - EDGE;
    let shift = r.right > right ? right - r.right : 0;
    if (r.left + shift < EDGE) shift = EDGE - r.left;
    if (shift !== 0) el.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
  }, [open]);

  return (
    <span className="term-wrap" ref={wrap}>
      <button
        type="button"
        className={className ? `term ${className}` : "term"}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? term}
      </button>
      <span id={id} ref={pop} className="term-pop" hidden={!open}>
        <b>{term}</b> {tip}
      </span>
    </span>
  );
}
