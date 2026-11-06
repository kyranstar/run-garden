# Import Trail — Phase 2 (pasted links and YouTube) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The owner pastes a YouTube or Instagram link — in the extension popup, or in the app on the phone — and it is
read in the background (a YouTube video by its player's own captions, chapters and metadata), screened, read for its
moves under prompt `extract-6` (use-when, skip-when, why, quotes), its quotes checked against the words, matched, and
waiting in the coach; a long video is read from its words until the owner taps **Watch it too**; a reading never fails
whole over one unknown list value.

**Architecture:** URL normalization, transcript text, quote verification and the lenient parse are pure functions in
`@rg/saves`, shared by the extension and the Worker. The extension gains a link queue and a link runner (one link at a
time, under the same lock as the saved-list check, polled every 15 minutes) and a thin YouTube page reader whose every
parser is a pure, tested function. The Worker stores pasted links (`saved_links`, migration 0035), hands the
extension `read` work, keeps a video's chapters on the post and its transcript as a blob, and — because a YouTube
reading carries no media bytes — builds a video's gateway body itself (`POST /api/saves/posts/:key/extract-video`),
sharing the relay's claim / reserve / settle / finish / match path.

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free) with D1/drizzle; zod; React 18 + TanStack Query; Vitest
(jsdom for UI); Chrome MV3 extension (esbuild, `chrome.scripting` MAIN world).

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` — §3.1, §5 (all; §5.5 is prompt
`extract-6`), §6.2–6.3, §10, §13, §14.4–14.5, §15.2–15.3 (phone links yes; a playable follow-along no). Principles
§6–§9 (`docs/principles/workout-system-principles.md`). Phase 1's plan for conventions:
`docs/superpowers/plans/2026-11-05-import-trail-phase-1.md`.

## Global Constraints

- Every Global Constraint of phase 1's plan applies (Workers Free ≤ 45 statements + fetches a request and 10 ms CPU;
  D1 ≤ 100 bound parameters; `import_blobs.text` ≤ 1,000,000 chars; public repo: `Zorbex …` names, made-up
  creators/channels, links assembled at runtime, a fake video id built at runtime; untrusted text drawn as text and
  inside the data block, defanged; owner's voice; never "proposal" in UI copy; Node v21; never `git stash`; trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push; design tokens, 44 px targets, both themes).
- Statement pins: every route whose count changes is re-pinned with `REBASED 2026-11-06 (import trail phase 2): <why>`.
- Accepted links: `youtube.com/watch?v=…` (also `m.`/no `www`), `youtu.be/…`, `youtube.com/shorts/…`,
  `instagram.com/p/…`, `/reel/…` (also `/<user>/p/…`, `/reels/…`); anything else: "Only YouTube and Instagram links for now."
- A video is attached to its reading by URL when it is **20 minutes or shorter** (or the owner asked: Watch it too).
- Output cap 32,000 tokens for a reading; the Worker's call timeout is 120 s plus 2 s per minute watched, at most
  600 s; the extension waits that plus 60 s. A reply cut at the output limit fails and says so.
- A watched video adds ≈100 tokens a second (typical estimate; the worst case reserves 300/s); under half of
  100/s × length beyond the text's own tokens (chars ÷ 4) is `videoSeen: false`.
- Transcript ≤ 400,000 chars, cut at a segment boundary with `cut: true`; screening sees its first 1,500 words.
- A YouTube read is capped at 60 s; failures in plain words: "YouTube asked to sign in", "Age-restricted",
  "Live now — try after it ends", "No captions" (not fatal alone), "The player didn't load".
- Moves cap 30; `matchVerdictSchema` 30; `pin_moves` (`PINS_MAX`, `PINS_LINES_MAX`) 30.
- Do not edit `design-context.ts`, `coach-nudges.ts`, `coach-conversation*.ts`, `design-prompt.ts` (phase 4's
  worktree); `prompts.ts` and `personal-records.ts` are edited on main too — keep their rules, rebase at the end.

## Review Focus

1. **An older extension (0.2.0) handed a YouTube or link work item** would read a YouTube id as an Instagram
   shortcode. Expected: `/work` hands `read` items and non-Instagram items only to a caller that asks `?v=2`
   (Task 6 test "an old extension's work list is unchanged").
2. **A reading with one unknown list value** (`regions: ["hips","forearmz"]`). Expected: stored without it, a repair
   note on the check event, the move flagged Check this; a list emptied by dropping still fails with the schema's
   words (Task 1 tests).
3. **A long video with no captions** (> 20 min, no transcript). Expected: no paid call; `failed` / `no_captions`
   "No captions, and it's over 20 minutes — Watch it too reads it from the video"; Watch it too reads it (Task 7).
4. **A huge transcript** (a 3-hour follow-along, 600 KB of captions). Expected: cut at 400,000 chars at a segment
   boundary, `cut: true` on the read event and in the prompt ("the transcript was cut here"); quote checks only
   scan windows near each quote's time (Tasks 2, 3).
5. **The same link pasted twice / already imported** (popup and phone). Expected: "Already in — imported Tue 3 Nov."
   with Open; no second link row; a failed link re-added goes back to waiting (Task 6 tests).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/saves/src/links.ts` (new) | `normalizeLink`, `LinkDto`, `linkState()` words |
