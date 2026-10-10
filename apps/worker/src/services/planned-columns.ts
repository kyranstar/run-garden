/**
 * A READ THAT DOES NOT NEED THE WORKOUT DOCUMENT LEAVES IT OUT (Stage 1; controller ruling 2026-10-10).
 *
 * `planned_workouts.workout_doc` holds a whole workout as JSON text, and the hot reads never use it: the hourly import
 * reads every planned row an account has, the Plan page's today reads weeks of rows, and the coach's dossier reads a
 * month of them. A full-row select would carry every document over D1 for nothing. `plannedRowColumns()` is the
 * table's columns without it, and `PlannedRow` is the row such a read returns — a function that takes a `PlannedRow`
 * cannot read the document by mistake, and a full row still satisfies it. A read that needs the document selects it
 * and parses it with `parseStoredWorkoutDoc`.
 */
import { getTableColumns } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";

/** `planned_workouts` without `workout_doc`. */
export function plannedRowColumns() {
  const { workoutDoc: _document, ...rest } = getTableColumns(plannedWorkouts);
  return rest;
}

/** A planned workout as a read without its document returns it. */
export type PlannedRow = Omit<typeof plannedWorkouts.$inferSelect, "workoutDoc">;
