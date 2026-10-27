-- 0032: planned_workouts.watch_copy_name (workout editability, 2026-10-27). The program name the watch holds a copy of this row under when the app did not push that copy (set when a coach or watch-plan session is adopted into a Studio document; cleared when the copy is gone). Purely additive: one nullable text column.
ALTER TABLE `planned_workouts` ADD `watch_copy_name` text;
