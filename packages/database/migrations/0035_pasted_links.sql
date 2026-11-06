-- 0035: pasted links (design 2026-11-05 §3.1, §5.1, §15.2). saved_links: a YouTube video or an Instagram post pasted in the extension's popup or the app's field, waiting for the computer's extension to read it — its id is the post's id-to-be (the same hash of account, source and key), so a link meets its post by id once read. saved_posts gains video_info (a video's chapters, which captions it had, whether it was live, the transcript's length and whether it was cut — the transcript itself is a blob) and watch_video (the owner asked for the video to be watched too). Purely additive: one new table and two nullable columns.
CREATE TABLE `saved_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`url` text NOT NULL,
	`added_from` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`error` text,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_links_source_unique` ON `saved_links` (`user_id`, `source`, `source_key`);
--> statement-breakpoint
CREATE INDEX `saved_links_added_idx` ON `saved_links` (`user_id`, `added_at`);
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `video_info` text;
--> statement-breakpoint
ALTER TABLE `saved_posts` ADD `watch_video` integer;
