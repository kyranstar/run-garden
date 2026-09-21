-- Selector ops (spec 2026-09-20 §2): a proposal's ops are expanded to
-- ordinary ops before they are stored, so the SELECTOR itself would otherwise
-- be lost. `selectors` keeps the intent behind a resolved list — "every
-- strength session, 22 Sep – 1 Nov" — so twelve move lines read as one
-- change on the card rather than twelve unrelated edits.
ALTER TABLE coach_proposals ADD COLUMN selectors TEXT;

-- The premise a structural proposal rests on (spec §6). 2026-09-19: the coach
-- inferred a race date from a three-word reply and built a bridge block on it;
-- the inference was invisible, so it could not be rejected without rejecting
-- the whole plan.
ALTER TABLE coach_proposals ADD COLUMN premise TEXT;
