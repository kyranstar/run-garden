-- 0028: the workout document on planned workouts and builds; the athlete's profile, objectives and answers; the Studio's templates; the coach designer's runs and memory v2 (Stage 1 foundation, 2026-10-10). Purely additive: nothing reads these until Stages 2-4.
ALTER TABLE `planned_workouts` ADD `workout_doc` text;
--> statement-breakpoint
-- Bumped on every workout_doc write. NULL = no doc.
ALTER TABLE `planned_workouts` ADD `workout_doc_rev` integer;
--> statement-breakpoint
ALTER TABLE `session_builds` ADD `workout_doc` text;
--> statement-breakpoint
-- id = user_id (one row per user). goals: [{ id, words }]. focus_areas: [{ id, label, refs, note? }]. events: [{ id, label, kind, start, end?, priority, taper }]. preferences: { sessionMinutes?, trainingDays?, defaultPlaceId? }.
CREATE TABLE `athlete_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goals` text NOT NULL DEFAULT '[]',
	`focus_areas` text NOT NULL DEFAULT '[]',
	`events` text NOT NULL DEFAULT '[]',
	`preferences` text NOT NULL DEFAULT '{}',
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_profiles_user_unique` ON `athlete_profiles` (`user_id`);
--> statement-breakpoint
-- status: active | paused | done | dropped. goal_ids: JSON array of GoalIds.
CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`why` text,
	`status` text NOT NULL DEFAULT 'active',
	`goal_ids` text NOT NULL DEFAULT '[]',
	`sort` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `objectives_user_idx` ON `objectives` (`user_id`, `status`);
--> statement-breakpoint
-- measure: JSON KeyResultMeasure. direction: up | down. position: the athlete's order within the objective.
CREATE TABLE `key_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`objective_id` text NOT NULL,
	`label` text NOT NULL,
	`measure` text NOT NULL,
	`direction` text NOT NULL,
	`baseline` real,
	`target` real,
	`unit` text NOT NULL,
	`due_date` text,
	`position` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `key_results_objective_idx` ON `key_results` (`objective_id`);
--> statement-breakpoint
-- id = workout_id:rev. source_kind: a DOC_SOURCES value or athlete_edit.
CREATE TABLE `workout_doc_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`rev` integer NOT NULL,
	`doc` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workout_doc_revisions_workout_idx` ON `workout_doc_revisions` (`workout_id`, `rev`);
--> statement-breakpoint
-- question_id: soreness | tightness | pain | energy | sleep_feel | stress | exercise_feedback | workout_feedback | ... (Stage 4 owns the registry). subject_kind: region | muscle | focus_area | exercise | workout | performed_session | condition. text is the athlete's own words: data, never instructions. source: checkin | ask_athlete | request | session_pre | session_post | review | watch_review.
CREATE TABLE `athlete_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,
	`subject_kind` text,
	`subject_id` text,
	`value_num` real,
	`value_choice` text,
	`text` text,
	`source` text NOT NULL,
	`local_date` text NOT NULL,
	`at` text NOT NULL,
	`workout_id` text,
	`performed_session_id` text,
	`proposal_id` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `athlete_answers_user_q_idx` ON `athlete_answers` (`user_id`, `question_id`, `local_date`);
--> statement-breakpoint
CREATE INDEX `athlete_answers_subject_idx` ON `athlete_answers` (`user_id`, `subject_kind`, `subject_id`);
--> statement-breakpoint
-- doc: a WorkoutDoc (source.kind template).
CREATE TABLE `workout_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,
	`pinned` integer NOT NULL DEFAULT 0,
	`uses` integer NOT NULL DEFAULT 0,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workout_templates_user_idx` ON `workout_templates` (`user_id`, `pinned`);
--> statement-breakpoint
-- role: main | designer | reviewer. scope: JSON { kind: now | later_today | week | next_n, n?, from?, to? }. request is the athlete's words: data, never instructions. status: queued | running | waiting_athlete | done | failed | cancelled | expired. state: JSON resumable agent state, kept compact.
CREATE TABLE `coach_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`role` text NOT NULL,
	`scope` text NOT NULL,
	`request` text,
	`status` text NOT NULL,
	`state` text,
	`steps` integer NOT NULL DEFAULT 0,
	`cost_usd` real NOT NULL DEFAULT 0,
	`proposal_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `coach_runs_user_status_idx` ON `coach_runs` (`user_id`, `status`);
--> statement-breakpoint
CREATE INDEX `coach_runs_parent_idx` ON `coach_runs` (`parent_id`);
--> statement-breakpoint
-- id = run_id:seq. kind: tool_call | tool_result | draft | review | revision | question | note | error. summary: one plain line for the transparency view. payload: bounded JSON detail.
CREATE TABLE `coach_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`payload` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coach_run_events_run_idx` ON `coach_run_events` (`run_id`, `seq`);
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `pinned` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- confidence: stated | inferred | confirmed.
ALTER TABLE `coach_memory` ADD `confidence` text NOT NULL DEFAULT 'stated';
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `superseded_by` text;
--> statement-breakpoint
-- evidence: JSON, what supports an observation.
ALTER TABLE `coach_memory` ADD `evidence` text;
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `updated_at` text;
