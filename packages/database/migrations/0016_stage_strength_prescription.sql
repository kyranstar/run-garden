-- The strength prescription gets somewhere to live (2026-08-17).
--
-- `buildStrengthProgram` writes a step's reps (`targetType: 3`), load
-- (`intensityType: 1`, grams), rest (`restType: 1`) and its disclosure prose
-- (`overview`, carrying "4s down" / "each side" / the coach's cue). `normalize.ts`
-- now reads all four back — and until these columns existed they stopped at the
-- database, which is why the athlete's Goblet Squat showed as a bare movement
-- name with no sets, no reps and no weight after a round trip through the watch.
--
-- `repeat_count` already held SETS (a repeat container's `sets` is the one
-- strength number that always survived). These are the rest of the prescription.
--
-- All nullable: every existing row predates the reader, and NULL is the honest
-- "this was never read back" rather than a fabricated zero. `load_bodyweight` is
-- deliberately separate from `load_kg` — COROS encodes bodyweight as
-- `intensityCustom: 1` with no value, and renders an explicit 0 kg as "0.00 kg",
-- so the two cannot share one nullable number.
ALTER TABLE `planned_workout_stages` ADD COLUMN `reps` integer;
ALTER TABLE `planned_workout_stages` ADD COLUMN `load_kg` real;
ALTER TABLE `planned_workout_stages` ADD COLUMN `load_bodyweight` integer;
ALTER TABLE `planned_workout_stages` ADD COLUMN `rest_seconds` integer;
ALTER TABLE `planned_workout_stages` ADD COLUMN `note` text;
