CREATE TABLE `coach_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`claim_token` text,
	`claimed_at` text,
	`glance` text,
	`body` text,
	`flags` text NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_reads_user_activity_unique` ON `coach_reads` (`user_id`,`activity_id`);--> statement-breakpoint
CREATE INDEX `coach_reads_user_status_idx` ON `coach_reads` (`user_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `coach_locks` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_locks_user_kind_unique` ON `coach_locks` (`user_id`,`kind`);--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `structured_json` text;
