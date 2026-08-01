# Garden engine

The garden is a deterministic, event-sourced simulation of your training
consistency. Implementation: `packages/garden-engine/src/` (`simulate.ts`,
`species.ts`, `condition.ts`, `prng.ts`, `types.ts`); the worker feeds it in
`apps/worker/src/services/garden-sync.ts`. Simulation version: **1**.

## Determinism

- **Event-sourced**: the inputs are resolved calendar days
  (`GardenDayInput`: completed runs, missed runs resolved that day, rest
  observed, rest mode, plan gap, week adherence on Mondays). `replay(created,
  days)` from genesis always reproduces the identical garden.
- **Seeded randomness only**: every stochastic decision uses mulberry32 seeded
  by an FNV-1a hash of a stable string key (`prng.ts`) — e.g.
  `species:quality:{workoutId}`, `wx:{date}`. No `Math.random`, no wall-clock.
- **Idempotent per day**: `simulateDay` refuses dates ≤ `lastSimulatedDate`,
  so re-running a day is a no-op; runs within a day are processed in sorted
  `workoutId` order so batching cannot change outcomes.

## State model

`GardenSnapshot` = `{ version, state, plants[], unlockedSpeciesIds[], wildlife }`.

- **Global state** (`EngineGardenState`): `moisture`, `soilHealth`,
  `biodiversity` (species count / 20), `canopy` (mature trees × 0.15),
  `floweringDensity`, `droughtDays`, `daysSinceCompletedRun`, weather, season
  (by month), rest mode, `unlockedRegions`, long-term counters
  (quality/easy/long/recovery/evening/total runs, consecutive consistent
  weeks), comeback tracking, `lastPlantDeathDate`, `createdDate`.
- **Plants**: species, `health`, `hydration`, `maturity`, `bloomProgress`,
  position (x, y, region), optional host plant, and a display state:
  `seed → growing → mature / flowering`, plus `thirsty`, `wilted`, `dormant`,
  `dead`. Genesis seeds a small starter meadow (3 meadow grass + 2 clover) so
  day one is never bare dirt.
- Only **planned** completed runs water fully, advance counters, and plant new
  species. Unplanned runs give a modest ambient benefit (+0.1 moisture,
  +0.15 hydration) — never rare species, never intensity rewards.

Primary UI shows a **condition word**, not numbers (`conditionWord`):
`flourishing` / `well_watered` / `growing` / `a_little_dry` / `recovering` /
`in_drought` / `dormant`. Weather is a metaphor for recent consistency
(`deriveWeather`): `fresh_rain` on a run day, `recovery_rain` on a comeback
day, `soft_sun` for observed rest / rest mode, `dry_spell`/`light_clouds` when
dry, `mild_drought` in drought, otherwise `clear_sun`/`seasonal_breeze`.

## The decay curve (`DEFAULT_GARDEN_CONFIG`)

Days are counted in `daysSinceCompletedRun` (planned runs reset it; observed
rest days and plan gaps do **not** increment it).

| Threshold | Days | Effect |
|---|---|---|
| Dryness | **4** | Visible dryness; blooms close faster (−0.5/day instead of −0.1); weather turns dry |
| Drought | **14** | `droughtDays` accrues; low-health plants wilt; passive growth stops |
| Dormancy | **30** | Up to 2 lowest-hydration non-tree plants go dormant per day; groundcover/grass contract; wildlife departs |
| Deaths begin | **60** | Bounded: at most one plant dies per **4 days** (`deathIntervalDays`), always the lowest-health non-tree first |
| Tree deaths | **120** | Only when no non-trees remain; immature trees before mature ones |
| Last plant | **150+** | The final plant only dies after `treeDeathStartDays + 30` — extinction is impossible before roughly five months of total absence |

Daily decay while unwatered: moisture −0.035 (floor 0.05), hydration −0.05,
and health −0.025 once hydration < 0.2 (floor 0.05). Each missed run resolved
on a day costs an extra −0.06 moisture and −0.1 hydration to all plants —
dryness debt, never instant death.

**Death is not deletion**: dead plants stay in the scene as habitat (perch,
nurse log, mushroom host), preserved history that later enables fungi.

## Comeback mechanics

A planned run after ≥ 14 dry days is a **comeback**: it waters extra (+0.4
moisture, +0.5 hydration vs the normal +0.25/+0.35) and starts `inComeback`.
Two consecutive comeback-streak runs reopen blooms on mature flowering plants;
the comeback resolves after 5 streak runs (or 3 with moisture > 0.85). The
comeback state satisfies the mushroom-cluster unlock gate, and comeback days
get `recovery_rain` weather. Returning after a break is designed to feel
*better* than never having left.

