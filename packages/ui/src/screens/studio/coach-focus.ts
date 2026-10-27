/**
 * WHAT THE COACH SEES (the new shape §5; coach everywhere before it): what the athlete is looking at — a planned
 * workout, a day, a session done, an activity, an objective, a move — as a screen registers it (`useCoachSeeing`) or an
 * Ask names it. A quiet hint, never the subject.
 *
 *  - The server takes `{ kind, id }` (`focusOfWire`); the label, the day and a workout's kind are the screen's own — for
 *    the "Seeing" line and the starter chips — and never sent.
 *  - The line: "Seeing: Fri 23 Oct · Strength · 40 min" — a day, a title, minutes; the day in the domain's `dayLabel`,
 *    the server's own words for a day (its refusal says "Ask about a day from Sat 10 Oct to …": one format).
 *  - A focus the server refuses (gone, a day out of reach) is said plainly (`focusRefusal`).
 */
import { ApiError, type ActivityDto, type CoachRunFocus, type WorkoutDto } from "@rg/api-client";
import { dayLabel } from "@rg/domain";
import { formatMinutes } from "../../components.js";

export type CoachFocusKind = CoachRunFocus["kind"];

export interface CoachFocus extends CoachRunFocus {
  /** What the chip says after "About: ". */
  label: string;
  /** A workout's or a day's date (an activity's and a session's too): the scope it asks for reads it. */
  date?: string;
  /** A workout's category ("easy", "strength", …). Never sent. */
  category?: string;
  /** A workout's sport ("run", "strength", …): the starter chips say a run's as a run. Never sent. */
  sport?: string;
  /** A day that is a rest day: its chips are a rest day's (nothing to make lighter). Never sent. */
  rest?: boolean;
}

/**
 * What opens the coach sheet (`useCoach().open`, the new shape): the words to write in the box (the athlete's to send),
 * and what the athlete is looking at — its "Seeing" hint. `seeing` absent: what the screen registered
 * (`useCoachSeeing`); null: nothing. `fit`: a fit of saved moves the server has just started (Today's Fit them in, the
 * batch page's Fit these in — the saves flow redesigned §3.1): the conversation sends its request with its batch, once.
 */
export interface CoachOpenArgs {
  request?: string | null;
  seeing?: CoachFocus | null;
  fit?: CoachFit;
}

/** A fit the server took (`/fit` answered): the words to send the coach and the batch they fit. */
export interface CoachFit {
  batchId: string;
  request: string;
}

/** What the server is told: the kind and the id, nothing the screen made up. */
export const focusOfWire = (f: Pick<CoachFocus, "kind" | "id">): CoachRunFocus => ({ kind: f.kind, id: f.id });

const joined = (...parts: Array<string | null | undefined | false>): string => parts.filter((p): p is string => !!p).join(" · ");

/** A planned workout: its day, its title, its minutes (the plan's own estimate, else its calendar block). */
export function workoutFocus(
  w: Pick<WorkoutDto, "id" | "title" | "effectiveDate" | "workoutSeconds" | "calendarSeconds"> & { category?: string | null; sport?: string | null },
): CoachFocus {
  const seconds = w.workoutSeconds ?? w.calendarSeconds ?? null;
  return {
    kind: "workout",
    id: w.id,
    date: w.effectiveDate,
    label: joined(dayLabel(w.effectiveDate), w.title, seconds ? formatMinutes(seconds) : null),
    ...(w.category ? { category: w.category } : {}),
    ...(w.sport ? { sport: w.sport } : {}),
  };
}

/** A day of the plan; `rest`: a rest day (Today's, with nothing planned to train). */
export const dayFocus = (date: string, o: { rest?: boolean } = {}): CoachFocus => ({
  kind: "day",
  id: date,
  date,
  label: dayLabel(date),
  ...(o.rest ? { rest: true } : {}),
});

/** An activity — or, when it holds a logged session (an app save, a watch review, an import), that session. */
export function activityFocus(a: Pick<ActivityDto, "id" | "date" | "title" | "sport" | "durationSeconds" | "performed">): CoachFocus {
  const minutes = a.durationSeconds > 0 ? formatMinutes(a.durationSeconds) : null;
  const sessionId = a.performed?.id;
  if (sessionId) {
    return { kind: "session", id: sessionId, date: a.date, label: joined(dayLabel(a.date), a.performed?.theme ?? a.title ?? "Session", minutes) };
  }
  return { kind: "activity", id: a.id, date: a.date, label: joined(dayLabel(a.date), a.title ?? sportWord(a.sport), minutes) };
}

const sportWord = (sport: string): string => (sport ? sport.charAt(0).toUpperCase() + sport.slice(1).replace(/_/g, " ") : "Activity");

export const objectiveFocus = (o: { id: string; title: string }): CoachFocus => ({ kind: "objective", id: o.id, label: o.title });

export const moveFocus = (m: { id: string; name: string }): CoachFocus => ({ kind: "move", id: m.id, label: m.name });

/** What the athlete asked from is gone (404 `focus_not_found`: removed, or never theirs). */
export const FOCUS_GONE_LINE = "That isn't there any more — take it off to ask anyway.";

/**
 * A start the server refused for its focus, in plain words: gone (404 `focus_not_found` — read here, never as the coach
 * being off), or the server's own words for a day out of reach or a set's suggestion (400 with `why`). Null otherwise.
 */
export function focusRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body as { error?: unknown; why?: unknown } | null;
  if (e.status === 404 && b?.error === "focus_not_found") return FOCUS_GONE_LINE;
  if (e.status === 400 && (b?.error === "focus_out_of_range" || b?.error === "focus_is_set" || b?.error === "bad_focus")) {
    return typeof b.why === "string" && b.why.trim() ? b.why : "The coach can't be asked about that from here.";
  }
  return null;
}
