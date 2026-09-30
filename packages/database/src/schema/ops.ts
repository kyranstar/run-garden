import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    kind: text("kind").notNull(), // coros_read | coros_backfill | calendar_sync | garden_sim | reconcile | weekly_review
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
  /** idle | queued | running | done | error */
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

/**
 * Per-account bookkeeping that is NOT account data: never exported, never
 * restored, removed by delete-all (migration 0023).
 *
 * `restoreId` is the RESTORE MARKER. Restore begin sets it (with a fresh id the
 * later `rows`/`finish` calls must present), finish or "Start fresh" clears it.
 * While it is set every writer skips the account, so nothing races the file
 * into the half-wiped tables (audit 1 data F2/F8, ruling B2).
 *
 * `restoreHeartbeatAt` is when begin, or the restore's last page, arrived:
 * under two minutes old means the restore is still running (B10), so another
 * device may not start fresh over it or begin a different one.
 *
 * `restoreExpected` is the check session's manifest (`{ table: rows }`);
 * finish compares the landed counts against it.
 *
 * `calendarReconcile` is the one-shot post-restore calendar reconcile (B6):
 * null when there is nothing to do.
 *
 * `gardenCatchUpPending`: a restored garden is still catching up from the
 * file's last simulated day (B4 amended) — a forward-only walk, capped per
 * invocation, that persists `garden_state` where each step stops and deletes
 * nothing at or before it. Cleared by the step that reaches today.
 *
 * `gardenChangedFrom` / `gardenChangedSeq`: the earliest input change a
 * resimulation recorded because a catch-up step held the garden lock (B11),
 * and a counter bumped by every record — the step that replays the change
 * clears it only if nothing was recorded meanwhile.
 */
export const accountState = sqliteTable("account_state", {
  userId: text("user_id").primaryKey(),
  restoreId: text("restore_id"),
  restoreStartedAt: text("restore_started_at"),
  restoreHeartbeatAt: text("restore_heartbeat_at"),
  restoreFileExportedAt: text("restore_file_exported_at"),
  restoreFileExportedFrom: text("restore_file_exported_from"),
  restoreExpected: text("restore_expected", { mode: "json" }).$type<Record<string, number>>(),
  restoreFinishedAt: text("restore_finished_at"),
  calendarReconcile: text("calendar_reconcile", { mode: "json" }).$type<{
    phase: "pending" | "sweeping";
    /** False when the restore came back short: link and recreate, never delete. */
    sweep: boolean;
  }>(),
  gardenCatchUpPending: integer("garden_catch_up_pending", { mode: "boolean" }).notNull().default(false),
  gardenChangedFrom: text("garden_changed_from"),
  gardenChangedSeq: integer("garden_changed_seq").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});
