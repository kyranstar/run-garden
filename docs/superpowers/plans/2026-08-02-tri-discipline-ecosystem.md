# Tri-Discipline Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the tri-discipline ecosystem (spec: `docs/superpowers/specs/2026-08-02-tri-discipline-ecosystem-design.md`): running, lifting, and yoga imported from COROS, each feeding a distinct garden axis, with balance mechanics, new unlocks, and a standard cross-discipline UX — shipped to prod.

**Architecture:** Additive changes along the existing pipeline: bridge admits more sportTypes → providers classify them → worker ingests and tags `discipline` → engine runs three recency clocks driving water/earth/life axes → API exposes balance → UI generalizes the activity log and adds a BalanceStrip. All engine state lives in the self-healing JSON snapshot (no DB migration).

**Tech Stack:** existing monorepo (TypeScript, Hono worker, React, Drizzle/D1, vitest).

## Global Constraints

- **Node:** tests under Node 21 (machine default); builds/wrangler/typecheck-workspace under Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`). NEVER run `pnpm test` under Node 22.
- **Test commands:** package-scoped `pnpm --filter <pkg> exec vitest run`; full workspace `pnpm test` (Node 21); workspace typecheck `pnpm typecheck` (Node 22).
- **Git:** stage specific paths; commit exits 137 → `git write-tree`/`git commit-tree`/`git update-ref`. Branch: `tri-discipline-ecosystem`.
- **No new dependencies.**
- **Determinism:** engine stays pure/deterministic; new state fields self-heal via `??=` (existing pattern, simulate.ts:163-165 area). Bump `simulationVersion` once (Task 3).
- **Honesty rules:** yoga is never penalized as "missed" (no yoga plans exist); copy is gentle everywhere ("misses", "moves on for now" — never punishing).
- **Discipline colors:** run = existing greens; lifting = terracotta `#b5652f` family; yoga = violet `#8f6fae` family.
- **Backward compat:** stored `GardenDayInput`s lack `discipline` → default `"run"`. Old snapshots must replay without throwing.
- **Existing choke points to remove** (from the exploration map): bridge run filter `services/coros-bridge/src/snapshot.ts:88`; worker unplanned filter `apps/worker/src/services/garden-sync.ts:186`; UI filter `packages/ui/src/screens/runs.tsx:149`.

---

### Task 1: Domain + classify + matching — yoga becomes a category

**Files:**
- Modify: `packages/domain/src/workout.ts` (WORKOUT_CATEGORIES)
- Modify: `packages/scheduling/src/classify.ts`
- Modify: `packages/providers/src/matching.ts`
- Test: `packages/scheduling/test/classify.test.ts`, `packages/providers/test/matching.test.ts` (append; read the existing files first and follow their fixture patterns)

**Interfaces produced:** `WorkoutCategory` includes `"yoga"`. `classifyWorkout` returns `yoga` for yoga-named/sport workouts. Matching treats yoga as a non-run sport bucket.

- [ ] **Step 1: Append failing tests.** In classify tests: a workout named "Morning Yoga" → category `"yoga"`; named "Hip mobility" → `"yoga"`; named "Stretch session" → `"yoga"`; sport `"yoga"` with any name → `"yoga"`; ensure "Strength" still → `"strength"` (no regression). In matching tests: a planned workout with category `"yoga"` scores the sport point against an activity with sport `"yoga"` (mirror the existing strength/cross_training sport-score test pattern at matching.ts:46-49).
- [ ] **Step 2: Run to verify failure.** `pnpm --filter @rg/scheduling exec vitest run` and `pnpm --filter @rg/providers exec vitest run`.
- [ ] **Step 3: Implement.** `workout.ts`: add `"yoga"` to `WORKOUT_CATEGORIES` (before `"rest"`). `classify.ts`: add name rule `{ re: /\byoga\b|\bmobility\b|\bstretch/i, category: "yoga" }` ABOVE the cross-training rule (line ~32); add `const YOGA_SPORTS = new Set(["yoga"])` and a sport-hint branch mirroring the strength one (`if (YOGA_SPORTS.has(sport)) return { category: "yoga", basis: "hint" };` next to line 68). `matching.ts:47`: `!["cross_training", "strength", "yoga"].includes(w.category)`.
- [ ] **Step 4: Run both suites green.** Then `pnpm test` (Node 21) to catch any exhaustive-switch fallout across the workspace (e.g. category→label maps); fix any site that fails to compile/test by adding the yoga case following that site's local pattern — list each such site in your report.
- [ ] **Step 5: Typecheck + commit.** `pnpm typecheck` (Node 22). Commit: `feat(domain): yoga workout category with classify + matching support`.

