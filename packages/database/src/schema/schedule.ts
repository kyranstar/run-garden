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
    /** Coach-authored lift/mobility structure (rework spec §5): the
     * exercises array survives apply so plan-detail progressions can graph
     * coached plans — stageSummary alone flattens sets×reps×kg into prose.
     * `rounds` (2026-08-16) marks the list as a CIRCUIT cycled that many
     * times rather than straight sets; absent means straight sets. */
    structuredJson: text("structured_json", { mode: "json" }).$type<
      { exercises: unknown[]; rounds?: number } | null
    >(),
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
    /** Who blessed a skip: "coach" = an approved coach proposal (the garden
     * treats it as sanctioned rest, 1/rolling-week — fairness spec §1). */
    sanctionedBy: text("sanctioned_by"),
    archivedAt: text("archived_at"),
    /** Why archivedAt is set: absence_confirmed | user_removed | duplicate_mirror. */
    archiveReason: text("archive_reason"),
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
    /**
     * ── THE STRENGTH PRESCRIPTION (2026-08-17) ──────────────────────────────
     *
     * A run stage is fully described by the columns above; a STRENGTH step is
     * not, and these five are why the athlete's Goblet Squat rendered as a bare
     * movement name with no sets, no reps and no weight.
     *
     * The whole chain was already broken in three places at once. The push path
     * wrote all of it (`buildStrengthProgram`: reps as `targetType: 3`, load as
     * `intensityType: 1` in grams, rest as `restType: 1`, and tempo/per-side
     * disclosure in the step's `overview`); `normalize.ts` read none of it back;
     * and there was nowhere to put it if it had. So a session made a round trip
     * through the watch and came home as a list of names — the app erasing the
     * prescription the app itself had written.
     *
     * `repeatCount` above already carried SETS, because a repeat container's
     * `sets` was the one number that always survived. These are the rest of it.
     */
    /** Reps per set (`targetType: 3`). NOT a duration — the wire states no time
     *  for a rep step, so `durationType` stays `"none"` and this is the target. */
    reps: integer("reps"),
    /** External load in kilograms (grams on the wire, `intensityType: 1`). */
    loadKg: real("load_kg"),
    /**
     * The step is explicitly BODYWEIGHT — a distinct fact from `load_kg = 0`,
     * which COROS renders as "0.00 kg" in its own app. On the wire this is
     * `intensityCustom: 1` with `intensityValue` empty OR ABSENT (the server
     * drops the empty string the write path sends), so it cannot be inferred
     * from the load column being null and needs its own flag.
     */
    loadBodyweight: integer("load_bodyweight", { mode: "boolean" }),
    /** Rest after this step in seconds (`restType: 1`); null = skip rests. */
    restSeconds: integer("rest_seconds"),
    /**
     * The step's own free text (`overview`) — the one slot a step has, and where
     * the push path discloses what the wire has no field for at all: "4s down"
     * for an eccentric tempo, "each side" for per-side work, and the coach's own
     * cue. A COROS-authored program can carry one too.
     */
    note: text("note"),
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

export const syncIntents = sqliteTable(
  "sync_intents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    targetKind: text("target_kind").notNull(), // workout | studio_session
    targetId: text("target_id").notNull(), // planned_workouts.id | studio_plan_pushes.id
    kind: text("kind").notNull(), // move | create | delete | remove_local | restore
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    source: text("source").notNull(), // user_move | calendar_drag | studio_push | studio_retire | remove_from_plan | auto_resolve | undo
    createdAt: text("created_at").notNull(),
    /** Newer intent of the same (targetId, kind) that replaced this one. */
    supersededBy: text("superseded_by"),
    /** Set when the reconciler verified this intent landed on COROS (or it needs no write). */
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("sync_intents_target_idx").on(t.targetId),
    index("sync_intents_user_open_idx").on(t.userId, t.resolvedAt),
  ],
);

export const syncNotes = sqliteTable(
  "sync_notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workoutId: text("workout_id"),
    kind: text("kind").notNull(), // kept_local_change | adopted_coros_change | adopted_coros_edit | adopted_coros_removal
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    dismissedAt: text("dismissed_at"),
  },
  (t) => [index("sync_notes_user_idx").on(t.userId, t.dismissedAt)],
);