| `packages/saves/src/transcript.ts` (new) | transcript text ⇄ segments, the 400 KB cut, `clock()`, prompt lines |
| `packages/saves/src/quotes.ts` (new) | `verifyQuotes()` (§5.6) |
| `packages/saves/src/lenient.ts` (new) | `dropUnknownEnums()` |
| `packages/saves/src/schemas.ts`, `prompts.ts`, `trail.ts` | submit fields, `extract-6` fields, `filter-2`, error codes, DTOs |
| `packages/database/migrations/0035_pasted_links.sql`, `schema/saves.ts`, `version.ts` | `saved_links`; `saved_posts.video_info`, `watch_video` |
| `apps/worker/src/services/saved-links.ts` (new) | add / list links, link work |
| `apps/worker/src/services/saves-relay.ts` | the shared reading core; video body; video-seen; quote checks |
| `apps/worker/src/services/saves-video.ts` (new) | `watchVideo()`, `watchCostMicros()`, video prompt input |
| `apps/worker/src/services/saves-ledger.ts`, `saves-filter.ts`, `saves-match.ts`, `saves-batches.ts` | submit, screening, 30 moves, insights scope |
| `apps/worker/src/routes/saves.ts`, `my-saves.ts` | `/links`, `/extract-video`, `/posts/:id/watch` |
| `apps/saves-extension/src/youtube.ts` (new) | pure parsers: player response, tracks, json3, chapters, panel, submit |
| `apps/saves-extension/src/youtube-reader.ts` (new) | the thin page reader (tabs + MAIN-world scripts) |
| `apps/saves-extension/src/links.ts` (new) | the link queue and runner |
| `apps/saves-extension/src/{background,check,app-client,popup,status}.ts`, `manifest.json` | wiring, popup field |
| `packages/api-client/src/index.ts`, `packages/ui/src/screens/settings/saves.tsx`, `screens/saves/trail-*.ts(x)` | the app's field, recent links, Watch it too, trail words |

---

### Task 1: A reading never fails whole over one unknown list value

**Files:** Create `packages/saves/src/lenient.ts`; Modify `packages/saves/src/schemas.ts` (extraction gains optional
`dropped`), `apps/worker/src/services/saves-relay.ts` (`parseExtraction`), `apps/worker/src/services/saves-match.ts`
(check event + flag), `apps/worker/src/services/personal-records.ts` (`repairDraft`: external + breaths);
Test `packages/saves/test/lenient.test.ts`, `apps/worker/test/saves-relay.test.ts`, `apps/worker/test/personal-records.test.ts`.

**Interfaces — Produces:** `dropUnknownEnums(raw: unknown) → { value: unknown; dropped: { move: number; field: ListField; values: string[] }[] }`
with `ListField = "regions" | "patterns" | "equipment" | "equipmentOneOf" | "contraction"`; extraction (stored) gains
`dropped?: {move, field, values}[]`, always written by the Worker (a model-written one is replaced).

- [x] **Step 1: failing tests** — `dropUnknownEnums({moves:[{regions:["hips","forearmz"],patterns:["mobility"],…}]})`
  keeps `["hips"]`, `dropped: [{move:0, field:"regions", values:["forearmz"]}]`; a list whose every value is unknown is
  left as it is (the schema refuses it, its retry names the options); non-string entries are dropped too; a value
  longer than 40 chars is reported cut to 40. Relay: a reply with `moves[0].regions: ["hips","forearmz"]` is stored
  `matched`, the stored extraction has `dropped`, the check event's detail lists `dropped` and its summary counts it,
  the link is `checkFlag: true`; a reply with `position: "floaty"` still fails `model_failed` with the schema's issue.
  personal-records: `load: "external"`, kettlebell, `dose.type: "breaths"` → built, repair "a weight counted in
  breaths; stored as bodyweight (the app logs a weight on reps or a timed carry)".
- [x] **Step 2:** run `pnpm vitest run packages/saves/test/lenient.test.ts apps/worker/test/saves-relay.test.ts apps/worker/test/personal-records.test.ts` — FAIL.
- [x] **Step 3:** implement; `parseExtraction` runs `dropUnknownEnums` before `extractionSchema.safeParse` and sets
  `dropped` (deleted when empty); `matchTrail`'s check event: status `warn` when any drop, detail `dropped`, each
  dropped move's link flagged.
- [x] **Step 4:** rerun — PASS; run `apps/worker/test/saves-match.test.ts` too.
- [x] **Step 5:** commit `fix(saves): one unknown list value no longer throws a paid reading away`.

### Task 2: The wire and the prompts — links, transcripts, `extract-6`, `filter-2`

**Files:** Create `packages/saves/src/links.ts`, `packages/saves/src/transcript.ts`; Modify `schemas.ts`, `prompts.ts`,
`trail.ts`, `index.ts`, `insights.ts`; `apps/worker/src/services/saves-batches.ts` (`insightRowsSql`);
Test `packages/saves/test/{links,transcript,prompts}.test.ts`, `apps/worker/test/saves-batches.test.ts`.

