# The Watch Mirrors the Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scheduled session the watch can hold is on the COROS watch in its current version, automatically: pushed ahead of its day as a provisional copy, replaced on the day and on every later change, removed on skip/remove, honouring "Keep off my watch".

**Architecture:** A new `mirror` service owns the rule: it marks rows *mirror-owed* on cheap change paths (revise, adopt, move, un-skip, switch-on), and the drain or the hourly sweep makes a **provisional build record** (negative `session_builds.version`, `kind: "provisional"`, never locked) and queues a `program_session_push` with `provisional: true`, always preceded by the previous copy's delete. The executor's claim admits provisional pushes ahead of the day. On the day, the document build path compares steps and either hands over in D1 (same) or queues delete + push (different); every later day change replaces again. Skip unpushes. The UI's watch line becomes a status.

**Tech Stack:** TypeScript monorepo (pnpm): `apps/worker` (Hono on Cloudflare Workers, D1/drizzle, vitest + better-sqlite3, the mock COROS lane in `test/watch-push-fixture.ts`), `packages/domain`, `packages/database` (drizzle + SQL migrations), `packages/ui` (React, vitest/jsdom), `packages/api-client`.

**Spec:** `docs/superpowers/specs/2026-10-28-watch-mirrors-the-plan-design.md` (§3 decisions; §3.7 budgets; §10 owner answers). Builder check: `.superpowers/sdd/2026-10-27-workout-editability/mirror-builder-check.md` (A1–A9, M1–M7 — read it before Tasks 2, 4, 5, 9).

## Global Constraints

- Workers Free: ≤45 D1 statements per request; 50 subrequests per invocation (a COROS create ≈ 9 fetches; a push drain measures ≈31–34, an unpush 29) → **one watch job per invocation**; the sweep makes **one** record per run (≈10 statements) and is the hourly's one heavy step; 10 ms CPU.
- Lane invariants: no write without a stamp; deletes triple-addressed and re-proven at claim; **one copy per session** (the delete is queued before the push); writes off (`prefs.corosWritesEnabled` false) → nothing queued, cleanup still runs, owed unpushes recorded; done/completed/missed sessions keep their copy; the import never rewrites an app-authored row's content; `WATCH_PUSH_ENABLED` stays the global switch.
- The provisional record is **never locked** (`locked_at` null) and has a **negative version**; play, Start and check readers do not learn the marker; `pruneBuilds` spares it.
- The thread coach's own lane (`coach-apply.ts`, `coach_create_workout`/`coach_update_workout`, `push-absent.ts`) is NOT changed; hooks live in the shared services (`applyMove`, skip/unskip, `removeFromPlan`, `doc-workouts.ts`) and the sweep.
- Comparison on the day uses the would-be payload's `session.steps`, never `pushDigest`, never COROS's observed fingerprints.
- Public repo: invented ids/titles only; the fixture clock (`watch-push-fixture.ts` `DAY`/`NOON`) or `pinMiddayToday`; no hardcoded passing dates.
- Copy (verbatim): Settings row "Keep my watch in sync with the plan" / "Sessions go to your watch as the plan changes; COROS's own sessions stay yours."; status words "On your watch", "Updating your watch…", "Sending to your watch…", "Couldn't reach COROS — retrying", "Not on your watch: …", "Kept off your watch", buttons "Keep off my watch" / "Put on my watch" / "Retry".
- Tests run on the default node; `pnpm typecheck` and the touched suites before each commit; real exit codes; never bare `git stash`.

## Review Focus

