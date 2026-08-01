CREATE TABLE `desktop_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`platform` text NOT NULL,
	`app_version` text NOT NULL,
	`bridge_version` text,
	`capabilities` text,
	`bridge_paused` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `device_handshakes` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`device_name` text NOT NULL,
	`platform` text NOT NULL,
	`app_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_user_id` text,
	`device_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`code_verifier` text,
	`redirect_to` text,
	`device_handshake_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`encrypted_access_token` text,
	`encrypted_refresh_token` text,
	`access_token_expires_at` text,
	`scope` text,
	`external_account_id` text,
	`meta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_sync_at` text,
	`last_error_category` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_conn_unique` ON `provider_connections` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`prefs` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`google_sub` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);--> statement-breakpoint
CREATE TABLE `calendar_event_links` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`state` text DEFAULT 'synced' NOT NULL,
	`last_written_fingerprint` text,
	`last_written_at` text,
	`user_notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_links_workout_id_unique` ON `calendar_event_links` (`workout_id`);--> statement-breakpoint
CREATE INDEX `event_links_event_idx` ON `calendar_event_links` (`event_id`);--> statement-breakpoint
CREATE TABLE `calendar_event_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`event_id` text,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `suppressions_workout_idx` ON `calendar_event_suppressions` (`workout_id`);--> statement-breakpoint
CREATE TABLE `coros_schedule_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`summary` text,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `coros_snapshots_user_idx` ON `coros_schedule_snapshots` (`user_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `coros_write_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`device_id` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text,
	`path_used` text,
	`error_category` text,
	`observed_date` text,
	`signature_valid` integer
);
--> statement-breakpoint
CREATE INDEX `write_attempts_job_idx` ON `coros_write_attempts` (`job_id`);--> statement-breakpoint
CREATE TABLE `coros_write_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`kind` text DEFAULT 'move_scheduled_workout' NOT NULL,
	`expected_source_version` text,
	`expected_content_fingerprint` text NOT NULL,
	`original_date` text NOT NULL,
	`destination_date` text NOT NULL,
	`requested_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`claimed_by_device_id` text,
	`claimed_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`path_used` text,
	`degraded` integer DEFAULT false NOT NULL,
	`verified_at` text,
	`last_error_category` text,
	`completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `write_jobs_status_idx` ON `coros_write_jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `write_jobs_workout_idx` ON `coros_write_jobs` (`workout_id`);--> statement-breakpoint
CREATE TABLE `planned_workout_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`parent_stage_id` text,
	`ord` integer NOT NULL,
	`kind` text NOT NULL,
	`repeat_count` integer,
	`duration_type` text NOT NULL,
	`duration_seconds` integer,
	`distance_meters` real,
	`target_type` text,
	`target_low` real,
	`target_high` real,
	`pace_zone` integer,
	`hr_zone` integer,
	`label` text
);
--> statement-breakpoint
CREATE INDEX `stages_workout_idx` ON `planned_workout_stages` (`workout_id`);--> statement-breakpoint
CREATE TABLE `planned_workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`source_workout_id` text NOT NULL,
	`source_program_id` text,
	`source_id_in_plan` text,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`quality_subtype` text,
	`sport` text DEFAULT 'run' NOT NULL,
	`original_plan_date` text NOT NULL,
	`last_verified_coros_date` text NOT NULL,
	`effective_date` text NOT NULL,
	`effective_time` text NOT NULL,
	`source_content_fingerprint` text NOT NULL,
	`source_version` text,
	`source_estimated_duration_seconds` integer,
	`fallback_estimated_duration_seconds` integer,
	`calendar_block_duration_seconds` integer NOT NULL,
	`duration_estimate` text,
	`expected_distance_meters` real,
	`stage_summary` text,
	`calendar_sync_state` text DEFAULT 'not_created' NOT NULL,
	`coros_sync_state` text DEFAULT 'synced' NOT NULL,
	`completion_state` text DEFAULT 'scheduled' NOT NULL,
	`missing_reads` integer DEFAULT 0 NOT NULL,
	`resolution_date` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_workouts_source_unique` ON `planned_workouts` (`user_id`,`plan_id`,`source_workout_id`);--> statement-breakpoint
CREATE INDEX `planned_workouts_date_idx` ON `planned_workouts` (`user_id`,`effective_date`);--> statement-breakpoint
CREATE INDEX `planned_workouts_state_idx` ON `planned_workouts` (`user_id`,`completion_state`);--> statement-breakpoint
CREATE TABLE `schedule_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_date` text,
	`to_date` text,
	`to_time` text,
	`source` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `overrides_workout_idx` ON `schedule_overrides` (`workout_id`);--> statement-breakpoint
CREATE TABLE `training_plan_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`version_num` integer NOT NULL,
	`captured_at` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `plan_versions_plan_idx` ON `training_plan_versions` (`plan_id`);--> statement-breakpoint
CREATE TABLE `training_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'coros' NOT NULL,
	`source_plan_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`pb_version` text,
	`source_version` text,
	`content_fingerprint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `plans_user_idx` ON `training_plans` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`coros_activity_id` text,
	`strava_activity_id` text,
	`start_time` text NOT NULL,
	`start_time_local` text,
	`timezone` text,
	`sport` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`elapsed_seconds` integer,
	`distance_meters` real,
	`avg_heart_rate` real,
	`max_heart_rate` real,
	`avg_pace_sec_per_km` real,
	`elevation_gain_meters` real,
	`training_load` real,
	`device_name` text,
	`title` text,
	`summary_polyline` text,
	`completion_match_id` text,
	`source_merge_confidence` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activities_user_time_idx` ON `activities` (`user_id`,`start_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_coros_unique` ON `activities` (`user_id`,`coros_activity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_strava_unique` ON `activities` (`user_id`,`strava_activity_id`);--> statement-breakpoint
CREATE TABLE `activity_laps` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`lap_index` integer NOT NULL,
	`duration_seconds` real NOT NULL,
	`distance_meters` real,
	`avg_heart_rate` real,
	`avg_pace_sec_per_km` real,
	`split_type` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `laps_activity_idx` ON `activity_laps` (`activity_id`,`lap_index`);--> statement-breakpoint
CREATE TABLE `activity_source_links` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_activity_id` text NOT NULL,
	`source_created_at` text,
	`source_updated_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`normalizer_version` text NOT NULL,
	`source_version` text,
	`raw_summary` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_links_provider_unique` ON `activity_source_links` (`provider`,`provider_activity_id`);--> statement-breakpoint
