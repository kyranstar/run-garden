# Optional sports (adventures) — design

**Date:** 2026-08-09
**Status:** Approved by user (brainstorming session)

## Problem

The Coros bridge drops every activity that isn't run/strength/yoga (plus downhill
ski as load-only). A backpacking weekend is invisible to the garden, and the days
around it are punished as neglect: moisture decays, missed-run hits accrue,
strength/yoga neglect fires. The user wants all Coros-importable sports supported,
with this contract: **optional sports boost the garden but their absence never
hurts it, and a real adventure protects the surrounding days from decay.**

## Decisions (user-approved)

1. **Protection:** freeze + earned grace. Adventure days freeze all decay clocks
   (like rest mode); big efforts extend protection into following days. Clocks
   freeze, never reset — a hike is not a run.
2. **Boost:** feed existing axes via the `lifeBonus` pattern (helps, fades only to
   zero, never below baseline). No new visual flourishes this round.
3. **Qualifying:** one uniform effort threshold, any sport. No curated list.
4. **Backfill:** retroactive. Backfill dropped history, bump `SIMULATION_VERSION`,
   full resim honors past trips.
5. **Architecture:** adventure as a cross-cutting engine day-input + a small shared
   sport registry. No generalized discipline refactor.
6. **Grace source:** recovery-aware — Coros `recoveryScore` drives grace length,
   adventure-gated, heuristic fallback where health data is missing.

## 1. Sport registry + import

New canonical table in `packages/domain/src/sport.ts` (domain is already a
dependency of providers, worker, and UI):

```ts
export interface SportDef {
  id: string;          // "hike", "ski", "snowboard", "xc-ski", "bike", ...
  label: string;       // "Hike"
  corosCodes: number[];// [104, 105, 106]
  adventure: boolean;  // true for everything that isn't run/strength/yoga
}
export const SPORTS: SportDef[]
export function sportForCorosCode(code: number): SportDef | undefined
```

Codes from `docs/research/coros-community-clients.md:1013-1028`: run family
(100–103), hike/climb (104–106), bike, swim, strength (402), yoga (403, 904),
ski family (500–503), walk (900), elliptical (903), etc.

- Replaces `COROS_ADMITTED_SPORT_TYPES` (`packages/providers/src/coros/raw-types.ts:166`)
  and `corosSportName`.
- Both bridge filter sites (`services/coros-bridge/src/snapshot.ts:112`,
  `services/coros-bridge/src/backfill.ts:58`) admit through the registry.
  **Unknown codes are admitted as `other`** (generic label), still tallied so the
  census surfaces new codes to name later. Nothing is dropped.
- `SPORT_LABELS` in `packages/ui/src/screens/runs.tsx` becomes a registry lookup.
- Run/strength/yoga codes keep their exact current discipline mapping.
- `walk`/`elliptical` are `adventure: true` — the effort threshold is the gate,
  not the sport.
- Planned-workout namespace (`WORKOUT_SPORT`, matching) is untouched; plan
  matching stays run-only.

## 2. Engine mechanics

### Day input

`EngineDayInput` gains:

```ts
adventures?: { sport: string; trainingLoad?: number; durationMin?: number }[];
recoveryScore?: number; // 0-100, from daily_health for that date, if present
```

Built in `apps/worker/src/services/garden-sync.ts` from admitted non-discipline
activities (currently filtered out at garden-sync.ts:203) and the `daily_health`
row for the date.

### Tunables (next to `BALANCE_TUNING` in `packages/garden-engine/src/balance.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `ADVENTURE_MIN_LOAD` | 40 | qualifies if trainingLoad ≥ this… |
| `ADVENTURE_MIN_DURATION_MIN` | 45 | …or duration ≥ this |
| `ADVENTURE_BIG_LOAD` | 80 | fallback "big day" banks +1 grace day… |
| `ADVENTURE_BIG_DURATION_MIN` | 150 | …or this duration |
| `ADVENTURE_GRACE_CAP` | 2 | max consecutive/banked grace days |
| `ADVENTURE_RECOVERY_THRESHOLD` | 60 | grace continues while recoveryScore < this |

