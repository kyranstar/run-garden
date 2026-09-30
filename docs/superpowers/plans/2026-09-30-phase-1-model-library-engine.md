# Phase 1 — Unified Model, Exercise Library and Session Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the standalone exercise tool's library and engine into two pure TypeScript packages with a condition-profile contract, and add the additive database model the later phases build on — with no visible behaviour change.

**Architecture:** `@rg/exercise-library` (data, profiles, validation) and `@rg/session-engine` (pure functions over an explicit `EngineData`), ported module by module with their tests; then hand-authored migrations, Drizzle schema, domain schemas and registry wiring in the worker.

**Tech Stack:** TypeScript (strict), vitest, zod, Drizzle/D1, pnpm workspaces (source-consumed packages, no build step).

**Spec:** `docs/superpowers/specs/2026-09-30-phase-1-model-library-engine-design.md` (authority: `docs/superpowers/specs/2026-09-30-one-workout-system-design.md`).

**Port source (read-only, local):** `/Users/kyranadams/src/tmj_tool` — `data/*.js`, `data/exercises/*.js`, `engine/*.js`, `js/recorder.js`, `js/units.js`, `tests/*.test.js`, `tests/fixtures.js`, `tests/load.js`. Never copy `sources` fields, URLs or creator names out of it. Never modify it.

## Global Constraints

- New packages follow the existing `@rg/*` pattern: `packages/<name>/package.json` with `"name": "@rg/<name>"`, `"type": "module"`, `"main": "src/index.ts"`, `"types": "src/index.ts"`, scripts `typecheck: "tsc --noEmit"`; a `tsconfig.json` extending the repo base exactly like `packages/scheduling/tsconfig.json`; tests under `packages/<name>/test/*.test.ts` picked up by the root `vitest.config`/workspace (check how `packages/scheduling` is registered and copy it).
- Tests run on the default Node 21 (`node -v` → v21.x): `pnpm vitest run packages/<name>`; full gates `pnpm -r typecheck`, `pnpm test`, `pnpm build:web`.
- TypeScript strict; no `any` except at JSON boundaries with a comment.
- The engine is pure: no `Date.now()`, no `new Date()` without an argument, no `Math.random()`, no I/O. The date is always an input.
- The engine source never contains the strings `tmj`, `jaw`, `clench` (a test enforces it); condition words come from profiles.
- Standalone behaviour is preserved exactly except the five deliberate changes in the Phase 1 spec §5. Ported tests keep their standalone test names.
- No personal data: the library carries no `sources`, URLs or creator handles; location presets carry no implement weights.
- Migrations are hand-authored (`packages/database/migrations/NNNN_name.sql`), never `pnpm db:generate`.

## Review Focus

1. **A library record missing a rating for a profile, or a `text.conditions` note** — validation must fail loudly, not let the engine read `undefined` as 0 (which would make every move look safe). Pinned in Task 2.
2. **An engine built with no active profile** — must never throw on `ex.conditions[...]`, must drop the care block and renormalise, and must produce reasons with no condition words. Pinned in Task 9.
3. **A history session with an exercise id no longer in the library** (renamed via `legacyIds`, or removed) — resolves or is ignored, never throws. Pinned in Tasks 4 and 8.
4. **Weights typed in mixed units across sessions** (`25 lb` one day, `12 kg` the next) — progression compares in kg with the 0.05 kg tolerance and suggests in the unit last used. Pinned in Task 5.
5. **Two sessions on the same day** — theme not repeated; "earlier today" wording; new-move-of-the-week logic unaffected. Pinned in Task 6.

---

### Task 1: `@rg/exercise-library` scaffold, vocabularies, formats, themes, targets, skeletons, presets, profile contract, TMJ profile

**Files:** create `packages/exercise-library/{package.json,tsconfig.json}`, `src/{vocab,formats,themes,targets,skeletons,equipment,index}.ts`, `src/conditions/{types,tmj,index}.ts`; tests `test/profile-tmj.test.ts`, `test/skeleton.test.ts`.

