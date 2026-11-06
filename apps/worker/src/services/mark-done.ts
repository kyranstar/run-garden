/**
 * MARK DONE (plans with a purpose, spec §4.2 and §5.1; rulings R40, R41): following a course's video records nothing, and a
 * course counts sessions done, so the athlete can say one happened. Their word is the session's evidence.
 *
 * ONE WRITE, AND NO DOCUMENT (R40). `completion_state`, `resolution_date` (the session's own day, since that's the day it
 * happened), `sanctioned_by = 'athlete_said_done'` and the number (`courseNumberOnCompletion`) land in one UPDATE, which holds
 * to everything below in its own WHERE, so nothing can land apart and a change since the read writes nothing. An outline stays
 * an outline whether it's due, held by a pause or by `finishing`, or past: a written session keeps its document and number. So
 * there's no judge that could refuse a session already over.
 *
 * WHOSE (R41): a course's own session, an outline of the plan or a row with its number. A workout the coach filed under the plan
 * doesn't count toward the course and completes the normal way. A paused or stopped plan's session still can be, since this only
 * records what happened.
 *
 * WHEN: today or up to `MARK_DONE_DAYS_BACK` back, by the athlete's own day, never ahead; scheduled, unresolved or missed. Not a
 * session under way (`LOCKED_CONTENT`, or a performed session saved), matched to an activity, completed another way, or skipped.
 *
 * THE UNDO reverses only this kind. The row goes back to the state reconcile would give it for its date (`openStateFor`), not
 * blindly to `scheduled`, with its document left as `/unmatch` leaves one (`reopenedDocColumns`). An outline's number goes with
 * it, so it's a plain outline again (`flexible`, `TOUCHED`); a written session keeps the number it was written as, which counts
 * for nothing until it's completed again. A week's limit doesn't apply: it only takes back what the athlete said.
 *
 * Said twice, either way, the second writes nothing and answers the same, so a retry after a lost answer is safe.
 *
 * THE WATCH. A copy on it stays, as a done session's does. Undone on its own day, a written session is marked owed, as an un-skip
 * is (`markMirrorOwed`): the mirror may have let it go while it read as done.
 *
 * WHAT IT COSTS: two statements here, the read and the write; a third to read again when the write's guard refused it, or for
 * an undo's owed mark. A refusal or a retry stops at the read. Then the route replays the garden from the session's day as
 * `/match` does, in what a request has left (`MARK_DONE_REPLAY_MAX_DAYS`). Pinned in mark-done.test.ts.
 *
 * A restore in progress: the middleware's 423 first, and `restoring` from the write's own guard for one begun since.
 */
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { addDays, docOriginRow, type UserPreferences } from "@rg/domain";
import { ATHLETE_SAID_DONE, courseNumberOnCompletion, MARK_DONE_DAYS_BACK } from "./course-number.js";
import type { Db } from "./db.js";
import { LOCKED_CONTENT } from "./doc-workouts.js";
import { markMirrorOwed } from "./mirror-owed.js";
import { openStateFor, restModeOn } from "./reconcile-daily.js";
import { reopenedDocColumns } from "./workout-doc-store.js";

const pw = plannedWorkouts;

/** Raw names, so these read the same inside the SELECT and inside the UPDATE of this very table. */
const OWN_SESSION = sql.raw(
  "((planned_workouts.origin = 'program' or planned_workouts.course_session is not null) and exists (select 1 from programs p where p.id = planned_workouts.plan_id and p.user_id = planned_workouts.user_id and p.kind = 'course'))",
);
const MATCHED = sql.raw("exists (select 1 from workout_completion_matches m where m.workout_id = planned_workouts.id and m.undone_at is null)");
const PERFORMED = sql.raw("exists (select 1 from performed_sessions s where s.workout_id = planned_workouts.id)");
const RESTORING = sql.raw("exists (select 1 from account_state a where a.user_id = planned_workouts.user_id and coalesce(a.restore_id, '') <> '')");

/** What can still be marked: everything still open, a miss among them. A skip is the athlete having said otherwise. */
const MARKABLE = ["scheduled", "unresolved", "missed"];

/** Why it's refused, in words the sheet says as they are. */
const WHY = {
  not_a_course_session: "Only a course's own session can be marked done. This one completes the usual way.",
  under_way: "It's under way. Finish it or discard it first.",
  matched: "It's linked to an activity, and that's what says it's done.",
  completed_another_way: "It was completed another way, so it stays done.",
  skipped: "It's skipped. Un-skip it first.",
  ahead: "Its day hasn't come yet.",
  too_long_ago: "It's more than a week back, so it stays as it is.",
  changed: "It changed just now. Try again.",
} as const;