## Rest mode

User-toggled (optionally until a date). While active: no decay, no missed-run
penalties (the worker's reconciler also pauses the missed pipeline), mature
plants rest as dormant, wildlife counts it as decline (they drift away), and
weather holds at `soft_sun`. Ending rest mode wakes everything without damage.

## Species catalog — 34 species

`species.ts`; each entry has a distinct renderer archetype + palette, growth
days, spacing, depth band, rarity (weighting common 4 : uncommon 2 : rare 1).

| Category | Count | Species (unlock gate) |
|---|---|---|
| Trees | 8 | Paper birch (1 long run), Field maple (2), Shore pine (3), Mountain cherry (4), Ginkgo (6), Creek willow (8), Dogwood (10, rare), Star magnolia (12, rare) |
| Flowers | 8 | Field poppy (1 quality run), Meadow iris (2), Wildflower cluster (3), Wood aster (4), Coneflower (6), Cosmos (8), Wild tulip (10), Garden dahlia (14, rare) |
| Ferns & shade | 4 | Woodland grass (1 easy run), Sword fern (3), Maidenhair fern (6), Hosta (8) |
| Vines (need a host tree) | 4 | English ivy (4 consistent weeks), Clematis (6), Flowering creeper (8), River wisteria (10, rare) |
| Groundcover & grass | 4 | White clover (start), Meadow grass (start), Creeping thyme (5 easy runs), Cushion moss (2 recovery runs) |
| Shrubs | 3 | Lavender (5 quality runs), Hydrangea (9), Azalea (12) |
| Fungi | 3 | Mushroom cluster (comeback), Shelf fungus (dead wood), Log moss (dead wood) |

Unlock gates reference the long-term counters: `quality_runs`, `easy_runs`,
`long_runs`, `recovery_runs`, `consistent_weeks` (weeks with ≥ 75% adherence,
consecutive), `mature_trees`, `comeback`, `dead_wood`, or `start`. Gate checks
are live, so a run that satisfies a gate can plant that species the same day;
the unlock event still fires exactly once.

## What each run type does

| Category | Effect |
|---|---|
| Quality / race | Plants a flower/shrub (or fern/vine/groundcover when the scene is dense); can push mature, hydrated flowering plants into bloom |
| Long | Strongly advances the least-mature sapling; long run #1 plants the first tree, then every 3rd long run adds one while room remains (max `regions × 2 + 1` trees) |
| Easy | Extra hydration; boosts young plants; every 2nd easy run plants groundcover/grass |
| Recovery | Soil health +0.03, strong watering; with dead wood present, 60% chance of fungi; else every 2nd recovery run plants groundcover |
| Cross-training / strength | Hydration only — modest ecosystem support |

Per-species population caps (flower 5, shrub 3, fern 4, vine 2, groundcover 6,
grass 8, fungus 3, tree 2) keep the scene composed.

## Wildlife & regions

| Wildlife | Arrives when (and no decline: < 30 dry days, not rest mode) |
|---|---|
| Birds | ≥ 2 mature trees and canopy ≥ 0.25 |
| Bees | ≥ 3 flowering-capable species mature, ≥ 1 currently blooming |
| Butterflies | Biodiversity ≥ 0.5 (10+ living species) |
| Fireflies | ≥ 10 evening runs and (a mature tree or 2 flowering species) |

Wildlife departs during decline and returns when conditions recover. The scene
expands into a new region (max **6**, capacity **14** plants each) when living
plants exceed 75% of current capacity.

## Daily simulation in the worker

`advanceGarden` (hourly cron + after ingests) walks forward one day at a time,
strictly before "today" in the user's timezone, with a 2-day resolution grace
(a newer day simulates early only when every workout on it is resolved). Per
day it persists: the day input (`garden_day_inputs`), emitted events
(`garden_events`, conflict-ignoring on the unique (user, date, seq) key),
species unlocks, and a **Monday checkpoint** (`garden_snapshots`).

**Versioning**: every event and snapshot records `SIMULATION_VERSION`;
`schema_versions` tracks the deployed component version.

**Checkpoint replay** (`resimulateFrom`): when history changes (a late
activity arrives for a past date), the worker restores the latest checkpoint
before the affected date (or genesis), deletes downstream events/inputs/
checkpoints, and resimulates from the database — determinism guarantees
convergence. Late data *corrects* the past instead of double-counting it.