Thresholds are provisional — calibrate against the user's real load distribution
during implementation (`pnpm coros:census` can dump it).

### Behavior

- **Qualifying adventure day → full freeze.** Same punishment suppression as rest
  mode: no clock advancement (`daysSinceCompletedRun/Strength/Yoga`), no
  missed-run moisture hit, no strength-soil or yoga-life neglect. Sub-threshold
  activities are recorded but garden-neutral.
- **Boost per qualifying adventure:** `tendLifeAxis(state, 0.03, 0.02)` sharing
  yoga's existing reservoir caps (`LIFE_BONUS_CAP_*` — bonuses never stack past
  them), plus `moisture +0.05`, `soilHealth +0.02`. Deliberately smaller than a
  run's rain: running remains the garden's water source.
- **Recovery-aware grace:** on a day that would otherwise decay (no discipline
  session, no qualifying adventure, no rest mode, no plan gap — sub-threshold
  activities do NOT block grace), if a qualifying adventure occurred within the
  last `ADVENTURE_GRACE_CAP` days (`lastAdventureDate`) and that day's
  `recoveryScore < ADVENTURE_RECOVERY_THRESHOLD`, the day is a grace day → same
  full freeze, no boost. Fallback when the date has no
  `recoveryScore`: big-day heuristic banks +1 grace day (cap 2), spent the same
  way. Recovery data **only** extends adventure protection — normal
  run/strength/yoga decay after hard training weeks is unchanged.
- **Untouched:** `overall = min(run, strength?, yoga?)`; adventures never appear
  as a balance axis, never notch, never damage.

### State + versioning

New `EngineGardenState` fields (all defaulted via the existing `??=` pattern in
`simulate.ts`): `adventureGraceDays: number` (banked, heuristic path),
`lastAdventureDate?: string`, `weekDisciplines.adventure: number`.
`SIMULATION_VERSION` bump (landed as 5 → 6 after merging with the coach-era
engine, which had already taken 4 and 5) → automatic full resim in `advanceGarden`, which is
how retroactivity lands. Garden state is a versioned JSON blob — **no D1
migration needed**; `activities.sport` is already free-form text and
`daily_health.recovery_score` already exists.

Determinism: no new rng; all inputs (activities, recovery scores) are stored
per-date, so resimulation is deterministic **given the DB's contents at resim
time** — same stored inputs always produce the same state.

**Resim drift (accepted):** that same-DB-at-resim-time qualifier has one
observable consequence. Resimulation always rebuilds a day's inputs from
whatever the DB holds *now*, not from what it held when that day was first
simulated. If health data arrives late — a delayed `fatigueScore`/
`recoveryScore` sync landing after a day was already simulated — a later
resim can flip that day's grace decision (grace on ↔ grace off) once the
now-more-complete data is in the DB. This is still fully deterministic (same
DB contents in → same state out), bounded by the protective window
(`ADVENTURE_GRACE_CAP`, max 2 days), and the same class of acceptance the
design already makes for late-arriving activities, which retroactively
resimulate their own dates forward.

## 3. UI

Deliberately small surface:

- **`runs.tsx`:** labels from the registry; one new "Adventures" filter chip;
  empty-state copy for the chip.
- **`garden.tsx` caption/forecast voice:** when today is adventure-frozen or in
  grace, suppress loss voices (same mechanism as taper/rest suppression) and
  acknowledge: "Saturday's ridge walk is still keeping the beds shaded." Gentle
  tone — the garden asks, never accuses.
- **Week ribbon:** small mark on adventure days; week trio stays run/strength/yoga.
- **`api-client`:** expose `adventureGraceDays` / today's adventure-frozen state
  so the caption can speak.
- **Not in scope:** fourth balance bar, codex entries, new visitors/flourishes
  (deferred follow-up), insights discipline picker, weekly-review changes.

## 4. Testing

- **Engine (vitest):** threshold edges (load 39/40, 44/45 min); freeze on
  adventure day (clocks hold, no punishment); recovery-driven grace continues at
  59 and stops at 60; grace cap at 2; heuristic fallback when `recoveryScore`
  absent; boost respects shared lifeBonus caps; freeze-not-reset (clocks resume
  from prior values); version-bump defaulting of new fields; resim determinism
  (same inputs twice → deep-equal state).
