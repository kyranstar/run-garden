import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    corosActivityId: text("coros_activity_id"),
    startTime: text("start_time").notNull(),
    startTimeLocal: text("start_time_local"),
    timezone: text("timezone"),
    sport: text("sport").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    elapsedSeconds: integer("elapsed_seconds"),
    distanceMeters: real("distance_meters"),
    avgHeartRate: real("avg_heart_rate"),
    maxHeartRate: real("max_heart_rate"),
    avgPaceSecPerKm: real("avg_pace_sec_per_km"),
    elevationGainMeters: real("elevation_gain_meters"),
    trainingLoad: real("training_load"),
    deviceName: text("device_name"),
    title: text("title"),
    completionMatchId: text("completion_match_id"),
    sourceMergeConfidence: real("source_merge_confidence").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("activities_user_time_idx").on(t.userId, t.startTime),
    uniqueIndex("activities_coros_unique").on(t.userId, t.corosActivityId),
  ],
);

export const activitySourceLinks = sqliteTable(
  "activity_source_links",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id").notNull(),
    provider: text("provider").notNull(),
    providerActivityId: text("provider_activity_id").notNull(),
    sourceCreatedAt: text("source_created_at"),
    sourceUpdatedAt: text("source_updated_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    normalizerVersion: text("normalizer_version").notNull(),
    sourceVersion: text("source_version"),
    /** Minimized raw payload kept only for debugging; sanitized. */
    rawSummary: text("raw_summary", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("source_links_provider_unique").on(t.provider, t.providerActivityId),
    index("source_links_activity_idx").on(t.activityId),
  ],
);

export const activityLaps = sqliteTable(
  "activity_laps",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id").notNull(),
    lapIndex: integer("lap_index").notNull(),
    durationSeconds: real("duration_seconds").notNull(),
    distanceMeters: real("distance_meters"),
    avgHeartRate: real("avg_heart_rate"),
    avgPaceSecPerKm: real("avg_pace_sec_per_km"),
    splitType: text("split_type"),
  },
  (t) => [uniqueIndex("laps_activity_idx").on(t.activityId, t.lapIndex)],
);

export const activityStreamSummaries = sqliteTable(
  "activity_stream_summaries",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id").notNull(),
    streamType: text("stream_type").notNull(),
    sampleCount: integer("sample_count").notNull(),
    stats: text("stats", { mode: "json" }).$type<Record<string, number>>(),
  },
  (t) => [uniqueIndex("streams_activity_type_idx").on(t.activityId, t.streamType)],
);

export const workoutCompletionMatches = sqliteTable(
  "workout_completion_matches",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id").notNull(),
    activityId: text("activity_id").notNull(),
    confidence: real("confidence").notNull(),
    method: text("method").notNull(), // coros_plan_link | scored_auto | scored_confirmed | manual
    matchedAt: text("matched_at").notNull(),
    undoneAt: text("undone_at"),
  },
  (t) => [
    // One activity completes at most one workout and vice versa (among active matches).
    index("matches_workout_idx").on(t.workoutId),
    index("matches_activity_idx").on(t.activityId),
  ],
);

export const dailyHealth = sqliteTable(
  "daily_health",
  {
    id: text("id").primaryKey(), // `${userId}:${date}`
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    restingHeartRate: real("resting_heart_rate"),
    hrv: real("hrv"),
    recoveryScore: real("recovery_score"),
    fatigueScore: real("fatigue_score"),
    trainingLoad7d: real("training_load_7d"),
    provider: text("provider").notNull().default("coros"),
    contentFingerprint: text("content_fingerprint").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("daily_health_unique").on(t.userId, t.date)],
);

export const sleepRecords = sqliteTable(
  "sleep_records",
  {
    id: text("id").primaryKey(), // `${userId}:${date}`
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    durationSeconds: integer("duration_seconds").notNull(),
    deepSeconds: integer("deep_seconds"),
    remSeconds: integer("rem_seconds"),
    lightSeconds: integer("light_seconds"),
    awakeSeconds: integer("awake_seconds"),
    qualityScore: real("quality_score"),
    provider: text("provider").notNull().default("coros"),
    contentFingerprint: text("content_fingerprint").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("sleep_unique").on(t.userId, t.date)],
);
