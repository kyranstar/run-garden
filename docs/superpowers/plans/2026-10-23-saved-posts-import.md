# Saved Posts → Moves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's saved posts are read by a private Chrome extension, filtered cheaply, extracted by a video model, deduped and matched into the library (as links on library moves, or as the owner's own moves), and announced by the coach. The coach then fits them in through one approved proposal.

**Architecture:**
- **A shared contract package, `@rg/saves`,** holds the wire schemas, prompts, ids and name normalisation. The extension and the Worker both import it.
- **The Worker is the coordinator:** token routes, ledger tables, budget, filter, the extraction relay, matching, batches, and the owner's review routes.
- **The extension (`apps/saves-extension`, MV3) does what needs the owner's browser:** reading the saved feed and single posts, and fetching media.
- **Personal moves are `ExerciseRecord`s stored per account.** They resolve through one per-request "account library" that is threaded through the parameters the pure packages already take (`ValidateCtx.library`, `EngineData.exercises`, `searchLibrary(records…)`).
- **The coach gains a `saves` opening line, a `read_saves` tool, a context section, and a `move_pins` proposal kind.**

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free plan) with D1/drizzle; React and TanStack Query; zod; Vitest; esbuild (extension build); Chrome MV3; Vercel AI Gateway (OpenAI-compatible `/chat/completions`, with Gemini video input).

**Spec:** `docs/superpowers/specs/2026-10-23-saved-posts-import-design.md` (approved by the owner 2026-10-23: "looks good. run autonomously"). Recon notes with file:line maps are in the gitignored ledger `.superpowers/sdd/2026-10-23-saved-posts-import/recon-*.md`.

## Global Constraints

**Sequencing.** Start only after the 2026-10-23 audit fix wave has merged into this branch. Task 5 reuses stream C's exclusion of spend by `llm_usage` kind.

**Platform limits**
- **Workers Free:** at most 45 D1 statements per request, and about 10 ms of CPU. The Worker never decodes, re-encodes or base64-encodes video; it only streams bodies through. Each route's statement count is pinned by a test.
- **Node:** vitest runs on the default node, with `NODE_OPTIONS=--max-old-space-size=4096`. wrangler needs node 22 on PATH, and only in its own shell.

**Repository**
- **The repo is public.** No saved-post URLs, handles, captions or media in code, fixtures or tests; use synthetic data. Worker code is site-neutral: the source name arrives as data, matched against `SAVE_SOURCE_RE = /^[a-z][a-z0-9._-]{0,39}$/`. Only `apps/saves-extension` may name the site and its endpoints.
- **Migration:** a single `0029_saved_posts.sql`. Set `SCHEMA_VERSION = "0029"`. Register every new table in `account-tables.ts`.

**Wiring**
- **Switches** (`env.ts`, documented the same way as the existing ones):
  - `SAVES_IMPORT` (Var, `"1"` turns the feature on; absent means every saves route is 404)
  - `SAVES_TOKEN_SHA256` (Secret)
  - `SAVES_HOLD_BATCHES` (Var, `"1"` means new batches are created `held`)
- **Token routes** live under `/api/saves/*`. They are bearer-only, never cookie, and are exempt from `originGuard`.
- **Owner routes** live under `/api/my-saves/*` and use cookie auth (`requireUser`).

**Personal moves**
- **Id:** `PERSONAL_ID_RE = /^my[A-Z][A-Za-z0-9]{1,60}$/`, at most 80 characters, and no `EXERCISES` id may match it.
- **Status:** `pending` → `active` → `archived` | `merged`.
  - A pending move is read only by the review routes.
  - An active move is resolvable and offered.
  - An archived move is resolvable but never offered.
  - The engine pool holds active moves that are also pinned.
- **Saving:** nothing from a batch is used until the batch is saved. Links reach `exercise_provenance` only on save.

**Budget**
- Import spend uses the kinds `import_filter`, `import_extract` and `import_match`.
- The cap is `IMPORT_BUDGET_MICROS = 5_000_000` per rolling 30 days.
- This spend is excluded from the coach's budget, its auto-read reserve, and `weekCanPay`.

**Cadence**
- The extension's alarm fires every 360 min, with ±30 min of jitter.
- A check reads at most 20 feed pages and at most 20 work-list posts.
- At most one batch is released per 20 h.
- An extraction is retried at most 3 times in all.

**Copy, exactly**
- **Notice:** `From your saves: {n} new move(s) ({breakdown}), {m} you already had.`
  - With `m = 0`, drop `, {m} you already had`.
  - With `n = 0`, it reads `From your saves: {m} move(s) you already had.`
  - The breakdown is at most 3 groups, e.g. `2 hip, 1 neck, 1 jump`.
- **Chips:** `See them` (opens the batch) and `Fit these in`, with request `Fit the new moves from my saves into my training.`
- **Review screen:** `From your saves`, `New`, `Linked to {name}`, `Check this`, `Edit`, `Not this move`, `Same as…`, `Remove`, `Ask the coach`, `Save these`.
- **Settings:**
  - Row title: `Saves`
  - Line: `Last import {ago} · {moves} moves from {posts} posts`
  - When stale: `Last check {n} days ago`
  - When over budget: `Paused — import budget`
- **Extension popup states:** `Up to date`, `Instagram wants you to log in again`, `Instagram changed something — the extension needs an update`, `Paused — import budget`, `App unreachable`, `Error: {message}`. Buttons: `Check now`, `Process anyway`, `Retry`.

**Rules for every change**
- **Untrusted text:** captions, creator names and model-written text reach the coach only through `untrusted()` / `untrustedOrNull()` (`read-common.ts`). The extraction prompt treats all post content as data.
- **UI:** design tokens only, 44 px targets, both themes, and the owner's density rule (data, names and links; no explainer captions).
- **Commits:** small, in the repo's style, ending with the session trailer lines. Never push from a task.

## Review Focus

1. **A re-saved old post jumps to the top of the feed above new saves.** The stop rule must not stop at the first known post. It stops on a page that is all known, or after 12 known posts in a row. Pinned in Task 9 (`feed.test.ts`: "a re-saved known post above two new ones doesn't stop the check").
2. **A backlog longer than 20 pages after a long gap.** The next check continues where it left off, re-reading nothing already submitted. Pinned in Task 9 ("a 25-page backlog finishes on the second check").
3. **The same move under different spellings or across posts.** "90/90 Hip Switch", "90-90 hip switches" and "the 90 90 switch" match each other and the library move. Two posts with the same new move in one batch make one personal move with two links. Pinned in Task 8.
4. **An archived or merged personal move still referenced by an old workout, history or a pin.** It still resolves for history and builds. It is never offered in search or to the engine. A merged id resolves to its target. Pinned in Tasks 13 and 14.
5. **The import budget at its edge.** The call that would cross $5/30 d is not made, and the post waits `queued` with `budget_paused`. Coach spend is unaffected, and import spend never moves `llmBudgetStatus`. Pinned in Task 5.

---

## Phase A — the pipeline

### Task 1: `@rg/saves`, the shared contract

**Files:**
- Create: `packages/saves/{package.json,tsconfig.json,vitest.config.ts}`, `packages/saves/src/{index.ts,schemas.ts,ids.ts,normalize.ts,prompts.ts,breakdown.ts}`
- Test: `packages/saves/test/{schemas,ids,normalize,prompts,breakdown}.test.ts`

**Interfaces:**
- **Consumes:**
  - `@rg/exercise-library` vocab arrays (patterns, regions, equipment, position, laterality, load, contraction, dose types) and `PROFILES`;
  - `ExerciseRecord`.
