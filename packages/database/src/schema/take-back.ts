import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * A TAKE-BACK RECEIPT (migration 0040; the LifeOS migration's DESIGN-3 §3.4.3): one per training write that can be taken
 * back — a saved workout put on the plan (`source` `place`, `source_key` its clientId) or an approved coach op
 * (`coach_approve`, `<proposalId>:<opId>`) — written in the SAME batch as the write it records, so no write stands without
 * its receipt and no receipt without its write. Its id is deterministic (`tb_` + 32 hex of sha-256 over the account, the
 * source and the key): a retried write makes the same receipt.
 *
 *  - `op`: create | revise | move | skip — what the write did to `workout_id`;
 *  - `group_id`: the request that wrote it; receipts written together go back together;
 *  - `depends_on`: receipts this one's write relied on (JSON ids) — they can't be taken back while this one stands;
 *  - `pre_state`: what the row was before (null for a create; a revise's base revision; a move's day and time);
 *  - `post_state`: the row's compare columns as the write left them, canonical JSON read from the row inside the write's
 *    batch (services/take-back.ts `POST_STATE_SQL`) — a take-back runs only while the row still reads exactly this;
 *  - `effects`: the provider work the write queued (`[{provider}]`), so the answer can say what is still pending;
 *  - `expires_at`: 8 days after it was written, or the session's day end on the account's clock if sooner;
 *  - `status`: open | taken_back | expired; `request_id`, `taken_back_at` and `result` once taken back.
 *
 * The account's own data (`user` scope): exported, restored and deleted with it. A restore that brings back an export from
 * before a write brings back no receipt for it; one from after brings back a receipt whose row the compare then finds.
 */
export const takeBackReceipts = sqliteTable(
  "take_back_receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    madeBy: text("made_by").notNull(),
    workoutId: text("workout_id").notNull(),
    op: text("op").notNull(),
    groupId: text("group_id").notNull(),
    dependsOn: text("depends_on").notNull().default("[]"),
    preState: text("pre_state"),
    postState: text("post_state").notNull(),
    effects: text("effects").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    status: text("status").notNull().default("open"),
    requestId: text("request_id"),
    takenBackAt: text("taken_back_at"),
    result: text("result"),
  },
  (t) => [uniqueIndex("take_back_receipts_source_idx").on(t.userId, t.source, t.sourceKey), index("take_back_receipts_workout_idx").on(t.userId, t.workoutId), index("take_back_receipts_open_idx").on(t.userId, t.status, t.expiresAt)],
);

/**
 * SWITCH A, PER PAIRED PHONE (migration 0040; DESIGN-3 §3.12): whether the phone may send the owner's day frame (free
 * times, energy, how full the day is) with a training ask, and the version of the words the owner accepted. No row is off,
 * and so is every phone until the owner turns it on, on the phone. A sign-in's bookkeeping, like the phone's own row: never
 * exported, restored or copied (a restore must never turn a consent back on); delete-all removes it; a step-down below v5
 * turns it off.
 */
export const nativeDeviceSharing = sqliteTable(
  "native_device_sharing",
  {
    deviceId: text("device_id").primaryKey(),
    userId: text("user_id").notNull(),
    toTraining: integer("to_training", { mode: "boolean" }).notNull().default(false),
    disclosureVersion: text("disclosure_version").notNull(),
    setAt: text("set_at").notNull(),
  },
  (t) => [index("native_device_sharing_user_idx").on(t.userId)],
);
