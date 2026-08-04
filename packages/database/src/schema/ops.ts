import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    kind: text("kind").notNull(), // coros_read | strava_read | calendar_sync | garden_sim | reconcile | weekly_review
    deviceId: text("device_id"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").notNull().default("running"), // running | ok | error | partial
    stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("sync_runs_kind_idx").on(t.kind, t.startedAt)],
);

export const syncErrors = sqliteTable(
  "sync_errors",
  {
    id: text("id").primaryKey(),
    syncRunId: text("sync_run_id"),
    userId: text("user_id"),
    provider: text("provider"),
    operation: text("operation"),
    category: text("category").notNull(),
    /** Sanitized — never tokens, credentials, or full payloads. */
    message: text("message"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("sync_errors_time_idx").on(t.createdAt)],
);

export const providerCursorState = sqliteTable(
  "provider_cursor_state",
  {
    id: text("id").primaryKey(), // `${userId}:${provider}:${cursorKey}`
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    cursorKey: text("cursor_key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("cursor_unique").on(t.userId, t.provider, t.cursorKey)],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    /** Provider-scoped dedupe key, e.g. `strava:{object_id}:{aspect}:{event_time}`. */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    receivedAt: text("received_at").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    aspect: text("aspect"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status").notNull().default("pending"), // pending | processed | ignored | error
    processedAt: text("processed_at"),
  },
  (t) => [index("webhook_status_idx").on(t.status, t.receivedAt)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    kind: text("kind").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("audit_time_idx").on(t.createdAt)],
);

/**
 * Checkpoint for the one-shot deep activity backfill. One row per user.
 *
 * The backfill walks history backwards in 90-day chunks; this row is what
 * makes a slept Mac resume at the pending chunk instead of restarting from
 * today. `earliestDateReached` is the oldest chunk start that has been
 * ingested, and is what the chunk walker reasons from.
 */
export const backfillState = sqliteTable("backfill_state", {
  userId: text("user_id").primaryKey(),
  /** idle | running | done | error */
  status: text("status").notNull().default("idle"),
  earliestDateReached: text("earliest_date_reached"),
  chunksCompleted: integer("chunks_completed").notNull().default(0),
  activitiesIngested: integer("activities_ingested").notNull().default(0),
  /** Consecutive chunks that returned zero activities; 2 ends the walk. */
  consecutiveEmptyChunks: integer("consecutive_empty_chunks").notNull().default(0),
  /** Accumulated tally of sportType codes seen but not admitted, by code. */
  skippedSportTypes: text("skipped_sport_types", { mode: "json" }).$type<Record<string, number>>(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  lastErrorCategory: text("last_error_category"),
  updatedAt: text("updated_at").notNull(),
});

/** App-level component versions (DB migrations are tracked by wrangler/drizzle). */
export const schemaVersions = sqliteTable("schema_versions", {
  component: text("component").primaryKey(), // simulation | normalizer | estimator | renderer
  version: text("version").notNull(),
  appliedAt: text("applied_at").notNull(),
});
