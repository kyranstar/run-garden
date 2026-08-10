# Effort Analysis — Design

**Date:** 2026-08-06 · **Status:** approved (decisions locked via user Q&A)

An optional, strictly trigger-only coach analysis of any single workout effort.
The coach receives the full telemetry for that effort (heart rate, elevation,
temperature, pacing, splits vs. the planned workout) plus historical context,
and returns a short, encouraging, data-cited read with at most two improvements.

Locked decisions:

1. **Block on bridge extension** — temperature (and the rest of the newly
   discovered telemetry) ships from day one, which requires normalizer changes
   and a desktop release before the analysis endpoint is useful.
2. **Strength/yoga included, simplified** — no pace/splits framing; duration,
   HR, load, feel, exercise keys.
3. **Triggers on activity rows + workout detail sheet** — never automatic.

## 1. Probe-verified COROS telemetry (2026-08-06, PACE 4, two live runs + yoga)

The bridge already fetches `activity/detail` for every admitted activity, so
all of this rides along with zero extra API calls. Units verified by
cross-checking list values against detail values on the user's own account.

### detail.summary / list item (per activity)

| Wire field | Sample | Unit / decode | Ours |
| --- | --- | --- | --- |
| `avgCadence` / `maxCadence` | 152 / 184 | steps per minute (verified: `step` ÷ moving minutes) | `avgCadenceSpm`, `maxCadenceSpm` |
| `avgPower` / `maxPower` | 160 / 383 | watts (running power) | `avgPowerWatts`, `maxPowerWatts` |
| `avgStepLen` | 93 | centimetres (verified: distance ÷ steps) | `avgStrideLengthCm` |
| `aerobicEffect` / `anaerobicEffect` | 3.2 / 0.2 | 0–5 training-effect scale | `aerobicEffect`, `anaerobicEffect` |
| `currentVo2Max` | 53 | ml/kg/min estimate | `vo2maxEstimate` |
| `staminaLevel7d` | 98 | percent (often 0 = absent) | `staminaLevel7d` |
| `bestKm` | 342 | sec/km, fastest km of the effort | `bestKmSecPerKm` |
| `pauseTime` | 13594 | centiseconds (sums match `pauseList`) | `pauseSeconds` |
| `waterTemperature` (list) | 2800 | °C × 100 from the watch thermometer — populated on land activities (wrist-warmed, runs read ~2–3 °C above air) | `deviceTempC` |
| `avgSpeed` | 425.5 | sec/km for run family; **`avgPace` is 0 on current payloads** | pace fix below |

### detail.weather (outdoor activities only; provider 1 = AccuWeather)

| Wire field | Sample | Decode | Ours |
| --- | --- | --- | --- |
| `temperature` | 253 | °C × 10 → 25.3 °C | `weatherTempC` |
| `bodyFeelTemp` | 272 | °C × 10 RealFeel | `weatherFeelsLikeC` |
| `humidity` | 790 | % × 10 → 79% | `humidityPercent` |
| `windSpeed` | 81 | × 10, unit assumed km/h → 8.1 | `windKph` |
| `windDirection` | 1580 | degrees × 10 (not stored) | — |

### detail.sportFeelInfo

`feelType` 0 = unset, 1–5 with 5 = strongest (COROS post-workout emoji row) →
`feelRating`. `sportNote` freetext → `sportNote` ("" → absent).

### detail.zoneList

- `zoneType 3` (`type: 126`) — HR zones: 6 buckets of
  `{leftScope, rightScope, second}` (bpm bounds, seconds). Stored verbatim
  order as `hrZones: [{lo, hi, seconds}]`.
- `zoneType 0` (`type: 130`) — pace zones: 7 buckets, bounds in ms/km
  (left = slower). Stored as `paceZones: [{loSecPerKm, hiSecPerKm, seconds}]`.

### detail.pauseList

`{duration (centiseconds), start/end}` entries → derived `pauseCount` and
`longestPauseSeconds` (distinguishes one long gel stop from eight stoplights).

### lap items (per split)

| Wire field | Decode | Ours (activity_laps column) |
| --- | --- | --- |
| `avgCadence` | spm, 0 = absent | `avg_cadence_spm` |
| `minHr` / `maxHr` | bpm, 0 = absent | `min_heart_rate` / `max_heart_rate` |
| `elevGain` | metres (0 legit) | `elev_gain_meters` |
| `avgGrade` | percent (0 legit) | `avg_grade_percent` |
| `avgPower` | watts, 0 = absent | `avg_power_watts` |
| `exerciseNameKey` | catalog key, strength/yoga naming | `exercise_name_key` |

## 2. Storage

One nullable JSON column `activities.telemetry` holds the whole per-activity
extras object, typed by `activityTelemetrySchema` in `@rg/domain` (every field
optional; object omitted entirely when empty). Rationale: exactly one consumer
today (the effort-package builder, server-side), D1 can `json_extract` if a
future dashboard wants aggregation, and 17 flat columns would be migration
churn with no current reader. Laps get real columns because the splits table is
relational and read per-row.

Sentinel policy: wire `0` means "absent" for cadence/power/VO2max/feel/
device temp/bestKm and is dropped; it is legitimate for `elevGain`/`avgGrade`
/`pauseSeconds` and kept.

