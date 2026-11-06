-- 0035: plans with a purpose (design 2026-11-05, §3). programs gains purpose, brief, on_end (ask | continue | finish), paused_until and objective_ids (a JSON array of objective ids); coach_plans gains program_id, the programs row it is the coach's face of. Purely additive: six nullable columns.
ALTER TABLE `programs` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `brief` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `on_end` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `paused_until` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `objective_ids` text;--> statement-breakpoint
ALTER TABLE `coach_plans` ADD `program_id` text;
