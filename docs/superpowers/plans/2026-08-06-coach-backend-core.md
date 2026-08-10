# Coach Backend Core (Plan A of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coach's entire headless substrate per `docs/superpowers/specs/2026-08-06-coach-intelligence-design.md`: tables, typed ops, guardrails, triggers, dossier, wake pipeline, proposal lifecycle, apply path, and routes — deployable dark (no UI consumes it yet; Plan B is the panel, Plan C the garden loop).

**Architecture:** One-shot full-dossier wakes through the existing gateway/zod-retry infra; deterministic trigger + validator layers around the model; `plannedWorkouts` stays the firm source of truth; everything fixture-testable in the in-memory D1 harness.

**Tech Stack:** Drizzle/D1, Hono, zod, existing `chatCompletion`/`extractJson` gateway helpers, vitest (Node 21).

## Global Constraints

- Node 21 tests; `git add` specific paths (SIGKILL); engine untouched in this plan (v5 comes in Plan C); LLM house rules (never-truncate caps 64k/16k, 300s, one transient retry); $20/wk rolling budget via `llm_usage`; commit per task; push (deploy) when the plan is green.

---

### Task A1: coach tables + migration

**Files:** Create `packages/database/src/schema/coach.ts`; modify `schema/index.ts`; generate migration; test `apps/worker/test/coach-schema.test.ts`.

**Produces (exact tables):**
- `coach_memory` `{id pk, userId, kind: text('fact'|'rule'|'note'), body, provenance json {source, messageId?, at}, learnedAt, expiresAt?, active int(bool) default 1}`
- `coach_questions` `{id pk, userId, body, chips json string[], askedAt, answeredAt?, memoryId?}`
- `coach_messages` `{id pk, userId, role: 'coach'|'user'|'receipt', body, refs json {proposalId?, memoryIds?, questionId?} , at}` + index (userId, at)
- `coach_proposals` `{id pk, userId, planId?, title, evidence, rationale, flags json string[], ops json Op[], status: 'pending'|'approved'|'declined'|'superseded'|'expired', createdAt, expiresAt, resolvedAt?, supersededBy?}` + index (userId, status)
- `coach_triggers` `{id pk, userId, kind, evidence json, firedAt, consumedAt?}` + index (userId, consumedAt)
- `coach_plans` `{id pk, userId, discipline: 'run'|'lift', name, status: 'draft'|'active'|'completed'|'retired', startDate, endDate, raceDate?, stampPrefix, createdAt, updatedAt}`
- `coach_plan_weeks` `{id pk, planId, weekStart, state: 'firm'|'shape', shape json {volumeTarget, keySessions[]}|null}` + unique (planId, weekStart)

Steps: failing insert/read smoke test per table → schema → `pnpm --filter @rg/database generate` (inspect: 7 CREATE TABLEs) → green → commit `feat(coach): tables + migration`.

### Task A2: domain types — ops, sessions, wake output

**Files:** Create `packages/domain/src/coach.ts`; export from domain index; test `packages/domain/test/coach-schema.test.ts` (create test dir if the package lacks one — check `packages/domain/vitest.config.ts` exists; if the package has no test setup, put tests in `apps/worker/test/coach-domain.test.ts` instead).

**Produces (zod, exported with inferred types):**
- `CoachSession` — discipline-generic session: `{category, title, run?: {blocks: Array<{kind:'duration'|'distance', value, intensity?: 'easy'|'steady'|'threshold'|'interval'|'rest'}>}, lift?: {exercises: Array<{name, sets, reps, weightNote?}>}, durationMinutes}` (mirrors the studio session shape; run blocks = the COROS-confirmed topology).
- `CoachOp` — discriminated union: `ease{workoutId, session}` · `move{workoutId, toDate}` · `swap{dayA, dayB}` · `skip{workoutId, reason}` · `add{date, session}` · `reshapeWeek{planId, weekStart, sessions: Array<{date, session}>}` · `firmUp{planId, weekStart, sessions}` · `extendPlan{planId, shapeWeeks: Array<{weekStart, volumeTarget, keySessions}>}` · `windDown{planId}` · `createPlan{discipline, name, startDate, endDate, raceDate?, firmWeeks, shapeWeeks}` · `retirePlan{planId}`
- `WakeOutput` — `{briefing: string|null, proposals: Array<{title, evidence, rationale, expiresAt, flags: string[], ops: CoachOp[]}>, question: {text, chips: string[]}|null, memoryOps: Array<add|update|expire>}` exactly per spec §3.

Steps: failing parse tests (valid samples + each malformed rejection) → implement → green → commit.

### Task A3: guardrails validator

**Files:** Create `packages/domain/src/coach-guardrails.ts`; tests beside A2's.

