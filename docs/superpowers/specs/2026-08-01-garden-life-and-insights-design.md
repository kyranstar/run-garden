# Garden liveliness & comprehensive insights — design

Date: 2026-08-01
Status: approved-direction, pending spec review

Two independent enhancement passes for Run Garden:
- **A. Bring the garden to life** — ambient atmosphere (moving sun/time-of-day, wind) always on; new creatures (squirrels, rabbits, frogs, more insects, richer birds) *earned* by training richness; an unobtrusive species-diversity breakdown on the garden page; all reflected in the standalone HTML demo.
- **B. Comprehensive, interpretable insights** — every metric framed *educationally with gentle guidance*: what it is, your number, a healthy/typical range and where you fall, a light "this tends to suggest…", and an honest sample-size caveat. Never prescriptive/bossy.

Non-goals: no new external data sources; no auto-changing the training plan; keep honest small-sample suppression.

---

## A. Garden liveliness

### A1. Ambient (always on — rendering-time, NOT persisted garden state)
The garden *state* stays fully deterministic (event-sourced replay is unchanged). Sun position and wind gusts are **rendering-time ambiance** driven by a prop, exactly like the existing animations — they never touch the persisted snapshot.

- **Moving sun + time of day.** `GardenScene` gains an optional `timeOfDay` prop (0–24 hours, default from `new Date()` in the live app; the demo drives it with a slider). Drives: sun x/y along an arc, sun size/glow, sky gradient warmth (dawn gold → midday → dusk amber → night), plant/hill shadow direction, and at night a moon + stars + boosted fireflies. Reduced-motion still respected.
- **Wind.** A gentle base sway (exists) plus periodic gusts that deepen the sway amplitude and spawn a few drifting leaves; wind visibly strengthens for the "pre-rain" moment. Rendering-time only.

### A2. Creatures (earned — engine state)
New `WildlifeKind`s added to `@rg/domain` and to `snapshot.wildlife`. The engine (`packages/garden-engine/src/simulate.ts`) sets each true/false from garden conditions, mirroring the existing bird/bee logic. Proposed unlock conditions (tunable):

| Creature | Appears when |
|---|---|
| squirrels | ≥1 mature tree (long-run streak) + garden not in drought |
| rabbits | lush + well-watered (high moisture, groundcover present) |
| frogs | after rest/recovery (shade plants present, recent rest observed) |
| dragonflies | high flowering density in summer |
| ladybugs | flowers present, not drought |
| ants | ground-level, most conditions (very common) |
| moths | night-time ambiance (rendering-time, paired with fireflies) |

`GardenScene` gets a small shape-renderer per creature (SVG, in the existing style), placed relative to plants/ground with deterministic jitter (stable `rng()` keys), animated (scamper/hop/flit) unless reduced-motion.

### A3. Species-diversity strip (garden page, unobtrusive)
A thin horizontal stacked bar + tiny per-category counts (trees, flowers, ferns/shade, vines, groundcover/grass, shrubs, fungi) computed from `snapshot.plants` grouped by `species.category`, plus a one-line biodiversity readout (e.g., "7 of 7 plant families · biodiversity high"). Low-key, sits by the species-collection card. New small UI component in `packages/ui`.

### A4. Demo
`packages/garden-renderer/demo` updated: creatures appear across the timeline as the garden matures; add a **time-of-day slider** (sunrise→night) and a **wind toggle**; the weather showcase gains the new creatures; each creature/weather labeled. Rebuild the single-file HTML.

### A5. Files touched (A)
`@rg/domain` (WildlifeKind), `packages/garden-engine/src/{types,simulate,condition}.ts` (new wildlife flags + unlock logic), `packages/garden-renderer/src/GardenScene.tsx` (sun/time, wind, creature shapes), `packages/garden-renderer/demo/*`, `packages/ui/src/screens/garden.tsx` + `styles.css` (diversity strip).

---

## B. Comprehensive, interpretable insights

### B1. The interpretable result shape
A single result type every insight returns (in `@rg/analytics`), so the UI renders them uniformly:

```
InterpretedMetric = {
  id, title,
  state: "ok" | "insufficient_data",
  value: string,                 // formatted, e.g. "3.2%" / "1.08" / "62 bpm"
  band?: "low" | "healthy" | "high" | "watch",  // where you fall
  range?: string,                // healthy/typical range, e.g. "under 5%"
  meaning: string,               // plain-language "what this is / what yours means"
  suggestion?: string,           // GENTLE, optional: "this tends to suggest…"
  sampleNote: string,            // honest N / caveat
  trend?: { direction: "up"|"down"|"flat"; better: "up"|"down"|"either" }
}
```

Sample-size suppression stays: below threshold → `state: insufficient_data` with a "need N more runs" note; never a confident number.

### B2. HR-zone model (dependency for several metrics)
Several metrics need zones. Estimate **HRmax** from the max HR observed across the user's activities (fallback: highest `maxHeartRate`), derive 5 zones as %HRmax (Z1 <68%, Z2 68–79%, Z3 80–87%, Z4 88–94%, Z5 95%+). Note assumption in the UI; allow a `maxHeartRate` preference override later. If no HR data, zone metrics report `insufficient_data`.

### B3. Metrics to build first (★ across all four themes)

**Aerobic fitness trend**
- **Aerobic efficiency trend** — pace-per-heartbeat (EF) over recent easy runs; healthy = trending up. (extend existing `aerobicEfficiency`)
- **Cardiac drift** — HR:pace decoupling on long runs; range "under ~5% is strong aerobic durability". (extend existing `hrDrift`)
- **Easy-run discipline** — % of easy-run time actually in Z1–Z2; healthy ≈ ≥80%.

**Recovery / readiness**
- **Resting HR vs baseline** — today vs your 30-day median; a multi-day rise of ≥5 bpm = fatigue/illness watch. (from `dailyHealth`)
- **HRV trend** — 7-day vs baseline; sustained drop = accumulated stress.
- **HR-zone distribution (weekly)** — % time per zone; flag "too much Z3 grey zone".
- **Hard-day stacking** — consecutive days with a quality/race effort; ≥2–3 in a row = watch.

**Injury-risk / load**
- **Acute:chronic load ratio (ACWR)** — 7-day load ÷ 28-day average load (COROS `trainingLoad`, fallback duration); sweet spot 0.8–1.3, >1.5 = spike/watch.
- **Weekly ramp rate** — this week's volume vs last; >~10%/wk = watch.
- **Easy/quality/long balance** — share of each by category; healthy ≈ mostly easy.

**Performance / predictions**
- **Predicted race times** — Riegel from recent best efforts (1k/5k from laps or full-run pace); framed as "a rough estimate from your recent running".
- **Negative-split tendency** — second-half vs first-half pace across runs (from laps); finishing faster = good pacing/durability.
- **Best-effort trends** — fastest rolling 1k / 5k over time (from `activityLaps`).
- **Morning vs evening** — pace/HR difference by run window. (extend existing `timeOfDay`)

The remaining brainstorm items (grade-adjusted pace, sleep-vs-performance, monotony/strain, adherence) are a documented **menu** to enable later.

### B4. Compute + surface
New metric modules in `packages/analytics/src/*`, aggregated by the insights route (`apps/worker/src/routes/misc.ts` `insightRoutes`), which already loads activities + laps + planned workouts + daily health. Insights screen (`packages/ui/src/screens/insights.tsx`) renders the uniform `InterpretedMetric` cards, grouped by the four themes, with an "explain" line each. Existing charts (weekly duration, adherence, run-series) stay.

### B5. Files touched (B)
`@rg/analytics` (result type + new metric modules + HR-zone helper), `apps/worker/src/routes/misc.ts` (insights aggregation), `packages/ui/src/screens/insights.tsx` (+ a small `InterpretedMetric` card component), possibly `@rg/domain` (zone thresholds), `packages/database` only if a `maxHeartRate` preference is added (deferred).

---

## Testing
- Analytics: unit tests per new metric (values, bands, and `insufficient_data` thresholds) — the package already has this pattern.
- Engine: determinism test still passes with new wildlife flags; unlock-condition tests.
- Renderer/demo: headless render check (SVG count, no console errors), screenshot review.
- Full suite green under Node 21; typecheck all packages.

## Phasing
1. **Insights** (B) — result type + HR-zone helper + the ★ metrics + UI. Ships via web deploy.
2. **Garden life** (A) — engine wildlife + renderer sun/wind/creatures + diversity strip + demo. Ships via web deploy (+ demo file); no desktop release needed.

Each phase: typecheck + tests + deploy, then review.