**Interfaces (produces):** everything in Phase 1 spec §2 for these files, and the `ConditionProfile` contract of spec §4.1 verbatim; `skeletonFor(mode, careProfiles)`; `makeEngineData({activeProfiles, careProfiles, exercises})` (exercises passed in; Task 2 supplies `EXERCISES`).

- [ ] Port `data/vocab.js`, `formats.js` (drop `maxClench`), `themes.js` (add `profile: "tmj"` to `jawReset`), `targets.js` (`coreFamilies`, base coverage targets without `regions.jaw`, `modes` without clench/neck/faceDown caps, with `allowExternalLoad: false` for recovery), skeleton tables with block id `care` in place of `jaw`, `equipment.js` (presets without weights).
- [ ] TMJ profile: every rule in spec §4.2 with the standalone thresholds (`never`: clench ≥ 3; `fitsMode` recovery 1/1/no faceDown, consistent and build 2/2; `fitsFormat` circuit/ladder/flow ≤ 1, straight/superset/holds ≤ 2; `allowPattern` push-v only in build with an answered pre ≤ 2; `coreCandidate` clench ≤ 2; `blockAssignable` not push-v; `flareSafe`; `recoveryReason` in the standalone order with its exact strings; `buildChecks` = the standalone checks 1–3 with exact strings; `buildLabel` "Jaw calm (N)"; `holdReason`; `stepDownCause`; `entryClean`; `quietPhrase` "with a quiet jaw"; `flagPenaltyWeight` 2; `rotateReason` "clenched in 2 of the last 3 sessions"; `calmStreakLabel` "calm-jaw"; `care.block` label "Jaw care", roles `["jaw-care"]`, formats `["holds"]`, min/max from `blockMin`/`blockMax.jaw`; `care.coverageTargets` `{regions:{jaw:4}}`).
- [ ] Tests: table-driven checks of each TMJ rule against the standalone numbers; `skeletonFor` with TMJ equals the standalone shares exactly (block `care` = standalone `jaw`); with no care profile the shares sum to 1 and the ratios among the remaining blocks equal the standalone ratios.
- [ ] Gates; commit `feat(library): @rg/exercise-library — vocabularies, formats, skeletons and the TMJ condition profile`.

### Task 2: Exercise records and validation

**Files:** create `src/exercises/*.ts` (one per standalone file), `src/define.ts` (`defineExercises`), `src/validate.ts`; tests `test/validate.test.ts`, `test/coverage-presets.test.ts`, `test/no-provenance.test.ts`.

- [ ] Convert the 120 records mechanically with a throwaway script (run it, commit only its output; do not commit the script): `jaw` → `conditions.tmj`, `text.jaw` → `text.conditions.tmj`, drop `sources`, keep every other field and value byte-for-byte, typed `ExerciseRecord`.
- [ ] `validateLibrary` ports `Lib.validate` plus the spec §3.3 additions; `EXERCISES` exported; coverage per preset × mode ported from `data.test.js` with TMJ active + cared-for; `no-provenance.test.ts` fails on `http`, `www.`, `instagram`, `@` anywhere in `src/exercises`.
- [ ] Review Focus 1: a test builds a copy of one record without `conditions.tmj` and asserts `validateLibrary` reports it.
- [ ] Gates; commit `feat(library): the 120 exercise records, validated, with no provenance`.

### Task 3: Weights in `@rg/domain`

**Files:** create `packages/domain/src/weights.ts`, export from `packages/domain/src/index.ts`; modify `packages/domain/src/preferences.ts` (`weightUnit`, `equipmentWishlist`); test `packages/domain/test/weights.test.ts`.

- [ ] Port `js/units.js` and `tests/units.test.js` (rename `Units.*` → `parseWeight`, `toKg`, `weightInUnit`, `formatWeight`, `formatWeightIn`, `parseWeightList`, `sameWeight`; `LB_TO_KG = 0.45359237`). Where a ported assertion depends on the old 2.20462 factor, update the expected value and note it in the commit body.
- [ ] Preferences: `weightUnit: z.enum(["lb","kg"]).default("lb")`, `equipmentWishlist: z.array(z.string()).default([])`; a test that parsing `{}` yields both defaults.
- [ ] Gates; commit `feat(domain): weights kept as typed — lb or kg, compared in kg`.

