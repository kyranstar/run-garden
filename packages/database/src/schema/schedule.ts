import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const trainingPlans = sqliteTable(
  "training_plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("coros"),
    sourcePlanId: text("source_plan_id").notNull(),
    name: text("name").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    status: text("status").notNull().default("active"), // active | archived
    pbVersion: text("pb_version"),
    sourceVersion: text("source_version"),
    contentFingerprint: text("content_fingerprint"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [index("plans_user_idx").on(t.userId, t.status)],
);

export const trainingPlanVersions = sqliteTable(
  "training_plan_versions",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    versionNum: integer("version_num").notNull(),
    capturedAt: text("captured_at").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("plan_versions_plan_idx").on(t.planId)],
);

export const plannedWorkouts = sqliteTable(
  "planned_workouts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    planId: text("plan_id").notNull(),
    sourceWorkoutId: text("source_workout_id").notNull(),
    sourceProgramId: text("source_program_id"),
    sourceIdInPlan: text("source_id_in_plan"),
    title: text("title").notNull(),
    category: text("category").notNull(),
    qualitySubtype: text("quality_subtype"),
    sport: text("sport").notNull().default("run"),
    originalPlanDate: text("original_plan_date").notNull(),
    lastVerifiedCorosDate: text("last_verified_coros_date").notNull(),
    effectiveDate: text("effective_date").notNull(),
    effectiveTime: text("effective_time").notNull(),
    sourceContentFingerprint: text("source_content_fingerprint").notNull(),
    sourceVersion: text("source_version"),
    sourceEstimatedDurationSeconds: integer("source_estimated_duration_seconds"),
    fallbackEstimatedDurationSeconds: integer("fallback_estimated_duration_seconds"),
    calendarBlockDurationSeconds: integer("calendar_block_duration_seconds").notNull(),
    durationEstimate: text("duration_estimate", { mode: "json" }).$type<Record<string, unknown>>(),
    expectedDistanceMeters: real("expected_distance_meters"),
    stageSummary: text("stage_summary"),
    calendarSyncState: text("calendar_sync_state").notNull().default("not_created"),
    corosSyncState: text("coros_sync_state").notNull().default("synced"),
    completionState: text("completion_state").notNull().default("scheduled"),
    /** Consecutive schedule reads where this workout was absent upstream. */
    missingReads: integer("missing_reads").notNull().default(0),
    /** "Not yet" on the did-this-happen prompt: reconcile won't re-ask until
     * this LocalDate. Without it the hourly cron re-flagged the workout
     * within the hour and the defer button read as broken. */
    snoozedUntil: text("snoozed_until"),
    /** The local date a completion/skip/missed resolution landed (garden input). */
    resolutionDate: text("resolution_date"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("planned_workouts_source_unique").on(t.userId, t.planId, t.sourceWorkoutId),
    index("planned_workouts_date_idx").on(t.userId, t.effectiveDate),
    index("planned_workouts_state_idx").on(t.userId, t.completionState),
  ],
);

export const plannedWorkoutStages = sqliteTable(
  "planned_workout_stages",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id").notNull(),
    parentStageId: text("parent_stage_id"),
    ord: integer("ord").notNull(),
    kind: text("kind").notNull(),
    repeatCount: integer("repeat_count"),
    durationType: text("duration_type").notNull(),
    durationSeconds: integer("duration_seconds"),
    distanceMeters: real("distance_meters"),
    targetType: text("target_type"),
    targetLow: real("target_low"),
    targetHigh: real("target_high"),
    paceZone: integer("pace_zone"),
    hrZone: integer("hr_zone"),
    label: text("label"),
  },
  (t) => [index("stages_workout_idx").on(t.workoutId)],
);

export const scheduleOverrides = sqliteTable(
  "schedule_overrides",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id").notNull(),
    kind: text("kind").notNull(), // user_move | user_skip | time_change | restore
    fromDate: text("from_date"),
    toDate: text("to_date"),
    toTime: text("to_time"),
    source: text("source"), // app | calendar_edit | reconciler
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("overrides_workout_idx").on(t.workoutId)],
);

export const corosScheduleSnapshots = sqliteTable(
  "coros_schedule_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    capturedAt: text("captured_at").notNull(),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    /** Sanitized normalized summary — never raw credentials or health payloads. */
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
    reason: text("reason"), // scheduled_read | pre_write | post_write_verify | spike
  },
  (t) => [index("coros_snapshots_user_idx").on(t.userId, t.capturedAt)],
);

export const corosWriteJobs = sqliteTable(
  "coros_write_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /**
     * `planned_workouts.id` for move jobs. The studio kinds have no planned
     * workout of their own until COROS syncs one back, so they mirror
     * `studioPushId` here to satisfy NOT NULL — code must read `studioPushId`,
     * never this column, when `kind` is a studio kind.
     */
    workoutId: text("workout_id").notNull(),
    kind: text("kind").notNull().default("move_scheduled_workout"),
    expectedSourceVersion: text("expected_source_version"),
    expectedContentFingerprint: text("expected_content_fingerprint").notNull(),
    originalDate: text("original_date").notNull(),
    destinationDate: text("destination_date").notNull(),
    requestedAt: text("requested_at").notNull(),
    status: text("status").notNull().default("queued"),
    claimedByDeviceId: text("claimed_by_device_id"),
    claimedAt: text("claimed_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    pathUsed: text("path_used"),
    degraded: integer("degraded", { mode: "boolean" }).notNull().default(false),
    verifiedAt: text("verified_at"),
    lastErrorCategory: text("last_error_category"),
    completedAt: text("completed_at"),
    /** `studio_plan_pushes.id` this job acts on (studio kinds only). */
    studioPushId: text("studio_push_id"),
    /**
     * The studio job payload, stored server-side. A superset of what the
     * bridge is sent: a delete for a CHANGED session also carries the
     * follow-up create, which is enqueued only once the delete reaches a
     * terminal "gone" state, so a refused delete can never be followed by a
     * create that silently adopts the stale workout via `already_present`.
     */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("write_jobs_status_idx").on(t.userId, t.status),
    index("write_jobs_workout_idx").on(t.workoutId),
    index("write_jobs_studio_push_idx").on(t.studioPushId),
  ],
);

export const corosWriteAttempts = sqliteTable(
  "coros_write_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    deviceId: text("device_id").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    outcome: text("outcome"),
    pathUsed: text("path_used"),
    errorCategory: text("error_category"),
    observedDate: text("observed_date"),
    signatureValid: integer("signature_valid", { mode: "boolean" }),
  },
  (t) => [index("write_attempts_job_idx").on(t.jobId)],
);

export const calendarEventLinks = sqliteTable(
  "calendar_event_links",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id").notNull().unique(),
    calendarId: text("calendar_id").notNull(),
    eventId: text("event_id").notNull(),
    state: text("state").notNull().default("synced"), // synced | pending | user_deleted | error
    lastWrittenFingerprint: text("last_written_fingerprint"),
    lastWrittenAt: text("last_written_at"),
    /** The user-notes section preserved across description rewrites. */
    userNotes: text("user_notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("event_links_event_idx").on(t.eventId)],
);

export const calendarEventSuppressions = sqliteTable(
  "calendar_event_suppressions",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id").notNull(),
    eventId: text("event_id"),
    reason: text("reason").notNull(), // user_deleted | workout_removed
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("suppressions_workout_idx").on(t.workoutId)],
);
