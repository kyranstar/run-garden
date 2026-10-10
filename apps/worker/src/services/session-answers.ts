/**
 * THE SESSION REVIEW'S FEEDBACK, KEPT (Stage 1 Task 15). `exercise_prefs.rating` holds only the latest rating; each
 * save also writes what the athlete said as `athlete_answers` rows, so the history survives the next save:
 *  - one `exercise_feedback` row per rated library exercise (+1 / -1; a cleared rating says nothing, so no row);
 *  - one `workout_feedback` row when the review carries the workout-level slot (rating 1–5, difficulty, words).
 * The ids are deterministic per (user, performed session, question, subject): a re-save of the same session upserts
 * its rows and never doubles them. The words are the athlete's own: stored as data, never logged.
 */
import { sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { PerformedSessionWire } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { insertBatches, type AtomicStatement, type Db } from "./db.js";

const { athleteAnswers } = schema;

let libraryIds: Set<string> | undefined;

export function sessionAnswerStatements(
  db: Db,
  userId: string,
  performedId: string,
  p: PerformedSessionWire,
  source: "review" | "watch_review",
  now: string,
): AtomicStatement[] {
  libraryIds ??= new Set(EXERCISES.map((e) => e.id));
  const common = { userId, source, localDate: p.localDate, at: now, workoutId: p.workoutId, performedSessionId: performedId };
  type Row = typeof athleteAnswers.$inferInsert;
  const exerciseRows: Row[] = [];
  for (const exerciseId of Object.keys(p.review.ratings).sort()) {
    const rating = p.review.ratings[exerciseId];
    if (rating === null || rating === undefined || !libraryIds.has(exerciseId)) continue;
    exerciseRows.push({
      id: `${userId}:${performedId}:exercise_feedback:${exerciseId}`,
      questionId: "exercise_feedback",
      subjectKind: "exercise",
      subjectId: exerciseId,
      valueNum: rating,
      ...common,
    });
  }
  let workoutRow: Row | undefined;
  const s = p.review.session;
  if (s && (s.rating !== undefined || s.difficulty !== undefined || (s.text !== undefined && s.text !== ""))) {
    workoutRow = {
      id: `${userId}:${performedId}:workout_feedback`,
      questionId: "workout_feedback",
      subjectKind: "performed_session",
      subjectId: performedId,
      valueNum: s.rating ?? null,
      valueChoice: s.difficulty ?? null,
      text: s.text ? s.text : null,
      ...common,
    };
  }
  // Every row of one insert has the same columns: the lean shape (no null columns, more rows under the 100 bound
  // variables) unless the workout row rides along, and then all of them share its columns and one statement serves both.
  const rows: Row[] = workoutRow ? [...exerciseRows.map((r) => ({ ...r, valueChoice: null, text: null })), workoutRow] : exerciseRows;
  return insertBatches(rows).map((batch) =>
    db
      .insert(athleteAnswers)
      .values(batch)
      .onConflictDoUpdate({
        target: athleteAnswers.id,
        set: {
          valueNum: sql`excluded.value_num`,
          valueChoice: sql`excluded.value_choice`,
          text: sql`excluded.text`,
          localDate: sql`excluded.local_date`,
          at: sql`excluded.at`,
        },
      }),
  );
}