- **Produces:**
  - **Wire constants and enums:**
    - `SAVE_SOURCE_RE`
    - `SavePostStatus = "seen"|"filtered_out"|"queued"|"extracting"|"extracted"|"matched"|"failed"|"skipped_by_owner"|"reference_only"`
    - `SaveErrorCode = "login_needed"|"feed_changed"|"app_unreachable"|"budget_paused"|"media_failed"|"model_failed"|"too_large"|"gone"|"unknown"`
  - **`postSubmitSchema` / `PostSubmit`:**
    - Fields: `{ source, key (≤64), url (https, ≤500), creator: {handle ≤64, name? ≤120}, caption (≤4000), hashtags (≤30×≤60), mediaType: "video"|"carousel"|"image", postedAt?: string|null, cover?: {mime: "image/jpeg"|"image/png"|"image/webp", base64 ≤ 400_000 chars}, seed?: {status: "queued"|"filtered_out", reason ≤160} }`
    - The schema is strict.
  - **`filterVerdictSchema`:** `{ verdict: "training"|"maybe"|"not", reason ≤160 }`
  - **`extractedMoveSchema` / `ExtractedMove`:**
    - **Text:** `name ≤80`, `aliases ≤5`, `summary ≤160`, `steps ≤8×≤200`, `cues ≤6×≤160`, `mistakes ≤5×≤160`, `purpose ≤160`
    - **Dose:** `{text ≤80, type?, range?: [n,n], sets?: [n,n]}`
    - **Vocab fields** (every one from the library's vocab arrays): `patterns`, `regions`, `equipment`, `position`, `laterality`, `load`, `contraction`, `difficulty 1–5`
    - **Conditions:** `conditions: Record<profileId, {attrs: Record<string, number|boolean>, note ≤160}>`, covering every profile in `PROFILES`
    - **Other:** `corosHint? ≤60`, `evidence: {name, dose, steps: "stated"|"inferred"}`, `confidence: "high"|"medium"|"low"`
  - **`extractionSchema` / `Extraction`:** `{ kind: "routine"|"single_move"|"tips"|"not_training", summary ≤300, themes ≤5×≤40, moves: ExtractedMove[] ≤12, routine?: {rounds?, restSec?, order: number[]} }`
  - **`checkReportSchema`:** `{ checkId (uuid), phase: "start"|"finish", found?, fresh?, filtered?, extracted?, failed?, error?: {code: SaveErrorCode, message ≤200} }`
  - **`SavesStatusDto`:**
    - `{ state: "ok"|"login_needed"|"feed_changed"|"paused_budget"|"error"|"idle", lastCheckAt, checks: CheckRowDto[] ≤10, posts: PostRowDto[] ≤30, spend: {spentMicros, capMicros} }`
    - `PostRowDto = {key, url, creator, status, reason, updatedAt}`
  - **Ids:**
    - `PERSONAL_ID_RE`
    - `personalMoveId(name: string, salt: string): string`: `"my"` + the PascalCase words of the ASCII-folded name, cut to 40 characters, + 6 base36 characters of an FNV-1a hash of `salt`.
    - `isPersonalId(id: string): boolean`
  - **`normalizeMoveName(name: string): string`:** lower-case and ASCII-fold; `/`, `-` and `_` become spaces; drop `the|a|an|with|your`; strip a trailing plural `s`/`es` per word; collapse spaces.
  - **`moveGroup(m: Pick<ExerciseRecord,"regions"|"contraction">): "jump"|"hip"|"neck"|"upper back"|"shoulder"|"core"|"leg"|"other"`.** It returns `jump` when `isPlyometric`. Otherwise it maps the first region: hips/glutes → hip, neck/jaw → neck, thoracic/upper back → upper back, shoulders → shoulder, core/trunk → core, any leg region → leg, anything else → other.
  - **`batchNotice(newMoves: Pick<ExerciseRecord,"regions"|"contraction">[], linked: number): string`:** the exact notice copy (Global Constraints).
  - **Prompts:**
    - `FILTER_PROMPT_VERSION`
    - `filterMessages(post: PostSubmit): {system: string; userText: string}`
    - `EXTRACT_PROMPT_VERSION`
    - `buildExtractBody(args: {model: string; post: Pick<PostSubmit,"caption"|"hashtags"|"creator"|"mediaType">; video?: {mime: string; base64: string}; images: {mime: string; base64: string}[]; libraryNames: string[]; retryIssues?: string[]; maxTokens: number}): string`
      - It returns the gateway JSON with `"model"` as the first key.
      - The content parts are: text (instructions + caption as data), then `{"type":"file","file":{"filename":"post.mp4","file_data":"data:video/mp4;base64,…"}}`, then the images as `image_url` data URLs.

- [ ] **Step 1: Write the failing tests**
  - **schemas:**
    - every schema rejects unknown keys and over-length fields;
    - an `ExtractedMove` missing a profile's condition rating is rejected;
    - vocab values outside the library's arrays are rejected.
  - **ids:**
    - `personalMoveId("90/90 Hip Switch", "u1:k1")` matches `PERSONAL_ID_RE` and is stable;
    - different salts give different ids;
    - `EXERCISES.filter(e => PERSONAL_ID_RE.test(e.id))` is empty.
  - **normalize:** `normalizeMoveName` maps "90/90 Hip Switch", "90-90 hip switches" and "the 90 90 switch" to the same string (Review Focus 3).
  - **breakdown:**
    - `batchNotice` gives `From your saves: 4 new moves (2 hip, 1 neck, 1 jump), 3 you already had.` for a fixture;
    - with 1 new and 0 linked: `From your saves: 1 new move (hip).`;
    - with 0 new and 2 linked: `From your saves: 2 moves you already had.`
  - **prompts:**
    - `buildExtractBody(...)` starts with `{"model":"`;
    - it parses as JSON;
    - it carries the file part;
    - the caption appears only inside the data-marked block.
- [ ] **Step 2:** Run `pnpm vitest run packages/saves`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement. The package follows the repo pattern: `"type": "module"`, `exports` pointing at `./src/index.ts`, a `typecheck` script, and its own `vitest.config.ts`.
- [ ] **Step 4:** Run `pnpm vitest run packages/saves && pnpm --filter @rg/saves typecheck`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): the shared contract — wire schemas, personal ids, name normalising, the notice, prompts`.

### Task 2: Tables (migration 0029)

**Files:**
- Create: `packages/database/migrations/0029_saved_posts.sql`, `packages/database/src/schema/saves.ts`
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/version.ts` (`"0029"`), `apps/worker/src/services/account-tables.ts`
- Test: `packages/database/test/{migrations,schema-version}.test.ts` (existing), `apps/worker/test/account-tables.test.ts` (existing), and new `packages/database/test/saves-schema.test.ts`

