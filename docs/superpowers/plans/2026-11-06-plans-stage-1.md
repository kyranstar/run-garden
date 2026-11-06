# Plans with a purpose, Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every plan has a stored purpose, brief and way of ending; the coach reads them; TRE becomes a plan that continues itself, written on its day; running asks through the coach; lifting drafts for a tap.

**Architecture:** `programs` is the registry of plans. A coach block stays in `coach_plans` as a phase and points to its plan with `program_id`. TRE's upcoming sessions reuse the programme slot machinery as outlines (`origin = 'program'`), and become ordinary document workouts (`origin = 'studio'`) on their day. Stages 2–4 of the design (computed plan facts, one write path, retiring old tables) are not in this plan.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, drizzle, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-plans-with-a-purpose-design.md`. Also read `docs/principles/workout-system-principles.md`, and for one-off and line behaviour `docs/superpowers/specs/2026-10-20-training-lines-design.md`.

## Global Constraints

- Public repository: no real plan names, purposes, briefs, figures or dates in code, tests, specs or commits. Tests use synthetic data.
- Workers Free: at most about 45 D1 statements plus fetches a request; hourly work is one heavy step; D1 binds 100 parameters and 5 compound terms; never export a non-function from `apps/worker/src/index.ts`.
- API changes are additive. `/api/programs` keeps answering adaptive programmes only, so cached clients and `ProgramSettingsSheet` never meet a course.
- No new screens (Q-130). New logic goes in pure modules with thin `.tsx`.
- Prose rules: `purpose` at most 200 characters, `brief` at most 1,000. Stored athlete and coach words are `untrusted(...)` when read to the model.
- Node: default node 21 for vitest; node 22 for wrangler only. Tests run in local time and with `TZ=UTC`.
- `pnpm -r typecheck` before every commit, including test-only ones: vitest doesn't typecheck.
- Mutation-check each guard (revert it, a test must fail), per the principles §9.
- Pushing to `main` deploys and applies migrations automatically. Don't push while a coach run is live (`GET /api/coach/runs/current`).
- Work in the worktree. Stage only your own files. Never bare `git stash`.

## Review Focus

1. A restore replacing the account while the hourly course pass or the on-day write runs: nothing may be written. Tested in Tasks 9 and 10.
2. The athlete's local day against UTC: at 23:30 local, "today" is still the local day, so tomorrow's session isn't written yet. Tested in Task 10.
3. A session the athlete moved: an outline moved off today isn't written today, and one moved onto today is. Placement doesn't refill the day it left. Tested in Tasks 9 and 10.
4. Stopping a course with today's session already written and on the watch: it comes off unless started; a started or done one stays. Tested in Task 11.
5. Exporting and restoring an account holding a course plan and `program_id` links round-trips exactly. Tested in Task 1.

---

## Piece 1: the registry

### Task 1: Columns and vocabulary

**Files:**
- Create: `packages/database/migrations/0035_plans_with_a_purpose.sql`
- Modify: `packages/database/src/schema/programs.ts`, `packages/database/src/schema/coach.ts`, `packages/database/src/version.ts`, `packages/domain/src/program.ts`
- Test: `packages/domain/test/program.test.ts`, `apps/worker/test/account-tables.test.ts`

**Interfaces:**
- Produces, in `@rg/domain`:
  - `PROGRAM_KINDS` gains `"course"`.
  - `PLAN_ON_END = ["ask", "continue", "finish"] as const`; type `PlanOnEnd`.
  - `defaultOnEnd(kind: ProgramKind, disciplines: readonly string[]): PlanOnEnd`.
  - `onEndAllowed(kind: ProgramKind, onEnd: PlanOnEnd): boolean`.
  - `courseConfigSchema`: `{ course: string; weekdays: number[] (0 = Monday, 1 to 7 entries, unique); time: "HH:MM"; quietDaysBeforeRace: number (default 7, 0–21); placementWeeksAhead: number (default 2, 1–4); easeNext: boolean (default false) }`. Type `CourseConfig`. Weekdays use the same numbering as `adaptiveConfigSchema.preferredDays`; check it there and say so in the schema's comment.
- Produces, in `@rg/database`: `programs.purpose`, `programs.brief`, `programs.onEnd`, `programs.pausedUntil`, `programs.objectiveIds` (JSON `string[]`), all nullable; `coachPlans.programId`, nullable.

- [ ] **Step 1: Write failing tests** in `packages/domain/test/program.test.ts`:

