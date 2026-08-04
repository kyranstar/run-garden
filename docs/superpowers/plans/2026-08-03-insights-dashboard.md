# Insights Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Run Garden Insights into a trustworthy dashboard: fix pipeline/math (Phase A), then restructure the screen with gauges, heatmap, and honest charts (Phase B).

**Architecture:** Pure metric math lives in `packages/analytics` (TDD, Node 21 vitest). The worker route (`apps/worker/src/routes/misc.ts`) assembles scoped, run-filtered inputs and ships an extended payload. UI (`packages/ui`) renders it with a shared SVG chart kit. Spec: `docs/superpowers/specs/2026-08-03-insights-dashboard-design.md` (authoritative for definitions/bands).

**Tech Stack:** TypeScript monorepo (pnpm), Hono + Drizzle/D1 worker, React + hand-rolled SVG charts, vitest.

## Global Constraints

- Tests run under Node 21 (`~/.nvm/versions/node/v21.7.3`); builds/wrangler under Node 22 (`~/.nvm/versions/node/v22.23.1`).
- `git add` specific paths only (never `git add -A`; repo has a multi-GB Rust target/ tree that SIGKILLs scans).
- Metric honesty contract: every metric returns `MetricResult<T>` (`ok`/`insufficient`) from `packages/analytics/src/metric.ts` — never a confident number from thin data.
- Band vocabulary: `"low" | "healthy" | "high" | "watch"` (existing `Band` type). Healthy renders silently.
- All new UI colors via existing CSS tokens (`--chart-1/2/3`, `--chart-grid`, `--chart-track`, `--ink-*`, `--green-soft`, `--danger` if present — verify in styles.css); both light and dark themes.
- Dates are `LocalDate` strings (`YYYY-MM-DD`); weeks are ISO Monday (`startOfIsoWeek` from `@rg/domain`).
- No new npm dependencies.

---

## Phase A — Truth layer

### Task A1: Load metrics rewrite (`load.ts`): EWMA load ratio, rolling ramp, monotony

**Files:**
- Modify: `packages/analytics/src/load.ts` (replace `computeAcwr`, `computeRampRate`, `computeBalance` — balance is deleted here, replaced by Task A3's `lowIntensityShare`)
- Test: `packages/analytics/test/load.test.ts` (new file; move/replace relevant cases from `test/insights-metrics.test.ts`)

**Interfaces (Produces):**
```ts
export interface LoadRatioValue {
  ratio: number;                 // 2dp; EWMA7/EWMA28
  pctVsNorm: number;             // Math.round((ratio - 1) * 100)
  series: Array<{ date: string; ratio: number }>; // last 56 days, one entry/day
}
export function computeLoadRatio(
  loadsByDay: ReadonlyArray<{ date: string; load: number }>,
  today: string,
): MetricResult<LoadRatioValue>;

export interface RampValue { deltaSeconds: number; pct: number } // acute 7d total vs prior-21d weekly norm
export function computeRamp(
  secondsByDay: ReadonlyArray<{ date: string; seconds: number }>,
  today: string,
): MetricResult<RampValue>;

export interface MonotonyValue { monotony: number; strain: number; weeklyLoad: number }
export function computeMonotony(
  loadsByDay: ReadonlyArray<{ date: string; load: number }>,
  today: string,
): MetricResult<MonotonyValue>;
```

**Algorithm (from spec §A2):**
- Shared helper `zeroFillDays(entries, from, to): number[]` — dense daily values, absent days = 0.
- `computeLoadRatio`: gate = ≥28 days since earliest positive-load entry (`insufficient(28, days, …)`); zero-fill from earliest to `today`; EWMA with λ=2/(N+1), N=7 and 28, seeded at the first day's value; walk day by day storing `ratio = ewma7/ewma28` (skip while `ewma28 < 1e-6` — if it's that small on `today`, return `insufficient` "needs runs in the last four weeks"); series = last 56 computed days.
- `computeRamp`: gate ≥28 days; acute = sum(last 7 days incl. today); norm = sum(prior 21 days)/3; if norm ≤ 0 and acute > 0 → `insufficient(28, have, "Ramp needs a recent baseline — you're returning from a break, build back gradually.")`; else `pct = Math.round(((acute - norm) / norm) * 100)`, `deltaSeconds = Math.round(acute - norm)`.
- `computeMonotony`: gate ≥14 days history and ≥4 positive-load days in the last 7 → else insufficient; values = last 7 zero-filled days; monotony = mean/populationStdDev (2dp), capped at 5 when stdev=0 (identical non-zero days); strain = weeklyLoad × monotony (rounded); weeklyLoad = sum of the 7 values.

