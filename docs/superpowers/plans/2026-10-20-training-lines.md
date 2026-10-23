# Training Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Your plans" shows one entry per thing being trained. Consecutive coach blocks of a sport read as one line with phases, one-off buckets are never listed, and ended plans move to Past plans.

**Architecture:** One pure module in `@rg/domain` (`training-lines.ts`) groups coach blocks into lines, decides what has ended, and decides which phase names a week.
- The worker's `GET /api/coach/plans` returns `lines` beside `plans`, with no buckets.
- The UI, the week line and brief, `read_plans`, `propose_plan`, the nudges and the sleeping `plan_ending` trigger all read the same functions.
- No schema change and no data change.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers (D1/drizzle), React and TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-training-lines-design.md` (approved by the owner 2026-10-20: "sounds good go ahead and ship it autonomously").

## Global Constraints

- **Workers Free:** ≤45 D1 statements per request. `GET /api/coach/plans` may add at most 1 statement.
- **No migration and no production data change.** `planned_workouts.plan_id` stays NOT NULL, and the buckets stay as internal rows.
- **Chain rule:** coach blocks of one sport, excluding buckets (`adhoc-` id prefix, `LOOSE_PLAN_ID_PREFIX`) and `retired` ones, ordered by start date. A block joins the line when its start is ≤ the line's latest end + 8 days (at most 7 whole rest days between; owner, 2026-10-23 — it was + 7). Overlap joins.
- **Line names:** "Running", "Lifting", "Mobility". In sentences: "my running plan", "my lifting plan", "my mobility plan".
- **Copy, exactly:**
  - "Your plans", "Past plans", "Stop this plan", "One-off"
  - "Toward <race day>"
  - "Phase 2 of 3 · <phase name> · week 1 of 4"
  - "Starts <date>"
  - "Extend my running plan by two weeks", "Wind down my running plan"
  - "Plan what comes after my running plan", "Fill in next week of my running plan"
- **The goal race** is the last phase's own `planRaceDate`, never Settings' fallback (`raceDate`).
- **"Ended"** means `endDate < today` in the athlete's zone. The hourly sweep's stored status flip and its "Block complete" receipt stay unchanged.
- **UI:** tokens only, 44 px targets, both themes.
- **Backward compatibility:** the payload stays compatible. An old cached client reads `plans` (buckets absent), and a new client with no `lines` falls back to today's list.
- **Public repo:** nothing personal; synthetic data in tests.
- **Node:** vitest on node 21 (`NODE_OPTIONS=--max-old-space-size=4096 --maxWorkers=2`); wrangler on node 22.
- **Committing:** through a private index with compare-and-swap. Never push.

## Review Focus

1. **A retired middle phase.** The phases either side still chain if they fall within 7 days of each other; otherwise they make two lines. Never one line spanning a gap of more than 7 days. Pinned in Task 1.
2. **Today on a boundary.** A phase ending today is current and not ended. Tomorrow the next phase is current and the first is past, though still inside the line. Pinned in Task 1, and in Task 3's row words.
3. **The athlete's zone.** "Ended" and "current" use the athlete's zone, not UTC. A plan ending on the athlete's today, where UTC is already tomorrow, is not ended. Pinned in Task 2.
4. **"Stop this plan" interrupted part way.** Phases already retired stay retired. A second tap finishes the rest. Past phases and completed sessions are never touched. Pinned in Task 4.
5. **Mixed versions during the deploy.** A new client given a payload without `lines` renders today's list minus buckets. An old client given the new payload renders without crashing. Pinned in Task 3.

---

### Task 1: The domain module — lines, ended, the week's naming phase

**Files:**
- Create: `packages/domain/src/training-lines.ts`
- Modify: `packages/domain/src/index.ts` (export it)
- Test: `packages/domain/test/training-lines.test.ts`

**Interfaces:**
- **Consumes:** nothing new. Use the domain's existing date helpers (`addDays`, `startOfIsoWeek`; find them in `@rg/domain`).
- **Produces:**
  - `type LineBlock = { id: string; discipline: "run" | "lift" | "mobility"; status: "draft" | "active" | "completed" | "retired"; name: string; startDate: string; endDate: string; planRaceDate?: string | null }`
  - `type TrainingLine = { key: string; discipline: LineBlock["discipline"]; name: "Running" | "Lifting" | "Mobility"; phases: LineBlock[]; currentPhaseId: string; startDate: string; endDate: string; goalRaceDate: string | null; ended: boolean }`
    - `key` is `${discipline}:${phases[0].id}`.
    - `currentPhaseId` is the phase covering today, else the next to start, else the last.
    - `goalRaceDate` is the last phase's `planRaceDate` when it is ≥ today, else null.
  - `const LINE_GAP_DAYS = 7` (since 2026-10-23: `LINE_MAX_REST_DAYS = 7`, `LINE_GAP_DAYS = LINE_MAX_REST_DAYS + 1`)
  - `function planEnded(endDate: string, today: string): boolean` (`endDate < today`)
  - `function linesOf(blocks: readonly LineBlock[], today: string): TrainingLine[]` drops `retired` defensively and applies the chain rule. Lines are sorted by `startDate`. Callers pass coach blocks only, never buckets.
  - `function lineSentenceName(discipline: LineBlock["discipline"]): "my running plan" | "my lifting plan" | "my mobility plan"`
  - `type WeekPlan = { id: string; discipline: string; startDate: string; endDate: string; raceDate?: string | null; source?: "coach" | "studio" | "coros" }`
  - `function weekNaming(plans: readonly WeekPlan[], lines: readonly TrainingLine[], weekStart: string, sessionsByPlan: ReadonlyMap<string, number>): { planId: string | null; lineKey: string | null; others: number }`
    - A plan holds a week when `startOfIsoWeek(startDate) <= weekStart <= endDate`.
    - Group the holders: a coach plan belongs to its line; any other plan is its own group.
    - The main group has the most sessions that week (the sum over its plans). A tie goes to the run group with a race (the line's goal, or the plan's `raceDate`), then to the earlier start.
    - Within the main line, the naming phase is the one holding the week with the most sessions. A tie goes to the later start.
    - `others` is the number of the other groups holding the week.

- [ ] **Step 1: Write the failing tests** (table-driven, synthetic ids)
  - `linesOf` chains three abutting run blocks into one line with 3 phases. Its `currentPhaseId` is the one covering today.
  - A gap of 7 days joins; a gap of 8 days makes two lines (`LINE_GAP_DAYS` boundary). Since 2026-10-23: 7 whole rest days (start = end + 8) join, 8 rest days make two.
  - Overlapping blocks join.
  - A retired middle phase leaves `[A, C]` joined when C starts ≤ A.end + 7, and two lines otherwise (Review Focus 1). Since 2026-10-23: ≤ A.end + 8.
  - A run block and a lift block make two lines.
  - A one-phase line has `phases.length === 1`.
  - With every phase ended, `ended === true` and `currentPhaseId` is the last phase.
  - Before the first phase starts, `currentPhaseId` is the first phase.
  - Boundary (Review Focus 2): with `today = A.endDate`, current is A and the line is not ended. With `today = A.endDate + 1` and B starting then, current is B.
  - `goalRaceDate` is the last phase's `planRaceDate` (`2026-12-12` with `today 2026-10-20`), null when it is past, and null when only Settings' fallback exists (pass none).
  - `planEnded("2026-10-19", "2026-10-20") === true`; `planEnded("2026-10-20", "2026-10-20") === false`.
  - `weekNaming`: in a boundary week held by phases A (2 sessions) and B (1 session) of one line, it names A with `others: 0`. With a studio lift plan also holding the week, `others: 1`. Of two lines with equal sessions, the run line with a goal race wins. With no holder, it returns `{ planId: null, lineKey: null, others: 0 }`.
  - `lineSentenceName("run") === "my running plan"`.

- [ ] **Step 2:** Run `pnpm --filter @rg/domain exec vitest run test/training-lines.test.ts`. Expect FAIL: the module does not exist yet.

- [ ] **Step 3:** Implement the signatures above in `training-lines.ts`. The chain is one pass over the blocks sorted by `(startDate, id)`, keeping the running maximum end. Add a module comment stating the chain rule and the naming rule.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the domain suite. Run mutants on `linesOf`, `planEnded` and `weekNaming` (the gap comparison, the retired filter, the tie order, the current-phase choice).

- [ ] **Step 5:** Commit: `feat(domain): training lines — coach blocks of one sport chain into a line; ended; the phase that names a week`.

---

### Task 2: `GET /api/coach/plans` returns lines and no buckets

**Files:**
- Modify: `apps/worker/src/routes/coach.ts`: the `/plans` handler (~763–943).
- Modify: `packages/api-client/src/index.ts`: `CoachPlansResponse`, the type that `/plans` returns.
- Test: `apps/worker/test/coach-routes.test.ts`. Extend the "buckets" cases (~625–779) and add a "lines" describe block.

**Interfaces:**
- **Consumes:** `linesOf`, `planEnded` and `LineBlock` from Task 1.
- **Produces:**
  - The response gains `lines: TrainingLineDto[]`, where `TrainingLineDto = TrainingLine & { phases: Array<LineBlock & { futureSessions: number }> }`.
    - `futureSessions` counts sessions dated today or later that are not archived, not completed and not rest.
  - `plans` no longer includes loose buckets.
  - `plans` keeps blocks of every status, the Studio entry and COROS entries, unchanged.
  - Add `lines` to the api-client type as optional (`lines?: TrainingLineDto[]`), so an older payload type-checks.

- [ ] **Step 1: Write the failing tests**
  - `/plans` answers no row whose id starts `adhoc-`.
  - `lines` holds one run line of 3 phases for three abutting coach blocks. Its `key`, its `currentPhaseId` and each phase's `futureSessions` are checked against seeded sessions.
  - A retired block is in no line.
  - A completed or ended block stays in its line as a past phase.
  - Zone (Review Focus 3): with athlete zone `America/Los_Angeles` and `now = 2026-10-21T05:00Z`, a block ending `2026-10-20` is not ended, and its line's `ended` is false.
  - The statement count of `/plans` is at most one above its count before this change. Measure the old count first and pin it.

- [ ] **Step 2:** Run `pnpm --filter @rg/worker exec vitest run test/coach-routes.test.ts`. Expect the new cases to FAIL.

- [ ] **Step 3:** In the handler:
  - filter the buckets out of the response rows;
  - build the `LineBlock`s from the coach rows that aren't buckets, using `planRaceDate` (the row's own `raceDate`);
  - count `futureSessions` with one grouped statement over `planned_workouts` by `plan_id` for those ids;
  - call `linesOf(blocks, todayInZone(prefs.timezone))`.

  Drop the bucket `holds` aggregation: nothing reads it once buckets are gone. Check with grep, and keep it if anything else uses it.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the worker suite.

- [ ] **Step 5:** Commit: `feat(plans): the plans read answers training lines and no one-off buckets`.

---

### Task 3: "Your plans" lists lines, then Past plans

**Files:**
- Modify: `packages/ui/src/screens/plan-cards.tsx`: `planEntries`, `planRowState`, `YourPlans`.
- Modify: `packages/ui/src/screens/plan.tsx` (~774–787, the plans query and `activePlans`).
- Modify: `packages/ui/src/styles.css`: the Past plans disclosure. Tokens only.
- Test: `packages/ui/test/plan-page.test.tsx` (~232–365).

**Interfaces:**
- **Consumes:** `TrainingLineDto` (Task 2); `planEnded`, `lineSentenceName` (Task 1).
- **Produces:**
  - `type PlanEntry = { kind: "program"; program } | { kind: "line"; line: TrainingLineDto } | { kind: "plan"; plan: CoachPlanDto }`. `plan` is now only Studio or COROS.
  - `function planEntries(plans, programs, lines: readonly TrainingLineDto[] | undefined, today: string): { live: PlanEntry[]; past: PlanEntry[] }`
  - `function lineRowState(line: TrainingLineDto, today: string): { kind: string; state: string; goal: string | null }`
  - `YourPlans` gains a `lines` prop, and opens a line by `onOpenLine(key)`.

- [ ] **Step 1: Write the failing tests**
  - A line's row reads kind "Running" with state "Phase 2 of 3 · Base block · week 1 of 4" and goal "Toward Dec 12". Use the app's short date format, as `formatShortDate` gives it.
  - Before the line starts, its state is "Starts <date>".
  - A one-phase line's state is today's block wording, "Week n of m · ends <date>".
  - No row says "one-offs".
  - An ended line, an ended Studio plan and a completed block go under the "Past plans" disclosure (closed by default, a 44 px summary), most recent first. Retired ones are absent. A past row reads its kind and its dates ("Oct 4 – Dec 12"); its adherence is shown in its sheet.
  - Review Focus 2: the row on a boundary day names the current phase as Task 1 decides.
  - Review Focus 5:
    - a payload without `lines` renders today's coach blocks as rows (no buckets) without crashing;
    - a payload with `lines` renders no duplicate block rows for coach blocks that are in lines.

- [ ] **Step 2:** Run `pnpm --filter @rg/ui exec vitest run test/plan-page.test.tsx`. Expect FAIL.

- [ ] **Step 3:** Implement:
  - lines come from `lines`;
  - coach blocks covered by a line are not rendered as plan rows;
  - when there are no `lines`, fall back to today's block rows.

  Order the live entries as: programmes, then lines and Studio/COROS plans by start date. The disclosure is `<details>` with a 44 px summary, as `.sync-stale` does.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the UI suite.

- [ ] **Step 5:** Commit: `feat(plan): your plans — one row per training line, one-offs unlisted, Past plans a tap down`.

---

### Task 4: The line's sheet, "Stop this plan", and a one-off says so

**Files:**
- Modify: `packages/ui/src/screens/plan-sheet.tsx`. A line sheet renders its phases; the existing per-plan sheet body serves the open phase.
- Modify: `packages/ui/src/screens/plan.tsx`. Route `?line=<key>` to the line sheet, and keep `?plan=<id>` working: a coach block's id opens its line, scrolled to that phase.
- Modify: `packages/ui/src/components/session-sheet.tsx`. A row whose `planId` starts `adhoc-` shows "One-off" where a programme session shows its programme.
- Test: `packages/ui/test/plan-sheet-line.test.tsx` (new), and `packages/ui/test/session-sheet.test.tsx`.

**Interfaces:**
- **Consumes:** `TrainingLineDto`, `lineSentenceName`; `api.coachPlanRetire(id)` (it already loops while `remaining`); the existing `/plans/:id/detail`, rename and race calls.
- **Produces:**
  - `function stopLine(line: TrainingLineDto, today: string, retire: (id: string) => Promise<{ ok: boolean }>): Promise<{ stopped: string[] }>`. It retires the current phase and every later phase, in order. It never retires a phase that has ended.
  - `function stopCount(line: TrainingLineDto, today: string): number`: the sum of `futureSessions` over those phases.

- [ ] **Step 1: Write the failing tests**
  - The sheet lists the phases in order: ended phases collapsed, the current one open with its detail, later ones as a heading and dates.
  - Rename sits on each phase's heading.
  - "Change race" acts on the last phase.
  - "Extend" pre-fills "Extend my running plan by two weeks"; "Wind down" pre-fills "Wind down my running plan".
  - "Stop this plan":
    - its confirm says the count from `stopCount` ("Stop this plan? 14 sessions leave your calendar.");
    - confirming calls `retire` for the current phase and the later ones only, never an ended phase;
    - Review Focus 4: when the second call rejects, the first stays retired, the sheet says "That didn't go through — try again.", and a second tap retires only what is left;
    - focus moves to the result line.
  - The `?plan=<coach block id>` link opens its line.
  - An ended line (opened from Past plans) shows its phases read-only: no Extend, Wind down, Stop, Change race or Rename. Its adherence is per phase, from each phase's detail as now.
  - A session in an `adhoc-` plan shows "One-off". A programme session still shows its programme. A plan session shows neither.

- [ ] **Step 2:** Run `pnpm --filter @rg/ui exec vitest run test/plan-sheet-line.test.tsx test/session-sheet.test.tsx`. Expect FAIL.

- [ ] **Step 3:** Implement. Reuse the existing sheet body for the open phase. No new server route.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the UI suite. Run mutants on `stopLine`, `stopCount` and the phase states.

- [ ] **Step 5:** Commit: `feat(plan): a training line's sheet — its phases, its end's Extend and Wind down, Stop this plan; a one-off says so`.

---

### Task 5: The week line and the brief name the same phase

**Files:**
- Modify: `packages/ui/src/screens/week-view.tsx`: `weekPlan` (~131–146) and the week-jump numbering (`plan.tsx` ~827–846).
- Modify: `apps/worker/src/routes/plan.ts`: `covering` (~1159–1166) and the brief's week counter (~1202–1221).
- Test: `packages/ui/test/week-plan-line.test.tsx`, `apps/worker/test/plan-routes.test.ts` (~608–750), and `packages/domain/test/week-naming-cases.ts` (new: one shared table both suites import).

**Interfaces:**
- **Consumes:** `weekNaming`, `linesOf`, `WeekPlan` (Task 1); `lines` (Task 2).
- **Produces:**
  - `weekPlan(blocks, weekStart, week, lines?)` keeps its return shape. `planMore` comes from `weekNaming().others`.
  - The brief's `weekIndex`/`weekTotal` are the naming phase's own week counts.

- [ ] **Step 1: Write the failing tests**
  - Every row of the shared table gives the same naming phase from the client's `weekPlan` and from the server's brief. The table covers:
    - a boundary week;
    - two lines;
    - a Studio plan beside a line;
    - a past week whose phase has ended;
    - no holder.
  - In a boundary week the line reads with no "+1".
  - The week-jump menu numbers weeks from the line's first phase.

- [ ] **Step 2:** Run both test files. Expect FAIL.

- [ ] **Step 3:** Implement both readers through `weekNaming`.
  - The server counts sessions per plan from the week's rows it already reads, with no new statement.
  - Paging back to a past week considers coach plans of every status except retired, so a completed phase still names its weeks.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the worker and UI suites.

- [ ] **Step 5:** Commit: `fix(week): the week line and the brief name one phase, by one rule — a line's phases are never "+1"`.