```ts
it.each([
  ["coach", ["run"], "ask"],
  ["coach", ["run", "strength"], "ask"],
  ["coach", ["strength"], "continue"],
  ["adaptive", ["yoga", "strength"], "continue"],
  ["course", ["yoga"], "continue"],
  ["coros_import", ["run"], "ask"],
  ["coros_import", ["strength"], "finish"],
])("%s of %j ends by %s", (kind, sports, want) => expect(defaultOnEnd(kind, sports)).toBe(want));

it("a programme or a course can't ask", () => {
  expect(onEndAllowed("adaptive", "ask")).toBe(false);
  expect(onEndAllowed("course", "ask")).toBe(false);
  expect(onEndAllowed("coach", "ask")).toBe(true);
});

it("a course's config needs a real day and time", () => {
  expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [], time: "19:30" }).success).toBe(false);
  expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [0, 0], time: "19:30" }).success).toBe(false);
  expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [0, 4], time: "25:00" }).success).toBe(false);
  expect(courseConfigSchema.parse({ course: "tre", weekdays: [0, 4], time: "19:30" }).quietDaysBeforeRace).toBe(7);
});
```

In `account-tables.test.ts`, add an export and restore round trip of a `course` programme with every new column set, and a `coach_plans` row with `program_id`.

- [ ] **Step 2: Run, expect failure:** `pnpm exec vitest run packages/domain/test/program.test.ts apps/worker/test/account-tables.test.ts`. Expected: FAIL, `defaultOnEnd` isn't defined.

- [ ] **Step 3: Implement.** The migration is `ALTER TABLE ... ADD` only: `programs`: `purpose`, `brief`, `on_end`, `paused_until`, `objective_ids` (text); `coach_plans`: `program_id` (text). `SCHEMA_VERSION` becomes `"0035"`.

- [ ] **Step 4: Run, expect pass,** plus `pnpm exec vitest run packages/database` and `pnpm -r typecheck`.

- [ ] **Step 5: Commit** `feat(plans): a plan's purpose, brief and ending: columns and vocabulary`. Do not push: the migration needs the owner's OK (Task 13).

### Task 2: Backfill the registry

**Files:**
- Create: `apps/worker/src/services/plan-registry.ts`, `apps/worker/test/plan-registry.test.ts`
- Modify: `apps/worker/src/index.ts` (the hourly pass, beside `placeSlotsForAllPrograms`)

**Interfaces:**
- Consumes: Task 1; `linesOf`, `lineBlockOf`, `isLoosePlan`, `studioEntriesOf`/`corosEntriesOf` results through `loadNonCoachPlanEntries`.
- Produces: `backfillPlanRegistry(db: Db, userId: string, today: string): Promise<{ created: number; linked: number }>`, idempotent, at most 45 statements a call, doing what fits and leaving the rest for the next hour. `planIdForLine(blockIds)` is internal.

