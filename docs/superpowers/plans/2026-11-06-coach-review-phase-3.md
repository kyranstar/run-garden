# Import Trail — Phase 3 (the coach's review, challenge and corrections) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coach's fit-in card becomes a review the owner can trust: every line says in or out, where, at what dose
and why, with chips that open the evidence on the post's trail; the coach reads each claim's evidence (stated or
inferred, quotes with their checks, dose origin, match, corrections, use-when / skip-when / why, scoped insights),
argues from it, takes a challenge like a coach, proposes corrections that are logged when approved, and every decision
is written to each post's trail; the reviewer checks a revised workout's saved moves against their evidence.

**Architecture:** A pure module (`saves-evidence.ts`) turns a post's stored reading into the coach's evidence words and
stable quote ids (`q<move>.<k>`). `read_saves` reads the page's evidence in one more statement and leaves a receipt in
its trail event; `pin_moves` and the new `correct_import` read those receipts (no extra statement) to refuse uncited
claims and unread moves and to resolve cites into chips. Corrections are a new designed op kind (`import_correction`),
applied at Approve in one atomic batch per correction (state change last, gated, with its `import_corrections` row and
trail event). The coach's decisions reach the trail by set-based inserts riding the writes that already happen: the
supersede at promotion, the pins apply, the decline. The UI renders the stored lines; the trail sheet opens at a quote.

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free) with D1/drizzle; zod; React 18 + TanStack Query; Vitest
(jsdom for UI).

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` — binding §8 (8.1–8.5), §3.3–3.5,
§2, §10, §14, §15 (Q1's default); consumed §5.5–5.6 (phase 2) and §7.4 (phase 4). Principles:
`docs/principles/workout-system-principles.md` (§2.8–2.9, §6.1–6.5, §7). Earlier plans for conventions:
`2026-11-05-import-trail-phase-1.md`, `2026-11-06-import-trail-phase-2.md`. (The brief names `AGENTS.md`: this repo has
none — the rules are this plan's Global Constraints, the principles and `docs/TESTING.md`.)

## Global Constraints

- Workers Free: ≤ 45 D1 statements + fetches a request, 10 ms CPU. Every tool, route and step whose count changes is
  re-pinned with `REBASED 2026-11-06 (coach review, phase 3): <why>`; `design-cpu-bench`'s shapes stay under budget.
- D1: ≤ 100 bound parameters a statement (pass id lists as one JSON parameter and `json_each` it); a row ≤ 2 MB.
- The trail pattern: a stage's events are written in the same `runAtomically` batch as its state change; with
  `runAtomicallyClaim` the claim (`… returning`) is the last statement and the others are gated on the same condition.
- Size pins (`design-prompt`, `design-fix13-prompt`, `design-orchestrate`, `coach-shape-pins`, role blocks): re-measure
  by setting the pin low, reading the failure, then pinning with ≥ 100 tokens of headroom and a dated REBASED comment
  saying what grew.
- Untrusted text: everything a post, a creator, a transcript, the reader or the owner wrote reaches a model marked —
  `{ text, untrusted: true }` (`untrusted()` in read-common) in tool results, `markUntrusted(from, text)` in prose — and
  is drawn as text in the UI.
- Public repo: synthetic `Zorbex …` names, made-up creators, links built as the existing fixtures build them (no
  literal link in a test; example.com is not allowed); no personal data anywhere.
- Copy: brisk, plain, specific; never "proposal" in UI copy ("suggestion"); explanation one tap down; 44 px targets,
  design tokens, both themes, phone width first.
- Caps: `PINS_MAX` = `PINS_LINES_MAX` = 30 (kept); a proposal holds at most `CORRECTIONS_MAX` = 10 corrections.
- Never truncate a reasonable model call (no output caps change here).
- Node v21; `pnpm --filter @rg/<pkg> exec vitest run <file>`; typecheck `npx tsc -p <pkg> --noEmit` (exit code read,
  never under `timeout`). Never `git stash`, never `git add -A`, never push. Trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No migration (`import_corrections` exists from 0034; ops are JSON): `SCHEMA_VERSION` stays `0035`.

## Rulings (my calls; cost if wrong)

1. **Quote ids are `q<n>.<k>`**: `n` the move's 1-based place in the batch's one order, `k` its quote's place across
   the move's links in post order — stable across pages of a batch, so a cite from page 1 still resolves after page 2.
   (Cost: the spec's "q1, q2" reads slightly differently; nothing breaks.)
2. **The read leaves a receipt, not a write**: read tools never write (their tests assert it), so "when it read the
   post" is the read event's own time from the run's trail, written to the post's trail when the card is shown
   (promotion). (Cost: a run that read and never suggested leaves no "read" row on the post.)
3. **The tool computes a line's dose** (the move's record, the revised item's, or a pending dose correction's); a dose
   the coach writes that names other numbers is refused `dose_mismatch`. (Cost: a coach dose in words with the same
   numbers but another meaning passes — rare.)
4. **Faithfulness is scored only when the draft holds a saved move** (a `my…` id): optional otherwise, so a review of a
   library-only workout shows no empty line. (Cost: none; the rubric's other dimensions are unchanged.)
5. **Insistence never overrides** a condition's "never" or loading a sore area (§15 Q1's default, said in the prompt;
   both are already code at the tools).
6. **A "same as X" link correction** archives the duplicate (`merged`, `merged_into` X) only when it has no logged
   sets, no planned workout from today on that names it, no pin and no other saved link; else the link is marked
   `like` X. **"Not the same"** on a library-linked link makes the personal move from the post's reading, active on
   approval, never pinned by the same card (the card can't name a move that doesn't exist yet). (Cost: the owner pins it
   in a second tap.)

## Review Focus

1. **A pins card from before this phase** (plain-string lines, or `{moveId, name, text}` with no decision or cites):
   the card, the conversation block, read_proposals and the trail read it without throwing — no chips, no group
   heading it can't fill (Task 9 test "an old card reads as before").
2. **A line that quotes a heard (in_speech) passage** says "in the video she says…": allowed with its cite, and its chip
   reads ⟨heard 0:12⟩, never ⟨said⟩ (Task 3 test "a heard quote is never said").
3. **A correction approved after the record changed** (the owner edited the dose meanwhile): refused `stale`, nothing
   written, the card says it changed since; one approved twice (a double tap, a crash after the write) is recorded
   applied with no second write (Task 5 tests).
4. **A batch of 30 moves read over several pages**: cites from every page resolve; a line about a move on a page never
   read is refused naming it (Task 3 test "two pages, one unread").
5. **A challenge on a phone**: Challenge fills the box with "About <name>: ", focuses it and keeps the card in view; a
   chip opens the post's trail at the quote, its row marked, at 360 px with no sideways scroll (Task 10 tests).

---

## File structure

| File | Responsibility |
|---|---|
| `apps/worker/src/services/saves-evidence.ts` (new) | pure: quote ids, check words, a reading's evidence for the coach, cite refs and chip labels, claim words, dose numbers |
| `apps/worker/src/services/design-tools/read-saves.ts` | the page's evidence (one statement more), scoped insights, post refs, the receipt |
| `apps/worker/src/services/saves-batches.ts` | `insightsJsonSql(…, { scoped })` with scope, quote and place |
| `apps/worker/src/services/design-tools/pin-moves.ts` | lines `{moveId, decision, where, dose, text, cites}`, the refusals, `read` times |
| `apps/worker/src/services/design-tools/saves-reads.ts` (new) | `savesReadsSql` / `savesReadsOf`: the run's read_saves receipts, read inside another tool's statement |
| `apps/worker/src/services/proposal-kinds.ts` | `PinsCardLine` fields, `CiteRef`, `ImportCorrectionOp`, `isImportCorrectionOp`, designed-op lists |
| `apps/worker/src/services/design-tools/correct-import.ts` (new) | the `correct_import` tool: before read, validation, stored op |
| `apps/worker/src/services/import-corrections.ts` (new) | targets' read/apply statements, the correction words, `applyCorrections` |
| `apps/worker/src/services/coach-trail.ts` (new) | the coach's decision events: suggested, read, approved, declined, superseded, corrected |
| `apps/worker/src/services/design-approve.ts`, `design-orchestrate.ts`, `design-cover.ts`, `coach-runs.ts`, `design-context.ts` | corrections applied/declined/superseded; trail rows; the designed-op kind lists |
| `apps/worker/src/services/design-prompt.ts`, `design-review.ts` | the prompt rules; faithfulness dimension, packet, optional parse |
| `apps/worker/src/services/coach-conversation.ts`, `design-tools/read-proposals.ts`, `design-manifest.ts` | lines and why carried into later turns; the read's corrections part |
| `packages/saves/src/schemas.ts` | insight gains optional `move` (a correction's "attach to a move") |
| `packages/api-client/src/index.ts` | DTOs: cites, line fields, corrections |
| `packages/ui/src/screens/studio/plan-card.tsx`, `review-lines.tsx` (new), `coach-reply.ts` (new), `coach-conversation.tsx`, `coach-tolerance.ts` | the review card, chips, Challenge |
| `packages/ui/src/screens/saves/trail-sheet.tsx`, `trail-model.ts` | open at a quote; coach and correction lines |

---

### Task 1: The evidence words (pure)

**Files:** Create `apps/worker/src/services/saves-evidence.ts`; Test `apps/worker/test/saves-evidence.test.ts`.

**Interfaces — Produces:**
- `quoteId(moveNo: number, k: number): string` → `"q3.2"`; `QUOTE_ID_RE = /^q\d{1,3}\.\d{1,3}$/`.
- `type CheckWord = "said" | "in the caption" | "heard" | "on screen" | "not in the post"`;
  `checkWord(check: QuoteCheck | undefined, from: string): CheckWord` — verified from `caption` → "in the caption",
  verified otherwise → "said", `in_speech` → "heard", `on_screen` → "on screen", `not_found`/none → "not in the post".
- `clockOf(sec: number): string` → `"1:12"`, `"1:02:05"`.
- `interface QuoteRef { postId: string; position: number; quote: number; check: QuoteCheck | null; from: string; at: number | null }`.
- `readingEvidence(move: unknown, o: { moveNo: number; firstK: number; postId: string; position: number }): { evidence: ReadingEvidence; refs: Array<[string, QuoteRef]> } | null`
  where `ReadingEvidence = { confidence: string | null; stated: string[]; inferred: string[]; dose: Untrusted | null; why?: Untrusted; useWhen?: Case[]; skipWhen?: Case[]; quotes: EvidenceQuote[] }`,
  `Case = { text: Untrusted; said: boolean }`, `EvidenceQuote = { id; field; text: Untrusted; check: CheckWord; at?: string }`
  (a field whose quotes were all `not_found` is listed in `inferred`, as §5.6 says).
- `type CiteRef = { id: string; kind: "quote"; label: string; postId: string; position: number; quote: number } | { id: "history"; kind: "history"; label: "your history" } | { id: string; kind: "goal"; label: "your goal"; goalId: string } | { id: string; kind: "inferred"; label: "reader's guess"; field: string; postId?: string; position?: number }`;
  `quoteLabel(ref: QuoteRef): string` → `"said 1:12"`, `"in the caption"`, `"heard 0:12"`, `"on screen"`, `"not in the post"`.
- `INFERRED_FIELDS = ["name","dose","steps","purpose","useWhen","skipWhen","why"]`; `parseCite(id): {kind, …} | null`.
- `claimsThePost(text: string): boolean` — true for "she says", "he said", "they recommend", "the creator …",
  "the post says/recommends/suggests", "the caption says", "the video shows", "according to", "in the video she says".
- `doseNumbers(text: string): number[]` — every number in order (`"2×6 per side"` → `[2,6]`, `"8–12 reps"` → `[8,12]`).

- [ ] **Step 1: failing tests** — each function's table above; `readingEvidence` on an extract-6 move with three
  quotes (caption verified, transcript verified `at: 72`, speech `in_speech`) and one `not_found` dose quote gives ids
  `q2.4…q2.7` from `firstK: 4`, chips "in the caption", "said 1:12", "heard", "not in the post", `inferred` holding
  `dose`, every text `{ untrusted: true }`; a pre-extract-6 move (no quotes, no useWhen) gives `quotes: []` and its
  stated/inferred from `evidence`; garbage (`null`, `{}`) gives null.
- [ ] **Step 2:** run `pnpm --filter @rg/worker exec vitest run test/saves-evidence.test.ts` — FAIL (no module).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun — PASS.
- [ ] **Step 5:** commit `feat(coach): the evidence words — quote ids, checks and chips for a saved move`.

### Task 2: read_saves gives the coach the evidence (§8.1)

**Files:** Modify `apps/worker/src/services/design-tools/read-saves.ts`, `apps/worker/src/services/saves-batches.ts`
(`insightsJsonSql` option), `apps/worker/test/design-cpu-bench.test.ts` (shape), `apps/worker/test/design-read-budget.test.ts`
(pin, if it lists read_saves); Test `apps/worker/test/design-read-saves.test.ts`, `apps/worker/test/saves-batch-fixture.ts`.

**Interfaces — Consumes:** Task 1. **Produces:**
- each listed move gains `n` (its place in the batch), `dose: { record: string; from: "post" | "reading" | "default" | "library" | "edited" | "an earlier post" }`,
  `corrections: Array<{ field, after: Untrusted, why: Untrusted, by: "coach" | "owner", basis, at }>` (≤ 3, newest),
  and each link gains `post` (the post id), `at` (the move's position in it), `match: { as: "new" | "yours" | "library"; by: "name" | "judge" | "new"; confidence: string | null; check: boolean }`,
  `reading: ReadingEvidence | null`;
- `insights: Array<{ ref: "<postId>:<index>"; text: Untrusted; scope: InsightScope; quote?: Untrusted; post: string }>` —
  every scope, each keeping its post (`insightsJsonSql(userId, keptPosts, max, { scoped: true })`; the opening context's
  call is unchanged: general only);
- `receipt: { saves: { batch: string; moves: Array<[moveId, postId, position]>; quotes: Record<string, [postId, position, quote, check, from, at]> } }` (never shown to the model);
- `statementCost: 3` (the athlete, the batch, the page's evidence: each link's reading slice
  `json_extract(extraction, '$.moves[<pos>]')`, its post's latest match event's entry for that position, the page's
  moves' corrections and `edited_by_owner` — one statement, the page's `[postId, position]` pairs and move ids as JSON
  parameters).

- [ ] **Step 1: failing tests** (`design-read-saves.test.ts`, seeding extract-6 readings with quotes through the fixture):
  "each move carries its evidence" — stated/inferred, quotes with ids `q1.1…`, checks as words, `useWhen`/`skipWhen`/`why`
  marked, the post's dose words and the record's dose with its origin (`post` for a born move whose dose text parsed,
  `default` for none, `library` for the goblet squat, `edited` after `editPersonalMove`), the match (`by: "name"` for the
  library link); "a correction shows on its move" (a seeded `import_corrections` row, newest first, at most 3); "insights
  keep their post and scope" (a `this_routine` insight is read, the opening context still shows general only); "the
  receipt maps every quote id read"; "ids are stable across pages" (`limit: 1`, `offset: 1` → `q2.1`); "three statements,
  no writes" (the registry test's `statementCost` 3 and the count); "a page shrinks to fit" (12 moves with 8 long quotes
  each stay under `RESULT_BUDGET_BYTES`, `missing` names the offset).
- [ ] **Step 2:** run the file — FAIL.
- [ ] **Step 3:** implement: candidate page first (`moves.slice(offset, offset + limit)`), its evidence read, then the
  byte fit as today; description (≤ 240) names evidence and corrections.
- [ ] **Step 4:** rerun — PASS; run `design-context.test.ts`, `design-cpu-bench.test.ts` (re-measure `read_saves`'s
  `cpuWeight`: declared at the highest scaled p50 of three quiet runs, rounded up to the tenth, with a dated comment).
- [ ] **Step 5:** commit `feat(coach): read_saves gives each saved move its evidence — quotes, checks, dose origin, match, corrections`.

### Task 3: pin_moves lines cite their evidence (§8.3, §14.1–14.2)

**Files:** Create `apps/worker/src/services/design-tools/saves-reads.ts`; Modify `pin-moves.ts`, `proposal-kinds.ts`;
Test `apps/worker/test/design-move-pins.test.ts`.

**Interfaces — Consumes:** Tasks 1–2 (the receipt). **Produces:**
- `savesReadsSql(userId: string, mainRunId: string, batchId: string): SQL` (a scalar subquery over `coach_run_events`
  tool_result rows of `read_saves` whose receipt names the batch) and `savesReadsOf(raw): { moves: Map<moveId, {postId, position}>; quotes: Map<id, QuoteRef>; readAt: Map<postId, string> }`.
- input line `{ moveId?, decision?: "in" | "out", where?: string (≤ 80), dose?: string (≤ 40), text, cites?: string[] (≤ 8) }`;
- stored `PinsCardLine` gains `decision?`, `where?`, `dose?`, `cites?: CiteRef[]`, `post?: { id, position }`;
  `MovePinsOp` gains `read?: Array<[postId, at]>`; `pinsCardLinesOf` keeps them when well-formed.
- refusals (each a teachable `ToolErr`): `invalid_input` (a move line with no decision), `not_read` (a line about a
  move of the card's batch no read_saves page of this run covered — names it), `unknown_cite` (an id the run never read,
  or not one of `q…`, `history`, `goal:<id>`, `inferred:<field>`), `uncited_claim` (`claimsThePost(text)` with no quote
  cite), `dose_mismatch` (a coach dose whose `doseNumbers` differ from the dose the move will run with — the reply
  names that dose and `correct_import`), `in_not_placed` (in, but neither pinned here, in a workout this suggestion
  holds, nor already pinned), `out_but_placed` (out, but pinned here or in a workout here). Statements unchanged (2):
  the receipts, the batch's link moves and the current pins ride the existing read.
- the line's dose: the revised item's in a `doc_workout` op of this proposal (domain `doseSummary`), else a pending
  `import_correction` dose's `after`, else the record's (`doseWords`, moved from read-library to `saves-evidence.ts`).

- [ ] **Step 1: failing tests** — a fit with a read (the receipt event seeded through the loop's own payload builder
  `toolResultPayload`): cites resolve to `CiteRef`s with labels and the line keeps `post`; each refusal above; "a heard
  quote is never said" (cite of an `in_speech` quote → label `heard 0:12`); "two pages, one unread" (receipts for page 1
  only → a line about a page-2 move is `not_read`); the dose filled from the record, from a revised item, from a pending
  dose correction, and `dose_mismatch` for `"3×10"` against `2 × 6 / side`; an old-style line `{moveId, text}` in a
  stored op still reads (`pinsCardLinesOf`); the 30-line cap holds; statement count still 2.
- [ ] **Step 2:** run the file — FAIL.
- [ ] **Step 3:** implement; description and input schema say decision, where, cites (keep `coach-shape-pins` in view).
- [ ] **Step 4:** rerun — PASS; run `design-act-tools.test.ts`, `design-act-budget.test.ts`, `coach-runs-fit-release.test.ts`.
- [ ] **Step 5:** commit `feat(coach): a pins line says in or out, where, the dose it runs with, and cites what it rests on`.

### Task 4: correct_import — the coach proposes a correction (§8.4)

**Files:** Create `apps/worker/src/services/design-tools/correct-import.ts`, `apps/worker/src/services/import-corrections.ts`;
Modify `proposal-kinds.ts`, `design-tools/index.ts`, `design-prompt.ts` (`PROMPT_TOOL_NAMES`), `packages/saves/src/schemas.ts`
(insight `move?: number`); Test `apps/worker/test/design-correct-import.test.ts`.

**Interfaces — Produces:**
- `ImportCorrectionOp { kind: "import_correction"; id: string (correctionId); target: "move" | "reading" | "insight" | "link"; targetId: string; field: string; before: unknown; after: unknown; why: string; basis: "evidence" | "owner"; cites: CiteRef[]; name: string; line: string; posts: string[]; date; toolUseId; replaces?: string[]; at }`;
  `correctionId(target, targetId, field) = "fix-" + target + "-" + targetId + "-" + field`; `isImportCorrectionOp`.
- targets and fields: `move` (`targetId` a personal move id): `name, summary, purpose (text.why), dose, laterality, load, equipment, steps, cues (text.focus)`;
  `reading` (`<postId>:<position>`): `useWhen, skipWhen, why`; `insight` (`<postId>:<index>`): `drop, text, scope, move`;
  `link` (`<postId>:<position>`): `same_as` (after: a move id offered), `not_same` (after: null; a library-linked link only).
- `import-corrections.ts`: `correctionReadSql(userId, target, targetId, field): SQL` (the current value and the row's
  standing as one JSON), `correctionValueOf(target, field, raw)`, `validateAfter(target, field, after, current): string | null`
  (the corrected record held to `validatePersonalRecord`; reading items to extract-6's own limits), `correctionLine(op): string`
  (`"Dose of Zorbex hip lift: 2 × 30 s (was 8–12 reps)"`), `CORRECTIONS_MAX = 10`.
- the tool: main only; `statementCost: 2` (the read with the proposal, the restore marker and the receipts; the upsert);
  refuses `not_for_role`, `not_a_target` (archived, merged or library move; another account's; a post not in a read
  batch), `bad_field`, `bad_after` (with the validator's words), `same_value`, `uncited` (basis evidence with no cite
  — a quote, `history` or `inferred:<field>`), `unknown_cite`, `too_many` (> CORRECTIONS_MAX), `proposal_pending`,
  `proposal_closed`, `restoring`; a second call for the same id replaces it; a replay answers what it stored; a dose
  correction updates the dose of the pins line naming the move (Task 3's line) in the same upsert.

- [ ] **Step 1: failing tests** — each target and field stores its op with `before` read by the Worker; each refusal;
  replace and replay; a dose fix rewrites the pins line's dose; `basis: "owner"` needs no cite; an insight with `move`
  parses through `extractionSchema`; registry has it in `ACT_TOOLS` after `pin_moves` and the prompt names it.
- [ ] **Step 2:** run the file — FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun — PASS; run `design-prompt.test.ts` (tool names), `packages/saves` tests.
- [ ] **Step 5:** commit `feat(coach): correct_import — a correction to imported data, proposed with its evidence`.

### Task 5: Corrections approved, declined, superseded — logged and on the trail

**Files:** Modify `design-approve.ts` (a class after the programme changes, before the pins), `proposal-kinds.ts`
(`isDesignedOp`), `design-cover.ts` (`openOp`, a newer correction of the same id covers an older), `design-orchestrate.ts`,
`coach-runs.ts`, `design-context.ts`, `coach-conversation.ts` (the kind lists in SQL), `import-corrections.ts`
(`applyStatements`); Test `apps/worker/test/design-approve-corrections.test.ts`.

**Interfaces — Consumes:** Task 4. **Produces:**
- `CorrectionOutcome = { status: "applied"; at } | { status: "applying"; at } | Exclude<OpOutcome, { status: "applied" }>`;
- `CORRECTIONS_FIXED = 1 + 1` (their claim, their one read), `CORRECTION_COST = 3` (the atomic batch: the
  `import_corrections` row and the trail event, each gated on the value still being `before`, then the state change
  `… returning`, last), `LINK_CORRECTION_EXTRA = 2` (the repoint and the archive-or-like); found already at `after` →
  applied with nothing written; changed to anything else → refused `stale` ("It changed since the coach suggested
  this — ask again."); a move archived or merged since → refused `not_a_target`.
- the trail event: stage `correction`, source `coach`, `moveId` when it names one, summary `"<Field> corrected: <after>
  (was <before>) — <why>"`, detail `{ target, targetId, field, before, after, basis, cites, proposalId }`, on every
  post in `op.posts`; the `import_corrections` row `by: "coach"`, `basis`, `evidence` = the cites, `proposal_id`.