- [ ] **Step 1: Write failing tests** — concrete cases (exact numbers):
```ts
// loadRatio: 60 days of steady 100/day → ratio ≈ 1.00 (±0.02), pctVsNorm 0, series.length 56
// loadRatio: 14 days of history → insufficient, needed 28
// loadRatio: 28 days at 50 then 7 days at 150 → ratio > 1.3 (spike detected)
// loadRatio: last run 30 days ago (all recent days zero) → insufficient (no recent baseline)
// ramp: 28 days of 3600 s/day → pct 0, deltaSeconds 0
// ramp: prior 21 days 1800 s/day, last 7 days 3600 s/day → pct 100
// ramp: no running in prior 21 days, running this week → insufficient (returning from break)
// monotony: alternating [200,0,200,0,200,0,200] → monotony ≈ 1.0 (mean 100, stdev 100)
// monotony: seven identical 100 days → capped 5, strain 3500
// monotony: 2 active days in last 7 → insufficient
```
- [ ] **Step 2:** `pnpm --filter @rg/analytics test` → new tests FAIL (functions undefined)
- [ ] **Step 3:** Implement in `load.ts`; delete `computeAcwr`, `computeRampRate`, `computeBalance`
- [ ] **Step 4:** Tests pass. Old `insights-metrics.test.ts` load-block cases: rewrite to the new functions' semantics (the "acwr honesty" sparse-history case must now assert `insufficient` — that regime was the 2× inflation bug)
- [ ] **Step 5:** Commit `feat(analytics): EWMA load ratio, rolling ramp, monotony/strain`

### Task A2: Recovery rewrite (`recovery.ts`): staleness, uncontaminated baselines, yesterday-inclusive streak

**Files:**
- Modify: `packages/analytics/src/recovery.ts`
- Test: `packages/analytics/test/recovery.test.ts` (new)

**Interfaces (Produces):**
```ts
export interface RestingHrValue {
  current: number;          // median of the 3 most recent readings
  baseline: number;         // median of readings within last 30 days (≥7 required)
  deltaBpm: number;         // current - baseline
  staleDays: number;        // whole days between newest reading date and today
  series: Array<{ date: string; value: number }>; // last 60 days, asc
}
export function computeRestingHr(rows, today: string): MetricResult<RestingHrValue>;

export interface HrvValue {
  recent: number;           // median of 7 most recent readings (all within 14 days)
  baseline: number;         // median of readings ranked 8..37 (uncontaminated)
  pctVsBaseline: number;    // 1dp
  thresholdPct: number;     // clamp(0.5 * CV% of baseline readings, 5, 15); 10 if CV incomputable
  staleDays: number;
  series: Array<{ date: string; value: number }>;
}
export function computeHrvTrend(rows, today: string): MetricResult<HrvValue>;

export interface HardStackValue { consecutive: number; strip: Array<{ date: string; hard: boolean }> } // strip = last 7 days asc
export function computeHardDayStacking(hardDates: readonly string[], today: string): MetricResult<HardStackValue>;
```

**Rules:** restingHr insufficient when <7 valid readings in 60 days OR newest reading >7 days old (explanation says how old). HRV insufficient when <17 valid readings (7 recent + 10 baseline) or >7 days stale; recent readings must be within 14 days of today else insufficient. hardStack: `consecutive = max(streakEndingAt(today), streakEndingAt(yesterday))`.

- [ ] **Step 1: Failing tests:**
```ts
// restingHr: readings ending today, last3 [53,52,54], 20 older around 48 → current 53, baseline ~48, delta 5, staleDays 0
// restingHr: newest reading 8 days ago → insufficient mentioning "8 days"
// restingHr: staleDays computed = 3 when newest is today-3
// hrv: 37 readings, recent7 median 58, readings 8..37 median 64 → pctVsBaseline ≈ -9.4, baseline 64
//      (contrast: old code's contaminated baseline would give ≈ -7.x — assert the uncontaminated value)
// hrv: thresholdPct = 10 when baseline CV is 0 (identical readings → SWC 0 → clamped to fallback 10)
// hrv: 16 readings → insufficient needed 17
// hardStack: hard [today-2, today-1], nothing today → consecutive 2 (yesterday-ending streak)
// hardStack: hard [today-2, today-1, today] → 3; strip has 7 entries, last one hard:true
// hardStack: no hard days → consecutive 0, ok (not suppressed)
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass (update the three old cases in `insights-metrics.test.ts` to new shapes). **Step 5:** Commit `feat(analytics): staleness-aware recovery metrics, uncontaminated HRV baseline, yesterday-inclusive hard streak`

### Task A3: Zones + intensity (`hrZones.ts`, new `lowIntensityShare.ts`, `easyDiscipline.ts`)

**Files:**
- Modify: `packages/analytics/src/hrZones.ts` (robust HRmax)
- Create: `packages/analytics/src/lowIntensityShare.ts`
- Modify: `packages/analytics/src/easyDiscipline.ts` (shared predicate + per-run ticks)
- Test: `packages/analytics/test/intensity.test.ts` (new)

**Interfaces (Produces):**
```ts
// hrZones.ts — replace estimateHrMax body:
// per-activity maxHeartRate values > 120, sorted desc → 2nd highest (or the only one);
// DELETE the maxAvg*1.05 fallback (returns null instead — caller decides).
export function estimateHrMax(activities: readonly NormalizedActivity[]): number | null;
export function isEasyHr(avgHr: number, hrMax: number): boolean; // zoneOf(avgHr, hrMax) <= 2 — THE shared predicate

