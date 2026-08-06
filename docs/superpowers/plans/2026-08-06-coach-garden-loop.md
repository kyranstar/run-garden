# Coach × Garden Loop (Plan C of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fair incentives per `docs/superpowers/specs/2026-08-06-coach-garden-loop-design.md`: sanctioned rest (1/rolling week), the coach speaking garden sparingly, and the Keystone pine — the suite's only engine change (`SIMULATION_VERSION` 4 → 5).

**Architecture:** Sanction is a workout-row marker flowing into day inputs (builder-side mercy math, engine untouched for §1); block completion is a deterministic per-day derivation; the new gate/counter/species ride the standard versioned-resim path.

## Global Constraints
Node 21 tests; specific-path git add; engine change confined to Task C3 (one version bump); canon copy tone; commit per task; ship at the end (local wrangler deploy if Actions is still reaping runs — no new migration beyond C1's).

---

### Task C1: the sanction marker
**Files:** `packages/database/src/schema/schedule.ts` (+`sanctionedBy` text nullable on planned_workouts) → migration 0011; `apps/worker/src/services/coach-apply.ts` (skip op sets `sanctionedBy: "coach"`); the unskip route clears it; tests in `coach-apply.test.ts` + the unskip suite.
**Produces:** `plannedWorkouts.sanctionedBy: "coach" | null`.

### Task C2: mercy in the day-input builder
**Files:** `apps/worker/src/services/garden-sync.ts` (`buildDayInput`); test `apps/worker/test/garden-sanction.test.ts`.
**Rules:** sanctioned skips are excluded from `missedRuns` always; the FIRST sanctioned skip resolving in any rolling 7 days (count prior sanctioned resolutions in `[date-6, date)` — zero → this is the mercy day) additionally sets `restObserved = true` unless the day has completions. Unsanctioned skips unchanged. Matrix test: first-in-week → rest; second-in-week → neutral (no debt, normal decay); unsanctioned → debt; mercy day with a completed run → completions win, no restObserved, still no debt.

### Task C3: engine v5 — coached blocks + Keystone pine
**Files:** `packages/garden-engine/src/{types,species,unlocks,simulate}.ts`; renderer test count updates; engine tests.
**Produces:** `SIMULATION_VERSION = 5`; `state.coachedBlockCount` (`??= 0`); `GardenDayInput.coachedBlockCompleted?: boolean` → counter increments before unlock evaluation; gate `{kind:"coached_blocks"; count}` (satisfied/describe/progress: "See a coached block through, start to finish" / "{n} coached blocks completed"); species `keystone_pine` (tree, rare, coached_blocks:1, tree_conifer, palette `#4a6e52/#6b4a32/#caa25a`) and `keystone_grove` (tree, rare, coached_blocks:3, tree_round, palette `#5a7d56/#7a5c40/#8fb7a0`) — 55 → 57 species, archetypes stay 21. Replay determinism suite green; v4-shaped snapshot simulates (missing counter defaults).

### Task C4: block completion detection
**Files:** `garden-sync.ts` `buildDayInput` (flag derivation) + the hourly cron (status flip active→completed past endDate, with a coach receipt); tests.
**Rule (deterministic, status-independent):** `coachedBlockCompleted = true` on date D iff a coach plan (status ≠ draft/retired) has `endDate === D-1` AND block adherence ≥ 0.85, where adherence = completed ÷ (completed + skipped + missed) over the plan's non-rest workouts in [startDate, endDate], **excluding coach-sanctioned skips from the denominator** (mercy never tanks the block). Cron flip adds receipt "Block complete: {name} — {adh}% adherence."

### Task C5: the coach speaks garden + mercy awareness
**Files:** `coach-context.ts` (MILESTONES → garden line: condition word, weather, days-since-run, chain, forecast stage, nearest unlock; OPEN ITEMS → "sanctioned rest used N of 1 this rolling week"); `coach-wake.ts` prompt additions (garden voice: ≤1 reference per briefing, action-tied, never guilt, silent during rest mode/taper/when the forecast stage is already loss-voiced; skip proposals must state their garden treatment in the rationale). Tests: dossier fixtures; prompt string assertions.

### Task C6: verify + ship
Full suite Node 21; typecheck; push; if Actions still reaping → build web (Node 22) + `wrangler d1 migrations apply run-garden-db --remote` via the CI path if possible, else local deploy WITH the 0011 migration applied first; confirm prod version.
