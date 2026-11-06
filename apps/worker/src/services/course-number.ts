/**
 * THE NUMBER OF A COURSE'S SESSION DONE WITHOUT BEING WRITTEN (plans with a purpose, rulings R16, R40), apart from the write
 * itself: a leaf, so every path that completes a row takes it without the build's imports.
 *
 * A course counts its sessions by `course_session` (`courseSessionsDone`), and the day's write is what sets it. A session
 * can also end before anything wrote it: a manual link on an outline, an activity linked by its COROS program, an app save
 * that names the slot, Mark done whatever its day. Then the session is over, so it stays without a document (judging a day
 * gone could refuse it, and a document adds nothing), and it takes its number in the same write as the completion, or the
 * session is done and the number doesn't move.
 *
 * SO EVERY WRITE THAT COMPLETES A PLANNED ROW SPREADS THIS, in the same `.set()` as `completionState: "completed"`. It is
 * one column of that UPDATE, read against the row as it was: no statement more, no bound value, and nothing that can land
 * apart from the completion. Its number is the plan's sessions done, plus one, as the write's is. On anything but an
 * outline of a course it leaves the column as it is, so a written session keeps the number it was written as, and an
 * adaptive slot or a workout the coach filed keeps none. So it does on a row already completed: a session marked done and
 * then linked has its number, and that count already includes it.
 *
 * WHAT MARK DONE OFFERS (`markDoneOffer`, `mark-done.ts` has the rest) is here too, because the session's read says it, and
 * that read reads nothing more for it.
 */
import { sql, type SQL } from "drizzle-orm";
import { addDays } from "@rg/domain";
import { plannedWorkouts } from "@rg/database";

/** `sanctioned_by` of a session the athlete said is done. Nothing reads it as the coach's sanction: those read `coach`. */
export const ATHLETE_SAID_DONE = "athlete_said_done";

/** How far back a session can be marked done: the week reconcile leaves one unresolved (`AUTO_MISS_DAYS`). */
export const MARK_DONE_DAYS_BACK = 7;

export function courseNumberOnCompletion(): { courseSession: SQL } {
  const pw = plannedWorkouts;
  return {
    courseSession: sql`case when ${pw.origin} = 'program' and ${pw.completionState} <> 'completed' and exists (select 1 from programs p where p.id = ${pw.planId} and p.user_id = ${pw.userId} and p.kind = 'course')
      then (select count(*) + 1 from planned_workouts done where done.user_id = ${pw.userId} and done.plan_id = ${pw.planId} and done.course_session is not null and done.completion_state = 'completed')
      else ${pw.courseSession} end`,
  };
}

/**
 * Evidence takes over from the athlete's word: spread in a write that links an activity or saves a session, so a session marked
 * done and then linked or played is theirs, no longer the athlete's to undo, and no longer open to an activity of its own
 * (`ingestActivities`). Anyone else's sanction stands. No bound value.
 */
export function markGivesWay(): { sanctionedBy: SQL } {
  const pw = plannedWorkouts;
  return { sanctionedBy: sql`case when ${pw.sanctionedBy} = 'athlete_said_done' then null else ${pw.sanctionedBy} end` };
}

/**
 * What the sheet offers a course's own session, as its row reads: `offer` Mark done, or `marked`, which offers its undo; null
 * for anything else. It can't see a match or a saved session without a read, so the route has the last word on those: a row
 * with either is `completed` or `done` nearly always, and the answer is a refusal in words.
 */
export function markDoneOffer(
  row: { completionState: string; contentState: string | null; effectiveDate: string; sanctionedBy: string | null },
  today: string,
): "offer" | "marked" | null {
  if (row.contentState === "started" || row.contentState === "done") return null;
  if (row.completionState === "completed") return row.sanctionedBy === ATHLETE_SAID_DONE ? "marked" : null;
  if (row.completionState === "skipped") return null;
  return row.effectiveDate <= today && row.effectiveDate >= addDays(today, -MARK_DONE_DAYS_BACK) ? "offer" : null;
}
