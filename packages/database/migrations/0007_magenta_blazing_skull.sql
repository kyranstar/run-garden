-- Strava removal. Data first, then schema.
--
-- Activities whose only source was Strava are deliberately KEPT: they are real
-- sessions, and after this migration they simply become source-less rows that
-- still count toward the garden, streaks, and records. An incoming COROS
-- activity within ±1h adopts them (completion.ts, ORPHAN_ADOPTION_FLOOR), so
-- the backfill reunites what it can whenever it runs — before or after this.
--
-- To see what remains source-less afterwards:
--   SELECT a.id, a.start_time, a.sport, a.duration_seconds, a.distance_meters, a.title
--   FROM activities a
--   LEFT JOIN activity_source_links l
--     ON l.activity_id = a.id AND l.provider = 'coros'
--   WHERE l.id IS NULL ORDER BY a.start_time;

-- `provisionally_completed` meant "matched from Strava, richer COROS record
-- awaited". With one provider it is unreachable, and the wait is over.
UPDATE `planned_workouts` SET `completion_state` = 'completed' WHERE `completion_state` = 'provisionally_completed';--> statement-breakpoint
DELETE FROM `activity_source_links` WHERE `provider` = 'strava';--> statement-breakpoint
DELETE FROM `provider_connections` WHERE `provider` = 'strava';--> statement-breakpoint

-- Schema. The index must go before the column it references — SQLite/D1 will
-- not drop a column an index still points at.
DROP TABLE `webhook_events`;--> statement-breakpoint
DROP INDEX `activities_strava_unique`;--> statement-breakpoint
ALTER TABLE `activities` DROP COLUMN `strava_activity_id`;--> statement-breakpoint
ALTER TABLE `activities` DROP COLUMN `summary_polyline`;--> statement-breakpoint
ALTER TABLE `workout_completion_matches` DROP COLUMN `provisional`;
