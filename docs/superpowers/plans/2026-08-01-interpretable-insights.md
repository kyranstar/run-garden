# Interpretable Insights (Phase 1) Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Steps use `- [ ]`.

**Goal:** Add an educational, gently-guided insight layer — every metric shows what it is, your number, a healthy range and where you fall, a soft "this tends to suggest…", and an honest sample caveat — with the ★ metrics across aerobic fitness, recovery, load, and performance.

**Architecture:** Build on the existing `MetricResult<T>` pattern in `@rg/analytics`. A thin `interpret()` layer wraps a computed value into an `InterpretedMetric` (adds band/range/meaning/suggestion). New pure metric modules follow the existing file-per-metric convention; the insights route aggregates them; the insights screen renders a uniform card.

**Tech Stack:** TypeScript monorepo, `@rg/analytics` (pure functions + vitest), Hono worker route, React UI. Node 21 for tests (better-sqlite3 ABI), Node 22 for wrangler/build.

## Global Constraints
- Keep honest sample-size suppression: below threshold → `insufficient_data`, never a confident number.
- Gentle guidance only — no imperatives ("aim for"/"you should"); use "this tends to…".
- Pure metric functions (no I/O); data is passed in. Follow `aerobicEfficiency.ts` shape.
- All packages typecheck; full vitest suite green under Node 21.

---

### Task 1: Interpretive layer (`InterpretedMetric` + helpers)

**Files:** Create `packages/analytics/src/interpret.ts`; Test `packages/analytics/test/interpret.test.ts`; Modify `packages/analytics/src/index.ts` (export).

**Produces:**
```ts
export type Band = "low" | "healthy" | "high" | "watch";
export interface InterpretedMetric {
  id: string; title: string;
  status: "ok" | "insufficient_data";
  value?: string; band?: Band; range?: string;
  meaning: string; suggestion?: string; sampleNote: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
}
export function interpret(id: string, title: string, m: MetricResult<unknown>, present: (v: unknown) => Omit<InterpretedMetric,"id"|"title"|"status"|"sampleNote">): InterpretedMetric;
```
`interpret` maps `ok` → filled card (calls `present(value)`, carries `sampleNote` from `comparisonNote`), and `insufficient_data` → `{status, meaning, sampleNote: explanation}` with no value.

- [ ] Test: `interpret` on an `ok(3, 5, "note")` returns status ok, value/meaning from `present`, sampleNote "note"; on `insufficient(5,2,"need 3")` returns status insufficient_data, sampleNote "need 3", no value.
- [ ] Implement; run `npx vitest run interpret`; commit.

---

### Task 2: HR-zone helper

**Files:** Create `packages/analytics/src/hrZones.ts`; Test `packages/analytics/test/hrZones.test.ts`; export in index.

**Produces:** `estimateHrMax(activities: NormalizedActivity[]): number | null` (max observed `maxHeartRate`, else max `avgHeartRate` * 1.05, else null). `zoneOf(hr: number, hrMax: number): 1|2|3|4|5` with bounds Z1<0.68, Z2<0.80, Z3<0.88, Z4<0.95, Z5≥0.95.

- [ ] Test: hrMax from activities; zoneOf(140,190)=2, zoneOf(180,190)=5, boundary 0.68*190≈129→Z2.
- [ ] Implement; test; commit.

---

### Task 3: Load & balance metrics

**Files:** Create `packages/analytics/src/load.ts`; Test `.../test/load.test.ts`; export.

**Produces:**
- `computeAcwr(loadsByDay: {date:string; load:number}[], today:string): MetricResult<{ acwr:number; acute:number; chronic:number }>` — acute = sum last 7d, chronic = avg weekly over last 28d; ACWR = acute/chronic. Need ≥14 days with load. Band via caller: 0.8–1.3 healthy, <0.8 low, >1.5 watch.
- `computeRampRate(weeklySeconds:number[]): MetricResult<{ pct:number }>` — (thisWeek-lastWeek)/lastWeek. Need ≥2 weeks.
- `computeBalance(byCategorySeconds: Record<string,number>): MetricResult<{ easyPct:number; qualityPct:number; longPct:number }>` — need ≥ 4 runs total.

- [ ] Tests: ACWR math (acute 400/chronic 350 → 1.14 healthy; insufficient <14d); ramp 10%; balance percentages sum ~100.
- [ ] Implement; test; commit.

