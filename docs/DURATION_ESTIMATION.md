# Duration estimation

How long will this workout actually take, and how big should its calendar
block be? Implementation: `packages/scheduling/src/estimate.ts` (priority
chain) and `stages.ts` (stage derivation). Estimator version: `1.0.0`.

## The priority chain

`estimateDuration` never replaces a valid COROS estimate with its own math:

| Priority | Source | `source` value | Confidence |
|---|---|---|---|
| 1 | **COROS native estimate** — `programs[].duration` (seconds) from the planned workout | `coros_native` | high |
| 2 | **COROS calculation endpoint** — `POST /training/program/calculate` → `planDuration ?? duration` | `coros_calculated` | high |
| 3 | **Stage derivation** — sum the flattened stage tree (below) | `derived_from_stages` | high if no assumptions were needed, else medium |
| 4 | **Historical median** — median duration of comparable completed workouts (same category) | `historical_fallback` | medium |
| 5 | **Conservative default** by category | `default_fallback` | low |

Category defaults (priority 5): recovery 35 min · easy 50 · long 100 ·
quality 60 · race 60 · cross-training 45 · strength 40 · unknown 50 · rest 0.

### Stage derivation (priority 3)

`deriveWorkoutSeconds` flattens nested repeats (children reference their
repeat container via `parentStageId`; nesting deeper than 6 throws), then per
leaf stage:

- `time` stages: use `durationSeconds` as-is.
- `distance` stages: `meters / 1000 × pace`, where pace resolves in order —
  explicit pace-target band midpoint → COROS pace-zone midpoint → the user's
  historical median pace for the category → the conservative configured
  default (390 s/km at the import call site). Every non-explicit resolution
  appends a plain-language assumption.
- `open` / `lap_button` stages: assumed defaults by kind — warm-up 10 min,
  cool-down 10 min, work 10 min, recovery 2 min, rest 1 min, open 10 min —
  each recorded as an assumption.

## The persisted `DurationEstimate`

Stored as JSON on `planned_workouts.duration_estimate`
(`packages/domain/src/workout.ts: durationEstimateSchema`):

```ts
{
  workoutSeconds: number;      // the workout itself
  calendarSeconds: number;     // workoutSeconds + both buffers
  source: "coros_native" | "coros_calculated" | "derived_from_stages"
        | "historical_fallback" | "default_fallback";
  confidence: "high" | "medium" | "low";
  assumptions: string[];       // every guess, in plain language
  estimatorVersion: string;    // "1.0.0"
}
```

Alongside it the row keeps `source_estimated_duration_seconds` (COROS native,
verbatim), `fallback_estimated_duration_seconds` (set only when the estimate
was *not* COROS-native), and `calendar_block_duration_seconds`. A COROS
content change re-runs the whole chain (reconciliation rule 7).

## The calendar block formula

```
calendarSeconds = workoutSeconds + (bufferBeforeMinutes + bufferAfterMinutes) × 60
```

Buffer defaults (`packages/domain/src/preferences.ts`): **10 min before**
(get ready, get out the door) and **15 min after** (cool down, shower).
`computeBlock` (`packages/scheduling/src/windows.ts`) places the block
DST-safely via Luxon: the event starts `bufferBefore` before the workout's
`effectiveTime` and ends `bufferAfter` after the workout ends. The event
therefore represents *the time actually spent*, not just the run.

## Worked example

A threshold session with a COROS native estimate of **54 minutes**, default
buffers:

| Quantity | Value |
|---|---|
| `workoutSeconds` | 3240 (54 min, `source: "coros_native"`, high confidence, no assumptions) |
| Buffers | 10 min before + 15 min after = 25 min |
| `calendarSeconds` | 3240 + 1500 = 4740 → **79 min block** |
| Scheduled at 07:00 | Calendar event 06:50 – 08:09; the run itself 07:00 – 07:54 |

If the same workout had no native estimate but stages "15 min easy · 5 × 5 min
threshold / 2 min jog · 10 min cool-down", stage derivation yields 15 + 5×(5+2)
+ 10 = 60 min (high confidence — all stages time-based, no assumptions), and
the block becomes 85 min.