**Interfaces:**
- **Produces drizzle tables:**
  - `savedPosts` (`saved_posts`):
    - Columns: `id` (text PK, `sha256(user:source:key)` as a uuid), `user_id`, `source`, `source_key`, `url`, `creator_handle`, `creator_name`, `caption`, `hashtags` (json), `media_type`, `posted_at`, `first_seen_at`, `status`, `filter_verdict`, `filter_reason`, `filter_stage` (`"creator"|"keyword"|"model"|"owner"|"seed"`), `extraction` (json), `extract_attempts` (int), `last_error_code`, `last_error`, `cost_micros` (int), `batch_id`, `seeded` (bool), `updated_at`.
    - Unique: `(user_id, source, source_key)`. Index: `(user_id, status, updated_at)`.
  - `saveChecks` (`save_checks`):
    - Columns: `id` (the client's checkId), `user_id`, `started_at`, `finished_at`, `found`, `fresh`, `filtered`, `extracted`, `failed`, `error_code`, `error_message`.
    - Index: `(user_id, started_at)`.
  - `saveBatches` (`save_batches`):
    - Columns: `id`, `user_id`, `status` (`"held"|"released"|"saved"|"dismissed"`), `theme`, `created_at`, `released_at`, `saved_at`, `fitted_at`, `notice` (text).
    - Index: `(user_id, status, released_at)`.
  - `personalMoves` (`personal_moves`):
    - Columns: `id` (the personal id, PK), `user_id`, `status`, `merged_into`, `batch_id`, `record` (json `ExerciseRecord`), `edited_by_owner` (bool), `created_at`, `updated_at`.
    - Index: `(user_id, status)`.
  - `savedPostMoves` (`saved_post_moves`):
    - Columns: `id`, `user_id`, `post_id`, `position`, `move_id`, `move_kind` (`"library"|"personal"`), `batch_id`, `confidence`, `check_flag` (bool), `status` (`"pending"|"saved"|"removed"`), `created_at`.
    - Unique: `(post_id, position)`. Index: `(user_id, batch_id)`.
- **Registration:** all five tables are registered `USER` in `ENTRIES`. None has secret-looking columns.
- **Row types** (exported from the schema file): `SavedPostRow = typeof savedPosts.$inferSelect`, `PersonalMoveRow = typeof personalMoves.$inferSelect`, `SaveBatchRow = typeof saveBatches.$inferSelect`, `SavedPostMoveRow = typeof savedPostMoves.$inferSelect`.

- [ ] **Step 1:** Write the failing `saves-schema.test.ts`.
  - It inserts a post twice with the same `(user, source, key)` and expects the unique-index failure.
  - It inserts a move and two post-moves at different positions.
  - Running the existing `migrations` / `schema-version` / `account-tables` tests now fails on the version and the registration.
- [ ] **Step 2:** Run `pnpm vitest run packages/database apps/worker/test/account-tables.test.ts`. Expect FAIL.
- [ ] **Step 3:** Write the migration. Use a `-- 0029:` header, `--> statement-breakpoint` between statements, a single `id` PK per table, ISO text timestamps, and JSON in text columns. Then write the schema file, the barrel export, the version, and the registrations.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(database): 0029 — saved posts, checks, batches, personal moves, post moves`.

### Task 3: Token routes, the switch and the ledger basics

**Files:**
- Create: `apps/worker/src/routes/saves.ts`, `apps/worker/src/services/saves-ledger.ts`, `apps/worker/src/auth/token.ts`
- Modify: `apps/worker/src/routes/lifeos.ts` (use the shared token helper), `apps/worker/src/env.ts`, `apps/worker/src/index.ts` (mount `/api/saves`; exempt `/api/saves/` from `originGuard`), `apps/worker/wrangler.toml` (`SAVES_IMPORT` absent in prod until Task 20; `"1"` under `[env.staging.vars]`)
- Test: `apps/worker/test/saves-routes.test.ts`, `apps/worker/test/lifeos-plan.test.ts` (must stay green)

**Interfaces:**
- **Consumes:** Task 1's schemas and Task 2's tables.
- **Produces:**
  - `export function sameHex(a: string, b: string): boolean` and `export function bearerGuard(secretOf: (env: Env) => string | undefined): MiddlewareHandler<AppContext>`, both in `auth/token.ts`.
    - `bearerGuard` gives 404 `not_found` without the secret and 401 `unauthenticated` on a bad token.
    - It resolves the owner by `ALLOWED_GOOGLE_EMAIL`, as lifeos does, and sets `c.set("userId")`.
    - It gives 503 while a restore is in progress.
  - `export const savesImportEnabled = (env: Env | undefined): boolean => env?.SAVES_IMPORT === "1"`
  - **Routes** (`savesRoutes`; all 404 unless `savesImportEnabled`; `Cache-Control: no-store`):
    - `POST /checks`: body `checkReportSchema`. `start` upserts a row; `finish` sets the counts and the error, then calls `assembleBatch` (Task 8). Returns `{ ok: true }`.
    - `POST /known`: body `{ source, keys: string[] ≤ 200 }`. Returns `{ fresh: string[] }`, in input order.
    - `POST /posts`: body `PostSubmit`. Idempotent upsert by `(source, key)`; a known post returns its current row. Then runs the filter (Task 6). Returns `{ status: SavePostStatus, verdict?, reason? }`.
    - `GET /work`: returns `{ keys: {source, key, url}[] ≤ 20 }`. These are posts that are `queued` with no extraction, or `failed` with `extract_attempts < 3` and a retryable `last_error_code`, oldest first.
    - `GET /status`: returns `SavesStatusDto`. Its spend comes from Task 5.
  - **Ledger services** in `saves-ledger.ts`:
    - `upsertPost(db, userId, p: PostSubmit, now): Promise<SavedPostRow>`
    - `freshKeys(db, userId, source, keys): Promise<string[]>`
    - `workList(db, userId, limit): Promise<…>`
    - `recordCheck(db, userId, r, now)`
    - `savesStatus(db, userId, now): Promise<SavesStatusDto>`

- [ ] **Step 1: Write the failing tests** (pattern: `lifeos-plan.test.ts`, `makeEnv` + `mountRoutes`)
  - 404 without `SAVES_IMPORT`, and 404 without the secret.
  - 401 with a wrong token.
  - A POST carrying `Origin: chrome-extension://abc` is not 403.
  - A cookie alone is 401.
  - `/known` returns only unseen keys, in input order.
  - A second `/posts` with the same key changes nothing (row count 1, same `first_seen_at`).
  - `/work` lists a seeded `queued` post and a `failed` one with 2 attempts, but not one with 3.
  - Statements are pinned: `/posts` ≤ 8 (excluding the filter's model call), `/known` ≤ 3, `/status` ≤ 5, `/checks` finish ≤ 4 plus `assembleBatch`'s count.
  - lifeos tests still pass with the shared helper.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/saves-routes.test.ts apps/worker/test/lifeos-plan.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The `originGuard` exemption is a path-prefix check on `/api/saves/` only, with a comment explaining that the routes are bearer-only and never read the session cookie.
  - The filter call inside `/posts` is a stub returning `queued` until Task 6.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): token routes behind SAVES_IMPORT — known, posts, work, checks, status`.

### Task 4: Owner routes and Settings → Saves (observability in the app)

**Files:**
- Create: `apps/worker/src/routes/my-saves.ts`, `packages/ui/src/screens/settings/saves.tsx`
- Modify: `apps/worker/src/index.ts`, `packages/api-client/src/index.ts`, `packages/ui/src/screens/settings.tsx` (a `<SavesSection />` in the "Coach & AI" group, shown only when the status read answers 200)
- Test: `apps/worker/test/my-saves-routes.test.ts`, `packages/ui/test/settings-saves.test.tsx`

**Interfaces:**
- **Consumes:** `savesStatus` (Task 3).
- **Produces:**
  - **Cookie routes** (`/api/my-saves`, `requireUser`, 404 unless `savesImportEnabled`):
    - `GET /status`: `SavesStatusDto`.
    - `POST /posts/:id/override`, body `{ action: "process"|"skip"|"reference" }`:
      - `process` sets a `filtered_out` or `failed` post back to `queued`, sets `filter_stage = "owner"`, and resets attempts.
      - `skip` sets `skipped_by_owner`.
      - `reference` sets `reference_only`: the post's links are kept, and its routine is never offered as a whole.
    - The service is `overridePost(db, userId, by: {id} | {source, key}, action, now)`. Task 10's token route reuses it.
  - **API client:** `api.savesStatus()`, `api.savesOverride(id, action)`, and query key `SAVES_STATUS_QUERY = ["saves-status"] as const`.
  - **UI:** `SavesSection`.
    - One `place-row` with title `Saves`, whose line is the copy from Global Constraints (`Last import …`, or `Last check {n} days ago` when the last check is 7 or more days old, or `Paused — import budget`).
    - It opens a `Sheet` listing the posts: creator, status, reason, the link (opens in a new tab), and `Process anyway` / `Retry` where they apply.

- [ ] **Step 1: Write the failing tests**
  - Worker:
    - override `process` on a `filtered_out` post makes it `queued`, with `filter_stage "owner"`;
    - `skip` works;
    - another user's post is 404.
  - UI:
    - the row shows `Last check 8 days ago` for a stale status, and `Paused — import budget` when the state is `paused_budget`;
    - the sheet lists a post with its link;
    - `Process anyway` calls the override.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/my-saves-routes.test.ts packages/ui/test/settings-saves.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): Settings → Saves — what the import did, with Process anyway`.

### Task 5: The import budget, kept apart from the coach's

**Files:**
- Create: `apps/worker/src/services/saves-budget.ts`
- Modify: wherever stream C's kind exclusion lives (find it with `git log --grep "stream C"`; it will be in `llm.ts` / `coach-runs.ts` / `coach-reads.ts`). Add `import_` to the excluded kinds. Also add the chosen Gemini models to `MODEL_PRICES` (`llm-messages.ts`), with prices copied from `GET https://ai-gateway.vercel.sh/v1/models`.
- Test: `apps/worker/test/saves-budget.test.ts`

**Interfaces:**
- **Produces:**
  - `IMPORT_KINDS = { filter: "import_filter", extract: "import_extract", match: "import_match" } as const`
  - `IMPORT_BUDGET_MICROS = 5_000_000`
  - `IMPORT_WINDOW_DAYS = 30`
  - `importSpend(db, userId, now): Promise<{ spentMicros: number; capMicros: number }>`
  - `reserveImport(db, userId, kind, model, worstMicros, now): Promise<{ ok: true; usageId: string } | { ok: false; reason: "budget_paused" }>`
    - It inserts an `llm_usage` row at the worst case, with fingerprint mark `;est=`.
    - It refuses when `spent + worst > cap`.
  - `settleImport(db, usageId, actual: { model; inputTokens; outputTokens; costMicros } | null): Promise<void>`. Passing `null` zeroes the row.

- [ ] **Step 1: Write the failing tests**
  - Reserve at $4.99 spent with a $0.02 worst case is refused `budget_paused` (Review Focus 5).
  - After a settle, spend equals the actual cost.
  - `llmBudgetStatus` and the auto-read reserve ignore `import_*` rows: with $19 of import spend, `llmBudgetStatus(...).spentMicros` is 0.
  - A stale `;est=` reservation older than 15 minutes counts at its estimate.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/saves-budget.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Reuse stream C's exclusion predicate; don't add a second one.
- [ ] **Step 4:** Run the Step 2 command, plus `apps/worker/test/coach-reads*.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): the import budget — $5 per 30 days, reserved then settled, never the coach's`.

### Task 6: The cheap filter

**Files:**
- Create: `apps/worker/src/services/saves-filter.ts`
- Modify: `apps/worker/src/routes/saves.ts` (`/posts` calls the filter)
- Test: `apps/worker/test/saves-filter.test.ts`

**Interfaces:**
- **Consumes:**
  - `PostSubmit`, `filterMessages` and `filterVerdictSchema` (Task 1);
  - `reserveImport` / `settleImport` (Task 5);
  - an injected `fetchImpl` (the test pattern used for `chatCompletion`).
- **Produces:**
  - `FILTER_MODEL_DEFAULT` (a string, set from probe R3, Task 19). Overridable by the `SAVES_FILTER_MODEL` Var.
  - `TRAINING_WORDS: readonly string[]`, e.g. `["workout","sets","reps","mobility","stretch","drill","exercise","routine","warm up","hold","rounds"]`.
  - `filterPost(db, env, userId, post: SavedPostRow & {cover?}, now, fetchImpl): Promise<{ status: "filtered_out"|"queued"; verdict: "training"|"maybe"|"not"; stage: "creator"|"keyword"|"model"|"seed"; reason: string }>`
    - **seed:** a `seed` from the submit decides.
    - **creator:** if the creator's earlier decided posts are at least 3 and all one verdict, that verdict decides (one statement).
    - **keyword:** only promotes a post to the model step; it never rejects.
    - **model:** an OpenAI-compatible call with the caption text, plus the cover as an `image_url` data URL when present, at `max_tokens` 120.
      - The result is parsed with `filterVerdictSchema`.
      - A parse failure counts as `maybe`, with reason "unclear".
      - `maybe` and `training` lead to `queued`; `not` leads to `filtered_out`.
    - **budget:** when the budget refuses, the post stays `seen`, `last_error_code = "budget_paused"`, and the response carries the status.

- [ ] **Step 1: Write the failing tests** (a fake gateway via `fetchImpl`)
  - A creator with 3 earlier training posts makes no model call and gives `queued` with stage `creator`.
  - A model answer of `not` gives `filtered_out` with the model's reason.
  - Malformed model JSON gives `queued` with reason "unclear".
  - Budget refused gives status `seen` with `budget_paused`.
  - The usage row has kind `import_filter`.
  - The model request carries the cover as an `image_url` part, and the caption only inside the data block.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/saves-filter.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): the cheap filter — creator history, then a small model on caption and cover`.

### Task 7: The extraction relay

**Files:**
- Create: `apps/worker/src/services/saves-relay.ts`
- Modify: `apps/worker/src/routes/saves.ts` (`POST /posts/:key/extract`)
- Test: `apps/worker/test/saves-relay.test.ts`

**Interfaces:**
- **Consumes:**
  - Task 5's reserve/settle;
  - `extractionSchema` (Task 1);
  - env `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL`.
- **Produces:**
  - The route `POST /api/saves/posts/:key/extract?source=…`.
    - **Headers:** `x-saves-model` (must be in `EXTRACT_MODELS`, an allowlist set from R3) and `x-saves-max-tokens` (≤ 4000).
    - **Body:** the gateway JSON from `buildExtractBody`.
    - **Limit:** `content-length` ≤ `RELAY_MAX_BYTES` (default 20_000_000; R2 sets the real value).
  - `relayExtract(db, env, userId, post, req: Request, now, fetchImpl): Promise<{ ok: true; extraction: Extraction } | { ok: false; code: SaveErrorCode; issues?: string[] }>`
    1. Reserve the worst case: `(content-length / 4 + maxTokens)` priced by `MODEL_PRICES[model]`.
    2. Mark the post `extracting`.
    3. `fetch(gateway /chat/completions, { body: req.body, duplex: "half" })`. The body stream is never read or parsed by the Worker.
    4. Parse the gateway's (small) JSON response: `choices[0].message.content`, `usage`, `model`.
    5. Settle the reservation.
    6. Increment `extract_attempts`.
    7. Parse the content as JSON with `extractionSchema`.
  - **Outcomes:**
    - **Success:** stores the extraction and calls `matchPost` (Task 8).
    - **Failure:** returns `{ok: false, code: "model_failed", issues}`. The extension retries once with `retryIssues`.
    - **413 from the gateway:** returns `code: "too_large"`.
    - **402:** recorded through `recordOutOfCredits`, `code: "model_failed"`.
    - **A response model outside the allowlist:** settled at the real cost and refused with `code: "model_failed"`.
  - `EXTRACT_MODELS: readonly string[]` and `EXTRACT_MODEL_DEFAULT` (from R3).

- [ ] **Step 1: Write the failing tests** (a fake gateway that echoes byte counts)
  - The body reaches the gateway byte-identical (compare a hash).
  - The reservation is inserted before the call and settled after.
  - A content-length above the cap is a 413 without a gateway call.
  - Schema-invalid content gives `model_failed` with issues, and `extract_attempts` becomes 1.
  - A gateway 413 gives `too_large`.
  - A model not in the allowlist in the header gives a 400 and no call.
  - Statements are pinned at ≤ 7, excluding `matchPost`.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/saves-relay.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): the extraction relay — the body streams through untouched, spend reserved and settled`.

