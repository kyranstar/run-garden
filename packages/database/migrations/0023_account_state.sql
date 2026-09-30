-- 0023: per-account bookkeeping that is never exported or restored (audit 1
-- data findings 1-8, rulings B2/B4/B6).
--
-- `restore_id` IS the restore marker: set by restore begin, cleared by finish
-- or "Start fresh". While it is set every writer (crons, garden, COROS,
-- calendar, cloud jobs, coach reads and wakes, backfill) skips the account.
-- `restore_expected` holds the per-table row counts the checked pages
-- promised, so finish can say which table came back short.
-- `calendar_reconcile` is the one-shot post-restore calendar reconcile.
-- `garden_catch_up_pending`: a restored garden still catching up from the
-- file's last simulated day — forward only, capped per invocation, nothing
-- deleted (ruling B4 amended).
CREATE TABLE `account_state` (
  `user_id` text PRIMARY KEY NOT NULL,
  `restore_id` text,
  `restore_started_at` text,
  `restore_file_exported_at` text,
  `restore_file_exported_from` text,
  `restore_expected` text,
  `restore_finished_at` text,
  `calendar_reconcile` text,
  `garden_catch_up_pending` integer DEFAULT false NOT NULL,
  `updated_at` text NOT NULL
);
