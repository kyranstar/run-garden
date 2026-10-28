-- 0033: planned_workouts.watch_off (the watch mirrors the plan, 2026-10-28). Set when the athlete keeps a workout off the watch: the mirror makes no copy until it is cleared. Purely additive: one integer column, default 0.
ALTER TABLE `planned_workouts` ADD `watch_off` integer DEFAULT 0 NOT NULL;