**Pace fix (bundled):** `summary.avgPace` is 0 on current payloads, and the
normalizer stored it as-is — run rows carry pace 0 today. New behavior: when
`avgPace` is falsy, derive moving pace as `durationSeconds / km` for
activities with ≥100 m distance.

**Re-ingest lever:** the activity content fingerprint gains a `v: 2` salt.
Every fingerprint changes once, so the next sync window (and a user-triggered
Backfill history for older rows) rewrites activities + laps with telemetry.
`ingestActivities` already treats a fingerprint mismatch as "refresh
everything, rewrite laps".

## 3. Effort package (`apps/worker/src/services/coach-effort.ts`)

`buildEffortPackage(db, userId, activityId)` → `{ text, approxTokens }`,
deterministic, unknowns explicit ("temperature unknown"), ≤8k tokens. Sections:

1. **THIS EFFORT** — sport, title, date/time, duration (moving + elapsed),
   distance, pace, HR avg/max, cadence, power, stride, elevation, load,
   training effects, VO2max, best km, pauses (count/total/longest).
2. **CONDITIONS** — weather temp + RealFeel + humidity + wind, device temp,
   self-reported feel, athlete note. Absent → "no weather data (indoor?)".
3. **SPLITS** — up to 30 laps: pace, HR (avg, min–max), cadence, grade, elev.
   `splitType = workout` laps join against the matched planned workout's
   stages (warmup/work/recovery labels + targets) so interval reps compare
   against their targets; `auto_km` laps render as km splits.
4. **PLAN CONTEXT** — matched planned workout (title, category, stage list,
   completion state) or "unplanned effort".
5. **ZONES** — HR zone table (bounds + minutes + %); pace zones for runs.
6. **HISTORY** — last 5 same-category efforts (date, distance, pace, avgHR,
   load, weather temp) as a compact table; all-time + 90-day best km; 30-day
   wellness baselines (RHR, HRV, sleep) with that morning's values.
7. **LOAD** — trailing 7d / 28d training-load sums and ratio.
8. **MEMORY** — active coach memory lines (injury notes, preferences).

Strength/yoga: sections 3/5 pace framing drops out automatically (no laps with
pace, no pace zones); exercise keys resolve via the stored exercise catalog
when available.

## 4. Prompt (separate from wake — read-only voice)

`ANALYSIS_SYSTEM_PROMPT`, key rules:

- You are reading one completed effort. You may not propose plan changes,
  write memory, or ask questions — this is a post-run debrief, not a wake.
- Shape: one-line verdict → 2–3 observations, each citing a number from the
  package → at most 2 next-time improvements → one earned, specific
  encouragement. ~140 words. No headers, no bullets-of-bullets.
- Honesty rules: never invent data; name unknowns plainly; no cardiac-drift
  claims unless temperature and duration support them; conditions
  (heat/humidity) may explain HR elevation and should be credited before
  fitness conclusions; never scold — a rough day gets context, not judgment.
- Garden voice: at most one light garden reference, only if natural.

## 5. Route + caching

`POST /api/coach/analyze/:activityId` body `{ force?: boolean }`:

1. Auth → activity must belong to user (404 otherwise).
2. Cache: newest `coachMessages` row with `refs.activityId = :id` and
   `refs.kind = "analysis"` → returned as `{ message, cached: true }` unless
   `force`.
3. Budget gate: same `LLM_BUDGET` $20/wk gate as wake; over budget → 429 with
   budget message (never a silent skip — this is user-triggered).
4. `buildEffortPackage` → strong-tier `chatCompletion` (never-truncate caps,
   300 s timeout, one transient retry) → persist as coach message
   `{ role: "coach", body, refs: { kind: "analysis", activityId } }` →
   `recordUsage` ledger kind `coach_analysis` → `{ message, cached: false }`.

The analysis is a normal coach message: it appears in the coach thread and
survives re-opens; re-analyze (`force`) supersedes nothing — it just appends a
fresh read (receipts show both; history of reads is harmless and honest).

## 6. UI

- **Activity rows (runs screen)** and the **workout detail sheet** get a
  "Coach's read" action. Un-analyzed: sparkle-ish quiet button. Pending:
  inline spinner ("reading the effort…"). Done: the analysis text renders
  inline in an expandable card right where the user asked, with a small
  "re-run" affordance (force). Errors render inline and are dismissable.
- The same message shows in the plan-page coach thread (it is one).
- Never automatic: no trigger rule fires analyses; cron never calls this.

## 7. Testing

- Normalizer: fixture from the probe payload shapes → telemetry object with
  exact unit conversions; sentinel dropping; pace derivation; lap columns;
  fingerprint v2 differs from v1.
- Ingest: telemetry lands in `activities.telemetry`, lap columns populate,
  fingerprint-match skip still holds.
- Effort package: golden tests (sections present, unknowns explicit on bare
  activity, deterministic, token cap, workout-lap/stage alignment).
- Route: cache hit, force re-run, budget 429, persist + ledger row —
  stubbed fetch, no live LLM.

## 8. Rollout

Migration 0012 (CI applies), worker deploy via dispatch, desktop 0.1.10
release (bridge sidecar carries the normalizer), then user runs Backfill
history once to enrich old activities. Sync window re-ingests the recent 14
days automatically via the fingerprint salt.