### Task 4: Engine scaffold — types, rng, lib, hist, coverage

**Files:** create `packages/session-engine/{package.json,tsconfig.json}`, `src/{types,rng,lib,hist,coverage,index}.ts`; tests `test/engine-lib.test.ts`, `test/engine-coverage.test.ts`, `test/fixtures.ts` (port `tests/fixtures.js` to the `HistorySession` shape of spec §4.3), `test/no-condition-words.test.ts`.

- [ ] `types.ts`: `EngineData` (re-exported from the library), `HistorySession`, `HistoryEntry`, `CheckReading`, `Mode`, `Plan`, `Step`, `Target`, `EngineInput` (`today, mode?, theme?, minutes, location {id, equipment, implements}, unit, sessions, prefs {ratings, excluded, pinned}, savedIds, block, checks: Record<profileId, CheckReading>, swaps`).
- [ ] `lib.ts` = `Lib` with `data: EngineData` as the first parameter of every function (or a `makeLib(data)` closure — pick one and use it everywhere); `fitsMode` = general + every active profile's `never`/`fitsMode`/`allowPattern`.
- [ ] `hist.ts`, `coverage.ts`, `rng.ts` ported; dates via `@rg/domain` helpers (`addDays`, `startOfIsoWeek`, a pure `daysBetween`).
- [ ] Port `engine-lib` and `engine-coverage` tests; Review Focus 3 (unknown / legacy id in history resolves or is ignored).
- [ ] `no-condition-words.test.ts`: reads every file under `packages/session-engine/src` and fails on `/tmj|jaw|clench/i`.
- [ ] Gates; commit `feat(engine): @rg/session-engine scaffold — library lookups, history, coverage`.

### Task 5: Progression and the day's proposal

**Files:** `src/prog.ts`, `src/proposal.ts`; tests `test/engine-prog.test.ts`, `test/engine-proposal.test.ts`.

- [ ] Port `prog.js` with profile hooks (spec §4.2 rows for Prog) and weights from `@rg/domain`; port `proposal.js` with `recoveryReason`/`buildChecks`/`buildLabel` hooks and the general checks after them.
- [ ] Port both test files; add Review Focus 4 (mixed-unit history) and the spec §5 change 3 ("earlier today" vs "yesterday").
- [ ] Gates; commit `feat(engine): progression and the day's proposal, condition rules behind profiles`.

### Task 6: Blocks and selection

**Files:** `src/blocks.ts`, `src/select.ts`; tests `test/engine-blocks.test.ts`, `test/engine-select.test.ts`.

- [ ] Port with `coreCandidate`, `blockAssignable`, `rotateReason`, `flagPenaltyWeight`; `saved` term reads `input.savedIds`.
- [ ] Port both test files; add spec §5 change 2 (no same-day theme repeat) where `Proposal.theme` is exercised; Review Focus 5.
- [ ] Gates; commit `feat(engine): core-lift blocks and scored selection`.

### Task 7: The builder and formats

**Files:** `src/builder.ts`; tests `test/engine-builder.test.ts`, `test/engine-formats.test.ts`.

- [ ] Port `builder.js`: the `care` block from the composed skeleton (§4.4); `accepts` uses `profile.fitsFormat`; `calmEnough` becomes the profiles' `allowPattern` (answered pre required — spec §5 change 1, with its own test); `build` returns `{ …plan, alternatives: Record<slotKey, Alternative[]> }` computed once per build (top 3 per slot, each with its expanded steps) so the player can swap offline.
- [ ] Port both test files; the 40-minute mat-only fill-rate note from the standalone tests stays an assertion at its current threshold.
- [ ] Gates; commit `feat(engine): the time-fitted builder, formats and precomputed swap alternatives`.

### Task 8: Records, the planner and the recorder

**Files:** `src/records.ts`, `src/planner.ts`, `src/recorder.ts`; tests `test/engine-records.test.ts`, `test/engine-planner.test.ts`, `test/recorder.test.ts`.

