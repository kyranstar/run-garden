# Coach-input audit — what the LLM actually receives, 2026-08-18

Question asked: does the coach get everything USEFUL from COROS (and only the
useful), is every number clearly labeled, and could the format teach the model
more? Method: read the ACTUAL payload builders (coach-effort.ts effort
package, coach-context.ts dossier, llm.ts weekly-review facts, studio-llm.ts
athlete context), then inventory the COROS wire (recorded payloads in
packages/providers/test + docs/research/coros-community-clients.md field
survey + raw-types.ts) against what normalize/ingest stores.

## Temperature, answered

- **Body temperature does not exist on the COROS wire.** No body/skin-temp
  field anywhere (summary survey, raw types, captures). Nothing to pass.
- **Ambient temperature IS passed and labeled**: `detail.weather` is an
  AccuWeather record COROS attaches to outdoor GPS activities (temp,
  RealFeel, humidity, wind). The effort package prints it as "weather
  25.5°C (feels 31.4°C) · humidity 59% · wind 2km/h".
- `waterTemperature` is a wire MISNOMER — it is the wrist thermometer.
  Passed as "watch thermometer 28°C (wrist-warmed, reads high)" — already
  correctly distinguished from ambient.
- **FIXED: the zero-gate.** `positive()` guarded temperature presence, so
  0 °C and every sub-zero reading dropped the ENTIRE weather block (humidity
  and wind died with it), and the coach was told "no weather data (indoor?)"
  about outdoor runs in the snow — this account has ten Whistler/Alberta
  winter activities. Now: a weather record is real when any field is
  non-zero; within a real record 0 °C is a value; the wrist thermometer
  keeps 0-as-absent (sentinel risk beats the 0.00 °C reading) but passes
  negatives. Freezing fixtures added to coros-normalize.test.
- **External weather fallback: not recommended now.** We store no
  coordinates (GPS lives only in the unfetched `frequencyList`), so there is
  nothing to geocode against; COROS already attaches weather to the
  activities that have it; the real losses were our own gate. Revisit if
  per-sample ingestion ever lands.

## Also fixed today

- "no weather data (indoor?)" → "no weather record on this activity
  (indoor, non-GPS, or COROS attached none — absence of a record, not
  evidence of conditions)". The old line invited the model to infer
  "indoor" from our own drop.
- `staminaLevel7d` was normalized and stored but never shown — it now rides
  the effort package's fitness line as "COROS stamina NN/100 (7d
  running-fitness gauge)".
- The dossier's LAST 14 DAYS session lines said "did 45min 8km" with no
  effort evidence, making two very different weeks read identically — they
  now carry `HR · load · felt n/5` (data that was already fetched).

## What is genuinely good (leave alone)

Explicit unknowns everywhere ("unknown", never blank); weak-evidence
markers in WELLNESS (frozen feeds, no-reading days, the empty-sleep-table
declaration); units spelled out on every number; the weekly review's
pre-converted units ("models are unreliable at arithmetic"); the
load-collapse call-out; HISTORY 90D's "treat as untrained" verdicts; zone
lines carry their own bpm/pace bounds inline.

## The dropped-data map (wire offers → we discard)

Per-activity summary: avgSpeed + **adjustedPace** (grade-adjusted pace,
typed, never read) · normalized power · **totalDescent/min/max/avg
elevation** (no profile at all) · running-dynamics family (ground time,
vibration, stiffness) · strength volume (sets/reps) · calories (normalized
then dropped at the DB boundary — no column) · `performance`/`tiredRate`.
Laps: the **second lap view** (structured-workout laps OR per-km autolaps —
one is discarded wholesale at normalize; the schema's splitType could hold
both) · per-lap prescribed targets (intensityType/Value) · adjustedPace ·
timestamps. Detail sections never touched: **frequencyList (the entire GPS
+ per-sample HR/pace/altitude stream)**, **graphList (incl. peak-N-second
efforts)**, climb segmentation. Daily health: **sleepHrvBase (COROS's own
HRV baseline — readiness.ts explicitly wants one and computes its own
instead)** · per-day trainingLoad/**trainingLoadRatio (ACWR)**/**ati/cti**
· per-day vo2max/lthr/ltsp/stamina series (we stamp four metrics on ONE day
behind a freshness gate) · dashboard rhr/fullRecoveryHours/sleepHrvData ·
**lthrZone/ltspZone (the athlete's actual zone definitions)**. Endpoints
never called: `/dashboard/detail/query` (the historical series for exactly
those one-day metrics) and `/activity/detail/download` (FIT export — every
stream, losslessly). Sleep is fixture-only (the web API can't read it
without killing the phone session) — the dossier declares this honestly.

## Brainstorm — ranked next steps

1. **`sleepHrvBase` (+sd) → store + feed readiness/dossier** (small;
   migration + ingest + one readiness plumb). COROS's own baseline beats
   our 14-day median and matches what the watch shows the athlete.
2. **`/dashboard/detail/query` ingestion** (medium): per-day ati/cti/
   trainingLoadRatio/stamina/lthr/ltsp history. Gives the coach COROS's own
   acute:chronic ratio instead of our derived 7d/28d, and unfreezes the
   four metrics currently stamped on a single fresh day.
3. **Keep BOTH lap views** (medium): today a structured workout discards
   its per-km splits (and vice versa); `activity_laps.splitType` is already
   shaped for both. The effort package's SPLITS section is the direct
   beneficiary.
4. **Zone definitions** (small, rides #2): lthrZone/ltspZone so the coach
   and insights can name zones the athlete's watch names.
5. **Per-sample streams** (large): frequencyList/graphList or the FIT
   download — real HR-drift/decoupling from samples instead of lap
   approximations, peak-effort curves, climb/route context; the dead
   `activity_stream_summaries` table is already shaped for the summaries.
   Biggest analytical unlock, biggest ingestion cost.
6. **Descent + elevation profile for trail** (small, rides #3's touch).
7. Hygiene, non-coach: calories dropped at the DB boundary;
   `activities.timezone` column never written; `activity_stream_summaries`
   is dead until #5.

Not worth it: windDirection (no route bearing to compare against), external
weather APIs (no stored coordinates), body temperature (does not exist).
