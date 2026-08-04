# Analytics

Every metric in `packages/analytics/src/` is a pure, deterministic function
with an explicit rule and an honest sample-size gate. The shared result shape
(`metric.ts`) is either `{status: "ok", value, sampleSize, comparisonNote}` or
`{status: "insufficient_data", needed, have, explanation}` — suppressed
metrics say exactly what would be needed, and nothing is ever extrapolated.
The worker route (`apps/worker/src/routes/misc.ts`) wraps each `ok`/
`insufficient_data` result in `interpret()` (`interpret.ts`) to attach a
plain-language meaning, a band, and (where one exists) a gauge or strip — the
computation and the phrasing are different files on purpose.

## Modules

### Training load (`load.ts`) — `loadRatio`, `ramp`, `monotony`

All three gate on daily history since the earliest positive-load (or
positive-seconds) entry, so nothing is reported until there's enough real
training behind it to make the comparison honest.

- **`loadRatio`** — EWMA(7) acute load over EWMA(28) chronic load (Williams et
  al.), not a rolling-window average — this avoids the "phantom spike/drop" a
  simple ACWR produces when a big day rolls out of the window. Needs ≥28 days
  of history *and* some positive load in the trailing 28 days; a metric with
  months of history but nothing recent reports `have: 0` ("needs runs in the
  last four weeks to form a baseline"), not the longer history count. Bands:
  healthy 0.8–1.3, watch ≥1.3, high >1.5, low <0.8.
- **`ramp`** — trailing 7-day running time vs. the prior 21-day weekly
  average. Needs ≥28 days of history *and* a positive prior-21-day norm (a
  runner coming back from a break has no recent baseline to ramp from, so
  `have: 0` with "build back gradually" rather than a divide-by-zero). Bands:
  healthy under ~15%, watch 15–30%, high >30%.
- **`monotony`** — mean ÷ population standard deviation of the trailing 7
  daily loads (Foster's monotony): a high ratio means every day looked alike,
  with no easy days built in. `strain` is weekly load × monotony. Needs ≥14
  days of history *and* ≥4 active days in the trailing week; a perfectly flat
  week (stddev 0) reports the sentinel `5`, not a divide-by-zero. Bands:
  healthy <1.5, watch 1.5–2, high >2.

`loadRatio` and `monotony` share one training-load basis for the whole
window — COROS load when it covers ≥90% of the window's minutes, else a
minutes-of-activity fallback — and disclose which in their sample note.
`ramp` runs on run-only seconds instead, since it's specifically about
running time, so it carries no load-basis note.

### Recovery (`recovery.ts`) — `restingHr`, `hrv`, `hardStack`

Both `restingHr` and `hrv` are staleness-aware: a "current" number built from
a week-old-or-older reading isn't current. When staleness is the actual
failure, `have` is reported as `0` rather than the larger, gate-passing total
reading count — "Need 7; have 12" would read as self-contradictory.

- **`restingHr`** — median of your 3 most recent readings vs. the median of
  readings within the trailing 30 days (the two pools may overlap). Needs ≥7
  valid readings in the trailing 60 days *and* a newest reading ≤7 days old.
  Both halves are then separately recency-gated, because "enough readings
  somewhere in the window" is not the same claim as "enough readings recent
  enough to describe now": the 3 that make `current` must come from the last
  **5 days** and there must be **≥2** of them (filtered before the slice, so
  one fresh reading beside a seven-week-old cluster can't reach back across
  the gap), and the 30-day baseline pool needs **≥7** of its own. Both
  suppressions name the gap. Watch band: ≥5 bpm above baseline.
- **`hrv`** — median of your 7 most recent readings (all within 14 days of
  today) vs. an *uncontaminated* baseline built from readings ranked 8th–37th
  most recent — a disjoint, fixed 30-reading window, deliberately capped so a
  daily-syncing user's baseline doesn't silently drift into an all-time
  average. Needs ≥17 valid readings total, a newest reading ≤7 days old, and
  the 7 recent readings spanning ≤14 days. The "smallest worthwhile change"
  threshold is `clamp(0.5 × baseline CV%, 5, 15)` — derived from your own
  variability, not a number from a magazine — falling back to 10% when the
  baseline shows no measurable variability at all.
- **`hardStack`** — consecutive hard days, counted as
  `max(streak ending today, streak ending yesterday)`, so a hard streak that
  ended yesterday still reads as live context if today hasn't happened yet
  (or was a rest day). Never suppressed — 0 is a valid, informative answer.
  A day counts as hard when it carried a matched quality/race session, ran
  100+ minutes, or (only when there's no plan match to trust) averaged HR
  above the easy ceiling. **Runs only** — the route feeds it `runRows`, so a
  hard lifting or cycling day is not in the streak. Because one of its three
  tests is the easy ceiling, it carries the same ceiling caveat
  `easyDiscipline` and `lowIntensityShare` do. Watch band: ≥2 consecutive;
  rendered as a 7-day strip on the dashboard, not a gauge.

The route (`misc.ts`) layers one more staleness rule on top of `restingHr`
and `hrv`'s own 7-day suppression gate: past 2 days old, the card still shows
its value but drops the band/gauge/suggestion and adds a `staleNote` instead
— "still shown, but it makes no claim about today" (see Honesty conventions).

### Intensity distribution (`lowIntensityShare.ts`)

Share of heart-rate-tracked running time spent at low intensity (zones 1–2)
vs. high (zones 3–5) — a *time-in-zone* view, complementing `easyDiscipline`'s
per-run view. Lap HR is preferred when available (a hard surge inside an
otherwise-easy run still counts as hard); a run with no usable laps falls
back to its average HR for the whole duration. Time with no heart rate at all
is disclosed separately (`noHrSeconds`) and excluded from the ratio, never
guessed. Needs ≥4 runs contributing usable HR *and* ≥4 hours of
heart-rate-tracked running. The dashboard's headline is deliberately the
trailing 4 weeks, not the full 12-week window — a disciplined block two
months ago shouldn't hide a month of running everything too hard; the
worker computes the metric twice, once for the 4-week headline and once over
the full window purely to feed the weekly stacked-bar zone split. Bands:
healthy ≥75%, watch 65–74%, high (too intense) <65%.

### Easy-run discipline (`easyDiscipline.ts`)

How often your easy/recovery runs actually stayed easy: the share whose
*whole-run average* heart rate sat at or under the easy ceiling — the same
`isEasyHr` predicate `lowIntensityShare` uses, but scored per-run rather than
lap-by-lap, so the two cards can legitimately disagree (a brief spike can
pass on average while failing the zone-time view). Needs ≥5 easy/recovery
runs with heart rate. Watch band: <80%. Rendered as a per-run strip.

### Pacing (`performance.ts`)

Median (second-half pace − first-half pace) in seconds/km across steady runs
only — interval and race sessions are excluded, since their halves differ by
design and would say nothing about pacing. Positive means you faded, negative
means you finished faster. Needs ≥4 runs with usable split-lap data. No band
or gauge: framed as descriptive, never a target ("a fade on a hilly or hot
run says more about the day than about you").

### Aerobic efficiency (`aerobicEfficiency.ts`)

Meters per heartbeat — `(speed m/s) / avgHR × 60` — on easy/recovery runs of
25+ minutes with average HR; runs paused more than 15% (elapsed vs. moving)
are excluded. Every run is scored on the same lap-trimmed basis: laps ending
at or before 600 cumulative seconds are dropped as warm-up, and the *final*
lap is always dropped too, so cool-down never leaks in — a run without at
least 2 usable laps (one of them carrying HR) simply doesn't count, with no
whole-run fallback. Needs ≥3 qualifying runs. A trend (Theil–Sen slope over
day-index, reported as % change) appears only once there are ≥6 qualifying
runs *and* the largest gap between two consecutive ones is ≤21 days — a
trend is never claimed across a break in training.

### Pace-adjusted decoupling (`decoupling.ts`)

"Pa:HR": the change in speed-to-heart-rate ratio from the first half of a
steady run to the second. Unlike a raw HR-drift figure, a deliberate pace
change that raises HR proportionally reads as flat here, not as fatigue.
Steady categories only (easy/long/recovery — never intervals); runs need 40+
minutes and ≥4 usable laps after the same 600-second warm-up trim as
`aerobicEfficiency` — but, unlike efficiency, the *final* lap is kept, since
decoupling needs the whole second half to compare against the first. Runs
whose lap paces vary more than 25% from the run's own median (surging) are
excluded, with an explicit reason recorded and disclosed (capped at 5).
Needs ≥3 qualifying runs; reports the median % across them plus the excluded
count/reasons (the Insights chart discloses that count beside its `n=`). The
dashboard shades **0–5%** on the decoupling chart — the range conventionally
read as "held together" — with a zero line, so a reader can see whether a
run stayed inside it without being told a verdict.

### Consistency (`consistency.ts`)

Never suppressed — even one workout yields honest counts. A workout whose
`effectiveDate ≠ originalPlanDate` *and* was completed counts as *both*
`moved` and `completed` — moving is never a failure. `adherenceRate =
completed / (planned − stillAhead − unresolved)`; 0 when nothing has resolved
yet. The day-status grid (`days`) runs one status per date from `range.start`
through the *Sunday that closes the ISO week containing `range.end`* — not
just `range.end` itself — so the heatmap always draws whole week columns,
with the rest of the current week rendering as `future` rather than blank
space that could be misread as "no data." When multiple workouts land on one
date, the highest-precedence status wins: `missed` > `skipped` > `pending` >
`moved` > `completed` > `future` > `rest`. `pending` is the grid's read on
two different underlying states that are required to agree in count with the
outcome bar drawn above it: an explicitly `unresolved` workout, or a
`scheduled` workout whose date has already passed (sync hasn't caught up
yet) — a workout reading `pending` in the grid but `future` in the bar would
be a contradiction the reader has to resolve, so `unresolved`/`pending` are
kept as literal aliases of the same count.

### Weekly training totals (`weeklyTraining.ts`)

ISO-week (Monday-start) buckets of duration/distance/training-load/run
count, continuous from the first activity's week through the week containing
`opts.today` (gap weeks are zeroed rather than omitted, so a chart never lies
by silently skipping a blank week — and that includes a *trailing* run of
them: stopping at the last week trained made a month off read as "up to
date" and let the 4-week average describe the last four weeks *trained*). The easy/quality split relies on the completion-match category
map — an unmatched activity counts as easy, since intensity is never guessed
from raw data. The low/high intensity split feeding the weekly stacked bars
is separate: it prefers real per-activity zone time when supplied, falling
back to the quality/race-category heuristic only when zone time is unknown
for that activity. The ISO week containing "today" is flagged `partial` and
excluded from both rolling averages — `fourWeekAvgDuration` needs ≥4
*complete* weeks, `twelveWeekAvgDuration` needs ≥12 — a week that hasn't
finished happening yet shouldn't drag its own average down.

### Invisible records (`records.ts`)

Records lacking data are simply omitted — no fake records. Each carries its
one-sentence deterministic rule:

| Record | Rule | Minimum sample |
|---|---|---|
| Best aerobic efficiency | Highest m/beat on any eligible easy/recovery run | 5 efficiency runs |
| Most consistent four weeks | Max over all 4-consecutive-week windows of the *minimum* weekly adherence | 8 adherence weeks |
| Fastest comeback | Fewest days from the first run after a 7+ day break to three runs each within 3 days of the previous | one qualifying break |

Records never regress: `mergeRecords` merges each freshly computed record
into the persisted set by id, keeping whichever has the higher `numeric`
value (ties favor the stored one), so an achievement doesn't stop having
happened once the run that earned it rolls out of the 12-week display
window. A stored record with no fresh counterpart this run survives
unchanged.

### Evidence cards (`evidence.ts`)

At most **one** factual, dismissible card on Today, chosen by information
value: comeback record → morning completion rate (needs ≥3 scheduled samples
in *both* windows — below that the comparison is too thin to stand behind —
plus ≥10 scheduled morning ones at a ≥70% morning rate) → easy-run consistency
(≥10 planned easy runs at ≥70%). `dismissedIds` is applied *inside* the
fallback chain, not to its result — dismissing the top card reveals the
next one instead of collapsing the whole rotation to `null`. Returns `null`
when nothing qualifies — no platitudes, no filler. Card ids are stable
hashes of the card kind + headline value, so a dismissal survives the next
day's numbers moving slightly. The morning card is the only remaining
consumer of `timeOfDay.ts` (median morning/evening completion rate + median
start-time delta) — time of day has no card of its own on the dashboard.

### Weekly facts (`weeklyFacts.ts`)

The deterministic input to the weekly review: planned/completed/moved/skipped
counts, total duration + distance, quality sessions, long-run-completed flag,
adherence % (resolved denominator), at most one record achieved this week, and
a garden summary sentence computed from event counts. Every string is a pure
function of inputs.

## Honesty conventions

A handful of rules recur across modules and are worth calling out once:

- **Insufficient always means `have < needed`.** Even when a metric has
  months of history, a suppression caused by *staleness* or a *missing recent
  baseline* reports `have: 0` rather than the larger, gate-passing total —
  "Need 7; have 12" would read as self-contradictory. (Enforcing this caught
  a real bug in `ramp`'s break-return branch during the rebuild.)
- **Staleness date-stamps a card instead of hiding it.** `restingHr` and
  `hrv` keep showing their last value once a reading crosses the route's
  2-day staleness cutoff, but drop the band/gauge/suggestion and add a
  `staleNote` ("last reading N days ago") — still shown, but no longer
  making a claim about today.
- **Moving a workout is never a failure.** `consistency.ts`, `records.ts`,
  and `weeklyFacts.ts` all treat a completed-but-moved workout as a subset of
  `completed`, never as a separate negative outcome.
- **Partial weeks are excluded from averages, not zeroed into them.**
  `weeklyTraining.ts` flags the in-progress ISO week `partial` and skips it
  when computing the 4-week and 12-week rolling averages, so an unfinished
  week can't drag its own average down before it's actually over. Weeks that
  are *over* and empty are a different matter: those count as the zeroes they
  are, so a layoff shows up in the average instead of being skipped.
- **The easy-ceiling HR max is a 26-week, robustness-checked estimate that
  discloses its own confidence.** `hrZones.ts` takes the *second*-highest
  qualifying max-HR reading over the trailing 26 weeks — so one spike, one
  device glitch, one sprint for the bus can't set the ceiling on its own —
  from readings above 120 bpm. The exception is having exactly **one**
  qualifying reading, where there is no second to fall back to and that
  reading is used as-is; the caveat below is what keeps that honest. With
  none, the estimate is `null`. `misc.ts` counts how many
  readings actually backed that estimate and appends a caveat to every card
  that uses the ceiling when fewer than 10 did, or a stronger one ("default
  max heart rate of 190") when there were none at all.

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
