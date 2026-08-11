# Coach & Plan Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coach reads every activity automatically (exactly-once), and the plan page becomes brief → plan cards → one pickable week, with a studio modal per plan.

**Architecture:** New `coach_reads` ledger + `coach_locks` single-flight table give the LLM layer idempotency; two new read routes (`/api/plan/week`, `/api/coach/plans/:id/detail`) feed a fully rewritten `/plan` screen; the coach floats (window desktop / pill+sheet mobile) with ONE `CoachPanel` mount. Spec: `docs/superpowers/specs/2026-08-11-coach-plan-rework-design.md`. Mock reference: `docs/superpowers/mocks/2026-08-11-coach-plan-rework.html` (open in a browser; the page mocks are pixel guides).

**Tech Stack:** Cloudflare Workers + Hono + Drizzle/D1 (better-sqlite3 in tests), React + TanStack Query, vitest (`pnpm test` at repo root runs everything; `pnpm --filter @rg/worker test`, `pnpm --filter @rg/ui test` scope). Node 21 for vitest; wrangler needs Node 22.

## Global Constraints

- **R1 (mobile):** no horizontal body scroll, no clipped content at 360/390px. Rows wrap or scroll in their own container; SVGs are `width:100%` + `viewBox`; text clamps.
- **R2 (exactly-once):** every LLM call is preceded by an atomic claim (token pattern below). No path may call `chatCompletion` without owning a claim.
- Reads honor ALL gates: fixture mode, `AI_GATEWAY_API_KEY` presence, `prefs.aiEnabled` && `AI_DEFAULT_ENABLED !== "0"`, budget. Auto-read budget reserve: pause at **$12** (`AUTO_READ_RESERVE_MICROS = 12_000_000`) of the $20 cutoff.
- Determinism: nothing in this project writes garden state; `garden_day_inputs` replay is untouched.
- Tone: garden voice — names the situation, never accuses. Copy in this plan is exact; don't editorialize.
- Existing behavior preserved: proposal lifecycle, workout sheet + mutations, memory, Sheet/dialog contract (`useDialogFocus`), category palette, `usePlanCoach` optimistic-send/abort semantics (audit C16/C17 comments must survive the move).
- All timestamps via `nowInstant()`; ids via `newId()` (`@rg/domain`).
- Commit after every task with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01Bz4kv2YxpsEqG3DsMHHwT5`

**The claim-token pattern (used by Tasks 2 & 3)** — portable across D1 and better-sqlite3 (no reliance on driver `changes` shape): conditionally UPDATE a row to stamp your fresh token, then SELECT and check the token is yours. Single-writer SQLite makes the UPDATE atomic; losing racers stamp nothing and read someone else's token.

---

### Task 1: Schema + migration for `coach_reads` and `coach_locks`

**Files:**
- Modify: `packages/database/src/schema/coach.ts` (append two tables)
- Modify: `packages/database/src/schema/schedule.ts` (add `structuredJson` to `plannedWorkouts`, after `stageSummary`-adjacent columns ~line 60)
- Create: `packages/database/migrations/0013_coach_reads.sql`
- Modify: `packages/database/migrations/meta/_journal.json` (append idx 13 entry, same shape as idx 12)
- Test: `apps/worker/test/coach-reads.test.ts` (schema smoke — created here, grown in Task 2)

**Interfaces:**
- Produces: `coachReads`, `coachLocks` drizzle tables exported from `@rg/database` (add to the schema barrel exactly like `coachTriggers` is); `plannedWorkouts.structuredJson: {exercises: unknown[]} | null`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/worker/test/coach-reads.test.ts
import { describe, expect, it } from "vitest";
import { coachReads, coachLocks } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("coach_reads schema", () => {
  it("enforces one read per (user, activity)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const row = {
      id: newId(), userId, activityId: "act-1", status: "queued",
      attempt: 0, nextAttemptAt: nowInstant(), claimToken: null, claimedAt: null,
      glance: null, body: null, flags: [], model: null,
      createdAt: nowInstant(), completedAt: null,
    };
    await db.insert(coachReads).values(row);
    await expect(db.insert(coachReads).values({ ...row, id: newId() })).rejects.toThrow();
  });

  it("coach_locks is one row per (user, kind)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(coachLocks).values({ userId, kind: "wake", token: "t1", claimedAt: nowInstant() });
    await expect(
      db.insert(coachLocks).values({ userId, kind: "wake", token: "t2", claimedAt: nowInstant() }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @rg/worker test -- coach-reads` → FAIL (`coachReads` not exported).

- [ ] **Step 3: Implement schema + migration**

Append to `packages/database/src/schema/coach.ts`:

```ts
/** The perception ledger: exactly one LLM read per activity (rework spec §1).
 * Reads live HERE, not in coach_messages — an analysis stored as a coach
 * message resets the briefing-staleness clock and crowds the thread/dossier. */
export const coachReads = sqliteTable(
  "coach_reads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Activity id, or `digest:<backfillRunId>` for a backfill batch digest. */
    activityId: text("activity_id").notNull(),
    status: text("status").notNull(), // queued | running | done | failed | skipped
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    glance: text("glance"),
    body: text("body"),
    flags: text("flags", { mode: "json" }).notNull().$type<string[]>(),
    model: text("model"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    uniqueIndex("coach_reads_user_activity_unique").on(t.userId, t.activityId),
    index("coach_reads_user_status_idx").on(t.userId, t.status, t.nextAttemptAt),
  ],
);

/** Single-flight claims for per-user LLM work (rework spec R2). */
export const coachLocks = sqliteTable(
  "coach_locks",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // 'wake'
    token: text("token").notNull(),
    claimedAt: text("claimed_at").notNull(),
  },
  (t) => [uniqueIndex("coach_locks_user_kind_unique").on(t.userId, t.kind)],
);
```

`packages/database/migrations/0013_coach_reads.sql` (match house style — check 0010 for formatting):

```sql
CREATE TABLE `coach_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`claim_token` text,
	`claimed_at` text,
	`glance` text,
	`body` text,
	`flags` text NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_reads_user_activity_unique` ON `coach_reads` (`user_id`,`activity_id`);
--> statement-breakpoint
CREATE INDEX `coach_reads_user_status_idx` ON `coach_reads` (`user_id`,`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE TABLE `coach_locks` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_locks_user_kind_unique` ON `coach_locks` (`user_id`,`kind`);
--> statement-breakpoint
ALTER TABLE `planned_workouts` ADD `structured_json` text;
```