### Task 8: Matching, dedupe, pending moves and batches

**Files:**
- Create: `apps/worker/src/services/saves-match.ts`, `apps/worker/src/services/saves-batches.ts`, `apps/worker/src/services/personal-moves.ts`
- Test: `apps/worker/test/saves-match.test.ts`, `apps/worker/test/saves-batches.test.ts`

**Interfaces:**
- **Consumes:**
  - `normalizeMoveName`, `personalMoveId` and `batchNotice` (Task 1);
  - `EXERCISES`;
  - Task 2's tables;
  - `validatePersonalRecord` and `toPersonalRecord` (Task 11). Until Task 11 lands, matching stores the draft as the record; Task 11 adds the build and the check there.
- **Produces:**
  - **`matchMoves(extraction: Extraction, library: readonly ExerciseRecord[], personal: readonly PersonalMoveRow[]): MatchDecision[]`**, where `MatchDecision = { position; kind: "library"|"personal"|"new"; id?: string; confidence: "high"|"medium"|"low"; check: boolean; draft?: ExtractedMove }`. In order:
    1. The normalised name or any normalised alias equals a library record's normalised name or legacy id gives `library`, `high`.
    2. The same test against active, pending or archived personal moves gives `personal`, `high`. A merged move resolves to its `merged_into`.
    3. Otherwise, a token-overlap score of at least 0.6 against library names gives a candidate, judged by step 4.
    4. Candidates go to `judgeMatches(env, candidates, fetchImpl)`: one cheap model call per post, kind `import_match`. Yes means `medium` with `check: true`; no means `new`.
    5. Within one post, and across posts in the same batch, two `new` moves with equal normalised names become one personal move.
  - **`matchPost(db, env, userId, postId, now, fetchImpl): Promise<{ newMoves: number; linked: number }>`**
    - It writes the pending personal moves (`status pending`, `batch_id` null for now) and the `saved_post_moves` rows (`status pending`), and sets the post to `matched`.
    - A move the owner has edited (`edited_by_owner`) is never rewritten; later posts only add links.
  - **`assembleBatch(db, env, userId, now): Promise<string | null>`**
    - It gathers `matched` posts with no `batch_id`.
    - It does nothing if a batch was released less than 20 h ago, or if no posts are waiting.
    - Otherwise it creates the batch (`held` when `SAVES_HOLD_BATCHES === "1"`, else `released` with `released_at` and `notice = batchNotice(...)`), and sets `batch_id` on those posts, their post-moves, and their pending personal moves.
  - **`saveBatch(db, userId, batchId, now): Promise<{ moves: number; links: number }>`**
    - It sets the batch's pending personal moves to `active` and its pending post-moves to `saved`.
    - It upserts `exercise_provenance` rows (`exercise_id = move_id`, `source_type = post.source`, `source_key = post.source_key + "#" + position`, url, creator).
    - It sets the batch to `saved`, with `saved_at`.
    - It runs in chunks within 45 statements and is idempotent.

