-- 0029: saved posts imported from outside, the checks that found them, the batches they are released in, the personal moves extracted from them, and the link from a post to each move (saved-posts import, 2026-10-23). Purely additive: nothing reads these until the saves routes land.
-- id = sha256(user_id:source:source_key) formatted as a uuid. source is data (the site is never named here). status is owned by the ledger service. filter_stage: creator | keyword | model | owner | seed. hashtags, extraction: JSON text.
CREATE TABLE `saved_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`url` text,
	`creator_handle` text,
	`creator_name` text,
	`caption` text,
	`hashtags` text NOT NULL DEFAULT '[]',
	`media_type` text,
	`posted_at` text,
	`first_seen_at` text NOT NULL,
	`status` text NOT NULL,
	`filter_verdict` text,
	`filter_reason` text,
	`filter_stage` text,
	`extraction` text,
	`extract_attempts` integer NOT NULL DEFAULT 0,
	`last_error_code` text,
	`last_error` text,
	`cost_micros` integer NOT NULL DEFAULT 0,
	`batch_id` text,
	`seeded` integer NOT NULL DEFAULT 0,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_posts_source_unique` ON `saved_posts` (`user_id`, `source`, `source_key`);
--> statement-breakpoint
CREATE INDEX `saved_posts_status_idx` ON `saved_posts` (`user_id`, `status`, `updated_at`);
--> statement-breakpoint
-- id = the client's checkId. One row per check the extension ran.
CREATE TABLE `save_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`found` integer NOT NULL DEFAULT 0,
	`fresh` integer NOT NULL DEFAULT 0,
	`filtered` integer NOT NULL DEFAULT 0,
	`extracted` integer NOT NULL DEFAULT 0,
	`failed` integer NOT NULL DEFAULT 0,
	`error_code` text,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `save_checks_user_idx` ON `save_checks` (`user_id`, `started_at`);
--> statement-breakpoint
-- status: held | released | saved | dismissed. notice: the plain-words note shown with the batch.
CREATE TABLE `save_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`theme` text,
	`created_at` text NOT NULL,
	`released_at` text,
	`saved_at` text,
	`fitted_at` text,
	`notice` text
);
--> statement-breakpoint
CREATE INDEX `save_batches_status_idx` ON `save_batches` (`user_id`, `status`, `released_at`);
--> statement-breakpoint
-- id = the personal move id. status is owned by the moves service. record: JSON ExerciseRecord.
CREATE TABLE `personal_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`merged_into` text,
	`batch_id` text,
	`record` text NOT NULL,
	`edited_by_owner` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `personal_moves_status_idx` ON `personal_moves` (`user_id`, `status`);
--> statement-breakpoint
-- move_kind: library | personal. status: pending | saved | removed.
CREATE TABLE `saved_post_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`position` integer NOT NULL,
	`move_id` text NOT NULL,
	`move_kind` text NOT NULL,
	`batch_id` text,
	`confidence` real,
	`check_flag` integer NOT NULL DEFAULT 0,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_post_moves_position_unique` ON `saved_post_moves` (`post_id`, `position`);
--> statement-breakpoint
CREATE INDEX `saved_post_moves_batch_idx` ON `saved_post_moves` (`user_id`, `batch_id`);