Add `structuredJson: text("structured_json", { mode: "json" }).$type<{ exercises: unknown[] } | null>()` to `plannedWorkouts` in `schedule.ts`. Export both new tables from the schema barrel (`packages/database/src/index.ts` — follow how `coachTriggers` is exported). Append journal entry `{"idx": 13, "version": "6", "when": <now ms>, "tag": "0013_coach_reads", "breakpoints": true}`.

- [ ] **Step 4: Run tests** — same command → PASS. Also `pnpm --filter @rg/worker test` (full) to prove no migration break.
- [ ] **Step 5: Commit** — `feat(db): coach_reads ledger + coach_locks single-flight + structured lift column (0013)`

---

### Task 2: Read pipeline — `coach-reads.ts` service

**Files:**
- Create: `apps/worker/src/services/coach-reads.ts`
- Modify: `apps/worker/src/routes/devices.ts:231` area (post-ingest hook), `apps/worker/src/services/backfill.ts:199` area (enqueue + digest), `apps/worker/src/index.ts` `hourly()` (sweep)
- Test: `apps/worker/test/coach-reads.test.ts` (extend)

**Interfaces:**
- Consumes: `buildEffortPackage(db, userId, activityId)` (`coach-effort.ts`), `chatCompletion/extractJson/recordUsage/DEFAULT_MODEL_STRONG` (`studio-llm.ts`), `llmBudgetStatus` (`llm.ts`), `fixtureModeEnabled` (`env.ts`), tables from Task 1.
- Produces:
  - `enqueueCoachReads(db: Db, userId: string, today: LocalDate): Promise<number>` — insert-or-ignore `queued` rows for un-read activities with local date ≥ `addDays(today, -14)`.
  - `enqueueBackfillDigest(db: Db, userId: string, runId: string, oldCount: number): Promise<boolean>` — when `oldCount > 5`, insert-or-ignore one `queued` row with `activityId = \`digest:${runId}\``.
  - `processCoachReads(db, env, userId, prefs, {cap = 2, fetchImpl = fetch}): Promise<{processed: number; skipped: string | null}>` — gate-check, claim, call, persist; `skipped` names the first gate that stopped everything (`"fixture" | "no_key" | "ai_disabled" | "budget_reserve" | null`).
  - `ensureRead(db, env, userId, prefs, activityId, {force = false, fetchImpl}): Promise<ReadResult>` where `ReadResult = { status: "done" | "working" | "resting" | "error" | "not_found"; read?: { id, glance, body, flags, at } }` — Task 4's route calls this.
  - `AUTO_READ_RESERVE_MICROS = 12_000_000`, `READ_MAX_ATTEMPTS = 5`, `READ_RECLAIM_MINUTES = 10`, `READ_WINDOW_DAYS = 14` (exported for tests).
  - `READ_SYSTEM_PROMPT` — exact text in Step 3.

- [ ] **Step 1: Write failing tests** (extend `coach-reads.test.ts`). A fake transport counts calls:

```ts
function fakeLlm(responses: string[]): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    const content = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(
      // studio-llm streams SSE; chatCompletion accepts non-stream JSON bodies
      // in tests only via its fallback — mirror studio-llm.test.ts's helper.
      // COPY the SSE-shaping helper from apps/worker/test/studio-llm.test.ts
      // (`sseBody(content)`) rather than inventing a new shape.
      sseBody(content),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => n };
}
const GOOD = JSON.stringify({ glance: "Steady 9:40s; HR drifted late — fueling.", body: "Nice steady effort…", flags: ["hr_drift"] });
```

Test cases (each a separate `it`; insert activities via `db.insert(activities).values({...})` with `sport: "run"`, `startTime`/`startTimeLocal` — copy the activity fixture shape from `coach-effort.test.ts`):
1. `enqueueCoachReads` enqueues a 3-day-old activity, skips a 20-day-old one, and is idempotent (second call inserts 0).
2. `processCoachReads` with GOOD transport → row `done`, glance/body/flags stored, exactly 1 call, `llm_usage` row kind `coach_read`.
3. **Exactly-once:** enqueue one activity, then `await Promise.all([processCoachReads(...), processCoachReads(...)])` with the SAME db → total calls === 1.
4. Failure backoff: transport returning 500s → row stays `queued`… wait, claim moves it to `running` then failure sets `status:'queued'`, `attempt:1`, `nextAttemptAt` in the future → a second immediate `processCoachReads` makes 0 calls. After `READ_MAX_ATTEMPTS` simulated attempts (set `attempt: 4` directly, run once more with failing transport) → `failed`.
5. Gates: `prefs.aiEnabled false` → `{skipped: "ai_disabled"}`, 0 calls, rows untouched. Missing `AI_GATEWAY_API_KEY` → `"no_key"`. Seed `llm_usage` with a 13_000_000-micro row (kind `studio_generate`, createdAt now) → `"budget_reserve"`, 0 calls — but `ensureRead` (user-initiated) still runs while under the $20 cutoff.
6. `ensureRead` on an unqueued activity generates synchronously (1 call, `done`); called again → `done` from ledger, 0 new calls; `force:true` → regenerates same row (still 1 row total, 1 new call). Unknown activity → `not_found`.
7. Re-ingest no-re-read: after `done`, `enqueueCoachReads` again → still `done`, 0 new rows.
8. `enqueueBackfillDigest(db, u, "run1", 12)` inserts `digest:run1` row; `oldCount 3` → false, no row; repeat call → no duplicate.
9. Invalid JSON then valid on repair round-trip (responses `["not json", GOOD]`) → `done`, 2 calls.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @rg/worker test -- coach-reads` → FAIL (module missing).

- [ ] **Step 3: Implement `coach-reads.ts`**

```ts
import { and, eq, gte, isNull, lte, notInArray, sql } from "drizzle-orm";
import { activities, coachReads, llmUsage } from "@rg/database";
import { addDays, newId, nowInstant, type LocalDate, type UserPreferences } from "@rg/domain";
import { z } from "zod";
import type { Env } from "../env.js";
import { fixtureModeEnabled } from "../env.js";
import type { Db } from "./db.js";
import { llmBudgetStatus } from "./llm.js";
import { chatCompletion, DEFAULT_MODEL_STRONG, extractJson, recordUsage } from "./studio-llm.js";
import { buildEffortPackage } from "./coach-effort.js";

