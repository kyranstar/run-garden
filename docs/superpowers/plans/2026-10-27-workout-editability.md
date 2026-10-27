# Workout Editability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any planned workout can be revised by the coach and in the Studio unless there is a clear reason; every reason carries a path forward; the coach reads revisability before drafting; a fit run that ends without a proposal releases its batch.

**Architecture:** One predicate (`revisability`, `@rg/domain`) replaces every scattered `docOriginRow` editability gate. A revise of a non-app-authored row *adopts* it into a Studio document workout inside the existing atomic revise write (origin → `studio`, stage rows and watch-shaped content columns cleared, the old watch copy's name recorded in a new `planned_workouts.watch_copy_name` column). The copy on the watch stays, marked older, and is taken off by the Studio's Send (delete-then-push), Remove, and a plan archive; the import claims it for the adopted row until it is gone. Reads expose `revisable`; refusals carry `instead`; the run-end write, cancel and the expiry sweep release a fit's batch.

**Tech Stack:** TypeScript monorepo (pnpm): `apps/worker` (Hono on Cloudflare Workers, D1 via drizzle, vitest on better-sqlite3), `packages/domain`, `packages/database` (drizzle schema + SQL migrations), `packages/ui` (React, vitest/jsdom), `packages/api-client`.

**Spec:** `docs/superpowers/specs/2026-10-27-workout-editability-design.md` (the design; its §3 table holds the exact strings, §4 the watch rules, §10 the owner's answers). Builder check: `.superpowers/sdd/2026-10-26-saves-flow-redesign/editability-builder-check.md`.

## Global Constraints

- Workers Free plan: ≤45 D1 statements per request; the adoption adds to the revise batch only the stage-row delete and the column writes already in the UPDATE; `REVISE_BASE` (`design-approve.ts:458`) is raised by exactly the statements added (M7).
- Public repo: no production facts in fixtures — no plan name, no real session titles, no row census (M9). Invented ids and titles only.
- The thread coach's apply path (`coach-apply.ts` `sessionRowInsert`, `createSession`, the plan-week writers) is NOT changed: it keeps writing NULL-origin rows; adoption is lazy.
- `docOriginRow` / `DOC_ORIGINS` / `appAuthoredRow` keep their meaning and their test (`packages/domain/test/app-authored.test.ts` stays green unchanged).
- `revisability`'s strings are the spec §3 table's, verbatim; refusals and reads use them, never a paraphrase.
- Tests run on the default node (vitest + better-sqlite3); wrangler only on node 22. Never bare `git stash`. Run `pnpm typecheck` and the touched packages' vitest before each commit; report real exit codes.
- Date-sensitive tests pin "today" (`pinMiddayToday` in `apps/worker/test/helpers.ts`); never hardcode a calendar date that will pass.

## Review Focus

1. A NULL-origin row revised while its coach create job is already claimed by the lane: the create lands the OLD session on the watch and writes its address onto the adopted row; the row must still read older-on-watch and the adopted document must not be touched. → Task 4 test "a claimed create counts as being sent".
2. The next import read after adopting a COROS-plan row: no duplicate row, no `planned_workouts_source_unique` collision, the wire workout claimed by the adopted row; once the wire no longer holds it, `watch_copy_name` cleared. → Task 5 tests.
3. `plan-repair`'s rename of an adopted row keeps its document (the row is now a doc origin). → Task 3 test "a rename after adoption keeps the document".
4. A fit run cancelled (or expired by the sweep) before it proposes: the batch comes back at once. → Task 8 tests.
5. The Studio's session sheet on a coach session (`cw-`, NULL origin) shows Edit; saving adopts it; a programme session's 409 carries `cause` and `instead`. → Task 9 tests; Task 3 route test.

---

### Task 1: The predicate — `revisability` in `@rg/domain`

**Files:**
- Create: `packages/domain/src/revisability.ts`
- Modify: `packages/domain/src/index.ts` (export it)
- Test: `packages/domain/test/revisability.test.ts`

**Interfaces:**
- Consumes: `DOC_ORIGINS`, `APP_AUTHORED_ORIGINS` from `./watch-address.js`.
- Produces:
  ```ts
  export type RevisabilityReason = "programme" | "resolved" | "under_way" | "run" | "rest" | "race" | "past";
  export interface RevisabilityInput {
    origin: string | null; category: string | null; sport: string | null;
    completionState: string | null; contentState: string | null;
    effectiveDate: string; archived?: boolean; hasDoc: boolean; isRun: boolean | null; // isRun: from the document; null with none
  }
  export type Revisability =
    | { ok: true; adopts: boolean }                         // adopts: origin is not app-authored
    | { ok: false; reason: RevisabilityReason; why: string; instead: string };
  export function revisability(row: RevisabilityInput, today: string): Revisability;
  export const REVISABILITY_WORDS: Record<RevisabilityReason, { why: string | ((state: string) => string); instead: string }>;
  ```
  Order of checks: past → resolved → under_way → race → rest → programme → run → ok. `resolved`'s `why` is per state: "It's already done." / "It was skipped." / "It was missed.". `run` = `isRun === true`, or with no document `sport === "run"` or `category` in `recovery|easy|long|quality`. `programme` = origin `program` or `on_demand`. `adopts` = `!APP_AUTHORED_ORIGINS.includes(origin)`.

- [ ] **Step 1: Write the failing tests** — one `it` per reason with the spec §3 strings exact; `adopts` true for `null` and `"coros"` origins, false for `studio`/`template`; a NULL-origin row with no document and `sport: "run"` → `run`; `category: "race"` beats `programme`; a `past` row that is also `completed` → `past`.
- [ ] **Step 2: Run** `pnpm --filter @rg/domain test -- revisability` → FAIL (module missing).
- [ ] **Step 3: Implement** `revisability.ts` with the table as data (`REVISABILITY_WORDS`), export from `index.ts`.
- [ ] **Step 4: Run** the test → PASS; `pnpm --filter @rg/domain test` all green; `pnpm typecheck` exit 0.
- [ ] **Step 5: Commit** `feat(domain): revisability — one predicate for which workouts can be revised, with why and instead`.

---

### Task 2: Schema — `planned_workouts.watch_copy_name`

**Files:**
- Create: `packages/database/migrations/0032_watch_copy_name.sql`
- Modify: `packages/database/src/schema/schedule.ts` (planned_workouts), `packages/database/src/version.ts` (`SCHEMA_VERSION = "0032"`), drizzle meta if the repo keeps a journal (follow `0031_saves_flow.sql`'s pattern exactly).
- Test: the existing schema-version test (find it: `grep -rn SCHEMA_VERSION apps/worker/test packages/database/test`), updated to "0032".

**Produces:** column `watchCopyName: text("watch_copy_name")` — "the program name the watch holds a copy of this row under when the app did not push that copy (set at adoption; cleared when the copy is gone)". Nullable, no index.

- [ ] **Step 1:** Write the migration (`ALTER TABLE planned_workouts ADD COLUMN watch_copy_name TEXT;`) and the schema column; bump the version.
- [ ] **Step 2: Run** `pnpm typecheck` and the worker's migration/schema test (`pnpm --filter worker test -- schema`) → PASS.
- [ ] **Step 3: Commit** `feat(db): planned_workouts.watch_copy_name (0032)`.

---

### Task 3: Adoption — `reviseDocWorkout` revises any revisable row

**Files:**
- Modify: `apps/worker/src/services/doc-workouts.ts` (`reviseDocWorkout` ~590–692, `watchHoldsOlder` ~574, `NotEditableError`), `apps/worker/src/routes/workouts.ts:89` (409 body), `apps/worker/src/services/design-approve.ts:458` (`REVISE_BASE`).
- Test: `apps/worker/test/doc-workouts.test.ts` (the `not_editable` block at 572–644 is rewritten to the new rule), new `apps/worker/test/doc-workouts-adopt.test.ts`.

**Interfaces:**
- Consumes: `revisability` (Task 1); `watchCopyName` (Task 2); `recordedStampFor(db, userId, workoutId)` (`coros-stamp.ts:267`); `sentBuildIdOf`.
- Produces:
  - `NotEditableError` gains `reason: RevisabilityReason`, `why`, `instead` (constructor `(r: Extract<Revisability, {ok:false}>)`); `PUT /api/workouts/:id/doc` answers `409 { error: "not_editable", cause: reason, why, instead }`.
  - `reviseDocWorkout` on an adoptable row writes, in the same UPDATE: `origin = 'studio'`, `structuredJson = null`, `stageSummary = null`, `expectedDistanceMeters = null`, `qualitySubtype = null`, `sourceEstimatedDurationSeconds = null`, `durationEstimate = null`, `sourceVersion = null`, `sourceContentFingerprint = <as createDocWorkout>`, `watchCopyName = <name>`; and adds to the batch `delete from planned_workout_stages where workout_id = ?`. `<name>`: `recordedStampFor(...)` when it answers (a coach row), else the row's `title` when `watchAddressOf(row)` is non-null (an imported row), else null. `planId` untouched.
  - The SQL guard replaces `inArray(origin, DOC_ORIGINS)` with `or(isNull(origin), notInArray(origin, ["program","on_demand"]))` (M2) and keeps the rev/frozen/locked guards; the pre-check uses `revisability` (so `past`, `rest`, `race`, `run`-without-doc refuse before the document is judged; a run DOCUMENT still throws `RunUnsupportedError` from `validated`).
  - `watchHoldsOlder(db, workoutId, rev)` is true also when the row's `watchCopyName` is set, or a `coach_create_workout` job for the row is in flight (`claimed|in_progress|verifying`).
  - `REVISE_BASE` += 1 (the stage delete).

- [ ] **Step 1: Failing tests** (`doc-workouts-adopt.test.ts`, seeded with `db.insert(plannedWorkouts)` + `plannedWorkoutStages` rows, invented ids like `cw-test-1-0`): "a coach session with stages and a synced copy is adopted" (origin studio, stages 0, structured/stage summary/estimates null, planId kept, address columns kept, rev 1→2 or 0→1, `watchHasOlder: true`, `watchCopyName` = the stamp from a seeded verified `coach_create_workout` job's payload name); "an imported watch-plan session is adopted with its wire title as the copy's name"; "a NULL-origin row with no document revises from rev 0"; "a programme session: 409 not_editable cause programme with the spec's why and instead"; "rest / race / a run with no document: 409 with their reasons"; "the NULL guard: a row whose origin is NULL passes the SQL guard" (M2); "a rename after adoption keeps the document" (call the plan-repair rename path on the adopted row; document unchanged). Rewrite the 572–644 block: completed → cause `resolved`, started → `under_way`, `origin = 'program'` → `programme`, each with `why`/`instead` in the body.
- [ ] **Step 2: Run** `pnpm --filter worker test -- doc-workouts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces. The adoption columns are computed once before the batch; the stage delete is a statement in the same `runAtomically` batch, after the UPDATE.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck` 0.
- [ ] **Step 5: Commit** `feat(studio): a revise adopts any revisable workout — coach and watch-plan sessions become Studio documents`.

---

### Task 4: The old copy on the watch — Send replaces it; Remove and a plan archive take it off

**Files:**
- Modify: `apps/worker/src/services/watch-push.ts` (`sendToWatch` ~745–878), `apps/worker/src/services/plan-mutations.ts` (`enqueueUnpushIfOurs` ~174, `unpushInsertIfOurs` ~202), `apps/worker/src/services/coros-write-cloud.ts` (the `coach_delete_workout` branch ~995: on verified, clear `watchCopyName` when `spec.name` equals it), `apps/worker/src/services/coach-apply.ts` `archiveStep` ~2505–2540 (uses `enqueueUnpushIfOurs` for app-authored rows: no change needed if 4b below lives in `plan-mutations`; verify).
- Test: `apps/worker/test/watch-push-adopted.test.ts` (new; use `watch-push-fixture.ts`'s `seedSlot`/`buildToday`/`connectMock` patterns).

**Interfaces:**
- Consumes: `watchCopyName`; `coachDeleteWorkoutJobSchema` payload `{ workoutId, happenDay, name, idInPlan, programId, corosPlanId }`; `watchAddressOf(row)`.
- Produces:
  - `plan-mutations.ts`: `export function adoptedCopyUnpush(db, userId, row, now, prefs): { insert } | null` — for an app-authored row with `watchCopyName` and a watch address: a `coach_delete_workout` job `id = \`${row.id}-unpush-copy\``, payload from the address + `name: row.watchCopyName`; null with writes off, no address or no name. `enqueueUnpushIfOurs` runs it (in addition to its sent-build path) so Remove, Stop this plan and a week re-plan take the copy off.
  - `sendToWatch`: before inserting the `program_session_push`, when the row has `watchCopyName`, insert the `adoptedCopyUnpush` job in the same request (two statements; the lane serialises: delete lands first). Nothing else about Send changes (still today-only).
  - `coros-write-cloud.ts`: a verified `coach_delete_workout` whose `spec.name === row.watchCopyName` sets `watchCopyName = null` on the row (alongside what it writes today).
  - A claimed `coach_create_workout` for an app-authored row: already superseded at claim (A2); when it was claimed BEFORE adoption and verifies after, it writes the address as today — `watchHoldsOlder` reads the in-flight job (Task 3) and, on verify, the executor sets `watchCopyName = spec.name` when the row is app-authored and `watchCopyName` is null (M8).

- [ ] **Step 1: Failing tests:** "Send on the day queues the old copy's delete before the push" (job ids and order by `requestedAt`/insert order; payload name = `watchCopyName`); "Remove queues the old copy's delete"; "a plan archive (Stop this plan) queues it"; "a verified delete clears watch_copy_name"; "a claimed create counts as being sent" (Review Focus 1: seed a claimed `coach_create_workout`, adopt, `watchHasOlder` true; run the lane's verify → `watchCopyName` set, document untouched).
- [ ] **Step 2: Run** `pnpm --filter worker test -- watch-push-adopted` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; the whole `watch-push-*` and `plan-*` suites green; `pnpm typecheck` 0.
- [ ] **Step 5: Commit** `feat(watch): an adopted workout's old copy is replaced by Send and taken off by Remove and a plan archive`.

---

### Task 5: The import keeps the old copy attached to the adopted row

**Files:**
- Modify: `apps/worker/src/services/import-plan.ts` (claimants ~786–794; the "New workout from COROS" branch ~1001; the per-row update of a claimed app-authored row).
- Test: `apps/worker/test/import-adopted.test.ts` (new; use `import-probes.ts` / `watch-push-import.test.ts` patterns for a fake wire snapshot).

**Interfaces:**
- Consumes: `watchCopyName`, `existingByAddress`, `verifiedPushOf`.
- Produces: in `claimants`, an app-authored row also claims a wire workout at its address when `w.watchCopyName === src.title` (beside the verified-push claim). A claimed adopted row is "unchanged" (no content rewrite, no title rewrite — app-authored rules already skip them; assert). When a read shows no wire workout at an adopted row's address under `watchCopyName` (and no delete job for it is in flight), the read sets `watchCopyName = null` (one UPDATE in the read's write batch, bounded: rows the read touched).

- [ ] **Step 1: Failing tests** (Review Focus 2): "an adopted watch-plan row claims its wire workout: no new row, no unique collision, stats.unchanged +1"; "an adopted coach row claims its copy: no duplicate"; "the copy gone from the wire: watch_copy_name cleared"; "the copy renamed in the COROS app is not claimed" (document the limit: it reads as a new workout, as today for a renamed coach copy).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; all `import-*`, `*-import.test.ts`, `provenance-*` suites green; typecheck 0.
- [ ] **Step 5: Commit** `feat(import): a wire workout at an adopted row's address is the row's old copy, until it is gone`.

---

### Task 6: The coach's gates use the predicate; refusals carry `instead`

**Files:**
- Modify: `apps/worker/src/services/design-tools/propose.ts` (`whyNotEditable` ~732 → `revisability`; the refusal at ~469: `refuse("not_editable", r.why, r.instead)`; `past` → `refuse("past_date", …)`, `run` → `refuse("run_unsupported", …)` where those codes exist today), `apps/worker/src/services/design-approve.ts` (`NotEditableCause` = `RevisabilityReason | "unknown"`; `notEditableCause` and `NOT_EDITABLE_WHY` → from `REVISABILITY_WORDS`; ~957–964 and ~1627 use the reason; the refusal object gains `instead`), `apps/worker/src/services/design-tools/adjust-plan.ts` (~231–236, ~264–269: `revise_instead` applies to any revisable row (`revisability(...).ok`), `programme_session` to `programme`; strings from the table), `apps/worker/src/services/design-tools/act-common.ts` if the refusal type lives there.
- Test: `apps/worker/test/design-act-tools.test.ts:657–663`, `design-approve.test.ts:399–417`, `design-plan-adjust.test.ts` (:460, :586, :591, :689), `design-plan-powers.test.ts` (:316, :339), `design-plan-adjust-routes.test.ts:241` — updated to the table; new cases: "propose_workout revise of a NULL-origin coach session is accepted" and "approve adopts it" (`design-approve` applier revise → row origin studio).

- [ ] **Step 1: Failing tests** — update the pinned strings; add the two new cases.
- [ ] **Step 2: Run** `pnpm --filter worker test -- design-act-tools design-approve design-plan` → FAIL.
- [ ] **Step 3: Implement.** The `cause` on the wire keeps its name; its values are the reasons (`resolved` replaces completed/skipped/missed).
- [ ] **Step 4: Run** → PASS; typecheck 0.
- [ ] **Step 5: Commit** `feat(coach): editability gates share one predicate; every not_editable names what to do instead`.

---

### Task 7: The coach reads revisability first

**Files:**
- Modify: `apps/worker/src/services/design-tools/read-plan.ts` (`planTerm` SQL adds `'content'` (already), `'doc', (workout_doc is not null)`, `'archived'`…; `planItem` adds `revisable` beside `rev`; `ORIGIN_WORDS`: a NULL origin with a `cw-` id → "coach session", with a watch address → "watch plan session"), `read-workouts.ts` (list ~132–150 and get ~380–399 add `revisable`), `read-plans.ts:202`, `design-context.ts` (`planItemWords` ~728–746: append ", revisable" or ", <reason>: <instead>" short form; `ORIGIN_WORDS` ~710 gains the two NULL-origin words).
- Test: the existing read-tool tests (`design-read-tools*.test.ts`, `design-context*.test.ts` — find by `grep -rln "read_plan\|planItemWords" apps/worker/test`) gain: "a coach session reads revisable: true and origin 'coach session'"; "a programme session reads revisable: { no, instead }"; "get_workout on a resolved row reads revisable: { no: 'It's already done.', instead: 'Propose a new workout.' }"; the context line for a NULL-origin row.

**Produces:** `revisable: true | { no: string; instead: string }` on every planned-workout item the coach reads; `isRun` for `revisability` comes from the document's discipline when read (`get_workout`) and from `sport`/`category` in lists (documented in the tool description).

- [ ] **Step 1: Failing tests.** **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck 0.
- [ ] **Step 5: Commit** `feat(coach): reads carry revisable — true, or why not and what to do instead`.

---

### Task 8: A fit ends when its run ends

**Files:**
- Modify: `apps/worker/src/services/coach-runs.ts` (the run-end write ~2264–2300; `cancelRun` ~1681; the expiry sweep ~1424–1452), `apps/worker/src/services/saves-batches.ts` (new `releaseFitForBatch(db, userId, batchId, runCreatedAt): Promise<void>` — the §7 statement), `packages/ui/src/screens/studio/coach-conversation.tsx` or wherever a run's terminal state is observed (invalidate `OPEN_SAVES_QUERY` when a run with a saves batch ends).
- Test: `apps/worker/test/coach-runs-lifecycle.test.ts` (or a new `coach-runs-fit-release.test.ts`): "a fit run ending in words releases the batch (fit_started_at null)"; "one ending with a proposal does not"; "cancelled: released"; "expired by the sweep: released"; "a fit started after the run (a newer fit) is not released". UI: `packages/ui/test/coach-saves*.test.tsx` — "a fit run's end re-reads the open batch".

**Interfaces:** the batch id is `readRunState(run.state).settings.savesBatchId` (main run only); "no proposal" = `!end.proposalId && !due.proposalId && !designProposalId-written-by-proposeWhatItHas` (check after `proposeWhatItHas` ran).

- [ ] **Step 1: Failing tests.** **Step 2: Run** → FAIL. **Step 3: Implement** — one statement, `.catch(() => undefined)` after the end is written, as `releaseFitStarts` is run today. **Step 4: Run** → PASS; typecheck 0.
- [ ] **Step 5: Commit** `fix(saves): a fit run that ends with no proposal — finished, cancelled or expired — hands its batch back`.

---

### Task 9: The Studio sees it the same way

**Files:**
- Modify: `packages/ui/src/screens/studio/add-model.ts` (`editableWorkout` → `revisability(...).ok`; inputs from `WorkoutDto`: add `completionState`, `archived`, `hasDoc` to the DTO where the plan route (`routes/plan.ts` ~500–570) does not already send them), `packages/ui/src/components/session-sheet.tsx` (`doneWith` ~266–270 via the predicate; `sessionTitle` unchanged), `packages/ui/src/screens/studio/run-model.ts` ~856–906 (cause words from `REVISABILITY_WORDS`; `resolved` replaces the three), `packages/ui/src/screens/studio/use-build-flows.ts:123` (the 409's `why` + `instead` when the body carries them), `packages/api-client/src/index.ts` (`WorkoutDto` fields; the 409 body type).
- Test: `packages/ui/test/studio-add-live.test.tsx:438`, `coach-run-model.test.ts:279–314`, `coach-proposal-card-live.test.tsx:255, :639` updated; new: "a coach session (NULL origin, cw- id) is editable in the session sheet"; "a programme session's 409 shows its instead".

- [ ] **Step 1: Failing tests.** **Step 2: Run** `pnpm --filter @rg/ui test -- studio-add coach-run-model coach-proposal-card session-sheet` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck 0; `pnpm --filter @rg/ui test` all green.
- [ ] **Step 5: Commit** `feat(studio): any revisable workout is editable in the sheet; refusals say what to do instead`.

---

### Task 10: Prompt guidance

**Files:**
- Modify: `apps/worker/src/services/design-prompt.ts` (:193, :206, :209, :286, :334 per spec §6).
- Test: `apps/worker/test/design-prompt.test.ts` (:273 and any other pinned line) updated; a new assertion that the fit section contains "A refusal is never the end of a fit".

- [ ] **Step 1: Failing test.** **Step 2: Run** → FAIL. **Step 3: Implement** the wording; keep each line's length within the prompt's budget tests (`SHARED_PROMPT`/`GROWTH_MAX_CHARS` pins — rebase the constants only if the test says so, and say so in the commit). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(coach): guidance — revise what revisable allows, take instead otherwise; a refusal never ends a fit`.

---

### Task 11: Whole-system check and the runbook

- [ ] **Step 1:** `pnpm typecheck && pnpm test` (every package) → exit 0; `pnpm --filter web e2e` if the shape/nav suites are affected (they shouldn't be).
- [ ] **Step 2:** Runbook, appended to the ledger: deploy = push to main (the Deploy workflow applies `0032`); after deploy, in prod: open the coach, send "Fit the new moves from my saves into my training" on the open batch (or press Fit); expect a proposal that revises an upcoming coach session (its `revisable: true` in the trail), approve → the row's origin `studio`, stages gone, `watch_copy_name` set, Today card gone, next batch cuts on the following read. Read-only D1 checks only; any prod UPDATE goes through the owner's staged runner.
- [ ] **Step 3: Commit** nothing new unless the check found something; otherwise the branch is ready for `superpowers:finishing-a-development-branch`.
