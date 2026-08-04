# Insights Dashboard — Design

Date: 2026-08-03
Status: approved (full restructure, best-practice metric math, phone + desktop parity)
Origin: six-subagent audit of insights/metrics (report: session scratchpad `insights-audit-2026-08-03.md`; findings summarized in the plan)

## Goal

Rebuild Run Garden's Insights into a trustworthy, glanceable personal fitness dashboard. Two phases:

- **Phase A — Truth layer.** Fix the data pipeline and metric math; adopt best-practice definitions; extend the API payload with everything the new UI needs.
- **Phase B — Dashboard.** Restructure the screen: status strip, unified signals grid with inline gauges/sparklines, consistency heatmap, small-multiple aerobic charts, shared touch-capable chart infrastructure.

Phase B never renders a number Phase A hasn't made honest.

## Non-goals

- No prod deploy (manual, out of scope; D1 write restrictions apply).
- No user-configurable HRmax settings UI (robust estimate now; pref override later).
- No readiness composite (sleep data isn't collected; revisit after bridge work).
- No Today-screen endpoint split (acceptable after lap-query scoping; noted as future).
- No stages/executions wiring (the dead interval record is deleted instead).

## Phase A — Truth layer

### A1. Pipeline correctness (apps/worker/src/routes/misc.ts insights route)

- `activityLaps` fetched via `inArray(activityId, windowActivityIds)` (chunked); never a full scan.
- `workoutCompletionMatches` scoped to the user via the user's workout ids.
- All independent queries issued with `Promise.all`.
- `timeOfDayPairs` assembly uses prebuilt Maps (no `find` in loops).
- `dismissedIds` passed into `pickEvidenceCard` so dismissal falls through to the next card.
- Category resolution: matched → planned workout's category; matched-but-unresolvable or unmatched → `"unknown"`. Nothing ever defaults to `"easy"`.
- Sport scoping: run-only for ramp, low-intensity share, efficiency, decoupling, easy discipline, pacing, weekly `runCount`, records inputs. All-sport for load-based signals (load vs norm, monotony/strain) — deliberate whole-body choice, disclosed in each card's note.
- Window: activities fetched by UTC instant but bucketed by local date; fetch padded ±1 day and filtered to local-date window to remove edge wobble.

### A2. Signal definitions (packages/analytics)

Nine signals, three groups. Every signal keeps the existing `Metric`/insufficient-data honesty contract and gains `gauge` (numeric band edges) where banded.

**Load** (basis rule: COROS `trainingLoad` when ≥90% of window activities (by duration) carry it, else uniform duration-minutes; basis disclosed; never mixed):

1. `loadRatio` (replaces `acwr`): EWMA(7) / EWMA(28), λ = 2/(N+1) per Williams et al., over zero-filled daily load. Gate: ≥28 days since first activity. Headline "+12% vs your norm". Bands: low <0.8, healthy 0.8–1.3, watch 1.3–1.5, high >1.5. Payload includes the trailing 8-week weekly series of the ratio for the band chart.
2. `ramp`: trailing 7 days of running time vs (prior 21 days ÷ 3). Zero-filled, no partial-week artifacts. Headline "+45 min (+12%) vs your norm". Bands: healthy ≤15%, watch 15–30%, high >30%. Insufficient below 28 days.
3. `monotony` (new): mean ÷ population stdev of the last 7 zero-filled daily loads; strain = weekly load × monotony (in `detail`). Bands: healthy <1.5, watch 1.5–2.0, high >2.0. Insufficient if <4 active days in the window basis or <14 days history.

**Recovery** (route fetches 60 days of `daily_health`; payload ships the daily series):

4. `restingHr`: current = median of the last 3 readings whose dates are within 5 days; baseline = median of readings in the last 30 days (min 7). Headline "+4 bpm vs your usual 48". Watch: delta ≥ +5 sustained (current-side median, not single night). Staleness: newest reading >48h old → value date-stamped, no band; >7 days → insufficient.
5. `hrv`: recent = median of last 7 readings (within 14 days); baseline = median of readings 8–37 (uncontaminated). Threshold = smallest worthwhile change (0.5 × CV of baseline), fallback −10% when CV incomputable. Headline shows the % vs baseline. Same staleness rules.
6. `hardStack`: streak = max(consecutive hard days ending today, ending yesterday). Hard day = matched quality/race, OR unmatched run with avg HR > easy ceiling, OR any run ≥100 min. Payload includes the trailing 7-day hard/easy boolean strip.

**Execution** (runs only):

7. `lowIntensityShare` (replaces `balance`): duration-weighted share of run time at/below the easy ceiling over the last 4 weeks, computed from lap avg HR (fallback: whole-run avg HR when a run has no HR laps; runs with no HR excluded and counted). Target tick at 80%. Bands: healthy ≥75%, watch 65–75%, high (i.e. too intense) <65%. Payload: low/high seconds + per-week split for the stacked bar.
8. `easyDiscipline`: unchanged concept; ceiling = `easyCeiling(robust HRmax)`. Robust HRmax = 2nd-highest per-run `maxHeartRate` over trailing 26 weeks of runs (min 10 runs, else insufficient-quality note; fallback 190 only when no HR at all). One shared predicate (`avgHr <= ceiling` = easy) used by both the metric and the drill-down. Tile shows chronological green/red tick strip of the window's easy runs.
9. `pacing` (replaces `splits`): steady categories only (easy/long/recovery, matched). Headline = median second-half minus first-half pace differential in s/km ("typically +4 s/km late"); negative-split share is secondary. Drill-down: per-run diverging s/km bars.

**Aerobic response charts** (not banded tiles; full-width cards):

- `efficiency`: m/beat, lap-basis only — first 10 minutes (by cumulative lap time) and final lap excluded; runs without usable laps excluded and counted in the note. Trend = Theil–Sen slope over days, reported as % over the window, shown only at ≥6 runs. Chart: muted dots + 5-run rolling median line.
- `decoupling` (replaces `drift`): Pa:HR — (pace/HR of first half) vs (second half) after dropping the first 10 minutes; eligible: steady categories, ≥40 min, ≥4 laps with HR + pace. Bands: <5% fit, 5–10% watch, >10% high. Chart: dots + rolling median + shaded 0–5% zone + 0-line.

### A3. Consistency, reviews, records

- `unresolved` leaves the adherence denominator; shipped as a distinct `pending` count and heatmap state. Headline: adherence % of resolved.
- Payload adds `consistency.days`: per-day status array for 12 weeks (`completed | moved | skipped | missed | pending | rest | future | none`), local dates, for the heatmap. Current week flagged `inProgress`.
- `weeklyTraining`: `fourWeekAvgDuration` over the last 4 *complete* weeks; current week flagged partial in payload. Stacked split becomes low/high intensity from HR zones (same basis as `lowIntensityShare`), falling back to category when HR absent.
- Records: computed over full run history (all-time activities query, run-only, id/date/laps as needed). Set: best aerobic efficiency, most consistent 4 weeks, fastest comeback. Deleted: most even interval set (dead), lowest HR at comparable pace (redundant).
- Weekly review cron: counts all in-week run activities (not matched-only); schedule moves Mon 14:00 → Mon 20:00 UTC.
- Time-of-day standing card dies; its computation joins the evidence rotation with a per-window n ≥ 3 gate and surfaces `medianStartDeltaMinutes`.

### A4. Wellness ingestion (services/coros-bridge + apps/worker devices route)

- Bridge daily-health backfill window: 14 → 60 days (activities stay 14).
- `daily_health` upsert never overwrites a non-null stored value with null (per-column coalesce in the update set).

### A5. API payload (versioned additive)

`GET /api/insights` response changes:

- `interpreted[]` entries gain optional `gauge {min, max, healthyLo, healthyHi, value}`, `series [{date, value}]` (restingHr/hrv), `strip [{date, on}]` (hardStack, easyDiscipline ticks), `trend {pct, n}` (efficiency), `partial` flags.
- `consistency` gains `days[]`, `pending`, `inProgressWeekStart`.
- `weekly.weeks[]` gain `partial: boolean`, `lowSeconds/highSeconds`.
- `efficiency/decoupling.value.perRun[]` gain `activityId` (for drill-to-run).
- `drift`→`decoupling` rename; `excludedRuns` trimmed to `{count, reasons: first 5}`.
- Client updated in lockstep; `InsightsScreen` wrapped in an error boundary; blind casts replaced by one typed response interface in api-client.

### A6. Testing

- TDD (red → green) for every new/changed analytics function: EWMA load ratio, ramp, monotony, recovery windows + staleness, streak-ending-yesterday, time-in-zone share, robust HRmax, decoupling, Theil–Sen, pacing median, per-day consistency statuses, complete-week averaging.
- New worker-route assembly tests (fixtures + local D1 sim): sport scoping, unknown-category exclusion, lap query scoping, dismissed-evidence fallthrough, partial-week flags, staleness, records-over-full-history. This layer had zero coverage and held every HIGH finding.
- Tests run on Node 21; builds/wrangler on Node 22.

## Phase B — Dashboard

### B1. Screen structure (packages/ui/src/screens/insights.tsx)

```
STATUS STRIP    one line: top concern by severity (high > watch) or all-clear;
                includes adherence %; tap scrolls to the owning card
SIGNALS         one card, subgroups Load / Recovery / Execution; responsive tile
                grid (2-col ≥360px, 3-col ≥720px); tile = title, value, inline
                visual, silent-when-healthy pill, drill chevron
CONSISTENCY     adherence headline + stacked outcome bar (completed[+moved] /
                pending / skipped / missed) + 12wk × Mon–Sun heatmap with streak
                line; weekly bullet rows retired
TRAINING VOLUME upgraded stacked weekly bars (low/high intensity) + 4-complete-
                week avg reference line + hatched partial week
AEROBIC         efficiency | decoupling side-by-side ≥720px, stacked below;
                dots + rolling median; trend chip; 0–5% decoupling band
RECORDS         full-history, rule text kept
WEEKLY REVIEW   latest narrative + "earlier weeks" disclosure
```

### B2. Tile visuals

- Banded bullet gauge (loadRatio, ramp, monotony, restingHr, hrv, lowIntensityShare): 6px track, shaded healthy band from `gauge`, value marker.
- Sparkline (restingHr, hrv): last ~14 daily points from `series`, current point accented.
- Strips: hardStack 7-day boxes; easyDiscipline green/red ticks.
- Drill-down sheets: existing Sheet pattern; recovery drill-downs get the baseline-band daily chart (60d dots + 7-day rolling line + shaded baseline ± SWC band); pacing gets diverging bars; easyDiscipline keeps lap bars redrawn as diverging-from-ceiling.

### B3. Chart infrastructure (packages/ui/src/charts.tsx)

- Shared pointer-overlay tooltip: hover (desktop) + tap-to-pin (touch), nearest-mark hit testing, ≥24px targets, one implementation for all charts; SVG `<title>` retired.
- Helpers: nice ticks, date-scaled x, reference line, shaded band, hatch pattern.
- All colors via `--chart-*` / semantic tokens; LapHrBars re-tokenized (dark-mode + CVD-safe); fix `var(--muted, #667)` dead token.
- Honesty fixes: stack gap subtracted from segment height; adherence-fill clamped; square baseline corners; zero-or-disclosed axis baselines; diverging lap bars anchored at the ceiling.
- ChartFrame (figcaption + hidden summary + note) wraps every chart including drill-down charts.
- One shared short-date formatter; hours (1 decimal) for all weekly durations.
- Visible trend chip component (▲/▼ + %) used by efficiency (and decoupling median).

### B4. Design quality bar

Both themes styled; 360px and desktop first-class; `dataviz` and `frontend-design` skills loaded before chart/screen implementation; tabular-nums for values; "normal earns silence" retained everywhere.

## Error handling

- Route degrades per-metric to `insufficient_data` (existing contract) — never a 500 for missing data.
- Client: typed response parse + per-screen error boundary with retry; unknown metric ids ignored (forward compatibility).
- Bridge upsert failures logged, non-fatal, next 30-min cycle retries.

## Testing summary

Unit (analytics, Node 21) → route assembly (worker fixtures) → UI helper units (ticks/scales/hit-testing) → typecheck + build (Node 22) → screenshot pass via existing scripts for visual verification.

## Sequencing

Phase A lands as one PR-shaped commit series on branch `insights-dashboard` (pipeline → analytics → route/payload → bridge → tests green). Phase B follows on the same branch (chart infra → tiles/gauges → screen restructure → drill-downs → polish). Existing-behavior tests updated alongside renames (`acwr`→`loadRatio`, `drift`→`decoupling`, `balance`→`lowIntensityShare`, `splits`→`pacing`).
