/**
 * WHAT THE ATHLETE WAS LOOKING AT WHEN THEY ASKED (coach everywhere, phase A1). A run may be asked from something on
 * screen and carries it as `focus: { kind, id }`:
 *
 *   workout    a planned workout (a doc workout is one too): its `planned_workouts` id
 *   day        a day of the plan: `YYYY-MM-DD`
 *   session    a session the athlete did: its `performed_sessions` id
 *   activity   an activity: its `activities` id
 *   objective  an objective: its `objectives` id
 *   move       a library exercise: its id (the bundled library)
 *   proposal   one of the coach's designed suggestions: its `dp-` id — a follow-up that changes it (phase A2)
 *
 * The route validates the shape (`focusSchema`: 400 `bad_focus`). `checkFocus` holds it to the signed-in athlete in ONE
 * statement — none for a day or a move — and answers a suggestion's own scope (a follow-up asks nothing else): another
 * athlete's object, or one that isn't there, is `focus_not_found` (the route's 404); a set's suggestion is refused in
 * words (`focus_is_set`: a week plan is changed by planning it again). A day is held to the run's horizon by
 * `dayOutOfRange` (a week back, to the last day a run plans, +6: `focus_out_of_range`, in words). The focus is kept in
 * the main run's state (`settings.focus`) — no migration — and read into its opening context (design-context.ts).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { activities, coachProposals, objectives, performedSessions, plannedWorkouts } from "@rg/database";
import { addDays, dayLabel, isLocalDate } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { Db } from "./db.js";
import { designProposalId } from "./design-tools/propose.js";
import type { RunScope } from "./design-tools/types.js";
import { PENDING_HASH } from "./watch-sets.js";

export const FOCUS_KINDS = ["workout", "day", "session", "activity", "objective", "move", "proposal"] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

export interface RunFocus {
  kind: FocusKind;
  id: string;
}

/** An id as long as the app writes them, twice over. */
export const FOCUS_ID_MAX_CHARS = 200;

/** The focus a create may carry: a kind and an id — a day's a calendar date — and nothing else. */
export const focusSchema = z
  .object({ kind: z.enum(FOCUS_KINDS), id: z.string().min(1).max(FOCUS_ID_MAX_CHARS) })
  .strict()
  .refine((f) => f.kind !== "day" || isLocalDate(f.id), { message: "a day is a calendar date, YYYY-MM-DD" });

/** What a set's suggestion as a focus answers (the athlete reads it): a week plan is changed by planning it again. */
export const FOCUS_SET_LINE = "Ask Plan ahead again to change a week plan.";

/** How far back a day may be asked about: the week just gone (a past day's "what now?"). */
export const FOCUS_PAST_DAYS = 7;
/** How far ahead a day may be asked about: the last day a run can plan for — Now's one workout names a day of the next
 * seven, and plan_set plans today to +6 (the review, I1: a week's context reads 14 days, but nothing plans past +6). */
export const FOCUS_AHEAD_DAYS = 6;

export type FocusErrorCode = "focus_not_found" | "focus_out_of_range" | "focus_is_set";

/** A focus a create can't take; `why` is the athlete's words for a refusal they can act on. */
export class FocusError extends Error {
  constructor(
    readonly code: FocusErrorCode,
    readonly why?: string,
  ) {
    super(code);
  }
}

/** Whether a create checks a focus of this kind with a statement (a day and a move need none). */
export const focusCheckedInDb = (kind: FocusKind): boolean => kind !== "day" && kind !== "move";

/** Whether the opening context reads a focus of this kind with a statement: every kind but a move (a day's plan rows are
 * read too). */
export const focusReadInContext = (kind: FocusKind): boolean => kind !== "move";

const MOVES = new Map(EXERCISES.map((e) => [e.id, e]));
/** The library move a focus names, or none. */
export const focusMove = (id: string) => MOVES.get(id) ?? null;

/** A designed suggestion the athlete has seen: never a rehearsal's, one still under review, or one closed with its run. */
const UNSEEN = ["rehearsal", "unreviewed", "cancelled"] as const;
const DESIGNED_PREFIX = designProposalId("");

