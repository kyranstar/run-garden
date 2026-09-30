-- 0022: where an activity row came from. 'coros' for every existing row (the
-- DEFAULT backfills them); 'app' = recorded by the in-app player; 'import' =
-- history imported from another tool. The COROS ingest must never adopt an
-- 'import' row, and adopting an 'app' row is the deliberate watch+app merge.
ALTER TABLE `activities` ADD `source` text DEFAULT 'coros' NOT NULL;
