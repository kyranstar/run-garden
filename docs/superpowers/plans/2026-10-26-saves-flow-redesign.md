# Saves Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One path from a new saves batch to the coach. A Today card and a coach chip lead to one coach card: Fit them in, or Choose first. The batch page asks one Skip | Coach | Include per new move. The coach's pins card names each move once and is never cut mid-sentence. Batches hold at most 12 new moves, and only one is open at a time.

**Architecture:**
- **Server state.** "Open", "fitting" and "dismissed" are server state on `save_batches` (migration 0031), never per-device state.
- **Owner routes.** `GET /api/my-saves/open`, `POST /batches/:id/fit`, `/dismiss` and `/fit/cancel` drive both surfaces.
- **The fit-in run.** The run is told its batch (`savesBatchId` in the run's settings, with the batch's skip set). The opening context, `read_saves`, `pin_moves`, `propose_workout` and `plan_set` all read the owner's choices from there.
- **The assembler.** It cuts batches oldest-first, at most 12 new moves each, only while no batch is open, and flags near-duplicates as it cuts. Matching flags them for new extractions too.
- **Removed.** The coach opening's `saves` source goes.

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free) with D1/drizzle; zod; React 18 and TanStack Query; Vitest (jsdom for the UI suites); Playwright (untouched).

**Spec:** `docs/superpowers/specs/2026-10-26-saves-flow-redesign-design.md`. It is binding, and where it is silent, its §12 decides. Its parent is `docs/superpowers/specs/2026-10-23-saved-posts-import-design.md` (§5.5, §6, §7, §17). The parent plan, `docs/superpowers/plans/2026-10-23-saved-posts-import.md`, shows the file layout and test conventions this plan follows.

## Global Constraints

**From the spec, §9 (verbatim)**
- Workers Free: ≤45 D1 statements a request, 10 ms CPU. `GET /open` is one statement; `/fit` stays within the save route's budget plus one update for the choices.
- Public repository: no real post links, handles, captions or media in code, fixtures, tests or docs. The move names in this document are the owner's own extracted names, already in the private database; they do not appear in tests.
- The owner's voice: brisk, one next step, no apologies, no explainers.
- Every principle in `workout-system-principles.md` and the original design's §10 (privacy) still applies.
- Migrations: 0031 (`dismissed_at`, `fit_choice`), additive.

**Where this plan goes beyond §9**
- **`GET /open`.** It is one statement while a batch is open or no new move waits. When nothing is open and new moves wait, it assembles the next batch first: ≤ 1 + 8 + 1 statements. This is what makes §3.1 true: "When it is fitted in, the next waiting batch opens."
- **`/fit`.** It pays the save route's statements, plus one fit-check read, plus the choices statement (Task 4 pins the exact number).

**Repository rules**
- **wrangler.** Never run wrangler against `--remote` in a task. Task 15's script is run by the lead, after deploy, never by an implementer.
- **Node and vitest.** vitest runs on the default node (v21; `node --version`). Never run tests under node 22: better-sqlite3 dies there. Use `NODE_OPTIONS=--max-old-space-size=4096` for full runs.
- **Commands.** Run everything from the worktree root:
  - suites: `pnpm vitest run <paths>`
  - types: `pnpm typecheck`
- **Git.**
  - Never `git stash`.
  - Commit source only, never `.superpowers/`.
  - End each commit with the session's two trailer lines (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, then `Claude-Session: https://claude.ai/code/session_01CdKANDrBQqYpaTiCBGMaJd`).
  - Never push from a task.
- **Synthetic data only.**
  - Assemble links as `seed-saves-transform.test.ts` does, so the privacy grep never sees a literal link.
  - Use made-up `Zorbex …` move names and made-up creators.
  - Never use a move name, insight or post quoted in the spec.
- **Untrusted text.** Model-written names, summaries, insights and creators reach a model only through `untrusted()` / `untrustedOrNull()` / `markUntrusted()`. The UI draws them as text.
- **Statement and size pins.**
  - Every route or tool whose D1 count changes updates its pin to the exact new number, with a comment naming this change.
  - Every prompt-size pin that moves is rebased as `REBASED 2026-10-26 (saves flow redesign): <what grew> — measured N`, with ≥ 100 tokens (400 chars) of headroom.
- **UI.**
  - Use design tokens only.
  - Targets are 44 px.
  - Check both themes.
  - Follow the density rule: names, one line of purpose, the control. No explainer captions.

