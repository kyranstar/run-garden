import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Saved posts imported from outside (migration 0029). The source is data — no
 * site is named here.
 */

/** One post the extension found. `id` = sha256(`${userId}:${source}:${sourceKey}`) formatted as a uuid. */
export const savedPosts = sqliteTable(
  "saved_posts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    url: text("url"),
    creatorHandle: text("creator_handle"),
    creatorName: text("creator_name"),
    caption: text("caption"),
    hashtags: text("hashtags", { mode: "json" }).$type<string[]>().notNull().default([]),
    mediaType: text("media_type"),
    postedAt: text("posted_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    status: text("status").notNull(),
    filterVerdict: text("filter_verdict"),
    filterReason: text("filter_reason"),
    filterStage: text("filter_stage").$type<"creator" | "keyword" | "model" | "owner" | "seed">(),
    extraction: text("extraction", { mode: "json" }).$type<unknown>(),
    extractAttempts: integer("extract_attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    costMicros: integer("cost_micros").notNull().default(0),
    batchId: text("batch_id"),
    seeded: integer("seeded", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("saved_posts_source_unique").on(t.userId, t.source, t.sourceKey),
    index("saved_posts_status_idx").on(t.userId, t.status, t.updatedAt),
  ],
);

/** One check the extension ran; `id` is the client's checkId. */
export const saveChecks = sqliteTable(
  "save_checks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    found: integer("found").notNull().default(0),
    fresh: integer("fresh").notNull().default(0),
    filtered: integer("filtered").notNull().default(0),
    extracted: integer("extracted").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (t) => [index("save_checks_user_idx").on(t.userId, t.startedAt)],
);

/** A group of extracted moves released together. */
export const saveBatches = sqliteTable(
  "save_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").$type<"held" | "released" | "saved" | "dismissed">().notNull(),
    theme: text("theme"),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at"),
    savedAt: text("saved_at"),
    fittedAt: text("fitted_at"),
    notice: text("notice"),
  },
  (t) => [index("save_batches_status_idx").on(t.userId, t.status, t.releasedAt)],
);

/** A move extracted from a post that the library does not hold. `record` is an ExerciseRecord. */
export const personalMoves = sqliteTable(
  "personal_moves",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").notNull(),
    mergedInto: text("merged_into"),
    batchId: text("batch_id"),
    record: text("record", { mode: "json" }).$type<unknown>().notNull(),
    editedByOwner: integer("edited_by_owner", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("personal_moves_status_idx").on(t.userId, t.status)],
);

/** The link from a post to each move found in it, by position. */
export const savedPostMoves = sqliteTable(
  "saved_post_moves",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    postId: text("post_id").notNull(),
    position: integer("position").notNull(),
    moveId: text("move_id").notNull(),
    moveKind: text("move_kind").$type<"library" | "personal">().notNull(),
    batchId: text("batch_id"),
    confidence: real("confidence"),
    checkFlag: integer("check_flag", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<"pending" | "saved" | "removed">().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("saved_post_moves_position_unique").on(t.postId, t.position),
    index("saved_post_moves_batch_idx").on(t.userId, t.batchId),
  ],
);

export type SavedPostRow = typeof savedPosts.$inferSelect;
export type PersonalMoveRow = typeof personalMoves.$inferSelect;
export type SaveBatchRow = typeof saveBatches.$inferSelect;
export type SavedPostMoveRow = typeof savedPostMoves.$inferSelect;
