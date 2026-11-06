# Audit fixes — safety (2026-11-06) Plan

> Branch `fix-safety`, from origin/main `b7a5fed9`. Built test-first: each finding gets a failing test, then the fix; a
> finding no test can fail is a `Ruling:` instead. Ledger: `.superpowers/sdd/2026-11-06-audit-fixes-safety/progress.md`.

**Goal:** close the end-of-programme audits' safety findings: the owner's two hard checks (a condition's "never",
loading an area they called sore) hold in code whatever the athlete insists; imported and free-text jumps meet the
condition gates; a plan change shows its running load beside Approve; the old Plan Studio can't put an AI plan on the
watch.

**Binding:** principles §2.7, §2.8, §2.9, §6.1, §11; spec 2026-11-05 §8 and §15 Q1 (insistence never overrides a
condition's never or loading a sore area); `docs/TESTING.md`; the Global Constraints of
`2026-11-06-coach-review-phase-3.md`, verbatim. Re-pins say `REBASED 2026-11-06 (audit fixes, safety): <why>`.

**Shared files:** `design-prompt.ts` is touched only on its sore-area, record_answer, first-exposure, run-load and
designer lines (fix-evidence owns the challenge-answer lines); size pins are re-measured at merge.

## Tasks

- [x] **S1 — a sore area is a hard check.** `draft-checks.ts`: a working move (the check's own "work": a working part ×
  `isWorkingMove`) that loads an area called sore today is an error (`sore_area_loaded`, fatal at validate, propose and
  amend), its fix with no "kept on purpose"; gentle work (warm-up, activation, care, cool-down parts; mobility,
  breathing and release moves) stays allowed. The reviewer's packet and rubric stop calling it "must-fix unless
  explained". The prompt: `record_answer` is a safety step — a sore area named in the request is recorded first; the
  designer's block carries the same rule. Tests: `design-hard-checks.test.ts` (the `valid: true` expectation flips).
- [x] **S5 — the first-exposure cap is a cost when the athlete insists.** Prompt progression line and the reviewer's
  progression question; the reviewer's role and packet name the only two absolute checks. Tests: the packet's line,
  the rubric text, `parseReview` keeping an accepted progression out of must-fix, and the finish guard letting it pass.
- [x] **S2 — imported jumps meet the gates.** `@rg/exercise-library` `plyometricWord(name, text?)` (hop, jump, bound,
  pogo, skip, depth, landing, leap, plyo, burpee; negations taken back). `buildPersonalRecord`: a reading whose words
  say jump and whose contraction doesn't is stored plyometric, with a repair line (the trail's check stage shows it).
  `correct_import`: a move's `contraction`, `conditions` (ratings, merged per profile), `regions`, `patterns`, and
  `retire` (archives a non-move) — the same atomic, gated application. Tests: personal-records, correct-import,
  approve-corrections.
- [x] **S3 — free-text items are judged.** `@rg/workout` `validateWorkoutDoc`: a free item named as a library or
  personal move (loose spelling) meets that move's condition rules; otherwise one whose name sounds like a jump is
  refused on a Recover day, and wherever a profile's gate keeps a jump out (a flare day, feeling off, a day ahead it
  could close). Tests: `validate.test.ts`.
- [x] **S4 — adjust_plan carries its load.** `@rg/workout` `runLoadNotes` (validate's own rules, extracted:
  `run_hard_close`, `run_long_share`, `run_volume_jump`); `adjust_plan` reads the session's day's running in its one
  athlete statement (no statement more) and attaches each breach as an issue beside Approve, for a move, a length or a
  restore. Pins: statement count held at 2; a CPU bench shape for a moved run.
- [x] **S6 — the old Plan Studio is unmounted.** Prove no client calls them; unmount `POST /api/studio/generate`,
  `/edit`, `/push`, `/push/retry`, `/adoption/:pushId/undo` (it re-pushes), and the old screens' reads `GET /`,
  `/history` (no client calls them either); keep `/plans/:id/retire` (the Plan modal's Retire) and
  `/plans/:id/repair-exercise-ids` (never touches COROS); remove the dead api-client functions. Ruling lists them.
- [x] Review: one fresh opus reviewer on the diff (safety regressions, over-blocking) — 0 Critical, 6 Important fixed RED→GREEN (I1 loaded work in a gentle part, I2 propose_plan, I3 tomorrow vs the day after, I4 a 0/1 answer, I5 false jumps, I6 stored jump-named moves), Minors M5, M6, M10 fixed, the rest deferred in the ledger.
- [ ] Suites in the default TZ and `TZ=UTC`; tsc for all; fetch and rebase.

## As built (rulings in the ledger)

- S1's line, after review: a sore area is loaded by a working move or any weighted move in a working part above Recover;
  in a gentle context (warm-up, activation, care, cool-down, or a Recover document) only by a weight or a jump; an
  item's alternates count; refused today and tomorrow, the day after a note; an answer of 0 or 1 is no soreness;
  propose_plan's sessions today and tomorrow are held to it too.
- S2, after review: a stored move whose name says it jumps is read as a jump wherever the account library is read (no
  backfill); correct_import won't take its plyometric away (`still_a_jump`), nor on evidence alone from one whose words
  say jump (`owner_only`); doc-build-8.
