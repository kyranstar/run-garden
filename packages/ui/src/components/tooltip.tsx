/**
 * A TERM THAT EXPLAINS ITSELF, ONE TAP DOWN (Stage 2 spec §5; principles §7). The word is a button: a tap — or Enter or
 * Space, which a button turns into a click — opens a small popover with one plain sentence, and a second tap, Escape, a
 * tap anywhere else, or focus moving away (Tab) closes it. Nothing about it is hover-only: a pointer hovering over the
 * word does nothing, so a phone and a mouse get the same thing, and the sentence is never the only way to learn
 * something the page needs.
 *
 * The pattern is a disclosure, not an ARIA `tooltip` (which is a hover/focus hint): `aria-expanded` says whether it is
 * open and `aria-controls` names the popover, which stays in the DOM while closed so the reference always resolves
 * (the same rule as `.disclosure-body`). It sits right after the button, so the next thing a screen reader reads is
 * the sentence.
 *
 * Escape goes through `useEscapeKey`, so it belongs to the top thing: a tooltip open inside a sheet closes first, and
 * the sheet only on the next press. One tooltip is open at a time — opening another closes the last.
 *
 * The word is a fingertip target without growing the line it sits in: `.tap-pad` gives it an invisible 44px hit area
 * (its container, `.stu-meta`, says how far that may reach). The popover is placed under the word and measured on open:
 * past the right edge it shifts back inside (`--tip-shift`), because the shell clips anything wider than the page; too
 * near the bottom — or the phone's tab bar — it opens upward instead (`data-place="above"`), and it paints above the
 * tab bar either way.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useEscapeKey, useIsomorphicLayoutEffect } from "../components.js";

/** The open tooltip's closer, so opening another closes it. */
let closeOpen: (() => void) | null = null;

/** How close to the viewport's edge a popover may come, in CSS px. */
const EDGE = 12;

/** Where the usable screen ends: the top of the phone's tab bar when one is drawn, else the window's bottom. */
function screenBottom(): number {
  const nav = document.querySelector(".bottom-nav");
  const top = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : 0;
  return top > 0 ? top : window.innerHeight;
}

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
    // Measure where it falls by default, then move it: back inside on the right, upward near the bottom.
    el.style.removeProperty("--tip-shift");
    delete el.dataset.place;
    const r = el.getBoundingClientRect();
    const right = document.documentElement.clientWidth - EDGE;
    let shift = r.right > right ? right - r.right : 0;
    if (r.left + shift < EDGE) shift = EDGE - r.left;
    if (shift !== 0) el.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
    const bottom = screenBottom() - EDGE;
    const word = el.previousElementSibling?.getBoundingClientRect();
    if (r.bottom > bottom && word && word.top - EDGE > bottom - word.bottom) el.dataset.place = "above";
  }, [open]);

  return (
    <span
      className="term-wrap"
      ref={wrap}
      onBlur={(e) => {
        // Focus left the term and its popover (Tab away): close. Moving within them keeps it open.
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <button
        type="button"
        className={className ? `term tap-pad ${className}` : "term tap-pad"}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? term}
      </button>
      {/* Focusable (not tabbable) so a click inside it — selecting the sentence — is not focus leaving the term. */}
      <span id={id} ref={pop} className="term-pop" hidden={!open} tabIndex={-1}>
        <b>{term}</b> {tip}
      </span>
    </span>
  );
}