---

### Task 6: The coach sees lines

**Files:**
- Modify: `apps/worker/src/services/design-tools/read-plans.ts`: list lines with their phases; list the newest Studio plan read-only; replace "plan what comes after it as a new plan".
- Modify: `apps/worker/src/services/design-tools/propose-plan.ts`: refuse changing a block whose `endDate` is before today, by date as well as by status.
- Modify: `apps/worker/src/services/coach-nudges.ts`: the "Fill in …" and ending chips become line-aware. Add `discipline` and `startDate` to its plans select.
- Modify: `apps/worker/src/services/coach-triggers.ts`: `plan_ending` uses the line's last phase, only when it ends ≥ today.
- Modify: `apps/worker/src/services/coach-context.ts`: the dossier excludes buckets.
- Test: `design-read-plans.test.ts`, `design-propose-plan.test.ts`, `coach-nudges.test.ts`, `coach-triggers.test.ts`, `coach-context.test.ts`, and the prompt/schema size pins (`coach-shape-pins.test.ts`).

**Interfaces:**
- **Consumes:** `linesOf`, `planEnded`, `lineSentenceName` (Task 1).
- **Produces:**
  - `read_plans` output gains `lines: [{ name, discipline, phases: [{ id, name, start, end, ended }], end, goalRace }]`. The blocks list is unchanged for ids.
  - The new instruction sentence, exactly: "To continue a line, propose its next phase starting the day after the line's last phase ends; it joins the line."

