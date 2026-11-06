/**
 * THE NUMBER OF A COURSE'S SESSION DONE WITHOUT BEING WRITTEN (plans with a purpose, ruling R16), apart from the write
 * itself: a leaf, so every path that completes a row takes it without the build's imports.
 *
 * A course counts its sessions by `course_session` (`courseSessionsDone`), and the day's write is what sets it. A session
 * can also end before anything wrote it: a manual link on an outline, an activity linked by its COROS program, an app save
 * that names the slot, Mark done on a past day. Then the session is over, so it stays without a document (judging a day
 * gone could refuse it, and a document adds nothing), and it takes its number in the same write as the completion, or the
 * session is done and the number doesn't move.
 *
 * SO EVERY WRITE THAT COMPLETES A PLANNED ROW SPREADS THIS, in the same `.set()` as `completionState: "completed"`. It is
 * one column of that UPDATE, read against the row as it was: no statement more, no bound value, and nothing that can land
 * apart from the completion. Its number is the plan's sessions done, plus one, as the write's is. On anything but an
 * outline of a course it leaves the column as it is, so a written session keeps the number it was written as, and an
 * adaptive slot or a workout the coach filed keeps none.
 */
import { sql, type SQL } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";

export function courseNumberOnCompletion(): { courseSession: SQL } {
  const pw = plannedWorkouts;
  return {
    courseSession: sql`case when ${pw.origin} = 'program' and exists (select 1 from programs p where p.id = ${pw.planId} and p.user_id = ${pw.userId} and p.kind = 'course')
      then (select count(*) + 1 from planned_workouts done where done.user_id = ${pw.userId} and done.plan_id = ${pw.planId} and done.course_session is not null and done.completion_state = 'completed')
      else ${pw.courseSession} end`,
  };
}
