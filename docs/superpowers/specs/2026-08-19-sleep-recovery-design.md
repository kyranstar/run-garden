# Sleep & recovery as a core element — design (phase 1)

**Date:** 2026-08-19 · **Status:** approved (mocks reviewed; option C chosen for the garden mechanic)
**Mocks:** artifact 808cc3c0 (`sleep-recovery-mocks.html`) · **Data inventory:** two-agent sweep 2026-08-19

## Thesis

Night becomes the garden's fourth rhythm: **dew**. On a *tended* garden, a settled night leaves dew
that holds the decay clocks for a day. Dew only settles on living leaves — no training in the last
3 days, no dew — so sleep multiplies running and can never replace it. A rough night simply leaves
no dew: sleep can never hurt the garden (the adventure contract).

## Data reality (from the inventory)

- Production `sleep_records` has 0 rows ever; duration/stages are mobile-API-only (forbidden — logs
  the phone app out) or via the official COROS OAuth connection (**phase 2**).
- The app's `daily_health.hrv` IS overnight sleep HRV (`avgSleepHrv`) — phase 1 relabels it honestly.
- Fetched-but-discarded today: `sleepHrvSd` (COROS's own band, inside `dashboard.sleepHrvData`),
  `fullRecoveryHours` (parsed at client.ts:506, zero consumers). Phase 1 stores both.
- Missing data is the primary state (prod recovery_score: 73 null + 4×100 of 77). Every surface
  renders gaps as gaps and withholds under the established minimums.

## Definitions

- **Settled night** (`nightState`, shared in `@rg/domain`): for a date's `daily_health` row —
  `hrv != null && sleepHrvBase != null` → settled iff `hrv >= sleepHrvBase - (sleepHrvSd ?? 0.1*base)`
  (one-sided: a high HRV night is never "unsettled"). Else if `recoveryScore != null` → settled iff
  `>= 60`. Else **gap** (no reading → no claim).
- **Tended** (revised after adversarial verify round 1): a **run** within `DEW_TENDED_DAYS` (3),
  running today included, computed by the WORKER's `buildDayInput` from the durable `activities`
  table. Three rejected alternatives, each a confirmed bug: engine counters freeze under dew and
  self-renew (finding: one dewy morning tended forever); an engine `lastTrainedDate` snapshot field
  diverges between genesis replay and incremental sim; and any-discipline tending let sleep + two
  yoga sessions a week pin the run clock forever — sleep replacing running, the thing option C
  forbids. Runs bring the rain; dew is water.
- **DEW_EPOCH** (`2026-08-19`, in garden-sync): nights before it derive neither `settledNight` nor
  `dew` on any path. Resims re-run `buildDayInput` and overwrite stored inputs, so without the gate
  a resim would retroactively mint dew across pre-feature history.
- **Dew morning**: settled night AND tended → that day's punitive decay paths freeze, exactly like
  an adventure grace day (credit still accrues). Also increments `dewyMornings`. A banked adventure
  grace day is NOT spent on a morning dew already shields. The engine consumes two input fields —
  `settledNight` (feeds the weekly count) and `dew` (settled + tended; shields) — and derives
  nothing itself.
- **Steady week**: at week close, `weekSettledNights >= 5` AND the week was a consistent training
  week (`weekAdherence >= 0.75`). Consecutive count in `steadySleepWeeks`. Slept-only or
  trained-only weeks do not count — the unlock can't be earned from the couch.

## Changes by layer

### Data (no new auth)
- Migration 0020: `daily_health` + `sleep_hrv_sd REAL`, `full_recovery_hours REAL`.
  (`recoveryState` deliberately skipped — nothing in the design reads it.)
- `packages/coros` client: type `sleepHrvData` (`sleepHrvList[{happenDay, avgSleepHrv, sleepHrvBase,
  sleepHrvSd}]`); snapshot maps per-day `sleepHrvSd` by `happenDay`, `fullRecoveryHours` on the
  stamp day only. Ingest COALESCEs as usual.
- Health pull window widens from 7 to 42 days (`healthRangeStart`) so bands/series have history.

### Engine (`packages/garden-engine`) — no SIMULATION_VERSION bump
- `GardenDayInput.dew?: boolean` (server computes settled-night; engine owns "tended").
- New state (all `??=` backfilled, so historical replay is byte-identical): `dewyMornings`,
  `weekSettledNights`, `steadySleepWeeks`, `bestSteadySleepWeeks`, `dewToday` (derived, for UI).
- Dew freeze folds into the existing adventure-freeze sites; punitive paths only. Counters start at
  zero the day this ships — no retroactive rewrites of garden history.
- **One band, one voice**: "your band" always means COROS base ± sd EXACTLY, printed only when a
  real sd (> 0) exists — never clamped, never our 10% stand-in dressed as the watch's. Without a
  real sd the sheet says "usually N", the tile says "within 10% of your N ms baseline"
  (bandSource "derived"), and only `nightState` keeps a silent 10% floor for classification.
- New unlock gates `dewy_mornings` / `steady_sleep_weeks` (three exhaustive switches + species):
  **Evening primrose** (uncommon, 10 dewy mornings), **Night phlox** (rare, 3 steady weeks —
  "Moonflower" from the mocks already existed as the evening-runs species).
  `disciplineOfGate` → null (they don't join the per-discipline nudge trio).
- **Luna moth** rare visitor: ≥4 settled nights among the stored last-7 day inputs (today's input
  is never stored, so the window is at most 6 rows) plus ≥2 runs that week; seeded scarcity like
  the heron.
- Forecast/`projectedBalance`: dew today freezes today in the projection (forecast mirrors the sim).

### Home (System 1)
- ReadinessSheet: "HRV · usually 70" → "sleep HRV · your band 62–74" (falls back to "usually N"
  when no sd); new conditional vitals: slept h (+ deep/REM when a sleep record exists — fixture-only
  until phase 2) and "until full recovery, says COROS"; a 7-night row (settled / low ✕ / dashed gap).
- Scene: dew glints on plants on a dew morning (deterministic placement); the forecast voice
  speaks for it. (The mocked BalanceDetail "· dew held it a day" suffix was dropped — one voice
  per fact; the forecast owns it.)

### Dashboard (System 2)
- The existing `hrv` metric is upgraded in place (same id — no duplicate voice, old clients safe):
  title "Sleep HRV", gauge with the personal band, 14-night series, baseline; drilldown keeps
  BaselineBandChart ("Nights") and adds **Strain & answer** (day load above the line, following
  night below it, same column) fed by `daily_health.day_load` + nightly HRV.
- New metric id `sleep` emitted only when `computeSleepNights` returns ok (≥3 recorded nights in
  30d, newest ≤7d old) — with no data the metric is simply absent, never a dead "Need 3; have 0"
  tile (prod: absent until phase 2; fixtures show it): duration tile + stage chart (deep/REM/light
  stacked bottom-up, 7h reference). Stage ramp: #3a4494 / #5560c9 / #a9b3e6 (validated:
  lightness-ordered, adjacent ΔE 11.6/25.6).
- Insight sentences are rule-based (`meaning`/`sampleNote` conventions), never invented.

### Coach
- WELLNESS 14D gains the band line when sd exists ("sleep-HRV band (COROS): 62–74ms") and
  fullRecoveryHours on the latest day; READING THESE NUMBERS explains the band. The existing
  sleep_deficit trigger is unchanged — its evidence just gets specific.
- User-facing "HRV" strings become "sleep HRV" in dossier glossaries.

### Deliberately not done (phase 1)
- No COROS OAuth connect + settings section (phase 2 — the only path to duration/stages in prod).
- No plan-week readiness dot, no sleep score, no fourth balance bar, no bedtime nags.
- No retroactive dew for historical days.

## Test plan
Engine: dew requires both settled+tended; never punitive; counters + week close + gate progress;
replay-identical without dew inputs. Domain: `nightState` truth table incl. gaps and sd fallback.
Worker: snapshot mapping of sd/fullRecoveryHours; ingest COALESCE; readiness DTO band + nights row;
`sleep` metric emitted only with data. UI: sheet render variants (band vs usually, slept row, night
row), tile shapes, stage chart, scales/responsive suites stay green. Fixtures seed sleepHrvBase/sd +
below-band nights + gaps so every state is screenshottable.
