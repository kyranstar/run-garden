ALTER TABLE `coros_write_jobs` ADD `studio_push_id` text;--> statement-breakpoint
ALTER TABLE `coros_write_jobs` ADD `payload` text;--> statement-breakpoint
CREATE INDEX `write_jobs_studio_push_idx` ON `coros_write_jobs` (`studio_push_id`);--> statement-breakpoint
ALTER TABLE `studio_plan_pushes` ADD `coros_plan_id` text;--> statement-breakpoint
ALTER TABLE `studio_plan_pushes` ADD `session_fingerprint` text;