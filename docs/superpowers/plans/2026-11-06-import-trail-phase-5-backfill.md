# Import Trail — Phase 5a (the backfill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal (spec §6.6):** a post imported before the trail shows an honest trail: its steps rebuilt from what was kept —
screening, the reading, links and their flags, batch, the owner's choices, provenance — each labelled "rebuilt from what
was kept; the raw replies weren't kept then", dated only by a time that was kept. Its trail offers **Read it again**: a
re-read under the current prompt, through the extension's work list, at a cost stated before the tap. Nothing is re-read
automatically, and a re-read never rewrites a move, a link or an approved correction.

**Architecture:** No production data write (the controller's ruling): the rebuild stays at read time
(`import-trail-read.ts`), widened to read the batch, the moves' owner state and their provenance in the same statements.
Read it again is an owner write like Watch it too (`saves-reread.ts`): the post goes back to `queued` keeping its reading,
`/work` hands it out, the extension reads it as it reads any `extract` work, and the relay's claim returns the post's
links and approved reading corrections. A pure `alignReading` lines the new reading up with the links (by name), puts
each found move at its link's position, re-applies the corrections, keeps saved insights, and appends new moves; if a
link's move isn't in the new reading, the earlier reading stays whole and the trail says so. `matchPost` leaves every
position that has a link alone (no new move, no new link) and matches only the appended moves.

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` §6.6 (binding), §2.3, §3.3, §3.4,
§10, §11, §14.4. Principles §7, §8, §9. Conventions: phase 1 and phase 3 plans.

## Global Constraints (verbatim from the phase 1/3 plans, as the brief restates them)

- Workers Free: ≤ 45 D1 statements per request, 10 ms CPU, ≤ 100 bound parameters per statement (pass id lists as one
  JSON parameter and `json_each` them), rows ≤ 2 MB.
- Untrusted text (posts, creators, transcripts, the reader, the owner) goes to a model marked, and is drawn as text.
- Public repo: synthetic `Zorbex …` names and made-up creators; links built at runtime; no literal links in tests, no
  example.com; no personal data.
- Never truncate a reasonable model call.
- Size, statement and CPU pins: re-measure by setting the pin low and reading the failure; pin with headroom and a dated
  `REBASED 2026-11-06 (phase 5 backfill): <why>` comment.
- Node v21 for vitest (`cd <pkg> && npx vitest run <file>`); typecheck `npx tsc -p <pkg> --noEmit`, exit code read. No
  `timeout` command.
- Never `git stash`, never `git add -A`, never push. Rebase alone, never piped; `git status` after.
- Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Copy: brisk, plain; never "proposal" in UI copy; 44 px targets, design tokens, both themes, phone width first;
  explanation one tap down (principles §7).

## Rulings (cost if wrong) — also in the ledger

1. **No production write; the rebuild stays at read time** (the controller's ruling). Cost: every read of an old post
   rebuilds (cheap, in the same statements).
2. **Read it again keeps everything the owner has**: links (any status), moves, corrections. A found move's new words go
   at its link's position; a correction to the reading is applied again on top; saved insights (in the coach's memory by
   index) are kept. Cost: a re-read's new insights on a saved post are on its raw reply only.
3. **All or nothing on alignment**: when a linked move isn't in the new reading (by name, alias, or close name), the
   earlier reading stays whole; the reply is on the trail. Cost: a post whose re-read renamed one move gets no new words
   for the others either (partial alignment deferred).
4. **No re-screen**: Read it again reads the moves only (extract-6); a filtered post keeps Import anyway as its way back
   in (shown beside its "Not training" line). Cost: a post screened out under filter-1 isn't re-screened under filter-2.
5. **Offered on an old post that is matched or failed, not being fitted, with no move waiting in a held or open batch.**
6. **Watch it too frees its post's link rows** (it deleted none and marked pending ones removed, so the watched reading's
   links collided with them on (post, position) and were dropped): found while building the re-read; fixed test-first.

## Tasks

- [ ] 1. The rebuilt trail carries what was kept (worker): provenance, screening, the reading (moves, dose words,
  stated/inferred), links and flags (check, like, merged, removed), batch and status, the owner's choices, saved — each
  `rebuilt`, dated by its kept time or none. Statement pin re-measured.
- [ ] 2. The rebuilt trail reads in words (ui): labels and values for every new key; a rebuilt section tagged; the
  per-step label; the coach line on a rebuilt post; the backfill caption one tap down; a filtered post's "Not training"
  line with Import anyway.
- [ ] 3. `hasOwnReading` counts only a stored reading (a failed or declined re-read keeps the rebuilt steps); the rebuilt
  extract-fail is never a copy of a stored failure.
- [ ] 4. Watch it too frees its post's link rows (RED: its watched reading's links are dropped).
- [ ] 5. `alignReading` (pure) — names, aliases, close names; corrections re-applied; insights kept; routine order and
  dropped remapped; all-or-nothing; ≤ 30 moves.
- [ ] 6. Read it again: the ask (`POST /api/my-saves/posts/:id/read-again`), its gate, its cost in words, its trail step;
  `/work` hands it out; `overridePost(process)` keeps a reading that has links.
- [ ] 7. The relay aligns a re-read before storing it; a declined one keeps the earlier reading; `matchPost` leaves linked
  positions alone, matches appended moves, and lets the post join the next batch. Corrections survive (the proof test).
- [ ] 8. The trail sheet: Read it again with its cost beside the rebuilt label; waiting for the extension once asked.
- [ ] 9. One fresh reviewer (opus) on the branch diff; fix Critical/Important RED→GREEN; minors ledgered.
- [ ] 10. Full suites (default TZ and UTC) for worker, ui, saves, saves-extension, database; tsc for all; fetch/rebase.
