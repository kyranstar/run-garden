CREATE TABLE `sync_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`superseded_by` text,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_intents_target_idx` ON `sync_intents` (`target_id`);--> statement-breakpoint
CREATE INDEX `sync_intents_user_open_idx` ON `sync_intents` (`user_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `sync_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workout_id` text,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`dismissed_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_notes_user_idx` ON `sync_notes` (`user_id`,`dismissed_at`);--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `archive_reason` text;