**Interfaces — Produces:**
- `normalizeLink(input: string) → { source: "youtube" | "instagram"; key: string; url: string } | null` — YouTube key
  `/^[A-Za-z0-9_-]{11}$/`, url `https://www.youtube.com/watch?v=<id>`; Instagram key the shortcode, url
  `https://www.instagram.com/p/<code>/` (or `/reel/<code>/` when pasted as a reel). A bare `youtu.be/…` gets `https://`.
- `LINK_REFUSED = "Only YouTube and Instagram links for now."`
- `LinkDto { id; source; key; url; title: string | null; addedAt; addedFrom: "extension" | "app"; postId: string | null; state: LinkState; words: string; moves: number | null; action: "retry" | "import_anyway" | null }`,
  `LinkState = "waiting" | "reading" | "screening" | "reading_moves" | "moves" | "not_training" | "failed" | "skipped"`,
  `linkState(link: {status, addedFrom, errorCode, error}, post: {status, lastErrorCode, lastError, moves, watchVideo} | null) → { state; words; action }`
  — words: waiting from the app "Waiting for your computer's extension"; waiting from the extension "Reading";
  seen "Screening"; queued/extracting/extracted "Reading the moves" (queued with `watchVideo` from the app: "Waiting
  for your computer's extension"); matched `N moves` / `1 move` / "No moves"; filtered_out "Not training" (action
  import_anyway); failed `Failed: <failureWords>` (action retry); skipped_by_owner "Skipped"; reference_only "Kept as a reference".
- `TRANSCRIPT_MAX = 400_000`; `transcriptText(segments: [number, string][]) → { text: string; cut: boolean }` (one
  line per segment, `"<seconds, ≤ 1 decimal>\t<text>"`, tabs/newlines in text become spaces; stops before the segment
  that would pass the cap); `transcriptSegments(text) → [number, string][]`; `clock(sec) → "m:ss" | "h:mm:ss"`;
  `firstWords(text, n) → string`.
- `postSubmitSchema` gains (all optional): `origin: "saved" | "pasted"`, `title ≤ 200`, `durationSec` int 0–86,400,
  `chapters ≤ 100 of {start ≥ 0, title ≤ 100}`, `transcript {lang ≤ 20, kind: "uploaded" | "auto", text ≤ 400,000, cut}`,
  `live: boolean`; `caption` ≤ 5,000; `readFacts.youtube?: {captions: {lang, kind} | null, segments, transcriptChars, chapters, chaptersFrom: "player" | "description" | null, via: "captured" | "panel" | null, ms}`.
- `SAVE_ERROR_CODES` gains `"no_captions"`, `"unplayable"`; `failureWords`: no_captions → "No captions, and the video
  couldn't be watched" (or the stage's own words when given), unplayable → the stage's words else "YouTube won't play it".
- `WorkItem.action` gains `"read"` (a pasted link waiting to be read).
- `extractedMoveSchema` gains optional `useWhen`/`skipWhen` (≤ 4 of `{text ≤ 160, evidence}`), `why ≤ 200`,
  `quotes ≤ 8 of {field: "name"|"dose"|"purpose"|"useWhen"|"skipWhen"|"steps"|"why", text ≤ 200, at?: number ≥ 0, from: "caption"|"transcript"|"speech"|"screen", check?: "verified"|"in_speech"|"not_found"}`;
  `evidence` gains optional `purpose`, `useWhen`, `skipWhen`. `extractionSchema`: moves ≤ 30, `speech?: ≤ 4,000`,
  `insights` ≤ 5 of `string ≤ 200 | {text ≤ 200, scope: "general"|"this_routine"|"creator_programme", quote?: ≤ 200}`.
  `insightText(i) → string`, `insightScope(i) → scope` (a string is `general`). `matchVerdictSchema` ≤ 30.
- `EXTRACT_PROMPT_VERSION = "extract-6"`, `FILTER_PROMPT_VERSION = "filter-2"`. `PostWords` = the data block's input:
  `Pick<PostSubmit, "caption" | "hashtags" | "creator" | "mediaType"> & { source?: string; title?: string | null; durationSec?: number | null; chapters?: Chapter[] | null; transcript?: { lang: string; kind: "uploaded" | "auto"; text: string; cut?: boolean } | null }`.
  The data block adds, only when present: `title:`, `length: m:ss`, the caption labelled `description:` for YouTube,
  `chapters:` lines `m:ss <title>`, `transcript (uploaded captions, <lang>):` / `(auto-generated captions, <lang>):`
  lines `[m:ss] text` and a final `(the transcript was cut here)` when cut — all defanged. An Instagram post's block is
  byte-identical to `extract-5`'s. `filterMessages` gives screening the first 1,500 words of the transcript.

