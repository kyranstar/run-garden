# Phase 2d — Progress, Activity and the Garden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App sessions and imported history show up in Activity and Progress with their logged sets and check values; app sessions grow the garden on the right axis; imported history never changes a past garden; the third axis reads "Yoga & mobility".

**Architecture:** An input-side epoch gate in `buildDayInput` (the `DEW_EPOCH` pattern) plus an `import` exclusion at every activity read; activity DTO enrichment from `performed_sessions`; new analytics metrics (`conditionTrend`, `weeklyStrengthVolume`, `liftTopSets`) returning `MetricResult`; Activity tiles per mocks.

**Tech Stack:** Hono/D1, `@rg/analytics`, `@rg/garden-engine` (unchanged), React, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-2-adaptive-program-design.md` §2d. Mocks §8: https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z.

## Global Constraints

- `SIMULATION_VERSION` is not bumped. The garden engine package is not changed.
- `APP_SESSION_EPOCH` is a `LocalDate` constant next to `DEW_EPOCH` in `apps/worker/src/services/garden-sync.ts`, set to the date this slice merges.
- Every metric returns `MetricResult` with honest `insufficient_data`.
- Weights display as typed; volume counts both sides of a one-sided move.
- Only display strings change for the third axis ("Yoga & mobility"); ids, keys and the garden's `yoga` discipline stay.

## Review Focus

1. **A full-history resim after importing a year of standalone history** — the garden state and event stream are byte-identical to before the import. Task 1.
2. **An app session recorded on the epoch day and one the day before** (a clock-skewed device) — only the on/after-epoch one credits. Task 1.
3. **A merged session (app + watch)** — Activity shows one row with the watch's HR and the app's sets; the garden counts it once. Task 2.
4. **A week with only one paired pre/post check** — the condition tile says it needs more sessions, never shows a trend. Task 3.
5. **Mixed-unit logs for one lift** — the lift tile's series is in kg internally and labels in the unit last used. Task 3.

---

### Task 1: The garden gates

**Files:** modify `apps/worker/src/services/garden-sync.ts` (`APP_SESSION_EPOCH`; exclude `activities.source = 'import'` at the unplanned-session, adventure and dew reads; exclude `app` rows dated before the epoch at the same reads and in the completed-slot path's activity lookup); tests `apps/worker/test/garden-app-sessions.test.ts`.

- [ ] Failing tests: Review Focus 1 (seed a garden, hash state + events via the parity helpers from Phase 0 Task 12, import synthetic history spanning the past year, full resim, hashes equal); Review Focus 2; a post-epoch strength session credits Lift and a mobility session credits the third axis; an imported session on a day with no other activity leaves that day's inputs unchanged.
- [ ] Implement; gates; commit `feat(garden): app sessions grow the garden; imported history never changes it`.

### Task 2: Activity feed — app, merged and imported sessions

**Files:** modify the activities DTO (`routes/misc.ts` activity routes or wherever the feed is served) to attach `{performed: {mode, theme, checks, entries:[{exerciseId, name, sets:[{w, reps, secs, side}]}]}}` when a performed session references the activity; modify `packages/ui/src/screens/runs.tsx` row + inline expansion per mocks §8; tests.

- [ ] Failing tests incl. Review Focus 3 and an imported session rendering (no HR, "Imported" source note in the expansion only); implement; screenshot matrix; gates; commit `feat(activity): logged sets and check values in the feed`.

### Task 3: Progress metrics and tiles

**Files:** create `packages/analytics/src/strength.ts` (`weeklyStrengthVolume`, `liftTopSets`), `packages/analytics/src/condition.ts` (`conditionTrend`: 8-week pre vs post means, flare days by the profile's flare rule, `insufficient_data` below 4 paired sessions); wire into the insights payload; tiles in `runs.tsx` per mocks; tests.

- [ ] Failing tests incl. Review Focus 4 and 5; implement; screenshot matrix; gates; commit `feat(insights): the condition trend, weekly volume and lift tiles from logged sets`.

### Task 4: "Yoga & mobility"

**Files:** every display site of the third axis label (`packages/analytics/src/discipline.ts` `disciplineLabel`, `packages/ui` garden/codex/components/runs/arrival and any other hit of the literal "Yoga" as an axis label; category labels for a yoga *session* stay "Yoga"); tests updated.

- [ ] Grep for the label, change display strings only, update snapshot/text tests, confirm the balance meters fit at 360 px (screenshot); gates; commit `feat(ui): the third garden axis is "Yoga & mobility"`.

### Task 5: Flip the gates and run the parallel-run checklist

- [ ] `features.import = true` (2c import UI becomes reachable), confirm `features.player = true` (2b).
- [ ] Write `docs/reports/2026-09-30-parallel-run-checklist.md` (generic): how the owner imports, what numbers to compare with the standalone Progress tab, how to report a mismatch, and the two-week window (D8).
- [ ] Gates; commit `chore(programs): open the import and the player; parallel-run checklist`.

## Self-Review

- Spec §2d coverage: garden gate (1), feed (2), progress tiles (3), axis label (4); the D8 parallel run starts after 5.