export type MarkDoneAnswer =
  /** `from`: the day to replay the garden from, when something changed. */
  | { ok: true; from: string | null }
  | { ok: false; status: 404 }
  | { ok: false; status: 423 }
  | { ok: false; status: 409; error: keyof typeof WHY; why: string };

const refuse = (error: keyof typeof WHY): MarkDoneAnswer => ({ ok: false, status: 409, error, why: WHY[error] });

/** The session as both halves read it. One statement. */
async function readSession(db: Db, userId: string, workoutId: string) {
  const [found] = await db
    .select({
      origin: pw.origin,
      completionState: pw.completionState,
      contentState: pw.contentState,
      effectiveDate: pw.effectiveDate,
      sanctionedBy: pw.sanctionedBy,
      snoozedUntil: pw.snoozedUntil,
      own: sql<number>`${OWN_SESSION}`,
      matched: sql<number>`${MATCHED}`,
      performed: sql<number>`${PERFORMED}`,
      restoring: sql<number>`${RESTORING}`,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId), isNull(pw.archivedAt)))
    .limit(1);
  return found;
}
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/** What's to be done with this session: nothing (it's as asked), a refusal, or the write. */
function decide(s: Session | undefined, done: boolean, today: string): MarkDoneAnswer | "write" {
  if (!s) return { ok: false, status: 404 };
  if (s.restoring) return { ok: false, status: 423 };
  if (!s.own) return refuse("not_a_course_session");
  if (s.matched) return refuse("matched");
  const underWay = (LOCKED_CONTENT as readonly (string | null)[]).includes(s.contentState) || Boolean(s.performed);
  if (s.completionState === "completed") {
    if (s.sanctionedBy !== ATHLETE_SAID_DONE) return refuse("completed_another_way");
    if (underWay) return refuse("under_way");
    return done ? { ok: true, from: null } : "write";
  }
  if (underWay) return refuse("under_way");
  if (s.completionState === "skipped") return refuse("skipped");
  if (!done) return { ok: true, from: null };
  if (s.effectiveDate > today) return refuse("ahead");
  if (s.effectiveDate < addDays(today, -MARK_DONE_DAYS_BACK)) return refuse("too_long_ago");
  return "write";
}

/** The write's guard, either way: what `decide` said, as the row stands now. */
const stillAsRead = (workoutId: string, userId: string, date: string) =>
  and(
    eq(pw.id, workoutId),
    eq(pw.userId, userId),
    isNull(pw.archivedAt),
    eq(pw.effectiveDate, date),
    or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
    sql`${OWN_SESSION}`,
    sql`not ${MATCHED}`,
    sql`not ${PERFORMED}`,
    sql`not ${RESTORING}`,
  );

/**
 * The header's Mark done, or its undo. `from` in the answer says the garden has something to replay. Two statements, three when
 * the write's guard refused it and the row is read again to say why.
 */
export async function markSessionDone(
  db: Db,
  userId: string,
  workoutId: string,
  done: boolean,
  { today, now, prefs }: { today: string; now: string; prefs: UserPreferences },
): Promise<MarkDoneAnswer> {
  const session = await readSession(db, userId, workoutId);
  const decided = decide(session, done, today);
  if (decided !== "write") return decided;
  const { effectiveDate: date, snoozedUntil } = session!;
  const wrote = done
    ? await db
        .update(pw)
        .set({ completionState: "completed", resolutionDate: date, sanctionedBy: ATHLETE_SAID_DONE, ...courseNumberOnCompletion(), updatedAt: now })
        .where(and(stillAsRead(workoutId, userId, date), inArray(pw.completionState, MARKABLE)))
        .returning({ id: pw.id })
    : await db
        .update(pw)
        .set({
          ...openStateFor(date, today, { restMode: restModeOn(prefs, today), snoozedUntil }),
          sanctionedBy: null,
          // An outline goes back to being one. A written session keeps what it was written as.
          courseSession: sql`case when ${pw.origin} = 'program' then null else ${pw.courseSession} end`,
          ...reopenedDocColumns(),
          updatedAt: now,
        })
        .where(and(stillAsRead(workoutId, userId, date), eq(pw.completionState, "completed"), eq(pw.sanctionedBy, ATHLETE_SAID_DONE)))
        .returning({ id: pw.id });
  if (wrote.length > 0) {
    if (!done && date >= today && docOriginRow(session!)) await markMirrorOwed(db, userId, workoutId, now);
    return { ok: true, from: date < today ? date : today };
  }
  // Its guard held: the row has moved since the read. Say why as it now stands.
  const asItStands = decide(await readSession(db, userId, workoutId), done, today);
  return asItStands === "write" ? refuse("changed") : asItStands;
}