// lowIntensityShare.ts:
export interface IntensityRunInput {
  activityId: string;
  durationSeconds: number;
  avgHeartRate: number | null;
  laps: Array<{ avgHeartRate: number | null; durationSeconds: number }>;
}
export interface LowIntensityValue {
  lowPct: number;                     // low / (low+high) * 100, rounded
  lowSeconds: number; highSeconds: number;
  noHrSeconds: number;                // excluded time, disclosed
  perActivity: Record<string, { lowSeconds: number; highSeconds: number }>;
}
export function computeLowIntensityShare(runs: IntensityRunInput[], hrMax: number): MetricResult<LowIntensityValue>;
// per run: laps with HR>0 & duration>0 → bucket each lap by isEasyHr(lap.avgHeartRate, hrMax);
// no usable laps but avgHeartRate>0 → whole duration in one bucket by isEasyHr(avg);
// no HR at all → noHrSeconds. Gate: ≥4 runs contributing HR time AND lowSeconds+highSeconds ≥ 4*3600.

// easyDiscipline.ts:
export interface EasyDisciplineValue {
  inEasyPct: number;
  ticks: Array<{ activityId: string; date: string; easy: boolean }>; // chronological
}
export function computeEasyDiscipline(
  easyRuns: ReadonlyArray<{ activityId: string; date: string; avgHr: number }>,
  hrMax: number,
): MetricResult<EasyDisciplineValue>; // uses isEasyHr; gate unchanged (≥5)
```

- [ ] **Step 1: Failing tests:**
```ts
// estimateHrMax: maxes [188, 201, 186] → 188 (2nd highest kills the 201 spike); single [190] → 190; none → null
// estimateHrMax: values ≤120 ignored (a 90-bpm "max" from a walk doesn't count)
// lowIntensityShare, hrMax 190 (ceiling 152): run A laps [30min@140, 10min@160] + run B..E 30min@140 avg-only
//   → lowSeconds 30+4*30 min, highSeconds 10 min, lowPct 94
// lowIntensityShare: 3 runs → insufficient
// easyDiscipline: boundary — avgHr exactly at easyCeiling(hrMax) counts EASY in BOTH pct and ticks (one predicate)
// easyDiscipline: [150easy,150easy,160over,150easy,150easy] hrMax190 → 80%, ticks[2].easy false
```
- [ ] **Step 2:** FAIL → **Step 3:** implement; add `export * from "./lowIntensityShare.js"` to `index.ts`. **Step 4:** pass. **Step 5:** Commit `feat(analytics): robust HRmax, HR time-in-zone low-intensity share, aligned easy predicate`

### Task A4: Aerobic rewrite (`stats.ts` Theil–Sen, `aerobicEfficiency.ts` uniform basis, new `decoupling.ts`)

**Files:**
- Modify: `packages/analytics/src/stats.ts` (add `theilSen`)
- Modify: `packages/analytics/src/aerobicEfficiency.ts`
- Create: `packages/analytics/src/decoupling.ts`; Delete: `packages/analytics/src/hrDrift.ts` (update `index.ts`)
- Test: `packages/analytics/test/aerobic.test.ts` (new; port keepable cases from `aerobicEfficiency.test.ts` + `hrDrift.test.ts`, delete those files)

**Interfaces (Produces):**
```ts
// stats.ts:
export function theilSen(points: ReadonlyArray<{ x: number; y: number }>): { slope: number; intercept: number };
// slope = median of pairwise slopes (skip equal-x pairs); intercept = median(y_i - slope*x_i)

// aerobicEfficiency.ts — value shape changes:
export interface AerobicEfficiencyValue {
  perRun: EfficiencyPoint[];                   // unchanged point shape (activityId, date, efficiency)
  trend?: { pct: number; n: number };          // Theil–Sen over day-index; only when n >= 6
  excludedCount: number;                       // eligible-category runs dropped for lacking usable laps
}
// runEfficiency: REQUIRE laps. Sort by lapIndex; drop laps fully inside the first 600s of cumulative
// time AND drop the final lap; need ≥2 remaining laps with distance>0 & duration>0 and ≥1 with HR.
// HR = duration-weighted lap HR over the used laps ONLY (never whole-run avg). No whole-run fallback.
// trend.pct = roundTo(slope * xLast / intercept * 100, 1) with x = days since first point.

