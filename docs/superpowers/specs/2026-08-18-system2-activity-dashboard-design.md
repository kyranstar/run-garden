# System 2 — Activity + Insights become one dashboard (approved 2026-08-18)

User-approved via mock artifact b8987ff3 v2 ("Looks great"). The mock is the
spec; this file pins the data wiring and the scope cuts. Density law (learned
over both systems' mock rounds): data, names, and pictures only — no explainer
captions on the page; explanations live one tap down.

## The page (/runs, nav label "Activity"; nav drops to 4 tabs; /insights → /runs)

Order, mobile-first:

1. **Header** — h1 "Activity" + existing discipline chips (All/Runs/Lifting/
   Yoga/Adventures). CorosCheck note stays; the header "Backfill history"
   button DIES (Settings keeps it). Chips: the feed filters client-side as
   today; the overview sections read insights for the chip's discipline
   (run/strength/yoga); under All/Adventures the overview shows running (the
   default discipline — the product's center).
2. **Training** — eyebrow "Training"; WeeklyDurationChart (existing, 8 wk
   stacked low/high + 4-wk avg) with legend; no subtitle/note paragraphs.
3. **Consistency** — "82% of planned workouts done." (adherence line, no
   count) + ConsistencyHeatmap. No OutcomeBar (the heatmap carries the
   texture), no caption, no streak note (home celebrates it).
4. **Signals** — ONLY flagged tiles (interpreted where status==="ok" and
   band high|watch, same confidence gates as pickStatusStripMetric) rendered
   with SignalTile minus the meaning/suggestion prose (value + range + visual;
   the drilldown keeps the words). None flagged → one line "All N signals in
   range." Then "All N signals ›" expander revealing: the full grouped grid
   (Load/Recovery/Execution, tiles as today), Hill exposure, and the Aerobic
   response pair. MetricDrilldown sheet unchanged.
5. **Records** — top 3 (newest-record first, "New" ring rule as today), no
   rule fine-print on the page; "All records ›" expander for the rest.
6. **Feed** — activities grouped by ISO week, newest first, 3 weeks then
   "Earlier weeks ›" (client-side reveal):
   - Week header: serif "This week"/"Week of <Mon d>" + "N sessions · Xh Ym"
     (client-side sums over the week's activities, all sports).
   - Week story: reviews[].narrative matching the weekStart —
     firstSentence(narrative) + "Full review ›" expanding the rest in place.
     Weeks without a review get stats only.
   - Row: category spine (matched.category else sport-mapped), day-of-month +
     DOW, title, one stat line (duration · distance · pace | duration · load),
     chevron. The whole row is the disclosure trigger.
   - Expanded in place: PaceShape (when laps); EffortChip line + matched pill
     OR "Link to a workout" (LinkSheet as today); efficiency clause when the
     run is in efficiency.perRun ("Above/Below/On your efficiency trend —
     …" vs the median of the prior 5 runs' values, plain words, one clause);
     the coach's read — CACHED reads render automatically via the new peek
     endpoint; "✨ Get the coach's read" stays an explicit tap when none
     exists (CoachRead component handles generation states as today);
     "Open in Plan ›" when matched (→ /plan?workout=<matched.workoutId>).
   - No "Laps & heart rate" link in v1 (ActivityDto laps carry no HR; the
     pace shape + read carry the expansion). Deliberate scope cut from mock.
7. **Weekly review section, records rules, evidence card, status strip** —
   none exist as standalone blocks anymore (folded per above; evidence stays
   a home-Lately line; StatusStrip component becomes unused by screens).

## Server

New `GET /api/coach/analyze/:activityId` — returns `{ read }` from the
ledger when status==="done", `{ read: null }` otherwise. Never generates,
never claims, no gates beyond auth. POST is unchanged (explicit tap).

## Deletions / migrations

- insights.tsx screen dies; its pieces move: MetricDrilldown + signal-group
  grid + aerobic/hill blocks into the dashboard's expander (extracted to
  screens/signals-panel.tsx); ReviewBody → the feed's week story.
- app.tsx: /insights route → <Navigate to="/runs" replace>; the chart
  ErrorBoundary moves onto /runs. shell.tsx NAV loses the Insights entry.
- Home's ReviewPull link retargets /runs.
- Tests migrate: insights-copy.test.tsx targets move; runs-units keeps
  PaceShape coverage; new tests for week grouping + efficiency clause +
  flagged-tile filter + peek endpoint.

## Verification gates

Same as System 1: vitest green on default node; screenshot matrix
360/390/768/1280/1440 light+dark with zero-overflow gate; tap-target
hit-tests on rows/expanders/chips; independent adversarial verify AFTER
implementation; real before/after; user ship call before push.