1. A revision lands while a provisional push for the old revision is **claimed** by the lane: the old push verifies with the old content; the new provisional push must then replace it (delete old + push new), never leave two copies. → Task 3 test "a revision during a claimed push".
2. The day's build is made while the provisional push is still **queued** (never ran): the hand-over must supersede the queued provisional push and push the day build (no D1-only hand-over of a copy that isn't on the watch). → Task 5 test "day build before the provisional push ran".
3. The switch goes off, then on: nothing pushed while off; owed unpushes recorded; on switch-on the sweep catches up one per run, soonest first, with no duplicates. → Task 3 test "switch off then on".
4. A move onto **today** of a document workout whose check is already answered: pushes the day's gated build, not the provisional copy (M1). → Task 6 test "moved onto today".
5. The copy is deleted in the COROS app for a session still ahead: after two reads the address clears without the "Removed from your watch" note, and the sweep re-pushes once — no duplicate on a read in between. → Task 9 test "deleted on the watch, re-pushed once".

---

### Task 1: Schema and wire types — `watch_off`, `provisional`

**Files:**
- Create: `packages/database/migrations/0033_watch_off.sql` (`ALTER TABLE planned_workouts ADD watch_off integer NOT NULL DEFAULT 0;` in 0032's style)
- Modify: `packages/database/src/schema/schedule.ts` (`watchOff: integer("watch_off", { mode: "boolean" }).notNull().default(false)` after `watchCopyName`, doc comment "Kept off the watch by the athlete: the mirror makes no copy until cleared."), `packages/database/src/version.ts` (`"0033"`), `packages/domain/src/jobs.ts` (`programSessionPushJobSchema` gains `provisional: z.boolean().optional()`), `packages/api-client/src/index.ts` (`WorkoutDto.watchOff?: boolean`; `WatchStateDto` gains the new `state` values of Task 10: `updating | kept_off | closed_by_check`)
- Test: `packages/database` schema test (version), `packages/domain/test/jobs*.test.ts` (schema accepts `provisional`)

**Produces:** the column, the flag on the job payload, the DTO fields.

- [ ] Write the failing tests (version "0033"; `programSessionPushJobSchema.parse({..., provisional: true})` ok; without it ok). Run → FAIL. Implement. Run → PASS; `pnpm typecheck` 0.
- [ ] Commit `feat(db): planned_workouts.watch_off (0033); provisional flag on the program push job`.

---

### Task 2: The provisional build record and the "on the watch" readers (A1)

**Files:**
- Modify: `apps/worker/src/services/session-build.ts` (`storeBuild` ~:1247 — refuse to touch negative versions; `pruneBuilds` ~:991 — spare `version < 0`; `currentBuild` ~:717 and both `previous` finds ~:1065/~:1481 — ignore `version < 0`; `sentBuildIdOf` ~:1814 — consider negative-version records whose payload has `kind: "provisional"`, and **prefer the day's build** (version ≥ 1, dated the row's day) when both have a live push; new `export async function makeProvisionalRecord(db, userId, row: SlotRow, doc: WorkoutDoc, rev: number, ctx: BuildCtx): Promise<{ buildId: string; stored: StoredBuild }>` — materialises the document as the preview does (`materializeDocBuild` with checks `{}`), stores it at version `min(existing negative) − 1` (first −1) with `payload.kind = "provisional"` and `fromDoc.rev`, `lockedAt` null, never reuses or overwrites a record), `apps/worker/src/services/watch-push.ts` (`unlockSentBuild` ~:931 — for a provisional record clear `payload.kind` instead of unlocking; the owed-unpush write/read ~:913/~:954 — accept provisional records; `buildRefusal` ~:518 — a provisional record is sendable ahead of its day by the mirror path only, not by `sendToWatch`), `apps/worker/src/routes/plan.ts` (`sessionsOnWatch` ~:677 — a verified `push:<provisionalId>` counts as on the watch), `apps/worker/src/services/session-watch-review.ts` (~:314, ~:526 — the quick review reads the sent record via `sentBuildIdOf`, provisional included), `apps/worker/src/services/key-result-measures.ts` (~:548 likewise)
- Test: `apps/worker/test/session-build.test.ts` (new describe "provisional records"), `apps/worker/test/watch-push-builds.test.ts`

