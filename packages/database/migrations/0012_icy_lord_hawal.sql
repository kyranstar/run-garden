ALTER TABLE `activities` ADD `telemetry` text;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `avg_cadence_spm` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `min_heart_rate` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `max_heart_rate` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `elev_gain_meters` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `avg_grade_percent` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `avg_power_watts` real;--> statement-breakpoint
ALTER TABLE `activity_laps` ADD `exercise_name_key` text;