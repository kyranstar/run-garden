-- 0040: R1 (the LifeOS migration's DESIGN-3 §3.4.3, §3.12; kit v0.20). take_back_receipts: one row per training write the phone or the laptop can take back — a saved workout put on the plan (`place`, keyed by its clientId) or an approved coach op (`coach_approve`, keyed by proposal id and op id) — written in the same batch as that write, with what the row was before (`pre_state`), what the write left (`post_state`: the compare columns as canonical JSON, read from the row inside that batch), the provider work it queued, when it lapses (8 days, or the session's day end), and, once taken back, the take-back's request id, when and what it did. The account's own data: exported, restored and deleted with the account. native_device_sharing: switch A per paired phone (whether it may send the owner's day frame with a training ask, and the disclosure version the owner accepted), off unless a row says on; a sign-in's bookkeeping like native_devices — never exported, restored or copied, delete-all removes it. Purely additive: two new tables and their indexes, no backfill, no existing table touched or locked. Rolling the code back leaves both tables idle and harmless (nothing reads them); dropping them is a migration of its own.
CREATE TABLE `take_back_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`made_by` text NOT NULL,
	`workout_id` text NOT NULL,
	`op` text NOT NULL,
	`group_id` text NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`pre_state` text,
	`post_state` text NOT NULL,
	`effects` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`request_id` text,
	`taken_back_at` text,
	`result` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `take_back_receipts_source_idx` ON `take_back_receipts` (`user_id`,`source`,`source_key`);
--> statement-breakpoint
CREATE INDEX `take_back_receipts_workout_idx` ON `take_back_receipts` (`user_id`,`workout_id`);
--> statement-breakpoint
CREATE TABLE `native_device_sharing` (
	`device_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`to_training` integer DEFAULT 0 NOT NULL,
	`disclosure_version` text NOT NULL,
	`set_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `native_device_sharing_user_idx` ON `native_device_sharing` (`user_id`);
