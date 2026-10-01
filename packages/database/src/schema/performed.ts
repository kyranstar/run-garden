import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Builds and what was actually done (migration 0026; one-workout-system spec
 * §8.3). Additive in Phase 1: Phase 2 writes them.
 */

/** Every build of an app session, versioned per planned workout. */
export const sessionBuilds = sqliteTable(
  "session_builds",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workoutId: text("workout_id").notNull(),
    version: integer("version").notNull(),
    engineVersion: text("engine_version").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    /** The build payload the player plays (steps, library slice, alternatives). */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Set when the session starts; a locked build never changes. */
    lockedAt: text("locked_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("session_builds_version_unique").on(t.workoutId, t.version)],
);

/**
 * One performed session. `id` is client-generated — the outbox's idempotency
 * key. `source`: app | watch_review | import; `sourceRef` is the source's own
 * session id for imports (NULL for app saves, which the unique index then
 * never binds: SQLite treats NULLs as distinct).
 */
export const performedSessions = sqliteTable(
  "performed_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workoutId: text("workout_id"),
    activityId: text("activity_id"),
    buildId: text("build_id"),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    localDate: text("local_date").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    seconds: integer("seconds").notNull().default(0),
    plannedSeconds: integer("planned_seconds"),
    /** The session length asked for. */
    minutes: integer("minutes"),
    mode: text("mode"),
    theme: text("theme"),
    locationId: text("location_id"),
    blockRef: text("block_ref"),
    /** The block's number when the session was done: history (and "Block N complete") without the block row. */
    blockNumber: integer("block_number"),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    stepsTotal: integer("steps_total"),
    stepsDone: integer("steps_done"),
    /**
     * Every move the session reached, logged or not (the engine's `done`):
     * played-only moves (mobility, breathing) have no set rows, and the
     * engine's repetition penalty, first-done dates and coverage read them.
     */
    movesDone: text("moves_done", { mode: "json" })
      .$type<Array<{ exerciseId: string; seconds: number }>>()
      .notNull()
      .default([]),
    note: text("note"),
    newMove: text("new_move"),
    payloadHash: text("payload_hash").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("performed_sessions_user_date_idx").on(t.userId, t.localDate),
    uniqueIndex("performed_sessions_source_unique").on(t.userId, t.source, t.sourceRef),
  ],
);

/**
 * One logged set. Weights are kept exactly as entered (`loadValue`,
 * `loadUnit`) plus `loadKg`, derived, for maths.
 */
export const performedSets = sqliteTable(
  "performed_sets",
  {
    id: text("id").primaryKey(),
    performedSessionId: text("performed_session_id").notNull(),
    entryIndex: integer("entry_index").notNull(),
    exerciseId: text("exercise_id").notNull(),
    implement: text("implement"),
    format: text("format"),
    perSide: integer("per_side", { mode: "boolean" }).notNull().default(false),
    setIndex: integer("set_index").notNull(),
    side: text("side"),
    reps: integer("reps"),
    seconds: integer("seconds"),
    loadValue: real("load_value"),
    loadUnit: text("load_unit"),
    loadKg: real("load_kg"),
    done: integer("done", { mode: "boolean" }).notNull().default(true),
    /** Profile flag ids set on this exercise, e.g. a profile's `setFlag.id`. */
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (t) => [
    index("performed_sets_session_idx").on(t.performedSessionId),
    index("performed_sets_exercise_idx").on(t.exerciseId),
  ],
);

/** A condition check: before or after a session, or on its own (daily). */
export const conditionChecks = sqliteTable(
  "condition_checks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    profileId: text("profile_id").notNull(),
    /** pre | post | daily. */
    kind: text("kind").notNull(),
    /** 0–10; NULL when not given. */
    value: integer("value"),
    feelingOff: integer("feeling_off", { mode: "boolean" }).notNull().default(false),
    localDate: text("local_date").notNull(),
    at: text("at").notNull(),
    performedSessionId: text("performed_session_id"),
    workoutId: text("workout_id"),
  },
  (t) => [index("condition_checks_user_date_idx").on(t.userId, t.localDate)],
);