- [ ] `records.ts` with `calmStreakLabel`; `planner.ts` becomes a pure `planToday(input, programState)` returning `{ view, blockUpdate }` (no persistence; the worker persists); graduation offers and `acceptGraduate` preserved; swaps keep the original `from`.
- [ ] `recorder.ts` ported with `flags` instead of `clenched`; `toSession` emits the `performedSessionSaveSchema` shape (spec §6) with `checks` per profile; review decisions (ratings, graduations) returned as a pending change set (spec §5 change 4); unknown/removed ids tolerated (Review Focus 3).
- [ ] Port the three test files (recorder regressions: half-time holds, propagation to untouched sets, rebase on swap, swap-of-swap keeps `from`, withdrawn graduation pruned — now a unit test, typing during rest kept in the live state).
- [ ] Gates; commit `feat(engine): records, the day planner and the session recorder`.

### Task 9: Simulation, no-profile behaviour, and the port audit

**Files:** tests `test/simulation.test.ts`, `test/no-profile.test.ts`, `test/port-parity.test.ts`.

- [ ] Port `simulation.test.js` (3 seeds × 84 days × 6 properties) against the ported engine with TMJ active and cared-for.
- [ ] `no-profile.test.ts` (Review Focus 2): build a week of sessions with no active profile — no throw, no `care` block, skeleton renormalised, proposal reasons from general rules only, no condition words in any reason or note.
- [ ] `port-parity.test.ts`: a list of the 219 standalone test names (from `node --test --test-reporter=spec` output of the standalone suite, captured once into the test file as a literal array) and a check that each has a same-named vitest test across the ported files, except the named Phase 2 files (`stats`, `store`).
- [ ] Gates; commit `test(engine): the 12-week simulation, no-profile behaviour and a port-parity check`.

### Task 10: Migrations, schema, domain schemas, registry (orchestrator worktree, after Phase 0's Task 7)

**Files:** `packages/database/migrations/0023_programs.sql`…`0026_exercise_settings.sql` (spec §6), `packages/database/src/schema/{programs,performed}.ts` (+ barrel export), `packages/domain/src/{program,performed}.ts`, `apps/worker/src/services/account-tables.ts` (register the new tables), `apps/worker/src/routes/misc.ts` (`deleteAllUserData` via the registry), tests: `delete-all-data.test.ts` stays green; `account-tables.test.ts` covers the new tables; a schema round-trip test inserting and selecting one row per new table.

- [ ] Write the four migrations exactly as spec §6; Drizzle tables to match; zod schemas; registry entries (`performed_sets` child of `performed_sessions`; `program_versions`, `program_blocks` children of `programs`).
- [ ] Gates; commit `feat(db): programs, builds, performed sessions, checks and per-user exercise settings (additive)`.

### Task 11: COROS catalog enrichment

**Files:** `packages/coros/src/snapshot.ts` (~246), `apps/worker/src/services/exercise-catalog.ts`; tests in `packages/coros/test` and `apps/worker/test/exercise-catalog.test.ts`.

- [ ] Keep `muscle`, `part`, `equipment` (arrays, default `[]`), `exerciseType`, `targetType` in the snapshot item and in `raw`; `catalogMeta(id)` accessor. A mock catalog item carrying those keys round-trips into `raw`.
- [ ] Gates; commit `feat(coros): keep the catalog's muscle, part and equipment tags`.

## Self-Review

- Spec coverage: §2 packages (1, 4), §3 library + validation (1, 2), §4 contract + mapping + history shape + skeleton (1, 4–8), §5 behaviour changes (5, 6, 7, 8), §6 data model + domain (3, 10), §7 test port (2, 4–9), §8 catalog (11).
- Tasks 1–9 touch only new packages plus `packages/domain/src/{weights,preferences,index}.ts`; they can run in their own worktree in parallel with Phase 0 and merge with no overlap except `pnpm-lock.yaml` (regenerate with `pnpm install` on merge).
- Task 10 depends on Phase 0 Task 8 (the registry) and takes migration numbers after Phase 0's `0022`.
