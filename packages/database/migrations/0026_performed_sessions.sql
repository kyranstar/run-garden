-- 0026: builds and what was actually done (one-workout-system spec §8.3).
--
-- `session_builds`: every build of an app session, versioned per planned
-- workout; `locked_at` is set when the session starts.
CREATE TABLE `session_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`version` integer NOT NULL,
	`engine_version` text NOT NULL,
	`inputs_hash` text NOT NULL,
	`payload` text NOT NULL,
	`locked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_builds_version_unique` ON `session_builds` (`workout_id`,`version`);
--> statement-breakpoint
-- `performed_sessions.id` is client-generated: the outbox's idempotency key.
-- `source`: app | watch_review | import. `source_ref` is the source's own
-- session id (import); NULL for app saves, and SQLite treats NULLs as
-- distinct, so the unique index only ever binds imports.
-- `moves_done` (beyond the spec's list): JSON `[{exerciseId, seconds}]`, every
-- move the session reached, logged or not — the engine's `done`. A mobility
-- hold or a breathing step is played, never logged, so it has no
-- performed_sets row; without this the engine's history would lose it (its
-- repetition penalty, first-done dates and coverage all read these ids).
CREATE TABLE `performed_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workout_id` text,
	`activity_id` text,
	`build_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`local_date` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`seconds` integer NOT NULL DEFAULT 0,
	`planned_seconds` integer,
	`mode` text,
	`theme` text,
	`location_id` text,
	`block_ref` text,
	`completed` integer NOT NULL DEFAULT 0,
	`steps_total` integer,
	`steps_done` integer,
	`moves_done` text NOT NULL DEFAULT '[]',
	`note` text,
	`new_move` text,
	`payload_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `performed_sessions_user_date_idx` ON `performed_sessions` (`user_id`,`local_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `performed_sessions_source_unique` ON `performed_sessions` (`user_id`,`source`,`source_ref`);
--> statement-breakpoint
-- One row per logged set. Weights are kept exactly as entered (`load_value`,
-- `load_unit`) plus `load_kg`, derived, for maths. `flags` is a JSON list of
-- profile flag ids. A child of performed_sessions in the table registry.
CREATE TABLE `performed_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`performed_session_id` text NOT NULL,
	`entry_index` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`implement` text,
	`format` text,
	`per_side` integer NOT NULL DEFAULT 0,
	`set_index` integer NOT NULL,
	`side` text,
	`reps` integer,
	`seconds` integer,
	`load_value` real,
	`load_unit` text,
	`load_kg` real,
	`done` integer NOT NULL DEFAULT 1,
	`flags` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE INDEX `performed_sets_session_idx` ON `performed_sets` (`performed_session_id`);
--> statement-breakpoint
CREATE INDEX `performed_sets_exercise_idx` ON `performed_sets` (`exercise_id`);
--> statement-breakpoint
-- `kind`: pre | post | daily. `value` 0–10, NULL when not given.
CREATE TABLE `condition_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` integer,
	`feeling_off` integer NOT NULL DEFAULT 0,
	`local_date` text NOT NULL,
	`at` text NOT NULL,
	`performed_session_id` text,
	`workout_id` text
);
--> statement-breakpoint
CREATE INDEX `condition_checks_user_date_idx` ON `condition_checks` (`user_id`,`local_date`);
