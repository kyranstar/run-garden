-- 0035: plans with a purpose (design 2026-11-05, §3). programs gains purpose, brief, on_end (ask | continue | finish), paused_until and objective_ids (a JSON array of objective ids); coach_plans gains program_id, the programs row it is the coach's face of; planned_workouts gains course_session, the session number a course wrote that row as, which is what marks it as the course's own. Purely additive: seven nullable columns.
ALTER TABLE `programs` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `brief` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `on_end` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `paused_until` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `objective_ids` text;--> statement-breakpoint
ALTER TABLE `coach_plans` ADD `program_id` text;--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `course_session` integer;