// decoupling.ts:
export interface DecouplingPoint { activityId: string; date: string; decouplingPct: number }
export interface DecouplingValue {
  perRun: DecouplingPoint[];
  medianPct: number;
  excluded: { count: number; reasons: string[] };  // reasons = first 5, human-readable
}
export function computeDecoupling(runs: HrDriftRunInput[]): MetricResult<DecouplingValue>;
// eligibility: STEADY_CATEGORIES (easy|long|recovery), duration ≥ 2400s, and after trimming laps
// inside the first 600s: ≥4 laps with HR>0, pace>0 (avgPaceSecPerKm), duration>0. Keep the ±25% pace-surge filter.
// per-run: split trimmed laps into halves by cumulative-time midpoint (existing rule);
// each half: speed = Σdist/Σtime — derive lap dist as duration/ (pace s/km) * 1000/… use pace: meters = duration/pace*1000;
// hr = duration-weighted; ratio = speed/hr; decouplingPct = roundTo((ratio1/ratio2 - 1) * 100, 2).
```

- [ ] **Step 1: Failing tests:**
```ts
// theilSen: y = 2x+1 exactly → slope 2, intercept 1; one wild outlier in 8 points barely moves slope (|Δ|<0.2)
// efficiency: run with laps [5min,5min,10min,10min,10min,5min] — first two (≤600s cumulative) and last dropped;
//   middle 30min@[150,150,150]bpm 6km → efficiency uses only those 3 laps
// efficiency: eligible easy run with 0 laps → excludedCount 1, not in perRun (NO whole-run fallback)
// efficiency: 5 points → trend undefined; 6 points spaced over days with +10% linear rise → trend.pct ≈ +10 (±1), n 6
// decoupling: constant pace & HR (after trim) → 0%
// decoupling: same pace both halves, HR +5% in H2 → ≈ +5
// decoupling: H2 pace 5% slower AND HR 5% lower → ≈ 0 (the Pa:HR point — HR-only would say -5)
// decoupling: 35-minute run → excluded (≥40min); interval category → excluded with reason
```
- [ ] **Step 2:** FAIL → **Step 3:** implement (delete hrDrift.ts, fix index.ts export to `decoupling.js`). **Step 4:** pass. **Step 5:** Commit `feat(analytics): lap-basis efficiency with Theil–Sen trend, Pa:HR decoupling replaces HR drift`

### Task A5: Pacing, consistency days/pending, weekly training (`performance.ts`, `consistency.ts`, `weeklyTraining.ts`)

**Files:**
- Modify: `packages/analytics/src/performance.ts` (replace `negativeSplit` with `computePacing`; delete `predictRaces`)
- Modify: `packages/analytics/src/consistency.ts`
- Modify: `packages/analytics/src/weeklyTraining.ts`
- Test: `packages/analytics/test/pacing-consistency.test.ts` (new); update `consistency.test.ts`, `weeklyTraining.test.ts`

**Interfaces (Produces):**
```ts
// performance.ts:
export interface PacingValue { medianDeltaSecPerKm: number; negativePct: number } // delta = secondHalfPace - firstHalfPace; + = fade
export function computePacing(runs: ReadonlyArray<{ firstHalfPace: number; secondHalfPace: number }>): MetricResult<PacingValue>; // gate ≥4

// consistency.ts — ConsistencyReport gains:
//   pending: number;                    // = old `unresolved` (renamed in report, field kept too)
//   days: ConsistencyDay[];             // every date in range
// adherenceRate & weekly denominators now EXCLUDE unresolved: denom = planned - future - unresolved.
export interface ConsistencyDay {
  date: LocalDate;
  status: "completed" | "moved" | "skipped" | "missed" | "pending" | "rest" | "future" | "none";
}
export function computeConsistency(workouts, range, today: LocalDate): ConsistencyReport; // today param NEW
// day status precedence when multiple workouts share a date: missed > skipped > pending > moved > completed > future > rest.
// scheduled with effectiveDate <= today → "pending" (sync limbo), > today → "future".

