# Stage 3 — The Coach Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool-using coach that designs workouts (or a set of them) from the library with intent, reviews its own draft independently along explicit dimensions, revises, and proposes for one-tap approval — showing its work live — plus memory v2, settings for scope, and the objectives board.

**Architecture:** Agent runs persisted in `coach_runs` / `coach_run_events` (migration 0028); one model call per client-driven step through the AI gateway's native Messages endpoint with tools and prompt caching; tools are thin, budgeted, provenance-carrying wrappers over Stage 1–2 services; proposals reuse `coach_proposals` with a `doc_workout` op approved through Stage 2's `createDocWorkout` / `reviseDocWorkout`.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers (Free plan) + D1, the Vercel AI Gateway (`/v1/messages`), React UI in `packages/ui`, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-stage-3-coach-designer-design.md`. **Principles (binding):** `docs/principles/workout-system-principles.md` §2, §6, §7, §10.

## Global Constraints

- Public repository: no personal data in code, prompts committed to the repo, tests, fixtures, snapshots or commit messages; prompts carry the athlete's data only at run time from the database.
- Every request ≤ 45 combined D1 statements + external fetches; the model call is one fetch; each tool declares its statement cost; counting tests.
- AI spend: every call recorded in `llm_usage`; the weekly cap ($5 warn / $20 cutoff) is enforced before every model call; per-run ceilings (defaults $1.50 now / later today, $6 week).
- Fatal only when wrong (hard condition rule, unknown exercise, past date, resolved / programme row, stale base); everything else advisory.
- Untrusted text (requests, free-text answers, notes, imported names) is data, marked in tool results, never followed as instructions.
- Never export a non-function from `apps/worker/src/index.ts`; cron work goes through `cron-limits.ts` constants and one heavy step per cron run.
- Test first with a scripted model (no key); live runs only in Task 13, within the cap.

## Review Focus

1. **The app closes mid-run** — state persists per step; reopening resumes; the cron sweep finishes or expires orphans; nothing is half-applied. Tests in Task 2.
2. **The model asks for more tool calls than the step budget allows** — the remainder is queued and executed first next step; no statement-limit failure. Tests in Task 2.
3. **The cap is reached mid-run, or credits run out** — the run stops gracefully with what it has and the plain fallback line; no partial proposal. Tests in Tasks 2 and 10.
4. **A request containing instructions** ("ignore your rules and…") — treated as data; hard rules still enforced by code. Tests in Tasks 3 and 5.
5. **Approving part of a week's proposal, or a proposal whose base workout changed** — the approved parts apply; stale ones refuse with a reason. Tests in Task 8.

---

## Batch 3A — the agent (deterministic)

### Task 1: The Messages client
**Files:** `apps/worker/src/services/llm-messages.ts`; `apps/worker/test/llm-messages.test.ts`; `scripts/probe-gateway-model.mjs` (the free schema probe: posts an invalid body with a junk key; 400 naming a field = parsed, 401 = dropped).
**Produces:** `callMessages(env, { model, system: SystemBlock[], messages, tools, maxTokens, effort? }, fetchImpl?) → { content: ContentBlock[], stopReason, usage: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }, costMicros }`; system blocks carry `cache_control: { type: "ephemeral" }` at the cache breakpoints; the base URL and model from env (`AI_GATEWAY_BASE_URL`, `AI_DESIGN_MODEL`, default the strongest Claude model id the probe confirms); the recorded-model fixture server (`FIXTURE_MODEL_URL`) supported like `coach-wake.ts`; a 402 maps to `out_of_credits` (reuse the existing marker); cost from the gateway's usage with the model's prices in one table.
- [ ] Failing tests (request shape incl. tools and cache_control; usage → cost incl. cache reads; 402 → out_of_credits; 5xx → retryable error; no key → `no_key`) → implement → pass → commit.

### Task 2: Runs and the step loop
**Files:** `apps/worker/src/services/coach-runs.ts`, `apps/worker/src/routes/coach-runs.ts` (mounted under `/api/coach/runs`), cron hook (`cron-limits.ts`: `COACH_RUN_SWEEP_MAX = 1`, `COACH_RUN_ORPHAN_MINUTES = 30`), `packages/api-client`; tests.
**Produces:** `POST /api/coach/runs { scope, request?, rehearsal? }` → `{ run }`; `POST /api/coach/runs/:id/step` → `{ status, nextDue, events }`; `GET /api/coach/runs/:id?afterSeq=` → `{ run, events }`; `POST /api/coach/runs/:id/answer { answers }`; `POST /api/coach/runs/:id/cancel`. One step: pick the due run (main or the next due sub-run), execute queued tool calls first, else call the model once, execute its tool calls in order while the statement budget allows (queue the rest), append events, persist state (trimmed: tool results summarised after use), update cost; enforce the weekly cap and the run ceiling before the model call; `waiting_athlete` on `ask_athlete`; a lock so two steps never run one run concurrently. `rehearsal: true` stores the final proposal with status `rehearsal` (never shown in the app's lists) — for the live suite.
- [ ] Failing tests with a scripted model (a sequence of tool-call turns): happy path to `finish`; budget overflow queues; resume after `waiting_athlete`; cancel; cap reached → graceful stop + event; out of credits → plain event; concurrent step → 409; orphan sweep advances one step / expires after 30 min idle; budgets ≤ 45 per step → implement → pass → commit.

### Task 3: The opening context
**Files:** `apps/worker/src/services/design-prompt.ts` (the principles as reasons and examples, the archetypes and asking examples, the tool contracts, the review rubric — text constants, generic), `apps/worker/src/services/design-context.ts`, `packages/exercise-library/src/conditions/types.ts` (+ `describeRules(): string[]` on the profile contract; TMJ implements it from its own constants); tests.
**Produces:** `buildDesignContext(db, userId, run, now) → { system: SystemBlock[] /* cached principles + tools + profile summary | breakpoint | pinned memory */, header: string /* today header + availability index + scope + request marked as the athlete's words */ }` per spec §3, ≤ 45 statements, the availability index as counts and dates only.
- [ ] Failing tests (contains units, weekday and timezone, each active profile's generated rules and today's reading or "none today", today's plan line, events within the horizon, the availability index; never contains raw history rows; the request appears inside a marked data block; a request with "ignore your rules" changes nothing in the system blocks; size of the cached part stable across two runs → cacheable) → implement → pass → commit.

### Task 4: Read tools
**Files:** `apps/worker/src/services/design-tools/read-*.ts`, a registry `design-tools/index.ts` (name, JSON schema, statement cost, roles allowed, handler); tests per tool.
**Produces:** the read tools of spec §4 with contracts: compact, ranked, `limit`/`cursor`, `{ data, provenance: { source, asOf }, missing: string[] }`, untrusted text marked `{ text, untrusted: true }`, teachable errors `{ error, why, fix }`. Reuse Stage 1 services (`measureKeyResult`, `derivePerformed`, `searchLibrary`, the workouts list) and the existing readiness builder.
- [ ] Failing tests per tool (shape, pagination, provenance, untrusted marking, statement cost declared = measured, user scoping) → implement → pass → commit.

### Task 5: Act tools
**Files:** `design-tools/validate.ts`, `ask.ts`, `record-answer.ts`, `remember.ts`, `propose.ts`, `plan-set.ts`, `finish.ts`; `apps/worker/src/services/coach-memory.ts` (v2 fields); tests.
**Produces:** per spec §4 "Act". `propose_workout` writes a `doc_workout` op into a pending proposal for the run (one proposal per main run; designers append), refusing with reasons on fatal issues / stale base / resolved or programme rows; `record_answer` writes `athlete_answers` with `source 'request'` and an undo handle; `remember` writes memory v2 (`confidence`, `evidence`), never `confirmed` on its own.
- [ ] Failing tests (each refusal path; an injected instruction in the request does not bypass the validator; ask pauses the run; record_answer undo; remember marks inference) → implement → pass → commit.

### Task 6: Review and revise
**Files:** `apps/worker/src/services/design-review.ts`; tests.
**Produces:** after a designer's draft passes validation, a reviewer sub-run (role `reviewer`) with the draft, request, scope, validator issues, derived fields and the designer's tool results (with provenance), never the designer's reasoning; output parsed to `{ scores: Record<Dimension, 1..5>, notes: Record<Dimension, string>, mustFix: string[], improvements: string[] }`; the designer revises ≤ 2 rounds; the best-scoring passing version is proposed with the review and the change list attached.
- [ ] Failing tests (scripted reviewer: must-fix triggers a revision; two rounds max; best version chosen; unparsable review → one repair, then proceed with the validator's view and say so) → implement → pass → commit.

### Task 7: Orchestration for a week / next N
**Files:** `apps/worker/src/services/design-orchestrate.ts`; tests.
**Produces:** main run tools `plan_set` → designer sub-runs (each with its brief); scheduling: one due sub-run per step; when all designers finish, the main run reviews the set (balance, interference, progression) and finishes one proposal; a failed designer leaves its slot out with a reason, not the whole set.
- [ ] Failing tests (3-workout set end to end with a scripted model; one designer fails → proposal with two and a note; ceilings respected) → implement → pass → commit.

### Task 8: Approve and edit
**Files:** `apps/worker/src/services/coach-apply.ts` (the `doc_workout` op), `apps/worker/src/services/proposal-manifest.ts` (or where manifest lines are computed), `packages/ui` hook for "Edit before approve"; tests.
- Approve all or some through `createDocWorkout` / `reviseDocWorkout`, watch / calendar writes queued as approvals do today (the drain); manifest lines from the documents; a stale base refuses that op only; Edit before approve opens the draft in the Studio builder and saving there approves the edited version (`basedOn: { kind: "proposal" }`).
- [ ] Failing tests (partial approve; stale op refused, others applied; manifest lines; edit-approve) → implement → pass → commit.

**Batch 3A end:** gates; audit (agent loop correctness, budgets, cost, security of untrusted text, Review Focus 1–5); fixes; re-review.

## Batch 3B — the surfaces

### Task 9: Composer and the run view
**Files:** `packages/ui/src/screens/studio/composer.tsx`, `studio/run-view.tsx`, `studio/proposal-card.tsx` (or extend the coach panel's ProposalCard for `doc_workout`), the Plan coach sheet link; tests.
- Per spec §10: composer at the top of the Studio (text, Now, Later today, scope menu); the run view (events live — poll every 2 s while a step runs; each line expands; question card with chips + free text; proposal card with the review's scores and changes, Approve / Edit / Decline; cost; failure and fallback lines); the client step loop with backoff; resume on reopen.
- [ ] Failing tests (component renders for each run status; question answer posts; fallback offers programme session / template / quick start when out of credits) → implement → pass → commit.

### Task 10: Settings → Coach and memory v2
**Files:** `packages/ui/src/screens/settings.tsx` (a Coach section: default scope, N, training times, ceilings, model shown), `settings/coach-memory.tsx` (list, edit, pin, delete, confidence shown); server routes for preferences.coach and memory v2; a one-time, dry-run-first move of profile-shaped memories into the profile (admin route, owner data — dry run report first); tests.
- [ ] Failing tests → implement → pass → commit.

### Task 11: The objectives board
**Files:** `packages/ui/src/screens/studio/objectives.tsx` (+ cards, the trend chart via the existing chart kit), objective add / edit / pause / complete; tests.
- Per spec §11 (gentle gamification; evidence quality shown; the coach's one-line note).
- [ ] Failing tests → implement → pass → commit.

**Batch 3B end:** gates + e2e (composer → scripted run → proposal → approve → on the Plan); screenshot QA; audit; fixes; deploy (no schema change).

## Batch 3C — live

### Task 12: Go live
- Probe the gateway for the model id (`scripts/probe-gateway-model.mjs`), set `AI_DESIGN_MODEL`, deploy; one live "now" run from the browser as a smoke test; record cost and latency.

### Task 13: The live scenario suite and the audits
- Rehearsal runs (`rehearsal: true`, never shown in the app) for the scenario suite in spec §13 (≈ 12 scenarios, budget ≈ $8, checked against the weekly spend before each run); capture each run's context, tool calls, events, draft, review and proposal into the git-ignored ledger (personal data: never into the repo).
- Audits: (a) expert-coach quality against principles §2; (b) the context against interview-style agentic-design principles (programme §10.2); (c) a scenario red-team of the built system (principles §10); (d) the owner's original request, verbatim, theme by theme (programme §10.1).
- Fix wave; re-run the failing scenarios; record survival, cost and latency per scope in the ledger.
