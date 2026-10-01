-- 0024: programs — the one registry of plans (one-workout-system spec §8.1,
-- Phase 1 spec §6). Additive: nothing reads these until Phase 2, and Phase 5
-- inserts a row per training_plans / coach_plans / studio_plans row with the
-- same id before any reader switches.
--
-- `kind`: adaptive | coros_import | coach | studio. `status`: draft | active |
-- completed | retired | archived. `disciplines`, `source` and `config` are
-- JSON (`config` validated per kind — `adaptiveConfigSchema` for adaptive).
-- `program_versions` and `program_blocks` belong to an account only through
-- `program_id` (children of `programs` in the table registry).
CREATE TABLE `programs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`disciplines` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`race_date` text,
	`source` text,
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `programs_user_idx` ON `programs` (`user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `program_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`version_num` integer NOT NULL,
	`captured_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `program_versions_program_idx` ON `program_versions` (`program_id`);
--> statement-breakpoint
-- `kind`: core_block | firm_week | shape_week. `intent` is JSON
-- (`blockIntentSchema`): the core lift per family and the rotations for a
-- core block; `{volumeTarget, keySessions}` for a shape week.
CREATE TABLE `program_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`start_date` text NOT NULL,
	`weeks` integer NOT NULL,
	`intent` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_blocks_number_unique` ON `program_blocks` (`program_id`,`number`);
