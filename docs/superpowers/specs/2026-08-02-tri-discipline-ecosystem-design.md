# Tri-Discipline Ecosystem — Running, Lifting, and Yoga as First-Class Citizens

**Date:** 2026-08-02
**Directive:** User-approved autonomous build ("run completely autonomously … until the features are shipped completely to prod"). Design decisions delegated to the agent; this spec records them.

## Product goal

Track three disciplines — **running**, **lifting (strength)**, and **yoga** — imported from
**COROS only** (Strava stays run-only legacy; the user may migrate off it). Each discipline
nourishes a *distinct layer* of the garden ecosystem; neglecting one visibly and gently
unbalances the garden. All three are first-class: one standard UX across disciplines with
subtle color identity per discipline. Lifting follows a plan (COROS schedule, like
running); yoga is ad-hoc (completion-only, never penalized for having no plan).

## Non-goals (v1)

- No yoga *scheduling* (COROS has no verified yoga code in the workout/schedule namespace;
  yoga is completion-only).
- No set/rep/weight rendering for strength stages (COROS strength structure renders
  generically; a reps `targetType` is future work).
- No Strava multi-sport ingestion (Strava path untouched, runs only).
- No new sprite archetypes (new species reuse existing archetypes with new palettes; the
  sprite-art pass remains a separate future project).
- No new insights metrics.

## The ecosystem mapping (the heart of the design)

Three independent recency clocks in `EngineGardenState` (JSON snapshot, self-healing
`??=` defaults — no migration):

| Clock | Discipline | Garden axis (existing, already visually wired) |
|---|---|---|
| `daysSinceCompletedRun` (existing, now run-only) | Running | **Water**: moisture, rain weather, drought patches |
| `daysSinceStrength` (new) | Lifting | **Earth**: `soilHealth` → meadow density floor, tree growth pace |
| `daysSinceYoga` (new) | Yoga | **Life**: `biodiversity` + `floweringDensity` → meadow variety, wildflowers, butterflies/dragonflies |

### Exact simulation semantics

1. **Clocks.** A day input carries completions tagged with `discipline: "run" | "strength" | "yoga"`
   (derivation below). Each discipline present that day (planned or unplanned) resets its
   clock to 0; otherwise the clock increments. `restMode` freezes all three (no decay, no
   increments — matches existing rest-mode semantics). `planGap` continues to suppress
   *penalties* (missed-run decay) but not clock increments.
2. **Running** keeps every existing effect unchanged (moisture, rain weather, per-category
   planting: quality→flowers, long→trees, easy→groundcover, recovery→soil +0.03).
   `droughtDays` and rain weather remain **run-driven** — "a run brings the rain" stays true.
3. **Strength day:** `soilHealth = min(1, +0.05)`; modest hydration support (+0.08 moisture,
   the existing cross-training case). Neglect: when `daysSinceStrength > 7`,
   `soilHealth` decays −0.02/day to a floor of 0.2. Tree growth couples to earth: the
   long-run tree maturity advance is scaled by `0.5 + 0.5 * soilHealth`.
4. **Yoga day:** `biodiversity = min(1, +0.04)` and `floweringDensity = min(1, +0.03)`.
   Neglect: when `daysSinceYoga > 7`, both decay −0.015/day to floors of 0.15. Wildlife
   consequences fall out of the *existing* desired-state rules (butterflies need
   biodiversity ≥ 0.5; dragonflies need floweringDensity ≥ 0.3) — no new wildlife logic.
5. **Garden-wide decline** (`inDecline` for wildlife/dormancy) switches from
   `daysSinceCompletedRun` to `daysSinceAnyActivity = min(run, strength, yoga clocks)` —
   keeping *any* discipline alive keeps the garden alive, while individual axes wilt
   individually. Gentle, honest.
6. **Balance.** Per-discipline health `h_d = clamp01(1 − max(0, days_d − grace_d) / 14)`
   with grace 2/3/3 days (run/strength/yoga). `balance = min(h_run, h_strength, h_yoga)` —
   the weakest limb defines balance. Stored on the snapshot state; surfaced through the API.
7. **Balanced weeks.** A Mon–Sun week in which all three disciplines completed ≥ 1 session
   increments `balancedWeekCount` (evaluated deterministically when simulating the first
   day after the week ends). Drives the rarest unlocks.
8. **Events.** Two new `GardenEventKind`s with gentle copy: `soil_tended` (first strength
   day after ≥ 3 days) and `life_tended` (first yoga day after ≥ 3 days); existing kinds
   cover the rest. Zod enum + copy additions.
9. **Determinism:** all new logic is pure; old snapshots self-heal new counters to 0 and
   replay identically for run-only histories except where the new decay rules apply from
   the feature's simulationVersion forward (bump `simulationVersion`; replays remain
   internally consistent).

### Discipline derivation

`discipline(activity/workout)`: sport `"strength"` or category `"strength"` → `strength`;
sport/category `"yoga"` → `yoga`; everything else that reaches the garden → `run`.
Bike/swim/other remain cross-training (planned-only modest support, no dedicated axis).

## COROS import (COROS-only)

- **Bridge** (`services/coros-bridge/src/snapshot.ts`): replace the run-only filter with an
  admitted-set: run family (100–103) → run; **402 → strength**; **403 and 904 → yoga**
  (both community-reported yoga codes accepted — they conflict across sources and neither
  is live-verified; accepting both is safe as neither collides with another known code).
  Everything else is still skipped but now **counted**: the snapshot payload gains
  `skippedSportTypes: Record<string, number>` so unknown codes surface in worker logs —
  the runtime-discovery path for the true yoga code on the user's real account.