- [ ] **Step 1: Write the failing tests**
  - **Matching:**
    - Review Focus 3: the spellings match one library move.
    - An extracted name with no near library name becomes `new`.
    - Two posts in one batch with the same new move give one personal move and two post-moves.
    - A re-submitted post changes nothing.
    - An owner-edited personal move keeps its record when a later post matches it, and gains a link.
    - A merged personal move resolves to its target.
    - Judge yes gives `check: true`; the judge's usage kind is `import_match`.
  - **Batches:**
    - A second `assembleBatch` within 20 h returns null.
    - With `SAVES_HOLD_BATCHES=1` the batch is `held`.
    - The notice equals `batchNotice`.
    - `saveBatch` writes provenance only on save, and nothing before it.
    - `saveBatch` twice writes nothing new.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/saves-match.test.ts apps/worker/test/saves-batches.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves): matching and dedupe — links on library moves, one new move however many posts show it, batches held until saved`.

### Task 9: The extension: reading saves and orchestrating a check

**Files:**
- Create: `apps/saves-extension/` containing:
  - `package.json` (devDeps: esbuild, @types/chrome; deps: `@rg/saves`), `tsconfig.json`, `vitest.config.ts`, `build.mjs`, `manifest.json`
  - `src/{background.ts,feed.ts,page-reader.ts,shortcode.ts,media.ts,app-client.ts,queue.ts,check.ts,options.ts,options.html}`
- Test: `apps/saves-extension/test/{feed,shortcode,media,queue,check}.test.ts`

**Interfaces:**
- **Consumes:** `@rg/saves` (schemas, `buildExtractBody`), and the routes from Tasks 3 and 7.
- **Produces:**
  - **`manifest.json` (MV3):**
    - permissions: `alarms`, `storage`, `scripting`, `tabs`
    - host_permissions: `https://www.instagram.com/*`, `https://*.cdninstagram.com/*`, `https://*.fbcdn.net/*`, and the app origin from options
    - background service worker `background.js`; action popup `popup.html`; options page `options.html`
  - **`feed.ts`:**
    - `parseFeedPage(json: unknown): { posts: FeedPost[]; nextMaxId: string | null }`. It throws `FeedChangedError` on an unexpected shape. `FeedPost = { key, url, pk, creator, caption, hashtags, mediaType, postedAt, videoVariants: {width,height,url}[], images: {width,url}[], coverUrl }`.
    - `shouldStop(page: { keys: string[]; fresh: Set<string> }, run: { knownStreak: number }): { stop: boolean; knownStreak: number }`. It stops when every key on the page is known, or when the running streak of known keys reaches 12.
  - **`page-reader.ts`:** functions injected with `chrome.scripting.executeScript` into an instagram.com tab. It opens a background tab when none exists and closes it afterwards.
    - `readSavedPage(maxId: string | null)` fetches `/api/v1/feed/saved/posts/` with header `x-ig-app-id: 936619743392459`, from the page.
    - `readPost(pk: string)` fetches `/api/v1/media/{pk}/info/`.
    - A 401, 403, or a login redirect/HTML response gives `LoginNeededError`.
  - **`shortcode.ts`:** `shortcodeToPk(code: string): string` (BigInt, alphabet `A–Z a–z 0–9 - _`).
  - **`media.ts`:**
    - `pickVariant(variants, minWidth: number): {url,width}`, the smallest at or above `minWidth` (`MIN_VIDEO_WIDTH`, default 480, set by R4), else the largest.
    - `fetchAsBase64(url, fetchImpl): Promise<{mime; base64; bytes}>`
  - **`queue.ts`:** `ExtQueue` persisted in `chrome.storage.local` (adapter injected): `push`, `peek`, `ack`, `size`, with entries `{kind: "submit"|"extract"; source; key; payload?}`.
  - **`check.ts`:** `runCheck(deps: CheckDeps): Promise<CheckSummary>`. `CheckDeps` = `{ app, reader, fetchImpl, queue, now, config }`. The order is:
    1. Report start.
    2. Read pages until `shouldStop` or 20 pages, asking `/known` per page.
    3. Submit each fresh post (cover thumbnail at about 320 px, base64), newest last.
    4. For `queued` posts, fetch media and call extract. On `model_failed` with issues, retry once with `retryIssues`. On `too_large`, retry once at the next smaller variant.
    5. Process `/work` keys (up to 20) through `readPost(shortcodeToPk(key))`, then the same extract path.
    6. Report finish with counts and the first error.
    - Unacked app calls stay in the queue and are replayed first on the next check.
  - **`background.ts`:** `chrome.alarms.create("check", { periodInMinutes: 360 })`, plus jitter by delaying a check 0–30 min. It runs `runCheck` on the alarm and on the popup's `check-now` message, single-flight.
  - **`options.ts`:** stores `{ appUrl, token }` in `chrome.storage.local`. The token is never logged.
  - **`build.mjs`:** esbuild bundles to `dist/`, copies the manifest and the html files, and fills the app origin into host_permissions from `APP_ORIGIN` (default `https://run-garden-api.kyranadams.workers.dev`).

- [ ] **Step 1: Write the failing tests** (pure modules, chrome adapters faked)
  - **feed:** `parseFeedPage` on a synthetic page fixture, and `FeedChangedError` on a shape without `items`.
  - **Review Focus 1:** "a re-saved known post above two new ones doesn't stop the check".
  - **Review Focus 2:** "a 25-page backlog finishes on the second check", with the second check resuming from the queue and `/known`.
  - **shortcode:** `shortcodeToPk("B")` and a known synthetic pair.
  - **media:** `pickVariant` chooses 480 from [360, 480, 720] and 720 from [720, 1080]; when nothing reaches `minWidth`, it falls back to the largest.
  - **queue:** survives a simulated restart.
  - **check:**
    - a `LoginNeededError` ends the check with error `login_needed` and no submits;
    - an app 5xx leaves the entries queued, and the next check sends them first;
    - an extract `model_failed` is retried once with the issues, and `too_large` once smaller.
- [ ] **Step 2:** Run `pnpm vitest run apps/saves-extension`. Expect FAIL.
- [ ] **Step 3:** Implement. Keep chrome APIs behind small adapters, so the modules under test are pure.
- [ ] **Step 4:** Run `pnpm vitest run apps/saves-extension && pnpm --filter @rg/saves-extension typecheck && pnpm --filter @rg/saves-extension build`. Expect PASS, and `dist/manifest.json` exists.
- [ ] **Step 5:** Commit: `feat(saves-extension): read the saved list in the owner's session, catch up, submit, extract`.

### Task 10: The extension popup (observability)

**Files:**
- Create: `apps/saves-extension/src/{status.ts,popup.ts,popup.html,popup.css}`
- Test: `apps/saves-extension/test/status.test.ts`

**Interfaces:**
- **Consumes:** `GET /api/saves/status` (Task 3), the local queue size, the last local error, and the next alarm time.
- **Produces:** `popupModel(input: { status: SavesStatusDto | null; appError: string | null; queueSize: number; nextCheckAt: number | null; now: number }): PopupModel`.
  - `PopupModel = { headline: string; lastCheck: string; nextCheck: string; checks: …; posts: …; spend: string; actions: ("check_now"|"process_anyway"|"retry")[] }`.
  - Headlines are the exact strings from Global Constraints.
  - `popup.ts` renders the model with plain DOM. Its `Check now`, `Process anyway` and `Retry` buttons message the background, which calls the token routes. (Overrides use the token route `POST /api/saves/posts/:key/override`, the same service as Task 4.)

