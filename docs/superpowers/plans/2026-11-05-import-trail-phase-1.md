# Import Trail — Phase 1 (the trail and health) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every saved post keeps one trail — what each stage took in, decided and gave out, with its model call's
facts and raw reply — readable as a plain account in a sheet that opens to any depth; a red/yellow/green health row in
the popup and the coach; the pipeline bugs the audit found fixed; the coach's own trail stops cutting and hiding.

**Architecture:** A small trail module (`import-trail.ts`) collects events and blobs per stage and turns them into D1
statements that join the stage's existing `runAtomically` / `db.batch`, so a trail row is written with the state change
it describes. The prompt registry stores each prompt version's system text once. The trail is read by one owner route
and rendered by a pure model (`trail-model.ts`) and a sheet. Health is computed on read from trail events, checks and
the import budget. The coach trail fixes keep tool results (bounded digests) and render every payload through words.

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free) with D1/drizzle; zod; React 18 + TanStack Query; Vitest
(jsdom for UI); Chrome MV3 extension built with esbuild (`apps/saves-extension/build.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` (§3.2, §3.4, §4, §6, §9 for this
phase; §14 decisions). Audit: `docs/reports/2026-11-05-import-trail-audit.md`. Earlier plans for file layout and test
conventions: `docs/superpowers/plans/2026-10-23-saved-posts-import.md`, `2026-10-26-saves-flow-redesign.md`.

## Global Constraints

- Workers Free: ≤ 45 D1 statements and external fetches per request, 10 ms CPU. Every route or tool whose count changes updates its statement pin to the exact new number with a comment naming this change ("import trail").
- D1: ≤ 100 bound parameters a statement (chunk multi-row inserts; `insertBatches` exists); a row ≤ 2 MB — `import_blobs.text` ≤ 1,000,000 characters, `import_events.detail` ≤ 64,000 characters (bigger pieces become blobs).
- Public repository: no real post links, handles, captions, transcripts or move names in code, fixtures, tests or docs. Synthetic `Zorbex …` names, made-up creators; links assembled as `seed-saves-transform.test.ts` does.
- Untrusted text (captions, model replies, move names) is drawn as text in the UI, never markup, and reaches a model only through the existing untrusted wrappers.
- Owner's voice: brisk, plain, no explainer captions on a page; detail one tap down. Never "proposal" in UI copy (the coach says "suggestion").
- Never truncate a reasonable model call: output caps sized from worst cases with headroom (filter 1,000 tokens; judge 2,000).
- Node v21 for vitest (never node 22: better-sqlite3); `NODE_OPTIONS=--max-old-space-size=4096` for full runs; run from the worktree root: `pnpm vitest run <paths>`, `pnpm typecheck`.
- Git: never `git stash`; commit source only (never `.superpowers/`); commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push from a task (the lead pushes; every push to `main` deploys).
- Never run wrangler against `--remote` in a task.
- UI: design tokens only, 44 px targets, both themes.

## Review Focus

1. **A trail that disagrees with the state**: a stage that fails after its state write but before its trail write (or the reverse). Expected: both in one batch; a test per stage asserts the event exists iff the state change does.
2. **A huge raw reply or prompt** (a 12k-token reply, a 400 KB caption+library prompt): expected stored whole as a blob up to 1,000,000 chars, cut at a char boundary past that with `cut: true`, never failing the stage.
3. **A post with no trail** (imported before this phase): the trail route answers an account built from stored columns with `rebuilt: true` and no error; the sheet says "Kept from before the trail: the raw replies weren't kept then."
4. **Health with no data** (a new account, a source never used): grey, never green; the popup headline is "No check yet", not "Up to date".
5. **The coach trail on old runs** (events stored before §6.4, with `{truncated, head}` payloads): rendered as words ("Too long to show here") — never raw JSON.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/database/migrations/0034_import_trail.sql` + `packages/database/src/schema/saves.ts` | the four tables and four `saved_posts` columns |
| `packages/saves/src/trail.ts` (new, exported from `index.ts`) | the trail's shared types and DTOs: `ImportStage`, `TrailStatus`, `ImportTrailDto`, `ImportHealthDto` |
| `packages/saves/src/prompts.ts` | `extractUserText()` shared by the extension and the Worker; prompt hashes |
| `apps/worker/src/services/import-trail.ts` (new) | collecting events/blobs, `trailStatements()`, `promptVersionStatement()` |
| `apps/worker/src/services/import-trail-read.ts` (new) | the owner's read: `readPostTrail()`, `readBlob()`, the rebuilt account for old posts |
| `apps/worker/src/services/import-health.ts` (new) | `importHealth()` lights |
| `apps/worker/src/services/saves-*.ts` | each stage writes its events |
| `apps/worker/src/routes/saves.ts`, `my-saves.ts` | `/health`, `/read-failed`, `/posts/:id/trail`, `/blobs/:id` |
| `apps/saves-extension/src/*` | read facts, prompt headers, read failures, health in the popup, trail links |
| `packages/ui/src/screens/saves/trail-model.ts`, `trail-sheet.tsx`, `health-row.tsx` (new) | the trail sheet and the health row |
| `packages/ui/src/screens/studio/run-model.ts`, `apps/worker/src/services/coach-runs.ts` | the coach trail fixes |

---

### Task 1: Plurals match their singulars

**Files:** Modify `packages/saves/src/normalize.ts:5-9`; Test `packages/saves/test/normalize.test.ts`

- [ ] **Step 1: failing tests** — `normalizeMoveName` maps each plural to its singular's form:
  `["Calf raises","calf raise"]`, `["Rib releases","rib release"]`, `["Child's poses","child's pose"]`, `["Glute squeezes","glute squeeze"]`, `["Hip circles","hip circle"]`, `["Box jumps","box jump"]`, `["Lunges","lunge"]`, `["Bench presses","bench press"]`, `["Pushes","push"]`, `["Boxes","box"]`, `["Crunches","crunch"]`, `["Lateral raises" === "Lateral raise"]`; and words that end in s but aren't plural keep it: `"Press"→"press"`, `"Cross"→"cross"`, `"Abs"`→`"abs"`, `"Bus"`→ unchanged len≤3.
  Also `matchMoves` exact-matches a post's "Zorbex raises" to a library record named "Zorbex raise" (`saves-match.test.ts`).
- [ ] **Step 2:** run `pnpm vitest run packages/saves/test/normalize.test.ts` — FAIL on raises/releases/poses/squeezes.
- [ ] **Step 3:** `singular(w)`: strip `-es` only after `ch|sh|x|z|ss` (presses, crunches, boxes, pushes); otherwise strip a final `s` unless the word ends `ss` or `us` or is ≤ 3 letters; "abs" stays. (Rebuilds `normalizeMoveName` for every stored name: names are normalized at read, never stored normalized — confirm with `grep -rn normalizeMoveName apps/worker/src` before committing.)
- [ ] **Step 4:** run the saves package and `apps/worker/test/saves-match.test.ts` `saves-batches.test.ts` — PASS.
- [ ] **Step 5:** commit `fix(saves): plurals match their singulars — "raises" no longer reads as "rais"`.

### Task 2: The dose a post states is read whole, and a default says it is one

**Files:** Modify `apps/worker/src/services/personal-records.ts:12-75,190-222`; Test `apps/worker/test/personal-records.test.ts`

**Interfaces — Produces:** `doseFromText(text) → { type?, range?, sets?, perSide?: boolean }` (unchanged shape plus `perSide`); `buildPersonalRecord(id, draft) → { ok: true; record; repairs: string[]; doseOrigin: "post" | "reading" | "default" } | { ok: false; issues }` (`reading` = the model's `dose.range`; `post` = parsed from the dose text; `default` = `DEFAULT_RANGE`).

- [ ] **Step 1: failing tests** (`doseFromText`): `"1.5 min"` → time `[90,90]`; `"0.5 min"` → `[30,30]`; `"2x30s"` → sets `[2,2]`, time `[30,30]`; `"3 x 30 sec"` → sets `[3,3]`, `[30,30]`; `"1:30 hold"` → time `[90,90]`; `"10 each side"` → reps `[10,10]`, perSide; `"8/side"` → reps `[8,8]`, perSide; `"45-60s"` → `[45,60]`; `"10-15 reps"` → `[10,15]` (still). And `buildPersonalRecord` returns `doseOrigin: "default"` for a draft with dose text "slowly" and no range, `"post"` for "2x30s", `"reading"` when `dose.range` is set.
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** decimals in the minute and second patterns (`\d+(?:\.\d+)?`), `NxM` followed by a unit (`s|sec|min`) as sets×time, `m:ss`, `each side|per side|/side|a side` → perSide; `doseOf` reports its origin; `matchPost` keeps it on the decision for Task 8.
- [ ] **Step 4:** run `apps/worker/test/personal-records.test.ts` and `saves-match.test.ts` — PASS.
- [ ] **Step 5:** commit `fix(saves): a stated dose is read whole — decimals, 2x30s, m:ss, per side — and a default knows it is one`.

### Task 3: A failed post says why, and its words match its code

**Files:** Modify `packages/saves/src/schemas.ts` (`PostRowDto`), `apps/worker/src/services/saves-ledger.ts:169-205,235-297`, `saves-relay.ts:212-218,403-408`, `saves-ledger.ts:101-160` (work-list give-up); Test `apps/worker/test/saves-routes.test.ts`, `saves-relay.test.ts`

**Interfaces — Produces:** `PostRowDto` gains `errorCode: SaveErrorCode | null` and `error: string | null` (the failure in plain words); `reason` stays the screening reason. `failureWords(code: SaveErrorCode, raw: string | null): string` in `packages/saves/src/trail.ts` (Task 6 creates the file; this task adds the function there first if Task 6 isn't done — keep it in `trail.ts`).

- [ ] **Step 1: failing tests**: a post failed by `markFetchFailed(..., "gone")` after an earlier `model_failed` shows `errorCode: "gone"`, `error: "The post is gone"` and no stale model text; `markTooLarge` clears `last_error`; the matching catch sets `last_error` to `"matching failed"`; `savesStatus` rows carry `errorCode` and `error`, and a `failed` row's `reason` is never presented as its failure (the popup's row shows `error`).
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** every path that sets `last_error_code` also sets `last_error` (null or the new text); `failureWords` maps each code to plain words: `gone` "The post is gone", `media_failed` "The video wouldn't download", `too_large` "Too large to send, at any size", `model_failed` "The reader's reply didn't work" + the first issue, `budget_paused` "Waiting for the import budget", `unknown` "Something went wrong" + the raw text, `login_needed` "Instagram wants you to log in again", `feed_changed` "Instagram changed something", `app_unreachable` "The app couldn't be reached".
- [ ] **Step 4:** run — PASS. Update the extension's popup row to show `error` for failed posts (`apps/saves-extension/src/status.ts` `popupModel`: `reason: p.status === "failed" ? p.error ?? p.reason : p.reason`) with its test.
- [ ] **Step 5:** commit `fix(saves): a failed post says why — never the filter's verdict — and its words match its code`.

### Task 4: Screening and the judge are never cut short; a reply that doesn't parse is a failure

**Files:** Modify `apps/worker/src/services/saves-filter.ts:21,117,217-225`, `saves-match.ts:58,393-412`; Test `saves-filter.test.ts`, `saves-match.test.ts`

- [ ] **Step 1: failing tests**: `FILTER_MAX_TOKENS === 1000`, `MATCH_MAX_TOKENS === 2000`; an unparseable filter reply leaves the post `seen` with `errorCode: "model_failed"` (retried next check), settles its cost, and is never `queued` with reason "unclear"; two posts with empty creator handles never decide each other by the creator rule.
- [ ] **Step 2–4:** implement (`parseVerdict` returns `null` on failure; the creator rule skips an empty handle), run — PASS. Reservation estimates stay at the typical output (the worst case grows with the cap; check `saves-budget.test.ts` still passes).
- [ ] **Step 5:** commit `fix(saves): screening and matching replies are never cut short; one that doesn't parse is retried, not a paid maybe`.

### Task 5: The smaller pipeline bugs

**Files:** Modify `saves-ledger.ts` (work list, override), `saves-relay.ts:243-251`, `saves-match.ts:140,157,286`, `saves-batches.ts:391-424,524-528`, `apps/saves-extension/src/check.ts:216-219`; Tests in the matching suites.

- [ ] **Step 1: failing tests**, one per bug:
  - *budget loop*: a post refused for budget is not in `/work` again until `importSpend` has room for a typical extraction (the work list checks spend once per call: +1 statement, pin it);
  - *archived*: an exact name match to an `archived` personal move links with confidence 0.6 and `checkFlag: true`, never 1;
  - *skip in a batch*: `overridePost(skip)` on a matched post removes its `pending` links from the batch (status `removed`), so `saveBatch` writes none of them; a non-matched post's skip is unchanged;
  - *insight cap*: with 25 insights of which the first 10 are doses, `insightsOf` keeps 20 valid ones (the SQL limit applies after `keepInsight`; fetch up to `INSIGHTS_PER_BATCH * 3`, filter, then cap);
  - *extension*: a submit answered `{status: "seen", errorCode: "model_failed"}` counts in the check's `failed`.
- [ ] **Step 2–4:** implement each, run the saves suites and `apps/saves-extension` — PASS.
- [ ] **Step 5:** commit `fix(saves): budget pauses don't loop, archived moves don't match blind, skip leaves the batch, insights cap after filtering`.
- Deferred (ledgered in STATUS, not this phase): aliases on personal records (needs an `ExerciseRecord` field); the relay reading `max_tokens` from the body.

### Task 6: The trail's tables and types

**Files:** Create `packages/database/migrations/0034_import_trail.sql`; Modify `packages/database/src/schema/saves.ts`, `packages/database/src/schema/index.ts`, `apps/worker/src/services/account-tables.ts`; Create `packages/saves/src/trail.ts`, export from `packages/saves/src/index.ts`; Test `apps/worker/test/import-trail.test.ts`, `account-export` / delete-all suites.

**Interfaces — Produces** (`@rg/saves`):
```ts
export const IMPORT_STAGES = ["read","submit","screen","extract","check","match","batch","choice","save","coach","correction"] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];
export type TrailStatus = "ok" | "warn" | "fail" | "skip" | "info";
export type TrailSource = "instagram" | "youtube" | "gateway" | "worker" | "coach" | "owner" | "extension";
export interface TrailEventDto { id: string; stage: ImportStage; source: TrailSource; status: TrailStatus; summary: string;
  detail: unknown; moveId: string | null; model: string | null; promptVersion: string | null; costMicros: number | null;
  latencyMs: number | null; attempt: number | null; runId: string | null; proposalId: string | null; rebuilt: boolean;
  blobs: { id: string; kind: BlobKind; chars: number }[]; at: string }
export type BlobKind = "raw_reply" | "prompt_user" | "transcript" | "speech" | "read_facts";
```
Tables (drizzle names): `importEvents`, `importBlobs`, `promptVersions`, `importCorrections` with the columns of spec §6.1; `savedPosts` gains `origin`, `title`, `durationSec`, `videoSeen`. Indexes: events `(user_id, post_id, at)`, `(user_id, stage, at)`; blobs `(user_id, post_id)`.

- [ ] **Step 1: failing test**: the test DB (migrations applied by `makeTestDb`) has the four tables; `account-tables.ts` lists all four under the user's key (the delete-all test deletes them; the export test exports events and corrections, not blobs of raw replies — blobs are exported too: they're the owner's data).
- [ ] **Step 2–4:** write the migration (additive; header comment in the style of 0031), the drizzle tables, account-tables entries; run `pnpm vitest run apps/worker/test/import-trail.test.ts apps/worker/test/account-*.test.ts` and `pnpm typecheck` — PASS.
- [ ] **Step 5:** commit `feat(saves): the import trail's tables — events, blobs, prompt versions, corrections (0034, additive)`.

### Task 7: Collecting a stage's trail

**Files:** Create `apps/worker/src/services/import-trail.ts`; Test `apps/worker/test/import-trail.test.ts`

**Interfaces — Produces:**
```ts
export interface TrailEventInput { stage: ImportStage; source: TrailSource; status: TrailStatus; summary: string;
  detail?: unknown; moveId?: string; batchId?: string; usageId?: string; model?: string; promptVersion?: string;
  costMicros?: number; latencyMs?: number; attempt?: number; runId?: string; proposalId?: string;
  blobs?: { kind: BlobKind; text: string }[] }
export function trailStatements(db: Db, userId: string, postId: string, events: TrailEventInput[], at: string): BatchItem[];
export function promptVersionStatement(db: Db, version: string, kind: string, systemText: string, at: string): BatchItem;
export const EVENT_DETAIL_MAX = 64_000; export const BLOB_MAX = 1_000_000; export const SUMMARY_MAX = 300;
```
- [ ] **Step 1: failing tests**: `trailStatements` with two events and one blob yields 2 statements (one multi-row events insert, one blobs insert); a detail over 64,000 chars is stored as `{ cut: true, head }` plus a `read_facts` blob holding the whole; a blob over 1,000,000 chars is cut at a char boundary with `cut: true` in its event's detail; a summary is clipped at a word boundary ≤ 300 with "…"; `promptVersionStatement` is insert-or-ignore (two calls, one row); events with > 100 bound parameters chunk (`insertBatches`).
- [ ] **Step 2–4:** implement; ids by `newId()`; run — PASS.
- [ ] **Step 5:** commit `feat(saves): the trail collector — a stage's events and blobs as statements in its own batch`.

### Task 8: Every Worker stage writes its trail

**Files:** Modify `saves-ledger.ts` (`upsertPost`, `markFetchFailed`, `overridePost`), `saves-filter.ts`, `saves-relay.ts`, `saves-match.ts`, `saves-batches.ts` (`assembleBatch`, `saveBatch`, `choicesWrite`), `saves-review.ts` (`editPersonalMove`, `rematchLink`, `removeLink`), `routes/saves.ts`; Tests: each stage's suite gains trail assertions, and `apps/worker/test/import-trail-stages.test.ts` walks one synthetic post submit → filter → extract → match → batch → save and asserts the ordered stage list `["submit","screen","extract","check","match","batch","save"]`.

**Interfaces — Consumes:** Task 7. **Produces** (event `detail` shapes the reader relies on):
- `screen`: `{ verdict, reason, stage: "creator"|"keyword"|"model"|"seed"|"owner", tokens?: {in,out} }` + `raw_reply` blob when a model answered.
- `extract` (one per attempt): `{ finishReason, tokens: {in,out}, issues?: string[], promptSha, promptShaSent, asSent: boolean, videoSeen: null, bytes }` + `raw_reply` and `prompt_user` blobs; status `fail` with the issues on a failed attempt.
- `check`: `{ moves: [{ position, name, repairs: string[], problems: string[], doseOrigin, evidence }] }`.
- `match`: `{ moves: [{ position, name, outcome: "library"|"personal"|"new", moveId, by: "name"|"judge"|"fuzzy"|"new", confidence, candidates: [{id,name,score,kind}], judge: "asked"|"not_needed"|"failed"|"budget", judgeAnswer: string|null, like: {id,name}|null, check: boolean }] }` + the judge's `raw_reply` blob.
- `batch`: `{ batchId, why: "oldest waiting" }`; `save`: `{ batchId, insightsKept: n, insightsDropped: [{text, why}] }`; `choice`: `{ action, moveId?, before?, after? }` (edits carry a field diff).

- [ ] **Step 1: failing tests** per stage (event present with the detail above, written iff the state changed; a refused or no-op stage writes nothing); relay: two attempts → two `extract` events, attempt 1 and 2, each with its own `raw_reply` blob; `prompt_user` equals `extractUserText()` for the stored post; `asSent` is true when `x-saves-prompt-sha` matches and false (status `warn`, summary "The extension sent a different prompt (an older version)") when not; filter's first use writes a `prompt_versions` row for `filter-1`, the relay's for the version its header names (the system text from `EXTRACT_SYSTEM_TEXT()` when the header names the Worker's own version; otherwise the row is not written and the event says "an older extension's prompt"), the judge's for `match-2`; `batchDetail`'s "Check this" reasons (`checkWhyOf`, audit bug 4) come from the post's `match`/`check` events when they exist — a judge that never answered reads "the matcher couldn't decide", an inferred dose reads "the dose was the reader's guess" — and fall back to today's rebuild only for old posts.
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** add each stage's trail statements to the batch that already writes its state (`finish` in filter and relay become `runAtomically` of the update and the trail statements; `matchPost` adds its events to its `runAtomically`); relay timing with `Date.now()` around `callGateway`; `callGateway` returns `content` whole (already) — store it; `extractUserText()` comes from Task 9.
- [ ] **Step 4:** run every saves suite and update statement pins (relay ≤ 24 on the happy path; name the new count in each pin's comment) — PASS.
- [ ] **Step 5:** commit `feat(saves): every stage writes its trail with its state — inputs, decisions, raw replies, the prompt as sent`.

### Task 9: The prompt as sent

**Files:** Modify `packages/saves/src/prompts.ts`; `apps/saves-extension/src/check.ts`, `app-client.ts`; Test `packages/saves/test/prompts.test.ts`, `apps/saves-extension/test/check.test.ts`, `app-client.test.ts`

**Interfaces — Produces:** `extractUserText(args: Omit<ExtractBodyArgs, "model"|"video"|"videoUrl"|"images"|"maxTokens">): string` (what `buildExtractBody` puts in its text part — `buildExtractBody` calls it); `promptSha(text: string): Promise<string>` (hex sha-256 via `crypto.subtle`); `EXTRACT_SYSTEM_TEXT(): string` exported for the registry. Headers the extension sends with `/extract`: `x-saves-prompt-version: extract-4`, `x-saves-prompt-sha: <hex>`.

- [ ] **Step 1: failing tests**: `buildExtractBody`'s text part equals `extractUserText` for the same args; the extension's extract call carries both headers and the sha of its text part; the Worker's relay (Task 8 test) compares them.
- [ ] **Step 2–4:** implement, run — PASS.
- [ ] **Step 5:** commit `feat(saves): the reading's prompt is versioned on the wire and checkable — the extension sends its hash`.

### Task 10: The extension tells the app what it read and what failed

**Files:** Modify `packages/saves/src/schemas.ts` (`postSubmitSchema.readFacts`), `apps/saves-extension/src/check.ts`, `feed.ts`, `app-client.ts`, `background.ts`, `apps/worker/src/routes/saves.ts`, `saves-ledger.ts`; Tests extension `check.test.ts`, worker `saves-routes.test.ts`

**Interfaces — Produces:** `readFacts?: { via: "saved_list" | "pasted"; extVersion: string; page?: number; coverSent: boolean; mediaCount: number }` on a submit (≤ 2 KB; strict); on extract, header `x-saves-read-facts` (JSON ≤ 1 KB: `{variantWidth, bytes, byLink, images}`); `POST /api/saves/read-failed` body `{ source, key?, url?, code: SaveErrorCode, message ≤ 300 }` → writes a `read` event with status `fail` on the post when known (else on a per-user `extension` pseudo-post: `post_id = "ext:<source>"`, which the health reads) — 2 statements.

- [ ] **Step 1: failing tests**: a submit's `readFacts` lands as the `read` event (source `instagram`, status `ok`, detail = facts); an extract's read-facts header lands in that attempt's `extract` event; a check that ends with `login_needed` posts `/read-failed` once with that code; a `MediaError` posts `/read-failed` with `media_failed` (in addition to today's `reportFailed`).
- [ ] **Step 2–4:** implement, run both suites — PASS.
- [ ] **Step 5:** commit `feat(saves-extension): the read is on the trail — what was fetched, and what failed before the app saw a post`.

### Task 11: Reading one post's trail

**Files:** Create `apps/worker/src/services/import-trail-read.ts`; Modify `apps/worker/src/routes/my-saves.ts`, `packages/api-client/src/*` (client + DTO re-export); Test `apps/worker/test/my-saves-trail.test.ts`

**Interfaces — Produces:**
```ts
export interface ImportTrailDto { post: { id; source; url; title: string|null; creator: {handle; name?}; mediaType;
  postedAt; firstSeenAt; status; origin: "saved"|"pasted"|null; durationSec: number|null; videoSeen: boolean|null };
  account: { kind: string|null; summary: string|null; moves: { position; name; outcome: "new"|"yours"|"library"; moveId|null; purpose: string|null }[];
    health: { status: TrailStatus; line: string } };
  events: TrailEventDto[]; rebuilt: boolean }
GET /api/my-saves/posts/:id/trail → ImportTrailDto (≤ 6 statements)   GET /api/my-saves/blobs/:id → { id, kind, text, cut }
api.saveTrail(postId), api.saveBlob(blobId)
```
- [ ] **Step 1: failing tests**: a post walked through the stages returns its events oldest first, each with its blob list; the account's moves come from the extraction and links; an old post (no events) returns `rebuilt: true` with events built from columns (screen from `filter_*`, extract from `extraction`, match from links), each `rebuilt: true`; another user's post or blob is 404; the account's health line is "Read cleanly" when every event is `ok`, else the worst event's summary.
- [ ] **Step 2–4:** implement; run with the statement pin — PASS.
- [ ] **Step 5:** commit `feat(saves): one post's trail, oldest first, with an account on top — old posts rebuilt and labelled`.

### Task 12: Health lights

**Files:** Create `apps/worker/src/services/import-health.ts`; Modify `routes/saves.ts`, `routes/my-saves.ts`, `saves-ledger.ts` (`savesStatus.state`), `apps/saves-extension/src/page-reader.ts:49-66`; Test `apps/worker/test/import-health.test.ts`

**Interfaces — Produces:**
```ts
export const HEALTH_LIGHTS = ["instagram","youtube","screening","reader","matching","coach","budget"] as const;
export interface HealthLightDto { light: (typeof HEALTH_LIGHTS)[number]; color: "green"|"yellow"|"red"|"grey"; line: string|null;
  failures: { postId: string|null; title: string; at: string; why: string }[] }
export interface ImportHealthDto { lights: HealthLightDto[]; worst: string|null }
export async function importHealth(db, userId, now): Promise<ImportHealthDto>  // ≤ 4 statements
GET /api/my-saves/health, GET /api/saves/health (token)
```
Rules (spec §6.5): window 7 days and the last 20 events per light; red = last attempt failed with a stage-wide cause (`login_needed`, `feed_changed`, gateway `401|402|403`, budget exhausted, a fit-in run `failed`) or ≥ 50% of ≥ 4 attempts failed; yellow = a failure since the last success, a retry, budget > 80%, a `videoSeen: false`, no Instagram check in 48 h while checks exist; green otherwise; grey with no events. Lights map: instagram ← `read` events source instagram + `save_checks`; youtube ← `read` source youtube; screening ← `screen`; reader ← `extract`; matching ← `match`; coach ← `coach` events and fit-in runs; budget ← `importSpend`.

- [ ] **Step 1: failing tests**: one test per rule (red by cause, red by ratio, yellow by retry, yellow by budget 85%, grey when empty, green); `worst` is the reddest light's line ("Reader: 3 of 4 readings failed today"); `savesStatus.state` is `"error"` while any light is red (the headline stops reading "Up to date"); page-reader: an HTML 200 that has no login form reads as `feed_changed`, one with a login form as `login_needed`.
- [ ] **Step 2–4:** implement, run — PASS.
- [ ] **Step 5:** commit `feat(saves): health lights per stage and source — red, yellow, green, grey — from the trail`.

### Task 13: The trail sheet and the health row (app)

**Files:** Create `packages/ui/src/screens/saves/trail-model.ts`, `trail-sheet.tsx`, `health-row.tsx`; Modify `packages/ui/src/screens/studio/saves.tsx` (batch rows → trail), `packages/ui/src/screens/settings/saves.tsx` (post rows → trail; health row), `packages/ui/src/screens/studio/coach-saves.tsx` (health row; "What came in" → trail list), `packages/ui/src/styles.css`; Tests `packages/ui/test/trail-model.test.ts`, `trail-sheet.test.tsx`, `health-row.test.tsx`

**Interfaces — Consumes:** Task 11, 12 DTOs. **Produces:** `trailAccount(dto: ImportTrailDto): AccountLine[]` (level 1, spec §3.4 items 1–6), `trailSections(dto): StageSection[]` (level 2: one per stage present, in pipeline order, each `{ stage, title, result: string, status, rows: DetailRow[], blobs }`), `<TrailSheet postId onClose />`, `<HealthRow health compact? onOpen(light) />`.
Stage titles (exact): Reading · Screening · Reading the moves · Checking the reading · Matching · Batch · Your choices · Saved · The coach · Corrections.

- [ ] **Step 1: failing tests** (model): the account's first line is "From <title or creator> · <source> · <when>"; a rebuilt trail's account ends with "Kept from before the trail: the raw replies weren't kept then."; sections appear in pipeline order whatever the events' order; an extract section with two attempts says "2 attempts — the first failed: <first issue>"; a row value longer than 160 chars has `full` set (the sheet shows "Show all"); raw blobs are listed with their size, fetched on open; detail rows never render a JSON string (a nested object renders as key: value lines).
  (sheet): opening renders the account, sections folded; opening a section shows its rows; "Show all" expands a long value; a raw blob opens monospace and copyable; all text set as text (a caption with `<b>` shows the characters).
  (health): all green renders one row with no line; a red light shows the worst line under the row; tapping a light lists its failures, each with Retry where the post can be retried.
- [ ] **Step 2–4:** implement in the coach trail's visual language (reuse `coach-run-fold`, `coach-line` classes and `DetailRow` from `run-model.ts`), both themes, 44 px targets; run `pnpm vitest run packages/ui/test/trail-*.test.* packages/ui/test/health-row.test.tsx packages/ui/test/studio-saves.test.tsx packages/ui/test/settings-*.test.tsx` — PASS.
- [ ] **Step 5:** commit `feat(ui): an import's trail — the account first, each stage one tap down, the raw replies last — and the health row`.

### Task 14: The popup shows health and opens trails

**Files:** Modify `apps/saves-extension/src/status.ts`, `popup.ts`, `popup.css`, `background.ts`, `app-client.ts`; Test `apps/saves-extension/test/status.test.ts`

- [ ] **Step 1: failing tests**: `popupModel` with a health DTO renders seven lights under the headline and the worst line when not all green; the headline is never "Up to date" while a light is red; a post row's link opens `<appUrl>/studio/saves/posts/<id>` (the app route that opens the trail sheet); the status call and the health call are one round trip each (background asks both).
- [ ] **Step 2–4:** implement (plain DOM, `textContent` only); add the app route `/studio/saves/posts/:postId` that renders the Saves screen with the trail sheet open (`packages/ui/src/app.tsx` + `screens/studio/saves.tsx`); run — PASS.
- [ ] **Step 5:** commit `feat(saves-extension): the popup's health row, and every post opens its trail in the app`.

### Task 15: The coach's trail keeps and shows what it read

**Files:** Modify `apps/worker/src/services/coach-runs.ts:1000-1015,1110-1120,2791`, `design-tools/read-saves.ts` (digest), `design-tools/pin-moves.ts` (input words), `packages/ui/src/screens/studio/run-model.ts:390-500,620-670`, `run-view.tsx`, `design-prose.ts:97-117`, `design-context.ts:1263-1265`, `coach-conversation.ts:207,319-331`; Tests `apps/worker/test/coach-runs.test.ts`, `design-read-saves.test.ts`, `packages/ui/test/run-model.test.ts`

**Interfaces — Produces:** a tool may return `digest?: unknown` (≤ 16,000 chars) kept in its `tool_result` payload as `data`; `read_saves`' digest: `{ moves: [{ id, name, new, choice, fields: string[] }], routines: n, insights: n, offset, next }`; payload over `EVENT_PAYLOAD_MAX_CHARS` (raised to 16,000) keeps its words: `{ tooLong: true, words: "<the tool's own one-line summary>" }` — never `{truncated, head}`; `pin_moves` events carry `{ lines: [{ moveId, name, text }], why }`.

- [ ] **Step 1: failing tests**: a `read_saves` tool result event has `payload.data.moves` with the six moves' names; the UI's detail for it lists those names; an old event with `{truncated, head}` renders "Too long to show here" (Review Focus 5); "In full" shows a 2,000-char text whole (no 160 cut) and other values keep a 160-char preview with `full`; a personal move id in a trail note renders as the move's name; a pins card in the conversation shows its `why` at the foot; the next turn's context carries the card's lines and why (`design-context` test).
- [ ] **Step 2–4:** implement, update the coach-runs payload pins, run the coach and UI suites — PASS.
- [ ] **Step 5:** commit `fix(coach): the trail keeps what the coach read and shows it in words — no cut "In full", no raw JSON, names not ids, the card's why kept`.

### Task 16: Land phase 1

- [ ] **Step 1:** full suites: `NODE_OPTIONS=--max-old-space-size=4096 pnpm vitest run` and `TZ=UTC` the same; `pnpm typecheck`; `pnpm --filter @rg/saves-extension build`. All green (rerun a known flake alone before calling it a regression).
- [ ] **Step 2:** render check: the trail sheet, the health row (popup and coach card), the coach trail detail — light and dark, phone and desktop widths — screenshots for the owner.
- [ ] **Step 3:** independent audits (fresh subagents, in parallel): correctness against the spec and this plan; data integrity and statement budgets; privacy (no personal data in the repo; untrusted text rendering); then verifiers on each finding, one fix wave, a scoped re-review.
- [ ] **Step 4:** rebase on `origin/main` (another session is active there), rerun suites, push to `main` (deploys migration 0034 and the Worker), watch CI and Deploy go green.
- [ ] **Step 5:** live check in the owner's browser (read-only): the health row loads, one old post's trail opens rebuilt, a new check writes a real trail. Rebuild the extension into the folder Chrome loads it from (`/Users/kyranadams/src/run-garden/.claude/worktrees/one-workout-system/apps/saves-extension/dist`) and tell the owner to press reload on it in `chrome://extensions`.
