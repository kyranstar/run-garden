-- Manifest redesign: what the plan held BEFORE an approved proposal applied,
-- snapshotted at apply time — settled cards were recomputing "before" from
-- the post-apply plan, rendering X → X.
ALTER TABLE coach_proposals ADD COLUMN applied_refs TEXT;
