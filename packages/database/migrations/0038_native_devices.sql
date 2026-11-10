-- 0038: native device sign-in (docs: the LifeOS migration's SLICE-CONTRACT revision 2, §10.1 and §10.6). native_devices: one row per paired phone, keyed by the SHA-256 of its `rgd_` token (the token itself is never stored), with its account, its scope (`training-slice-v1`), the label the phone sent, its state (pending until the owner confirms it on the laptop, then active, or revoked), the 4-digit check number both screens show, when it was made, when it expires, when it was confirmed, when it was last used (written at most hourly), and when and why it was revoked. native_pairings: the account's one live pairing code (the user id is the key, so a new code replaces the old in one statement), stored as an HMAC under SESSION_SECRET, never in plain text, with its expiry, the wrong tries it has taken (5 burn it) and when it was used. Purely additive: two new tables and one index; nothing existing changes. Rolling the code back leaves both tables idle (they hold hashes only); dropping them is a migration of its own.
CREATE TABLE `native_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`label` text NOT NULL,
	`state` text NOT NULL,
	`check_number` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`confirmed_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE INDEX `native_devices_user_idx` ON `native_devices` (`user_id`);
--> statement-breakpoint
CREATE TABLE `native_pairings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code_hmac` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`used_at` text
);
