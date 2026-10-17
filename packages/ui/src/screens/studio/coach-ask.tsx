/**
 * "ASK" — THE ONE AFFORDANCE THAT OPENS THE COACH FROM ANY SCREEN (coach everywhere, phase A3). Every entry point — the
 * Today card, a planned workout's sheet, a day of the week, an activity, an objective, a move — wears the same small
 * button: the coach mark and "Ask", named for what it asks about ("Ask the coach about Thu Oct 23 · Strength · 40 min").
 * It opens the app's one coach sheet (coach-sheet.tsx) with that focus, in place.
 *
 * The app mounts the sheet only with the coach designer on (app.tsx): with no sheet in the app, there is no Ask — the
 * button is not drawn at all. Kept apart from the sheet itself so a screen that asks imports only this.
 */
import { createContext, useContext, type ReactNode } from "react";
import { IconCoachSmall } from "../../icons.js";
import type { CoachFocus, CoachOpenArgs } from "./coach-focus.js";

/** What the app's coach sheet offers every screen. */
export interface CoachOpener {
  open: (args: CoachOpenArgs) => void;
}

export const CoachOpenContext = createContext<CoachOpener | null>(null);

/** The app's coach sheet: `open({ focus, request, scope })`; null when the app has none (the coach is off). */
export const useCoach = (): CoachOpener | null => useContext(CoachOpenContext);

/**
 * The Ask button. `label` replaces "Ask" where an entry point has words of its own (the objectives board's "Ask the coach
 * for a test"), drawn as a link (`variant: "link"`) where it sits in a sentence. `request`: words to start from.
 */
export function AskCoach({
  focus,
  request = null,
  label,
  variant = "button",
  className,
  wrap,
  name: named,
  fallback = null,
}: {
  focus: CoachFocus;
  request?: string | null;
  label?: string;
  variant?: "button" | "link";
  className?: string;
  /** A row of its own, drawn only with the button (no empty row without the coach). */
  wrap?: string;
  /** Its name for a reader, where the visible words are an entry point's own ("Ask me ›" → "Ask me about …"). */
  name?: string;
  /** What is drawn without the coach in the app (the Today card's link to the Plan's thread coach). */
  fallback?: ReactNode;
}) {
  const coach = useCoach();
  if (!coach) return <>{fallback}</>;
  const classes = [variant === "link" ? "linklike tap-pad ask-coach-link" : "btn btn-small ask-coach", className].filter(Boolean).join(" ");
  const name = named ?? (label ? `${label}: ${focus.label}` : `Ask the coach about ${focus.label}`);
  const button = (
    <button type="button" className={classes} data-focus={`${focus.kind}:${focus.id}`} aria-label={name} onClick={() => coach.open({ focus, request })}>
      {variant === "link" ? null : (
        <span className="ask-coach-mark" aria-hidden="true">
          <IconCoachSmall size={16} />
        </span>
      )}
      {/* The word: a phone's week view draws the mark alone (the name says it), styles.css `.plan-week-ask`. */}
      <span className={variant === "link" ? undefined : "ask-coach-word"}>{label ?? "Ask"}</span>
    </button>
  );
  return wrap ? <div className={wrap}>{button}</div> : button;
}