**Copy, exactly** (`{n}` is digits; `{N}` is `numberWord` (Task 2), capitalised at a sentence's start; `{word}` is `numberWord`)
- **Today card**
  - Headline: `{n} new moves from your saves`. One move: `1 new move from your saves`. With no new move: `{n} saved moves you already have`.
  - Under it: `{m} more were already yours`. One move: `1 more was already yours`. Shown only when there are new moves and `m > 0`.
  - Button: `Fit them in`.
- **Coach chip:** `{n} new saved moves`. One move: `1 new saved move`. With no new move: `{m} saved moves`.
- **Coach card**
  - Line (written by the server, `savesCardLine`): `{N} new moves came in from your saves: {groups}. Want me to fit them into the week, or choose first?`
  - One new move: `One new move came in from your saves: {group}. Want me to fit it into the week, or choose first?`
  - No new move: `{N} saved moves you already have came in. Want me to fit them into the week, or choose first?`
  - Buttons: `Fit them in`, `Choose first`. Text link: `not now`.
- **Put-aside sheet:** `Put aside. Find it again under Settings → Saves (or the Studio tab), where Fit them in brings it back.` One button: `OK`.
- **While fitting** (every surface, in place of the button): `Fitting in… open the coach`.
- **On a 409 `batch_open`:** `finish the batch that is open first`.
- **Batch page**
  - Title: `{n} new moves` (one move: `1 new move`).
  - Line under it: `On **Coach**, the coach decides. **Include** is in. **Skip** stays out.` The three words are bold.
  - Control: `Skip` | `Coach` | `Include`.
  - Folded line: `▸ Already yours · {m}` (`▾` when unfolded).
  - Row: `like {name}`.
  - Tally: `{i} in · {o} out · {c} on the coach's call`. Zero parts are left out.
  - Tally when every move is on the coach's call: `On the coach's call` (1 move), `Both on the coach's call` (2), `All {word} on the coach's call` (≥ 3).
  - Button: `Fit these in`.
- **Pins card summary:** `{N} join the rotation.`, then `{name} waits.` (one left out) or `{N} wait.` (several left out). One joins: `One joins the rotation.` None join: `None join the rotation.`
- **Skip refusal:** `the athlete skipped {name}`.

## Review Focus

1. **The fit-in run fails to start after `/fit` marked the batch** (a run already at work, the week's budget, offline, a create that returns the existing run). The card must come back with **Fit them in** at once, not read "Fitting in…" for an hour. Pinned in Task 4 (`my-saves-fit.test.ts`: "fit/cancel clears the fit at once") and Task 12 (`coach-saves-live.test.tsx`: "a refused run start cancels the fit: the card offers Fit them in again").
2. **A pins card stored before this change** (prod's first fitted batch: `lines` as plain strings). It must still render its lines on the card, in the conversation and in the coach's reads. Pinned in Task 7 (`design-move-pins.test.ts`: "an op stored with string lines still renders, word for word").
3. **The model still writes the name** ("Name (id): text"), or a move's name alone is near the cap. The card must show the name once, with the text cut at a sentence end, never a doubled name or a cut word. Pinned in Task 7 ("a line that repeats its move's name or id shows the name once; a long line ends at a sentence, inside PIN_LINE_MAX").
4. **Choices that no longer match the batch** (a row removed in its sheet, a move merged by Same as…, a stale page from another device). `/fit` must ignore any id that is not one of the batch's new moves, write no choice for a removed move, and clear a merged move's choice. Pinned in Task 4 ("choices that name a removed, merged or foreign move change nothing").
5. **One new move shown by posts on both sides of the 12-move cut.** It counts once, belongs to the first batch, and in the later batch reads as new while pending, never as "already yours". Pinned in Task 3 (`saves-batches.test.ts`: "a move shared across the cut counts once and stays new in the later batch while pending").

---

### Task 1: Migration 0031 and the schema

**Files:**
- Create: `packages/database/migrations/0031_saves_flow.sql`
- Modify: `packages/database/src/schema/saves.ts:61-77` (`saveBatches`), `:79-95` (`personalMoves`), `:97-117` (`savedPostMoves`); `packages/database/src/version.ts:10`
- Test: `apps/worker/test/saves-schema.test.ts`; `packages/database/test/{migrations,schema-version}.test.ts` (existing, must stay green)

**Interfaces:**
- **Produces:**
  - `save_batches.dismissed_at` and `save_batches.fit_started_at`, both nullable text. In drizzle they are `saveBatches.dismissedAt` and `saveBatches.fitStartedAt`, typed `string | null`.
  - `saveBatches.status` is typed `"held" | "released" | "saved" | "dismissed" | "superseded"`.
  - `personal_moves.fit_choice` is `personalMoves.fitChoice`, typed `$type<"include" | "skip">()`. Null means the coach's call.
  - `saved_post_moves.like_move_id` is `savedPostMoves.likeMoveId`, typed `string | null`. It names the near-duplicate the link's move is like (spec §6, §12.4). The check word `near_duplicate` is read from it (Task 4); no other column carries it.
  - `SCHEMA_VERSION = "0031"`.

- [ ] **Step 1: Write the failing test** in `saves-schema.test.ts`:

```ts
it("0031: a batch's dismissal and fit start, a move's fit choice, a link's like — null until written", async () => {
  await db.insert(saveBatches).values({ id: "b1", userId: "u1", status: "released", createdAt: T });
  await db.insert(personalMoves).values({ id: "m1", userId: "u1", status: "pending", record: { id: "m1", name: "Example" }, createdAt: T, updatedAt: T });
  await db.insert(savedPostMoves).values({ id: "l1", userId: "u1", postId: "p1", position: 0, moveId: "m1", moveKind: "personal", status: "pending", createdAt: T });
  expect((await db.select().from(saveBatches))[0]).toMatchObject({ dismissedAt: null, fitStartedAt: null });
  expect((await db.select().from(personalMoves))[0]!.fitChoice).toBeNull();
  expect((await db.select().from(savedPostMoves))[0]!.likeMoveId).toBeNull();
  await db.update(saveBatches).set({ status: "superseded", dismissedAt: T, fitStartedAt: T });
  await db.update(personalMoves).set({ fitChoice: "skip" });
  await db.update(savedPostMoves).set({ likeMoveId: "m0" });
  expect((await db.select().from(saveBatches))[0]).toMatchObject({ status: "superseded", dismissedAt: T, fitStartedAt: T });
  expect((await db.select().from(personalMoves))[0]!.fitChoice).toBe("skip");
  expect((await db.select().from(savedPostMoves))[0]!.likeMoveId).toBe("m0");
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run apps/worker/test/saves-schema.test.ts packages/database` → FAIL (unknown columns; `schema-version` still passes).
- [ ] **Step 3: Write the migration, then the schema.**
  - Start the migration with a `-- 0031: …` header saying what each column holds, and that the change is purely additive (nullable columns).
  - Then four `ALTER TABLE \`…\` ADD \`…\` text;` statements, separated by `--> statement-breakpoint`, in the order `save_batches.dismissed_at`, `save_batches.fit_started_at`, `personal_moves.fit_choice`, `saved_post_moves.like_move_id`.
  - Then the four drizzle columns and the status union, each with a one-line doc comment, and `SCHEMA_VERSION = "0031"`.
- [ ] **Step 4: Run it again.** Same command → PASS, `migrations` and `schema-version` included.
- [ ] **Step 5: Commit.** `git add packages/database apps/worker/test/saves-schema.test.ts && git commit -m "feat(database): 0031 — a batch's dismissal and fit start, a move's fit choice, a link's like"`

### Task 2: `@rg/saves` — the contract for the new flow

**Files:**
- Modify: `packages/saves/src/review.ts` (DTOs, `fitSchema`), `packages/saves/src/breakdown.ts` (`numberWord`, `groupCounts`, `savesCardLine`), `packages/saves/src/normalize.ts` (`nearDuplicateOf`, `sameMoveType`)
- Test: `packages/saves/test/{breakdown,normalize,schemas}.test.ts`

**Interfaces:**
- **Produces, in `review.ts`:**
  - `type FitChoice = "include" | "skip"`.
  - `SaveBatchDto` gains `dismissedAt: string | null`, `fitStartedAt: string | null` and `fitting: boolean`. `fitting` is the server's reading of the one-hour rule (Task 3's `isFitting`). `status` gains `"superseded"`.
  - `CheckWhy` gains `"near_duplicate"`.
  - `SaveBatchRowDto.move` gains:
    - `purpose: string | null` (the extraction's `purpose` at the link's position)
    - `like?: { id: string; name: string }`
    - `choice: FitChoice | null` (the move's stored `fit_choice`; null for a linked row)
  - `fitSchema`: `z.object({ choices: z.record(z.string().regex(PERSONAL_ID_RE), z.enum(["include", "skip"])) }).strict()`, refined to ≤ 60 keys. Also `type FitBody = z.infer<typeof fitSchema>`.
  - `FitAnswerDto { batchId: string; request: string; moves: number; links: number }`, where `request` is `FIT_SAVES_REQUEST`.
  - `OpenSavesBatchDto { id: string; counts: { new: number; linked: number }; groups: Array<{ group: MoveGroup; count: number }>; line: string; fitting: boolean }`.
  - `OpenSavesDto { open: OpenSavesBatchDto | null }`.
- **Produces, in `breakdown.ts`:**
  - `numberWord(n: number): string` gives `"one"`…`"twelve"`, and digits otherwise.
  - `groupCounts(moves: Pick<ExerciseRecord, "regions" | "contraction">[]): Array<{ group: MoveGroup; count: number }>` puts the biggest first; ties keep the order of first appearance (as `batchNotice` does).
  - `savesCardLine(counts: { new: number; linked: number }, groups: Array<{ group: MoveGroup; count: number }>): string` writes the card copy exactly (Global Constraints):
    - The list is at most four groups as `{count} {group}`, joined `a, b, c and d`.
    - Moves beyond the fourth group are summed into `and {k} more`, joined after a comma: `a, b, c, d and 2 more`.
    - With one new move it is the group word alone.
- **Produces, in `normalize.ts`:**
  - `interface NearMove { name: string; load: string | null; doseType: string | null }` and `interface NearCandidate extends NearMove { id: string }`.
  - `sameMoveType(a: NearMove, b: NearMove): boolean` is false only when both loads are present and differ, or both dose types are present and differ.
  - `nearDuplicateOf(move: NearMove, pool: readonly NearCandidate[]): NearCandidate | null`, by the rule below:

```
words(x) = set of normalizeMoveName(x).split(" ") with [^a-z0-9] stripped, empties dropped
near(a, b): equal normalized names → true; else s = |a ∩ b|:
            s >= 2 && max(|a|,|b|) - s <= 2 && min(|a|,|b|) - s <= 1
best = the near candidate with the largest s; ties keep pool order (callers put the owner's active moves first)
```

- [ ] **Step 1: Write the failing tests**

```ts
// breakdown.test.ts
expect([numberWord(1), numberWord(9), numberWord(12), numberWord(13)]).toEqual(["one", "nine", "twelve", "13"]);
expect(savesCardLine({ new: 9, linked: 4 }, [{ group: "upper back", count: 3 }, { group: "neck", count: 2 }, { group: "core", count: 2 }, { group: "hip", count: 1 }, { group: "leg", count: 1 }]))
  .toBe("Nine new moves came in from your saves: 3 upper back, 2 neck, 2 core, 1 hip and 1 more. Want me to fit them into the week, or choose first?");
expect(savesCardLine({ new: 4, linked: 0 }, [{ group: "hip", count: 2 }, { group: "neck", count: 1 }, { group: "jump", count: 1 }]))
  .toBe("Four new moves came in from your saves: 2 hip, 1 neck and 1 jump. Want me to fit them into the week, or choose first?");
expect(savesCardLine({ new: 1, linked: 2 }, [{ group: "hip", count: 1 }])).toBe("One new move came in from your saves: hip. Want me to fit it into the week, or choose first?");
expect(savesCardLine({ new: 0, linked: 3 }, [])).toBe("Three saved moves you already have came in. Want me to fit them into the week, or choose first?");
// groupCounts: [hip-region, neck, hip, jump] → [{hip,2},{neck,1},{jump,1}]

// normalize.test.ts
const m = (name: string, over: Partial<NearCandidate> = {}): NearCandidate => ({ id: name, name, load: "none", doseType: "reps", ...over });
expect(nearDuplicateOf(m("Zorbex dynamic rotational swing"), [m("Zorbex rotational swing")])?.id).toBe("Zorbex rotational swing");
expect(nearDuplicateOf(m("Zorbex cobra chest lift"), [m("Zorbex cobra hold")])?.id).toBe("Zorbex cobra hold");
expect(nearDuplicateOf(m("Zorbex leg glute bridge"), [m("Zorbex leg calf raise")])).toBeNull();
expect(nearDuplicateOf(m("Zorbex bug"), [m("Zorbex hang")])).toBeNull();
expect(nearDuplicateOf(m("Zorbex plank", { load: "external" }), [m("Zorbex plank")])?.id).toBe("Zorbex plank"); // equal names: near, whatever the type
expect(sameMoveType(m("a", { load: "external" }), m("b"))).toBe(false);
expect(sameMoveType(m("a", { doseType: null }), m("b"))).toBe(true);

// schemas.test.ts
expect(fitSchema.safeParse({ choices: {} }).success).toBe(true);
expect(fitSchema.safeParse({ choices: { myZorbexQuadShuffleabc123: "include" } }).success).toBe(true);
expect(fitSchema.safeParse({ choices: { myZorbexQuadShuffleabc123: "maybe" } }).success).toBe(false);
expect(fitSchema.safeParse({ choices: { gobletSquat: "skip" } }).success).toBe(false);
expect(fitSchema.safeParse({ choices: {}, extra: 1 }).success).toBe(false);
```

- [ ] **Step 2: Run them.** `pnpm vitest run packages/saves` → FAIL (not exported).
- [ ] **Step 3: Implement** the signatures above in their files. `index.ts` already re-exports all three modules.
- [ ] **Step 4: Run them again.** `pnpm vitest run packages/saves && pnpm --filter @rg/saves typecheck` → PASS.
  - The new `SaveBatchDto` and `SaveBatchRowDto.move` fields would break the Worker's typecheck until Task 4. Add them as optional (`?:`) here, and make them required in Task 4, Step 3.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): the contract for one path — fit choices, the open batch, the card's line, near-duplicates"`

### Task 3: The assembler — one open batch, at most 12 new moves, near-duplicates flagged at the cut

**Files:**
- Modify `apps/worker/src/services/saves-batches.ts`:
  - `:1-10` (the module doc)
  - `:24-25` (`BATCH_GAP_MS` goes)
  - `:38-74` (`noticeOf`)
  - `:76-169` (`assembleBatch`)
  - `:322-323` (`saveBatch`'s activation)
- Modify `apps/worker/src/services/saves-review.ts`:
  - `:39` (the import)
  - `:63-69` (`BORN_HERE` → `NEW_IN_BATCH`)
  - `:482-514` (`releaseBatch`'s gate)
- Modify `apps/worker/src/services/personal-moves.ts:24-43` (`PersonalMatchRow` gains `load` and `doseType`)
- Modify `apps/worker/src/routes/my-saves.ts:21-22,94` (`batch_open` replaces `too_soon`)
- Test: `apps/worker/test/saves-batches.test.ts`, `apps/worker/test/my-saves-review.test.ts:654-690`, `apps/worker/test/saves-routes.test.ts:316` (must stay green)

**Interfaces:**
- **Consumes:** `nearDuplicateOf` and `NearCandidate` (Task 2); the Task 1 columns.
- **Produces, in `saves-batches.ts`:**
  - `export const BATCH_NEW_MAX = 12;` and `export const FIT_STARTED_TTL_MS = 3_600_000;`
  - `export function isFitting(fitStartedAt: string | null, now: string): boolean` is true while `now - fitStartedAt < FIT_STARTED_TTL_MS`.
  - `export function openBatchSql(alias: string): SQL` gives `<a>.status in ('released','saved') and <a>.fitted_at is null and <a>.dismissed_at is null`.
- **`assembleBatch(db, env, userId, now): Promise<string | null>`** keeps its signature. What it does:
  - It returns null, writing nothing, while a batch is open (`openBatchSql`).
  - It takes posts in arrival order (`first_seen_at`, then `id`) under the cut rule below.
  - It writes nothing when the posts it takes bring no new move.
  - Statements: the gate 1, the waiting rows 1, the account's personal moves 1 (`loadPersonalForMatch`), then one transaction of 4, plus 1 when the cut flags any near-duplicate. That is 7, or 8.
- **`noticeOf` (rule change).** A move is new when it is personal, not merged, and either its `batch_id` is this batch's or it is still `pending` (spec §12.3). Every other move is the owner's.
- **`saveBatch`.** The moves it activates are also stamped `batchId = <this batch>`, so a pending move an earlier, dismissed batch brought belongs to the batch that saved it.
- **Produces, in `saves-review.ts`:** ``export const NEW_IN_BATCH = sql`(l.move_kind = 'personal' and coalesce(pm.status <> 'merged' and (pm.batch_id = l.batch_id or pm.status = 'pending'), 0))` ``. It replaces `BORN_HERE` everywhere.
- **`releaseBatch`.** It answers `"batch_open"` when another batch is open, in place of `"too_soon"`. Its read gains that one subquery and adds no statement. The route maps it to 409 `{ error: "batch_open" }`.
- **`PersonalMatchRow`** gains `load?: string | null` and `doseType?: string | null`, read out by SQLite as `json_extract(record, '$.load')` and `'$.dose.type'` in the same statement.

The cut, and the near-duplicate marks:

```
posts = waiting rows grouped by post, in (first_seen_at, id) order
post.fresh = distinct personal move ids of its pending links whose move is pending and not merged
taken = [], fresh = ∅
for post in posts:
  next = fresh ∪ post.fresh
  if taken.length > 0 and |next| > BATCH_NEW_MAX: break
  taken.push(post); fresh = next
if |fresh| == 0: return null                      // linked-only posts wait to ride with a new move
pool = account's active, unmerged personal moves as NearCandidate (load, doseType from the row)
for m in fresh, in post order:
  hit = nearDuplicateOf(m, [...pool, ...earlier new moves of this batch])
  if hit and hit.id != m.id: marks.push([m.id, hit.id])
marks → ONE update inside the transaction: saved_post_moves of this batch, pending, move_id in marks
        → check_flag = 1, like_move_id = the mapped id (json_each over the marks)
```

- [ ] **Step 1: Write the failing tests** in `saves-batches.test.ts`. Use the file's `matched(key, moves, owner, now)` (its `now` is the post's `first_seen_at`: pass `at(h)` to set arrival order), `move(name, over)` and `batchOf`. Name synthetic moves so that no two share more than one word (`Zorbex alpha`, `Zorbex beta`, …), except where a test wants a near-duplicate: `nearDuplicateOf` flags two names that share two words and differ by one.
  - **"takes the oldest posts first up to 12 new moves; the rest wait for the next batch":**
    - Seed three posts of 5 new moves each, at `at(0)`, `at(1)` and `at(2)`.
    - Expect the first two posts to carry the batch and the third `batchId === null`.
    - Expect 10 distinct new personal moves to carry the batch.
  - **"linked moves ride along and never count toward the cap":** an older post with two library moves, then a post with 12 new ones. Both are in the batch.
  - **"a pool whose moves are all the owner's makes no batch; they ride with the next new move":**
    - Two library-only posts give `assembleBatch` → null, and nothing is written.
    - Then add a post with one new move. The next call batches all three.
  - **"no batch while one is open; fitted in or dismissed opens the gate":** this replaces "does nothing within 20 h…".
    - With the first batch released (or saved), fitted null and not dismissed, the second call returns null and makes 0 writes.
    - After `fittedAt` is set, the second call batches the waiting post. Set `dismissedAt` on another fixture and expect the same.
  - **"a move shared across the cut counts once and stays new in the later batch while pending"** (Review Focus 5):
    - Post 1 holds 12 new moves, one of them "Zorbex quad shuffle". Post 2 holds "Zorbex quad shuffles" and one more new move.
    - Batch 1 is post 1, with 12 new moves.
    - Dismiss batch 1. Batch 2 is post 2. Its notice is `From your saves: 2 new moves (2 hip).`: the shared move is pending, so it is new, never "had".
  - **"near-duplicates at the cut: like an active move, and the later of two like new moves — one statement":**
    - The owner has an active "Zorbex cobra hold".
    - The batch brings "Zorbex cobra chest lift", "Zorbex rotational swing" and, in a later post, "Zorbex dynamic rotational swing".
    - The links of "cobra chest lift" get `checkFlag: true` and `likeMoveId` = the active move's id.
    - The links of "dynamic rotational swing" get `likeMoveId` = the "rotational swing" id.
    - "rotational swing" is unflagged.
    - Statements: 8. The plain case in the first existing test is 7, and its comment becomes `gate 1, waiting 1, personal moves 1, the batch and its stamps 4`.
  - **Rewrite** "a pending move an earlier, unsaved batch brought reads as one the owner had" (lines 149–160):
    - Its new name: "…reads as new in the later batch (§12.3)".
    - Dismiss the first batch before the second call.
    - The expected notice is `From your saves: 2 new moves (1 hip, 1 neck).`
  - **Amend** "counts a move another post already brought as the owner's when it was saved before": set the first batch's `fittedAt` after `saveBatch`.
  - **"saveBatch stamps the moves it makes usable with its own batch":**
    - Batch 1 brings move M and is dismissed. Batch 2 links M and is saved.
    - M is now `active` with `batchId` = batch 2.
  - **`my-saves-review.test.ts`:**
    - Rename the `:677` test "a release while another batch is open is 409 batch_open, and the batch stays held". Expect `res.body` to equal `{ error: "batch_open" }`.
    - Flip the `:654` M1 test so the release words the earlier batch's pending move as new.
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/saves-batches.test.ts apps/worker/test/my-saves-review.test.ts apps/worker/test/saves-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - Rewrite the module doc's first paragraph around the gate and the cap. Delete `BATCH_GAP_MS` and its import.
  - The waiting read adds `first_seen_at` and the move's name, load and dose type (`json_extract`). It orders by `first_seen_at, id`.
  - The `postIds` the stamps use become the taken posts only.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm --filter @rg/worker typecheck` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): one open batch at a time, at most 12 new moves, oldest first; near-duplicates flagged at the cut"`

### Task 4: The owner's routes — open, fit, dismiss, cancel

**Files:**
- Modify: `apps/worker/src/routes/my-saves.ts` (the header doc `:5-28`; four routes; `now` passed to the reads)
- Modify `apps/worker/src/services/saves-review.ts`:
  - `:48-107` (`BatchRead`, `BATCH_COLUMNS`, `batchOf(r, now)`, `listBatches(..., now)`)
  - `:110-228` (`batchDetail(..., now)`: the row's purpose, like and choice; `checkWhyOf`)
  - `:371-381` (`rematchLink`'s merge clears `fitChoice`)
  - New functions below.
- Modify: `apps/worker/src/services/saves-batches.ts` `saveBatch` (an optional `fit` argument)
- Modify: `packages/saves/src/review.ts` (Task 2's optional DTO fields become required)
- Test: create `apps/worker/test/my-saves-fit.test.ts`; update `apps/worker/test/my-saves-review.test.ts` (the detail rows; no statement changes)

**Interfaces:**
- **Consumes:**
  - from Task 3: `openBatchSql`, `isFitting`, `FIT_STARTED_TTL_MS`, `NEW_IN_BATCH`, `assembleBatch`
  - from Task 2: `savesCardLine`, `groupCounts`, `fitSchema`, `FitAnswerDto` and `OpenSavesDto`
- **Produces, in `saves-batches.ts`:** `saveBatch(db, userId, batchId, now, fit?: { at: string; choices: Record<string, FitChoice> })`.
  - With `fit`, its transaction gains one statement after the activation: the batch's active moves' `fit_choice` set from `choices` (`json_extract(<choices>, '$.' || id)`; an id not named → null).
  - Its final batch update also sets `fit_started_at = fit.at` and `dismissed_at = null`.
  - Statements: 6, or 7 with `fit`.
- **Produces, in `saves-review.ts`:**
  - `readOpenBatch(db: Db, env: Env, userId: string, now: string): Promise<OpenSavesDto>`
    - It is ONE statement: two scalar subqueries, the open batch (as JSON, with its new moves' regions and contraction, and its counts by `NEW_IN_BATCH`) and `waiting`.
    - `waiting` counts the matched, unbatched posts with a pending link to a pending personal move.
    - When nothing is open, `waiting > 0`, and `env.SAVES_HOLD_BATCHES !== "1"`, it calls `assembleBatch` and reads once more.
    - `line = savesCardLine(counts, groups)`; `fitting = isFitting(fit_started_at, now)`.
  - `fitBatch(db: Db, userId: string, batchId: string, choices: Record<string, FitChoice>, now: string): Promise<FitOutcome>`
    - `type FitOutcome = { kind: "ok"; answer: FitAnswerDto } | { kind: "not_found" } | { kind: "conflict"; error: "fitting" | "batch_open" | "already_fitted" | "not_released" }`
    - Its one read is the batch, plus whether another batch of the account's is open (`openBatchSql`, `id <> batchId`).
    - The outcome, in order:
      - not the account's → `not_found`
      - `fitted_at` set → `already_fitted`
      - `held` or `superseded` → `not_released`
      - `isFitting` → `fitting`
      - another batch open → `batch_open`: this covers a dismissed batch while another is open, spec §12.3
    - Otherwise:
      - a `released` batch → `saveBatch(..., { at: now, choices })`
      - a `saved` batch (a re-fit after a decline) → one transaction of 2: the choices statement, and `fit_started_at = now, dismissed_at = null`
    - The answer is `{ batchId, request: FIT_SAVES_REQUEST, moves, links }`.
  - `dismissBatch(db, userId, batchId, now): Promise<"ok" | "not_found" | "conflict">` writes `dismissed_at = now` only on an open batch that is not fitting (1 statement, 2 when it can't). It never saves: the moves stay pending.
  - `cancelFit(db, userId, batchId): Promise<"ok" | "not_found">` writes `fit_started_at = null` where `fitted_at is null` (1 statement, 2 when not found).
  - `SaveBatchDto` from `BATCH_COLUMNS` adds `dismissedAt`, `fitStartedAt` and `fitting`.
  - The detail row adds:
    - `purpose` (`json_extract(p.extraction, '$.moves[' || l.position || '].purpose')`)
    - `like` (`l.like_move_id` and the like move's `json_extract(record,'$.name')`, by subquery)
    - `choice` (`pm.fit_choice`, new rows only)
  - `checkWhyOf` adds `"near_duplicate"` when the link has a like.
- **Produces, routes** (cookie, `SAVES_IMPORT`, `Cache-Control: no-store`, as today):
  - `GET /open` → `OpenSavesDto`
  - `POST /batches/:id/fit`, body `fitSchema`: 200 `FitAnswerDto` | 404 | 409 `{ error }` | 422 `invalid`
  - `POST /batches/:id/dismiss` → `{ ok: true }` | 404 | 409 `not_open`
  - `POST /batches/:id/fit/cancel` → `{ ok: true }` | 404
- **`/save` stays** for the move sheet's needs. The header doc lists all four routes.

- [ ] **Step 1: Write the failing tests** in `my-saves-fit.test.ts`.
  - Setup: copy `my-saves-review.test.ts`'s setup: `makeTestDb` with `onStatement`, `makeTestUser`, `createSession`, `mountRoutes(db, "/api/my-saves", mySavesRoutes)`, `matched()`, `env = { SAVES_IMPORT: "1" }`.
  - **"GET /open: none is { open: null } — 2 statements in all (the sign-in 1, the read 1)"**
  - **"GET /open: the open batch — its id, counts, groups and the card's line, word for word; not fitting":**
    - Two new moves (hip, neck) and one library move.
    - The line is `Two new moves came in from your saves: 1 hip and 1 neck. Want me to fit them into the week, or choose first?`
  - **"GET /open: nothing open and new moves waiting — it assembles the next batch and answers it; never under SAVES_HOLD_BATCHES=1"**
  - **"POST /fit with no choices saves the batch and starts the fit, within the save route's statements + 2":**
    - The moves become `active` and the links `saved`.
    - `fitStartedAt === NOW`.
    - The body is `{ batchId, request: FIT_SAVES_REQUEST, moves: 2, links: 3 }`.
    - The statements equal `/save`'s measured count + 2.
    - `GET /open` then says `fitting: true`.
  - **"a second POST /fit while fitting is 409 fitting; past FIT_STARTED_TTL_MS it fits again"**
  - **"choices are stored per new move; a re-fit after a decline rewrites them":**
    - First `{ a: "include", b: "skip" }`. Clear `fit_started_at`, then re-fit with `{ a: "skip" }`.
    - Expect `a` "skip" and `b` null.
  - **"choices that name a removed, merged or foreign move change nothing"** (Review Focus 4):
    - Remove the row of move `c`, then `fit` with `{ c: "include", myZorbexElsewhere000000: "skip" }`.
    - Expect `c.fitChoice` null and no other account's row touched.
    - A move merged by Same as… before the fit has `fitChoice` null after the merge.
  - **"a dismissed batch: POST /fit clears dismissed_at and fits when nothing else is open; 409 batch_open while another batch is open"**
  - **"409 already_fitted, 409 not_released (held), 404 for another account's batch, 422 for a body outside fitSchema"**
  - **"POST /dismiss: dismissed_at set, moves still pending, nothing in the coach's memory; GET /open then opens the next waiting batch; dismissing while fitting is 409 not_open"**
  - **"fit/cancel clears the fit at once: GET /open says fitting false"** (Review Focus 1)
  - **The batch detail:**
    - each new row carries `purpose`, `choice`, and `like: { id, name }` where the link has one;
    - `checkWhy` holds `near_duplicate`;
    - the batch carries `dismissedAt`, `fitStartedAt` and `fitting`;
    - still 3 statements.
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/my-saves-fit.test.ts apps/worker/test/my-saves-review.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above. Make the Task 2 DTO fields required.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm typecheck` → PASS. The UI's `tsconfig` covers `src` only, but update the UI fixtures typed as these DTOs anyway (`packages/ui/test/studio-saves.test.tsx` `BATCH`/`ROWS`, `studio-fixtures.ts`), so the shapes stay true.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): the open batch, Fit them in, not now and a cancelled fit — four owner routes"`

### Task 5: A fit ends with its card — approved, declined, superseded or expired

**Files:**
- Modify: `apps/worker/src/services/saves-batches.ts` (`releaseFitStarts`)
- Modify `apps/worker/src/services/design-approve.ts`:
  - `:1523-1527` (the `fitted_at` write also clears `fit_started_at`)
  - `:433-438` (`DECLINE_COST = 7`, its doc naming the release)
  - `:1806-1861` (`declineDesignOps` calls the release)
- Modify: `apps/worker/src/services/design-orchestrate.ts:650-705` (`supersedeOlderPlans`: `RETURNING id, <has a move_pins op>`, then the release)
- Modify: `apps/worker/src/routes/coach.ts:127-171` (`sweepExpiredProposals` collects the expired rows that hold a `move_pins` op with a `batchId`, then one release)
- Test: `apps/worker/test/design-move-pins.test.ts` (a new `describe`)

**Interfaces:**
- **Consumes:** `MovePinsOp.batchId`; `fit_started_at` (Task 1).
- **Produces:** `releaseFitStarts(db: Db, userId: string, proposalIds: readonly string[]): Promise<void>`. It is ONE statement, run only when `proposalIds` is non-empty:

```sql
update save_batches set fit_started_at = null
where user_id = :u and fitted_at is null and fit_started_at is not null
  and exists (select 1 from coach_proposals p, json_each(case when json_valid(p.ops) then p.ops else '[]' end) o
    where p.user_id = :u and p.id in (select value from json_each(:ids))
      and json_extract(o.value, '$.kind') = 'move_pins' and json_extract(o.value, '$.batchId') = save_batches.id
      and (json_extract(o.value, '$.outcome.status') in ('declined', 'superseded') or p.status in ('declined', 'superseded', 'expired', 'cancelled'))
      and save_batches.fit_started_at <= p.created_at)   -- a fit started after this card was made is a newer fit's
```

- [ ] **Step 1: Write the failing tests.** Use the file's `proposed`, `invoke`, `approveAll`, `fittedAt` and `seedSavedBatch`. Set `fitStartedAt` on the seeded batch just before `proposed(...)`.
  - **"approved: fitted_at set and the fit cleared"**
  - **"Not now (decline): the fit cleared, fitted_at null — the card comes back; the decline within DECLINE_COST (7)"**
  - **"expired by the sweep: the fit cleared"**: set `expiresAt` in the past and call `sweepExpiredProposals(db, userId, today)`.
  - **"superseded by a newer pins card naming the same move: the old card's fit cleared only when the fit started before it was made"**: two cases, one per side of `created_at`.
  - **"a fit started after the declined card was made is left as it is"**
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/design-move-pins.test.ts apps/worker/test/design-approve-routes.test.ts apps/worker/test/design-plan-adjust-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Each caller calls `releaseFitStarts` after its own write succeeds:
  - in `declineDesignOps`, after `writeOps`, only when a declined op is a `move_pins` op with a `batchId`;
  - in `supersedeOlderPlans`, only when a returned row held one;
  - in the sweep, for the rows it expired.
- [ ] **Step 4: Run them again.** Same command → PASS. The other decline suites hold at ≤ 7.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): a fit ends with its card — approved it closes the batch, any other ending brings Fit them in back"`

### Task 6: The run knows its batch — `savesBatchId`, the skip set, the context and `read_saves`

**Files:**
- Modify: `apps/worker/src/routes/coach-runs.ts:124-169` (`savesBatchId` parsed: absent, or a string matching `/^[A-Za-z0-9-]{1,100}$/`, else 400 `bad_saves_batch`; `SavesBatchError` → 404 `saves_batch_not_found`)
- Modify `apps/worker/src/services/coach-runs.ts`:
  - `RunSettings` `:374-400` (`savesBatchId?: string`, `savesSkip?: SavesSkip[]`)
  - `CreateRunInput` `:1023-1040` (`savesBatchId?: string | null`)
  - `createRun` `:1162-1194` (one `skipSetOf` read when given)
  - `newRunState` `:482-528` (copies both for `main` and `designer`)
  - `ContextRun` `:664-680` and `contextStep` `:2510-2525` (passes `savesBatchId`)
  - `runTools` `:2857-2870` (`ctx.run.savesBatchId` / `savesSkip` for main and designer runs)
  - designer state `:3317-3326` (inherits both)
- Modify: `apps/worker/src/services/design-tools/types.ts:37-52` (`SavesSkip`, `ToolContext.run.savesBatchId?`, `savesSkip?`)
- Modify `apps/worker/src/services/design-context.ts`:
  - `DesignRun` `:148-170` (`savesBatchId?: string | null`)
  - the counts read `:538` (`savesBatchSql(userId, { now, batchId: run.savesBatchId ?? undefined })`)
  - `savesSection` `:1266-1284`
  - `header` `:1333` (`full = asksAboutSaves(run.request) || !!run.savesBatchId`)
- Modify `apps/worker/src/services/design-tools/read-saves.ts`:
  - `savesBatchSql` `:125-150` (each link adds `sv_m.fit_choice` and `sv_l.like_move_id`, before the note)
  - `savedBatchOf` `:155-171`
  - `SavedLink` / `SavedMove`
  - `readSaves.run` `:274-398` (default batch = `ctx.run.savesBatchId`; each move gains `choice` and `like`)
- Modify: `apps/worker/src/services/saves-batches.ts` (`skipSetOf`); `packages/api-client/src/index.ts:2622-2628` (`coachRunCreate` body `savesBatchId?: string`)
- Test: `apps/worker/test/coach-runs-routes.test.ts`, `apps/worker/test/design-context.test.ts` (saves block `:838-994`), `apps/worker/test/design-read-saves.test.ts`, `apps/worker/test/saves-batch-fixture.ts` (`SavedLink`'s draft gains `choice?: FitChoice`, `like?: number` (the index of the move it is like))

**Interfaces:**
- **Consumes:** `fit_choice` and `like_move_id` (Task 1); Task 4's `/fit`, which saves the batch before the run is created.
- **Produces:**
  - `interface SavesSkip { id: string; name: string }` (types.ts).
  - `skipSetOf(db, userId, batchId): Promise<SavesSkip[] | null>` is one statement. It returns null unless the batch is a `saved` batch of the account's, and gives its active new moves with `fit_choice = 'skip'`, with their names.
  - `class SavesBatchError extends Error` (coach-runs.ts).
  - The create costs +1 statement, only with `savesBatchId`.
  - `read_saves`:
    - Each move gains `choice: "include" | "skip" | "coach"` (a linked move is `"coach"`) and `like: { id: string; name: string | Untrusted } | null`. The like's name is resolved through the account's library at no cost, and a personal move's name is marked untrusted.
    - With no `batchId` input and `ctx.run.savesBatchId` set, it reads that batch, whatever its age (§8.2).
    - Without either, it reads the newest saved, unfitted batch in the 14-day window, as today.
  - The saves section line gains `; the athlete: include`, or `; the athlete skipped it — not placed`, and `; like {name}` (the name marked as a saved post's when personal).

- [ ] **Step 1: Write the failing tests**
  - **`coach-runs-routes.test.ts`:**
    - "a fit-in create carries its batch and skip set into the run's settings — one more statement".
    - "another account's or an unsaved batch is 404 saves_batch_not_found, and nothing starts; a non-string is 400 bad_saves_batch".
  - **`design-context.test.ts`:** "a run told its batch reads that batch — saved 30 days ago, with a newer unfitted batch waiting — in full whatever the request, with each move's choice and like; statements unchanged". Assert the lines contain `the athlete: include`, `the athlete skipped it — not placed` and `like `.
  - **`design-read-saves.test.ts`:** "with the run's batch and no batchId, read_saves reads it past the 14-day window; each move's choice and like (the like's name marked when personal)".
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/coach-runs-routes.test.ts apps/worker/test/design-context.test.ts apps/worker/test/design-read-saves.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them again.** Same command, plus:
  - `pnpm vitest run apps/worker/test/design-context-focus.test.ts apps/worker/test/design-cpu-bench.test.ts apps/worker/test/coach-shape-pins.test.ts`
  - `pnpm --filter @rg/worker typecheck && pnpm --filter @rg/api-client typecheck`

  Expect PASS. If `8.read_saves` exceeds its declared `cpuWeight`, re-measure on a quiet tree per that file's procedure and update the weight with a dated comment. Rebase the `read_saves` description's growth in `coach-shape-pins.test.ts` per Global Constraints.
- [ ] **Step 5: Commit.** `git commit -m "feat(coach): the fit-in run is told its batch — its choices, its skip set, read whatever its age"`

### Task 7: `pin_moves` — a line per move, named once; include and skip enforced; the summary counts

**Files:**
- Modify: `apps/worker/src/services/proposal-kinds.ts:157-191` (`PinsCardLine`; `MovePinsOp.lines: PinsCardLine[]`; the helpers)
- Modify `apps/worker/src/services/design-tools/pin-moves.ts`:
  - the doc `:1-30`
  - `:47-64` (`PIN_LINE_MAX = 280`; the lines schema)
  - `:66-74` (`namesFor` on the text only)
  - `:94-226` (the batch defaults to the run's; include and skip; the accounting by `moveId`; the summary; the stored lines)
- Modify: `apps/worker/src/services/coach-conversation.ts:284-287,312-321` (the pins card: `pinLines` and `lines` as text)
- Modify: `apps/worker/src/services/design-manifest.ts:480-505` (`PinsLine.lines: PinsCardLine[]`, via `pinsCardLinesOf`)
- Modify: `packages/api-client/src/index.ts:1425-1445` (`CoachConversationCardDto.pinLines?`, and the proposal read's pins line type)
- Modify: `packages/ui/src/screens/studio/plan-card.tsx` (a pins card renders `pinLines`)
- Test: `apps/worker/test/design-move-pins.test.ts` (`linesFor` and the I5 test `:290-317` move to object lines), `packages/ui/test/coach-pins-card.test.tsx`

**Interfaces:**
- **Consumes:** `ctx.run.savesBatchId` (Task 6); `personal_moves.fit_choice`; `numberWord` (Task 2).
- **Produces, in `proposal-kinds.ts`:**
  - `interface PinsCardLine { moveId?: string; name?: string; text: string }`
  - `pinsCardLinesOf(raw: unknown): PinsCardLine[]`. A plain string, as stored before this change, reads as `{ text }`.
  - `pinsLineText(l: PinsCardLine): string` gives `${name}: ${text}`, or `text`. Every reader that hands lines to a model or as plain strings uses it.
- **Produces, the tool's input:** `lines: Array<{ moveId?: string; text: string }>` (strict; `text: prose(PIN_LINE_MAX)`; 1…`PINS_LINES_MAX`). A line's `moveId` must be offered, else `not_a_move`.
- **Produces, what is stored:** `{ moveId, name: <the move's name from the account's library>, text }`, or `{ text }`.
  - The text has any leading copy of the name, of `(id)` or of the id stripped, along with the separator after it (`:`, `-`, `–`, `—`), and its first letter capitalized.
  - Personal ids elsewhere in it become names (`namesFor`).
  - Then `clipProse(text, PIN_LINE_MAX - name.length - 2)`: a line with its name never exceeds `PIN_LINE_MAX`, and it ends at a sentence end where `clipProse` finds one.
- **Batch:** `batchId = parsed.batchId ?? ctx.run.savesBatchId`. With one, the batch read returns `[id, fit_choice]` pairs, and:
  - an included move not in `pin` is refused `include_left_out`: "{names} — the athlete chose to include it — pin it, with a line on where it goes."
  - a skipped move in `pin`, or as a line's `moveId`, is refused `skipped`: "the athlete skipped {name} — leave it out of pin and lines."
  - Names in refusals are `markUntrusted("saved post", …)` when personal.
  - The new moves that must be accounted for are the offered, non-skipped ones not in `pin` or `unpin` and named by no line's `moveId` (`incomplete`).
- **Summary:** with a batch, the stored `summary` is `clipProse(pinsSummaryLine(pin.length, waiting), SUMMARY_MAX)`.
  - `waiting` is the names of the batch's offered new moves on the coach's call that are not pinned.
  - `export function pinsSummaryLine(joined: number, waiting: readonly string[]): string` writes the copy exactly.
  - The input's `summary` becomes optional. It is required only when there is no batch, else `invalid_input`.
- **The conversation card** gains `pinLines?: Array<{ name: string | null; text: string }>`, and `lines` keeps `pinsLineText` strings.

- [ ] **Step 1: Write the failing tests**
  - **`design-move-pins.test.ts`:**
    - Rewrite I5: lines `[{ moveId: b, text: "pinned: your neck care lacks a nod." }, { moveId: c, text: "left in your library: your calves get enough from running." }]`. Expect the stored lines `toEqual([{ moveId: b, name: "Zorbex neck nod", text: "Pinned: your neck care lacks a nod." }, …])`.
    - **"a line that repeats its move's name or id shows the name once; a long line ends at a sentence, inside PIN_LINE_MAX"** (Review Focus 3):
      - The text `"Zorbex neck nod (${b}): opens the neck. " + "x".repeat(300)` stores the text `"Opens the neck."`.
      - For a 70-character name, `name.length + 2 + text.length <= 280`.
    - **"an op stored with string lines still renders, word for word"** (Review Focus 2). Insert a `move_pins` op whose `lines` are strings directly into a proposal, then assert:
      - `cardsOf(...)` gives `lines` equal to the strings and `pinLines` as `{ name: null, text }`;
      - the manifest's `pinsLines` reads them;
      - the conversation block names the card.
    - **"include is pinned, always: a card leaving an included move out is refused include_left_out, naming it"**
    - **"a skipped move is never pinned nor lined: refused skipped; it needs no line to be accounted for"**
    - **"in a fit-in run, batchId defaults to the run's batch"**
    - **"with a batch the summary counts: Eight join the rotation. {name} waits."** Also cover one waiting and several waiting (`Two wait.`), using synthetic names.
  - **`coach-pins-card.test.tsx`:** "each line shows its move's name once, in bold, then its text; a line with no move is its text".
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/design-move-pins.test.ts packages/ui/test/coach-pins-card.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the interfaces above. In `plan-card.tsx`, render a pins line as `<li>{name ? <strong>{name}</strong> : null}{name ? " " : null}{text}</li>`.
- [ ] **Step 4: Run them again.** Same command, plus:
  - `pnpm vitest run apps/worker/test/coach-conversation.test.ts apps/worker/test/coach-shape-pins.test.ts apps/worker/test/design-cpu-bench.test.ts apps/worker/test/design-act-budget.test.ts`
  - `pnpm typecheck`

  Expect PASS. Rebase the tool schema's growth per Global Constraints.
- [ ] **Step 5: Commit.** `git commit -m "feat(coach): pin_moves names each move once from its id, clips after naming, holds the athlete's include and skip"`

### Task 8: Skip reaches the workout tools; the prompt says how choices and near-duplicates work

**Files:**
- Modify: `apps/worker/src/services/design-tools/act-common.ts:474-497` (`skippedRefusal`, beside `idsRefusal`)
- Modify: `apps/worker/src/services/design-tools/propose.ts:490-492` and `:866-868` (called after `idsRefusal` in the new or revise path and the amend path)
- Modify: `apps/worker/src/services/design-tools/plan-set.ts` (after parse, before any read: a brief naming a skipped move is refused)
- Modify: `apps/worker/src/services/design-prompt.ts:208-209` (the guidance)
- Test: `apps/worker/test/design-act-tools.test.ts` (a new `describe`, with the file's `run`, `ctxOf`, `call` and `docOf`); `apps/worker/test/design-move-pins.test.ts:584-601` (the guidance, word for word); `apps/worker/test/design-prompt.test.ts:46-53,320-323`; `apps/worker/test/design-fix13-prompt.test.ts:147-155`; `apps/worker/test/coach-shape-pins.test.ts:73`

**Interfaces:**
- **Consumes:** `ctx.run.savesSkip` (Task 6; set on main and designer runs).
- **Produces:**
  - `skippedRefusal(doc: Record<string, unknown>, skip: readonly SavesSkip[] | undefined): ToolErr | null`. It scans `parts[].items[].libraryId` and `items[].alternates[].libraryId`.
    - Code: `skipped_move`.
    - Why: `the athlete skipped {names} — it stays out of this fit-in`.
    - Fix: "Leave it out of the workout; the athlete chose to skip it."
    - Names: `markUntrusted("saved post", name)`.
  - `plan_set` refuses `skipped_move` when any brief's `purpose`, `emphasis` or `constraints` contains a skipped move's id, or its name (case-insensitive).
- **Produces, prompt copy:** these exact words are appended after `Finish by closing the batch: pin_moves with its batchId, even with no moves.` in the `# Integrating saved moves` paragraph:

> When the athlete chose first, read_saves says so per move (choice): include — pin it, always, with a line on where it goes; skip — leave it out: no pin, no line, never in a workout; coach — your call, as above. Two moves like each other are near-duplicates: never pin both — keep the one the athlete already has, else the clearer of the two, and say so in its line. A line about one move carries its moveId and says where it goes and why; the card shows the name.

- [ ] **Step 1: Write the failing tests**
  - **`design-act-tools.test.ts`:**
    - "propose_workout refuses a skipped move of the run's batch, new or revised, as an item or an alternate: skipped_move, naming it".
    - "amend refuses it too".
    - "plan_set refuses a brief naming a skipped move — nothing started".
    - "outside a fit-in run (no skip set) nothing changes".
  - **`design-move-pins.test.ts`:** extend the guidance assertion to `${guidance} ${selectivity} ${close} ${choices}`, with `choices` equal to the quote above.
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/design-act-tools.test.ts apps/worker/test/design-move-pins.test.ts apps/worker/test/design-prompt.test.ts apps/worker/test/design-fix13-prompt.test.ts apps/worker/test/coach-shape-pins.test.ts` → FAIL.
- [ ] **Step 3: Implement**, then rebase the three size pins (`SHARED_PROMPT` ≤ 6400 tokens in both prompt suites, and `GROWTH_MAX_CHARS`) per Global Constraints, with the measured values in the comments.
- [ ] **Step 4: Run them again.** Same command → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(coach): a skipped move stays out of the fit-in's workouts; the prompt says include, skip and never both of a near-duplicate pair"`

### Task 9: The coach opening's `saves` source goes (and the parent design points here)

**Files:**
- Modify `apps/worker/src/services/coach-opening-line.ts`:
  - `:18` and `:179-196` (`FIT_SAVES_REQUEST` re-export, `savesOpening`)
  - `:22-31` (`OpeningChip` loses `href` and `saveBatchId`)
  - `:38-41` (`source` loses `"saves"`)
  - `:198-200` (`SEEN_ID` loses `saves`)
- Modify `apps/worker/src/services/coach-nudges.ts`:
  - `:6`
  - `:34-44` (the doc's count then matches the pins again: at most six statements, four on a quiet account)
  - `:216-222` (the batch read goes)
  - `:309-317`
- Modify: `apps/worker/src/services/design-context.ts:87` (import `FIT_SAVES_REQUEST` from `@rg/saves`, since the re-export goes)
- Modify: `packages/api-client/src/index.ts:1488-1511` (`CoachOpeningChipDto` loses `href` and `saveBatchId`; `source` loses `"saves"`)
- Modify: `packages/ui/src/screens/studio/coach-conversation-model.ts:83-107` (the `open` chip kind and `saveBatchId` go)
- Modify: `packages/ui/src/screens/studio/coach-opening.tsx:68,164-181,210-235` (`SAVE_FAILED`, `saveThenAsk`, the `open` chip branch)
- Modify: `docs/superpowers/specs/2026-10-23-saved-posts-import-design.md:188` (a pointer line under the §6 heading). There is no `apps/saves-extension` README, and the extension describes no review flow, so nothing else in the docs changes.
- Test: `apps/worker/test/coach-opening.test.ts` (delete the `describe("From your saves: a released batch")` at `:484-534`, and the `savesOpening` / `parseSeen("saves:…")` uses; statement pins `:563` 7→6 and `:615` 8→7, comments drop "the saves batch"); `apps/worker/test/coach-nudges.test.ts:420-437` (7→6, quiet 5→4); `packages/ui/test/coach-opening-live.test.tsx:370-433` (the saves chip tests go); `packages/ui/test/coach-conversation-model.test.ts` (any `open`-kind case goes)

**Interfaces:**
- **Consumes:** nothing new.
- **Produces:**
  - `CoachOpeningLine.source` is `"review" | "session" | "read"`.
  - An old device's `?seen=saves:…` entry is simply ignored by `parseSeen`.
  - The parent design's pointer line, verbatim: `> Superseded in part (2026-10-26): the notice, the review screen and "Fitting them in" are now 2026-10-26-saves-flow-redesign-design.md (§3) — the Today card, the coach's saves card and the one-decision batch page.`

- [ ] **Step 1: Write the failing tests.**
  - `coach-opening.test.ts`: "a released batch is never the opening's line, and parseSeen drops saves:…".
  - `coach-nudges.test.ts`: the new counts (6, and 4 on a quiet account).
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/coach-opening.test.ts apps/worker/test/coach-nudges.test.ts packages/ui/test/coach-opening-live.test.tsx packages/ui/test/coach-conversation-model.test.ts` → FAIL.
- [ ] **Step 3: Remove** everything listed above, then add the doc pointer.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "refactor(coach): the saves opening line goes — the Today card and the coach's saves card replace it"`

### Task 10: Near-duplicates at matching

**Files:**
- Modify `apps/worker/src/services/saves-match.ts`:
  - `:65-81` (`MatchDecision.like?: string`)
  - `:220-241` (`matchMoves` step 2)
  - `:466-503` (`matchPost`: near-duplicates against active moves; `likeMoveId` on links)
  - the module doc `:1-22` (a step 2b)
- Test: `apps/worker/test/saves-match.test.ts`

**Interfaces:**
- **Consumes:** `nearDuplicateOf`, `sameMoveType` (Task 2); `PersonalMatchRow.load` / `doseType` (Task 3).
- **Produces:**
  - **Step 2, amended:** an equal-name hit on a personal move whose type differs (`!sameMoveType(draft, hit)`, with the draft's `load` and `dose.type`) is never linked. It becomes `{ kind: "new", confidence: draft.confidence, check: true, draft, like: hit.id }`, with no candidates: the judge is not asked.
  - **Step 2b, in `matchPost`:** after `applyVerdicts`, each `new` decision without `like` and without `sameAs` is compared with the account's `active`, unmerged personal moves by `nearDuplicateOf`. A hit sets `check: true, like: hit.id`.
  - Each link row carries `likeMoveId: d.like ?? decisions-at-sameAs.like ?? null`.
  - The library match (step 1) is unchanged. The statements are unchanged: the moves read already carries load and dose type.

- [ ] **Step 1: Write the failing tests**
  - "a new move one qualifying word from an active move of the owner's is created, flagged check this, like that move".
  - "an equal name with a different load or dose type is never linked: a new move, flagged, like the owner's — the judge not asked".
  - "an equal name with the same type links as before".
  - "a pending move (another batch's) is no like target at matching" (the cut flags it: Task 3).
  - "statements unchanged for a 12-move post".
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/saves-match.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them again.** `pnpm vitest run apps/worker/test/saves-match.test.ts apps/worker/test/my-saves-review.test.ts apps/worker/test/saves-batches.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): near-duplicates at matching — one qualifying word apart is flagged like the owner's move, never two load types merged"`

### Task 11: The insights the coach learns, tightened

**Files:**
- Create: `packages/saves/src/insights.ts`; export it from `packages/saves/src/index.ts`
- Modify: `packages/saves/src/prompts.ts:10` (`EXTRACT_PROMPT_VERSION = "extract-3"`), `:134-150` (the insights words)
- Modify `apps/worker/src/services/saves-batches.ts`:
  - `insightRowsSql` / `insightsJsonSql` `:195-219` (each insight carries its post's move summaries as a 7th element: a JSON array of `$.moves[*].summary`)
  - `insightsOf` `:226-247` (filters with `keepInsight`)
  - `insightWrites` `:249-275` and `saveBatch`'s first read `:309-317`
- Test: create `packages/saves/test/insights.test.ts`; update `packages/saves/test/prompts.test.ts:45-50`, `apps/worker/test/saves-notes.test.ts`

**Interfaces:**
- **Produces:**
  - `export const DOSE_ONLY_MAX_WORDS = 2; export const SUMMARY_OVERLAP_MIN = 0.7;`
  - `export function keepInsight(text: string, summaries: readonly string[]): boolean`, where:
    - The content words are `normalizeMoveName(text)`'s words, punctuation stripped, at least 3 letters, not numbers, and not in `{and, for, this, that, you, are, from, into, each, side, per, set, rep, second, minute, sec, min, breath, hold, perform, complete, movement, exercise, time, round, then, also}`. The words are already singular after `normalizeMoveName`.
    - A dose is `/\b\d+\s*(x|×|sets?|reps?|rounds?|s|secs?|seconds?|mins?|minutes?|breaths?)\b|\b(x|×)\s*\d+\b/i`.
    - It is dropped when it holds a dose and ≤ `DOSE_ONLY_MAX_WORDS` content words.
    - It is dropped when it has no content word.
    - It is dropped when the share of its content words found in any one summary's content words is ≥ `SUMMARY_OVERLAP_MIN`.
    - Anything else is kept.
  - `insightsOf` keeps only `keepInsight` survivors (the batch page, `read_saves` and the context all read through it).
  - Save writes only the survivors. Its first read adds `insightsJsonSql(userId, <kept posts>, INSIGHTS_PER_BATCH)`, and `insightWrites` inserts from `json_each(<survivors as [postId, idx, body, url]>)` under the same live-memory guard and ids (`saved:<post>:<idx>`). The statements stay at 6.
  - The extraction prompt's insights sentence, verbatim: `insights: guidance the post gives about when, why, how often or who it suits — never a dose (sets, reps, seconds) and never a description of one move (that is the move's summary); at most 5 of <=200 chars; empty when none.`

- [ ] **Step 1: Write the failing tests**

```ts
// insights.test.ts — synthetic words only
expect(keepInsight("3 sets of 10 reps", [])).toBe(false);
expect(keepInsight("Hold 30 seconds each side", [])).toBe(false);
expect(keepInsight("Perform 3 sets of each movement to build spinal extension", ["Builds spinal extension through the upper back."])).toBe(false);
expect(keepInsight("Do these before a run to wake the hips", ["Opens the hips."])).toBe(true);
expect(keepInsight("Good for desk workers who sit all day", ["Opens the hips."])).toBe(true);
expect(keepInsight("Twice a week is enough", [])).toBe(true);
```

  - **`saves-notes.test.ts`:** "a dose-only insight and one that repeats a move's summary are never kept, shown, or read by the coach — Save still 6 statements".
  - **`prompts.test.ts`:** the new sentence, and `EXTRACT_PROMPT_VERSION === "extract-3"`.
- [ ] **Step 2: Run them.** `pnpm vitest run packages/saves apps/worker/test/saves-notes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm vitest run apps/worker/test/design-read-saves.test.ts apps/worker/test/design-context.test.ts apps/worker/test/my-saves-review.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): the coach learns when, why and how often — never a restated dose or a move's own description"`

### Task 12: The app — the coach's saves card and chip, the Today card, the fit sent into the current conversation

**Files:**
- Modify: `packages/api-client/src/index.ts:2474-2478` (`OPEN_SAVES_QUERY`), `:2586-2611` (four functions)
- Modify: `packages/ui/src/screens/studio/coach-focus.ts:36-39` (`CoachOpenArgs.fit?`)
- Modify: `packages/ui/src/screens/studio/coach-sheet.tsx:41-73` (`CoachOpened.fit`), `:142-168` (the chip before `SheetMenu`; `fit={epoch === 0 ? args.fit : null}`)
- Modify `packages/ui/src/screens/studio/coach-conversation.tsx`:
  - props `:90-101` (`fit?`)
  - `start` `:181-225` (takes `{ words, savesBatchId? }`)
  - `send` `:249-257` (`send(words, opts?: { savesBatchId?: string })`)
  - the card at the top of the scroller
  - the opener's fit sent once when the conversation has settled
- Create: `packages/ui/src/screens/studio/coach-saves.tsx`
- Create: `packages/ui/src/components/saves-today-card.tsx`
- Modify: `packages/ui/src/screens/garden.tsx:1974-1982` (`<SavesTodayCard />` first in `parts.today`, right after the arrival block's slot)
- Modify: `packages/ui/src/screens/studio/saves-model.ts` (copy helpers)
- Modify: `packages/ui/src/screens/studio/plan-card.tsx` (`after()` also invalidates `["saves"]`)
- Modify: `packages/ui/src/styles.css`
- Test: create `packages/ui/test/coach-saves-live.test.tsx` (`coach-opening-live.test.tsx`'s `mountSheet` and harness `serve`), `packages/ui/test/saves-today-card.test.tsx`, `packages/ui/test/saves-model.test.ts`

**Interfaces:**
- **Consumes:** Task 4's routes and DTOs; Task 6's `coachRunCreate({ …, savesBatchId })`.
- **Produces, api-client:**
  - `OPEN_SAVES_QUERY = ["saves", "open"] as const`
  - `savesOpen: () => get<OpenSavesDto>("/api/my-saves/open")`
  - `savesFit: (id: string, choices: Record<string, FitChoice>) => post<FitAnswerDto>(…/fit, { choices })`
  - `savesDismiss: (id: string) => post<{ ok: boolean }>(…/dismiss)`
  - `savesFitCancel: (id: string) => post<{ ok: boolean }>(…/fit/cancel)`
- **Produces, `saves-model.ts`** (pure, copy exact as in Global Constraints):
  - `todayHeadline(c: { new: number; linked: number }): string`
  - `todaySubline(c): string | null`
  - `savesChipLabel(c): string`
  - `FITTING_LINE = "Fitting in… open the coach"`
  - `OPEN_FIRST_LINE = "finish the batch that is open first"`
  - `PUT_ASIDE_LINE = "Put aside. Find it again under Settings → Saves (or the Studio tab), where Fit them in brings it back."`
- **Produces, `coach-saves.tsx`:**
  - `CoachSavesChip()` reads `OPEN_SAVES_QUERY` (`retry: false`; an error or `open: null` draws nothing). It is a chip button labelled `savesChipLabel`. A tap scrolls `#coach-saves-card` into view.
  - `CoachSavesCard({ busy, onFit }: { busy: boolean; onFit: (batchId: string, request: string) => void })` draws `open.line` in `CoachSays` (exported by `coach-opening.tsx`), then:
    - **`Fit them in`:** `api.savesFit(id, {})`, then `onFit(id, request)`. A 409 `batch_open` shows `OPEN_FIRST_LINE`.
    - **`Choose first`:** navigates to `savesHref(id)`.
    - **`not now`:** a `Sheet` with `PUT_ASIDE_LINE` and `OK`. `OK` calls `api.savesDismiss(id)` and invalidates `OPEN_SAVES_QUERY` and `SAVES_BATCHES_QUERY`. Closing it any other way dismisses nothing.
    - **While `fitting`:** `FITTING_LINE` in place of the buttons and the link.
    - After any fit, dismissal or cancellation succeeds (here, on the Today card and on the batch page), invalidate `OPEN_SAVES_QUERY`, `SAVES_BATCHES_QUERY` and `savesBatchQuery(id)`.
- **Produces, `CoachConversation`:**
  - It renders `<CoachSavesCard busy={busy || working || usedUp} onFit={(id, r) => send(r, { savesBatchId: id })} />` first in its scroller.
  - With a `fit` prop, it sends `fit.request` with `savesBatchId` once, after `settled`.
  - When a fit's send cannot start, it calls `api.savesFitCancel(id)`, invalidates `OPEN_SAVES_QUERY`, and leaves the words in the box. That covers: `working`, `usedUp`, `start` failing, or `res.existing`.
- **Produces, `SavesTodayCard()`:**
  - It draws nothing without `useCoach()` or an open batch.
  - Otherwise it is a `dock-panel` section with `aria-label="From your saves"` holding `todayHeadline`, `todaySubline` and one `btn btn-primary` **Fit them in**. Fit them in calls `api.savesFit(id, {})`, then `coach.open({ fit: { batchId: id, request } })`: one tap from Today (spec §2, the anti-goal).
  - Tapping the card's body calls `coach.open()`.
  - While fitting: `FITTING_LINE` in place of the button. A 409 `batch_open` gives `OPEN_FIRST_LINE`.

- [ ] **Step 1: Write the failing tests**
  - **`saves-model.test.ts`:**
    - `todayHeadline({ new: 9, linked: 4 })` → `"9 new moves from your saves"`
    - `todaySubline({ new: 9, linked: 4 })` → `"4 more were already yours"`
    - `todaySubline({ new: 9, linked: 1 })` → `"1 more was already yours"`
    - `todaySubline({ new: 2, linked: 0 })` → `null`
    - `todayHeadline({ new: 0, linked: 3 })` → `"3 saved moves you already have"`
    - `savesChipLabel({ new: 1, linked: 0 })` → `"1 new saved move"`
  - **`coach-saves-live.test.tsx`:**
    - "with an open batch, the sheet's header holds the chip and the conversation starts with the card, word for word".
    - "Fit them in fits, then sends the request in the current conversation with its batch: POST /api/coach/runs carries { request: FIT_SAVES_REQUEST, savesBatchId }".
    - "a refused run start cancels the fit: the card offers Fit them in again" (Review Focus 1: the run create answers 409 `week_budget`; expect `POST …/fit/cancel`, and **Fit them in** is back).
    - "Choose first goes to the batch page".
    - "not now asks first, then puts it aside: the sheet's words, word for word; OK dismisses; closing the sheet doesn't".
    - "while fitting, every button gives way to Fitting in… open the coach".
  - **`saves-today-card.test.tsx`:**
    - "no card without an open batch, or with the coach off".
    - "the card's words, word for word".
    - "Fit them in fits and opens the coach with the fit".
    - "a tap on the card opens the coach".
    - "409 batch_open says finish the batch that is open first".
- [ ] **Step 2: Run them.** `pnpm vitest run packages/ui/test/saves-model.test.ts packages/ui/test/coach-saves-live.test.tsx packages/ui/test/saves-today-card.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them again.** Same command, plus:
  - `pnpm vitest run packages/ui/test/coach-opening-live.test.tsx packages/ui/test/coach-conversation-live.test.tsx packages/ui/test/responsive.test.tsx packages/ui/test/shape-today.test.tsx packages/ui/test/plan-card-live.test.tsx`
  - `pnpm typecheck`

  Expect PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(app): a new batch is impossible to miss — the Today card, the coach's chip and card, Fit them in in one tap"`

### Task 13: The app — the batch page, one decision per new move

**Files:**
- Modify `packages/ui/src/screens/studio/saves.tsx`:
  - `SaveBatchScreen` `:174-303` (the head, the rows, Already yours, the sticky foot; the "Save these" block and `save()` go)
  - `RowTags` `:143-150` (no creator, no dose)
  - `SavesScreen` `:109-138` (a dismissed, unfitted batch's row gets **Fit them in**)
  - `CHECK_WHY_WORDS` `:485-489` (`near_duplicate`)
- Modify: `packages/ui/src/screens/studio/saves-model.ts:26-67` (`batchFacts` adds `Put aside`; `canSave` goes; `canFit`; `waitingBatches`)
- Modify: `packages/ui/src/styles.css`
- Test: `packages/ui/test/studio-saves.test.tsx` (rewrite the save and fit tests; `serve()` answers `/fit` and `/dismiss`), `packages/ui/test/saves-model.test.ts`, `packages/ui/test/studio-home.test.tsx` (if `waitingBatches` changes its count)

**Interfaces:**
- **Consumes:** `SaveBatchRowDto.move.{purpose, like, choice}`; `SaveBatchDto.{fitting, dismissedAt}`; `api.savesFit`; `CoachOpenArgs.fit`; the Task 12 copy constants.
- **Produces, `saves-model.ts`:**
  - `interface PageRow { moveId: string; row: SaveBatchRowDto; name: string; purpose: string; check: boolean; like?: { id: string; name: string } }` and `interface OwnedRow { moveId: string; name: string; row: SaveBatchRowDto }`.
  - `pageRowsOf(rows: readonly SaveBatchRowDto[]): { fresh: PageRow[]; owned: OwnedRow[] }` gives one row per distinct move of the kept rows, in the posts' order, each holding its first kept link (`row`, for the sheet's actions).
  - `purposeLine(row: SaveBatchRowDto): string` is `move.purpose` trimmed, else the summary's first sentence, cut at 80 characters by word.
  - `tallyLine(choices: Readonly<Record<string, FitChoice | undefined>>, moveIds: readonly string[]): string` writes the copy exactly.
  - `canFit(b)` is `!b.fittedAt && !b.fitting && (b.status === "released" || b.status === "saved")`.
  - `waitingBatches(bs)` counts the batches with `!b.fittedAt` and status released or saved.
- **Produces, the page:**
  - The title is `{n} new moves`, then the bold line.
  - Each fresh row holds:
    - the name as a button (opens the `MoveSheet` with `row`);
    - the second line: `purposeLine`, then `Check this` when flagged, then `like {name}`. `like {name}` is a button calling `api.savesRematch(row.postMoveId, like.id)` and then `refresh(true)` when `rowActions(row).sameAs`, else text;
    - a `role="radiogroup"` with `aria-label={name}` holding three `role="radio"` buttons (`Skip`, `Coach`, `Include`; default the row's `choice` ?? Coach).
  - `▸ Already yours · {m}` is a toggle button. Unfolded, it lists the owned names, each a button that opens its sheet, with no control.
  - The sticky foot holds `tallyLine` and **Fit these in**. **Fit these in** calls `api.savesFit(batchId, choices restricted to the current fresh move ids, Coach left out)`, then `coach.open({ fit: { batchId, request } })`. A 409 `batch_open` gives `OPEN_FIRST_LINE`; while fitting, `FITTING_LINE`.
  - A fitted batch shows the rows read-only, with no control and no foot.
  - The list's dismissed batches show `Put aside` among their facts, and a **Fit them in** button doing the same fit with `{}`.

- [ ] **Step 1: Write the failing tests.** Use synthetic rows: two posts share "Zorbex quad shuffle", there is one owned library move, and one new row flagged with a like.
  - **`studio-saves.test.tsx`:**
    - "one row per new move, its purpose and control — no creator, no dose; Already yours folded: ▸ Already yours · 1".
    - "the title and the line, word for word".
    - "the tally follows the controls: All three on the coach's call → 1 in · 1 out · 1 on the coach's call".
    - "Fit these in fits with the choices — Coach sent as nothing — and opens the coach with the fit".
    - "like {name} merges in one tap".
    - "a removed move's row goes, and its choice is never sent".
    - "409 batch_open says finish the batch that is open first".
    - "a fitted batch is read-only".
    - "the list: a dismissed batch reads Put aside and offers Fit them in".
  - **`saves-model.test.ts`:** `tallyLine` for 1, 2, 9 and mixed; `pageRowsOf` dedupes by move; `purposeLine` falls back to the summary.
- [ ] **Step 2: Run them.** `pnpm vitest run packages/ui/test/studio-saves.test.tsx packages/ui/test/saves-model.test.ts packages/ui/test/studio-home.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm vitest run packages/ui/test/settings-saves.test.tsx packages/ui/test/studio-home-live.test.tsx && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(studio): the batch page asks one thing per new move — Skip, Coach or Include — and one button fits them in"`

### Task 14: Studio, a tab

**Files:**
- Modify: `packages/ui/src/shell.tsx:15-24` (the doc and `NAV`), `:56-77` (`PlaceLink` puts the Coach before `/studio`)
- Modify: `packages/ui/src/icons.tsx` (`IconStudio`)
- Test: `packages/ui/test/shape-nav.test.tsx:58-80`, `packages/ui/test/studio-nav.test.tsx:34-45`

**Interfaces:**
- **Produces:**
  - `NAV = [Today "/", Plan "/plan", Studio "/studio", Growth "/growth"]`, giving `Today · Plan · Coach · Studio · Growth`, with Settings at the rail's foot or as the athlete's mark (spec §8.1).
  - `export function IconStudio({ size }: IconProps)`: a kettlebell outline, drawn in the same 24-unit grid and stroke style as `IconPlan`.
  - The `/studio` NavLink is active on `/studio/*`.

- [ ] **Step 1: Write the failing tests**
  - **`shape-nav.test.tsx`:**
    - NAV is `[["/","Today"],["/plan","Plan"],["/studio","Studio"],["/growth","Growth"]]`.
    - The phone's bar is `Today · Plan · Coach(button) · Studio · Growth`.
    - The rail is the same five, then Settings.
  - **`studio-nav.test.tsx`:**
    - "is a tab: the nav leads to /studio, lit on /studio/saves".
    - "the labels stay short enough for five equal controls at 320px" (the same rule, five controls).
- [ ] **Step 2: Run them.** `pnpm vitest run packages/ui/test/shape-nav.test.tsx packages/ui/test/studio-nav.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the interfaces above, rewording the shell's doc comment to match.
- [ ] **Step 4: Run them again.** Same command, plus `pnpm vitest run packages/ui/test/responsive.test.tsx packages/ui/test/restore-notice.test.tsx` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(app): Studio is a tab — Today · Plan · Coach · Studio · Growth"`

### Task 15: The re-cut script, and the hold switch unset

**Files:**
- Create: `apps/worker/scripts/recut-saves-lib.mjs`, `apps/worker/scripts/recut-saves-lib.d.mts`, `apps/worker/scripts/recut-saves-batches.mjs`
- Modify: `apps/worker/wrangler.toml:93-98` (delete `SAVES_HOLD_BATCHES = "1"`; the comment says hold mode is off since the saves-flow redesign and the switch remains for a future bootstrap), `apps/worker/src/env.ts:90` (the doc)
- Test: create `apps/worker/test/recut-saves.test.ts`

**Interfaces:**
- **Produces, `recut-saves-lib.mjs`:**
  - `export const BATCH_ID_RE = /^[0-9a-f-]{8,36}$/`.
  - `export function recutStatements(batchIds: readonly string[]): string[]` throws on an id outside `BATCH_ID_RE` and on an empty list. It returns, in order:
    1. `UPDATE personal_moves SET batch_id = NULL WHERE status = 'pending' AND batch_id IN (<held>)`
    2. the same for `saved_post_moves`
    3. `UPDATE saved_posts SET batch_id = NULL WHERE batch_id IN (<held>)`
    4. `UPDATE save_batches SET status = 'superseded' WHERE status = 'held' AND id IN (<ids>)`

    Here `<held>` is `SELECT id FROM save_batches WHERE status = 'held' AND id IN (<ids>)`, so a released, saved or fitted batch named by mistake is never touched.
  - `export function checkStatements(batchIds): string[]` returns read-only `SELECT count(*)` twins of statements 1–4.
- **Produces, `recut-saves-batches.mjs`:**
  - Usage: `node apps/worker/scripts/recut-saves-batches.mjs --batch <id> [--batch <id> …] [--dry-run]`, parsed with `parseArgs` as in `seed-saves.mjs:102-107`.
  - With `--dry-run` it prints `checkStatements`. Without it, it prints `recutStatements` joined by `;\n`.
  - It never runs wrangler and writes no file. It exports `main(argv, { log }): number` and keeps the entry guard of `seed-saves.mjs:157`.

- [ ] **Step 1: Write the failing tests** in `recut-saves.test.ts`. Use synthetic held, released and fitted batches inserted with drizzle, then apply each statement with `db.run(sql.raw(s))`.
  - "dissolves only held batches: their pending moves, links and posts unbatched, the batches superseded; a released or fitted batch named by mistake untouched".
  - "after the re-cut, assembleBatch cuts at most 12 new moves, oldest post first, and flags near-duplicates in the pool".
  - "an id outside BATCH_ID_RE, or none, is refused before any SQL is made".
  - "--dry-run prints only SELECTs; without it, the four UPDATEs in order" (load the CLI by dynamic import, as `seed-saves-transform.test.ts:129-130` does).
- [ ] **Step 2: Run them.** `pnpm vitest run apps/worker/test/recut-saves.test.ts` → FAIL.
- [ ] **Step 3: Implement** the files above and edit `wrangler.toml`/`env.ts`. Never run the script against any real database in this task.
- [ ] **Step 4: Run them again.** `pnpm vitest run apps/worker/test/recut-saves.test.ts apps/worker/test/saves-batches.test.ts apps/worker/test/wrangler-config.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(saves): the re-cut script for the held batches (run by the lead); hold mode off"`
- **Lead runbook. These are never task steps; the lead does them after the whole branch is deployed.**
  1. Look up the full ids of the three held batches (`7514d1d4…`, `80bcb380…`, `90e095ad…`) with a read-only `wrangler d1 execute run-garden-db --remote --command "select id, status from save_batches where status = 'held'"`. Use `WRANGLER_WRITE_LOGS=false` and no output file.
  2. Run the script with `--dry-run`. Execute its SELECTs the same read-only way, and check the counts: about 66 moves.
  3. Run the script without `--dry-run`, and pipe its output to `wrangler d1 execute run-garden-db --remote --command`, one statement at a time, in order.
  4. Open Today: `GET /open` assembles a batch of ≤ 12 when none is open. Expect that the first `GET /open` after deploy (any device) will already have cut a batch of ≤ 12 from the unbatched pool before the dissolve. That is fine: the dissolve only changes the ORDER in which the older posts come (they join the pool and, oldest first, lead the batches cut after that one); nothing open, saved, fitted or active is touched.

### Task 16: The stale bridge poll answers 410

**Files:**
- Modify: `apps/worker/src/index.ts:270-287` (`export const bridgeGone: Handler<AppContext> = (c) => c.body(null, 410)`; `app.all("/api/devices/*", bridgeGone)` mounted just before `app.all("*", serveAsset)`)
- Test: create `apps/worker/test/bridge-gone.test.ts` (as `serve-asset.test.ts` mounts its handler)

**Interfaces:**
- **Produces:** every method on `/api/devices/*` answers 410 with an empty body. `/api/devices/bridge/jobs/claim` was deleted in 844aa0ec and has fallen through to the assets binding since.

- [ ] **Step 1: Write the failing test.** "POST /api/devices/bridge/jobs/claim is 410 with an empty body; GET /assets/x still reaches the assets". Mount `bridgeGone` on `/api/devices/*` and `serveAsset` on `*`, then expect `res.status === 410` and `await res.text() === ""`.
- [ ] **Step 2: Run it.** `pnpm vitest run apps/worker/test/bridge-gone.test.ts` → FAIL (no export).
- [ ] **Step 3: Implement** the handler and the mount, with a one-line comment naming the deleted desktop bridge.
- [ ] **Step 4: Run it again.** `pnpm vitest run apps/worker/test/bridge-gone.test.ts apps/worker/test/serve-asset.test.ts apps/worker/test/origin-guard.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(worker): the deleted bridge's poll answers 410 Gone, empty"`
- **Lead step (done 2026-10-26 before this plan ran):** the stale poller was the old Run Garden desktop app, launched at login by `~/Library/LaunchAgents/Run Garden.plist`; booted out and the plist renamed `.disabled`. Note in the ledger that the extension's link-based video path is left as it is (spec §8.7).

### Task 17: The CI flake — review-basis's row bound, its clock held

**Files:**
- Modify: `apps/worker/test/review-basis-summary.test.ts:15` (imports `afterEach`), `:249-294`
- Test: the same file

**Interfaces:**
- **Consumes:** the pattern at `apps/worker/test/design-approve-routes.test.ts:62-68,78-81`.
- **Produces:** inside `"the same statements, and a bounded number of rows, at 0, 100, 400 and 1,000 sessions"`, `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(noon));` runs right after `noon` is computed (`:268`), before the first `makeTestUser`. The suite gains `afterEach(() => vi.useRealTimers())`. The comment at `:290-291` adds that the clock is held at the test's own noon, because the bound flaked at 00:07 local (252 > 236).

- [ ] **Step 1: Run it under a shifted clock**, to see the bound depend on the hour. `.superpowers/tools/shift-date.mjs` is gitignored; read it for its contract first. Put the local clock at 00:05 America/Los_Angeles:
  - `RG_DATE_OFFSET_DAYS=$(node -e 'const f=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"numeric",hourCycle:"h23"});const [h,m]=f.format(Date.now()).split(":").map(Number);let d=5-(h*60+m);if(d<0)d+=1440;console.log(d/1440)') NODE_OPTIONS="--import $PWD/.superpowers/tools/shift-date.mjs" pnpm vitest run apps/worker/test/review-basis-summary.test.ts -t "bounded number of rows"`
  - Expected: it FAILs, or its logged row counts differ from an unshifted run. Record both runs' log lines.
- [ ] **Step 2: Hold the clock** as described under Interfaces.
- [ ] **Step 3: Run it again**, with the same shifted command and an unshifted `pnpm vitest run apps/worker/test/review-basis-summary.test.ts`. Expect PASS both times, with identical row counts in the log line.
- [ ] **Step 4: Commit.** `git commit -m "fix(test): review-basis's row bound holds the clock at the test's own noon"`

### Task 18: The hour-bomb sweep — twelve suites hold the clock at midday

**Files:**
- Modify: `apps/worker/test/helpers.ts` (`pinMiddayToday`)
- Modify, in `apps/worker/test/`: `doc-workouts.test.ts` (`:53`), `coach-opening.test.ts` (`:180`), `doc-workouts-offline.test.ts` (`:41`), `today-builds.test.ts` (`:29`), `watch-version-count.test.ts` (`:59`), `garden-day-input.test.ts`, `account-library.test.ts` (`:76`), `coach-runs-current.test.ts` (`:61`), `doc-build.test.ts` (`:43`), `doc-place-rule.test.ts` (`:73`), `pace-encoding-heal.test.ts` (`:110`), `plan-routes.test.ts`
- Test: the twelve suites themselves

**Interfaces:**
- **Produces:** `export function pinMiddayToday(timezone = "America/Los_Angeles"): string` (helpers.ts). It:
  - reads the real calendar day in `timezone`;
  - calls `vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime(new Date(\`${day}T19:00:00Z\`))` (12:00 PDT / 11:00 PST, as `design-approve-routes.test.ts` does);
  - returns `todayInZone(timezone)` read again.
- **In each suite:**
  - The first line of its top-level `beforeEach` calls `pinMiddayToday(<the suite's timezone, default>)`, before any real-clock read, and assigns its `today` from the return value where the suite keeps one.
  - It gains `afterEach(() => vi.useRealTimers())`.
  - Module-scope real-clock reads move into the `beforeEach`.
  - A suite whose tests use `vi.useFakeTimers` themselves keeps them: those calls follow the pin.

- [ ] **Step 1: Run the twelve under a late-evening clock**, to find the hour bombs. Use Task 17's offset command with `d=23*60+55-(h*60+m)`:
  - `RG_DATE_OFFSET_DAYS=<offset> NODE_OPTIONS="--import $PWD/.superpowers/tools/shift-date.mjs" pnpm vitest run apps/worker/test/{doc-workouts,coach-opening,doc-workouts-offline,today-builds,watch-version-count,garden-day-input,account-library,coach-runs-current,doc-build,doc-place-rule,pace-encoding-heal,plan-routes}.test.ts`
  - Record which suites fail. Some may pass: most pass `today`/`now` explicitly.
- [ ] **Step 2: Add `pinMiddayToday`**, then pin each suite as described under Interfaces.
- [ ] **Step 3: Run the twelve three times:** unshifted, shifted to 23:55, and shifted to 00:05 local (`d=5-(h*60+m)`). Expect PASS all three times.
- [ ] **Step 4: Run the full suite**, quiet tree: `NODE_OPTIONS=--max-old-space-size=4096 pnpm vitest run && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(test): twelve suites that place on today hold the clock at midday — no hour bombs"`
