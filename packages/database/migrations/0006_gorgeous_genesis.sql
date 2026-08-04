CREATE TABLE `backfill_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`earliest_date_reached` text,
	`chunks_completed` integer DEFAULT 0 NOT NULL,
	`activities_ingested` integer DEFAULT 0 NOT NULL,
	`consecutive_empty_chunks` integer DEFAULT 0 NOT NULL,
	`skipped_sport_types` text,
	`started_at` text,
	`finished_at` text,
	`last_error_category` text,
	`updated_at` text NOT NULL
);