**Interfaces:**
- Produces: `makeProvisionalRecord(...)` as above; `isProvisionalBuild(row: BuildRow): boolean` (exported from session-build.ts); `sentBuildIdOf` semantics: the day's locked build with a live push wins, else a provisional record with a live push.

- [ ] Failing tests: "a provisional record has version −1, then −2, never locked, carries fromDoc.rev and kind"; "pruneBuilds spares it"; "currentBuild, POST /build and the sheet's preview ignore it (a day build is still made)"; "sentBuildIdOf answers the provisional record when only its push is live, and the day build when both are"; "unlockSentBuild on a provisional record clears its kind, leaves locked_at null"; "sessionsOnWatch counts a verified provisional push".
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run session-build watch-push-builds today-watch`); typecheck 0.
- [ ] Commit `feat(watch): a provisional build record — negative version, never locked, seen only by the on-the-watch readers`.

---

### Task 3: The mirror service — owed marks, provisional pushes, the current-copy test, the sweep

**Files:**
- Create: `apps/worker/src/services/mirror.ts`
- Modify: `apps/worker/src/services/watch-push.ts` (`pushPayloadFor` ~:636 — accept a provisional record; the inserted job carries `provisional: true`), `apps/worker/src/services/plan-mutations.ts` (`enqueueUnpushIfOurs` — also used by the mirror for the previous copy)
- Test: `apps/worker/test/mirror.test.ts` (new; use `watch-push-fixture.ts`: `seedSlot`, `connectMock`, `switchOn`, `counting`)

**Interfaces:**
- Consumes: Task 2's `makeProvisionalRecord`, `sentBuildIdOf`; `programStamp`, `takenStampsOn`, `watchStepsFromBuild`, `pushJobId`; `unpushBuild` / `adoptedCopyUnpush` / `enqueueUnpushIfOurs`.
- Produces (all in `mirror.ts`):
  - `MIRROR_WINDOW_DAYS = 28`; `MIRROR_RETRY_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000]` (M3; a 4th failure stops);
  - `export async function markMirrorOwed(db, userId, workoutId, now): Promise<void>` — one INSERT into the existing `sync_intents` table, `kind: "mirror"`, `id = \`mirror-${workoutId}\``, `onConflictDoNothing` (idempotent); the sweep and the drain consume open mirror intents first (soonest day), then the window scan; `queueProvisionalPush` resolves the intent; `coros_sync_state` is not touched;
  - `export async function queueProvisionalPush(db, env, userId, row, ctx): Promise<"queued" | "skipped:<reason>">` — reasons `writes_off | switch_off | kept_off | not_document | resolved | past | beyond_window | too_long | current`; makes the record, queues the previous copy's delete (via `enqueueUnpushIfOurs`, which already does `adoptedCopyUnpush` / `enqueueProgramUnpush`), inserts `push:<provisionalId>` with `provisional: true`, resolves the mirror intent; ≤ 12 statements;
  - `export function currentCopy(row, pushes: PushRow[], today): boolean` — pure (A7): a non-settled push for this `fromDoc.rev` **and** `happenDay === row.effectiveDate` that is in flight, or verified with `watchAddressOf(row)` non-null; a copy the row followed in COROS (its stamp's date ≠ the row's day but the address holds) counts;
  - `export async function mirrorSweep(db, env, userId, prefs, ctx, opts: { cap: 1 }): Promise<{ queued: number; skipped: Record<string, number> }>` — scheduled, not archived, document-origin rows in [today, today+28], not kept off, oldest day first, with `!currentCopy(...)`; queues one; a failed push is re-queued per the backoff (reads the failed job's `updatedAt`); with writes off returns `skipped.writes_off` and queues nothing.
- `skipped:current` is the normal answer for most rows.

- [ ] Failing tests: "queueProvisionalPush makes a −1 record, the previous copy's delete first, then the push with provisional:true and the title — day stamp"; "a second revision makes −2 and deletes the −1 copy"; "writes off: nothing queued, no record"; "kept off: skipped:kept_off"; "a revision during a claimed push: after the old push verifies, the sweep sees !currentCopy (rev mismatch) and queues delete + new push — one copy at the end" (Review Focus 1, drive the lane); "currentCopy: same rev other day → false (a move); verified but address cleared → false (absence); copy moved in COROS → true"; "mirrorSweep queues exactly one, soonest first, within the window, skips beyond +28, skips resolved/rest/race/engine/kept-off"; "failed push re-queued after the first backoff, not before; stops after three" ; "switch off then on" (Review Focus 3).
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run mirror watch-push-lane watch-push-budget`); the statement count of `queueProvisionalPush` pinned (≤ 12) and of the sweep (≤ 15 for one record); typecheck 0.
- [ ] Commit `feat(watch): the mirror — provisional pushes, the current-copy rule, the sweep`.

---

### Task 4: The executor's claim admits provisional pushes (A2) and the import's job-verify excludes mirror jobs (M7)

**Files:**
- Modify: `apps/worker/src/services/coros-write-cloud.ts` (the `program_session_push` claim ~:607–642: `happenDay !== today` → `!provisional && happenDay !== today` plus `provisional && happenDay < today`; skip `gatedAtClaim` when provisional; supersede when the row's `watch_off` is set; the supersede branch calls `unlockSentBuild` which now clears a provisional record's marker (Task 2)), `apps/worker/src/services/import-plan.ts` (~:506 `pendingJobByWorkout`: exclude `program_session_push` and `unpush:`/`-unpush-copy` deletes of app-authored rows from the generic verify path)
- Test: `apps/worker/test/watch-push-claim-checks.test.ts` (the pin "a push for another day is superseded" becomes "a day gone, or not provisional"), `apps/worker/test/watch-push-import.test.ts` or `import-adopted.test.ts` (M7)

- [ ] Failing tests: "a provisional push for tomorrow is claimed and verifies; the row gets the address"; "a provisional push for yesterday is superseded"; "a non-provisional push for tomorrow is still superseded"; "gatedAtClaim is not consulted for a provisional push" (a profile with no check today); "kept off at claim → superseded, the record's marker cleared"; "M7: a COROS-side move onto a queued mirror push's day does not verify it".
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run watch-push-claim-checks watch-push-lane import`); typecheck 0.
- [ ] Commit `feat(watch): the lane takes a provisional push ahead of its day; the import never verifies a mirror job by sight`.

