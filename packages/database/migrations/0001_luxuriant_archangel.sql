CREATE TABLE `coros_exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`raw` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coros_exercises_updated_idx` ON `coros_exercises` (`updated_at`);--> statement-breakpoint
CREATE TABLE `studio_plan_pushes` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`plan_version` integer NOT NULL,
	`happen_day` text NOT NULL,
	`session_title` text NOT NULL,
	`coros_id_in_plan` text,
	`coros_program_id` text,
	`coros_entity_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `studio_plan_pushes_plan_idx` ON `studio_plan_pushes` (`plan_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `studio_plan_pushes_stamp_unique` ON `studio_plan_pushes` (`plan_id`,`happen_day`,`session_title`);--> statement-breakpoint
CREATE TABLE `studio_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`brief` text NOT NULL,
	`plan` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `studio_plans_user_idx` ON `studio_plans` (`user_id`);