import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The athlete's profile, objectives, answers, workout-document history and the Studio's templates
 * (migration 0028; Stage 1). JSON columns are typed loosely here: @rg/workout and the stages that own each
 * shape validate them.
 */

/** One row per user; `id` = `userId`. */
export const athleteProfiles = sqliteTable(
  "athlete_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** [{ id: GoalId, words: string }] */
    goals: text("goals", { mode: "json" }).notNull().$type<unknown[]>().default([]),
    /** [{ id: slug, label, refs: string[], note? }] */
    focusAreas: text("focus_areas", { mode: "json" }).notNull().$type<unknown[]>().default([]),
    /** [{ id, label, kind: race|trip|ski|travel|other, start, end?, priority: A|B|C, taper }] */
    events: text("events", { mode: "json" }).notNull().$type<unknown[]>().default([]),
    /** { sessionMinutes?, trainingDays?, defaultPlaceId? } */
    preferences: text("preferences", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("athlete_profiles_user_unique").on(t.userId)],
);

export const objectives = sqliteTable(
  "objectives",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    why: text("why"),
    status: text("status").notNull().default("active"), // active | paused | done | dropped
    goalIds: text("goal_ids", { mode: "json" }).notNull().$type<string[]>().default([]),
    sort: integer("sort").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("objectives_user_idx").on(t.userId, t.status)],
);

export const keyResults = sqliteTable(
  "key_results",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    label: text("label").notNull(),
    /** A KeyResultMeasure (Task 13 owns the shape). */
    measure: text("measure", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    direction: text("direction").notNull(), // up | down
    baseline: real("baseline"),
    target: real("target"),
    unit: text("unit").notNull(),
    dueDate: text("due_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("key_results_objective_idx").on(t.objectiveId)],
);

/** Every write of a workout document, kept. `id` is `<workoutId>:<rev>`. */
export const workoutDocRevisions = sqliteTable(
  "workout_doc_revisions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workoutId: text("workout_id").notNull(),
    rev: integer("rev").notNull(),
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    sourceKind: text("source_kind").notNull(), // a DOC_SOURCES value or 'athlete_edit'
    sourceRef: text("source_ref"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("workout_doc_revisions_workout_idx").on(t.workoutId, t.rev)],
);

/**
 * One answer per area ("sore: calves 6, hamstrings 3" is two rows sharing `at`). `text` is the athlete's own
 * words: data, never instructions. Stage 4 owns the question registry.
 */
export const athleteAnswers = sqliteTable(
  "athlete_answers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    questionId: text("question_id").notNull(),
    subjectKind: text("subject_kind"), // region | muscle | focus_area | exercise | workout | performed_session | condition
    subjectId: text("subject_id"),
    valueNum: real("value_num"),
    valueChoice: text("value_choice"),
    text: text("text"),
    source: text("source").notNull(), // checkin | ask_athlete | request | session_pre | session_post | review | watch_review
    localDate: text("local_date").notNull(),
    at: text("at").notNull(),
    workoutId: text("workout_id"),
    performedSessionId: text("performed_session_id"),
    proposalId: text("proposal_id"),
    expiresAt: text("expires_at"),
  },
  (t) => [
    index("athlete_answers_user_q_idx").on(t.userId, t.questionId, t.localDate),
    index("athlete_answers_subject_idx").on(t.userId, t.subjectKind, t.subjectId),
  ],
);

/** The Studio's saved workouts. `doc` is a WorkoutDoc with source.kind 'template'. */
export const workoutTemplates = sqliteTable(
  "workout_templates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("workout_templates_user_idx").on(t.userId, t.pinned)],
);