---

### Task 2: Providers + bridge — admit strength/yoga sportTypes, count skips

**Files:**
- Modify: `packages/providers/src/coros/raw-types.ts`
- Modify: `services/coros-bridge/src/snapshot.ts`
- Modify: the snapshot payload type + its worker-side zod schema (find via `grep -rn "skippedSportTypes\|activities" packages/domain/src/*.ts apps/worker/src --include="*.ts" -l` — the bridge snapshot upload schema; add the new OPTIONAL field where the payload is typed/validated)
- Test: `packages/providers/test` (raw-types/normalize test file), `services/coros-bridge/test/protocol.test.ts` + `mock-coros-server.ts`

**Interfaces produced:**
```ts
// raw-types.ts
export const COROS_GARDEN_SPORT_TYPES: ReadonlyMap<number, "run" | "strength" | "yoga">;
// = 100→run, 101→run, 102→run, 103→run, 402→strength, 403→yoga, 904→yoga
// corosSportName: 403 and 904 → "yoga" (before the >=400 cardio branch)
// snapshot payload: skippedSportTypes?: Record<string, number>
```

- [ ] **Step 1: Append failing tests.** raw-types: `corosSportName(403) === "yoga"`, `corosSportName(904) === "yoga"`, `corosSportName(402) === "strength"` (existing, keep), unknown `corosSportName(555)` → `"coros_555"`. Bridge protocol test: add a strength activity (sportType 402) and a yoga activity (sportType 904) to the mock server's activity list; assert the snapshot now contains those two plus the run, still excludes the bike (sportType 200), and reports `skippedSportTypes` containing `{"200": 1}`.
- [ ] **Step 2: Run to verify failure.** `pnpm --filter @rg/providers exec vitest run`; `pnpm --filter @rg/coros-bridge exec vitest run`.
- [ ] **Step 3: Implement.** raw-types: add the map + corosSportName branches (`if (sportType === 403 || sportType === 904) return "yoga";` before the 400/401 check). snapshot.ts: replace the line-88 `continue` filter with: look up `COROS_GARDEN_SPORT_TYPES`; admitted → fetch detail + normalize as today; not admitted → increment a local `skipped[String(item.sportType)]` counter and continue. Attach `skippedSportTypes: skipped` to the snapshot payload (optional field; only when non-empty). Extend the payload type + worker-side zod schema with the optional field, and in the worker's snapshot-ingest handler log it (`console.warn("coros: skipped sportTypes", …)` following the worker's existing logging style) so unknown codes are discoverable in ops.
- [ ] **Step 4: Run both suites + full `pnpm test` green.**
- [ ] **Step 5: Typecheck + commit.** `feat(coros): admit strength and yoga activities; count skipped sportTypes`.

---

### Task 3: Engine — discipline clocks, axis effects, wildlife switch

**Files:**
- Modify: `packages/garden-engine/src/types.ts`, `packages/garden-engine/src/simulate.ts`
- Test: `packages/garden-engine/test/` (find the simulate test file; append a new describe block)

**Interfaces produced (Tasks 4–6 depend on these exact names):**
```ts
// types.ts — EngineGardenState additions
daysSinceStrength: number;
daysSinceYoga: number;
strengthSessionCount: number;
yogaSessionCount: number;
balancedWeekCount: number;
/** Discipline flags for the in-progress Mon–Sun week. */
weekDisciplines: { weekStart: LocalDate; run: boolean; strength: boolean; yoga: boolean };
// CompletedRunInput addition
discipline?: "run" | "strength" | "yoga"; // default "run"
```

**Exact semantics to implement in simulate.ts (locate each site by reading the day-processing function top to bottom):**

