# Analytics

Every metric in `packages/analytics/src/` is a pure, deterministic function
with an explicit rule and an honest sample-size gate. The shared result shape
(`metric.ts`) is either `{status: "ok", value, sampleSize, comparisonNote}` or
`{status: "insufficient_data", needed, have, explanation}` — suppressed
metrics say exactly what would be needed, and nothing is ever extrapolated.

## Modules

### Consistency (`consistency.ts`)

- **Inputs**: planned workouts in a date range (rest days excluded).
- **Rule**: counts planned/completed/moved/skipped/missed/unresolved.
  `adherenceRate = completed / (planned − still-future)`. A workout whose
  `effectiveDate ≠ originalPlanDate` *and* was completed counts as both
  `moved` and `completed` — **moving is never a failure**. Weekly breakdown
  per ISO week (Monday start), empty weeks included.
- **Suppression**: none — even one workout yields honest counts.

### Weekly training totals (`weeklyTraining.ts`)

- **Inputs**: normalized activities + the completion-match category map.
- **Rule**: ISO-week buckets of duration/distance/training-load/run count,
  split easy vs quality seconds. Unmatched activities count as **easy** —
  intensity is never guessed from raw data. Gap weeks are zeroed so trends
  don't lie.
- **Suppression**: 4-week average needs ≥ 4 weeks; 12-week average ≥ 12 weeks.

### Aerobic efficiency (`aerobicEfficiency.ts`)

- **Inputs**: easy/recovery runs with laps.
- **Rule**: meters per heart beat = `(speed m/s) / avgHR × 60` on easy or
  recovery runs of **25+ minutes** with average HR; runs paused > **15%**
  (elapsed vs moving) excluded; when ≥ 3 laps exist, only the **middle laps**
  are used (first + last dropped, HR time-weighted). Trend = least-squares fit
  across the window, reported as % change.
- **Suppression**: ≥ **3** qualifying runs.

### HR drift (`hrDrift.ts`)

- **Inputs**: steady runs (easy, long, recovery — intervals never) with laps.
- **Rule**: second-half vs first-half time-weighted average HR (laps split by
  cumulative-time midpoint), per run and median across runs. Excluded with an
  explicit recorded reason: shorter than **30 min**, fewer than **4** HR laps,
  or any lap pace deviating > **25%** from the run's median pace (surging).
- **Suppression**: ≥ **3** qualifying runs.

### Time of day (`timeOfDay.ts`)

- **Inputs**: resolved planned workouts (rest and still-future excluded)
  paired with their activities.
- **Rule**: morning = scheduled before 12:00. Completion rate per window, plus
  the median |actual − scheduled| start delta in minutes for completed runs
  with a local start time. **Purely descriptive** — never claims one time of
  day is physiologically better.
- **Suppression**: ≥ **6** resolved planned workouts.

### Execution (`execution.ts`)

- **Inputs**: one structured workout (stages with repeats) + its laps.
- **Rule**: planned work-interval count = work stages × ancestor repeat
  multipliers; the **N fastest-pace laps** stand in for the N planned work
  bouts. Reports interval consistency (CV% of work-lap paces), target
  adherence inside `[targetLow −3%, targetHigh +3%]`, and `controlled` (last
  work lap ≤ median + 5%). **Faster than prescribed is counted as NOT
  adherent** — exceeding targets is never rewarded. Partial reads are flagged.
- **Suppression**: needs ≥ 1 work stage, ≥ 1 lap, and ≥ 1 paced lap (each
  failure states which).

### Invisible records (`records.ts`)

Records lacking data are simply omitted — no fake records. Each carries its
one-sentence deterministic rule:

| Record | Rule | Minimum sample |
|---|---|---|
| Best aerobic efficiency | Highest m/beat on any eligible easy/recovery run | 5 efficiency runs |
| Lowest HR at your usual easy pace | Lowest avg HR among easy runs paced within 3% of your median easy pace | 5 comparable runs |
| Most even interval set | Lowest work-lap pace CV across executed interval workouts (2+ bouts) | 3 interval workouts |
| Most consistent four weeks | Max over all 4-consecutive-week windows of the *minimum* weekly adherence | 8 adherence weeks |
| Fastest comeback | Fewest days from the first run after a 7+ day break to three runs each within 3 days of the previous | one qualifying break |

### Evidence cards (`evidence.ts`)

At most **one** factual, dismissible card on Today, chosen by information
value: comeback record → morning completion rate (needs ≥ 10 scheduled
morning runs at ≥ 70%) → easy-run consistency (≥ 10 planned easy runs at
≥ 70%). Returns `null` when nothing qualifies — **no platitudes, no filler**.
Card ids are stable hashes so dismissals persist.

### Weekly facts (`weeklyFacts.ts`)

The deterministic input to the weekly review: planned/completed/moved/skipped
counts, total duration + distance, quality sessions, long-run-completed flag,
adherence % (resolved denominator), at most one record achieved this week, and
a garden summary sentence computed from event counts. Every string is a pure
function of inputs.

## The LLM boundary

`apps/worker/src/services/llm.ts` is **the only place the app talks to an
LLM**, and it only *phrases* the deterministic weekly facts:

- Input is the `WeeklyFacts` JSON — never raw streams, never invented context.
  The system prompt forbids inventing metrics, diagnoses, causal explanations,
  plan changes, or injury advice; output is schema-constrained JSON, capped at
  200 words (defensively truncated at 220).
- **Strava-sourced fields are excluded from LLM input**: the weekly cron
  strips `title`, `summaryPolyline`, and `stravaActivityId` before computing
  facts (`apps/worker/src/index.ts`), per the Strava API agreement caution in
  [research/strava-api.md](research/strava-api.md).
- Results are cached by facts fingerprint; cost is recorded per call in
  `llm_usage`; the rolling-7-day budget (warn $2 / cutoff $8 / max $10)
  disables calls automatically. With AI off, over budget, or errored, the
  facts are stored and shown without a narrative — the app loses nothing
  functional. See [COSTS.md](COSTS.md).