- [ ] **Step 1: Write the failing tests**
  - `read_plans` returns one run line of 3 phases and the Studio plan with `coachMayChange: false`. Its text has the new sentence and not "as a new plan".
  - `propose_plan` refuses an extend of a block ended yesterday whose stored status is still `active`, with a reason naming the line's next phase.
  - Nudges:
    - with three chained blocks, no "Plan what comes after …" chip appears until the line's last phase ends within 21 days, and then the label is "Plan what comes after my running plan";
    - "Fill in next week of my running plan" appears for a shape week of any phase.
  - The trigger `plan_ending` does not fire for a phase followed by another, and does not fire for a phase that has ended.
  - The dossier lists no `adhoc-` plan.
  - The prompt and schema pins hold. If a pin must move, state why in the commit.

- [ ] **Step 2:** Run the listed files. Expect FAIL.

- [ ] **Step 3:** Implement. Keep each tool's `statementCost` true, measuring before and after.

- [ ] **Step 4:** Re-run. Expect PASS. Then run the worker suite and the coach CPU bench alone.

- [ ] **Step 5:** Commit: `feat(coach): the coach reads training lines and the Studio plan; its chips and plan_ending are line-aware`.

---

### Task 7: End to end

**Files:**
- Modify: `apps/web/e2e/coach-plans.spec.ts`, or `coach-plan-retire.spec.ts`.
- Modify: `apps/web/e2e/seeded-accounts.ts` (SEEDED), only if a new account is needed. If a seed lever is needed, add a fixture-only dev route (404 outside `FIXTURE_MODE`), as `/api/dev/coach-notices` does.
- Test: the spec itself, on both projects.

- [ ] **Step 1:** Write the journey:
  - an account with two abutting coach run blocks and a one-off;
  - "Your plans" shows one "Running" row with "Phase 1 of 2 · …";
  - no one-offs row;
  - the sheet lists both phases;
  - "Stop this plan" confirms with the count, and afterwards the row is gone and Past plans is unchanged;
  - the one-off's session sheet says "One-off".
- [ ] **Step 2:** Run it on a private fixture stack (ports of your own, private state), both projects. Expect PASS. Then run the default suite once.
- [ ] **Step 3:** Commit: `test(e2e): a training line, end to end — one row, its phases, Stop this plan; a one-off says so`.
