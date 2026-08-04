# Appendix — Decay / Balance / Countdown Audit (raw agent report)

All paths relative to repo root. Engine = `packages/garden-engine/src`. `cfg` = `DEFAULT_GARDEN_CONFIG` (`types.ts:36-45`): `drynessStartDays: 4`, `droughtStartDays: 14`, `dormancyStartDays: 30`, `deathStartDays: 60`, `treeDeathStartDays: 120`, `deathIntervalDays: 4`, `maxRegions: 6`, `regionCapacity: 14`.

Note two doc-drift items up front: `docs/GARDEN_ENGINE.md:6` says simulation version 1 and 34 species; code says `SIMULATION_VERSION = 2` (`types.ts:11`) and **46 species** (`species.ts:72-141`, incl. achievement/strength/yoga/balance species the doc omits).

---

## 1. Decay mechanics — what a workout-free day does

One simulated calendar day = one `simulateDay` call (`simulate.ts:164-355`). On a day with no completed sessions, not rest-observed, not a plan gap, not rest mode:

**Step order** (`simulate.ts:268-278`): `daysSinceCompletedRun += 1` (call it `d`, incremented *before* decay), then `applyDailyDecay` (`simulate.ts:659-717`):

| Quantity | Per-day change | Floor | Where |
|---|---|---|---|
| `state.moisture` | −0.035 | 0.05 | `simulate.ts:667` |
| `state.droughtDays` | +1 once `d ≥ 14` | — | `simulate.ts:668` |
| plant `hydration` (every living plant, dormant included) | −0.05 | 0 | `simulate.ts:671` |
| plant `health` | −0.025, **only while `hydration < 0.2`** (checked after that day's hydration decrement) | 0.05 | `simulate.ts:672` |
| `bloomProgress` | −0.1/day; **−0.5/day once `d ≥ 4`** (applies on any no-session day incl. rest mode) | 0 | `simulate.ts:317-323` |
| groundcover/grass `maturity` | −0.01/day once `d ≥ 30` | 0.2 | `simulate.ts:685-689` |
| `soilHealth` | −0.02/day while `daysSinceStrength > 7` (separate clock) | 0.2 | `simulate.ts:296-298` |
| `lifeBonusBiodiversity/Flowering` | −0.015/day while `daysSinceYoga > 7` | 0 | `simulate.ts:299, 393-397` |

Each **missed run resolved that day** additionally costs moisture −0.06 and hydration −0.1 to all living plants (`simulate.ts:236-243`) — "dryness debt, never instant death."

Passive growth (`+0.5/growthDays` maturity for plants with hydration > 0.5) stops at `d ≥ 14` (`simulate.ts:308-315`).

**Clock semantics** (`simulate.ts:263-278`): only a **planned run** resets `daysSinceCompletedRun` and `droughtDays` to 0. Rest-observed days and plan-gap days do **not increment** the run clock and skip decay entirely (rest-observed even gives soilHealth +0.01, `simulate.ts:271`). An **unplanned run** pauses the clock for that day (no increment, no decay) but does not reset it (`simulate.ts:263-268`). Strength/yoga sessions do **not** touch the run clock; a strength-only day still decays plants.

**Visible-damage timeline** (keyed to `d = daysSinceCompletedRun`):

- **`d = 1–3`**: weather `clear_sun` (70%) / `seasonal_breeze` (30%), per-date seeded roll `wx:{date}` (`condition.ts:30`). Condition word stays `flourishing`/`well_watered`/`growing` by moisture (`condition.ts:40-42`: flourishing needs moisture > 0.8 AND floweringDensity > 0.25; well_watered moisture > 0.55).
- **`d = 4` (dryness)**: weather becomes **`dry_spell` or `light_clouds` — these are the same stage**, a 50/50 per-date coin flip (`condition.ts:28`), *not* sequential stages. Condition word → `a_little_dry` (`condition.ts:39`). Blooms now close at −0.5/day.
- **hydration < 0.35 (any time)**: plant renders `thirsty` (`simulate.ts:154-157`; visible droop, `garden-renderer/src/PlantSprite.tsx:52`). From full hydration 1.0 that is day 14; from post-run ~0.8 it's day 10.
- **`d = 14` (drought)**: weather `mild_drought` (`condition.ts:27`), condition `in_drought` (`condition.ts:37`), `droughtDays` starts counting (drives straw patches/cracks in terrain from `droughtDays ≥ 3`, `garden-renderer/src/terrain.tsx:82-84`). Plants with `health < 0.55` render **`wilted`** (`simulate.ts:150-153`). Health only declines after hydration < 0.2, and plants start at health 0.9 (`simulate.ts:127`), so wilting typically appears well after day 14 unless already weak.
- **`d = 30` (dormancy)**: up to **2 lowest-hydration non-tree plants per day** go `dormant` (deterministic sort hydration then id, `simulate.ts:676-684`); groundcover/grass contract; **wildlife departs** — `inDecline = min(runClock, strengthClock, yogaClock) ≥ 30 || restMode` (`simulate.ts:775-780`), so practicing *any* discipline keeps wildlife.
- **`d = 60` (deaths)**: at most **one plant dies per 4 days** (`deathIntervalDays`, gated on `lastPlantDeathDate`, `simulate.ts:693-697`). Victim = **lowest-health living non-tree, ties by plant id** (`simulate.ts:699-701`).
- **`d = 120`**: trees may die, only when no living non-trees remain; **immature (lowest-maturity) trees first** (`simulate.ts:703-708`).
- **`d = 150`** (`treeDeathStartDays + 30`): only now can the *last* living plant die (`simulate.ts:709-714`).

**Rest mode** (`input.restModeActive`, from prefs `gardenRestMode`/`gardenRestModeUntil`, `garden-sync.ts:236-238`): freezes missed-run penalties (`simulate.ts:236`), the run-clock/decay branch (`simulate.ts:268`), all three discipline clocks (`simulate.ts:287,292`), neglect decay (`simulate.ts:295`), passive growth (`simulate.ts:308`), and weekly-consistency counting (`simulate.ts:326`). Mature plants display `dormant` (`simulate.ts:141-144`), weather holds `soft_sun` (`condition.ts:24`), condition word `dormant` (`condition.ts:35`). Wildlife treats rest mode as decline and departs (`simulate.ts:780`). One leak: bloom decay (step 9) is *not* rest-mode gated, so open blooms still close at −0.1/day.

**Strength ("soil") vs yoga ("life") vs runs**: runs alone drive moisture-as-rain, hydration, planting, weather, drought, comeback (`simulate.ts:229-231` comment). Strength: per session (planned or not) `soilHealth +0.05`, `moisture +0.08` (`simulate.ts:252-256`); soilHealth feeds long-run sapling growth `soilFactor = 0.5 + 0.5·soilHealth` (`simulate.ts:628`) and meadow density rendering (`terrain.tsx:38`). Yoga: per session `lifeBonus` +0.04 biodiversity / +0.03 flowering (caps 0.5 / 0.35, `simulate.ts:378-391`), `moisture +0.08`; the bonuses stack on top of plant-derived biodiversity/floweringDensity (`simulate.ts:840-849`), which gate butterflies (≥0.5), dragonflies (≥0.3), and the `flourishing` word.

---

## 2. The three bars

**Single source**: `disciplineBalance(state)` in `packages/garden-engine/src/balance.ts:38-57` — a **pure function of three integer day-counters**, computed server-side per request at `apps/worker/src/services/garden-sync.ts:566`, shipped in `GET /api/garden` (`apps/worker/src/routes/garden.ts:14-35`, client type `packages/api-client/src/index.ts:184-191`), rendered by `BalanceStrip` (`packages/ui/src/screens/garden.tsx:212-246, 418`).

**Formula** (`balance.ts:4-29`):

```
health = clamp01(1 − max(0, days − grace) / 14)     // DECAY_WINDOW_DAYS = 14
grace: run = 2, strength = 3, yoga = 3
overall = min(run.health, strength.health, yoga.health)
```

Full until day 2 (run) / 3 (lift, yoga); linear to **zero at day 16 / 17 / 17**. UI descriptor bands: `healthy ≥ 2/3`, `fading ≥ 1/3`, `wilting < 1/3` (`garden.tsx:191-195`) — run bar goes "fading" at day 8, "wilting" at day 12.

**Clocks** (`simulate.ts:263-292`): run = `daysSinceCompletedRun` (reset by planned runs only; paused by rest-observed/plan-gap/unplanned-run days). Strength/yoga = `daysSinceStrength`/`daysSinceYoga`, reset by any session of that discipline, incremented **every** non-rest-mode day (no rest-day/plan-gap exemption). `days: null` when `hasStrength`/`hasYoga` was never set (`balance.ts:44-49`, `types.ts:61-66`).

**Does health decline without workouts?** Yes in the model but **stepwise, one step per simulated day, and lagging real time**. The durable sim only advances through days **strictly before "today"** (`garden-sync.ts:315`), with a 2-day resolution grace that can hold it further back (`garden-sync.ts:316-317`). It advances on every `GET /api/garden` (`buildGardenView` calls `advanceGarden`, `garden-sync.ts:491`) and on the hourly cron (`apps/worker/src/index.ts:106-119, 200-202`). The same-day preview (`garden-sync.ts:498-511`) only runs **if a session was completed today**, so on a do-nothing day the bar reflects *end of yesterday*: a run done yesterday shows `days: 0`, which `daysCaption` renders as **"today"** (`garden.tsx:197-200`) — an existing one-day honesty bug. Between app opens the bar is frozen at the last simulated value.

**Client-side derivability: yes.** `health(t)` is closed-form in days-since. The UI already depends on `@rg/garden-engine` (`garden.tsx:11-12`), so it can call/replicate `healthFor` with a fractional clock: `dFrac = state.daysSince* + (now − endOf(state.lastSimulatedDate in user tz))/86400s`, giving bars that visibly shrink continuously. Exact for strength/yoga (+1/day unconditionally outside rest mode). For run, exact only if the client also accounts for: planned-rest days ahead (clock pauses), plan gaps, and a run completed today but not yet simulated (the `today` endpoint knows). All display-only — determinism of the sim is untouched.

---

## 3. Days-to-damage countdown

All thresholds are integer-day, deterministic, and computable from state already in the `/api/garden` payload (the **full snapshot** — `EngineGardenState` plus every plant's `health`/`hydration`/`maturity` — is serialized to the client, `garden-sync.ts:540-541`, `routes/garden.ts:27-34`; numeric internals also at `/api/garden/diagnostics`, `routes/garden.ts:63-80`). **Nothing computes or exposes a countdown today** — it must be derived client-side or added to the worker/engine.

Let `d = state.daysSinceCompletedRun` (as of `lastSimulatedDate`), assuming future days are plain decay days.

**(a) Next weather deterioration** — exact:
- to dry stage (`a_little_dry`, `dry_spell`/`light_clouds`): `max(0, 4 − d)` days
- to `mild_drought` / `in_drought`: `max(0, 14 − d)`
- to dormancy wave + wildlife departure: `max(0, 30 − d)` (wildlife also needs both other clocks ≥ 30)
- Even the dry-stage *flavor* per future date is predictable: `roll("wx:" + date)` is date-seeded (`condition.ts:28`).

**(b) First plant thirsty / wilted / dormant / dead** — exact per plant `p`:
- thirsty (`hydration < 0.35`): `floor((p.hydration − 0.35)/0.05) + 1` days; first plant = min over living plants.
- wilted (needs `d ≥ 14` **and** `health < 0.55`, `simulate.ts:150`):
  `hydrDays = max(0, floor((p.hydration − 0.2)/0.05) + 1)`;
  `healthDays = max(0, floor((p.health − 0.55)/0.025) + 1)`;
  `wiltIn = max(14 − d, hydrDays + healthDays)`.
- dormant: from day `max(0, 30 − d)`, 2 plants/day in ascending (hydration, id) order — fully rankable.
- first death: `firstDeathIn = max(60 − d, lastPlantDeathDate ? 4 − daysBetween(lastPlantDeathDate, lastSimulatedDate) : 0)`, victim identifiable now (lowest-health non-tree, tie by id). Health floor is 0.05, so decay never kills by itself — death is purely the scheduler at `simulate.ts:693-716`.
- Simplest robust implementation: **don't hand-derive — run `simulateDay` forward with empty inputs and read the emitted events** (`plant_state_changed`, `plant_died`, `weather_changed`); guaranteed to agree with the real sim forever (see §6).

**(c) Bar crosses threshold T**: from `health = 1 − max(0, days − g)/14`, crossing day is `days* = g + 14·(1 − T)`; countdown = `days* − currentDays`. E.g. run bar hits 0 at day 16, hits "wilting" (1/3) at day ~12.

**Non-determinism / honesty risks**:
1. **Anchor lag**: all clocks are as-of `lastSimulatedDate` (≤ yesterday; up to 2 days behind under the resolution grace, `garden-sync.ts:316-317`). A countdown must add wall-clock elapsed days in the **user's timezone** — the only wall-clock dependency, display-only.
2. **Run-clock pauses**: planned rest days and plan gaps don't advance `daysSinceCompletedRun`, so a naive "+1/day" run-bar countdown over-alarms across scheduled rest days. Either synthesize future inputs from the plan (worker has `buildDayInput`, `garden-sync.ts:143-274`) or caption the assumption ("if you do nothing").
3. **History rewrites**: late-arriving activities trigger `resimulateFrom` (`garden-sync.ts:395-437`) — a countdown can legitimately jump after a delayed COROS/Strava sync.
4. **Preview asymmetry**: if a run landed today, `buildGardenView` serves the previewed (reset) state; a countdown must anchor on the same snapshot the balance payload used (`garden-sync.ts:498-511, 566`).
5. `balance.overall` includes never-practiced disciplines: `daysSinceStrength` grows from genesis even when `days: null`, so a never-lifting user's strength health is 0 and `overall` is pinned at 0 (`balance.ts:44-49`).

---

## 4. Full metric inventory

**Everything below ships to the UI already** unless marked otherwise — `GET /api/garden` returns the entire snapshot + codex + wildlife + balance + events (`routes/garden.ts:27-34`).

Global state (`types.ts:48-114`, all in payload):

| Metric | Range / semantics |
|---|---|
| `moisture` | 0.05–1; rain reservoir; drives condition word + terrain lushness |
| `soilHealth` | 0.2–1; strength axis; drives sapling growth factor + meadow density |
| `biodiversity` | 0–1 = living species/20 + yoga bonus (`simulate.ts:826-829, 843`) |
| `canopy` | 0–1 = mature living trees × 0.15 (`simulate.ts:844`) |
| `floweringDensity` | 0–1 = in-bloom/max(6, flowering-capable) + yoga bonus (`simulate.ts:832-838`) |
| `droughtDays` | days in drought; drives terrain cracks |
| `daysSinceCompletedRun` / `daysSinceStrength` / `daysSinceYoga` | the three decay clocks |
| `weatherState`, `season`, `restMode`, `conditionWord` | enums (`domain/garden.ts:7-16, 143-160`) |
| `unlockedRegions` | 1–6; expansion when living > 0.75 × regions × 14 (`simulate.ts:812-823`) — "days to next region" derivable |
| `qualityRunCount`, `easyRunCount`, `longRunCount`, `recoveryRunCount`, `eveningRunCount`, `earlyRunCount` (< 07:00), `totalCompletedRuns`, `longestRunMeters` | lifetime counters |
| `consecutiveConsistentWeeks` | weeks ≥ 75% adherence, consecutive (`simulate.ts:326-329`) — a streak metric |
| `comebackStreak`, `bestComebackStreak`, `inComeback` | comeback arc (`simulate.ts:449-467`) |
| `strengthSessionCount`, `yogaSessionCount`, `balancedWeekCount` | tri-discipline lifetime counters |
| `weekDisciplines` | `{weekStart, run, strength, yoga}` booleans for the **in-progress week** (`simulate.ts:207-213, 303-305`) — ready-made "complete the trio this week" widget |
| `lifeBonusBiodiversity/Flowering` | 0–0.5 / 0–0.35 yoga reservoirs |
| `createdDate`, `lastSimulatedDate`, `lastPlantDeathDate` | garden age = today − createdDate |

Per-plant (`domain/garden.ts:68-84`, all in payload): `health`, `hydration`, `maturity`, `bloomProgress` (each 0–1), `state` (8-state enum incl. `thirsty/wilted/dormant/dead`), `category`, `plantedAt`, `diedAt`, `habitatRole`, `sourceWorkoutId` (plant↔workout provenance). Derivable: counts by state ("3 thirsty plants"), per-family diversity (UI already does — `DiversityStrip`, `garden.tsx:141-175`), dead-wood count, mature-tree count, trees remaining until cap (`regions × 2 + 1`, `simulate.ts:637`).

Unlock progress (in payload): `codex` gives every species with `unlocked`, `hint`, and numeric `progress {current, target}` (`unlocks.ts:101-161`); `nextUnlocks` = 3 nearest by remaining fraction (`unlocks.ts:167-177`). Gate kinds (`species.ts:11-29`): quality/easy/long/recovery run counts, consistent weeks, mature trees, comeback, dead wood, early runs, single-run distance (10 km / 21.097 km), total runs (50), comeback streak (3), strength sessions (5/12/20), yoga sessions (5/10/15), balanced weeks (3).

Wildlife (in payload as `{kind, present, hint}`): 9 kinds with exact arrival conditions (`simulate.ts:782-799`, hints `unlocks.ts:180-190`). **Not in payload**: `gardenWildlife.since` date (DB only, `garden-sync.ts:119-139`).

History: `events` feed (40 recent + today's preview, `routes/garden.ts:22-25`); the **timeline endpoint** replays every simulated day's full snapshot (`/api/garden/timeline`, `garden-sync.ts:597-619`) — historical charts (moisture curve, plant count over time, streak history) are derivable client-side from one fetch. Balance-per-historical-day is also derivable: `disciplineBalance` is pure and exported, and each timeline snapshot carries the clocks.

---

## 5. Damage-model honesty

**Death is real and irreversible.** `killPlant` sets `state: "dead"`, `health: 0`, `diedAt`, `habitatRole` (`simulate.ts:719-737`); no code path ever revives a dead plant — every recovery effect iterates `livingPlants` only (`simulate.ts:98-100, 441`), and dead plants are excluded from balance-relevant counts. Dead plants persist visually as habitat (perch / nurse log / mushroom host) and *enable* the dead-wood fungi unlocks (`unlocks.ts:41-42`, `simulate.ts:511-513`).

**Everything short of death recovers fully**: one planned run gives all living plants hydration +0.35 and health +0.08, wakes dormant plants (`simulate.ts:440-447`), and resets the drought clocks; a comeback (first planned run after ≥14 dry days) waters extra (+0.4/+0.5) and reopens blooms after 2 streak runs (`simulate.ts:449-462`). Health floors at 0.05, moisture at 0.05, soilHealth at 0.2, groundcover maturity at 0.2 — decay alone can never zero anything. Wildlife returns as soon as conditions re-satisfy. Unlocked species and regions are never lost.

**Verdict for a "save it" countdown**: honest **only for the death window** — real permanent loss begins at day 60 without a run, one plant per 4 days, weakest non-tree first, and you can name the victim in advance. A countdown framed as "N days until damage" for the day-4/day-14 stages is honest for *visible deterioration* (dry weather, closed blooms, thirsty droop, wilting, wildlife leaving at day 30) but everything before day 60 is fully reversible — and the comeback mechanic deliberately makes returning feel *better* than never leaving (plus drought is the gate for the mushroom/phoenix-fern unlocks). Copy should distinguish "wilting (recoverable)" from "dying (permanent)."

---

## 6. Extension points

**(a) Continuously-decaying bars — no engine change required.** `healthFor` is closed-form; the client (which already imports `@rg/garden-engine`) can compute fractional health from `state.daysSince*` + wall-clock elapsed since `lastSimulatedDate` in the user's tz. Cleanest: export a `projectedBalance(state, asOf)` from `balance.ts` so worker and UI share one formula. Determinism survives trivially — it's a pure display projection; the durable sim is untouched. Handle §3's caveats (planned rest days pause the run clock; run-completed-today needs the preview snapshot or `today` data).

**(b) Days-left countdown — small engine export + payload field.** Add a pure `forecast(snapshot, cfg)` next to `balance.ts` returning `{weather: {dryIn, droughtIn, dormancyIn}, plants: {firstThirstyIn, firstWiltIn, firstDeathIn, victimPlantId}, bars: {run/strength/yoga: {zeroIn, wiltingIn}}}` using the §3 formulas, computed in `buildGardenView` (`garden-sync.ts:540-567`) and appended to `GardenView`/`api-client`. All inputs are in the snapshot; all arithmetic is integer-day deterministic. The only judgment call is the future-day assumption — either caption "if you do nothing (ignoring planned rest days)" or synthesize plan-aware inputs worker-side.

**(c) Damage preview (ghosted garden N days out) — the machinery already exists and runs forward.** `simulateDay` is pure, exported, and its idempotency guard only rejects dates ≤ `lastSimulatedDate` (`simulate.ts:170`) — *future* dates fold cleanly. The timeline scrubber already proves the client can fetch/render arbitrary `GardenSnapshot`s and that a fold of inputs through `simulateDay` is cheap (`buildGardenTimeline` replays entire history per request, `garden-sync.ts:597-619`; the UI scrubs it client-side, `garden.tsx:280-333`). A forward preview is the same fold with synthesized inputs:

```
for i in 1..N:
  simulateDay(snapshot, { date: lastSimulatedDate + i, completedRuns: [],
                          missedRuns: [], restObserved: false,
                          restModeActive: prefs..., planGap: false })
```

Cost: N × `structuredClone` of a ≤ 84-plant snapshot — trivial for N ≤ 90. The emitted events double as narrative ("in 6 days: drought; in 23 days: 2 plants go dormant; in 41 days: your Field poppy dies"). Two build options: (1) pure client-side (engine is already a UI dependency — zero API change); (2) a read-only `GET /api/garden/forecast?days=N` that reuses `buildDayInput` for future dates — which naturally yields plan-aware do-nothing semantics, since a future planned rest day already evaluates `restObserved: true` and future unresolved workouts contribute no completions or misses (`garden-sync.ts:160-247`).

**Determinism survives in all three** provided: synthetic inputs are constructed deterministically; forecast snapshots are **never persisted** (keep all DB writes confined to `advanceGarden`, `garden-sync.ts:302-388`); and Monday `weekAdherence` is either synthesized as 0 or omitted (omitting leaves `consecutiveConsistentWeeks` frozen, `simulate.ts:326-329` — slightly optimistic, cosmetic for a decay preview but worth a comment). The PRNG is fully seeded by stable strings incl. per-date weather rolls (`prng.ts:17-31`, `condition.ts:28`), so even forecast weather flavor is reproducible. The one irreducible source of countdown churn is real life: late-arriving activities rewrite history via `resimulateFrom`, and that is by design.
