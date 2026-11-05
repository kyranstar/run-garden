-- 0034: the import trail (design 2026-11-05, §6.1). import_events: one row per thing a stage of a saved or pasted post did — what it took in, decided and gave out — written by that stage in the same batch as its state change. import_blobs: the large pieces an event points to (a model's raw reply, the prompt as sent, a transcript). prompt_versions: each prompt version's system text, written once on first use. import_corrections: every change to imported data (a move's field, a match, an insight), with before, after, why and basis. saved_posts gains origin (saved | pasted), title, duration_sec and video_seen. Purely additive: four new tables and four nullable columns.
CREATE TABLE `import_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`batch_id` text,
	`move_id` text,
	`stage` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`usage_id` text,
	`model` text,
	`prompt_version` text,
	`cost_micros` integer,
	`latency_ms` integer,
	`attempt` integer,
	`run_id` text,
	`proposal_id` text,
	`rebuilt` integer NOT NULL DEFAULT 0,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_events_post_idx` ON `import_events` (`user_id`, `post_id`, `at`);
--> statement-breakpoint
CREATE INDEX `import_events_stage_idx` ON `import_events` (`user_id`, `stage`, `at`);
--> statement-breakpoint
CREATE TABLE `import_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`event_id` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`cut` integer NOT NULL DEFAULT 0,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_blobs_post_idx` ON `import_blobs` (`user_id`, `post_id`);
--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`system_text` text NOT NULL,
	`first_used_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target` text NOT NULL,
	`target_id` text NOT NULL,
	`field` text NOT NULL,
	`before` text,
	`after` text,
	`why` text NOT NULL,
	`basis` text NOT NULL,
	`evidence` text,
	`by` text NOT NULL,
	`proposal_id` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_corrections_target_idx` ON `import_corrections` (`user_id`, `target`, `target_id`);
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `origin` text;
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `title` text;
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `duration_sec` integer;
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `video_seen` integer;
