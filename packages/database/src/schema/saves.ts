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
    /** Migration 0034: how the post came (`saved` from the saved list, `pasted` as a link); null before the trail. */
    origin: text("origin").$type<"saved" | "pasted">(),
    /** Migration 0034: a video's title (YouTube); null when the source has none. */
    title: text("title"),
    /** Migration 0034: the video's length in seconds, when known. */
    durationSec: integer("duration_sec"),
    /** Migration 0034: whether the reader watched the video (null: not known, or not a video read by link). */
    videoSeen: integer("video_seen", { mode: "boolean" }),
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
    status: text("status").$type<"held" | "released" | "saved" | "dismissed" | "superseded">().notNull(),
    theme: text("theme"),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at"),
    savedAt: text("saved_at"),
    fittedAt: text("fitted_at"),
    notice: text("notice"),
    /** Migration 0031: when the owner dismissed the batch; null until then. */
    dismissedAt: text("dismissed_at"),
    /** Migration 0031: when the batch's fit began; null until a fit starts. */
    fitStartedAt: text("fit_started_at"),
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
    /** Migration 0031: the owner's choice for this move; null means the coach's call. */
    fitChoice: text("fit_choice").$type<"include" | "skip">(),
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
    /** Migration 0031: the near-duplicate move this link's move is like; null when none. */
    likeMoveId: text("like_move_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("saved_post_moves_position_unique").on(t.postId, t.position),
    index("saved_post_moves_batch_idx").on(t.userId, t.batchId),
  ],
);

/**
 * THE IMPORT TRAIL (migration 0034; design 2026-11-05 §6.1). One row per thing a stage of a post did, written by that
 * stage with its state change. `detail` is JSON (≤ 64,000 chars); bigger pieces are `import_blobs`.
 */
export const importEvents = sqliteTable(
  "import_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    postId: text("post_id").notNull(),
    batchId: text("batch_id"),
    moveId: text("move_id"),
    stage: text("stage").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail", { mode: "json" }).$type<unknown>(),
    usageId: text("usage_id"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms"),
    attempt: integer("attempt"),
    runId: text("run_id"),
    proposalId: text("proposal_id"),
    rebuilt: integer("rebuilt", { mode: "boolean" }).notNull().default(false),
    at: text("at").notNull(),
  },
  (t) => [index("import_events_post_idx").on(t.userId, t.postId, t.at), index("import_events_stage_idx").on(t.userId, t.stage, t.at)],
);

/** A large piece an event points to: a model's raw reply, the prompt as sent, a transcript (≤ 1,000,000 chars; `cut` past that). */
export const importBlobs = sqliteTable(
  "import_blobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    postId: text("post_id").notNull(),
    eventId: text("event_id"),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    cut: integer("cut", { mode: "boolean" }).notNull().default(false),
    at: text("at").notNull(),
  },
  (t) => [index("import_blobs_post_idx").on(t.userId, t.postId)],
);

/** Each prompt version's system text, written once on first use: every trail can show the prompt it ran under. Not per user. */
export const promptVersions = sqliteTable("prompt_versions", {
  version: text("version").primaryKey(),
  kind: text("kind").notNull(),
  systemText: text("system_text").notNull(),
  firstUsedAt: text("first_used_at").notNull(),
});

/** One change to imported data, by the coach (approved) or the owner: before, after, why, and on what basis. */
export const importCorrections = sqliteTable(
  "import_corrections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    target: text("target").$type<"move" | "link" | "insight" | "reading">().notNull(),
    targetId: text("target_id").notNull(),
    field: text("field").notNull(),
    before: text("before", { mode: "json" }).$type<unknown>(),
    after: text("after", { mode: "json" }).$type<unknown>(),
    why: text("why").notNull(),
    basis: text("basis").$type<"evidence" | "owner">().notNull(),
    evidence: text("evidence", { mode: "json" }).$type<unknown>(),
    by: text("by").$type<"coach" | "owner">().notNull(),
    proposalId: text("proposal_id"),
    at: text("at").notNull(),
  },
  (t) => [index("import_corrections_target_idx").on(t.userId, t.target, t.targetId)],
);

export type ImportEventRow = typeof importEvents.$inferSelect;
export type ImportBlobRow = typeof importBlobs.$inferSelect;
export type SavedPostRow = typeof savedPosts.$inferSelect;
export type PersonalMoveRow = typeof personalMoves.$inferSelect;
export type SaveBatchRow = typeof saveBatches.$inferSelect;
export type SavedPostMoveRow = typeof savedPostMoves.$inferSelect;