/** The one statement that finds the focus among the athlete's rows (a suggestion with its run's scope). */
function ownedSql(userId: string, focus: RunFocus) {
  switch (focus.kind) {
    case "workout":
      return sql`select 1 as found, null as scope from ${plannedWorkouts}
        where ${plannedWorkouts.userId} = ${userId} and ${plannedWorkouts.id} = ${focus.id} and ${plannedWorkouts.archivedAt} is null`;
    case "session":
      return sql`select 1 as found, null as scope from ${performedSessions}
        where ${performedSessions.userId} = ${userId} and ${performedSessions.id} = ${focus.id} and ${performedSessions.payloadHash} != ${PENDING_HASH}`;
    case "activity":
      return sql`select 1 as found, null as scope from ${activities} where ${activities.userId} = ${userId} and ${activities.id} = ${focus.id}`;
    case "objective":
      return sql`select 1 as found, null as scope from ${objectives} where ${objectives.userId} = ${userId} and ${objectives.id} = ${focus.id}`;
    case "proposal":
      // Its run's scope says whether it is a set's, and is the scope a follow-up asks for.
      return sql`select 1 as found, (select r.scope from coach_runs r where r.user_id = p.user_id
          and r.id = substr(p.id, ${DESIGNED_PREFIX.length + 1})) as scope
        from ${coachProposals} p where p.user_id = ${userId} and p.id = ${focus.id}
          and substr(p.id, 1, ${DESIGNED_PREFIX.length}) = ${DESIGNED_PREFIX}
          and p.status not in (${sql.join(UNSEEN.map((s) => sql`${s}`), sql`, `)})`;
    default:
      return null;
  }
}

function scopeOfColumn(text: unknown): RunScope | null {
  if (typeof text !== "string") return null;
  try {
    const s = JSON.parse(text) as { kind?: unknown; n?: unknown };
    if (s.kind === "now" || s.kind === "later_today" || s.kind === "week") return { kind: s.kind };
    if (s.kind === "next_n") return typeof s.n === "number" ? { kind: "next_n", n: s.n } : { kind: "next_n" };
  } catch {
    // An unreadable scope is no set's; the create's own scope stands.
  }
  return null;
}

/**
 * The focus is the athlete's: one statement for a planned workout, a session, an activity, an objective or a suggestion
 * — none for a day (`dayOutOfRange` holds it) or a move (the bundled library). Answers a suggestion's own scope; throws
 * `focus_not_found` for another athlete's or a missing one, `focus_is_set` for a set's suggestion.
 */
export async function checkFocus(db: Db, userId: string, focus: RunFocus): Promise<{ scope: RunScope | null }> {
  if (focus.kind === "day") return { scope: null };
  if (focus.kind === "move") {
    if (!focusMove(focus.id)) throw new FocusError("focus_not_found");
    return { scope: null };
  }
  const statement = ownedSql(userId, focus)!;
  const [row] = (await db.all(statement)) as Array<{ found: number; scope: unknown }>;
  if (!row) throw new FocusError("focus_not_found");
  if (focus.kind !== "proposal") return { scope: null };
  const scope = scopeOfColumn(row.scope);
  if (scope && (scope.kind === "week" || scope.kind === "next_n")) throw new FocusError("focus_is_set", FOCUS_SET_LINE);
  return { scope };
}

/**
 * A day no run can plan for: before a week ago, or past FOCUS_AHEAD_DAYS from today — whatever the scope. The refusal's
 * words name the days it can (`dayLabel`'s), never ISO dates.
 */
export function dayOutOfRange(day: string, today: string): FocusError | null {
  const from = addDays(today, -FOCUS_PAST_DAYS);
  const to = addDays(today, FOCUS_AHEAD_DAYS);
  if (day >= from && day <= to) return null;
  return new FocusError("focus_out_of_range", `Ask about a day from ${dayLabel(from)} to ${dayLabel(to)}.`);
}