1. **Self-heal** (existing `??=` block): all five new numeric fields `??= 0`; `weekDisciplines ??= { weekStart: <Monday of the day being simulated>, run: false, strength: false, yoga: false }`. Write a local `mondayOf(date: LocalDate): LocalDate` helper using the domain's existing date utilities (`addDays`, day-of-week — check `packages/domain/src/time.ts` for what exists; do not hand-roll UTC math if a helper exists).
2. **Discipline sets for the day:** `const disc = (r: CompletedRunInput) => r.discipline ?? "run";` `hasStrength = runs.some(r => disc(r) === "strength")`; `hasYoga = runs.some(r => disc(r) === "yoga")`. **Run-clock completions become run-discipline only:** everywhere the current code computes planned-run presence for the run clock, weather `ranToday`, and comeback logic (`plannedRuns` per the map: simulate.ts:190, 210-213, 259-266, 312-320), filter to `disc(r) === "run"`. This intentionally changes strength-category behavior (it no longer brings rain) — that is the spec's redefinition; note it in your report.
3. **Clocks:** run clock unchanged mechanics (now run-only). `daysSinceStrength = hasStrength ? 0 : daysSinceStrength + 1` (skip increment when `restModeActive`); same for yoga. Increment sites mirror wherever `daysSinceCompletedRun` increments today.
4. **Session effects (planned AND unplanned, unlike run planting rewards):** for each strength session: `strengthSessionCount++`, `soilHealth = min(1, soilHealth + 0.05)`, `moisture = min(1, moisture + 0.08)`. For each yoga session: `yogaSessionCount++`, `biodiversity = min(1, biodiversity + 0.04)`, `floweringDensity = min(1, floweringDensity + 0.03)`, `moisture = min(1, moisture + 0.08)`. Add a `"yoga"` case to the category switch (no planting); keep `cross_training` as the modest-support case; the `strength` case's effects move to the per-session logic above (avoid double-applying if a strength session is both planned and in the switch — apply axis effects exactly once per session).
5. **Decay (apply where existing daily decay runs; skipped when `restModeActive` or `planGap`):** if `daysSinceStrength > 7`: `soilHealth = max(0.2, soilHealth − 0.02)`. If `daysSinceYoga > 7`: `biodiversity = max(0.15, biodiversity − 0.015)` and `floweringDensity = max(0.15, floweringDensity − 0.015)`.
6. **Tree growth coupling:** in `applyLongRun`'s tree maturity advance, scale the advance by `0.5 + 0.5 * soilHealth`.
7. **Wildlife decline switch:** in `evaluateWildlife` (simulate.ts:637 area), `inDecline` becomes `min(daysSinceCompletedRun, daysSinceStrength, daysSinceYoga) >= cfg.dormancyStartDays || s.restMode`.
8. **Weekly flags:** at the top of each simulated day: `const wk = mondayOf(date); if (wk !== state.weekDisciplines.weekStart) { if (all three flags true) balancedWeekCount++; weekDisciplines = { weekStart: wk, run:false, strength:false, yoga:false }; }` then OR-in today's disciplines after processing completions.
9. **`simulationVersion`:** bump the constant by 1.

