/**
 * WHAT THE COACH IS ASKED ABOUT (coach everywhere, phase A3): the focus an entry point hands the app's coach sheet — what
 * the athlete was looking at — with what its chip says and the scope it asks for by default.
 *
 *  - The server takes `{ kind, id }` (`focusOfWire`); the label, the day and a suggestion's scope are the screen's own,
 *    for the chip and the scope buttons, and never sent.
 *  - The chip: "About: Fri 23 Oct · Strength · 40 min" — a day, a title, minutes; the day in the domain's `dayLabel`,
 *    the server's own words for a day (its refusal says "Ask about a day from Sat 10 Oct to …": one format, the review).
 *  - The scope by default (`focusScope`): Now — for a workout or a day too, whatever its date: one workout, which the
 *    focus's day or workout directs (Now's own words: "unless the request names another day or a planned workout to
 *    change"); never a whole week's set for one workout (the review, I1) — and a suggestion its own (a single one is a
 *    now or a later-today design). Nothing in it waits on today being known, so the primary button never flips.
 *  - A day can be asked about from a week back to six days ahead, the last day any run plans (`askableDay`, the
 *    server's own range: design-focus.ts).
 */
import { ApiError, type ActivityDto, type CoachRunFocus, type DesignLineDto, type WorkoutDto } from "@rg/api-client";
import { addDays, dayLabel, type CoachScopeKind } from "@rg/domain";
import { formatMinutes } from "../../components.js";

export type CoachFocusKind = CoachRunFocus["kind"];

export interface CoachFocus extends CoachRunFocus {
  /** What the chip says after "About: ". */
  label: string;
  /** A workout's or a day's date (an activity's and a session's too): the scope it asks for reads it. */
  date?: string;
  /** A suggestion's own scope, when the screen knows it. */
  scope?: CoachScopeKind;
}

/** What opens the coach sheet (`useCoach().open`): what it is about, the words to start from, a scope to start with. */
export interface CoachOpenArgs {
  focus?: CoachFocus | null;
  request?: string | null;
  scope?: CoachScopeKind | null;
}

/** What the server is told: the kind and the id, nothing the screen made up. */
export const focusOfWire = (f: Pick<CoachFocus, "kind" | "id">): CoachRunFocus => ({ kind: f.kind, id: f.id });

const joined = (...parts: Array<string | null | undefined | false>): string => parts.filter((p): p is string => !!p).join(" · ");

/** A planned workout: its day, its title, its minutes (the plan's own estimate, else its calendar block). */
export function workoutFocus(w: Pick<WorkoutDto, "id" | "title" | "effectiveDate" | "workoutSeconds" | "calendarSeconds">): CoachFocus {
  const seconds = w.workoutSeconds ?? w.calendarSeconds ?? null;
  return { kind: "workout", id: w.id, date: w.effectiveDate, label: joined(dayLabel(w.effectiveDate), w.title, seconds ? formatMinutes(seconds) : null) };
}

/** A day of the plan. */
export const dayFocus = (date: string): CoachFocus => ({ kind: "day", id: date, date, label: dayLabel(date) });

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

/**
 * One of the coach's single-workout suggestions (a follow-up): its title, and its own scope — a now design (or one for
 * another day, which only a Now run names) Now; one later today Later today.
 */
export function proposalFocus(id: string, line: Pick<DesignLineDto, "title" | "date" | "atNow">, today: string | null): CoachFocus {
  const scope: CoachScopeKind = line.atNow || line.date !== today ? "now" : "later_today";
  return { kind: "proposal", id, label: line.title, scope };
}

/** The scope a focus asks for by default: Now, but a suggestion's own; null leaves the athlete's own default (a
 * suggestion whose scope isn't known). */
export function focusScope(f: CoachFocus): CoachScopeKind | null {
  return f.kind === "proposal" ? (f.scope ?? null) : "now";
}

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

/** How far back a day can be asked about, and how far ahead: the last day any run plans (Now names a day of the next
 * seven; Plan ahead plans today to +6) — the server's own range (design-focus.ts `FOCUS_AHEAD_DAYS`). */
export const ASK_DAYS_BACK = 7;
export const ASK_DAYS_AHEAD = 6;

/** A day the coach can be asked about: from a week back to six days ahead. */
export const askableDay = (date: string, today: string): boolean => date >= addDays(today, -ASK_DAYS_BACK) && date <= addDays(today, ASK_DAYS_AHEAD);
