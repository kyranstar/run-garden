/**
 * THE WAY INTO THE COACH FROM ANY SCREEN (the new shape, 2026-10-17; coach everywhere before it). The app has one coach,
 * a conversation in one sheet (coach-sheet.tsx), and two hooks every screen uses:
 *
 *  - `useCoach().open({ request?, seeing? })` opens it: the nav's Coach button with nothing named, a screen's action
 *    with its words written in the box ("Extend my plan by two weeks") — the athlete's to send, never sent for them.
 *  - `useCoachSeeing(focus | null)`: what the screen shows (today's session, the open workout's sheet, a move). The
 *    sheet shows it as a quiet, dismissible "Seeing: …" over the box — a hint, never the subject — when it is opened
 *    without one named. The newest registration wins; what a screen registered goes when the screen does.
 *
 * Kept apart from the sheet so a screen that asks imports only this. With the coach designer off the app mounts no
 * sheet: `useCoach()` is null, registering is harmless, and `AskCoach` draws nothing.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { IconCoachSmall } from "../../icons.js";
import type { CoachFocus, CoachOpenArgs } from "./coach-focus.js";

export type { CoachOpenArgs } from "./coach-focus.js";

/** What the app's coach sheet offers every screen. */
export interface CoachOpener {
  open: (args?: CoachOpenArgs) => void;
}

export const CoachOpenContext = createContext<CoachOpener | null>(null);

/** The app's coach sheet: `open({ request?, seeing? })`; null when the app has none (the coach is off). */
export const useCoach = (): CoachOpener | null => useContext(CoachOpenContext);

/** What the screens say they show, newest last: the newest is what the coach sees. */
export class SeeingRegistry {
  private entries: Array<{ token: number; focus: CoachFocus }> = [];
  private next = 0;
  private readonly listeners = new Set<() => void>();

  /** Register what a screen shows; the answer takes it back (once — a second call changes nothing). */
  register(focus: CoachFocus): () => void {
    const token = ++this.next;
    this.entries = [...this.entries, { token, focus }];
    this.changed();
    return () => {
      if (!this.entries.some((e) => e.token === token)) return;
      this.entries = this.entries.filter((e) => e.token !== token);
      this.changed();
    };
  }

  /** What the coach sees now: the newest registration, or nothing. */
  get current(): CoachFocus | null {
    return this.entries.at(-1)?.focus ?? null;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

export const CoachSeeingContext = createContext<SeeingRegistry | null>(null);

/** One focus's identity: a new object naming the same thing is the same registration. */
const seeingKey = (f: CoachFocus): string => `${f.kind}\u0000${f.id}\u0000${f.label}`;

/**
 * A screen says what it shows (null: nothing). Registered while the screen is mounted and names it; an equal focus made
 * anew each render registers once.
 */
export function useCoachSeeing(focus: CoachFocus | null): void {
  const registry = useContext(CoachSeeingContext);
  const latest = useRef(focus);
  latest.current = focus;
  const key = focus ? seeingKey(focus) : null;
  useEffect(() => {
    if (!registry || key === null || !latest.current) return;
    return registry.register(latest.current);
  }, [registry, key]);
}

const NOTHING_SEEN = () => () => undefined;

/** What the coach sees now (the newest registration), as React state; null without the sheet. */
export function useCoachSeen(): CoachFocus | null {
  const registry = useContext(CoachSeeingContext);
  return useSyncExternalStore(
    registry ? registry.subscribe : NOTHING_SEEN,
    () => registry?.current ?? null,
    () => null,
  );
}

/**
 * The Ask button (the Today card's, the one the new shape keeps): the coach mark and "Ask", named for what it asks
 * about; it opens the coach seeing that. `request`: words to start from, written in the box.
 */
export function AskCoach({
  focus,
  request = null,
  label,
  variant = "button",
  className,
  wrap,
}: {
  /** What the coach sees (its "Seeing" hint). */
  focus: CoachFocus;
  request?: string | null;
  label?: string;
  variant?: "button" | "link";
  className?: string;
  /** A row of its own, drawn only with the button (no empty row without the coach). */
  wrap?: string;
}) {
  const coach = useCoach();
  if (!coach) return null;
  const classes = [variant === "link" ? "linklike tap-pad ask-coach-link" : "btn btn-small ask-coach", className].filter(Boolean).join(" ");
  const name = label ? `${label}: ${focus.label}` : `Ask the coach about ${focus.label}`;
  const button = (
    <button type="button" className={classes} data-focus={`${focus.kind}:${focus.id}`} aria-label={name} onClick={() => coach.open({ seeing: focus, request })}>
      {variant === "link" ? null : (
        <span className="ask-coach-mark" aria-hidden="true">
          <IconCoachSmall size={16} />
        </span>
      )}
      <span className={variant === "link" ? undefined : "ask-coach-word"}>{label ?? "Ask"}</span>
    </button>
  );
  return wrap ? <div className={wrap}>{button}</div> : button;
}

/** Drawn only without the coach's sheet in the app (an older way to ask, where the sheet has none). */
export function WithoutCoach({ children }: { children: ReactNode }) {
  return useCoach() ? null : <>{children}</>;
}