- [ ] **Step 1: Append failing tests** (follow the existing test file's snapshot-builder pattern; build days via `simulateDay` with hand-made `GardenDayInput`s):
  - strength session (unplanned, `discipline: "strength"`) resets `daysSinceStrength`, bumps `soilHealth` +0.05 and `strengthSessionCount`, does NOT reset `daysSinceCompletedRun`, does NOT trigger rain weather.
  - yoga session bumps `biodiversity`/`floweringDensity`/`yogaSessionCount`, resets `daysSinceYoga`.
  - 8+ days without strength → soilHealth decays 0.02/day, floors at 0.2; restMode freezes the decay AND the clock; planGap skips decay but clocks still increment.
  - a run-only old-style input (no `discipline` field) behaves exactly as a run (compat).
  - long-run tree growth is slower at soilHealth 0.2 than 1.0 (compare maturity deltas).
  - wildlife: with runs fresh but strength+yoga stale ≥ dormancyStartDays, wildlife does NOT go into decline (min of clocks is fresh).
  - balanced week: a Mon–Sun with ≥1 of each discipline increments `balancedWeekCount` when the next Monday simulates; a week missing yoga does not.
  - determinism: replaying the same inputs twice yields deep-equal snapshots.
- [ ] **Step 2: Run to verify failure.** `pnpm --filter @rg/garden-engine exec vitest run`.
- [ ] **Step 3: Implement per the semantics above.**
- [ ] **Step 4: Engine suite green, then full `pnpm test`** — existing engine tests may legitimately change behavior ONLY where strength-category completions previously reset the run clock/brought rain; if any other existing test breaks, stop and report rather than adapting it.
- [ ] **Step 5: Typecheck + commit.** `feat(garden-engine): tri-discipline clocks, earth/life axes, balanced weeks`.

---

### Task 4: Engine — balance export + gentle events

**Files:**
- Modify: `packages/garden-engine/src/` (new `balance.ts` + index export), `packages/garden-engine/src/simulate.ts` (events), `packages/domain/src/garden.ts` (event kinds)
- Test: engine test file (append)

**Interfaces produced:**
```ts
// balance.ts (pure)
export interface DisciplineBalance {
  run: { days: number; health: number };
  strength: { days: number; health: number };
  yoga: { days: number; health: number };
  overall: number; // min of the three healths
}
export function disciplineBalance(state: EngineGardenState): DisciplineBalance;
// health_d = clamp01(1 - max(0, days_d - grace_d) / 14); grace: run 2, strength 3, yoga 3
```
New `GardenEventKind`s in `GARDEN_EVENT_KINDS` (domain/garden.ts:86-101): `"soil_tended"`, `"life_tended"`. Emitted in simulate when a strength (resp. yoga) session lands with prior clock ≥ 3. Find where event kinds map to history sentences (grep the worker/ui for an existing kind like `"wildlife_arrived"`) and add gentle copy: soil_tended → "Strength work fed the soil."; life_tended → "Yoga brought the meadow back to life." (match the surrounding voice; adjust wording to fit the site's style).

- [ ] **Step 1: Append failing tests:** `disciplineBalance` — all clocks 0 → all healths 1, overall 1; run 16 days stale → run health 0 (`(16−2)/14`), overall 0; grace respected (strength at 3 days → health 1); event emission: first strength after 4 stale days emits exactly one `soil_tended`; strength on consecutive days emits none the second day.
- [ ] **Step 2–4: fail → implement → green (engine suite, then `pnpm test`).**
- [ ] **Step 5: Typecheck + commit.** `feat(garden-engine): discipline balance + soil/life tended events`.

---

### Task 5: Engine — new gates and species

**Files:**
- Modify: `packages/garden-engine/src/species.ts`, `packages/garden-engine/src/unlocks.ts`
- Test: engine test file (append)

**Interfaces produced:** `UnlockGate` union += `{ kind: "strength_sessions"; count: number } | { kind: "yoga_sessions"; count: number } | { kind: "balanced_weeks"; count: number }`. `gateSatisfied`/`gateProgress`/`describeGate` handle all three (progress = counter/count clamped; describe: "Complete N strength sessions" / "Complete N yoga sessions" / "N balanced weeks — run, lift, and yoga in the same week").

Seven new species appended to `SPECIES` (read species.ts first; reuse EXISTING archetypes only — pick the closest archetype per category from what's already in the catalog; spacing/growthDays/depthBand values analogous to similar existing species):

| id | name | category | gate | palette direction |
|---|---|---|---|---|
| stonecrop | Stonecrop | groundcover | strength_sessions 5 | rust `#b5652f`/`#8a4a22`, accent `#d99a3d` |
| ironwood | Ironwood | tree | strength_sessions 12 | deep bark `#5a3d28`, rust-tinged canopy `#6b6234` |
| terrace_fern | Terrace fern | fern | strength_sessions 20 | bronze-green `#7a7038` |
| moon_lotus | Moon lotus | flower | yoga_sessions 5 | violet `#8f6fae`/`#6d4f8a`, white accent `#f2ede0` |
| meditation_moss | Meditation moss | fungus | yoga_sessions 10 | violet-grey `#8a7f96` |
| lavender_drift | Lavender drift | flower | yoga_sessions 15 | lavender `#9c8fc0` |
| harmony_willow | Harmony willow | tree | balanced_weeks 3 | silver-green `#8fae9a` |

- [ ] **Step 1: Append failing tests:** each new gate kind satisfied/unsatisfied at the boundary; `gateProgress` returns count-based fractions; `describeGate` strings match; the renderer species test that asserts catalog counts (`renderer.test.tsx`: "covers all 20 archetypes… SPECIES.length toBe(39)") will break — that count assertion lives in ANOTHER package; update the expected total to 46 there as part of this task (it is a catalog-size lock, not a behavior test), plus its archetype-count expectation only if you added no new archetypes (you must not — it stays 20).
- [ ] **Step 2–4: fail → implement → engine suite green → full `pnpm test` green** (the renderer "renders every species without throwing" test now covers the new species automatically — if a new species/archetype pairing throws, fix the pairing, not the test).
- [ ] **Step 5: Typecheck + commit.** `feat(garden-engine): strength/yoga/balance unlock gates + seven new species`.

---

### Task 6: Worker — ingest strength/yoga into the garden + balance API

**Files:**
- Modify: `apps/worker/src/services/garden-sync.ts` (buildDayInput ~lines 149-196; API payload site — find where the garden endpoint assembles its response, likely same file or the route handler)
- Modify: `packages/api-client/src/index.ts` (garden DTO)
- Test: worker test (find the garden-sync/vertical-loop test; append)

**Semantics:**
- Matched completions (the `workoutCompletionMatches` branch): tag `discipline` from the workout's category/sport: category `"strength"` or sport `"strength"` → `"strength"`; `"yoga"` → `"yoga"`; else `"run"`.
- Unplanned loop (line ~186): admit `a.sport === "run" || a.sport === "strength" || a.sport === "yoga"`, tagging discipline = the sport.
- Garden API payload: add `balance: DisciplineBalance` (import `disciplineBalance` from `@rg/garden-engine`, computed from the current snapshot state). Mirror the field into the api-client garden DTO type.

- [ ] **Step 1: Append failing tests:** buildDayInput with a day containing an unplanned strength activity + an unplanned yoga activity + an unplanned bike → completedRuns has exactly the strength and yoga entries with correct `discipline`, bike excluded; matched strength workout completion → discipline `"strength"`. Garden endpoint response contains `balance.overall` (follow the existing endpoint test pattern; worker tests need Node 21 for better-sqlite3).
- [ ] **Step 2–4: fail → implement → worker suite green → full `pnpm test` green.**
- [ ] **Step 5: Typecheck + commit.** `feat(worker): strength/yoga garden ingestion + balance in garden API`.

---

### Task 7: UI — Activity screen for all disciplines

**Files:**
- Modify: `packages/ui/src/screens/runs.tsx`, `packages/ui/src/shell.tsx` (nav label), `packages/ui/src/components.tsx` (CATEGORY_LABELS), the ui stylesheet (`styles.css`: `cat-yoga` + chip styles)
- Test: if the ui package has unit tests, append filter-logic tests; otherwise validate via typecheck + Task 9's fixture screenshots (state which applied in your report)

**Semantics:**
- Remove the `a.sport === "run"` filter (runs.tsx:149). Add filter chips above the list: `All · Runs · Lifting · Yoga` (local useState; filter by `a.sport`: runs = `"run"`, lifting = `"strength"`, yoga = `"yoga"`; All = those three — other sports (bike etc.) appear under All only). Chips styled as small pills; the active chip fills with its discipline color (run: existing accent green; lifting `#b5652f`; yoga `#8f6fae`; All: neutral).
- Row rendering: reuse the existing row; distance/pace fields render only when present (verify the existing row already guards undefined distance — if it prints "NaN km" for a strength activity, guard it).
- Nav label "Runs" → "Activity" (shell.tsx:6-12; keep the `/runs` route path — no route churn).
- `CATEGORY_LABELS` += `yoga: "Yoga"`; add `.cat-yoga { … }` CSS following the existing `cat-strength` pattern, violet `#8f6fae`.

- [ ] **Step 1–3: implement (tests-first where the package has tests).**
- [ ] **Step 4: `pnpm typecheck` (Node 22) + full `pnpm test` (Node 21) green.**
- [ ] **Step 5: Commit.** `feat(ui): activity screen with discipline filters, yoga category styling`.

---

### Task 8: UI — BalanceStrip on the garden screen

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx`, stylesheet
- Test: same policy as Task 7

**Semantics:** A compact horizontal strip above the garden readout (below the scene): three labeled mini-bars — "Run", "Lift", "Yoga" — each a 6px-high rounded track filled to `balance.<d>.health` in the discipline color, with a small muted caption `today` / `N d ago` (from `days`). One line of balance-aware copy under the strip when `overall < 0.5`: pick the weakest discipline and render e.g. "The garden misses your lifting." (map: run → "…misses your runs.", strength → "…misses your lifting.", yoga → "…misses your yoga."). Data: the garden query already fetches the payload that now includes `balance` (Task 6); thread it through the existing props/query plumbing in garden.tsx. Layout must hold at 360px wide (three bars stack horizontally with `flex: 1` and 8px gaps; captions truncate, never wrap the strip).

- [ ] **Steps: implement → typecheck + full suite green → commit.** `feat(ui): balance strip — run/lift/yoga health at a glance`.

---

### Task 9: Fixtures + deploy gate

**Files:**
- Modify: `packages/providers/src/fixtures/activities.ts` (add strength + yoga fixture activities: one 402 strength ~45min with HR, one 904 yoga ~30min, dated within the fixture window so the seeded garden has non-zero counters), plus whatever fixture plumbing feeds the dev seed (follow how the existing fixture run activities flow into `/api/dev/seed`).
- Modify: `.github/workflows/deploy.yml`
- Test: full suite; live fixture verification

**Deploy gate:** in deploy.yml's job, after dependency install and BEFORE the build/migrate/deploy steps, add typecheck + test steps mirroring ci.yml's setup (including its Node-version matrix trick — read ci.yml and reproduce exactly how it gets tests on Node 21 and builds on Node 22). The deploy must fail before touching prod if tests fail.

- [ ] **Step 1: Fixture activities + seed wiring; full `pnpm test` green.**
- [ ] **Step 2: Live verification (fixture mode):** start the dev stack (Node 22, `pnpm dev`), fixture-login + seed (curl flow from README), then playwright-screenshot `/runs` (chips + a yoga row visible), `/garden` (BalanceStrip visible with three bars), `/plan` (unchanged). Save to /tmp/tri-checkpoint/*.png and list paths in the report — the controller eyeballs them.
- [ ] **Step 3: deploy.yml gate; validate YAML (`node -e` yaml parse or push-dry reasoning); commit both.** `feat(fixtures,ci): tri-discipline fixture data + deploy gates on tests`.

---

### Task 10: Ship

- [ ] **Step 1:** Regenerate app screenshots (dev stack running: `node apps/web/scripts/screenshots.mjs`) — they're gitignored (local QA only); eyeball garden/runs/plan at 1280×800 + 390×844.
- [ ] **Step 2:** Full `pnpm test` (Node 21) + `pnpm typecheck` (Node 22) on the branch tip.
- [ ] **Step 3:** Merge `tri-discipline-ecosystem` → main, re-run `pnpm test` on merged main, push. Watch `gh run list` until the Deploy workflow (now test-gated) succeeds. Verify prod: `curl -s https://<worker-domain>/api/health || true` — find the real health/version endpoint in the worker routes first; if none exists, verify via the deploy workflow's own success + `wrangler deployments list` output in the workflow log.
- [ ] **Step 4:** Report: commits, deploy run URL, what shipped.

## Plan Self-Review Notes

- Spec coverage: mapping/semantics (T3-4), COROS import + skip counting (T2), domain/classify/matching (T1), unlocks/species (T5), worker/API (T6), UX standard pattern + colors (T7-8), fixtures + deploy gate (T9), ship (T10). Spec's "balance stored" is implemented as a pure derived export (`disciplineBalance`) rather than stored state — equivalent surface, less state to heal; recorded as an intentional refinement.
- Type consistency: `discipline?: "run"|"strength"|"yoga"` (T3) consumed by T6; `DisciplineBalance` (T4) consumed by T6/T8; gate kinds (T5) self-contained.
- Known-risk sites called out with line numbers from the exploration map; each task instructs reading the real file first (the map is a guide, not gospel).
