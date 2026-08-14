-- Race hub (2026-08-14): daily snapshots of COROS's fitness physiology.
-- Like recovery_score these are "now" values COROS never backfills — the
-- worker stamps them onto the current day on every pull and history
-- accumulates forward from ship day.
ALTER TABLE `daily_health` ADD COLUMN `stamina_level` real;
ALTER TABLE `daily_health` ADD COLUMN `threshold_pace_sec_per_km` real;
ALTER TABLE `daily_health` ADD COLUMN `threshold_hr` real;