---

### Task 5: On the day — hand-over, replace, replace again (A3, §3.3)

**Files:**
- Modify: `apps/worker/src/services/session-build.ts` (`commitDocBuild` ~:1510 and the engine day-build commit: after a **day build** (version ≥ 1, dated today) is stored and the slot's checks are answered, call `mirrorOnDayBuild`), `apps/worker/src/services/mirror.ts` (add `export async function mirrorOnDayBuild(db, env, userId, row, dayBuild: BuildRow, ctx): Promise<"handed_over" | "replacing" | "blocked" | "pushing" | "skipped:<reason>">`)
- Test: `apps/worker/test/mirror-day.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 (`sentBuildIdOf`, provisional records), Task 3 (`queueProvisionalPush`'s delete-then-push helpers — factor `queueReplacement(db, env, userId, row, newBuildId, ctx)`), `watchStepsFromBuild`, `lockCurrentBuild`'s lock write (`lockProven` ~:1570).
- Rule: `sent = sentBuildIdOf(row)`; if none → push the day build (engine slots and documents alike) once checks are answered; if the sent one is a provisional record: compare `watchStepsFromBuild(day).steps` with `watchStepsFromBuild(provisional).steps` (normalised: name, side, target type/value, grams, rest) — **same** → lock the day build, insert `push:<dayBuildId>` as `verified` copying the provisional push's `name`, `happenDay`, `observed`, `renamed`, then clear the provisional marker and mark its push `superseded` (≤ 5 statements, no COROS fetch); **different** → `queueReplacement` (delete old, push day build, lock it); the provisional push still **queued** (never ran) → supersede it and push the day build (Review Focus 2); a **blocked** day build (`gated.blocked` non-empty) → `"blocked"`, nothing queued. A later day build (new version after a change: a reading swap, length, place, mode, revision) with a sent day build → compare again → `queueReplacement` when different (§3.3 "every later change").

- [ ] Failing tests: "same steps → hand-over: day build locked, verified push:<day> carries the stamp, provisional push superseded, zero COROS fetches"; "different steps (a gated swap) → delete + push queued, day build locked"; "blocked → stays, nothing queued"; "engine slot built and checked → pushed"; "day build before the provisional push ran → the queued push is superseded, the day build pushed" (Review Focus 2); "a later change on the day → replaced again (two jobs)"; "a day build with the check unanswered → skipped:precheck, nothing queued".
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run mirror-day session-build watch-push-lifecycle`); typecheck 0.
- [ ] Commit `feat(watch): on the day the copy is handed over or replaced, and replaced on every later change`.