- [ ] **Step 1: Write the failing tests**
  - Each state maps to its exact headline.
  - `null` status plus an app error gives `App unreachable`.
  - Spend renders as `$0.42 of $5.00 this month`.
  - A `filtered_out` post offers `process_anyway`; a `failed` post offers `retry`.
- [ ] **Step 2:** Run `pnpm vitest run apps/saves-extension/test/status.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement, and add the token override route to `saves.ts`, reusing Task 4's service.
- [ ] **Step 4:** Run the Step 2 command and the build. Expect PASS.
- [ ] **Step 5:** Commit: `feat(saves-extension): the popup — status, checks, posts, spend, Check now`.

## Phase B — personal moves

### Task 11: Personal move records and their validation

**Files:**
- Modify: `packages/exercise-library/src/validate.ts`. Extract `validateRecord(ex, ctx: { themes; profiles; knownIds: ReadonlySet<string>; mode: "library"|"personal" })` from the per-record loop (currently :53-152). `validateLibrary` calls it with mode `library`, with unchanged results.
- Create: `apps/worker/src/services/personal-records.ts`
- Test: `packages/exercise-library/test/validate.test.ts` (must stay green), `packages/exercise-library/test/validate-record.test.ts`, `apps/worker/test/personal-records.test.ts`

**Interfaces:**
- **Produces:**
  - `validateRecord(...)`: `string[]`. In `personal` mode the provenance rule and the camelCase-id rule are skipped. Instead the id must match `PERSONAL_ID_RE`. `easier`/`harder` may be empty.
  - `toPersonalRecord(id: string, draft: ExtractedMove): ExerciseRecord`, through `defineExercises`.
    - Defaults: `family = id`, `roles` derived from `purposes` (or `["accessory"]`), `themes: []`, `tags: []`, `muscles: {primary: [], secondary: []}`.
    - `text` comes from the draft's summary, steps, cues (as `focus`), mistakes and purpose (as `why`).
    - Each profile's `text.conditions` comes from its note.
    - `providers.coros` is absent.
  - `validatePersonalRecord(rec): string[]`

- [ ] **Step 1: Write the failing tests**
  - `validateLibrary(current data)` returns `[]`, unchanged.
  - A personal record containing `@` in its text passes in `personal` mode but fails in `library` mode.
  - A personal record missing a TMJ rating fails.
  - `toPersonalRecord` output passes `validatePersonalRecord`.
- [ ] **Step 2:** Run `pnpm vitest run packages/exercise-library apps/worker/test/personal-records.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Matching (Task 8) now runs `toPersonalRecord` + `validatePersonalRecord` before writing a personal move. A record that fails validation leaves the post `failed` with `model_failed` and the issues.
- [ ] **Step 4:** Run the Step 2 command and `apps/worker/test/saves-match.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(library): one record's validation, and personal records built and checked by it`.

### Task 12: The account library on the Worker — validation, builds, engine

**Files:**
- Create: `apps/worker/src/services/account-library.ts`
- Modify:
  - the seven `library: EXERCISES` constructors: `doc-build.ts:219`, `doc-workouts.ts:293,329`, `session-build.ts:1506`, `workout-templates.ts:96`, `act-common.ts:531`, `plan-checks.ts:115`;
  - `session-build.ts` `engineDataFor` (its cache key includes `personalHash`; the pool is `library.engine`) and the document `inputsHash` (include `personalHash`);
  - `engine-inputs.ts` `EngineContext` (add `library: AccountLibrary`).
- Test: `apps/worker/test/account-library.test.ts`

**Interfaces:**
- **Produces:**
  - `AccountLibrary = { all: readonly ExerciseRecord[]; offered: readonly ExerciseRecord[]; engine: readonly ExerciseRecord[]; personalHash: string }`, where:
    - `all` = `EXERCISES` + active, archived and merged personal moves (merged ids resolve via `legacyIds` on the target);
    - `offered` = `EXERCISES` + active;
    - `engine` = `EXERCISES` + active moves that are pinned in `exercise_prefs`.
    - With no personal moves, each of these is the `EXERCISES` array itself.
  - `loadAccountLibrary(db: Db, userId: string): Promise<AccountLibrary>`. It is memoised per request in a `WeakMap<Db, Map<string, Promise<AccountLibrary>>>` and costs 2 statements.
- **Contract:** the validator receives `library.all`; engine data receives `library.engine`; search and coach offers receive `library.offered`.

- [ ] **Step 1: Write the failing tests**
  - A document holding an active personal move validates.
  - An unknown id is still `unknown_exercise`.
  - A document holding an archived personal move still validates and builds (Review Focus 4).
  - A pending personal move is `unknown_exercise`.
  - The engine pool holds a pinned active personal move but not an unpinned one.
  - Editing a personal move changes `inputsHash`.
  - `engineDataFor` returns different data for two personal sets with the same profiles.
  - With no personal moves, `library.all === EXERCISES`.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/account-library.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement, and thread the library through the listed constructors. Run the worker's doc and engine suites.
- [ ] **Step 4:** Run `pnpm vitest run apps/worker/test/account-library.test.ts apps/worker/test/doc-*.test.ts apps/worker/test/session-build*.test.ts apps/worker/test/engine-*.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(library): the account library — personal moves resolve in documents and builds; the engine sees pinned ones only`.

### Task 13: The account library on the Worker — reads, guards, pins

**Files:**
- Modify:
  - `library-view.ts`: the module `byId`/`canonicalId`, `listLibrary`, `libraryItem`, and `setExercisePrefs`, whose guard accepts active personal ids;
  - `design-tools/read-library.ts` (`search_library` over `offered`; `get_exercise` over `all`, labelling a personal move `yours: true` with its links);
  - `act-common.ts:688` `RECORD_BY_ID`;
  - `design-focus.ts` `checkFocus` for `move`, and `design-context.ts` `moveLines`:
    - A focus resolves against the account library's `all`, plus pending personal moves. This lets "Ask the coach" work in review before a batch is saved.
    - A personal id costs +1 statement; library ids cost none.
    - `moveLines` for a personal move adds its summary, its dose as seen, and `(from your saves, not yet saved)` when pending.
    - A pending move is still never placeable, because it is not in `all` for validation.
  - the id guards: `session-save.ts:319`, `session-answers.ts:27`, `read-sessions.ts:193`, `body-exposure.ts:42-43`, `growth-body.ts:52`, `progress.ts:53`, `key-result-measures.ts:129`, `logged-sets.ts:46`, `workout-doc-store.ts:67` (converters keep a personal id as an `exercise` item, never as free text);
  - `watch-push.ts:459` (pass the library to `corosKeyOf`).
- Add: `GET /api/library/personal` → `{ moves: { record: ExerciseRecord; status: "active"|"archived"; links: {url; creator}[] }[] }` (cookie route in `routes/library.ts`).
- Test: `apps/worker/test/account-library-reads.test.ts` (plus the existing suites for each touched file)

**Interfaces:**
- **Consumes:** `loadAccountLibrary` (Task 12).
- **Produces:** the route above, and `api.listPersonalMoves()` in api-client.

- [ ] **Step 1: Write the failing tests**
  - `search_library` finds an active personal move by name and marks it yours; it does not find an archived one.
  - `get_exercise` returns an archived one (Review Focus 4).
  - A run focused on a pending personal move starts, and its context names the move as not yet saved. A document placing that move is still `unknown_exercise`.
  - `setExercisePrefs` pins an active personal id, and refuses an unknown or pending one with 404.
  - A session save keeps a personal move's logged sets.
  - The doc store's converter keeps a personal id as an `exercise` item.
  - A pushed strength session carries a personal move as free text with its name.
  - `GET /api/library/personal` lists active and archived moves, not pending.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/account-library-reads.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Each module-level map becomes `makeLibraryIndex(library.all)` at the call.
- [ ] **Step 4:** Run the Step 2 command and `pnpm vitest run apps/worker` (the full worker suite, since the guards are widespread). Expect PASS.
- [ ] **Step 5:** Commit: `feat(library): personal moves in search, reads, pins, saves and history`.