export const AUTO_READ_RESERVE_MICROS = 12_000_000; // auto-reads stop at $12; interactive keeps $8 headroom
export const READ_MAX_ATTEMPTS = 5;
export const READ_RECLAIM_MINUTES = 10;
export const READ_WINDOW_DAYS = 14;
const MAX_OUTPUT_TOKENS_READ = 8_000;

export const READ_SYSTEM_PROMPT = `You are the athlete's coach, reading ONE completed effort. Reply with ONE JSON object, nothing else:
{"glance": string, "body": string, "flags": string[]}
- glance: ≤90 characters, one observation a tired athlete absorbs at a glance. An observation, not a grade ("HR drifted 6% late — fueling, not fitness").
- body: the full read, ≤180 words, plain prose. Same honesty rules as always: never invent data; conditions before conclusions; a rough day gets context, never judgment; close with one earned, specific encouragement.
- flags: zero or more of "hr_drift","strain_high","breakthrough","pace_regression","fueling","comeback". Empty array when nothing stands out. A flag means "the coach should mention this at the next briefing" — be sparing.`;

const readOutputSchema = z.object({
  glance: z.string().min(1).transform((s) => (s.length > 90 ? s.slice(0, 89) + "…" : s)),
  body: z.string().min(1),
  flags: z.array(z.enum(["hr_drift", "strain_high", "breakthrough", "pace_regression", "fueling", "comeback"])).max(6),
});
```

Enqueue (insert-or-ignore via `onConflictDoNothing` on the unique index):

```ts
export async function enqueueCoachReads(db: Db, userId: string, today: LocalDate): Promise<number> {
  const cutoff = addDays(today, -READ_WINDOW_DAYS);
  const acts = await db.select({ id: activities.id, startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
    .from(activities).where(eq(activities.userId, userId));
  const recent = acts.filter((a) => (a.startTimeLocal ?? a.startTime).slice(0, 10) >= cutoff);
  if (recent.length === 0) return 0;
  const existing = new Set(
    (await db.select({ activityId: coachReads.activityId }).from(coachReads).where(eq(coachReads.userId, userId))).map((r) => r.activityId),
  );
  const fresh = recent.filter((a) => !existing.has(a.id));
  const now = nowInstant();
  for (const a of fresh) {
    await db.insert(coachReads)
      .values({ id: newId(), userId, activityId: a.id, status: "queued", attempt: 0, nextAttemptAt: now, claimToken: null, claimedAt: null, glance: null, body: null, flags: [], model: null, createdAt: now, completedAt: null })
      .onConflictDoNothing();
  }
  return fresh.length;
}
```

Claim (the R2 heart — token pattern):

```ts
/** Atomically claim one due row. Returns the claimed row or null. A `running`
 * row whose claimedAt is older than READ_RECLAIM_MINUTES is reclaimable
 * (crash recovery) — its in-flight call, if any, will fail the token check
 * when it tries to complete. */
async function claimNextRead(db: Db, userId: string, now: string): Promise<{ id: string; activityId: string; token: string } | null> {
  const staleBefore = new Date(Date.parse(now) - READ_RECLAIM_MINUTES * 60_000).toISOString();
  const due = await db.select().from(coachReads).where(
    and(eq(coachReads.userId, userId), lte(coachReads.nextAttemptAt, now)),
  );
  const candidate = due.find((r) => r.status === "queued" || (r.status === "running" && (r.claimedAt ?? "") < staleBefore));
  if (!candidate) return null;
  const token = newId();
  await db.update(coachReads)
    .set({ status: "running", claimToken: token, claimedAt: now, attempt: candidate.attempt + 1 })
    .where(and(
      eq(coachReads.id, candidate.id),
      // Same condition the candidate matched — a racer who claimed first
      // changed status/claimedAt, so this UPDATE matches zero rows for us.
      candidate.status === "queued"
        ? eq(coachReads.status, "queued")
        : and(eq(coachReads.status, "running"), lte(coachReads.claimedAt, staleBefore)),
    ));
  const [after] = await db.select().from(coachReads).where(eq(coachReads.id, candidate.id)).limit(1);
  return after?.claimToken === token ? { id: candidate.id, activityId: candidate.activityId, token } : null;
}
```

Completion is token-guarded too: `db.update(coachReads).set({status:"done", …}).where(and(eq(id), eq(claimToken, token)))`. Failure path: token-guarded update to `{status: attempt >= READ_MAX_ATTEMPTS ? "failed" : "queued", nextAttemptAt: now + min(2^attempt × 15min, 24h), claimToken: null}`.

`generateRead(db, env, userId, activityId, token, fetchImpl)` — builds package (digest ids `digest:<runId>` get a package of the last 90 days' activity summary lines instead: reuse `buildEffortPackage` only for real ids; for digests, assemble counts/spans inline: total activities by sport, date span, longest run, biggest week — ~20 lines of SQL over `activities`), one `chatCompletion` with `READ_SYSTEM_PROMPT`, `extractJson` + `readOutputSchema.safeParse`, ONE repair round-trip carrying zod issues (copy the `attemptParse` shape from `coach-wake.ts:306-332`), `recordUsage(db, userId, "coach_read", model, "strong", chat, \`read:${activityId}\`)`.

`processCoachReads` gate order: `fixtureModeEnabled(env)` → `"fixture"`; `!env.AI_GATEWAY_API_KEY` → `"no_key"`; `!(prefs.aiEnabled && env.AI_DEFAULT_ENABLED !== "0")` → `"ai_disabled"`; `(await llmBudgetStatus(db, userId)).spentMicros >= AUTO_READ_RESERVE_MICROS` → `"budget_reserve"`. Then loop `cap` times: claim → generate → persist.

`ensureRead`: look up row by `(userId, activityId)`. `done` && !force → return it. `running` (fresh claim) → `{status:"working"}`. Missing/queued/failed/force → gates (user-initiated: use full `budget.cutoff`, not the reserve; on cutoff → `"resting"`) → claim that specific row (insert first if missing, `force` resets `attempt: 0, status: "queued", nextAttemptAt: now` before claiming) → generate synchronously → `done`.

Hook the callers:
- `devices.ts` post-ingest (right after the `ingestActivities` call ~line 231; the handler has `c` in scope): `const today = todayInZone(prefs.timezone); await enqueueCoachReads(db, userId, today); c.executionCtx?.waitUntil?.(processCoachReads(db, c.env, userId, prefs, {}).catch(() => undefined));` — wrap in `try/catch` so ingest never fails on enqueue.
- `backfill.ts` after its `ingestActivities` (~line 199): compute `oldCount` = sources in this chunk whose start date < `addDays(today, -READ_WINDOW_DAYS)`; call `enqueueCoachReads` + `enqueueBackfillDigest(db, userId, backfillRunId, oldCount)` (the run id variable is in scope in that function — use the actual name found there).
- `index.ts` `hourly()` inside the user loop after `sweepUserProposals`: `await processCoachReads(db, env, userId, prefs, {}).catch(() => undefined);` — cap 2 keeps the loop bounded.

- [ ] **Step 4: Run tests** — coach-reads suite PASS, then full worker suite PASS.
- [ ] **Step 5: Commit** — `feat(worker): ambient coach reads — exactly-once ledger, gates, backoff, digest, ingest+cron hooks`

---

### Task 3: Wake single-flight + focus + RECENT READS + `notable_read`

**Files:**
- Modify: `apps/worker/src/services/coach-wake.ts`, `apps/worker/src/services/coach-context.ts`, `apps/worker/src/services/coach-triggers.ts`, `packages/domain/src/coach.ts` (wakeOutputSchema)
- Test: `apps/worker/test/coach-wake.test.ts`, `apps/worker/test/coach-triggers.test.ts`, `apps/worker/test/coach-context.test.ts` (extend each)

**Interfaces:**
- Consumes: `coachLocks`, `coachReads` tables.
- Produces: `wakeOutputSchema` gains `focus: z.string().max(200).nullable().default(null)` (`WakeOutput.focus`); briefing message `refs.focus?: string`; trigger kind `"notable_read"`; `withWakeLock` internal only.

- [ ] **Step 1: Write failing tests**
  - coach-wake: **single-flight** — stub transport with a 50ms-delayed GOOD wake JSON; `Promise.all([wake(...'manual'), wake(...'manual')])` → exactly 1 transport call; second result `{status:"skipped"}`. **Stale lock takeover** — pre-insert `coachLocks` row with `claimedAt` 20 min old → wake proceeds (1 call). **focus persisted** — wake output with `focus: "Saturday anchors the week."` → briefing message row has `refs.focus` set.
  - coach-triggers: a `done` read with `flags:["hr_drift"]` newer than the last coach briefing fires `notable_read` (evidence carries activityId+glance+flags); a read with `flags: []` doesn't; 72h dedupe blocks refire (reuse the suite's existing dedupe-test pattern).
  - coach-context: seed 2 `done` reads → dossier text contains `RECENT READS` with both glances; seed an old-style analysis message (`role:'coach'`, `refs.kind:'analysis'`) newer than the real briefing → `freshBriefing`-equivalent behavior ignores it (assert via `openWakeIsFresh(db, userId, 0)` false when only an analysis is recent).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**
  - `coach.ts` (domain): add `focus` to `wakeOutputSchema` (nullable, default null, `prose(200)`-style truncation consistent with neighbors).
  - `coach-wake.ts`:
    - Lock helper (top of `wake`, after the message-persist + budget gate + skip-rule so user words are never dropped and cheap skips never claim):

    ```ts
    const WAKE_LOCK_STALE_MINUTES = 10;
    async function claimWakeLock(db: Db, userId: string): Promise<string | null> {
      const now = nowInstant();
      const staleBefore = new Date(Date.parse(now) - WAKE_LOCK_STALE_MINUTES * 60_000).toISOString();
      const token = newId();
      await db.insert(coachLocks).values({ userId, kind: "wake", token, claimedAt: now })
        .onConflictDoUpdate({
          target: [coachLocks.userId, coachLocks.kind],
          set: { token, claimedAt: now },
          setWhere: sql`${coachLocks.claimedAt} < ${staleBefore}`,
        });
      const [row] = await db.select().from(coachLocks)
        .where(and(eq(coachLocks.userId, userId), eq(coachLocks.kind, "wake"))).limit(1);
      return row?.token === token ? token : null;
    }
    const releaseWakeLock = (db: Db, userId: string, token: string) =>
      db.delete(coachLocks).where(and(eq(coachLocks.userId, userId), eq(coachLocks.kind, "wake"), eq(coachLocks.token, token)));
    ```

    In `wake()`: after the existing `open` skip-rule check, `const lock = await claimWakeLock(db, userId); if (!lock) return { status: "skipped" };` and wrap the whole try in `finally { await releaseWakeLock(db, userId, lock).catch(() => undefined); }`. (A `skipped` result is already a client no-op — the busy tab's own wake will refresh state.)
    - `freshBriefing` (line ~150) and the `/state` route's `lastCoach` query (Task 4 touches routes): add `sql\`json_extract(${coachMessages.refs}, '$.kind') IS NULL\`` to the where — analyses (legacy rows) no longer count as briefings.
    - Persist `focus`: in the briefing persist (~line 471), pass `refs: { …, focus: out.focus ?? undefined }` — extend `persistMessage`'s refs type accordingly, and add `focus?: string` to the `coachMessages.refs` `$type` in `schema/coach.ts` + `CoachMessageDto.refs` in api-client.
    - `WAKE_SYSTEM_PROMPT`: add to the output-shape line: `"focus": string|null` and the rule `- FOCUS: one sentence (≤160 chars) naming the week's anchor and at most one adjustment — the plan page shows it as "the coach's line". null when you have nothing genuinely useful.`
    - Dossier cause block: no change (RECENT READS rides the dossier).
  - `coach-context.ts`: new section between MILESTONES and OPEN ITEMS:

    ```ts
    // ── RECENT READS — glances since the last briefing (rework spec §3) ──
    const reads = await db.select().from(coachReads).where(and(eq(coachReads.userId, userId), eq(coachReads.status, "done")));
    const lastBriefingAt = /* newest role='coach' with refs.kind IS NULL, else "" */;
    const fresh = reads.filter((r) => (r.completedAt ?? "") > lastBriefingAt).slice(-7);
    if (fresh.length) {
      lines.push("RECENT READS");
      for (const r of fresh) lines.push(`- [${r.activityId}] ${r.glance ?? ""}${r.flags.length ? ` (${r.flags.join(",")})` : ""}`);
    }
    ```
    (Adapt to the file's actual section-builder idiom — read it first; it builds section strings, budget-sliced at the end.)
  - `coach-triggers.ts`: add `"notable_read"` to `CoachTriggerKind`; new block in `evaluateTriggers` (before the final insert):

    ```ts
    // notable_read — a flagged read the athlete hasn't been briefed on.
    if (!blocked.has("notable_read")) {
      const reads = await db.select().from(coachReads)
        .where(and(eq(coachReads.userId, userId), eq(coachReads.status, "done")));
      const [lastBriefing] = await db.select().from(coachMessages)
        .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach"),
          sql`json_extract(${coachMessages.refs}, '$.kind') IS NULL`))
        .orderBy(desc(coachMessages.at)).limit(1);
      const since = lastBriefing?.at ?? "";
      const notable = reads.find((r) => (r.completedAt ?? "") > since && r.flags.length > 0);
      if (notable) {
        fired.push({ kind: "notable_read", evidence: { activityId: notable.activityId, glance: notable.glance, flags: notable.flags } });
      }
    }
    ```

- [ ] **Step 4: Run** worker suite → PASS (existing wake tests must still pass — the lock is invisible to single-caller tests).
- [ ] **Step 5: Commit** — `feat(worker): wake single-flight lock, focus line, RECENT READS dossier, notable_read trigger`

---

### Task 4: Analyze route → read-through; api-client + CoachRead

**Files:**
- Modify: `apps/worker/src/routes/coach.ts` (analyze handler ~141-153), `apps/worker/src/services/coach-analyze.ts` (delete; its route now calls `ensureRead`), `packages/api-client/src/index.ts` (CoachAnalyzeResult + coachAnalyze), `packages/ui/src/screens/coach-read.tsx`
- Test: `apps/worker/test/coach-routes.test.ts` (extend), delete `coach-analyze.test.ts` (its behaviors now live in coach-reads tests), `packages/ui/test/coach-panel.test.tsx` untouched

**Interfaces:**
- Produces: `POST /api/coach/analyze/:activityId` → `{ read: { id, glance, body, flags, at }, cached: boolean }` | 404 | 429 `{error:"resting"}` | 202 `{status:"working"}` | 502. api-client `CoachAnalyzeResult = { read: { id: string; glance: string; body: string; flags: string[]; at: string }; cached: boolean }`.

- [ ] **Step 1: Failing route tests** (in `coach-routes.test.ts`, using `mountRoutes` + fake transport): analyze twice → second returns `cached: true` and transport called once; concurrent analyze (Promise.all) → one 200 + one `{status:"working"}` (202) or both 200 with 1 transport call (either is exactly-once; assert `calls() === 1`); analyze with `prefs.aiEnabled` false → 503 `{error:"ai_disabled"}` (NEW behavior — the old path ignored the kill switch).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — route body:

```ts
coachRoutes.post("/analyze/:activityId", async (c) => {
  const db = c.get("db"); const userId = c.get("userId");
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const prefs = await loadPreferences(db, userId);
  const r = await ensureRead(db, c.env, userId, prefs, c.req.param("activityId"), { force: force === true });
  if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
  if (r.status === "working") return c.json({ status: "working" }, 202);
  if (r.status === "resting") return c.json({ error: "resting", detail: "Weekly coach budget reached — try next week." }, 429);
  if (r.status === "ai_disabled") return c.json({ error: "ai_disabled" }, 503);
  if (r.status === "error" || !r.read) return c.json({ error: "llm_error" }, 502);
  return c.json({ read: r.read, cached: r.cached === true });
});
```

(Add `"ai_disabled"` to `ReadResult.status` union and `cached?: boolean` to `ensureRead`'s result in Task 2's file while here.) Delete `coach-analyze.ts` and its import in `routes/coach.ts`; keep `ANALYSIS_SYSTEM_PROMPT` history in git only. Update api-client types + `coachAnalyze` return type. `coach-read.tsx`: render `analyze.data.read.body`, show `glance` as the first line styled `coach-read-glance` (add `.coach-read-glance { font-weight: 650; }` to styles.css §coach-read block), poll on 202: `if (data?.status === "working") setTimeout(() => mutate(false), 4000)` guarded by mount ref. Grep for other `CoachAnalyzeResult` consumers (`runs.tsx`) and update the property access (`message.body` → `read.body`).

- [ ] **Step 4: Run** worker + ui suites → PASS.
- [ ] **Step 5: Commit** — `feat(worker,ui): analyze becomes read-through on the reads ledger — glance surfaced, kill switches honored`

---

### Task 5: `GET /api/plan/week`

**Files:**
- Modify: `apps/worker/src/routes/plan.ts` (new handler at the end of route defs), `packages/api-client/src/index.ts` (DTO + method)
- Test: `apps/worker/test/plan-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `computeWeeklyTraining`/`computeConsistency` (`@rg/analytics`), `plannedWorkouts`, `activities`, `coachPlans`, `coachMessages` (focus), `studioPlans` (week counting for lift plans).
- Produces route payload (api-client `PlanWeekResponse`):

```ts
export interface PlanWeekResponse {
  weekStart: string;
  days: Array<{ date: string; workouts: WorkoutDto[] }>; // length 7, Mon-first
  plannedSeconds: number;   // sum workoutSeconds, non-rest, this week
  doneCount: number;        // completionState === "completed"
  sessionCount: number;     // non-rest planned items
  weekIndex: number | null; // 1-based within the covering active coach plan
  weekTotal: number | null;
  adherence4w: { pct: number | null; trend: "up" | "flat" | "down" | null };
  loadRatio: number | null; // trailing 7d / 28d trainingLoad, all sports
  headline: "on_track" | "behind" | "ahead" | "rebuilding" | "race_week" | "resting";
  focus: { text: string; at: string } | null; // null when >3 days old
}
```

- [ ] **Step 1: Failing tests** (plan-routes.test.ts): seed a user with an active coach plan (startDate 4 weeks ago, endDate 8 weeks out), 6 planned workouts this week (1 completed), activities with trainingLoad across 28 days, a briefing message with `refs.focus`. Assert: `weekIndex === 5`, `weekTotal === 12`, `plannedSeconds`/`doneCount`/`sessionCount` exact, `focus.text` present, and with a 4-day-old focus → `focus === null`. Headline table test: call the exported pure `deriveHeadline({adherencePct, loadRatio, raceInDays, deloadWeek})` directly for each branch: race ≤7d → `race_week`; adherence null → `rebuilding`; ≥95 && loadRatio ≥1 → `ahead`; ≥80 → `on_track`; 60–79 → `behind`; <60 → `rebuilding`.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Export `deriveHeadline` from `plan.ts` (pure, no db). Handler: parse `start` (default `startOfIsoWeek(todayInZone(prefs.timezone))`, validate `/^\d{4}-\d{2}-\d{2}$/` + must be a Monday via `startOfIsoWeek(start) === start`, else 400). Days: reuse the workouts query pattern from the existing window handler scoped to `[start, start+6]`, mapped through the SAME DTO mapper the existing `/workouts` route uses (extract the mapper into a shared function if it's inline — keep one mapper, not two). `weekIndex`: covering active plan where `startDate ≤ start ≤ endDate` → `Math.floor((Date.parse(start) - Date.parse(startOfIsoWeek(plan.startDate))) / (7 * 86_400_000)) + 1`; lift studio plans use `studioPlans.plan.brief.durationWeeks` for total with week 1 at the plan's first push week — if that's not derivable (no pushes), return nulls. `adherence4w`: `computeConsistency` over the trailing 28 days ending at `start-1` (all disciplines: run the query unscoped by sport — check `computeConsistency`'s input shape in `packages/analytics/src/consistency.ts:23-51` and feed it planned workouts + statuses directly); trend compares that pct to the 28 days before it (±5pts → flat). `loadRatio`: sum `trainingLoad` over activities in `[today-7, today]` ÷ (sum over `[today-28, today]` / 4), null when the denominator is 0. `focus`: newest `role='coach'` message with `json_extract(refs,'$.focus') IS NOT NULL`, null if `at` older than 72h. api-client: `planWeek: (start?: string) => get<PlanWeekResponse>(\`/api/plan/week${start ? `?start=${start}` : ""}\`)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(worker): GET /api/plan/week — brief facts, headline, focus`

---

### Task 6: `GET /api/coach/plans/:id/detail` + structured lift persist

**Files:**
- Modify: `apps/worker/src/routes/coach.ts` (new handler after `/plans`), `apps/worker/src/services/coach-apply.ts` (~44-81), `packages/api-client/src/index.ts`
- Test: `apps/worker/test/coach-routes.test.ts`, `apps/worker/test/coach-apply.test.ts` (extend)

**Interfaces:**
- Produces api-client `PlanDetailResponse`:

```ts
export interface PlanProgressionPoint { week: number; value: number; done?: boolean }
export interface PlanProgression { key: string; label: string; unit: string; from: number; to: number; now: number | null; series: PlanProgressionPoint[] }
export interface PlanDetailWeek { weekStart: string; index: number; state: "firm" | "shape"; volumeTarget: string | null; keySessions: string[]; summary: string; done: boolean; current: boolean }
export interface PlanDetailResponse { plan: CoachPlanDto; weeks: PlanDetailWeek[]; progressions: PlanProgression[]; sessions: { planned: number; done: number }; adherencePct: number | null }
```

- coach-apply: lift sessions persist `structuredJson: { exercises: session.lift.exercises }` on the inserted `plannedWorkouts` row (keep the flattened `stageSummary` too).

- [ ] **Step 1: Failing tests.**
  - coach-apply: apply a `createPlan` op with a lift session → inserted row has `structuredJson.exercises` matching the op's exercises.
  - coach-routes detail: (a) studio plan seeded from a fixture `LiftingPlan` (copy the valid plan JSON literal from `studio-routes.test.ts` fixtures) → progressions contain the top-frequency lift with prescribed series week→kg and `sessions.planned === weeks × sessionsPerWeek`; (b) coach run plan with `coachPlanWeeks` (2 firm + 2 shape, `volumeTarget: "~4h easy focus"`) + planned workouts carrying `expectedDistanceMeters` → weeks list has firm/shape states and a `long_run` progression whose series is the per-week max distance (miles rounded to 0.1); shape weeks excluded from series; (c) unknown id → 404.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Route resolves the id against `coachPlans` then `studioPlans`. Extractors as pure exported functions in a new `apps/worker/src/services/plan-progressions.ts`: `liftProgressions(plan: LiftingPlan, pushes: StudioPlanPushRow[]): PlanProgression[]` (top-3 `originId` by frequency; per week take the max `weight.value` among that exercise's appearances — `bodyweight` weights excluded; `done` for a week when every push of that week is `verified`+matched — reuse the push→match join pattern from `routes/coach.ts /plans`'s pushed check, joined through `workout_completion_matches`) and `runProgressions(workouts: PlannedWorkoutRow[], weeks: CoachPlanWeekRow[]): PlanProgression[]` (`long_run`: per ISO week max `expectedDistanceMeters` → miles; `weekly_minutes`: sum `sourceEstimatedDurationSeconds`/60). `summary` per week: lift → `"bench 125, squat 175 · 44 sets"` style from the week's exercises (top 2 lifts by weight); run → `volumeTarget ?? key session titles joined " · "`. `adherencePct` via existing `coachBlockAdherence`. api-client: `planDetail: (id: string) => get<PlanDetailResponse>(\`/api/coach/plans/${id}/detail\`)`.
- [ ] **Step 4: Run** → PASS (including studio suites — the coach-apply change must not break push flows).
- [ ] **Step 5: Commit** — `feat(worker): plan detail route with progression series; coach lift structure survives apply`

---

### Task 7: UI — the new plan page

**Files:**
- Create: `packages/ui/src/screens/plan-brief.tsx`, `packages/ui/src/screens/week-view.tsx`, `packages/ui/src/screens/plan-cards.tsx`, `packages/ui/src/screens/coach-window.tsx`
- Modify: `packages/ui/src/screens/plan.tsx` (rewrite the assembly; KEEP `WorkoutDetail`, `usePlanCoach`, `focusProposal`, `askable`/`displayCompletionState`, `WorkoutCell` unchanged), `packages/ui/src/shell.tsx` (`shell-main--wide` for `/plan`), `packages/ui/src/styles.css`
- Delete usage (not files): `buildMonths`, month render, `ManagePlans` import, `StudioSection` import, Today button, extend row, `SHEET_ID_PREFIX`/`idPrefix` threading (also remove the `idPrefix` prop from `CoachPanel` and `PendingTray`/`ProposalCard` in `coach-panel.tsx` — one mount means plain ids)
- Test: `packages/ui/test/plan-page.test.tsx` (new), `packages/ui/test/coach-panel.test.tsx` (update: drop idPrefix cases)

**Interfaces:**
- Consumes: `api.planWeek`, `api.coachPlans`, `api.workouts`, `usePlanCoach` (unchanged), `pendingByDate` (`coach-panel.tsx`).
- Produces components:

```ts
export function WeeklyBrief(props: { week: PlanWeekResponse; pendingCount: number; onNeedsYou: () => void }): JSX.Element
export function PlanCards(props: { plans: CoachPlanDto[]; details: Map<string, PlanDetailResponse | undefined>; onOpen: (id: string) => void; onNew: (discipline: "run" | "lift") => void }): JSX.Element
export function WeekView(props: { week: PlanWeekResponse; today: string; ghostsByDate: Map<string, GhostChip[]>; planWeekLabel: string | null; onPick: (monday: string) => void; onOpenWorkout: (id: string) => void; onGhostTap: (proposalId: string) => void; jumpWeeks: Array<{ monday: string; label: string }> }): JSX.Element
export function CoachWindow(props: { panel: ReactNode; pendingCount: number; hasNewActivity: boolean; onSeen: () => void }): JSX.Element  // desktop only; renders null <1024px
export const HEADLINE_COPY: Record<PlanWeekResponse["headline"], string> // e.g. on_track → "on track", behind → "slightly behind", rebuilding → "rebuilding", race_week → "race week", resting → "resting up", ahead → "ahead"
```

- [ ] **Step 1: Failing component tests** (`plan-page.test.tsx`, same static-render style as `coach-panel.test.tsx` — read that file's harness first and reuse it):
  1. `WeeklyBrief` renders `Week 5 of 12 — on track.` from a fixture `PlanWeekResponse` (weekIndex 5, weekTotal 12, headline `on_track`), all 4 chips with tabular values, the focus line, and the Needs-you pill only when `pendingCount > 0`.
  2. `WeeklyBrief` with `weekIndex: null` renders the headline without the `Week n of m` fragment (`This week — on track.`).
  3. `WeekView` renders 7 day cells Mon-first, today ring on `today`, a ghost button on its date wired to `onGhostTap`, rest day quiet, and a "back to this week" chip only when `week.weekStart !== startOfIsoWeek(today)`.
  4. `WeekView` jump menu lists `jumpWeeks` labels and calls `onPick` with the monday.
  5. `PlanCards` renders a card per plan with `wk n/m`, progression headline `115 → 145 lb` (formatted from the first progression), and a dashed new-plan card per absent discipline; click calls `onOpen(id)`.
  6. `CoachWindow` minimized shows `Coach · 2` pill; `hasNewActivity` true → renders open; minimize click calls `onSeen`.
- [ ] **Step 2: Verify failure** — `pnpm --filter @rg/ui test -- plan-page`.
- [ ] **Step 3: Implement components.** Follow the mock's DOM (open `docs/superpowers/mocks/2026-08-11-coach-plan-rework.html` §3–4): brief = `.rg-card.brief` structure → real classes `card plan-brief` with `plan-brief-head/chips/chip/action`; week = `plan-week-head` + `plan-week-grid`/`plan-week-list`; cards = `plan-cards` grid + `plan-card`. Sparkline: inline SVG `viewBox="0 0 96 26"` from `progression.series` (scale x by index, y min→max; stroke `var(--chart-1)` run / `var(--lift-ink)` lift; `aria-hidden` + text alternative in the headline). CoachWindow: `localStorage` keys `rg.coachWindow.open` / `rg.coachWindow.seen` (a message-count+proposal-count watermark string `${lastCoachAt}:${pendingCount}`); Esc handler only when `document.activeElement` is inside and no dialog is open (`isTopDialog` export from components.tsx guards this); `className="coach-window"`, minimized pill reuses `.coach-pill` with `coach-pill--desktop` modifier.
- [ ] **Step 4: Rewrite `plan.tsx` assembly.** Query changes: add `["plan-week", monday]` → `api.planWeek(monday)` (monday from `?week=` param, validated, else current); keep `["plan"]` workouts query but window = `monday −4w … monday +4w` (refetch key includes monday: `["plan", monday]`); keep coach queries. Detail queries for plan cards: `useQueries` over active plans → `["plan-detail", id]` → `api.planDetail(id)`. Jump menu content: derived from active plans' week spans (`W1…Wn` labels with month names). Mobile day list: same `WeekView` renders `.plan-week-list` under 1024px via CSS (one component, CSS folds — mirror how `.cal-week` folded, styles.css:871-908, then delete those). Ghost tap: `onGhostTap` opens window (desktop: set window open + `focusProposal(id, "", true)`) or sheet (mobile: `setCoachOpen(true)` + `focusProposal(id, "", false)` — no prefix anymore). `shell.tsx`: add `shell-main--wide` when `pathname.startsWith("/plan")` (mirror the `--immersive` branch at shell.tsx:14-59); styles: `.shell-main--wide { max-width: 1440px; }`.
- [ ] **Step 5: Styles.** Add a `/* ── plan page (2026-08-11 rework) ── */` block: port the mock's `.brief/.plan-cards/.plan-card/.wk-*/.coach-win` styles into the app's tokens (they already use them — rename `.rg-*` prefixes off, dedupe with existing `.card`). Delete: `.plan-split*`, `.cal-month*`, `.cal-weekdays`, `.cal-week`, `.cal-day*`, `.cal-extend-row`, `.cal-pending` (dead), mobile agenda fold rules (styles.css:871-908) — grep each class for other consumers first (`WeekRibbon` uses `.week-*`, NOT `.cal-*`; `MoveSheet`/`MatchSheet` use `.workout-row`, keep). KEEP `.cal-card*` and `.cal-ghost*` (WorkoutCell/ghosts render inside the new week cells). **R1 rules in this block:** `.plan-brief-chips { display: flex; flex-wrap: wrap; gap: .4rem; }`; `.plan-week-head { flex-wrap: wrap; }`; `.plan-card svg, .chartbox svg { width: 100%; height: auto; }`; `.plan-week-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }` (the `minmax(0,…)` is what prevents cell blowout); every new text row gets `min-width: 0` on flex children.
- [ ] **Step 6: Run** ui suite + `pnpm -w typecheck` (or the repo's check script — see root package.json) → PASS.
- [ ] **Step 7: Commit** — `feat(ui): plan page rebuilt — brief, plan cards, one pickable week, floating coach window`

---

### Task 8: UI — studio modal

**Files:**
- Create: `packages/ui/src/screens/studio-modal.tsx`, `packages/ui/src/screens/plan-charts.tsx`
- Modify: `packages/ui/src/screens/plan.tsx` (mount, `?plan=` param), `packages/ui/src/screens/studio.tsx` (export the generate/edit/push controls as `StudioControls` — extract from `StudioSection`'s body; `StudioSection` itself becomes unused and is deleted along with its import sites), `packages/ui/src/styles.css`
- Test: `packages/ui/test/studio-modal.test.tsx` (new)

**Interfaces:**
- Consumes: `api.planDetail`, `CoachPlanDto`, `Sheet` (components), `ChartFrame`/`niceTicks`/`dateX` (chart-kit), `StudioControls` (new export), `usePlanCoach.send` for canned intake.
- Produces:

```ts
export function StudioModal(props: {
  planId: string | "new-run" | "new-lift";
  plans: CoachPlanDto[];
  onClose: () => void;
  onCanned: (body: string) => void;   // routes to coach.send + opens coach surface
  onRetire: (id: string) => void;
  onRename: (id: string, name: string) => void;
}): JSX.Element
// plan-charts.tsx
export function ProgressionStepChart(props: { progression: PlanProgression; discipline: "run" | "lift" }): JSX.Element
export function PlannedVsDoneBars(props: { planned: number[]; done: number[]; labels: string[] }): JSX.Element
```

- [ ] **Step 1: Failing tests:** modal renders name/pills/dates from a fixture detail; progression chips formatted `115 → 145 lb`; weeks list marks `current` row and firm/shape/done states; Retire is two-step (first click → "Really retire…"); `new-lift` mode renders the intake copy + brief form CTA and no weeks section; `ProgressionStepChart` outputs a `<figure>` (ChartFrame) with an SVG containing one step-path and `done` dots only for done points; charts SVG has `viewBox` and no `width` attribute in px.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Modal = `Sheet` (existing contract gives mobile bottom-sheet / desktop dialog free — pass `title={plan.name}`); body sections per mock §5. Charts on chart-kit: step path built from series (x = week index scaled into a 320×130 viewBox with margins `{top:10,right:10,bottom:26,left:40}`, y via `niceTicks`); prescribed = `stroke: var(--ink-faint)` dasharray `4 3`; done dots = discipline color (`var(--chart-2)` lift, `var(--chart-1)` run) r=4 with a 2px `var(--bg-raised)` ring; direct end-label with the `to` value; `ChartFrame` `summary` prop carries the text alternative (existing pattern — see `WeeklyDurationChart`). Actions: Extend/Wind down → `onCanned(\`Extend "${plan.name}" — draft the next weeks in the same shape.\`)` / wind-down equivalent (copy the exact canned strings from the deleted ManagePlans — they're in `coach-panel.tsx:464-598`); Rename inline input; Retire two-step calls `onRetire`. Studio-source lift plans render `<StudioControls />` inside a `<details className="studio-revise">` with summary "Revise this plan". `plan.tsx`: `?plan=` param mounts it (like `?workout=`); plan-card click → `setParams({ plan: id })`; new-plan card → `setParams({ plan: "new-run" })` etc.
- [ ] **Step 4: R1 pass on the modal:** charts grid `.charts2 { grid-template-columns: 1fr 1fr; } @media (max-width: 760px) { .charts2 { grid-template-columns: 1fr; } }`; week rows wrap (`flex-wrap: wrap` on `.wkrow` desc); action row wraps.
- [ ] **Step 5: Run** ui suite → PASS.
- [ ] **Step 6: Commit** — `feat(ui): studio modal — plan detail with progression charts, actions, intake; studio section absorbed`

---

### Task 9: Verification — suites, screenshots, overflow gate

**Files:**
- Modify: `scripts/screenshots.mjs` (viewport/route matrix — read it first; extend, don't rewrite)
- Create: `docs/superpowers/mocks/2026-08-11-coach-plan-rework.html` (copy the approved mock file from the session scratchpad if not already committed in Task 0 below)

- [ ] **Step 1: Full suites** — `pnpm test` at root → all PASS. `pnpm -w typecheck`/lint per root scripts.
- [ ] **Step 2: Fixture stack screenshots.** Worktree dev stack (memory: copy `.dev.vars`, `mkdir -p apps/web/dist`, Node 22 for wrangler, env-overridable ports — use `RG_WEB_PORT=5199 RG_API_PORT=8899` to avoid other sessions). Capture `/plan` (default, week navigated ±1, `?plan=` modal open, coach window open + minimized) at 360×780, 390×844, 768×1024, 1280×800, 1440×900, light + dark.
- [ ] **Step 3: R1 assertion.** In the screenshot script, after each mobile-width load: `const ok = await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1); if (!ok) throw new Error(\`horizontal overflow at ${route} ${width}\`);` — the run fails loud, not just a bad PNG.
- [ ] **Step 4: Exactly-once smoke against the dev stack:** open `/plan` in two tabs simultaneously (fresh user with `wakeAdvised` true), then `sqlite3` (or the d1 local db query path used by other scripts) count `llm_usage` rows kind `coach_wake` for the session window → must be ≤1. With fixture mode this exercises the lock path without real LLM spend (transport will no-op — assert via `coach_locks` emptiness after settle + no duplicate wake receipts in the thread).
- [ ] **Step 5: Review screenshots against the mock** (§3–5): brief anatomy, card grammar, week grid, ghost treatment, modal charts. Fix visual drift; re-run.
- [ ] **Step 6: Commit** — `test(ui,worker): rework verification — screenshot matrix + overflow gate + single-flight smoke`

---

### Task 0 (do first, 2 min): commit the approved mock into the repo

- [ ] Copy the session's approved mock HTML to `docs/superpowers/mocks/2026-08-11-coach-plan-rework.html`; commit — `docs: approved mock for the coach/plan rework`. (Tasks 7/8 reference it as the pixel guide.)

## Self-review notes (run before starting)

- Spec §1 guards ↔ Task 2 gate list — covered incl. reserve vs cutoff split (`ensureRead` uses cutoff).
- Spec §2 read-through ↔ Task 4. Spec §3 ↔ Task 3. Spec §4 ↔ Tasks 5–6. Spec §6 ↔ Task 7. Spec §7 ↔ Task 8. R1 ↔ Task 7 Step 5, Task 8 Step 4, Task 9 Step 3. R2 ↔ Tasks 2 (claim), 3 (lock), 4 (route), 9 Step 4 (smoke).
- Type names used across tasks: `PlanWeekResponse` (5→7), `PlanDetailResponse`/`PlanProgression` (6→7,8), `ReadResult`/`ensureRead` (2→4), `coachReads`/`coachLocks` (1→2,3). Consistent.
- Deletions checked for other consumers: `ManagePlans` (only plan.tsx), `StudioSection` (only plan.tsx), `.cal-day` CSS (only plan.tsx render), `idPrefix` (coach-panel + plan.tsx only).