---

### Task 6: The hooks — revise/adopt, move, skip/un-skip, remove, switch-on, today's push

**Files:**
- Modify: `apps/worker/src/services/doc-workouts.ts` (`reviseDocWorkout` and `createDocWorkout`: after the write, `markMirrorOwed` + the previous copy's delete via `enqueueUnpushIfOurs` — the adoption's held copy included), `apps/worker/src/services/jobs.ts` (`applyMove` ~:129: for an app-authored document row, the old copy's delete (`enqueueUnpushIfOurs`) + `markMirrorOwed` for the new day; `content_state` outline unchanged; for a move onto **today** with the check answered the drain pushes the day build (M1) — i.e. `queueProvisionalPush` answers `skipped:today_checked` and `mirrorOnDayBuild` runs on the next build), `apps/worker/src/services/plan-mutations.ts` (new `export async function skipWorkout(db, userId, workoutId, opts: { now; today; source: "app" | "coach"; sanctionedBy? }): Promise<{ skipped: boolean }>` doing the UPDATE both writers do today (`routes/plan.ts:1640`, `coach-apply.ts:1512` — the coach's call site changes only to call it, which is not a redesign of its lane) **plus** `enqueueUnpushIfOurs` for an app-authored row's copy; `unskipWorkout` ~:330 gains `markMirrorOwed` when the day is today or ahead), `apps/worker/src/routes/misc.ts` (~:1457 switch-on: `emitPendingWork` + the sweep runs on the next hourly/drain — nothing else), `apps/worker/src/services/design-approve.ts` (the revise op's approve already calls `reviseDocWorkout` — no change beyond the statement count comment if `markMirrorOwed` adds one: `REVISE_BASE` +1)
- Test: `apps/worker/test/mirror-hooks.test.ts` (new), `apps/worker/test/app-authored-moves.test.ts`, `doc-workouts-adopt.test.ts`, `plan-mutations.test.ts`

