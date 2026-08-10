# Garden Life in the Water (Bundle 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground-gated species, water wildlife, and the empty achievement gates filled, per `docs/superpowers/specs/2026-08-05-garden-life-in-the-water-design.md`. `SIMULATION_VERSION` 3 → 4.

**Architecture:** Engine-first (gates/counters/species/version), then placement (aquatic anchors), then art (waterlily archetype, ducks), then surfaces (shelf, insights, anniversary). Visual gate before ship via export harness + browser screenshot.

**Tech Stack:** TypeScript engine (pure), SVG renderer, Hono worker, vitest (Node 21).

## Global Constraints

- Node 21 tests; specific-path `git add`; determinism (fresh rng keys, fixed draw counts, render-N-draw-K); filters ≤ 1 plant; canon copy tone; `SIMULATION_VERSION` bump exactly once to 4.

---

### Task 1: engine — counters, gates, species, ducks flag, version 4

**Files:** `packages/garden-engine/src/{types.ts,species.ts,unlocks.ts,simulate.ts}`, `packages/domain/src/garden.ts` (WildlifeKind), tests in `packages/garden-engine/test/simulate.test.ts` + `unlocks` coverage where it lives.

**Interfaces (produces):** `UnlockGate` gains `{kind:"ground"; ground:"stream"|"terrace"|"glade"}`, `{kind:"races"; count:number}`, `{kind:"evening_runs"; count:number}`; `Species.aquatic?: "channel"|"bank"`; `EngineGardenState.raceCount`, `.bestConsistentWeeks` (both `??= 0` migrated); `WildlifeKind` gains `"ducks"`; 9 species rows per spec §2 table; `SIMULATION_VERSION = 4`.

- [ ] **Step 1 failing tests:** ground gate satisfied only when the ground exists; race day increments `raceCount` AND still counts as a quality run; `bestConsistentWeeks` survives a chain reset; evening gate progress returns `{current,target}`; aquatic species don't plant without their ground (eligibleSpecies); ducks arrive with a stream + moisture > 0.5 and depart in decline; v3-shaped snapshot (missing new fields) simulates without crashing.
- [ ] **Step 2 implement:** `types.ts` version + state fields; `species.ts` gate union + `aquatic` field + 9 rows (palettes: waterlily `#6f8f7d/#e8dbe8/#f2ede0`; cattail `#7a8f5f/#6b4a32`; river_reed `#8fa06b/#b5a878`; mountain_sage `#7c8f72/#b5652f/#d99a3d`; glade_harebell `#7c9483/#8f6fae`; victory_laurel `#5f7f55/#caa25a/#8a6248`; summit_sequoia `#3f6e57/#5a3d28/#8fb7a0`; old_beech `#6f9a58/#8a6248/#caa25a`; moonflower `#5f8054/#f2ede0/#c9d4e8`); `unlocks.ts` gateSatisfied/describeGate/gateProgress cases; `simulate.ts`: `state.raceCount ??= 0`, `state.bestConsistentWeeks ??= 0`, race branch `state.raceCount += 1` (before falling into quality effects — split `case "race":` to add the counter then share the quality body via fallthrough or a helper), chain-increment updates best, genesis wildlife record + `desired.ducks = !inDecline && (state.grounds ?? []).some(g => g.kind === "stream") && s.moisture > 0.5`, `WILDLIFE_HINTS.ducks = "A calm stream draws them in"`.
- [ ] **Step 3:** run engine suite; expect the version bump to ripple (fixtures asserting version 3 → update deliberately); commit `feat(engine): ground/race/evening gates, aquatic species, ducks, sim v4`.

### Task 2: aquatic placement

**Files:** `packages/garden-renderer/src/GardenScene.tsx` (anchor fn), `packages/garden-renderer/src/terrain.tsx` (export a `nearestChannelPoint(channels, x)` helper if none exists), renderer tests.

- [ ] **Step 1 failing tests:** with a stream ground, a `waterlily` plant's rendered anchor lies INSIDE a channel (|x − xc(t)| < width/2 at its t); `cattail` sits within the bank band (edge ± width); non-aquatic plants still displace out (existing invariant test keeps passing, now scoped to non-aquatic).
- [ ] **Step 2 implement:** in the anchor fn, branch on `speciesOrThrow(pl.speciesId).aquatic`: `"channel"` → snap to the nearest channel centerline point with `t` clamped ≥ the riparian fade threshold used in terrain (find its constant; ~0.34–0.45) so distant water stays bare; `"bank"` → nearest edge point ± 0.55 × width. Defensive: no channels → fall through to normal placement.
- [ ] **Step 3:** run renderer suite, commit `feat(garden): aquatic species anchor to the stream`.

### Task 3: waterlily archetype + ducks

**Files:** `packages/garden-renderer/src/PlantSprite.tsx` (archetype `water_lily`, add to `NO_SWAY`), `packages/garden-renderer/src/GardenScene.tsx` (ducks wildlife block), renderer tests.

- [ ] **Step 1 failing tests:** `water_lily` renders distinct markup per state (seed → sprout; mature → pad + bloom path present; dead → stalks); archetype count assertion 20 → 21; ducks render only when `wildlife.ducks && a stream exists`; fixed-draw determinism (two renders identical).
- [ ] **Step 2 implement:** pad = `blobPath` ellipse (fixed draws) with a notch wedge cut toward the viewer, `lightHint` tone on the sun side; bloom cup at `m ≥ 0.5`, petals when `P.blooming`; scale with `m`. Ducks: two small silhouettes (body ellipse + head + bill wedge) at `nearestChannelPoint` mid-channel, gentle bob via the existing `-hover` animation class, `pointerEvents="none"`, seeded jitter `wildlife:ducks`.
- [ ] **Step 3:** run renderer suite, commit `feat(garden): waterlily archetype + ducks on the stream`.

### Task 4: surfaces — shelf, insights longest chain, anniversary

**Files:** `packages/ui/src/screens/codex.tsx` (ducks emoji 🦆 in the shelf map), `packages/ui/src/screens/insights.tsx` (chain line gains `· longest {N}` when best > current), `apps/worker/src/services/garden-sync.ts` + `apps/worker/src/routes/garden.ts` + `packages/ui/src/screens/garden.tsx` (anniversary line: `anniversary: string | null` on the view when month-day matches `createdDate` and age ≥ 1y; UI leads the beat lines with it like the visitor line), worker + ui tests.

- [ ] **Step 1:** worker test — anniversary present exactly on the matching month-day with age ≥ 1 year, null otherwise (build via `ensureGarden` with an old genesis). UI: shelf renders ducks chip; insights line shows longest.
- [ ] **Step 2:** implement all three; commit `feat(garden): ducks shelf chip, longest chain, garden anniversary line`.

### Task 5: visual gate + verify + ship

- [ ] **Step 1:** export scenes including a stream garden with aquatics (extend `test/export-scenes.test.tsx`'s scenario or build snapshot via replay with enough long runs to carve a stream + gates satisfied); open the exported HTML in Chrome, screenshot, and eyeball: waterlily reads as a lily on water, ducks read as ducks, palettes sit inside grainlight. Iterate art until it does.
- [ ] **Step 2:** `pnpm test` full (Node 21) green; `pnpm typecheck` clean.
- [ ] **Step 3:** push; watch CI + Deploy green. Post-deploy: first garden read resimulates to v4 (lazy, per user).