- `corosSportName` (providers raw-types): 403/904 → `"yoga"`.
- Activity **detail fetch** works unchanged for non-GPS activities (labelId + sportType);
  duration/HR/calories normalize; distance/pace stay undefined.
- **Plan side:** COROS schedule strength programs (workout namespace 4) already normalize
  to sport `"strength"` and classify to category `"strength"` — the lifting plan flows
  through the existing plan pipeline (calendar mirroring included) with no new machinery.
- The existing bridge protocol test asserting the bike activity is dropped stays valid —
  bike is still dropped, now also counted in `skippedSportTypes`.

## Domain & matching

- `WORKOUT_CATEGORIES` += `"yoga"`.
- `classifyWorkout`: sport hint `"yoga"` → category `yoga`; name regex
  `/\byoga\b|\bmobility\b|\bstretch/i` → `yoga` (before the cross-training rule).
- `matching.ts`: `"yoga"` joins `["cross_training", "strength"]` in the non-run sport
  scoring set, so yoga activities match planned yoga workouts when any exist and otherwise
  ingest as unplanned.
- `GardenDayInput.completedRuns` entries gain optional `discipline` (default `"run"` for
  backward compat with stored day inputs).

## Unlocks — new species (existing archetypes only)

New gate kinds `strength_sessions`, `yoga_sessions`, `balanced_weeks` backed by
self-healing counters `strengthSessionCount`, `yogaSessionCount`, `balancedWeekCount`;
`gateSatisfied`/`gateProgress`/`describeGate` extended (codex progress bars come free).
Seven new species reusing existing archetypes/categories, with discipline-identity
palettes (terracotta/rust for strength, violet/lavender for yoga):

| Species | Category/archetype (existing) | Gate |
|---|---|---|
| Stonecrop | groundcover | strength_sessions ≥ 5 |
| Ironwood | tree | strength_sessions ≥ 12 |
| Terrace fern | fern | strength_sessions ≥ 20 |
| Moon lotus | flower | yoga_sessions ≥ 5 |
| Meditation moss | fungus | yoga_sessions ≥ 10 |
| Lavender drift | flower | yoga_sessions ≥ 15 |
| Harmony willow | tree | balanced_weeks ≥ 3 |

Descriptions use the codex's honest style ("Complete 5 strength sessions", "3 balanced
weeks — run, lift, and yoga in the same week").

## Worker

- `garden-sync.ts` `buildDayInput`: matched completions flow as today (any discipline);
  the unplanned loop admits `sport ∈ {"run", "strength", "yoga"}` and tags `discipline`.
- Garden API payload gains
  `balance: { run: {days, health}, strength: {days, health}, yoga: {days, health}, overall }`
  read from the snapshot (no DB change; all state lives in the JSON snapshot).

## UX — one standard pattern, color as identity

Discipline colors: **run** keeps the existing greens; **lifting** terracotta `#b5652f`
family; **yoga** violet `#8f6fae` family. Applied to category dots, filter chips, and the
balance strip — subtle, never loud.

- **Activity screen** (was "Runs"): drop the `sport === "run"` filter; add filter chips
  `All · Runs · Lifting · Yoga`; one shared row component for every discipline (date,
  name, duration, HR when present; distance/pace only when present). Nav label becomes
  "Activity". `CATEGORY_LABELS` += yoga; `cat-yoga` CSS.
- **Plan screen**: no structural change — lifting plan workouts render through the
  existing category machinery with their color; yoga never appears as planned (v1).
- **Garden screen**: new compact **BalanceStrip** above the readout — three labeled
  mini-bars ("Run", "Lift", "Yoga"), each filled to `health` in its discipline color with
  a "last: N days ago" line; balance-aware sentences join the existing condition copy
  ("The meadow thrives, but the soil misses your lifting."). Data from the new API field.
- **Codex**: new species and progress nudges appear automatically.

## Testing

- Engine: clock reset/increment/freeze (restMode), axis effects + caps/floors, decay
  onsets, balance math, balanced-week detection (edge: week straddling restMode/planGap),
  tree-growth coupling, wildlife inDecline switch, new gates' satisfied/progress/describe,
  determinism/self-healing of old snapshots.
- Providers/bridge: corosSportName 403/904; snapshot admits 402/403/904 and counts skips
  (update mock-server test additively); normalize non-GPS fields.
- Classify: yoga hints. Matching: yoga bucket.
- Worker: buildDayInput admits strength/yoga + tags discipline; balance in API payload.
- UI: activity filter logic; BalanceStrip renders from payload (unit-level).
- Fixtures: fixture dataset gains strength + yoga activities so the seeded dev garden
  exercises the full path end-to-end.

## Deploy safety (ships with this feature)

`deploy.yml` currently deploys on push to main without waiting for CI. Add typecheck +
`pnpm test` + web build steps to the deploy job before `wrangler deploy` so prod cannot
ship a red tree. (Found during the visual-overhaul final review.)

## Rollout order

1. Domain + classify + matching (yoga category, discipline typing).
2. Providers + bridge (sport codes, skip counting) with tests.
3. Engine (clocks, axes, balance, balanced weeks, gates, species, wildlife switch).
4. Worker (ingestion, balance API).
5. UI (Activity screen, plan labels, BalanceStrip, colors/copy).
6. Fixtures + deploy gate + screenshots refresh; ship to prod.
