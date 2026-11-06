# Audit fixes — the coach's evidence, the review card, goal management (2026-11-06)

> **For agentic workers:** test-first, one item at a time: each item's test is watched failing before its fix. Steps use
> checkbox (`- [ ]`) syntax. Ledger: `.superpowers/sdd/2026-11-06-audit-fixes-evidence/progress.md` (rulings, costs,
> deferred minors).

**Goal:** what the end-of-programme audits found in the coach's evidence, the review card and goal management, fixed:
the coach can read a move's evidence after the card is approved and cite it when challenged; a challenge's answer leads
with the call and is never cut; a decided card keeps its review; the batch card's headline is the coach's own and the
trail's words say what was decided; the honesty rule and the reviewer agree on where-you-stand figures; the coach can
propose changes to objectives and key results, applied only on the athlete's Approve; a review line's `where` is what
Approve does.

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` §3, §6–§8, §14.1. Principles:
`docs/principles/workout-system-principles.md` §2.8, §2.9, §5.2, §6.2, §7. The Global Constraints of
`docs/superpowers/plans/2026-11-06-coach-review-phase-3.md` apply verbatim; re-pins say
`REBASED 2026-11-06 (audit fixes, evidence): <why>`.

**Not mine (parallel builders):** the extension, the import pipeline, import health, the Studio move page, the how-to and
trail sheets (`fix-import`); validate, draft checks, `adjust_plan`, `correct_import`'s field list, the old Studio routes
(`fix-safety`). `design-prompt.ts`: only the lines named here (the honesty rule, the challenge order, the tool list and
the diagnose lines for `propose_objective`).

## Items

### E1 — Evidence after Approve
- [ ] RED: `test/design-evidence-after-approve.test.ts` — a fitted batch; a later main run (no batch) calls
  `read_saves({ moveIds })`, gets the move's evidence (`q<n>.<k>` as the batch numbers it), and `correct_import` on the
  evidence (cite `q1.1`) is stored; `read_saves` with no batch still says none waiting. The pins brief (conversation
  block) and `read_proposals` carry the batch id and each line's move id and post; `get_exercise`'s saved links carry
  `postId` and `batchId`.
- [ ] GREEN: `read_saves` takes `moveId` / `moveIds`: the newest saved batch with a saved link to one of them, fitted or
  not, its page those moves (their `n` the batch's order) — same three statements, same receipt; a moves-read page
  never asks to close a fitted batch. `coach-conversation.ts` pins brief + `read-proposals.ts` pinsOf carry
  `batch <id>`, each line's `moveId` and `post`. `get_exercise` joins a link to its saved post move by id
  (`exercise_provenance.id` = `saved_post_moves.id` for an imported link): `postId`, `batchId`.

### E2 — Challenge answers cut
- [ ] RED: finish on a main run answering the athlete's words with a proposal keeps a 600-character line whole (≤
  `ANSWER_MAX`); a no-words run still clips at `LINE_MAX`. The conversation block keeps the newest turn's coach line to
  `ANSWER_MAX`. The prompt's challenge order leads with the call.
- [ ] GREEN: `finish.ts` reads the run's request in its one statement; `coach-conversation.ts` newest line `ANSWER_MAX`;
  `design-prompt.ts` challenge order (the call, their point fairly, the evidence). Re-measure size pins.

### E3 — Decided cards keep their review
- [ ] RED: `packages/ui/test/plan-card-closed.test.tsx` — a closed (older, decided) pins card with decisions shows In /
  Left out, its chips and Challenge once Show is tapped.
- [ ] GREEN: `plan-card.tsx` closed branch draws `ReviewLines` when the lines are a review.

### E4 — The headline and the trail's words
- [ ] RED: pin_moves with a batch stores the coach's `summary` as the headline (two sentences, ≤ 240) and the count as
  `count` ("In 5 · Left out 1"); without a summary the count is the line. The conversation card carries `count`; the UI
  draws it small under the headline. coach-trail summaries read "Coach: put in — <where> — <why>", "Coach: leave out —
  <why>", "You approved: leave out", "You approved: put in — <where>".
- [ ] GREEN: `pin-moves.ts`, `proposal-kinds.ts` (`count`), `coach-conversation.ts`, `design-manifest.ts`, api-client,
  `plan-card.tsx`; `coach-trail.ts` words (JS and SQL alike).

### E5 — Figures from where you stand
- [ ] RED: the honesty rule allows the opening message's computed blocks; the reviewer's packet carries the
  where-you-stand block when the designing run's opening held one.
- [ ] GREEN: `design-prompt.ts` line 162; `design-review.ts` `reviewPacket({ stand })`; `coach-runs.ts` passes the block
  from the run's opening message (no statement).

### E6 — Manage goals (`propose_objective`, op `objective_change`)
- [ ] RED: `test/design-propose-objective.test.ts` — each kind (retarget, redate, add a key result, retire an objective or
  a key result, add an objective) stored with before → after, its line and why; refused: not the athlete's, bad value,
  same value, no figure in a stand-based why, `basis: owner` without their words, too many. `test/design-approve-objectives.test.ts`
  — applied only on Approve, atomically, gated on the value read (stale → refused, nothing written), idempotent on a
  second approve; declined writes nothing; statement counts pinned; the card and conversation carry the line; a CPU
  bench shape.
- [ ] GREEN: `design-tools/propose-objective.ts` (new), `objective-changes.ts` (new: read, judge, words),
  `proposal-kinds.ts`, `design-approve.ts` (apply + decline + receipt), the op-kind lists (cover, orchestrate,
  coach-runs, design-context, conversation, read_proposals, manifest), api-client, `plan-card.tsx` (an objectives card),
  `design-prompt.ts` (tool list, one acting line, the diagnose line). No migration (op JSON; the op's outcome is the
  log, read back by read_proposals, the conversation and the approve receipt).

### E7 — The `where` field
- [ ] RED: a line's `where` is the tool's: a move in a revised workout of the suggestion reads its day, title and part;
  a pin "joins your rotation"; in rotation already "already in rotation"; out, none; a coach `where` is ignored.
- [ ] GREEN: `pin-moves.ts` (`whereOf`), `workoutPlacesOf`.

## Close
- [ ] One fresh opus reviewer on the branch diff; Critical and Important fixed RED → GREEN; Minor to the ledger.
- [ ] Full suites (worker, ui, saves, saves-extension, database) in the default TZ and `TZ=UTC`; tsc for every package.
- [ ] `git fetch`; rebase alone if origin/main moved; `git status` after.