- declined and superseded corrections are decided like pins (no claim needed to decline one not started).

- [ ] **Step 1: failing tests** — approve a dose fix: record changed, one correction row, one event per post, in one
  batch (a forced failure of the update leaves neither); a reading's useWhen fix rewrites the post's extraction at that
  move and the trail account shows it; an insight drop / rescope; link `same_as` archives a clean duplicate and marks a
  used one `like`; `not_same` makes an active personal move and repoints the link; stale; a double approve; a decline;
  a proposal of corrections alone is promoted, read, approved; supersede by a newer correction of the same id; the
  declared cost holds (count the statements); 10 corrections fit one request.
- [ ] **Step 2:** run the file — FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun — PASS; run `design-approve*.test.ts`, `design-orchestrate.test.ts`, `design-plan-powers.test.ts`, `coach-conversation*.test.ts`.
- [ ] **Step 5:** commit `feat(coach): an approved correction is applied, logged with before, after, why and basis, and shown on the post's trail`.

### Task 6: The coach's decisions on each post's trail (spec item 6, §8.3)

**Files:** Create `apps/worker/src/services/coach-trail.ts`; Modify `design-orchestrate.ts` (`supersedeOlderPlans`),
`design-approve.ts` (`applyMovePins`, `declineDesignOps`, `MOVE_PINS_FIXED`, `DECLINE_COST`), `coach-runs.ts`
(`STOP_PROPOSE` and the finish's comment), `design-tools/finish.ts` (`statementCost`); Test `apps/worker/test/coach-trail.test.ts`.

**Interfaces — Consumes:** Tasks 3, 5. **Produces:**
- `type CoachVerdict = "suggested" | "approved" | "declined" | "superseded"`;
- `pinsTrailStatement(db, userId, o: { proposalId: string; runId: string; batchId: string; lines: PinsCardLine[] }, verdict: CoachVerdict, at: string, gate?: SQL): AtomicStatement`
  — one INSERT…SELECT: each line about a move × each saved link of the batch naming it (or a move merged into it), one
  event: stage `coach`, source `coach` (`owner` for approved/declined), `moveId`, `runId`, `proposalId`, summary
  `"<Verdict words>: <in|left out> · <where> · <dose> — <text>"` (verdict words: "The coach suggested it", "You
  approved it", "You said not now", "Replaced by a newer suggestion"), detail `{ verdict, decision, where, dose, text, cites }`;
- `promotionTrailStatement(db, userId, proposalId: string, at: string): AtomicStatement` — one INSERT…SELECT from the
  stored ops: the new suggestion's lines `suggested`, its `read` posts ("The coach read this post", `at` = the read's),
  its corrections `suggested`, and every older card this promotion superseded (`outcome.by` = proposalId,
  `outcome.at` = at) `superseded`; run by `supersedeOlderPlans` after its update (one statement more, always).
- approve: the pins' events ride `applyMovePins`' batch-fitted write as one `runAtomically` (`MOVE_PINS_FIXED` 3 → 4);
  decline: one statement for the declined pins and corrections (`DECLINE_COST` 7 → 8).

- [ ] **Step 1: failing tests** — a fit approved writes, per move per post, suggested (at promotion), read, then
  approved, and the trail account's "What the coach did" line is the latest; declined; superseded by a newer card; a
  move in two posts gets both; no batch → no events; an old card's lines (no decision) write words without one; the
  three budgets hold (count statements in `design-approve.test.ts`'s and the finish's counting tests).
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun — PASS; run `design-approve.test.ts`, `design-orchestrate.test.ts`, `coach-run-trail.test.ts`, `coach-runs-fit-release.test.ts`, `import-trail-read.test.ts`.
- [ ] **Step 5:** commit `feat(coach): the coach's reading, suggestion and your decision on each post's trail`.

### Task 7: The prompt — skepticism, citations, challenge, insistence (§8.2, §3.5, §15 Q1)

**Files:** Modify `design-prompt.ts` (`# Integrating saved moves`, `MAIN_ROLE`), `design-tools/read-saves.ts`,
`pin-moves.ts`, `correct-import.ts` (descriptions within their caps); Test `apps/worker/test/design-prompt.test.ts`,
`design-fix13-prompt.test.ts`, `design-orchestrate.test.ts`, `coach-shape-pins.test.ts`.

- [ ] **Step 1: failing tests** — the shared prompt says: weigh each move against where the athlete stands and name
  the goal or gap; a quote said / in the caption is the creator's word, heard is near it but not proof, on screen is
  unchecked, inferred or no quote is the reader's guess; never a guess as the creator's; garbled or thin readings said
  plainly, with humility; correct_import before pin_moves; a line's where is the revised workout or the rotation. The
  main role says the challenge order (their point fairly → the evidence → the call and what moved it), insistence wins
  without more argument and is `basis: "owner"`, except a condition's never and a sore area (say so, why, the closest
  safe option, the Studio). (`expect(SHARED_PROMPT).toContain(…)` on short exact phrases.)
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** write the words (brisk; reasons, not a checklist).
- [ ] **Step 4:** set each size pin low, read the measured value, pin at measured + ≥ 100 tokens with
  `REBASED 2026-11-06 (coach review, phase 3): <what grew> — measured N`; rerun — PASS.
