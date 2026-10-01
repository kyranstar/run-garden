-- 0025: three nullable columns on planned_workouts for sessions the app builds
-- itself (one-workout-system spec §8.2). Every existing row reads NULL, and
-- NULL keeps today's meaning, so no backfill and no table rebuild.
--
-- `origin`: program | on_demand now; coros | coach | studio backfilled in
-- Phase 5. NULL = inferred from which table the row's plan_id lives in.
-- `content_state`: outline → built → started → done; NULL for rows whose
-- content is fixed (COROS, coach, Studio).
-- `session_params`: JSON — minutes, focus, location, mode, theme, equipment
-- exclusions, and the day's overrides and swaps.
ALTER TABLE `planned_workouts` ADD `origin` text;
--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `content_state` text;
--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `session_params` text;