- [ ] Failing tests: "a Studio add for a day ahead → mirror-owed; the drain queues the provisional push"; "a revise → old copy's delete + owed; adoption → held copy's delete (`<id>-unpush-copy`) + owed"; "a move to another day → delete + owed for the new day, document kept, content_state outline"; "moved onto today with the check answered → the day build is pushed, no provisional" (Review Focus 4); "skip ahead of the day → unpush queued; un-skip → owed → push again"; "the coach's skip (coach-apply) goes through skipWorkout and unpushes"; "remove → unpush (unchanged)"; "writes off: every hook queues nothing but records owed"; "REVISE_BASE still ≤ 45 with the owed mark".
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run mirror-hooks app-authored-moves doc-workouts plan-mutations coach-apply design-approve`); typecheck 0.
- [ ] Commit `feat(watch): revise, adopt, move, skip and un-skip keep the watch in step`.

---

### Task 7: Keep off / Put on; Leave and Keep under the mirror (A8)

**Files:**
- Modify: `apps/worker/src/routes/sessions.ts` (`POST /:workoutId/take-off-watch` ~:329 becomes the mechanism behind new `POST /:workoutId/keep-off-watch` (take off + `watch_off = 1`) and `POST /:workoutId/put-on-watch` (`watch_off = 0` + `markMirrorOwed`); keep the old path answering as keep-off for one release), `apps/worker/src/services/watch-version.ts` (`leaveWatchVersion` ~:181: app rows → 409 `gone` (the mirror replaces copies); existing LEFT marks ignored by `watchEarlierVersions`; `keepWatchVersion` unchanged for coach rows), `apps/worker/src/services/watch-version-send.ts` (`cant_rewrite` for app rows → `mirrored`), `apps/worker/src/services/coros-write-cloud.ts` (a verified mirror push resolves the row's open content claims — one UPDATE), `packages/api-client/src/index.ts` (`keepOffWatch`, `putOnWatch`)
- Test: `apps/worker/test/watch-push-routes.test.ts`, `watch-version-routes.test.ts`, `watch-version-count.test.ts`

- [ ] Failing tests: "keep-off takes the copy off and sets watch_off; the sweep and the drain skip the row; put-on clears it and the push comes back"; "keep-off refused on a done session (409 done)"; "leave on an app row → 409 gone; the account line no longer counts LEFT marks"; "a verified mirror push closes the row's open content claim (no lingering 'Older on watch')".
- [ ] Run → FAIL. Implement. Run → PASS; typecheck 0.
- [ ] Commit `feat(watch): Keep off my watch / Put on my watch; Leave retires for mirrored rows`.

---

### Task 8: Drains and the hourly — one job per invocation, chained from the client, the sweep as the heavy step (A5)

**Files:**
- Modify: `apps/worker/src/services/jobs.ts` (`claimNextJob` ~:341 `watchOnly`: also `program_session_push` with `provisional` and the `-unpush-copy` deletes), `apps/worker/src/routes/sessions.ts` (`/watch/drain` ~:366 answers `{ ran, pending }` where `pending` is the count of watch jobs still queued for the account — one COUNT), `apps/worker/src/index.ts` (the hourly ~:433–459: after reconcile, when no heavy step ran, run `mirrorSweep(..., { cap: 1 })` as the heavy step `"mirror"`; the existing single-job drain stays), `packages/api-client/src/index.ts` (`drainedWatch` ~:2449 → `drainWatchUntilIdle(max = 6)`: calls `/watch/drain` while `pending > 0`, at most `max` calls), `packages/ui` (the sheet and Today call `drainWatchUntilIdle` after any action that queues a watch job, and on open when the row's state is `updating`)
- Test: `apps/worker/test/hourly-budget.test.ts` (the sweep's statements as a heavy step; still one job), `watch-push-routes.test.ts` (`pending`), `packages/ui/test/watch-drain-client.test.ts`

- [ ] Failing tests: "drain answers pending=N and runs one"; "the client chains up to 6 drains and stops at pending=0 or an error"; "the hourly runs the sweep only when no other heavy step ran, and still drains one job"; "two mirror jobs never run in one invocation".
- [ ] Run → FAIL. Implement. Run → PASS; typecheck 0.
- [ ] Commit `feat(watch): one watch job per request, chained drains from the app, the sweep as the hourly's heavy step`.

---

### Task 9: Import — re-push after absence, no note when the sweep will push (§3.8)

