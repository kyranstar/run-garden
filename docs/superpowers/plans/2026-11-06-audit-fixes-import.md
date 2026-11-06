# Audit fixes — the import side (2026-11-06)

> Branch `fix-import` (from `b7a5fed9`). Test-first: each item gets a test watched failing, then the fix. A finding that
> no test can make fail gets a `Ruling:` and is skipped. Ledger: `.superpowers/sdd/2026-11-06-audit-fixes-import/progress.md`.

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` §3, §4, §5, §6.5, §9.
**Global constraints:** phase 2's (`2026-11-06-import-trail-phase-2.md`), verbatim, plus: re-pin any count with
`REBASED 2026-11-06 (audit fixes, import): <why>`; extension 0.3.0 → 0.3.1; no `example.com` in the extension's tests.

**Parallel builders:** `fix-evidence` (read_saves, pin_moves, read_proposals, get_exercise, review card, coach-trail
summaries, objectives) and `fix-safety` (validate, draft checks, adjust_plan, correct_import's fields, old Studio
routes); phase 5 (`import-trail-read.ts` rebuilt steps, `trail-model.ts` old-post trail / "Not training" / Read it
again). Touch those only in small, localized lines.

## Tasks

- [x] **I1 — the extension token.** `status.ts`: a missing token heads "Add the app's token in Options", a refused one
  "The app refused the token — paste it in Options", both with Options. `links.ts` `addPastedLink` (pulled out of
  `background.ts` so it is tested): a 401 is refused, never queued as added. `options.ts`: Save tests the token on
  `GET /api/saves/links` (one statement and the guard's two) and says plainly whether it worked.
  Tests: `status.test.ts`, `links.test.ts`, `app-client.test.ts`, `options.test.ts` (new, jsdom).
- [x] **I12 — unbroken URL titles.** `popup.css` `.row .line > *` and Settings' link title wrap anywhere.
  Tests: a CSS rule test (popup), the Settings row's class (ui).
- [x] **I3 — YouTube failures before a post.** Health titles an `ext:` failure from its link (`saved_links.url`, joined
  in the one health statement) and carries the link for Retry; the row's and the popup's Retry re-add the link. New
  code `youtube_login` ("Sign in to YouTube in Chrome"), stage-wide (red), and the link run stops on it like Instagram's
  login. Tests: `import-health*.test.ts`, `youtube.test.ts`, `links.test.ts`, `health-row.test.tsx`, `status.test.ts`.
- [x] **I4 — several links pasted.** `normalizeLinks(text)` → every link the app takes, up to 5, with what was left and
  why ("took 2 of 3 — …"); playlists and channels: "Single videos and posts only — not playlists or channels."
  Popup and Settings add each. Tests: `packages/saves/test/links.test.ts`, `popup.test.ts`, `settings-saves.test.tsx`.
- [x] **I7 — the creator rule.** A pasted post skips the creator rule and is screened by the model.
  Test: `saves-filter*.test.ts`.
- [x] **I8 — the reader's quality.** The check step is `warn` when a quote isn't in the post or a move's reading is
  low-confidence, its line says which; the Reader light reads the check stage. Tests: `saves-match*.test.ts`,
  `import-health*.test.ts`.
- [x] **I9 — honest dose and evidence.** `doseWithOrigin`: `evidence.dose === "inferred"` → `"reader's guess"`; the
  trail's label, read_saves' `from`, and the move sheet ("The reader's guess: …"). An `on_screen`-only quote leaves its
  field inferred (`quotes.ts`, `saves-evidence.ts` one line). Tests: `personal-records.test.ts`, `quotes.test.ts`,
  `saves-evidence` test, `trail-model.test.ts`, `studio-saves.test.tsx`.
- [x] **I2 — health where the owner looks.** A coach-header chip (worst light, its word) while a light is red or yellow,
  opening the health row in a sheet; Settings' line shows yellow too. A fit's main run that ends failed, stopped or
  expired (or finished) without proposing writes a failed coach step on each of its batch's posts (zero statements on
  the paper path that proposes). Tests: `coach-health-chip` (ui), `settings-saves.test.tsx`, a coach-runs test.
- [x] **I6 — links behind an open batch.** The coach's saves card lists the recent pasted links (their words) and
  "N more waiting for the next batch" (`LinkDto.batchId`, same one statement). Test: `coach-saves-live` or a new ui test.
- [x] **I5 — a link in the coach.** A composer message that is only links goes to `POST /api/my-saves/links` (each),
  and their answers show in the conversation; no model run. Test: a ui live test.
- [x] **I10 — from a move back to its post.** `postId`/`position` on `PersonalMoveDto.links` and
  `LibraryItemDto.provenance` (from `exercise_provenance.source_key` `imp:<key>#<position>`); "How it came in" on the
  Studio move's SavedFrom and the how-to sheet (with the creator); the move's corrections one tap down.
  Tests: library-view worker test, `studio-detail.test.tsx`, a how-to test.
- [x] **I11 — the video at the quote.** A heard or said quote with a time on a YouTube post: "Open the video at m:ss",
  built from the post's link through `normalizeLink`. Test: `trail-model.test.ts`, trail sheet test.

## Finish

One fresh opus reviewer on the branch diff; Critical/Important fixed RED→GREEN; Minor deferred in the ledger. Full suites
(worker, ui, saves, saves-extension, database) in local time and `TZ=UTC`; `tsc` for each. Fetch, rebase if main moved.
