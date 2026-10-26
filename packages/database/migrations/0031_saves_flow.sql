-- 0031: the saves flow redesigned (saved-posts import, 2026-10-26; spec §6, §12.4). save_batches.dismissed_at: when the owner dismissed the batch (NULL until then; a batch a later one replaced reads status 'superseded'). save_batches.fit_started_at: when the fit of the batch's moves began, so a fit that never finished can be told from one still running (NULL until a fit starts). personal_moves.fit_choice: the owner's per-move choice, 'include' or 'skip' (NULL = the coach's call). saved_post_moves.like_move_id: the near-duplicate move this link's move is like (NULL = none). Purely additive: four nullable text columns.
ALTER TABLE `save_batches` ADD `dismissed_at` text;
--> statement-breakpoint
ALTER TABLE `save_batches` ADD `fit_started_at` text;
--> statement-breakpoint
ALTER TABLE `personal_moves` ADD `fit_choice` text;
--> statement-breakpoint
ALTER TABLE `saved_post_moves` ADD `like_move_id` text;