**Produces:** `validateOps(ops: CoachOp[], ctx: GuardrailCtx) → {hard: Violation[], soft: Violation[]}` where `GuardrailCtx = {today, workouts: Array<{id, date, category, completionState, durationMinutes, discipline}>, weeklyLoadByDiscipline: Record<discipline, number[4]> /* trailing 4 wk minutes */, raceDates: string[], firmHorizonEnd: Record<planId, date>, rules: Array<{id, text, test?: RuleTest}>}`; `Violation = {rule, opIndex, detail}`.

**Hard rules (each its own pure check + test):** H1 ramp — projected week minutes per discipline > 1.10 × trailing-4-week avg; H2 hard-day adjacency — resulting calendar has quality/long/race/heavy on consecutive days; H3 no touching completed/past/unresolved workouts; H4 beyond-horizon edits except via firmUp/extendPlan/reshapeWeek; H5 no new intensity within 7 days of a race; H6 never skip a race.
**Soft:** structured rule matchers for the two standing-rule shapes v1 extracts (`{kind:'anchor_day', category, weekday}` e.g. long-on-Saturday; `{kind:'fixed_slot', category, weekday}` quality-on-Tuesday) — violations returned as soft with rule id; free-text rules pass through for the model's own flags only (validator can't test prose).

Steps: failing exhaustive suite (≥1 positive + 1 negative per rule; flag-injection: model omitted a soft flag → validator adds it) → implement → green → commit.

### Task A4: trigger service

**Files:** Create `apps/worker/src/services/coach-triggers.ts`; wire evaluation into the hourly cron (`index.ts`, beside reconcile) and into `GET /api/coach/state` (A9); test `apps/worker/test/coach-triggers.test.ts`.

**Produces:** `evaluateTriggers(db, userId, prefs, today) → fired kinds` (writes rows, dedupe: skip if an unconsumed row of that kind exists or one was consumed <72h ago) + `pendingTriggers(db, userId)` + `consumeTriggers(db, userId, ids, at)`. The six spec rules as pure SQL/date computations over `sleep_records`, `daily_health` (30d baselines computed inline), `plannedWorkouts` resolutions, `coach_plans`/`coach_plan_weeks` horizon, race dates.

Steps: failing tests per rule (seed rows → expect fire; boundary → expect quiet; dedupe) → implement → green → commit.

### Task A5: the dossier

**Files:** Create `apps/worker/src/services/coach-context.ts`; test with a golden fixture (`apps/worker/test/coach-context.test.ts`).

**Produces:** `buildDossier(db, userId, prefs) → {text: string, sections: Record<name, {stale?: boolean}>}` — the eight spec §2 sections as terse labeled tables; explicit `unknown` for gaps; conversation tail = last 10 `coach_messages`; pending proposals + open question included; garden line LIGHT (chain only — full garden voice lands in Plan C). Assert in test: section headers all present, token estimate (`text.length/4`) ≤ 12k, unknown-marking behavior, determinism given fixed rows.

Steps: failing golden test using fixture seeding helpers (reuse `fixtures.ts` where possible) → implement → green → commit.

### Task A6: the wake pipeline

**Files:** Create `apps/worker/src/services/coach-wake.ts`; prompt in-file (`WAKE_SYSTEM_PROMPT`); test `apps/worker/test/coach-wake.test.ts` (fixture mode).

**Produces:** `wake(db, env, userId, prefs, cause: {kind:'message', body} | {kind:'open'}) → {messages, proposals, question}`:
1. Budget gate: rolling-7d `llm_usage` cost ≥ $20 → persist user message (if any) + receipt "coach is resting", no call.
2. Compose: dossier + pending triggers + (message). Skip-wake rule for `open`: no triggers AND last coach message <20h → return cached state, zero calls.
3. Call strong model (env `AI_STUDIO_MODEL_STRONG`), `extractJson` → `WakeOutput` zod, one repair retry (existing pattern from studio-llm — reuse its helper if exported, else mirror).
4. Validator: hard violations → ONE repair round-trip quoting violations; still bad → drop that proposal, log, keep the rest. Soft → union model flags with validator-found flags.
5. Persist atomically: coach message (briefing, unless null), user message (already persisted before the call so a crash never loses input), proposals (pending, supersede any live proposal sharing a (planId, affected-day) — mark old `superseded` + receipt), memoryOps applied (add/update/expire with provenance = this message id; expire honors user-deleted rows by simply not resurrecting them), question insert (only if none open AND no active memory answers it — enforced by prompt + a defensive dedupe on exact-normalized text), consume triggers.
6. Restraint honored: all-empty output with `briefing: null` → only trigger consumption happens (a fully successful wake).

**Prompt skeleton (curate in-file, ≈60 lines):** coach persona + propose-only contract + restraint-first-class + never-ask-what-memory-answers + flags duty + op vocabulary with the zod shapes + expiry rule + output-JSON-only.

Steps: failing fixture tests — message wake persists user msg + coach msg + proposal rows; open wake with no cause skips LLM (assert zero fixture calls); budget-exhausted receipt; hard-violation drop after failed repair; supersede path; restraint (empty output) path → implement → green → commit.