- [x] **Step 1: failing tests** — links: each accepted form (watch with extra params and `t=`, `m.` host, `youtu.be`
  with `?si=`, shorts, IG `/p/`, `/reel/`, `/reels/`, `/<user>/p/`) normalizes; `http://`, `vimeo`, a watch link with
  a 10-char id, an IG `/stories/` link → null. linkState words for each case. transcript: round trip; the cut stops at
  a segment boundary under 400,000 and says `cut: true`. prompts: an Instagram post's `extractUserText` equals the
  phase-1 text for the same post (a pinned string from before); a YouTube post's block holds title, length, chapters
  and `[0:05] …` lines, a `<post-data>` in a chapter title is defanged; `extractSystemText()` names `useWhen`,
  `skipWhen`, `why`, `quotes`, `speech`, insight `scope` and "at most 30"; screening's block has the first 1,500
  words only. schemas: an `extract-5` extraction (string insights, no new fields) still parses; 31 moves refused.
  batches: an object insight with scope `general` is kept by Save; `this_routine` is not.
- [x] **Step 2:** run `pnpm vitest run packages/saves apps/worker/test/saves-batches.test.ts` — FAIL.
- [x] **Step 3:** implement. `insightRowsSql` reads `body` from a text value or an object's `$.text`, and skips an
  object whose `$.scope` is not `general` (one rule for Save, the batch page and the coach: §5.5).
- [x] **Step 4:** rerun with `apps/worker/test/saves-relay.test.ts apps/worker/test/my-saves-review.test.ts` — PASS.
- [x] **Step 5:** commit `feat(saves): extract-6 and filter-2 — links, transcripts and the reading's reasons`.

### Task 3: Quotes checked against the words (§5.6)

**Files:** Create `packages/saves/src/quotes.ts`; Test `packages/saves/test/quotes.test.ts`.

**Interfaces — Produces:** `foldWords(s) → string` (NFKD, ASCII-folded, lower case, punctuation to spaces, one space);
`verifyQuotes(extraction: Extraction, sources: { caption: string; title?: string | null; chapters?: string[]; transcript?: [number, string][] | null; speech?: string | null }) → { extraction: Extraction; results: { move: number; quote: number; check: QuoteCheck; at: number | null }[] }`
— sets every quote's `check` (a model-written one is replaced). Rules: a folded substring of caption, title, chapters
or transcript → `verified` (`at` from the transcript segment where it starts); else a window of the quote's token
count over the transcript segments within ±45 s of `at` (the whole transcript only when it is ≤ 20,000 tokens) with
≥ 0.8 of the quote's tokens (multiset) → `verified`; else the same tests on `speech` → `in_speech`; else `not_found`.
A `not_found` quote's field reads as inferred: `evidence[field]` set to `"inferred"` when it was `"stated"` (only for
`name`, `dose`, `steps`, `purpose`, `useWhen`, `skipWhen`).

- [x] **Step 1: failing tests** — a caption substring with other punctuation and case → verified; "café" vs "cafe" →
  verified; a transcript quote spanning two segments near `at` → verified with that `at`; 80% token overlap → verified,
  70% → not_found; a quote only in `speech` → in_speech; a not_found dose quote turns `evidence.dose` stated → inferred;
  a 20,001-token transcript with no `at` only matches by substring.
- [x] **Step 2:** `pnpm vitest run packages/saves/test/quotes.test.ts` — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [x] **Step 5:** commit `feat(saves): a quote is checked against the words it claims`.

### Task 4: Migration 0035 — pasted links and a video's facts

**Files:** Create `packages/database/migrations/0035_pasted_links.sql` (+ drizzle meta as earlier migrations do);
Modify `packages/database/src/schema/saves.ts`, `packages/database/src/version.ts` (`"0035"`),
`apps/worker/src/services/account-tables.ts`; Test `packages/database` suite, `apps/worker/test/{account-tables,delete-all-data,account-export-restore}.test.ts`.

**Interfaces — Produces:** table `saved_links` (`id` pk = `savedPostId(user, source, key)`, `user_id`, `source`,
`source_key`, `url`, `added_from` (`extension`|`app`), `status` (`waiting`|`failed`), `error_code`, `error`,
`added_at`, `updated_at`; unique (`user_id`,`source`,`source_key`); index (`user_id`,`added_at`)) as `schema.savedLinks`;
`saved_posts.video_info` (JSON: `{ chapters: Chapter[]; captions: {lang, kind} | null; live: boolean; transcriptChars: number; transcriptCut: boolean }`)
and `saved_posts.watch_video` (integer boolean; the owner asked to watch it).

- [x] **Step 1:** failing: `pnpm vitest run packages/database` (schema-version, migration apply) and the account-tables
  test that every user table is listed. **Step 2:** write the migration, schema, version, `[savedLinks, USER]`.
- [x] **Step 3:** rerun — PASS. **Step 4:** commit `feat(db): 0035 — pasted links, a video's chapters and Watch it too`.

### Task 5: The Worker takes a pasted link's post and a YouTube video

**Files:** Modify `apps/worker/src/services/saves-ledger.ts` (`upsertPost`), `saves-filter.ts`, `routes/saves.ts`
(`/posts`); Test `apps/worker/test/saves-routes.test.ts`, `saves-filter.test.ts`, `import-trail-stages.test.ts`.

