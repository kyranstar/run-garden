/**
 * JSON KEPT AS PLAIN TEXT (controller ruling, Stage 1 Task 11; final review): Drizzle's json mode parses every row it
 * reads and throws on a malformed value, so one bad row fails a whole read. The document columns and the coach's
 * agent state and evidence are plain TEXT: writers stringify, readers parse at read and survive a bad value.
 */
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { coachMemory, coachRuns, plannedWorkouts, sessionBuilds, workoutTemplates } from "../src/index.js";

const COLUMNS: ReadonlyArray<[string, SQLiteTable, string]> = [
  ["planned_workouts", plannedWorkouts, "workout_doc"],
  ["session_builds", sessionBuilds, "workout_doc"],
  ["coach_runs", coachRuns, "state"],
  ["coach_memory", coachMemory, "evidence"],
  ["workout_templates", workoutTemplates, "doc"],
];

describe("JSON columns a bad row must not break are plain text", () => {
  for (const [tableName, table, name] of COLUMNS) {
    it(`${tableName}.${name}`, () => {
      const column = getTableConfig(table).columns.find((c) => c.name === name);
      expect(column).toBeDefined();
      expect(column!.columnType).toBe("SQLiteText");
    });
  }
});