- [ ] **Step 5:** commit `feat(coach): the prompt — a post is a stranger's claim, a challenge gets a coach, insistence wins within the hard checks`.

### Task 8: The reviewer's faithfulness dimension (§8.5)

**Files:** Modify `design-prompt.ts` (`REVIEW_DIMENSIONS`, `REVIEWER_ROLE`), `design-review.ts` (`parseReview(raw, rubric, { optional? })`,
`packetDoc`, `submitReview`, `EVIDENCE_TIERS.read_saves = 1`); Test `apps/worker/test/design-review*.test.ts`, `design-prompt.test.ts`.

**Interfaces — Produces:** dimension `{ id: "faithfulness", label: "Faithful to your saves", question: … }` (workout
rubric only); `parseReview(raw, rubric, { optional?: readonly string[] })` — an optional dimension may be absent;
`submitReview` passes `optional: ["faithfulness"]` when the draft holds no `my…` item; `packetDoc` adds to each saved
item `saved: { dose: <record dose words>, purpose: <marked> }`; the reviewer's must-fix gains "a saved move's dose, why
or notes that differ from its record or the post's quotes with no reason given".

- [ ] **Step 1: failing tests** — a review with no saved move and no faithfulness parses; with a saved move it is
  required; the packet shows a saved item's record dose; the reviewer block holds the dimension and the must-fix line;
  the card's review (`lineReview`) shows no empty faithfulness line; role-block pins re-measured as in Task 7.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** rerun — PASS.