---

### Task 4: Recovery metrics

**Files:** Create `packages/analytics/src/recovery.ts`; Test; export.

**Produces (from daily health rows `{date, restingHeartRate?, hrv?}`):**
- `computeRestingHr(rows): MetricResult<{ latest:number; baseline:number; deltaBpm:number }>` — baseline = 30-day median; need ≥7 rows. Band: delta ≥+5 → watch.
- `computeHrvTrend(rows): MetricResult<{ latest:number; baseline:number; pctVsBaseline:number }>` — need ≥7. Band: sustained ≥10% drop → watch.
- `computeHardDayStacking(hardDates:string[], today:string): MetricResult<{ consecutive:number }>` — consecutive days up to today with a quality/race effort; band ≥2 → watch. (No sample threshold; 0 is a valid answer.)

- [ ] Tests: baseline median + delta; hrv drop; stacking counts 3 consecutive.
- [ ] Implement; test; commit.

---

### Task 5: Aerobic interpretation + easy-run discipline

**Files:** Modify `packages/analytics/src/aerobicEfficiency.ts` / `hrDrift.ts` only if needed (values already computed); Create `packages/analytics/src/easyDiscipline.ts` (Z1–Z2 share of easy runs, needs zones + per-run avgHR); Test; export.

**Produces:** `computeEasyDiscipline(easyRuns:{avgHr:number}[], hrMax:number): MetricResult<{ inEasyPct:number }>` — % of easy runs whose avgHR ≤ Z2 top (0.80*hrMax); need ≥5 easy runs with HR. Band ≥80% healthy.

- [ ] Test: 4 of 5 easy → 80%.
- [ ] Implement; test; commit.

---

### Task 6: Performance metrics

**Files:** Create `packages/analytics/src/performance.ts`; Test; export.

**Produces:**
- `predictRaces(bestRun:{distanceMeters:number; durationSeconds:number}): MetricResult<{ k5:number; k10:number; half:number }>` — Riegel `t2 = t1*(d2/d1)^1.06` from the fastest recent run ≥3 km; need ≥1 qualifying run.
- `negativeSplit(runsWithLaps:{firstHalfPace:number; secondHalfPace:number}[]): MetricResult<{ negativePct:number }>` — % of runs finishing faster; need ≥4.
- `bestEfforts(laps per run): MetricResult<{ fastest1kSec:number; fastest5kSec:number }>` — rolling best from laps; need ≥3 runs with laps.

- [ ] Tests: Riegel 5k→10k scaling; negative-split fraction; best-effort min.
- [ ] Implement; test; commit.

---

### Task 7: Route aggregation

**Files:** Modify `apps/worker/src/routes/misc.ts` (`insightRoutes` GET `/`): build the daily-load series, weekly seconds, category seconds, hard dates, best run, easy runs from the already-loaded activities/laps/health/matches; call the new metrics; wrap each with `interpret(...)`; return `{ interpreted: InterpretedMetric[] }` alongside existing chart data.

- [ ] Add the aggregation; typecheck worker.
- [ ] Extend the vertical-loop or an insights route test minimally if practical; commit.

---

### Task 8: Insights UI

**Files:** Modify `packages/ui/src/screens/insights.tsx` (+ `packages/api-client` type `InterpretedMetric`, + a small `MetricCard` in `packages/ui/src/components.tsx`). Group cards by theme; render value, a band chip, range, meaning, gentle suggestion, and the sample note; suppressed metrics show the "need N more" note.

- [ ] Add `MetricCard`; wire the four theme groups; typecheck ui/web.
- [ ] Commit.

---

### Task 9: Ship
- [ ] Typecheck all; `pnpm test` green under Node 21; push (auto-deploys); verify `/api/insights` 200 + live.

## Self-review
- Spec coverage: aerobic (T5 + existing), recovery (T4), load (T3), performance (T6) — all four themes ✓. Interpretive framing (T1), zones (T2), route (T7), UI (T8) ✓. Deferred menu (grade-adjusted pace, sleep, monotony, adherence) intentionally out.
- No placeholders: formulas given (ACWR, Riegel, zones, medians); test cases named per task.
- Type consistency: `InterpretedMetric` defined in T1, consumed in T7/T8; `MetricResult` reused.
