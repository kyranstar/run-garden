-- 0027: per-user exercise settings (one-workout-system spec §8.4, §5.5).
--
-- user_conditions and exercise_prefs are keyed by a single `id` — by
-- convention `<user_id>:<profile_id>` / `<user_id>:<exercise_id>`, the way
-- daily_health and garden_wildlife are — with a unique index on the pair,
-- rather than the spec's composite PRIMARY KEY: export paging, restore's
-- lost-row check and the copier's keyset all page and match on ONE primary-key
-- column (account-restore.ts refuses any other table), and a restore into
-- another account re-keys `<old user id>:` ids for free.
CREATE TABLE `user_conditions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`active` integer NOT NULL,
	`since` text NOT NULL,
	`settings` text NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_conditions_profile_unique` ON `user_conditions` (`user_id`,`profile_id`);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`equipment` text NOT NULL,
	`implements` text NOT NULL DEFAULT '{}',
	`is_default` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `locations_user_idx` ON `locations` (`user_id`);
--> statement-breakpoint
-- `rating` is +1 / -1 / NULL; `excluded` is "not for me".
CREATE TABLE `exercise_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`rating` integer,
	`excluded` integer NOT NULL DEFAULT 0,
	`pinned` integer NOT NULL DEFAULT 0,
	`introduced_on` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_prefs_exercise_unique` ON `exercise_prefs` (`user_id`,`exercise_id`);
--> statement-breakpoint
-- Private to the account (URLs and creators are never committed to the
-- library); `source_key` dedupes repeated imports of the same source.
CREATE TABLE `exercise_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`source_type` text NOT NULL,
	`url` text,
	`creator` text,
	`source_key` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_provenance_key_unique` ON `exercise_provenance` (`user_id`,`source_type`,`source_key`);