// weeklyTraining.ts — WeeklyTotals gains lowSeconds/highSeconds/partial; signature:
export function computeWeeklyTraining(
  activities: NormalizedActivity[],
  categoryByMatchId: Record<string, WorkoutCategory>,
  opts?: { today?: LocalDate; intensityByActivity?: Record<string, { lowSeconds: number; highSeconds: number }> },
): WeeklyTrainingReport;
// partial = weekStart === startOfIsoWeek(opts.today); fourWeekAvgDuration/twelveWeekAvgDuration over
// the most recent 4/12 COMPLETE weeks (skip the partial one); low/high from intensityByActivity when
// present for the activity, else category (quality/race → high, everything else low).
```

- [ ] **Step 1: Failing tests:**
```ts
// pacing: deltas [+8,+4,-2,+6] s/km → medianDeltaSecPerKm +5, negativePct 25
// consistency: unresolved workout → pending 1, NOT in adherence denominator (2 completed of 2 resolved → 100%)
// consistency: days[] — moved-completed workout day → "moved"; empty day → "none"; rest day → "rest";
//   scheduled yesterday (limbo) → "pending"; scheduled tomorrow → "future"
// weeklyTraining: today mid-week → last week partial:true, fourWeekAvgDuration ignores it (avg of the 4 complete ones)
// weeklyTraining: intensityByActivity {a1:{low:1200,high:600}} → that week lowSeconds 1200 highSeconds 600
```
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** pass (update every `computeConsistency` call in existing tests to pass `today`). **Step 5:** Commit `feat(analytics): pacing metric, pending-aware consistency day grid, complete-week averages`

### Task A6: Records persistence-shape + evidence rotation (`records.ts`, `evidence.ts`, `timeOfDay.ts`)

**Files:**
- Modify: `packages/analytics/src/records.ts` — delete `mostEvenIntervalSet` + `lowestHrAtComparablePace`; `RecordsInput` drops `executions`; keep best-efficiency / most-consistent-4-weeks / fastest-comeback. Add pure merge helper:
```ts
export interface StoredRecord { id: string; title: string; value: string; achievedOn: LocalDate; rule: string; numeric: number }
export function mergeRecords(fresh: Array<PersonalRecord & { numeric: number }>, stored: StoredRecord[]): StoredRecord[];
// per id: keep whichever has better `numeric` (higher wins — callers normalize so higher is always better);
// records never regress: a stored record survives even when fresh is absent.
```
  (Give each remaining record builder a `numeric` field: efficiency m/beat as-is; consistency = min-week adherence; comeback = -daysToRegain so higher = faster.)
- Modify: `packages/analytics/src/evidence.ts` — `morningCard` gains per-window gate (≥3 planned in EACH window before comparative phrasing) and includes `medianStartDeltaMinutes` in its body when present.
- Modify: `packages/analytics/src/execution.ts` → DELETE file (only consumer was the dead record); remove export from `index.ts`.
- Test: update `records.test.ts`, `evidence.test.ts` (or equivalents in `test/`)

- [ ] Steps: failing tests (mergeRecords keeps stored when fresh worse/absent; replaces when fresh better; morningCard suppressed at 2-morning-planned) → implement → pass → commit `feat(analytics): never-regressing records, gated evidence rotation`

### Task A7: Worker route rewrite (`apps/worker/src/routes/misc.ts` insights GET)

**Files:**
- Modify: `apps/worker/src/routes/misc.ts:270-585`
- Modify: `packages/analytics/src/interpret.ts` — `InterpretedMetric` & `Presentation` gain optional `gauge?: { min: number; max: number; healthyLo: number; healthyHi: number; value: number }`, `series?: Array<{ date: string; value: number }>`, `strip?: Array<{ date: string; on: boolean }>`, `staleNote?: string`.
- Modify: `packages/database/src/schema/product.ts` consumers only if needed — records persistence uses the existing `computedMetrics` table (`inputFingerprint` keyed); READ its actual columns first and adapt (store JSON of `StoredRecord[]` under a fixed id like `records:v1:{userId}`).

**Assembly rules (each maps to a spec §A1 bullet):**
1. Queries in one `Promise.all`: workouts, activities (window padded: `gte(startTime, addDays(twelveWeeksAgo,-1)+"T00:00:00Z")`), dismissed, dailyHealth (`gte(date, addDays(today,-60))` AND `lte(date, today)`), reviews, storedRecords. THEN laps: `inArray(activityLaps.activityId, chunkIds(actIds))` over the fetched activities' ids; matches scoped: `inArray(workoutCompletionMatches.workoutId, chunkIds(workoutIds))` + `isNull(undoneAt)`.
2. `const runs = acts.filter(a => a.sport === "run" && localDate(a) >= twelveWeeksAgo && localDate(a) <= today)`; `allSport = acts` (same local-date filter) for load metrics only.
3. Category: `matched ? categoryByMatchId.get(...) ?? "unknown" : "unknown"` — the string `"easy"` never appears as a default. `runSamples` category-gated metrics receive `"unknown"` and their eligibility already rejects it.
4. Load basis: `loadCovered = allSport.filter(a => a.trainingLoad != null)`; use `trainingLoad` basis when covered duration ≥ 90% of total duration, else minutes; build `loadsByDay` accordingly (basis mentioned in the card's sampleNote).
5. `hardDates`: matched quality/race runs, plus unmatched runs with `avgHeartRate > easyCeiling(hrMax)`, plus runs ≥ 6000s.
6. `hrMax = estimateHrMax(runs) ?? 190`; `intensity = computeLowIntensityShare(intensityInputs, hrMax)`; feed `intensity.value.perActivity` into `computeWeeklyTraining(runs, categoryRecord, { today, intensityByActivity })`.
7. `interpreted` ids/titles (replaces old list): `loadRatio` "Load vs your norm", `ramp` "7-day ramp", `monotony` "Load variety", `restingHr`, `hrv`, `hardStack`, `lowIntensityShare` "Low-intensity share", `easyDiscipline`, `pacing` "Pacing". Bands per spec §A2 (loadRatio low<0.8 / watch 1.3–1.5 / high>1.5; ramp watch>15 high>30; monotony watch≥1.5 high>2.0; restingHr watch delta≥5 && staleDays≤2; hrv watch pct≤−threshold; hardStack watch≥2; lowIntensity watch<75 high<65; easyDiscipline watch<80; pacing no band). Every banded card sets `gauge` (e.g. loadRatio `{min:0.5,max:2,healthyLo:0.8,healthyHi:1.3,value:ratio}`). restingHr/hrv set `series`; hardStack sets `strip`; easyDiscipline maps `ticks`→`strip`; stale recovery cards set `staleNote: "last reading N days ago"` and band undefined.
8. Records: fresh = `computeRecords({runs: windowRunSamples, weeklyAdherence, completedRunDates: runDates})` → `mergeRecords(fresh, stored)` → upsert JSON back to `computedMetrics` → respond with merged.
9. Evidence: pass `dismissedIds` into `pickEvidenceCard` (change its signature: `pickEvidenceCard(input, dismissedIds: ReadonlySet<string>)` — skip dismissed inside the chain so the fallback fires).
10. Payload: `{ consistency, weekly, efficiency, decoupling, records, evidence, reviews, interpreted }` — `timeOfDay` REMOVED (evidence card covers it); `decoupling.value.excluded = { count, reasons: reasons.slice(0,5) }`; drilldowns: keep easyDiscipline lap detail (`over` computed via `!isEasyHr` — the shared predicate) + pacing detail (from `splitRuns` diffs, steady-category-only); efficiency/decoupling perRun points already carry `activityId`.
11. `splitRuns` loop: only over steady-category matched runs (`easy|long|recovery`).

- [ ] **Step 1:** Write failing route tests FIRST in `apps/worker/test/insights-route.test.ts` using the existing worker test harness (mirror `vertical-loop.test.ts` setup + `fixtures.ts`): (a) yoga activity with HR never reaches easyDiscipline/lowIntensity inputs; (b) unmatched tempo run absent from efficiency perRun; (c) two same-window users: user B's laps/matches never appear in user A's response (create both, assert isolation); (d) dismissing the comeback evidence card surfaces the next card, not null; (e) stored record survives when the achieving run leaves the window (seed computedMetrics, respond includes it); (f) payload has no `timeOfDay` key; `decoupling` present, `drift` absent.
- [ ] **Step 2:** Run (Node 21) → FAIL. **Step 3:** Implement route + interpret.ts extensions. **Step 4:** Suite green. **Step 5:** Commit `feat(worker): scoped, run-filtered insights assembly with extended payload`

### Task A8: Cron, devices upsert guard, bridge 60-day wellness

**Files:**
- Modify: `apps/worker/src/index.ts:121-150` — weekly(): drop the matched-only filter; `acts` = user's activities where `sport === "run"` and local date within [weekStart, weekEnd] (keep matches for adherence facts). Change cron case `"0 14 * * 1"` → `"0 20 * * 1"`.
- Modify: `apps/worker/wrangler.toml` (or wrangler.jsonc — find the crons array) `0 14 * * 1` → `0 20 * * 1`.
- Modify: `apps/worker/src/routes/devices.ts:257-268` — onConflictDoUpdate set becomes null-safe:
```ts
set: {
  restingHeartRate: sql`COALESCE(excluded.resting_heart_rate, ${dailyHealth.restingHeartRate})`,
  hrv: sql`COALESCE(excluded.hrv, ${dailyHealth.hrv})`,
  // …same for recoveryScore, fatigueScore, trainingLoad7d; fingerprint/updatedAt unconditional
}
```
  (verify generated SQL column names against the schema's actual snake_case.)
- Modify: `services/coros-bridge/src/cloud-sync.ts` + `snapshot.ts` — add `HEALTH_PAST_DAYS = 60`; pass a separate wellness range into the `getDailyMetrics` call so health covers 60 days while activities stay 14.
- Test: extend `insights-route.test.ts` or the devices test with: pushing `{date, restingHeartRate: null}` over an existing `{date, restingHeartRate: 48}` leaves 48.

- [ ] Steps: failing upsert test → implement → pass → commit `fix(worker,bridge): weekly review counts all runs; wellness upserts never null good data; 60-day health backfill`

### Task A9: Typed API client + UI compile

**Files:**
- Modify: `packages/api-client/src/index.ts:409` — add `export interface InsightsResponse { … }` (transcribe the exact Task A7 payload; `interpreted: InterpretedMetric[]` imported type or structural copy) and `insights: () => get<InsightsResponse>("/api/insights")`.
- Modify: `packages/ui/src/screens/insights.tsx` — minimal compile fix ONLY (Phase B restructures it): consume `InsightsResponse`, delete the local blind-cast interfaces, delete the time-of-day card, render `decoupling` where `drift` was. App must build and run between phases.
- [ ] Steps: typecheck (`pnpm -r typecheck` or build) Node 22 → fix → full test suite Node 21 green → commit `feat(api): typed insights response; UI consumes decoupling payload`

---

## Phase B — Dashboard

> Before ANY Phase B code: load the `dataviz` skill and the `frontend-design:frontend-design` skill; re-read `packages/ui/src/styles.css` token block (lines ~20-70) for the palette contract.

### Task B1: Chart kit (`packages/ui/src/chart-kit.tsx` new)

**Files:** Create `packages/ui/src/chart-kit.tsx`; Test `packages/ui/test/chart-kit.test.ts` (pure helpers only)

**Produces (consumed by B2/B3/B4):**
```ts
export function niceTicks(lo: number, hi: number, count?: 3): number[];        // nice-number algorithm, returns ascending ticks spanning [lo,hi]
export function dateX(dates: string[], innerW: number, left: number): (date: string) => number; // time-scaled, clamps single date to center
export function rollingMedian(values: number[], window: 5): number[];          // centered, shrinks at edges
export function useChartTooltip(): { containerProps; TooltipEl; register(mark: { x: number; y: number; label: string }): void };
// One pointer/touch overlay per chart: pointermove → nearest registered mark within 24px shows TooltipEl;
// pointerdown on touch pins/unpins. Positions in viewBox units scaled via getBoundingClientRect.
export function ReferenceLine({ y, label, dashed }): JSX; export function ShadedBand({ y1, y2 }): JSX;
export function HatchDefs(): JSX; // <pattern id="hatch"> for partial-week bars
export function TrendChip({ pct, betterWhen }: { pct: number; betterWhen: "up" | "down" }): JSX; // ▲/▼ + %, colored good/bad, tabular-nums
```
- [ ] Steps: failing tests for `niceTicks` (e.g. lo 1.07 hi 1.19 → [1.05,1.1,1.15,1.2]-style nice steps), `rollingMedian` ([1,9,1,9,1] w5 → center 1... assert exact), `dateX` proportional gaps → implement → pass → commit `feat(ui): chart kit — ticks, date scale, rolling median, touch tooltips, trend chip`

### Task B2: Tile visuals (`packages/ui/src/signal-tiles.tsx` new)

**Produces:** `<SignalTile m={InterpretedMetric} onDrill>` rendering by shape: `Gauge` (from `m.gauge`: 6px track, shaded healthy span, value marker + value text), `Sparkline` (from `m.series`: last 14 points, current accented), `StripBoxes` (from `m.strip`: 7 squares), value/pill/meaning/suggestion/staleNote text (reuse existing card CSS classes; add `.gauge-*`, `.spark-*`, `.strip-*` styles to `styles.css` with dark-theme variants). `<StatusStrip interpreted={…} adherencePct>` — first `high` band, else first `watch`, else all-clear line; anchors scroll via `document.getElementById("signal-"+id)`.
- [ ] Steps: build → visual check via existing screenshot script → commit `feat(ui): signal tiles with gauges, sparklines, strips; status strip`

### Task B3: Charts rebuilt (`packages/ui/src/charts.tsx`)

- `RunSeriesChart` → date-scaled x (`dateX`), muted dots (r3, 45% opacity) + 2px `rollingMedian` line, `niceTicks` axis, optional `band={y1,y2}` + `zeroLine` props (decoupling passes 0–5 band), tooltip overlay, dot click → `onPointClick(activityId)`.
- `WeeklyDurationChart` → segments low/high intensity (`lowSeconds/highSeconds`), gap SUBTRACTED from segment height, square baseline corners (path, not rx-rect, or rx on top only), partial week hatched + "(in progress)" tooltip, `avgLine` prop (4-complete-week avg) as labeled hairline, tooltip overlay.
- New `ConsistencyHeatmap({ days, onDayClick })`: 12×7 grid from `consistency.days`, statuses → tokens (completed `--chart-1`, moved `--chart-1` at 55% + dot, pending `--chart-track` + ring, missed `--danger`-tinted ✕ glyph rendered as path, rest faint, future empty, none transparent); weekday row labels Mon–Sun, month labels on week columns; legend via ChartFrame; ≥16px cells at 360px (12 cols fit: 12*~26px).
- New `OutcomeBar({ completed, moved, pending, skipped, missed, planned })`: single 12px stacked horizontal bar + count legend line.
- `LapHrBars` (in insights.tsx → move into charts.tsx): diverging from ceiling — bars anchored at `y(threshold)`, up = over (`--chart-2`-family/danger token), down = under (`--chart-1`), ceiling line labeled, ChartFrame-wrapped with real summary, tokens only.
- New `DivergingPaceBars({ runs })` for pacing drilldown: one thin bar per run from 0, left/right by sign of delta.
- New `BaselineBandChart({ series, baseline, bandPct })` for recovery drilldowns: 60d dots + 7-day rolling median line + shaded `baseline±band`.
- All dates through one `formatShortDate` helper added to `components.tsx` (used by every chart + drill rows); all weekly durations in hours 1dp.
- [ ] Steps: helpers already tested (B1); build; screenshot pass; commit `feat(ui): honest rebuilt charts — heatmap, outcome bar, diverging laps, baseline bands`

### Task B4: Screen restructure (`packages/ui/src/screens/insights.tsx`) + error boundary

Layout per spec §B1: StatusStrip → Signals card (three labeled subgroups, tile grid `repeat(auto-fill,minmax(150px,1fr))`) → Consistency card (adherence headline + OutcomeBar + Heatmap) → Weekly training card → Aerobic card (efficiency + decoupling side-by-side ≥720px via CSS grid, TrendChip in headers, visible median/trend in note) → Records → Weekly review (latest + `<details>` disclosure). Drilldowns: tiles → existing Sheet (recovery tiles get BaselineBandChart; pacing gets DivergingPaceBars; easyDiscipline gets diverging LapHrBars); heatmap day click → workout sheet if a workout exists that day (reuse existing workout sheet if importable, else no-op); chart dot click → runs screen route (`location.hash`/router — match app's existing navigation in `shell.tsx`). Drill affordance = `n runs ›` chip (kill the repeated sentence). New `ErrorBoundary` component wrapping the screen (class component, "Couldn't render insights — retry" + refetch). Fix `styles.css:1724` `var(--muted, #667)` → `var(--ink-faint)`; delete `.lap-bar` hardcoded hexes (tokens now); keep "normal earns silence".
- [ ] Steps: build Node 22; e2e smoke (`apps/web/e2e/smoke.spec.ts`) updated if it asserts old cards; screenshot both themes at 360px and 1024px via `apps/web/scripts/screenshots.mjs`; commit `feat(ui): insights dashboard — status strip, signal grid, heatmap, small multiples`

### Task B5: Final verification

- [ ] Full suite Node 21 (`pnpm -r test`) green; typecheck + web build Node 22 green.
- [ ] `superpowers:requesting-code-review` pass over the branch diff; fix findings.
- [ ] Update `docs/ANALYTICS.md` to the new metric set (definitions + bands, one paragraph each).
- [ ] Commit; leave branch `insights-dashboard` ready for the user's PR/merge (no deploy).

## Self-review notes

- Spec coverage: A1→§A2 load; A2→§A2 recovery; A3→§A2 execution zones; A4→§A2 aerobic; A5→§A2 pacing+§A3 consistency/weekly; A6→§A3 records/evidence; A7→§A1+§A5; A8→§A3 cron+§A4 bridge; A9→§A5 client; B1-B4→§B1-B4; B5→§Testing. Monotony gauge/band: spec watch 1.5–2.0 high>2.0 — A7 rule matches.
- Type consistency: `LoadRatioValue.series` date+ratio (chart uses value key `ratio` — SignalTile Sparkline reads `m.series` {date,value}; route maps ratio→value when setting `series`). `ConsistencyDay.status` union matches heatmap map. `HardStackValue.strip` {date,hard} → route maps to `strip` {date,on}.
- Known judgment calls implementers may NOT change silently: no whole-run efficiency fallback; unresolved excluded from adherence; records merge favors stored on ties.
