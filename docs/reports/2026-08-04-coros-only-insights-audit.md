# Insights audit — discipline-aware dashboard

**Date:** 2026-08-04
**Scope:** Phase 3 of the COROS-only migration (commits `3b395a6`, `258c4a6`, `2f1bbd9`).
**Method:** Three parallel audit agents were dispatched (metric correctness, copy and
framing, sparse/empty states). **All three stalled at the runtime's 600s watchdog and
returned no usable output** — each had read two or three files when it died. Three
identical failures pointed at infrastructure rather than the prompts, so the audit was
carried out directly instead. This report covers the same three lenses; it is a
single-reviewer audit, not the three-perspective one originally planned, and should be
read with that reduced independence in mind.

## Findings

### 1 · Consistency reported at a different scope than the rest of the page — HIGH

`apps/worker/src/routes/misc.ts:689` (pre-fix)

`computeConsistency` was fed `workouts` — every planned workout in the window,
unfiltered by discipline — while `computeWeeklyTraining` beside it was fed the
discipline-scoped `runs`.

**Failure scenario.** A user with 40 planned runs and 3 planned lifts selects
**Strength**. The Signals grid, Weekly training, and Records all describe lifting; the
Consistency card and the `StatusStrip` adherence headline directly above them describe
the whole plan, dominated by running. Both are labelled only by the discipline chip. The
number a reader would quote as "my lifting consistency" is in fact their running
consistency.

**Fix.** Planned workouts are filtered by `disciplineOf(category, sport)` before
`computeConsistency`. `disciplineOf` was promoted out of `garden-sync.ts` (where it was
a private helper) into `packages/analytics/src/discipline.ts`, and both call sites now
share it.

Category is checked before sport there, and that ordering matters: COROS's plan
namespace is `1=run 2=bike 3=swim 4=strength` with **no yoga sport type**, so a scheduled
yoga session arrives as `sport: "run"` and is only identifiable from the category the
title classifier assigned. Filtering on `sport` alone would have filed every planned
yoga session under running — the exact bug this fix exists to prevent, reintroduced.

Regression tests: `apps/worker/test/insights-route.test.ts` — "counts only this
discipline's planned workouts" and "files a planned yoga session by category".

### 2 · Switching discipline replaced the whole screen, selector included — MEDIUM

`packages/ui/src/screens/insights.tsx:189` (pre-fix)

`queryKey: ["insights", discipline]` means selecting a new discipline is a cache miss,
so `insights.isLoading` goes true and the early return `if (insights.isLoading) return
<Spinner/>` replaced the entire screen — including the chips that had just been tapped.

**Failure scenario.** The user taps **Yoga**, the page goes blank but for a spinner, and
there is no way to tap back to Running until the request completes. A mis-tap costs a
full round trip.

**Fix.** The last known `availableDisciplines` is held in state, the selector is hoisted
above the loading branch, and the loading return renders the title and chips around the
spinner.

Deliberately **not** `keepPreviousData`: that would leave running's numbers on screen
under a Yoga chip during the fetch. Briefly showing one discipline's data labelled as
another's is worse than briefly showing nothing.

### 3 · Selecting a discipline could hide the control needed to leave it — LOW

`packages/ui/src/screens/insights.tsx` (pre-fix)

The selector rendered only when `availableDisciplines.length > 1`, but the selected
discipline lives in independent component state. If the selected discipline is absent
from a later `availableDisciplines` and only one other remains, the selector disappears
while that discipline is still selected — leaving the user on a view with no way off it
short of a reload.

Narrow to reach (it needs the available set to change within a session), but the guard
is one line. **Fix:** the chip list always includes the selected discipline, whether or
not the server currently lists it.

## Checked and found correct

- **`availableDisciplines` window agreement.** Derived from the same `allSport` array,
  after the same local-date re-filter, as every metric on the page. The route's
  `actRows` query deliberately over-fetches by a day and `allSport` re-filters on local
  date; both the discipline list and the metrics sit downstream of that, so they cannot
  disagree about the window.
- **Load signals stay all-sport.** `loadRatio`, `ramp`, `monotony`, and `hardStack` are
  fed `loadsByDay`/`secondsByDay`, built from `allSport`, not from the discipline-scoped
  rows — a hard lift is load the legs absorb whichever chip is selected. `loadBasisNote`
  still says "all sports" and is still true.
- **Record namespacing cannot leak across disciplines.** `mergeRecords` keys on `id`;
  every id is prefixed `${discipline}:` at the single `push` site in `computeRecords`.
  The legacy `records:v1` row seeds **only** the run discipline, only when no
  `records:v2:run` row exists yet, and is never written to again.
- **`StatusStrip` has no dead scroll targets.** It is bounded by `RENDERED_METRIC_IDS`
  (derived from `METRIC_GROUPS`) *and* by what `interpreted` actually contains. Since the
  route now omits run-only ids from `interpreted` for other disciplines, the strip cannot
  headline a metric with no tile beneath it. The Signals grid independently returns
  `null` for any group whose metrics are all absent, so the "Execution" group simply does
  not render for strength or yoga.
- **No empty titled cards.** Consistency (`planned > 0`), Weekly training
  (`recentTraining.length === 0`), Records (`records.length > 0`), and Weekly review
  (`reviews.length > 0`) each have an explicit empty branch or guard. Aerobic response is
  unmounted entirely rather than rendered hollow.
- **Copy reachability.** Every remaining "run"/"runs"/"running" string in the
  `interpreted` array belongs to a metric in `RUN_ONLY_METRICS`
  (`lowIntensityShare`, `easyDiscipline`, `pacing`) and is therefore unreachable for
  strength and yoga. `ramp` and `hardStack` were corrected during implementation and are
  covered by a test asserting no shipped card matches `/\brun(s|ning)?\b/i` for a
  strength request. The `pacing` drilldown's "run by run" is reachable only via a
  run-only metric.
- **Thin-history honesty.** `longestSession`, `mostSessionsInAWeek`, and `longestStreak`
  require `MIN_SESSIONS_FOR_RECORD = 5` and a count of `MIN_NOTABLE_COUNT = 3`, matching
  the module's existing `MIN_EFFICIENCY_RUNS`/`MIN_ADHERENCE_WEEKS` convention and its
  stated promise of no fake records.

## Not covered

- **Rendered-output review.** This audit read code; it did not run the app and look at
  the three discipline views. Worth doing once the backfill has put real strength and
  yoga history in the database — the sparse-state reasoning above is traced, not seen.
- **Independent perspectives.** The three-reviewer structure was the point of the
  original plan and it did not run. A second pass by a fresh reader would be cheap
  insurance on findings 2 and 3, which are judgement calls about interaction rather than
  provable defects.