### Task 14: The account library in the UI

**Files:**
- Create: `packages/ui/src/library/account-library.ts`
- Modify:
  - `packages/ui/src/screens/studio/{model.ts,screen.tsx,home.tsx,filters-sheet.tsx,builder.tsx,build-model.ts,move-detail.tsx}` (`StudioCtx.library`; every `EXERCISES` use routed through `ctx.library` or the hook);
  - `packages/ui/src/player/local-build.ts` caller `use-build-flows.ts:533` (pass the library).
- Test: `packages/ui/test/account-library.test.tsx`

**Interfaces:**
- **Produces:**
  - `useAccountLibrary(): { all: readonly ExerciseRecord[]; offered: readonly ExerciseRecord[] }`
    - Query key `["library","personal"]`.
    - Merged with `EXERCISES`, memoised on data identity.
    - Falls back to `EXERCISES` while loading or on error.
  - `StudioCtx.library: readonly ExerciseRecord[]`, meaning `offered`.
  - Move detail shows `Yours` and, for each link, the creator and a link that opens the post.

- [ ] **Step 1: Write the failing tests**
  - The Studio search finds a personal move.
  - Move detail shows its post link.
  - A local build of a workout holding a personal move plays its steps.
  - With the personal read failing, the Studio still lists the library.
- [ ] **Step 2:** Run `pnpm vitest run packages/ui/test/account-library.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command and `pnpm vitest run packages/ui`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(studio): your moves beside the library — search, detail with the post link, the player`.

### Task 15: "From your saves", the review screen

**Files:**
- Modify: `apps/worker/src/routes/my-saves.ts`, `packages/api-client/src/index.ts`, `packages/ui/src/app.tsx` (the `/studio/saves` and `/studio/saves/:batchId` routes under the Studio)
- Create: `packages/ui/src/screens/studio/saves.tsx`, `packages/ui/src/screens/studio/saves-model.ts`
- Test: `apps/worker/test/my-saves-review.test.ts`, `packages/ui/test/studio-saves.test.tsx`

**Interfaces:**
- **Consumes:** `saveBatch` (Task 8) and `validatePersonalRecord` (Task 11).
- **Produces cookie routes:**
  - `GET /api/my-saves/batches` → `{ batches: {id, status, notice, releasedAt, savedAt, counts}[] }`. Released and saved batches are listed; held ones only when `?held=1`.
  - `GET /api/my-saves/batches/:id` → `{ batch, rows: { postMoveId, post: {url, creator, kind}, move: {id, name, summary, kind: "new"|"linked", linkedName?, check}, record?: ExerciseRecord }[] }`
  - `PUT /api/my-saves/moves/:id`, body: a partial record of `name`, `text.summary`, `text.steps`, `text.focus`, `text.mistakes`, `dose`, `conditions`, and `text.conditions`. It is validated by `validatePersonalRecord` and sets `edited_by_owner`.
  - `POST /api/my-saves/post-moves/:id/rematch`, body `{ to: string | null }`, where `null` makes the move its own personal move. This is "Not this move" and "Same as…"; merging sets `merged_into`.
  - `POST /api/my-saves/post-moves/:id/remove`
  - `POST /api/my-saves/batches/:id/save` → `saveBatch`
  - `POST /api/my-saves/batches`, body `{ theme, postIds }`: creates a held batch from posts (the bootstrap).
  - `POST /api/my-saves/batches/:id/release`
- **Produces UI:** a list of batches, then a batch's rows (copy exact, density rule), then a move sheet with `Edit`, `Not this move`, `Same as…`, `Remove`, and `Ask the coach` (opens the coach with focus `{kind: "move", id}`), and `Save these` at the foot.

- [ ] **Step 1: Write the failing tests**
  - **Worker:**
    - An edit keeps validation, so removing a rating is a 422.
    - Rematch to a library id moves the link.
    - Rematch `null` creates a personal move.
    - "Same as" another personal move merges it.
    - Remove excludes the row from save.
    - Save writes links for the remaining rows only.
    - Another user's batch is 404.
    - Statements are ≤ 45 per call, and save is chunked.
  - **UI:**
    - Rows render `New` / `Linked to {name}` / `Check this`.
    - `Save these` calls save.
    - `Ask the coach` opens the coach with the move focus.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/my-saves-review.test.ts packages/ui/test/studio-saves.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(studio): From your saves — look, edit, fix a match, save`.

## Phase C — the coach

### Task 16: The `saves` opening line

**Files:**
- Modify:
  - `apps/worker/src/services/coach-opening-line.ts` (the `"saves"` source, `savesOpening(batch)`, `SEEN_ID` admits `saves:`; `OpeningChip` gains `href?: string` and `saveBatchId?: string`);
  - `coach-nudges.ts` (the saves candidate);
  - `packages/api-client` (the DTO unions and fields);
  - `packages/ui/src/screens/studio/{coach-conversation-model.ts,coach-opening.tsx}` (a chip kind `open`, which navigates; a chip with `saveBatchId` saves the batch before `onAsk`).
- Test: `apps/worker/test/coach-opening.test.ts`, `apps/worker/test/coach-nudges.test.ts` (update the statement pins), `packages/ui/test/coach-opening-live.test.tsx`

**Interfaces:**
- **Produces:**
  - `savesOpening(b: { id; notice; releasedAt }): CoachOpeningLine`:
    - `id: "saves:" + b.id`, `source: "saves"`, `line: b.notice`;
    - chips: `{id: "saves-see", label: "See them", request: "", href: "/studio/saves/" + b.id}` and `{id: "saves-fit", label: "Fit these in", request: FIT_SAVES_REQUEST, saveBatchId: b.id}`;
    - `FIT_SAVES_REQUEST = "Fit the new moves from my saves into my training."`
  - **Candidate order:** review, then saves (the newest `released` batch, `since = released_at`), then session. The existing "first unseen, not asked about since" rule applies.

- [ ] **Step 1: Write the failing tests**
  - With a released batch and nothing else, the opening is the saves line with both chips.
  - With an unseen Monday review too, the review shows first; once the review is seen, saves shows.
  - `parseSeen("saves:abc")` keeps the id.
  - A `held` batch never shows.
  - The statement pins are updated to their new values (the read is folded into the existing statement where possible; at most +1).
  - UI: `See them` navigates to `/studio/saves/abc`; `Fit these in` calls save, then sends the request.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/coach-opening.test.ts apps/worker/test/coach-nudges.test.ts packages/ui/test/coach-opening-live.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(coach): the coach brings a saves batch — See them, Fit these in`.

### Task 17: The coach reads the saves (a context section and `read_saves`)

**Files:**
- Create: `apps/worker/src/services/design-tools/read-saves.ts`
- Modify:
  - `design-tools/index.ts` (`READ_TOOLS`);
  - `design-prompt.ts` (`PROMPT_TOOL_NAMES`, one "Reading" line);
  - `design-prose.ts` (`TOOL_WORDS`);
  - `design-context.ts` (a `savesSection` before the request; `contextStatements` and `DESIGN_CONTEXT_STATEMENTS`);
  - the test pins listed in recon-coach.md: `design-read-budget`, `design-prompt`, `design-act-budget` order, `design-orchestrate` names, `design-read-tools`, `design-cpu-bench` (an `8.read_saves` shape), `design-context` (statements and the 6.5 KB header test), and `coach-conversation` statement pins.
- Test: `apps/worker/test/design-read-saves.test.ts`

**Interfaces:**
- **Produces:**
  - **`readSaves: DesignTool`**
    - `name: "read_saves"`, `roles: READ_ROLES`, `statementCost: 2`, and `cpuWeight` measured by the bench.
    - Input `{ batchId?: string; limit?: number ≤ 12 }`. With no `batchId`: the newest saved batch with `fitted_at` null, saved within 14 days.
    - Output: `{ batch: {id, savedAt}, moves: { id, name, summary, new: boolean, pinned: boolean, groups: string, links: { url, creator: Untrusted }[], fromPost: Untrusted /* the post's summary */ }[], routines: { post: Untrusted, order: string[] }[] }`
  - **`savesSection`:** at most 12 moves, one line each (`- {name} ({id}) — {summary}; new|yours already; from {n} post(s)`), headed `From the athlete's saves (saved {date}, not yet fitted in):`. Present only when such a batch exists.

