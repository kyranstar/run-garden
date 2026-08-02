# Plan Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Plan Studio (spec: `docs/superpowers/specs/2026-08-03-plan-studio-design.md`): intake → strong-LLM plan generation → cheap-LLM edit loop → draft/diff → verified push to COROS, embedded in the Plan screen.

**Architecture:** Domain schemas + first real DB migration; the spike's create machinery refactored into a shared bridge executor; two new job kinds; worker orchestration with drift detection; a two-tier LLM service on the existing gateway/budget infra; Plan-screen Studio UI. Fixture mode makes everything demoable without credentials or LLM spend.

**Tech Stack:** existing monorepo. No new dependencies.

## Global Constraints

- Node 21 for ALL tests (`pnpm test`, package-filtered vitest); Node 22 for typecheck/builds (`source ~/.nvm/nvm.sh && nvm use 22`). NEVER tests under Node 22.
- Git: stage specific paths; exit 137 → `git write-tree`/`git commit-tree`/`git update-ref`. Branch: `plan-studio`.
- **THE PUSH INVARIANT (from the live spike):** every COROS write/delete is scoped to the target container plan; identity = plan + happenDay + program-name stamp; deletes are triple-addressed with ownership re-proven immediately before each delete; ambiguity → refuse and report, never guess. The spike's regression tests must keep passing — the executor core is SHARED with the spike, not copied.
- LLM: gateway transport + budget gate + `llmUsage` metering exactly as `apps/worker/src/services/llm.ts`; strong tier env `AI_STUDIO_MODEL_STRONG` default `anthropic/claude-opus-5`; edit tier env `AI_STUDIO_MODEL_EDIT` default `anthropic/claude-haiku-4.5`; prompts stable-prefix-first; JSON-only outputs, zod-validated, one feedback-retry, then honest null.
- `FIXTURE_MODE=1` short-circuits both LLM calls with deterministic canned outputs.
- Honest copy: "COROS calendar updated · open COROS to sync your watch" — never watch-delivery claims.
- Migrations: schema changes require `pnpm db:generate`, committed alongside (CI drift check is advisory only — do not rely on it).

---

### Task 1: Domain schemas + DB migration + catalog sync

**Files:** Create `packages/domain/src/studio.ts` (+ export from index); modify `packages/database/src/schema/` (new `studio.ts` schema file: `studio_plans`, `studio_plan_pushes`, `coros_exercises`; register in drizzle.config.ts); generate migration; modify bridge snapshot (catalog inclusion when stale) + worker sync ingest (upsert catalog); tests in domain + worker.

**Interfaces produced (verbatim names later tasks import):** `planBriefSchema`/`PlanBrief`, `studioExerciseSchema`/`StudioExercise`, `studioSessionSchema`/`StudioSession`, `liftingPlanSchema`/`LiftingPlan` exactly per the spec §1 (zod, with the numeric ranges as `.min/.max`); DB tables per spec §2. Bridge snapshot payload gains optional `exerciseCatalog?: Array<{id: string; name: string}>`; the worker's sync response tells the bridge `catalogStale: boolean` (worker-side: stale = no rows or oldest updatedAt > 7 days); bridge includes the catalog only when the previous sync said stale.

**Steps:** (1) failing tests: schema accepts a valid plan fixture, rejects out-of-range weeks/reps and unknown fields; worker test: sync with `exerciseCatalog` upserts rows, second sync reports `catalogStale: false`. (2) implement; `pnpm db:generate` and commit the migration SQL. (3) full `pnpm test` green (Node 21), typecheck (Node 22). (4) commit `feat(studio): domain schemas, studio tables, exercise catalog sync`.

---

### Task 2: Bridge create-executor refactor (shared with the spike)

**Files:** Create `services/coros-bridge/src/create-executor.ts`; modify `spike-create.ts` to consume it (behavior-identical); tests: existing spike suite UNCHANGED must pass; new executor tests.

**Interfaces produced:**
```ts
export interface CreateWorkoutSpec { happenDay: string /*YYYYMMDD*/; name: string; session: StudioSession }
export interface CreateResult { ok: boolean; code?: string; serverIdInPlan?: string; serverProgramId?: string; serverEntityId?: string; error?: string }
export function buildStrengthProgram(spec: CreateWorkoutSpec, catalog: Map<string,string>): RawCorosProgram  // §(d) encodings; throws on originId not in catalog
export async function createWorkout(client: CorosClient, spec: CreateWorkoutSpec, opts): Promise<CreateResult>   // plan-scoped derivation→occupancy→calculate→create→verify-by-stamp→ids
export async function deleteWorkout(client: CorosClient, target: {happenDay; name; idInPlan; programId; planId}): Promise<{ok: boolean; refused?: "ambiguous"|"not_found"|"stamp_mismatch"; error?: string}>
```
The weight-encoding table (bodyweight / kg / explicit-0, string display units "6"/"7"), repeat-group container shape, sortNo scheme, and exerciseNum rules move here from the spike verbatim. The spike calls these functions; its own report/CLI wrapper stays put.

**Steps:** (1) failing executor tests against the multi-plan mock: buildStrengthProgram encodings (all three weight cases pinned field-by-field), createWorkout full cycle verified, deleteWorkout refusals (ambiguous triple, stamp mismatch, foreign plan untouchable). (2) refactor; spike suite must pass UNCHANGED (proves behavior-identical). (3) bridge suite + full `pnpm test` + typecheck. (4) commit `refactor(coros-bridge): shared create-executor powering spike and product`.

---

### Task 3: Job kinds + worker push orchestration + drift detection