CREATE INDEX `source_links_activity_idx` ON `activity_source_links` (`activity_id`);--> statement-breakpoint
CREATE TABLE `activity_stream_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`stream_type` text NOT NULL,
	`sample_count` integer NOT NULL,
	`stats` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streams_activity_type_idx` ON `activity_stream_summaries` (`activity_id`,`stream_type`);--> statement-breakpoint
CREATE TABLE `daily_health` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`resting_heart_rate` real,
	`hrv` real,
	`recovery_score` real,
	`fatigue_score` real,
	`training_load_7d` real,
	`provider` text DEFAULT 'coros' NOT NULL,
	`content_fingerprint` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_health_unique` ON `daily_health` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `sleep_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`duration_seconds` integer NOT NULL,
	`deep_seconds` integer,
	`rem_seconds` integer,
	`light_seconds` integer,
	`awake_seconds` integer,
	`quality_score` real,
	`provider` text DEFAULT 'coros' NOT NULL,
	`content_fingerprint` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sleep_unique` ON `sleep_records` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `workout_completion_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`provisional` integer DEFAULT false NOT NULL,
	`matched_at` text NOT NULL,
	`undone_at` text
);
--> statement-breakpoint
CREATE INDEX `matches_workout_idx` ON `workout_completion_matches` (`workout_id`);--> statement-breakpoint
CREATE INDEX `matches_activity_idx` ON `workout_completion_matches` (`activity_id`);--> statement-breakpoint
CREATE TABLE `garden_day_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`input` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `garden_day_inputs_unique` ON `garden_day_inputs` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `garden_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`seq` integer NOT NULL,
	`workout_id` text,
	`activity_id` text,
	`workout_category` text,
	`plant_id` text,
	`species_id` text,
	`wildlife_id` text,
	`detail` text,
	`simulation_version` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `garden_events_unique` ON `garden_events` (`user_id`,`date`,`seq`);--> statement-breakpoint
CREATE INDEX `garden_events_date_idx` ON `garden_events` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `garden_plants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`species_id` text NOT NULL,
	`category` text NOT NULL,
	`planted_at` text NOT NULL,
	`source_workout_id` text,
	`health` real NOT NULL,
	`hydration` real NOT NULL,
	`maturity` real NOT NULL,
	`bloom_progress` real NOT NULL,
	`state` text NOT NULL,
	`pos_x` real NOT NULL,
	`pos_y` real NOT NULL,
	`region` integer NOT NULL,
	`host_plant_id` text,
	`died_at` text,
	`habitat_role` text
);
--> statement-breakpoint
CREATE INDEX `garden_plants_user_idx` ON `garden_plants` (`user_id`);--> statement-breakpoint
CREATE TABLE `garden_scene_layouts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`layout_version` integer NOT NULL,
	`renderer_version` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garden_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`snapshot` text NOT NULL,
	`simulation_version` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `garden_snapshots_unique` ON `garden_snapshots` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `garden_species` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`rarity` text NOT NULL,
	`archetype` text NOT NULL,
	`catalog_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garden_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`simulation_version` integer NOT NULL,
	`last_simulated_date` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garden_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`species_id` text NOT NULL,
	`unlocked_on` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unlocks_unique` ON `garden_unlocks` (`user_id`,`species_id`);--> statement-breakpoint
CREATE TABLE `garden_wildlife` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`present` integer NOT NULL,
	`since` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wildlife_unique` ON `garden_wildlife` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `computed_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`computed_at` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`sample_size` integer,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_key_unique` ON `computed_metrics` (`user_id`,`metric_key`);--> statement-breakpoint
CREATE TABLE `dismissed_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`dismissed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dismissed_unique` ON `dismissed_insights` (`user_id`,`card_id`);--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`cache_hit` integer DEFAULT false NOT NULL,
	`request_fingerprint` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_usage_time_idx` ON `llm_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `motivation_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`text` text NOT NULL,
	`sample_note` text,
	`created_at` text NOT NULL,
	`dismissed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_card_unique` ON `motivation_evidence` (`user_id`,`card_id`);--> statement-breakpoint
CREATE TABLE `weekly_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`facts` text NOT NULL,
	`narrative` text,
	`llm_model` text,
	`llm_cost_micros` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_reviews_unique` ON `weekly_reviews` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_time_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `provider_cursor_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`cursor_key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cursor_unique` ON `provider_cursor_state` (`user_id`,`provider`,`cursor_key`);--> statement-breakpoint
CREATE TABLE `schema_versions` (
	`component` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_run_id` text,
	`user_id` text,
	`provider` text,
	`operation` text,
	`category` text NOT NULL,
	`message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_errors_time_idx` ON `sync_errors` (`created_at`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`device_id` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`stats` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_kind_idx` ON `sync_runs` (`kind`,`started_at`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`received_at` text NOT NULL,
	`object_type` text,
	`object_id` text,
	`aspect` text,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE INDEX `webhook_status_idx` ON `webhook_events` (`status`,`received_at`);