-- 0039: pairing rate controls (native device sign-in, kit v0.5). native_pair_limits: fixed-window attempt counters, one row per key — `redeem:global`, `redeem:ip:<sha-256 of the client address>` (never the address itself) and `mint:<user id>` — with the window's start, its count, when its cool-off ends (null when none) and when the row may be purged. native_devices gains check_tries: wrong check numbers sent to Confirm, counted in the same statement that decides it; the bound revokes the pending phone. Purely additive: one new table and one integer column with a default; nothing existing changes. Rolling the code back leaves both idle; dropping them is a migration of its own.
CREATE TABLE `native_pair_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`blocked_until` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `native_devices` ADD `check_tries` integer DEFAULT 0 NOT NULL;