- [ ] **Step 1: Write the failing tests**
  - `read_saves` with no batch gives `missing`.
  - With a saved batch, it lists moves with untrusted creators.
  - The context header holds the section only when an unfitted saved batch exists, and stays under 6.5 KB with 12 long moves.
  - The registry, prompt and bench tests name `read_saves`.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/design-read-saves.test.ts apps/worker/test/design-*.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(coach): read_saves and the saves section — the coach sees what came in`.

### Task 18: The `move_pins` proposal and the integration prompt

**Files:**
- Create: `apps/worker/src/services/design-tools/pin-moves.ts`
- Modify:
  - `proposal-kinds.ts` (`MovePinsOp`, `isMovePinsOp`, `isDesignedOp`, `opIdOf`);
  - every SQL kind list in recon-coach.md (`design-cover.ts:37,52`, `design-context.ts:327`, `coach-runs.ts:1440,1447,1463`, `design-orchestrate.ts:685`, `propose.ts:563`, `coach-conversation.ts:98,201-203`);
  - `design-approve.ts` (dispatch, `MOVE_PINS_FIXED = 2`, plus 1 per 20 ids, an `applied`/`refused` outcome, a receipt line);
  - `coach-conversation.ts` `cardsOf` (kind `"pins"`), `design-manifest.ts`, the api-client DTO union (`"pins"`), and `coach-conversation.tsx` `TurnCards` (`"pins"` → `PlanCard` with its title, summary and lines);
  - `design-tools/index.ts` (`ACT_TOOLS`), `design-prompt.ts` (an acting line plus the integration guidance below), `design-prose.ts`;
  - the test pins (`design-act-budget` `ACT_NAMES`/roles, `design-cpu-bench` act shapes).
- Test: `apps/worker/test/design-move-pins.test.ts`, `packages/ui/test/coach-pins-card.test.tsx`

**Interfaces:**
- **Produces:**
  - **`MovePinsOp`:** `{ kind: "move_pins"; id: \`pins-${mainRunId}\`; pin: string[] ≤20; unpin: string[] ≤20; batchId?: string; why: string; title: string; summary: string; lines: string[]; toolUseId: string; replaces?: string[]; at: string }`
  - **The `pin_moves` tool:** `roles: ["main"]`. It refuses an id that isn't an active library or personal move (`not_a_move`), and anything during a restore. It is upserted into the run's proposal as `change_programme` is.
  - **Approval:** writes `exercise_prefs.pinned` (true for `pin`, false for `unpin`) in one batched upsert, and sets `save_batches.fitted_at` when `batchId` is present.
    - An id archived since the proposal is skipped, with a line in the outcome.
    - Outcomes are `applied` or `refused`.
  - **Integration guidance** (copy, in the prompt's integration section): "When the athlete asks to fit in moves from their saves, place them inside what they already do — revise upcoming workouts, keep a move in rotation with pin_moves, change the programme only if the week needs it — rather than adding sessions. Respect the week's load, their objectives and their conditions. One line per placement saying why. Ask at most two questions first, only when the answer changes the plan."

- [ ] **Step 1: Write the failing tests**
  - The tool proposes pins.
  - Approve pins two moves, and the engine pool (Task 12) then holds the personal one.
  - Approve sets `fitted_at`.
  - An archived id is skipped with a line.
  - The statement cost is pinned.
  - A pending id is refused at proposal time.
  - The card renders the lines and approves.
  - The prompt test finds the integration guidance and the tool name.
- [ ] **Step 2:** Run `pnpm vitest run apps/worker/test/design-move-pins.test.ts packages/ui/test/coach-pins-card.test.tsx apps/worker/test/design-*.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(coach): move_pins — the coach can keep a saved move in rotation, with the owner's approval`.

## Phase D — live probes, setup and the starter set

### Task 19: Live probes and setup (the lead, with the owner's browser)

This is not a code task until a probe fails. It runs after Phases A–C are deployed with `SAVES_IMPORT=1` and `SAVES_HOLD_BATCHES=1`, and with `SAVES_TOKEN_SHA256` set. The owner may need to run `! wrangler secret put SAVES_TOKEN_SHA256`. Results go in the ledger, `probes.md`.

- [ ] **Step 1: Setup.**
  1. Generate a token (`randomToken`) and put its SHA-256 in the secret.
  2. Build the extension: `pnpm --filter @rg/saves-extension build`.
  3. The owner loads `apps/saves-extension/dist` unpacked at `chrome://extensions` and pastes the app URL and the token into Options.
- [ ] **Step 2: R5.** Check now with the backlog cap set to 1 page. Expect `found > 0`, fresh keys, and no `login_needed`. Then submit one seeded key through `/work`. Expect fresh media links from `readPost`.
- [ ] **Step 3: R1 and R2.** Extract 3 posts of increasing size. The Worker's CPU time must stay within the limit; check with `wrangler tail` (with `WRANGLER_WRITE_LOGS=false`) for `exceededCpu` / status. Record the largest accepted body and any gateway 413.
  - **If R1 fails,** add Task 19b: the extension calls the gateway directly with a key from Options, using `reserveImport`/`settleImport` through two token routes. The relay route stays, used only by tests.
- [ ] **Step 4: R3 and R4.**
  - Extract about 15 first-capture posts at three settings: the default model at 480 px, at 720 px, and a cheaper model. Compare against the first capture's analysis on moves, doses and cues.
  - Set `EXTRACT_MODEL_DEFAULT`, `MIN_VIDEO_WIDTH`, `FILTER_MODEL_DEFAULT` and the `MODEL_PRICES` entries in a commit: `chore(saves): the probe's choices — model, resolution, prices`.
- [ ] **Step 5:** Record the probe results and the decision in the ledger.

### Task 20: The starter set (the lead)

**Files:**
- Create: `apps/worker/scripts/seed-saves.mjs`. It reads a private capture file path from the CLI, writes nothing in the repo, takes `--source`, `--app` and `--token-file`, and pages `POST /api/saves/posts` with `seed`.
- Test: `apps/worker/test/seed-saves-transform.test.ts`. It covers the pure `toSeed(record)` exported from `scripts/seed-saves-lib.mjs`, with synthetic records: the training categories map to `queued`; the others map to `filtered_out` with reason `not training (first capture)`.

- [ ] **Step 1:** Write the failing transform test. Run it and expect FAIL. Implement, and run it again to PASS. Commit: `feat(saves): the seed script for the first capture`.
- [ ] **Step 2: Seed.** Seed from the private file. Let the extension catch up (repeated `Check now`) and drain `/work` until every bootstrap post is `matched` or `failed`. Retry the failures once.
- [ ] **Step 3: Curate**, through the owner routes in the owner's browser.
  - Merge duplicates and fix low-confidence matches.
  - Hand-check every new move's ratings and dose.
  - Mark thin posts `reference_only`.
  - Check coverage: strength, mobility, posture and neck, conditioning, jumps.
  - Then `POST /api/my-saves/batches` 3–5 themed held batches.
- [ ] **Step 4: Release.** Release the first batch. Unset `SAVES_HOLD_BATCHES` once the starter batches are all released, about 2 weeks later; schedule a check-in for it. Record the plan in the ledger.

## Phase E — audit

### Task 21: Whole-branch review and the final audits

- [ ] **Step 1:** Run a whole-branch code review (fresh reviewer) of every task's diff, against this plan and the spec.
- [ ] **Step 2:** Run the verbatim audit. Separate reviewers check the shipped system against each of the owner's quoted asks in the spec's header, one by one.
- [ ] **Step 3:** Run the coach-context audit. Capture the context and tools of a "Fit these in" run on the fixture stack, and review them against the principles doc's agent-design section: untrusted marking, tool contracts, and no stated rule the code doesn't enforce.
- [ ] **Step 4:** Fix, re-review, and run the full gates: `pnpm -r typecheck` and `pnpm vitest run` on a quiet tree, then e2e on a fresh fixture stack.
- [ ] **Step 5:** Deploy a reviewed SHA (`git push origin <sha>:main`; the owner may need to run it). Verify the deploy (CI and Deploy both green, and the app loads).
