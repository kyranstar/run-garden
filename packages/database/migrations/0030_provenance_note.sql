-- 0030: a saved move's note on its link (saved-posts import, 2026-10-25; spec §17): what the post says the move is for, or when to do it — the extraction's purpose, written when the owner saves the batch. NULL for a curated link and every link written before. Purely additive: a nullable column.
ALTER TABLE `exercise_provenance` ADD `note` text;