**Files:** Modify `packages/domain/src/jobs.ts` (union: + `create_scheduled_workout`, `delete_scheduled_workout` with payloads carrying CreateWorkoutSpec / delete target); bridge `write-executor.ts`/job dispatch wires the new kinds to the Task-2 executor and reports results; worker: new `apps/worker/src/services/studio-push.ts` (diff computation draft-vs-pushes, enqueue, result ingestion into `studio_plan_pushes`, drift detection from latest snapshot), wire into the existing job-result sync path; tests both sides.

**Semantics:** diff keys = (happenDay, sessionTitle); changed = same key, different exercise payload (deep-compare); push enqueues deletes-then-creates for changed. Drift: before enqueue, compare snapshot's container-plan entities vs `verified` push rows — missing/renamed → mark row `failed` with error `changed_on_coros`, exclude from clobbering, surface. Job results: create ok → row `verified` with server ids; failure → `failed` + error code. All state transitions unit-tested.

**Steps:** TDD as usual; worker suite + bridge suite + full test + typecheck; commit `feat(studio): push orchestration — jobs, diff, drift detection`.

---

### Task 4: studio-llm service (fixture-first)

**Files:** Create `apps/worker/src/services/studio-llm.ts` + tests; env additions in `env.ts` (`AI_STUDIO_MODEL_STRONG`, `AI_STUDIO_MODEL_EDIT`).

**Interfaces produced:**
```ts
export async function generatePlan(env, db, userId, brief: PlanBrief, catalog: Array<{id,name}>): Promise<{plan: LiftingPlan|null; reason?: string}>
export async function editPlan(env, db, userId, plan: LiftingPlan, request: string, major: boolean): Promise<{plan: LiftingPlan|null; reason?: string}>
```
Follow `llm.ts` structurally: budget gate first (same thresholds), gateway fetch, usage rows (`kind: "studio_generate"|"studio_edit"` if the table has a kind column — read llm.ts and mirror its row shape), 20s timeout, never throws. Prompts: system prefix = role + hard rules + catalog lines (stable, first); user = brief/plan/request JSON (volatile, last). Edits: ops array (RFC-6902 subset add/replace/remove) applied via a small pure `applyOps(plan, ops)` (own unit tests; path syntax `/weeks/0/sessions/1/exercises/2/reps`), zod re-validate, one feedback-retry, else null+reason. major=true → strong model full regenerate. FIXTURE_MODE: deterministic canned plan (a sane 2-week 3-day template using real fixture catalog ids) and echo-style edits (append request to plan name? NO — canned edit: setting `name` to `${name} (edited)` and nothing else — deterministic and testable). Investigate gateway prompt-cache passthrough (one attempt, documented in code comment; non-blocking).

**Steps:** TDD (gateway stubbed exactly as llm.ts tests do); full test + typecheck; commit `feat(studio): two-tier LLM service with budget gates and fixture mode`.

---

### Task 5: API routes

**Files:** Create `apps/worker/src/routes/studio.ts`, mount in the app; api-client DTOs; tests.

Routes per spec §7; GET returns {plan, brief, version, pushes[], usage7d, budget state}; generate/edit persist to `studio_plans` (version bump on accepted edit); push triggers Task-3 orchestration; retry re-enqueues one failed row. Auth middleware same as existing routes. Route tests with stubbed studio-llm + canned push rows.

Commit `feat(studio): API routes + client DTOs`.

---

### Task 6: Studio UI

**Files:** Modify `packages/ui/src/screens/plan.tsx` (Studio section at top), new `packages/ui/src/screens/studio.tsx` component file (keep plan.tsx lean), styles; api-client already typed from Task 5.

Per spec §6: empty→intake form (all PlanBrief fields; validation mirrors zod ranges client-side); draft→week grid + edit box + Major toggle + diff strip + Push button; pushed→status chips + honest copy line; usage meter; terracotta accent; must hold at 360px. No unit-test infra in ui — typecheck + Task 7 screenshots; note in report.

Commit `feat(ui): plan studio — intake, draft grid, edit loop, push status`.

---

### Task 7: Fixture world + visual checkpoint + ship

**Files:** Fixture wiring so the seeded world has a canned studio plan + push rows (worker fixtures service); screenshot pass; final suite.

**Steps:** (1) fixture seed: studio plan present, 2 sessions `verified` + 1 `failed` so all chip states render. (2) Live dev-stack verification + playwright screenshots of /plan (intake collapsed state, draft grid, push chips) at 1280×800 + 390×844 → /tmp/studio-checkpoint/ — CONTROLLER eyeballs. (3) Full `pnpm test` + typecheck; merge to main; push; watch the (test-gated) deploy; verify prod loads. (4) POST-DEPLOY LIVE VERIFICATION (controller-run, reversible): with real credentials, generate a small real plan via the deployed app, push, verify workouts on COROS via the spike's read-only `--inspect`, then delete via the studio and confirm restoration. Report results.

Commit `feat(studio): fixture world + screenshots` then ship.

## Plan Self-Review Notes

- Spec coverage: §1-2→T1, §5 executor→T2, §5 jobs/orchestration/drift→T3, §3 LLM→T4, §7 routes→T5, §6 UI→T6, §8 fixtures + rollout 7-8→T7. Testing section distributed per task.
- Type consistency: LiftingPlan/StudioSession (T1) consumed by T2 (buildStrengthProgram), T3 (job payloads), T4 (LLM), T5 (routes); CreateWorkoutSpec/CreateResult (T2) consumed by T3.
- The catalog map (T2's `Map<string,string>`) is id→name from `coros_exercises` (T1).