### Task A7: proposal lifecycle endpoints + expiry sweep

**Files:** Create `apps/worker/src/routes/coach.ts` (mounted `/api/coach`); expiry sweep in the hourly cron; test `apps/worker/test/coach-proposals.test.ts`.

**Produces:** `POST /api/coach/proposals/:id/approve` (status→approved + receipt + apply via A8; 409 if not pending), `POST /:id/decline` (status→declined + receipt), sweep: pending with `expiresAt < now` or first-affected-day past → `expired` + receipt. Receipts are `coach_messages` rows `role:'receipt'` with `refs.proposalId`.

Steps: failing route tests (approve happy path → apply called + receipt; approve expired → 409; decline; sweep expiry) → implement → green → commit.

### Task A8: the apply path (app-side)

**Files:** Create `apps/worker/src/services/coach-apply.ts`; test `apps/worker/test/coach-apply.test.ts`.

**Produces:** `applyOps(db, userId, prefs, ops) → {created[], updated[], archived[]}` — deterministic mutations: `ease` rewrites the workout's session fields (title/category/duration/stages) keeping id+date; `move` sets effectiveDate via the EXISTING `applyMove` (rides intents/jobs — do not reimplement); `swap` = two moves; `skip` resolves skipped (Plan C adds sanction flavor); `add`/`firmUp`/`reshapeWeek`/`createPlan` insert `plannedWorkouts` rows (stamped `sourceWorkoutId` under the plan's `stampPrefix`, `corosSyncState` honest per writes toggle) + upsert `coach_plans`/`coach_plan_weeks`; `extendPlan` appends shape weeks + bumps endDate; `windDown` reshapes the final firm week to taper via provided sessions; `retirePlan` archives future workouts (calendar-suppression reason, COROS untouched — same contract as remove) + status retired.
Watch mirroring: rows created with writes ON enqueue through the existing studio-push generalization — **v1 of this plan wires lift sessions through the existing executor path and marks run-session push as `app_only` pending the run-topology executor extension (Task A10)**; writes OFF → everything `app_only`, honest sync state.

Steps: failing tests per op incl. idempotent re-apply (same ops twice → no dupes; keyed by deterministic ids `coach-{proposalId}-{i}`) → implement → green → commit.

### Task A9: state + message + memory routes, api-client

**Files:** Extend `apps/worker/src/routes/coach.ts`; `packages/api-client/src/index.ts`; tests in `apps/worker/test/coach-routes.test.ts`.

**Produces:**
- `GET /api/coach/state` → `{messages (paginated, ?before), pendingProposals, openQuestion, memoryCount, lastCoachAt}` — evaluates triggers inline (cheap) so an open can immediately decide wake-worthiness client-side via `wakeAdvised: boolean` (pending triggers OR stale).
- `POST /api/coach/message {body}` → runs `wake(cause: message)`, returns the new tail (long-poll style single response; streaming is a Plan B nicety, not required for correctness).
- `POST /api/coach/wake` → open-cause wake (respects skip rule; the panel calls it when `wakeAdvised`).
- `GET/PATCH/DELETE /api/coach/memory(/:id)`; `POST /api/coach/questions/:id/answer {chip|text}` → memory add + `answeredAt` + wake follow-up.
- Manage plans: `GET /api/coach/plans`, `POST /api/coach/plans/:id/(retire|rename)`; extend/wind-down/create go THROUGH the coach (message-shaped, e.g. `POST /message {body:"extend …"}` from the UI's buttons) so there is exactly one change pipeline.
- api-client: typed fns for all of the above.

Steps: failing route tests (auth, shapes, question-answer→memory, memory delete honored by next dossier) → implement → green → commit.

### Task A10: run-topology push lane (executor extension)

**Files:** `services/coros-bridge/src/create-executor.ts` (+ its schema/types), tests beside its existing suite; `apps/worker/src/services/studio-push.ts` generalization touchpoints.

**Produces:** executor accepts `sportType: run` sessions with duration/distance blocks (the spike-confirmed topology: two-block minimal, extendable list), same plan-scoped identity + stamp + verified read-after-write + guarded delete contract as strength. Worker push service accepts coach-plan stamps (`stampPrefix — wk N`).
**Checkpoint (not a code step):** before enabling run-writes in prod, run the live spike (`pnpm coros:spike:*` extended with a run case) against the real account with the desktop bridge up — same protocol as the strength safety-core verification. Until then run sessions stay `app_only` even with writes ON (a one-line capability gate).

Steps: failing executor unit tests (byte-shape of run create payload vs spike fixture; identity/verify paths) → implement → green → commit.

### Task A11: verify + ship dark

- Full suite (Node 21) green; typecheck clean; migration count sane; `wrangler tail`-able logs on wake failures.
- Push → CI gates → migration applies → deploy. Dark: no UI calls these routes until Plan B.