What it writes, each only if not already there:
- Each training line (`linesOf`, by today's date rule) becomes one `programs` row, `kind: "coach"`, id `plan-<first block id>`, name as the plan list names it today, `disciplines` from its blocks, `on_end` from `defaultOnEnd`; its blocks get `program_id`.
- The current Studio plan entry becomes one `programs` row whose **id is its sessions' container's `training_plans.id`**, found through `studio_plan_pushes.coros_plan_id` to `training_plans.source_plan_id`; `kind: "coach"`, `source: { studioPlanId }`, name from the entry. Leave it out, and log by code only, when no container resolves.
- Each listed COROS running plan becomes a `programs` row with the same id, `kind: "coros_import"`.
- Existing `adaptive` rows get `on_end: "continue"` when null.

- [ ] **Step 1: Write failing tests:** three abutting synthetic run blocks make one plan, all linked; a second call returns `{ created: 0, linked: 0 }` and writes nothing (count statements); a retired block isn't linked; an `adhoc-` bucket gets no plan; a Studio plan with a resolvable container gets a row with the container's id, and none without; `listPrograms` and `placeSlotsForAllPrograms` still see only the adaptive programme; a restore in progress writes nothing; the statement count stays at or under 45 with 40 blocks.

- [ ] **Step 2: Run, expect failure** (`backfillPlanRegistry` isn't defined).

- [ ] **Step 3: Implement,** and call it in `hourly` for each account, caught so a failure stops nothing, before `placeSlotsForAllPrograms`.

- [ ] **Step 4: Run, expect pass,** plus `apps/worker/test/entry-exports.test.ts` and typecheck.

- [ ] **Step 5: Commit** `feat(plans): every existing plan gets a row in the registry`.

### Task 3: Lines follow the stored link

**Files:**
- Modify: `packages/domain/src/training-lines.ts`, `apps/worker/src/services/coach-plans.ts` (`lineBlockOf`)
- Test: `packages/domain/test/training-lines.test.ts`

**Interfaces:**
- Produces: `LineBlock.programId?: string | null`; `TrainingLine.programId: string | null`. `linesOf` groups blocks with a `programId` by it, whatever their dates, and applies today's date rule only among blocks without one. `key`, `phases`, `currentPhaseId` and the rest are unchanged.

- [ ] **Step 1: Write failing tests, added to the existing table:** two blocks with one `programId` 30 days apart are one line; two adjacent blocks with different `programId`s are two lines; a block with none beside a block with one doesn't join it; two with none keep today's 7 and 8 rest-day rule.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** `lineBlockOf` passes `coach_plans.program_id`.

- [ ] **Step 4: Run** `packages/domain/test/training-lines.test.ts` and the worker's `coach-nudges`, `coach-triggers` and `design-read-plans` suites. Expected: PASS.

- [ ] **Step 5: Commit** `feat(plans): a training line follows its stored plan`.

### Task 4: Reading and editing plans

**Files:**
- Create: `apps/worker/src/routes/plans.ts`, `apps/worker/src/services/plan-summaries.ts`, `apps/worker/test/plans-routes.test.ts`
- Modify: `apps/worker/src/index.ts` (route), `packages/api-client/src/index.ts`

**Interfaces:**
- Produces:
  - `GET /api/plans` returning `{ plans: PlanSummaryDto[] }`, within two grouped reads plus preferences.
  - `PATCH /api/plans/:id` with `{ purpose?, brief?, onEnd?, objectiveIds?, pausedUntil?, easeNext? }`, which writes the row and one `program_versions` row with the same batch. `easeNext` is for a course only. 422 when `onEndAllowed` refuses, or on over-long text, or on a past pause date; 404 for another account's.
  - `PlanSummaryDto`: `{ id, kind: ProgramKind, name, purpose: string | null, brief: string | null, onEnd: PlanOnEnd, pausedUntil: string | null, objectiveIds: string[], status: "active" | "retired", lineKey: string | null, listedAs: string | null, course: { session: number; of: number } | null, prompt: { kind: "whats_next" | "draft_ready"; label: string; request: string } | null }`. `listedAs` is the id the existing list row carries (a Studio entry's `studio_plans` id), so that row's sheet can find its summary. `course` and `prompt` stay null until Tasks 11 and 14.
  - `api.plans()` and `api.updatePlan(id, patch)` in the client.

- [ ] **Step 1: Write failing tests:** `GET` lists a coach plan with its `lineKey`, an adaptive programme and a course; a phase never appears as a plan; a one-off bucket never does; `/api/programs` still answers only the adaptive one (pin it); `PATCH` writes and records a version; `onEnd: "ask"` on a course is 422 with the words; another account's plan is 404; `purpose` of 201 characters is 422.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Pure shaping goes in `plan-summaries.ts`.

- [ ] **Step 4: Run, expect pass,** with statement counts pinned; typecheck.

- [ ] **Step 5: Commit** `feat(plans): read and edit a plan's purpose, brief and ending`.

---

## Piece 2: the coach and the sheet

### Task 5: The coach reads a plan's purpose

**Files:**
- Modify: `apps/worker/src/services/design-tools/read-plans.ts`, `apps/worker/src/services/design-context.ts`, `apps/worker/src/services/design-prompt.ts`
- Test: `apps/worker/test/design-read-plans.test.ts`, `apps/worker/test/design-context-focus.test.ts`, the prompt shape pins

**Interfaces:**
- `read_plans` gains, per plan and per line: `purpose` and `brief` (both `untrusted`), `onEnd`, `kind`, `pausedUntil`, `objectiveIds`. Keeps one statement.
- The opening context's computed block gains one line per active plan: its name and purpose, `untrusted`.
- The prompt says what `onEnd` means in one sentence: `ask`, ask how and toward what goal before extending, unless the request already says; `continue`, it continues itself or you draft for a tap; `finish`, leave it.

- [ ] **Step 1: Write failing tests:** the read carries each field, marked untrusted; a plan with no purpose says `null`, not missing; the opening block holds one line for an active plan and none for a retired one; the statement count holds.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** If `coach-shape-pins` trips, rebase the pin with a dated note, as it asks.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(coach): the coach reads what each plan is for and how it ends`.

### Task 6: The coach proposes changes to a plan

**Files:**
- Create: `apps/worker/src/services/design-tools/change-plan.ts`
- Modify: `apps/worker/src/services/design-tools/index.ts`, `apps/worker/src/services/proposal-kinds.ts`, `apps/worker/src/services/design-approve.ts`, `apps/worker/src/services/design-prompt.ts`, the client's proposal card words
- Test: `apps/worker/test/design-act-tools.test.ts`, the approve suite

**Interfaces:**
- Modelled on `change_programme` (read `change-programme.ts`'s header first): tool `change_plan(planId, purpose?, brief?, onEnd?, objectiveIds?, pausedUntil?, easeNext?, why)`, stored as one `plan_change` op (`PlanChangeOp`, `isPlanChangeOp`, one per plan), with `base` for a stale check, applied at approval through the same function as `PATCH /api/plans/:id`. For an adaptive programme's days or minutes, `change_programme` stays.
- A `plan_change` can sit in the same proposal as a `plan_structure`, on one card, so a new goal updates the brief with the next phase (design §4.1).
- Refusals, teachable: `not_for_role`, `not_your_plan`, `no_change`, `invalid_input` (including `onEndAllowed`), `proposal_pending`.

- [ ] **Step 1: Write failing tests:** a proposal writes nothing until approved; approving writes the fields and a version; a stale `base` refuses at approval; `onEnd: "ask"` on a course refuses at the tool; a pause in the past refuses; a replay of the tool call is idempotent; a `plan_change` beside a `plan_structure` shows on one card and both apply.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement,** registering it in `ACT_TOOLS` after `changeProgramme`.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(coach): the coach can propose a change to a plan's purpose, brief, ending or pause`.

### Task 7: A new block says which plan it belongs to

**Files:**
- Modify: `packages/domain/src/coach.ts` (`createPlan`), `apps/worker/src/services/design-tools/propose-plan.ts`, `apps/worker/src/services/coach-apply.ts` (`structuralStep`), `packages/domain/src/coach-describe.ts`
- Test: `apps/worker/test/design-act-tools.test.ts`, `apps/worker/test/coach-apply.test.ts`

**Interfaces:**
- `createPlan` gains optional `continuesPlanId: string` and `newPlan: { name, purpose, brief?, onEnd?, objectiveIds? }`. They stay optional in the schema for stored old proposals, and `propose_plan` refuses `plan_unnamed` unless exactly one is given.
- At apply, in the same batch as the block's insert: with `continuesPlanId`, set `program_id` after checking it's this account's, active and `kind: "coach"`; with `newPlan`, insert the `programs` row, id `plan-cp-<proposalId>-<opIndex>`, and link it. A stored old op with neither leaves `program_id` null, and `linesOf`'s date rule still places it.
- Remove "a new block starting after at most a week's rest joins it" from `read_plans`' `CONTINUE_LINE` and from the prompt; say to name the plan instead.

- [ ] **Step 1: Write failing tests:** `propose_plan` with neither or both refuses `plan_unnamed`; `continuesPlanId` links the block, and the line holds both phases however far apart; `newPlan` creates the plan and two adjacent same-sport plans list separately; re-running the chunk creates no second plan; another account's plan id refuses.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(coach): a new block names the plan it continues, or a new plan and its purpose`.

### Task 8: Workouts made for a plan, and the plan sheet's words

**Files:**
- Create: `packages/ui/src/screens/plan-words.ts`, `packages/ui/test/plan-words.test.ts`
- Modify: `apps/worker/src/services/design-tools/plan-set.ts`, `apps/worker/src/services/design-tools/propose.ts`, `apps/worker/src/services/design-approve.ts`, `apps/worker/src/services/doc-workouts.ts` (`createDocWorkout`), `apps/worker/src/services/designed-runs.ts`, `packages/ui/src/screens/plan-sheet.tsx`, `packages/ui/src/components/session-sheet.tsx`
- Test: `apps/worker/test/design-act-tools.test.ts`, `apps/worker/test/doc-workouts.test.ts`, `packages/ui/test/session-sheet.test.tsx`

**Interfaces:**
- `createDocWorkout` and `createDesignedRun` input gain `planId?: string`: an active plan of this account, or a block of one. Default stays `studioProgramId(userId)`. An unknown or stopped id throws `PlanNotFoundError` (the route's 422).
- `plan_set` briefs and `propose_workout` gain optional `planId`, kept on the op and passed at approval.
- `isOneOffPlan(planId: string): boolean` in `@rg/domain`: true for `adhoc-` and `studio-` prefixes. `isOneOff` in the sheet uses it.
- `planSheetWords(plan: PlanSummaryDto): { purpose: string | null; ending: string; brief: string | null; pausedUntil: string | null }`, with `ending` one of "Asks you when it ends", "Continues on its own", "Ends when its sessions do".
- The plan sheet and line sheet show `purpose` and `ending`, with the brief in a disclosure, and a "Change" button that opens the coach with `Change how my <name> plan works: `, the athlete's to finish and send.

- [ ] **Step 1: Write failing tests:** a coach workout approved with `planId` files under it, and with none under the bucket; a stopped plan refuses; a Studio-bucket session's sheet now says "One-off"; `planSheetWords` for each `onEnd`; the sheet shows the words and hides the brief until opened; no purpose shows no line. Also: nothing on the Studio Schedule path changes.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Check that nothing keys on `plan_id === studioProgramId(userId)` beyond the two writers. Render the sheet locally on the fixture stack and take a screenshot for the owner (the principles' render approval).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(plans): workouts file under the plan they're for, and the sheet says what a plan is for`.

---

## Piece 3: TRE as a course

### Task 9: Courses, and placing them ahead as outlines

**Files:**
- Create: `packages/workout/src/courses.ts`, `packages/workout/test/courses.test.ts`, `apps/worker/test/course-placement.test.ts`
- Modify: `packages/workout/src/tre-course.ts`, `packages/workout/src/index.ts`, `apps/worker/src/services/program-slots.ts`

**Interfaces:**
- Produces, in `@rg/workout`:
  - `COURSES: Readonly<Record<string, CourseDefinition>>`.
  - `CourseDefinition = { id; name; sessionDoc(n: number, opts: { ease: boolean }): WorkoutDoc; sessionLabel(done: number): { session: number; of: number } | null; videos: readonly PracticeVideo[]; purpose: string; brief: string; disciplines: readonly string[] }`. Nothing outside a course's own entry may name TRE or a tremor: placement, writing, Mark done, Pause and Stop read only this interface.
  - TRE's entry wraps `treSessionDoc`. For TRE, `ease` halves the tremor's `holdSec`, floored at 60. `sessionLabel` gives session and of for the first 10, then null. `treSessionDoc` stops writing `notes`; its rule moves to `brief`.
- `place()` accepts `kind: "course"`, through `placementOf(program, today)`, returning `{ config: AdaptiveConfig-shaped inputs, goal, seconds, title, time }`: `weeklyGoal = weekdays.length`, `preferredDays = weekdays`, `seconds` from `deriveDoc(sessionDoc(done + 1))`, `title = name`, `effectiveTime = config.time`. `readSlotRows` reads `origin IN ('program','studio')` for a course, so a written session still holds its day.
- A day is passed over, and a flexible slot on it retracted, when `date <= program.pausedUntil` (either kind) or, for a course, when it's within `quietDaysBeforeRace` before `prefs.raceDate`.
- `placeSlotsForAllPrograms` includes active and lingering courses.

- [ ] **Step 1: Write failing tests:**

```ts
it("places a course's days ahead, at its time, as outlines with no document", ...);
// weekdays [0, 4], 19:30: rows on those days, origin "program", contentState "outline", workoutDoc null, effectiveTime "19:30"
it("a second pass writes nothing", ...);
it("what the athlete moved or removed is never undone, and the day it left isn't refilled", ...);
it("a written session holds its day", ...); // a row flipped to origin "studio" isn't placed over
it("a pause retracts flexible slots inside it, keeps moved ones, and ends by itself", ...);
it("nothing's placed in the quiet days before the race; an adaptive programme isn't quieted", ...);
it("a restore in progress writes nothing", ...);
it("a retired course's flexible slots come off", ...);
```

In `courses.test.ts`: TRE's `sessionDoc(5, { ease: true })`'s tremor is 300; every course's docs validate clean under the TMJ profile with `ease` either way; `sessionLabel(2)` is `{ session: 3, of: 10 }` and `sessionLabel(10)` is null. Add a synthetic second course in `course-placement.test.ts` and `course-sessions.test.ts`, so the worker's paths are proven not to depend on TRE. Update `tre-course.test.ts` for the removed `notes`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Adaptive placement's behaviour must not change: `programs-budget.test.ts` and the slot suites stay untouched and green.

- [ ] **Step 4: Run, expect pass,** with the existing `program-slots` suites and `session-build-bench`.

- [ ] **Step 5: Commit** `feat(plans): a course places its sessions ahead as outlines`.

### Task 10: Writing a course session on its day

**Files:**
- Create: `apps/worker/src/services/course-sessions.ts`, `apps/worker/test/course-sessions.test.ts`
- Modify: `apps/worker/src/services/session-build.ts` (`loadSession`, `buildSessionOutcome`), `apps/worker/src/services/completion.ts`, `apps/worker/src/index.ts` (hourly), `apps/worker/src/services/design-context.ts` only if its `origin === "program"` line misreads an outline

**Interfaces:**
- Produces:
  - `writeCourseSession(db, userId, row: SlotRow, ctx: BuildCtx): Promise<{ written: boolean; n: number }>`.
  - `writeCourseSessionsDue(db, at?: Date): Promise<{ written: number; failed: number }>`, for the hourly pass.
  - `courseOf(db, userId, row): Promise<{ program; definition } | null>`, null for anything but an outline of a course.
- **n** = the plan's rows with `course_session` set and `completionState = 'completed'`, plus one. Nothing else counts, so a coach-filed workout under the plan doesn't advance it.
- `writeCourseSession` judges the document with `judgeDoc`, then in one atomic batch: updates the row where `origin = 'program'` (the guard that makes it once only) to `origin: 'studio'`, with the document, revision, title, category, sport and booked length from `deriveDoc`; clears `easeNext`; marks the mirror owed (`markMirrorOwed`). A judge error writes nothing, logs by code only and leaves a sync note.
- Due means `effectiveDate === today` in the athlete's zone, and today's slot not moved away.
- `buildSessionOutcome` and `loadSession` call `courseOf` first for `origin === 'program'` rows: today's is written, then continues as a document row. A day ahead answers a preview through `docDayInputs` with a computed document that isn't stored: add its `docOverride` parameter.
- **A course's own session is marked by `planned_workouts.course_session`,** the session number it was written as (added to migration 0035 in Task 9), set in the same batch as the flip. `source_content_fingerprint` can't be the mark: a verified watch push overwrites it. n counts completed rows with `course_session` set.
- **A course session never takes a scored guess at matching.** The number counts sessions done, so an unrelated activity completing one would skip a dose. `completion.ts`'s `linkOnly` becomes `w.origin === "program" || w.courseSession !== null`.
- **A paused plan writes nothing:** an outline due today under a pause stays an outline if it survived the pause's retraction.

- [ ] **Step 1: Write failing tests:**

```ts
it("numbers from sessions done, not sessions planned", ...);
// 2 completed, 1 missed, 1 skipped, today's outline: title "TRE 3 of 10"
it("writes once, whichever comes first", ...); // the hourly pass then an open, and an open then the pass: one revision
it("isn't due on the wrong day", ...);
// fake clock 23:30 local, tomorrow UTC: tomorrow's outline stays an outline. An outline moved off today stays one; one moved onto today is written.
it("uses and clears the easing in one write", ...);
it("becomes an ordinary document workout", ...); // docOriginRow true; revisability ok; rowRefusal null; a mirror job is owed
it("a day ahead previews without storing", ...); // POST build on a future outline: dose shown; row's workoutDoc still null, origin still "program"
it("an unrelated activity doesn't complete a written session", ...); // a same-day strength activity: state stays scheduled, n unchanged
it("a restore in progress writes nothing", ...);
it("a document the day refuses leaves the outline and a note", ...);
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** The programme read in `loadSession` must not add a statement for a non-programme row.

- [ ] **Step 4: Run, expect pass,** with `doc-build`, `doc-build-gate`, `session-build` and `watch-mirror` suites, in local time and `TZ=UTC`.

- [ ] **Step 5: Commit** `feat(plans): a course session is written on its day, from sessions actually done`.

### Task 11: Starting and stopping a course

**Files:**
- Create: `apps/worker/test/course-start.test.ts`
- Modify: `apps/worker/src/routes/plans.ts`, `apps/worker/src/services/plan-summaries.ts`, `apps/worker/src/services/session-build.ts` (`docVideosOf`), `packages/workout/src/tre-course.ts`

**Interfaces:**
- `POST /api/plans/courses` with `{ course, weekdays, time, clientId? }`, returning `{ plan, more: boolean }`, idempotent per course. It creates the `programs` row from the definition's name, purpose, brief and disciplines. It re-points rows whose document's `source.ref` matches `<course>-course:<n>`: those completed or under way to the plan, with `course_session` set to that n and no new revision; those still ahead come off through `removeDocWorkout`, as much as the budget allows, and `more: true` says send it again. Placement runs once none is left. An unknown course is 422.
- `POST /api/plans/:id/stop`, returning `{ more: boolean }`: `status: 'retired'`; flexible outlines retract through placement's goal 0 path; a session written for today or ahead comes off through `removeDocWorkout` unless started. Past sessions stay.
- Session read: `videos` comes from the course definition for a course outline, and from `videosOfSource` for a written one, so both show the link.
- `PlanSummaryDto.course` filled from `sessionLabel(done)`.

- [ ] **Step 1: Write failing tests:** rows done keep their document and count toward n; rows ahead go, and the watch delete is queued; a retry makes no second plan; a stop with today's written session removes it and queues its watch delete; a started session survives a stop; the plan moves to Past plans and its outlines leave the calendar; an outline's read carries the videos.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run, expect pass,** within 45 statements a request.

- [ ] **Step 5: Commit** `feat(plans): start a course from sessions already planned, and stop it`.

### Task 12: Mark done, and courses in the list

**Files:**
- Create: `apps/worker/test/mark-done.test.ts`
- Modify: `apps/worker/src/routes/plan.ts`, `packages/ui/src/components/session-sheet.tsx`, `packages/ui/src/screens/plan-cards.tsx`, `packages/ui/src/screens/plan-words.ts`, `packages/api-client/src/index.ts`
- Test: `packages/ui/test/session-sheet.test.tsx`, `packages/ui/test/plan-words.test.ts`, the Your Plans suite

**Interfaces:**
- `POST /api/plan/workouts/:id/mark-done` with `{ done: boolean }`, for a course plan's session, scheduled or missed, on today or up to `MARK_DONE_DAYS_BACK = 7` days back (the week reconcile leaves a session unresolved), never ahead. `done: true` writes, in one batch, `completionState: 'completed'`, `resolutionDate`, `sanctionedBy: 'athlete_said_done'`, and writes the outline first if it's still one; then resimulates the garden from that date, as `/match` does. `done: false` reverses only this kind. 409 for a session under way or completed another way, or matched to an activity.
- `planRowState` handles a course: kind "Practice", state `Session 3 of 10`, or "Floor practice" once past them.
- `planEntries` gains course rows from `api.plans()`. A course's row opens a small sheet built from `planSheetWords` plus "Stop this plan…", with no settings: this is the one new sheet, kept to what's already on the plan sheet.

- [ ] **Step 1: Write failing tests:** marking done completes it, and the next day's n is one higher; undoing reverses it; a future session is 409; a session with an activity match is 409; the garden credits it once (`sanctionedBy` isn't read as the coach's skip; check `garden-sync.ts`'s `sanctionedBy === "coach"` sites); the sheet offers "Mark done" on any course's session and on nothing else; the list row reads "Practice · Session 3 of 10"; Stop asks, then calls the route.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement,** with a screenshot on the fixture stack for the owner.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(plans): mark a course session done, and courses in Your plans`.

### Task 13: Land pieces 1 to 3 on production

No code unless verification finds something.

- [ ] **Step 1:** Run `pnpm -r typecheck`, the suite in local time and `TZ=UTC`. On a loaded machine, re-run any timeout alone, and say so.
- [ ] **Step 2:** Ask the owner to OK the migration before any push (it applies on deploy). Record a D1 Time Travel bookmark first (`WRANGLER_WRITE_LOGS=false`).
- [ ] **Step 3:** Fetch, rebase, confirm no coach run is live, push a reviewed SHA, and confirm both CI and Deploy on the full SHA. A smoke job stuck on installing browsers is re-run with `gh run rerun --failed`.
- [ ] **Step 4:** Draft a purpose and brief for each existing plan and show the owner in chat. After approval, write them with `PATCH /api/plans/:id` from the signed-in browser and read them back. Nothing goes in the repo.
- [ ] **Step 5:** Start TRE: `POST /api/plans/courses` until `more` is false, with the days and time the owner has now. Read back: done sessions kept and counted, outlines ahead, watch copies gone from COROS's read (two reads, per the prod notes), one row in Your plans. On the next day's first pass after a TRE day, confirm the session was written and reached the watch.
- [ ] **Step 6:** Add a dated row to the principles' §12 for the definition, the model, and the draft exception. Add the design's "For later" ideas to `~/src/lifeos/docs/rungarden/INTEGRATION_NOTES.md` from a lifeos worktree.

---

## Piece 4: asking when it ends

### Task 14: One rule for when a plan prompts

**Files:**
- Create: `packages/domain/src/plan-prompts.ts`, `packages/domain/test/plan-prompts.test.ts`
- Modify: `apps/worker/src/services/coach-nudges.ts`, `apps/worker/src/services/plan-summaries.ts`, `packages/ui/src/screens/plan-cards.tsx`
- Test: `apps/worker/test/coach-nudges.test.ts`, the Your Plans suite

**Interfaces:**
- Produces: `planPrompt(plan: { kind; onEnd; status; pausedUntil; name; discipline; lastSessionDate: string | null; hasDraft: boolean }, today: string): PlanPrompt | null`, with `PlanPrompt = { kind: "whats_next" | "draft_ready"; label: string; request: string }`.
- Rule: nothing for a retired plan, a paused one, `finish`, or `adaptive` and `course`. For `ask`, and for `coach` with `continue` until Task 16 ships: a prompt when the last session is 0 to 21 days ahead (`ENDING_DAYS`, today's chip's horizon), with the existing words, "Plan what comes after my running plan — it ends in 12 days." `draft_ready` when `hasDraft`.
- `coach-nudges.ts` step 5 reads this rule instead of `endingLine`. `PlanSummaryDto.prompt` carries it; the row shows `label` as a tappable line that calls `coach.open({ request })`. `coros_import` running plans now take part; their `lastSessionDate` comes from the rows. `hasDraft` is false until Task 15.

- [ ] **Step 1: Write failing tests,** table-driven:

```ts
it.each([
  ["coach", "ask", 12, "whats_next"],
  ["coach", "ask", 22, null],
  ["coach", "finish", 12, null],
  ["course", "continue", 12, null],
  ["adaptive", "continue", 12, null],
  ["coros_import", "ask", 12, "whats_next"],
])("%s %s, last session in %i days: %s", ...);
it("a paused plan doesn't prompt", ...);
it("a plan with a phase following on doesn't prompt", ...); // pinned from today's rule
```

And: the chip's words are unchanged for a running line; the row and the chip send the same request; a tap on the row spends nothing until sent.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** The prompt's words in `read_plans` and `design-prompt` from Task 5 already cover the dialogue; add "stop here" and objectives to its worked example for `ask_athlete` if the pins allow.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(plans): one rule for when a plan asks what's next, on the chip and the plan's row`.

- [ ] **Step 6: After landing, one live check with the owner's OK** (a paid run): `POST /api/coach/replay` of a tapped chip, or the owner taps it. Expected: the coach asks about extending and a goal first. Then a replay of "extend my running plan four weeks toward the 10K": expected, no question.

---

## Piece 5: the draft for a tap

### Task 15: Drafting a plan's next stretch

**Files:**
- Create: `apps/worker/src/services/plan-drafts.ts`, `apps/worker/test/plan-drafts.test.ts`
- Modify: `apps/worker/src/index.ts` (hourly), `apps/worker/src/services/coach-runs.ts` (`CreateRunInput`), `apps/worker/src/env.ts`

**Interfaces:**
- Produces: `draftEndingPlans(db: Db, env: Env, at?: Date): Promise<{ started: number }>`, in the hourly pass, off unless `PLAN_DRAFTS = "1"` in `Env` (the same switch shape as `COACH_STEP_ALARM`).
- It starts a run only for an active, unpaused `coach` plan with `onEnd = 'continue'`, ending (`ENDING_DAYS`), with no phase following, no live run, and no existing draft for this ending. **The key is `plan-draft:<planId>:<lastSessionDate>`**, recorded on `audit_events` in the same batch as the run's start.
- `createRun` input gains `origin: "plan_draft"`, so its first turn reads as the app's, not the athlete's words, and `planId`, which `plan_set` and `propose_plan` default to. Scope `next_n`. After creating, arm the stepper with `tellStepper(env, runId, userId, "arm", hint)` from `coach-run-stepper.ts`, under the run's normal ceiling and the weekly cap.
- A `WeekBudgetError`, or a run that ends without a proposal, records the key with `outcome` and starts nothing further; `planPrompt` then gives the `whats_next` prompt with its plain line. `hasDraft` is true while an unresolved proposal names the plan.
- The request's words (the only spend the athlete doesn't start): "Draft the next stretch of the plan <name>, from its purpose and brief. Nothing changes until I approve it."

- [ ] **Step 1: Write failing tests,** with the fake model:

```ts
it("starts one run per ending, however many passes see it", ...);
it("starts none when the switch is off, for a paused plan, for ask, for a live run, or at the weekly cap", ...);
it("changes nothing on the plan before approval", ...); // rows and programs row unchanged after the run finishes
it("files what it draws under the plan", ...);
it("a failed draft falls back to the plain prompt, and doesn't retry", ...);
it("a new ending, after approval, can draft again", ...);
it("a restore in progress starts nothing", ...);
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Keep `hourly`'s per-account budget: starting a run is one step, and the alarm does the rest.

- [ ] **Step 4: Run, expect pass,** with `coach-runs` and `coach-run-stepper` suites.

- [ ] **Step 5: Commit** `feat(plans): a coach plan that continues drafts its next stretch for a tap`.

### Task 16: Land it, switched off, then on

- [ ] **Step 1:** Land as Task 13's steps 1 and 3, with `PLAN_DRAFTS` absent. In the prompt rule, `coach` with `continue` stops counting as a chip plan only once this is on and verified: gate that line on the same switch.
- [ ] **Step 2:** Show the owner the plan it would first draft, and when, and the worst-case cost (the run's ceiling). With their OK, set the switch. The classifier may block `wrangler secret put`: ask the owner to run it with `!`.
- [ ] **Step 3:** When the first real draft runs, read it back: one run, one proposal, nothing changed on the plan, and the plan's row saying "Next stretch ready". Report what it cost.

---

## Out of this plan

Stages 2 to 4 get their own plans, written once this has landed, because their shape depends on what Stage 1 finds:
- Stage 2 fixes the Studio strength plan's sheet, plan dates and race day.
- Stage 3 adds the single write path and the daily check.
- Stage 4 retires old tables.