- [ ] **Step 5:** commit `feat(coach): the reviewer checks a saved move's dose and why against its evidence`.

### Task 9: The lines and why carried into later turns

**Files:** Modify `coach-conversation.ts` (`turnsSql`'s pins and corrections fields, `turnLines`), `read-proposals.ts`
(`pinsOf` lines in brief; corrections), `design-manifest.ts` (`correctionLines`, the read's `corrections` part);
Test `apps/worker/test/coach-conversation.test.ts`, `design-read-proposals.test.ts` (or the file that holds read_proposals' tests).

**Interfaces — Produces:** in the conversation block, under a pins card: at most 12 lines
`    - <in|out> <name>[ · where][ · dose]: <text ≤ 160> [cite ids]` (marked as the main coach's; a name marked as a
saved post's), then `    Why: <why ≤ 300>`, then `    … and N more lines (read_proposals)`; each correction
`    - Correction: <line> — <how it stands>`; read_proposals' `move_pins` gains `lines` (same brief) and a new
`import_correction` entry; the proposal read gains `corrections: CorrectionLine[]` (`{ opId, target, field, name, line, why, basis, cites, outcome }`).

- [ ] **Step 1: failing tests** — "why did you leave X out" context: the next turn's block holds X's out line and the
  why; the block stays under `CONVERSATION_BLOCK_MAX_CHARS` with 30 long lines; "an old card reads as before" (plain
  strings, no decision); read_proposals shows lines and corrections, marked.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** rerun — PASS (and `design-context.test.ts`).
- [ ] **Step 5:** commit `feat(coach): the card's lines and why reach the coach's next turn`.

### Task 10: The review card and the trail at a quote (§3.3–3.5)

**Files:** Modify `packages/api-client/src/index.ts` (`DesignCiteDto`, `DesignPinsCardLineDto` fields,
`DesignCorrectionLineDto`, the read's `corrections`, `CoachConversationCardDto.kind` `"corrections"`), `plan-card.tsx`,
`coach-tolerance.ts`, `coach-conversation.tsx` (provides `CoachReplyContext`), `trail-sheet.tsx` (`focus`),
`trail-model.ts` (`TrailRow.quote`), the stylesheet the coach cards use; Create `packages/ui/src/screens/studio/review-lines.tsx`,
`coach-reply.ts`; Test `packages/ui/test/review-lines.test.tsx`, `packages/ui/test/trail-sheet.test.tsx`, `plan-card` tests.

**Interfaces — Produces:** `CoachReplyContext: React.Context<{ challenge(words: string): void } | null>`;
`<ReviewLines lines corrections why onOpenTrail />` — In first, then Left out (headings only when the card has
decisions), each line: the name (a button: the trail at the move), `where · dose`, the text, chips (buttons labelled
⟨said 1:12⟩ etc.; a quote's opens the trail at the quote, an inferred one at the move, history and goal are plain), and
Challenge (fills "About <name>: " through the context, or — no context — nothing shown); corrections under
"Corrections"; the why at the foot; `TrailSheet({ postId, onClose, focus?: { position: number; quote?: number } })` opens
that move's section and marks and scrolls to the quote row; the card approves its pins op and its corrections together
(`opIds`); a corrections-only card (`kind: "corrections"`) uses the same card in its own words ("Corrections to your
saves", done "Corrected").

- [ ] **Step 1: failing tests** — the card groups In / Left out; chips render with their labels as text; tapping a
  chip opens the trail with that quote's row marked; Challenge fills the box and focuses it; the why shows at the
  foot; an old card (no decisions, plain lines) renders as before; corrections listed and approved with the pins in one
  tap; at 360 px the lines wrap (no element wider than its container in the jsdom layout assertions the suite already uses).
- [ ] **Step 2:** run `pnpm --filter @rg/ui exec vitest run test/review-lines.test.tsx test/trail-sheet.test.tsx` — FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun — PASS; run the coach and saves UI tests.
- [ ] **Step 5:** commit `feat(ui): the coach's review card — evidence chips, Challenge, the why, corrections`.

### Task 11: The whole branch

- [ ] **Step 1:** worker, ui, saves, saves-extension, api-client and database suites, in the default TZ and `TZ=UTC`;
  typecheck each package (`npx tsc -p <pkg> --noEmit`, exit code read).
- [ ] **Step 2:** the spec gains `### 8.6 As built (phase 3, 2026-11-06)` (the rulings, the files, the costs).
- [ ] **Step 3:** one fresh whole-branch reviewer (opus); one fix pass, each fix with its test; suites again.
- [ ] **Step 4:** rebase on `origin/main` (run alone, read its result, confirm no rebase in progress); suites again.