**Files:**
- Modify: `apps/worker/src/services/import-plan.ts` (rule 8 ~:1493–1524: for a document row still ahead and not kept off, clear the address as today but skip the `watch_copy_removed` note and leave the push `verified` — the sweep's `currentCopy` (address cleared → false) re-pushes; "Changed in COROS" (~:1264–1289): the note stays, and the observation marks the row mirror-owed (`markMirrorOwed`) so the sweep replaces the copy on its next pass)
- Test: `apps/worker/test/watch-push-import.test.ts`, `mirror.test.ts`

- [ ] Failing tests: "deleted on the watch, re-pushed once: two reads clear the address without the note; the sweep queues one push; a read between queues nothing more" (Review Focus 5); "changed in COROS → one note, the row owed, the sweep replaces".
- [ ] Run → FAIL. Implement. Run → PASS (`npx vitest run watch-push-import mirror import`); typecheck 0.
- [ ] Commit `feat(import): a mirrored copy that goes missing or changes on the watch is put back by the sweep`.

---

### Task 10: The UI — status line, Today, pill, account line, Settings (§3.9)

**Files:**
- Modify: `apps/worker/src/services/watch-push.ts` (`watchStateOf` ~:588: states `on_watch | updating | sending | failed (retry) | unavailable (reason) | kept_off | closed_by_check` — `updating` when a mirror job (push or delete) is queued/claimed for the row), `apps/worker/src/routes/plan.ts` (`deriveWorkoutSync`/`syncAction` ~:442–470: the pill from the queued job, not `coros_sync_state`), `apps/worker/src/services/sync-status.ts` (`contentStaleSessions` → `watchUpdatingSessions` count), `packages/ui/src/components/session-sheet.tsx` (~:691–740 the watch line → status + Retry / Keep off / Put on; the `WatchVersion` at ~:868 removed for app rows; the preview behind "What's on your watch"), `packages/ui/src/components/watch-version.tsx` (app-row branches removed; coach-row Keep stays via `screens/plan.tsx:381`), `packages/ui/src/components/today-program.tsx` (~:213 unchanged wording; shows for provisional via Task 2), `packages/ui/src/components.tsx` (`COROS_PILL` ~:303 words; the account line ~:732 → "N sessions updating on your watch" / nothing), `packages/ui/src/screens/settings.tsx` (~:1227–1245 the row's two lines), `packages/api-client/src/index.ts` (types)
- Test: `packages/ui/test/session-sheet.test.tsx` (the pin "a day ahead: no pre-check, a preview, no Start" stays + the status line), `watch-version-live.test.tsx`, `sync-status-line.test.tsx`, `shape-settings.test.tsx` (the row's words), `today-program.test.tsx`

- [ ] Failing tests per state word (verbatim), the buttons, the Settings wording, the account line, the pill.
- [ ] Run → FAIL. Implement. Run → PASS (`cd packages/ui && npx vitest run session-sheet watch-version sync-status shape-settings today`); typecheck 0.
- [ ] Commit `feat(ui): the watch line is a status; Keep off / Put on; Settings says the watch stays in sync`.

---

### Task 11: Old pins rewritten, whole-system check, runbook

- [ ] Rewrite (not delete) the pins the recon lists: `watch-push-routes.test.ts:156` (`not_today` for Send stays — Send is now only the mirror's internal path; keep the route for Retry), `watch-push-claim-checks.test.ts:79–98` (Task 4), `session-sheet.test.tsx:691` (Task 10); confirm `T/watch-push-budget`, `watch-push-lane` (≤45 fetches for 3 pushes), `doc-workout-budget`, `coach-approve-budget` still pass.
- [ ] `pnpm typecheck && cd apps/worker && npx vitest run && cd ../../packages/ui && npx vitest run && cd ../domain && npx vitest run` → all exit 0.
- [ ] Runbook (append to the ledger): deploy = push to main (migration 0033 applied by Deploy); live verification on the owner's watch per spec §6: add a Studio workout for a day ahead → "Updating your watch…" → on the watch after the drain; revise → replaced; move → moved; skip → gone, un-skip → back; Keep off → gone and stays; on the day with a gating swap → replaced; a same-day change → replaced again. Read-only D1 checks only.