- **Worker:** garden-sync maps non-discipline activities → `adventures[]` and
  joins `recoveryScore`; sub-threshold activities pass through without inputs.
- **Bridge/providers:** registry admission incl. unknown codes → `other`;
  census tally still counts unknowns.
- **Manual:** before/after screenshots on fixture stack; live resim sanity check
  after backfill (garden should look same-or-healthier).

## Constraints that must hold

- Determinism (no `Date.now`-style inputs; fresh rng keys only — none needed here).
- Gentle tone: garden asks, never accuses.
- Optional means optional: no code path may let an adventure's absence reduce any
  axis, notch any bar, or appear in loss voices.

## 5. Backfill / rollout

**Deploy order:**

1. Ship registry + bridge admission, then deploy worker + web together.
   New activities flow through the registry immediately, and
   `SIMULATION_VERSION` 3 → 4 means every account's garden auto-resimulates in
   full on its next read (`advanceGarden`'s version-mismatch path) — no D1
   migration involved, and the change is protective/additive only (freeze +
   grace + a small boost; nothing new can subtract), so shipping ahead of any
   backfill is safe.
2. Backfill previously-dropped activities: trigger "Backfill history" from
   Settings. That walks deep history through
   `services/coros-bridge/src/backfill.ts` and syncs it through the same
   bridge `/sync` path `routes/devices.ts` already uses — `ingestActivities`
   followed by `resimulateFrom(db, userId, ingest.affectedDates[0], prefs)` —
   so late-arriving activities retroactively resimulate from their own dates
   forward, the same mechanism the version bump uses. `skippedSportTypes`
   tallies say what backfill turned up. Note: unlike `pnpm coros:census`,
   there is currently no root-level `pnpm coros:backfill` CLI shortcut — the
   Settings button is the only trigger today; add one if a scriptable/headless
   path turns out to be needed.
3. Run `pnpm coros:census` to confirm zero unnamed `sportType` codes. Unknown
   codes already resolve to `"other"` and are admitted regardless
   (`sportIdForCorosCode`), so nothing is silently dropped — but a code that
   turns out to be common should get a real registry entry (`packages/domain/src/sport.ts`)
   and label instead of showing up as "Other" throughout the UI.
4. Screenshot before/after on the fixture stack (ports 8899/5199) before
   merge/deploy, per the standing review workflow.

Gap accepted: old dates may predate daily-health sync → those trips use the
heuristic fallback, by design (see the resim-drift note in §2 for the related,
narrower case of health data that arrives late but still within a day's grace
window).

**Threshold calibration:**

After backfill, eyeball the real load/duration distribution the census turns
up against `ADVENTURE_TUNING` (`packages/garden-engine/src/adventure.ts`:
`minLoad: 40`, `minDurationMin: 45`, `bigLoad: 80`, `bigDurationMin: 150`). If
a typical easy hike lands under load 40 — COROS `trainingLoad` tends to run
low for long, low-heart-rate efforts like hiking — lower `minLoad`, or lean
more on `minDurationMin` (a leisurely-but-long hike clears that even at low
load). Recheck `bigLoad`/`bigDurationMin` the same way once real data is in:
they gate whether a day banks a grace day, so an under-calibrated `bigLoad`
means genuinely big days won't shelter the day after.

**Fixture stack:** `apps/worker/src/services/fixtures.ts` now seeds three
adventure-shaped fixtures on top of the existing history, so the shield and
the neutral case are both visible without needing a real backfill: a
sub-threshold Wednesday walk (garden-neutral — shows up tagged in history but
never freezes a clock), a big Saturday hike (`trainingLoad: 120`,
`durationSeconds` = 4h, well past `bigLoad`), and a low-recovery
(`recoveryScore: 42`) health record for the Sunday right after it, so
`adventureGraceDay`'s Coros-recovery path — not just the banked-day fallback —
is what's driving the shield in the demo. (In passing: removed a dead
no-op `sources.push()` call — a leftover from the Strava-removal refactor,
in the same file.)
