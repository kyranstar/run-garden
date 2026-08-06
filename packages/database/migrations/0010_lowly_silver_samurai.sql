CREATE TABLE `coach_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`provenance` text NOT NULL,
	`learned_at` text NOT NULL,
	`expires_at` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coach_memory_user_idx` ON `coach_memory` (`user_id`,`active`);--> statement-breakpoint
CREATE TABLE `coach_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`refs` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coach_messages_user_at_idx` ON `coach_messages` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `coach_plan_weeks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`week_start` text NOT NULL,
	`state` text NOT NULL,
	`shape` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_plan_weeks_unique` ON `coach_plan_weeks` (`plan_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `coach_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`discipline` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`race_date` text,
	`stamp_prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coach_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text,
	`title` text NOT NULL,
	`evidence` text NOT NULL,
	`rationale` text NOT NULL,
	`flags` text NOT NULL,
	`ops` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	`superseded_by` text
);
--> statement-breakpoint
CREATE INDEX `coach_proposals_user_status_idx` ON `coach_proposals` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `coach_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`chips` text NOT NULL,
	`asked_at` text NOT NULL,
	`answered_at` text,
	`memory_id` text
);
--> statement-breakpoint
CREATE INDEX `coach_questions_user_idx` ON `coach_questions` (`user_id`,`answered_at`);--> statement-breakpoint
CREATE TABLE `coach_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`evidence` text NOT NULL,
	`fired_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `coach_triggers_user_idx` ON `coach_triggers` (`user_id`,`consumed_at`);