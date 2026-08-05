CREATE TABLE `garden_visitors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `garden_visitors_unique` ON `garden_visitors` (`user_id`,`kind`);