**Interfaces — Consumes:** Task 2's schema, Task 4's columns. **Produces:** `upsertPost` stores `title`,
`durationSec`, `origin` (`p.origin ?? readFacts.via`), `videoInfo` (from chapters/transcript/live); the read event's
detail is `readFacts` (with `youtube`), summary for YouTube "Read the video: 12:34, uploaded captions (en), 6
chapters" / "… no captions"; the transcript is a `transcript` blob on that event. `filterPost(db, env, userId, post & { cover?, words?: PostWords }, …)`
— screening reads `words` when given (the route passes the submit's), and the summary of a pasted post that screening
keeps or filters is unchanged.

- [x] **Step 1: failing tests** — a YouTube submit (fake id built at runtime, made-up channel) stores title, duration,
  origin `pasted`, `video_info.chapters`, a `transcript` blob whose text is the submitted one, a `read` event with
  source `youtube`; the screening model is sent a block with `title:` and the transcript's head; the `/posts` route's
  statement pin re-pinned (REBASED … the transcript blob).
- [x] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** rerun the three files — PASS.
- [x] **Step 5:** commit `feat(saves): a pasted post and a YouTube video arrive with their words`.

### Task 6: Pasted links in the Worker — add, list, and the extension's `read` work

**Files:** Create `apps/worker/src/services/saved-links.ts`; Modify `saves-ledger.ts` (`workList`, `recordReadFailed`),
`routes/saves.ts`, `routes/my-saves.ts`; Test `apps/worker/test/saved-links.test.ts`.

**Interfaces — Produces:**
- `addLink(db, userId, input: string, from: "extension" | "app", now) → { ok: false; error: "not_a_link" } | { ok: true; state: "known"; postId; firstSeenAt } | { ok: true; state: "added"; link: LinkDto }`
  — a known post answers known; a new link inserts `waiting`; a `failed` link goes back to `waiting`; a waiting one
  answers added unchanged. ≤ 3 statements.
- `listLinks(db, userId, limit = 20) → LinkDto[]` — newest first, joined to the post by id, with its link count. 1 statement.
- `workList(db, userId, now, limit, opts: { links?: boolean } = {})` — with `links`, waiting links with no post come
  first as `{source, key, url, action: "read"}`, and non-Instagram posts are listed; without it, only `source =
  'instagram'`-style posts as today (the caller's source set is `["instagram", <test sources>]`: exclude
  `youtube` only).
- `recordReadFailed` also marks a waiting link of that source and key `failed` with the code and message.
- Routes: token `POST /api/saves/links` `{url}`, `GET /api/saves/links`, `GET /api/saves/work?v=2` (links on);
  owner `POST /api/my-saves/links` `{url}`, `GET /api/my-saves/links`. 400 `{error: "not_a_link", message: LINK_REFUSED}`.

- [x] **Step 1: failing tests** — add from app → waiting, listed "Waiting for your computer's extension"; added twice →
  one row; a known post → known with its first-seen time; failed → re-added waiting; `GET /work?v=2` lists it
  `read` first; `GET /work` (no v) lists no `read` item and no `youtube` post ("an old extension's work list is
  unchanged"); `/read-failed` for that key marks the link failed and `listLinks` says "Failed: Age-restricted";
  after the post is submitted the link reads "Screening", then "3 moves" once matched; another account never sees it.
  Statement pins for each new route and the re-pinned `/work`.
- [x] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS with `saves-routes.test.ts`, `my-saves-routes.test.ts`.
- [x] **Step 5:** commit `feat(saves): links pasted in the extension or the app wait for the extension`.

### Task 7: A video's reading — the Worker builds it, watches up to 20 minutes, and checks it saw it

**Files:** Modify `apps/worker/src/services/saves-relay.ts`; Create `apps/worker/src/services/saves-video.ts`;
Modify `routes/saves.ts`; Test `apps/worker/test/saves-video.test.ts`, `saves-relay.test.ts`.

**Interfaces — Produces:**
- `EXTRACT_MAX_TOKENS_CAP = 32_000`; `callTimeoutMs(watchedSec: number | null) = min(600_000, 120_000 + 2_000 × ceil(watchedSec / 60))`.
- `relayExtract` keeps its signature; its body becomes `runExtraction(db, env, userId, postId, plan, now, fetchImpl)`
  with `plan = { model; maxTokens; prompt: {version, sha, retryIssues}; readFacts; send: { kind: "stream"; req: Request; length: number } | { kind: "video" } }`.
  For `video`: one read of the post (duration, watch, video_info, has transcript) before reserving; reserve worst =
  text chars ÷ 3 + (attached ? 300/s × length : 0) input and `maxTokens` output, typical = chars ÷ 4 + 100/s × length
  and 1,500 output; after the claim, the transcript blob (1 statement) and the body built with
  `buildExtractBody({ post: PostWords, videoUrl: attached ? post.url : undefined, images: [], libraryNames, retryIssues, maxTokens, model })`.
  `attached = durationSec ≤ 1,200 || watch_video`. No transcript and not attached → no call: `failed`/`no_captions`
  "No captions, and it's over 20 minutes — Watch it too reads it from the video".
- After a good parse: `verifyQuotes` (Task 3) on caption, title, chapters, transcript, speech; for a video,
  `videoSeen = attached ? (promptTokens − textChars ÷ 4) ≥ 0.5 × 100 × durationSec : null`, written to
  `saved_posts.video_seen`; the extract event's detail gains `watched`, `videoSeen`, `quotes: {verified, in_speech, not_found}`,
  and a `speech` blob when the reply has `speech`. `videoSeen: false` → status `warn`, summary "… — the reader couldn't
  watch the video; it read the transcript only"; not attached → `info`-free `ok` with "… from the transcript (over 20
  minutes)". `videoSeen: false` with no transcript → `failed`/`no_captions` "Nothing to read: no captions, and the
  video couldn't be watched".
- Route: token `POST /api/saves/posts/:key/extract-video?source=youtube` (headers as the relay: model, max tokens,
  retry issues; no body read) → the relay's answers. The canned gateway (fixture mode) works as for the relay.
- `watchCostMicros(model, durationSec) → number` (100/s input + 1,500 output) in `saves-video.ts`.

- [x] **Step 1: failing tests** — a 10-minute video: the gateway receives a body whose user text equals
  `extractUserText` of the stored words and whose file part is the watch URL; `max_tokens` 32,000; prompt tokens of
  text + 60,000 → `videoSeen` true, column 1; text only → false, `warn`, the health Reader light yellow; a 40-minute
  video → no file part, "from the transcript (over 20 minutes)", reservation from text alone; a 40-minute video with
  `watch_video` → attached, timeout 200 s; no transcript + 40 min → no call, `no_captions`; a quote not in the words →
  `not_found` stored and counted; the reservation for a 10-minute video is ≥ 300/s × 600 s priced. A relay (stream)
  reading still passes every existing relay test. Statement pin for `/extract-video`.
- [x] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS with `import-health.test.ts`.
- [x] **Step 5:** commit `feat(saves): a YouTube reading — built by the Worker, watched up to 20 minutes, checked it was seen`.

### Task 8: Watch it too

**Files:** Modify `apps/worker/src/services/saves-video.ts`, `import-trail-read.ts`, `routes/my-saves.ts`,
`packages/saves/src/trail.ts`; Test `apps/worker/test/saves-video.test.ts`, `my-saves-trail.test.ts`.

**Interfaces — Produces:** `watchVideo(db, userId, postId, now) → "ok" | "not_found" | "conflict"` — a YouTube post
that is `matched` or `failed`, read without the video (`video_seen` null or 0), none of whose links is `saved` and
whose batch is not fitting: its pending links `removed`, its pending personal moves that no other live link names
deleted, `extraction`, `batch_id` cleared, `status` `queued`, `extract_attempts` 0, `watch_video` 1, and a `choice`
event "You asked for the video to be watched too (about $0.12)". ≤ 6 statements. `ImportTrailDto.post.video =
{ watched: boolean | null; watchAsked: boolean; watchCostMicros: number | null; offerWatch: boolean } | null`.
Route `POST /api/my-saves/posts/:id/watch`.

- [x] **Step 1: failing tests** — a 40-minute matched post: watch → queued, links removed, its pending move deleted,
  `/work?v=2` lists it `extract`, the trail offers no Watch it too while asked and says "Waiting for your computer's
  extension"; a post with a saved link → conflict; an Instagram post → conflict; a post already watched → conflict.
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(saves): Watch it too`.

### Task 9: A long follow-along stays whole (§14.5)

**Files:** Modify `apps/worker/src/services/proposal-kinds.ts` (`PINS_MAX`, `PINS_LINES_MAX` = 30), `saves-match.ts`
(statement note); Test `apps/worker/test/saves-batches.test.ts`, `saves-match.test.ts`, a `pin-moves` test.

- [x] **Step 1: failing tests** — a 30-move post matches in ≤ 45 statements with a judge call (pinned); a batch after a
  3-move post holds only it when the next post has 20 new moves, and the next batch is that post alone; `pin_moves`
  takes 30 pins and 30 lines, refuses 31.
- [x] **Step 2:** FAIL (pins). **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(saves): a 30-move follow-along is one batch and one card`.

### Task 10: The YouTube parsers (pure)

**Files:** Create `apps/saves-extension/src/youtube.ts`; Test `apps/saves-extension/test/youtube.test.ts`.

**Interfaces — Produces:**
- `YT_ORIGIN = "https://www.youtube.com"`, `watchUrl(id)`.
- `parsePlayer(raw: unknown, expectId: string) → { ok: true; meta: YoutubeMeta } | { ok: false; code: SaveErrorCode; message: string }`
  — `YoutubeMeta {id, title, channel: {handle, name}, lengthSec, description, publishedAt, live: boolean, tracks: CaptionTrack[]}`;
  playability `LOGIN_REQUIRED` → unplayable "YouTube asked to sign in" (reason naming age → "Age-restricted");
  `AGE_CHECK_REQUIRED`/`CONTENT_CHECK_REQUIRED` → "Age-restricted"; `ERROR`/`UNPLAYABLE` → gone "The video is gone" /
  unplayable with the site's reason (≤ 120 chars); `videoDetails.isLive` or `LIVE_STREAM_OFFLINE` → unplayable "Live
  now — try after it ends"; a different id → unknown "The player showed another video". Handle from
  `microformat.playerMicroformatRenderer.ownerProfileUrl` `@…`, else the channel id.
- `pickTrack(tracks) → CaptionTrack | null` — the video's language is the `asr` track's; an uploaded track in it
  (prefix match on the language subtag), else the `asr` one, else the first uploaded.
- `pickCapture(captures: {url, text}[], track) → string | null` (a non-empty capture whose `lang=` matches, else the first non-empty).
- `json3Segments(text) → [number, string][]` (events with `segs`, joined `utf8`, whitespace collapsed, empty dropped, start = `tStartMs/1000` to 0.1).
- `panelSegments(rows: {time, text}[]) → [number, string][]` (`"1:02:03"`/`"4:05"`).
- `chaptersFromMarkers(markersJson: string | null) → Chapter[]` (`DESCRIPTION_CHAPTERS` else `AUTO_CHAPTERS`);
  `chaptersFromDescription(desc) → Chapter[]` (starts at 0:00, ≥ 3, ascending, each ≥ 10 s after the last; else []).
- `toYoutubeSubmit(meta, transcript: {track, segments, via} | null, chapters: {list, from}, extVersion, ms) → PostSubmit`
  (source `youtube`, origin `pasted`, caption the description ≤ 5,000, hashtags from it, `readFacts.youtube`).

- [x] **Step 1: failing tests** — synthetic fixtures (made-up channel, fake id built at runtime) for every rule above,
  a 27-segment json3, the description rule's three refusals (no 0:00, two stamps, a 5-s gap).
- [x] **Step 2:** `pnpm vitest run apps/saves-extension/test/youtube.test.ts` — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [x] **Step 5:** commit `feat(saves-extension): YouTube's player, captions and chapters, read by pure functions`.

### Task 11: The YouTube page reader (thin)

**Files:** Create `apps/saves-extension/src/youtube-reader.ts`; Modify `manifest.json` (`https://www.youtube.com/*`);
Test `apps/saves-extension/test/youtube-reader.test.ts`.

**Interfaces — Produces:** `YoutubeTabs { open(url) → Promise<number>; mute(id); run<T>(id, func, args, world: "MAIN" | "ISOLATED") → Promise<T | null>; close(id) }`,
`chromeYoutubeTabs()`; page functions (self-contained): `installCaptionCapture()` (wraps XHR open/send and `fetch`,
keeps each `/api/timedtext` answer in `window.__rgCaptured`), `readPlayerInPage()` → `{player: string | null, markers: string | null}`,
`captionsInPage(languageCode, kind, waitMs)` → `{url, text}[]` (mute, `loadModule("captions")` + `setOption`, the
subtitles button off and on, seek to 1 s and play, poll 250 ms, pause), `transcriptPanelInPage(waitMs)` → `{time, text}[]`.
`readYoutube(tabs, id, opts: { now: () => number; sleep; capMs = 60_000 }) → Promise<{ ok: true; meta; transcript; chapters; ms } | { ok: false; code; message }>`
— open (background), mute, capture installed BEFORE captions, player polled until it shows the id (≤ 20 s: "The
player didn't load"), captions (≤ 15 s), the panel when nothing was captured, the tab closed in `finally`, the whole
read under `capMs` ("YouTube took too long").

- [x] **Step 1: failing tests** (a fake `YoutubeTabs`) — the capture is installed before the captions call; a capture
  yields segments `via: "captured"`; none → panel → `via: "panel"`; neither → transcript null (not a failure); an
  unplayable player → failure and the tab closed; a hung player → "The player didn't load" within the cap; each page
  function's source has no free identifiers beyond `window`/`document`/DOM globals (`func.toString()` checked for
  `import`/`require`).
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [x] **Step 5:** commit `feat(saves-extension): read a YouTube video in a background tab`.

### Task 12: The link queue and runner

**Files:** Create `apps/saves-extension/src/links.ts`; Modify `check.ts` (`mode: "queue"`, `prefetched`, `via`,
work skips `read`/`youtube`, maxTokens 32,000), `app-client.ts`, `background.ts`, `package.json`/`manifest.json`
version `0.3.0`; Test `apps/saves-extension/test/links.test.ts`, `check.test.ts`.

**Interfaces — Produces:**
- `LinkQueue(store)` — `"links"` in storage: `{source, key, url, addedAt, error: {code, message} | null}`; `add`
  (dedupe by source:key, clears an error), `next()` (first without an error), `fail`, `done`, `all`.
- `AppClient` gains `addLink(url) → {state: "known", postId, firstSeenAt} | {state: "added"}`, `links() → LinkDto[]`,
  `extractVideo(key, {model, maxTokens, retryIssues?, watchedSec?}) → ExtractAnswer` (timeout `callTimeoutMs + 60 s`),
  `work({links: true})` → `/work?v=2`.
- `runLinks(deps: LinksDeps) → Promise<{ read: number; failed: number }>` — first the app's work (`read` items join the
  queue; `youtube` filter items re-read; `youtube` extract items call `extractVideo`), then the queue one at a time:
  YouTube → `readYoutube` → `submitPost` → queued → `extractVideo` (one retry with issues); Instagram → `readPost` →
  a `submit` queue entry with `via: "pasted"` → `runCheck` in `queue` mode with the post prefetched. A read failure →
  `reportReadFailed` and the entry done when the app took it, else kept with its error. An unreachable app ends the run.
- `serialLock()` in `check.ts`; background: `checkOnce = singleFlight(() => lock(check-then-links))`,
  `linksOnce = singleFlight(() => lock(links))`; alarm `links` every 15 min; message `add-link` → normalize → app
  `addLink` (unreachable: queued anyway) → answer `{ok, known?, message}` at once, then `linksOnce()`.

- [x] **Step 1: failing tests** — a YouTube link: read, submitted, extracted, removed from the queue; a failed read:
  reported, removed; the app unreachable: kept, run ends; an Instagram link: one `readPost`, submit carries
  `readFacts.via: "pasted"`, extract runs, no check report sent; `runCheck`'s work skips a `read` item and a
  `youtube` item; two `add-link`s while a check runs are read after it, one at a time (the lock).
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS with the whole extension suite.
- [x] **Step 5:** commit `feat(saves-extension): pasted links, one at a time, and the app asked every 15 minutes`.

### Task 13: The popup's link field and recent links

**Files:** Modify `apps/saves-extension/src/popup.ts`, `status.ts`, `popup.css`, `background.ts` (status carries
links and the active YouTube tab); Test `apps/saves-extension/test/status.test.ts`, `popup.test.ts`.

**Interfaces — Produces:** `StatusResponse` gains `links: LinkDto[] | null`, `localLinks: LocalLink[]`,
`activeVideo: string | null` (the active tab's watch URL when it is one); `popupLinks(app, local, appUrl) → PopupLink[]`
(`{title, words, href (the trail), action: {kind: "retry" | "import_anyway", key, source} | null}`, local ones not in
the app's list first); `addAnswerLine(answer, now) → string` — "Added — it'll be waiting in the coach.",
"Already in — imported Tue 3 Nov.", the refusal. The field "Paste a YouTube or Instagram link", button "Add"
("Import this video" and pre-filled when `activeVideo`); Enter adds.

- [x] **Step 1: failing tests** — the field pre-fills and relabels on a YouTube page; Add sends `add-link` and shows
  the line; a known answer shows Open to the trail; recent links render words and Retry / Import anyway; a refused
  link shows the refusal and sends nothing.
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(saves-extension): paste a link in the popup`.

### Task 14: The app — Add a link, recent links, Watch it too, and the trail's new words

**Files:** Modify `packages/api-client/src/index.ts`, `packages/ui/src/screens/settings/saves.tsx`,
`packages/ui/src/screens/saves/trail-model.ts`, `trail-sheet.tsx`, `packages/ui/src/post-link.ts` (unchanged unless a
test needs it); Test `packages/ui/test/settings-saves.test.tsx`, `trail-model.test.ts`, `trail-sheet.test.tsx`.

**Interfaces — Produces:** `api.savesLinks()`, `api.savesAddLink(url)`, `api.savesWatch(postId)`; Settings → Saves
sheet: a field "Paste a YouTube or Instagram link" + Add above the health row, then "Recent links" rows (title or
link, words, Open → trail, Retry (re-add) / Import anyway (override process)). Trail: the account's first line for a
video "<title> · <channel> · YouTube · 12:34"; its health word "Read from the transcript only (over 20 minutes)" /
"The reader couldn't watch the video; it read the transcript only"; a **Watch it too (about $0.12)** button when
`offerWatch`; "Waiting for your computer's extension" when asked. Trail rows for `youtube` read facts, `watched`,
`videoSeen`, `quotes`, `dropped`, each quote as "“…” — checked: in the words / heard by the reader / not in the post"
(a `not_found` struck through), `useWhen`/`skipWhen`/`why` under the move.

- [x] **Step 1: failing tests** — the field posts and shows "Added — it'll be waiting in the coach." / the known line;
  recent links render; the trail shows the video line, Watch it too posts and then reads waiting; quote words.
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS with `packages/ui` saves suites; `pnpm --filter @rg/ui typecheck`.
- [x] **Step 5:** commit `feat(ui): add a link from the phone, recent links, Watch it too`.

### Task 15: Docs, rebase, full verification

- [x] The spec's §5.2 note that the reader captures the player's own `/api/timedtext` answer (the spike), and §5.4's
  Worker-built video body (this plan's ruling). (This repository keeps no `docs/STATUS.md`: the ledger and the final
  report carry what the lead verifies live.)
- [x] `git fetch origin && git rebase origin/main`; resolve keeping main's `prompts.ts` / `personal-records.ts` rules.
- [x] Scoped suites for every touched package plus `packages/database`, in local time and `TZ=UTC`; typechecks
  (`@rg/worker`, `@rg/ui`, `@rg/saves`, `@rg/saves-extension`, `@rg/api-client`, `@rg/database`); `pnpm --filter @rg/saves-extension build`.
- [x] commit `docs(saves): phase 2 — pasted links and YouTube`.
