CREATE TABLE `garden_seen` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last_seen_date` text NOT NULL,
	`last_seen_seq` integer NOT NULL,
	`celebrated_species_ids` text NOT NULL,
	`updated_at` text NOT NULL
);
