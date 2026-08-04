# COROS-Only — Full History, Three Equal Disciplines

**Date:** 2026-08-04
**Decisions (user-approved):** three disciplines stay the app's vocabulary (run, strength,
yoga — not every COROS sport); deep history via a one-shot resumable backfill job;
discipline-aware insight metrics with a discipline selector; Strava removed completely;
surviving Strava-only rows kept as source-less activities. Shipped end to end as one plan,
with post-implementation audits on the insights phase.
**Motivating fact:** Strava API access has required a paid subscription since 2026-06-01
(`docs/research/strava-api.md` §4). The user's membership lapsed. COROS already supplies
every metric the app actually uses.

## Goal

Make COROS the single source of truth, with history going back as far as the account
does, and stop treating strength and yoga as second-class next to running. When this
lands: no Strava code, no Strava columns, no Strava env; the activities table holds every
run, lift, and yoga session COROS knows about; and the insights dashboard answers
questions about all three disciplines rather than silently filtering to runs.

## Non-goals

- Admitting bike/swim/walk/cardio as first-class disciplines. They stay outside the
  garden's balance model and outside ingest; the census (phase 0) reports them so the
  decision stays informed, but `COROS_GARDEN_SPORT_TYPES` remains the gate.
- Re-designing the garden's discipline model. `balance.ts`, `species.ts`, and `unlocks.ts`
  are already genuinely tri-discipline and are not touched.
- New COROS write capability. Backfill is read-only.
- Backfilling daily health further than the existing 60 days, or adding sleep.

## What COROS already covers (basis for removing Strava)

`services/coros-bridge/src/snapshot.ts` pulls plan, structured workouts, activities, laps,
and daily health in one pass. Activities admit run (100–103), strength (402), yoga
(403/904) via `COROS_GARDEN_SPORT_TYPES`. Metrics: duration, elapsed, distance, avg/max
HR, avg pace, elevation, calories, training load, per-lap splits. Health: resting HR, HRV,
fatigue, 7-day load. Plus the explicit plan↔activity link (`summary.programId`) that
yields `coros_plan_link` matching at confidence 1.0 — something Strava can never provide.
`merge.ts` already declares COROS authoritative for every metric.

Strava's only unique contributions are `summaryPolyline` (stored, rendered nowhere — no
map component exists), an IANA `timezone` string (stored, never read; all date logic uses
`startTimeLocal`, which COROS supplies), a title preference on merge, and `description` /
`calories` / `external_id`, which are normalized and then dropped because the `activities`
table has no columns for them. `docs/ANALYTICS.md` §275 already strips every Strava-sourced
field before the weekly LLM review, so Strava contributes nothing to insights today.

---

## Phase 0 — Sport census

A read-only diagnostic before anything is built on an assumption about sport codes.

Walks the account's full activity history via the existing paginated
`CorosClient.getActivities` (size 200, follows `totalPage`) and reports, per distinct
`sportType`: count, earliest and latest date, and up to three sample activity names. No
detail fetches, no ingest, no writes.

**Why it comes first:** the user has historical COROS yoga. The map claims yoga is 403 and
904, but `corosSportName` falls through to `coros_<n>` for anything unmapped, and
`buildSnapshot` tallies unmapped codes into `skippedSportTypes` and drops them. If that
yoga sits under a code we do not map, every downstream phase would be built on sand. The
census is the cheapest possible way to find out.

**Deliverable:** a bridge subcommand writing `docs/reports/coros-sport-census-<date>.json`,
plus a short written finding: which codes exist, which are admitted, which are dropped,
and whether `COROS_GARDEN_SPORT_TYPES` needs new entries before phase 1. If the census
turns up yoga (or strength) under unmapped codes, adding them to the map is part of
phase 1, and the mapping change ships with a normalizer test per added code.

## Phase 1 — Resumable deep backfill

### 1.1 The hazard that shapes the design

Backfill must **not** reuse the normal snapshot path. `import-plan.ts` judges absence
within a snapshot's `[rangeStart, rangeEnd]`: rule 8 archives a workout after two
consecutive absent reads, and rule 9 archives the old plan when a different plan appears
active. A snapshot covering 2024 legitimately contains none of today's workouts, so
pushing one through the normal path would archive the live plan and its scheduled
workouts.

Therefore backfill is **activities-only**, end to end, and never touches plan
reconciliation.

### 1.2 Bridge (`services/coros-bridge`)

`buildActivityBackfill(client, rangeStart, rangeEnd, resolver)` — a sibling of
`buildSnapshot` that performs only the activities-and-laps portion: paginate
`getActivities`, gate on `COROS_GARDEN_SPORT_TYPES`, fetch `getActivityDetail` per
admitted item, normalize via `normalizeCorosActivity` / `normalizeCorosLaps`, tally
`skippedSportTypes`. Returns `{ activities, lapsByProviderId, skippedSportTypes }` — no
plan, no health, no exercise catalog.

`coros-client.ts` gains a small configurable inter-request delay used by the backfill path,
since this is one detail call per activity (roughly 800–1000 for five years of training)
against an API with no published rate limit. The rolling snapshot path keeps its current
behaviour.

### 1.3 Job kind

A `backfill` job kind modelled on `read_now`: workout-less (self-referencing `workoutId`,
the trick the studio kinds already use), so it inherits claiming, Ed25519 signing, retry,
and the `pendingCount`-driven fast poll. The job payload carries `{ chunkStart, chunkEnd }`.

Execution: the bridge claims the job, calls `buildActivityBackfill` for the chunk, POSTs
the result to a new signed `POST /api/devices/bridge/backfill-chunk` (`requireDevice`,
alongside the existing `/bridge/sync`), then reports the job result normally with
`{ activitiesFound, earliestDate }`.

### 1.4 Worker

`backfill-chunk` calls `ingestActivities` **only** — never `importPlan` — then resimulates
the garden from the earliest affected date, exactly as the webhook and snapshot paths do.

`applyJobResult` for `backfill` advances the checkpoint and enqueues the next chunk. All
chunk-sequencing logic lives in one pure function so it is unit-testable without a
database:

```ts
nextBackfillAction(state: BackfillState, result: ChunkResult): 
  | { kind: "continue"; chunkStart: LocalDate; chunkEnd: LocalDate }
  | { kind: "done"; reason: "empty_run" | "floor_reached" }
```

- **Direction/size:** walks backwards from `today − 14d` (where the rolling window already
  ends) in 90-day chunks.
- **Termination:** two *consecutive* empty chunks — one empty chunk is an ordinary
  training gap — or a configurable floor date (default five years back).
- **Resumption is free:** the checkpoint advances only on a reported chunk, so a slept Mac
  resumes at the pending chunk rather than restarting.

### 1.5 Storage

New `backfill_state` table: `userId` (pk), `status` (`idle` | `running` | `done` |
`error`), `earliestDateReached`, `chunksCompleted`, `activitiesIngested`,
`consecutiveEmptyChunks`, `skippedSportTypes` (json, accumulated), `startedAt`,
`updatedAt`, `lastErrorCategory`.

### 1.6 Surface

Settings gains a "Backfill history" button and live progress (chunks done, earliest date
reached, activities ingested). `POST /api/activity/backfill` is repointed from Strava to
enqueueing this job; its `strava_unavailable` / `strava_error` responses are replaced with
device-availability reasons. The self-heal steps it already runs (`repairDurations`,
`repairTimestamps`, `promoteProvisionalMatches`) stay.

## Phase 2 — Strava removal

### 2.1 Ordering

**Backfill runs before removal, and this is load-bearing.** `ingestActivities`
(`completion.ts:406-481`) already absorbs an existing Strava-only row when a matching
COROS activity arrives — ±1h window, pair score ≥ 0.6 — reusing the original
`activities.id`, so completion matches, garden history, and records survive untouched.
Removing the merge code first would instead produce duplicate rows beside the old ones.

### 2.2 Code deleted

`apps/worker/src/services/strava.ts`, `apps/worker/src/routes/strava.ts`,
`packages/providers/src/strava/`, and from `merge.ts` the pair-merge machinery
(`scoreActivityPair`, `mergeActivityPair`, `pairSources`) — `singleSourceActivity` stays
and becomes the only path. The Strava branches in `completion.ts` ingest collapse
accordingly. `ActivityProviderName` narrows to `"coros"`.

UI: the onboarding Strava step (`STEPS` drops to seven), the Settings connection card, the
lapsed-subscription banners on `garden.tsx:705` and `today.tsx:325`, the `stravaStatus`
field in the plan route's sync payload, and the Strava copy in `runs.tsx` (empty states,
backfill error) and `match-sheet.tsx`.

Env: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_API_BASE`,
`STRAVA_WEBHOOK_VERIFY_TOKEN`.

The weekly-review cron's Strava-field stripping in `apps/worker/src/index.ts` disappears
with the fields it guards — the API-agreement caution no longer applies.

### 2.3 Data migration

One migration, in this order:

1. Run `promoteProvisionalMatches` to settle any outstanding `provisional` matches, then
   drop the `provisional` column. `provisionally_completed` is removed from the
   `CompletionState` union in `packages/domain/src/states.ts:36`, and every call site that
   branches on it collapses to `completed`: `completion.ts` (the `hasCoros` ternary at
   :602, the promotion branch at :573, the candidate-state filter at :525),
   `import-plan.ts` (:256, :351, and the state-rank map at :581), `garden-sync.ts:161`,
   and `plan.tsx` (:221, :231, :322).
2. Delete `activity_source_links` rows with `provider = 'strava'`, and
   `provider_connections` rows with `provider = 'strava'`.
3. Drop the `activities_strava_unique` index, then the `activities.strava_activity_id`
   column, then `activities.summary_polyline` (Strava-only and rendered nowhere). Index
   before column — SQLite/D1 will not drop a column an index references.
4. Drop `webhook_events` — only the Strava route ever wrote it; its sole other reference
   is the account-deletion sweep in `misc.ts`, which is updated in the same change.

Surviving orphans — activities with no COROS source, i.e. sessions that only ever lived on
Strava — keep their metrics and become source-less rows that still count toward the
garden, streaks, and records. The migration emits a report of their count and dates.

## Phase 3 — Discipline-aware insights

### 3.1 The good news

`consistency.ts`, `weeklyTraining.ts`, and `timeOfDay.ts` are already generic over their
input shapes. The run-ness lives in the route, not the metrics: `misc.ts:513` splits
`runRows = allSport.filter(a => a.sport === "run")` and feeds only those to every
execution, aerobic, pacing, and records metric. So this phase is mostly a route change
plus copy that stops saying "runs" when it means "sessions".

### 3.2 API

`GET /api/insights?discipline=run|strength|yoga`, defaulting to `run`. The response gains
`availableDisciplines` — only disciplines with data in the window, so the selector never
offers an empty view — and carries the metric set that is real for the requested
discipline. **Cards that do not apply are absent from the payload, not empty.**

| Discipline | Metrics |
|---|---|
| Run | Everything today: aerobic efficiency, decoupling, HR zones, low-intensity share, easy discipline, weekly training split, pace-based records |
| Strength, Yoga | Consistency + heatmap, session frequency, duration trend, training-load contribution, HR intensity where present, time-of-day, own records |
| All-sport (unchanged) | Load ramp and recovery signals, which already include every sport and say so in `loadBasisNote` |

### 3.3 Records

`computeRecords` takes a discipline. Record ids are namespaced
(`run:best_aerobic_efficiency`, `yoga:longest_session`), the `computed_metrics` key becomes
`records:v2:{discipline}`, and the never-regress merge stays per-discipline so one
discipline's history cannot suppress another's. `fastestComebackDays` and
`mostConsistentFourWeeks` generalize as-is — they already operate on dates and adherence,
not on pace. New for strength/yoga: longest session, most sessions in a week, longest
streak.

### 3.4 UI

A discipline selector at the top of `insights.tsx`, driven by `availableDisciplines`. The
`StatusStrip` and `METRIC_GROUPS` derive from the returned payload rather than a
hardcoded run-shaped list — the existing comment at `insights.tsx:151` already insists the
strip be derived, not hand-duplicated, and that constraint now spans disciplines.

`apps/worker/src/index.ts:170`'s run-only weekly-facts filter becomes discipline-aware.

### 3.5 Audits

Because insights is the phase most likely to go subtly wrong — honest sample sizes,
suppression rules, and copy that must not claim more than the data supports — it gets
post-implementation audits: parallel reviewers over (a) metric correctness and
suppression honesty per discipline, (b) copy and framing across the new discipline views,
(c) empty/sparse-data states for a discipline with two sessions. Findings are synthesized
into one prioritized write-up under `docs/reports/`.

## Testing

- **Pure functions first:** `nextBackfillAction` (checkpoint + chunk result → next action),
  covering the two-consecutive-empty rule, the floor, and resumption after a gap.
- **Normalizer:** admission tests for every code in `COROS_GARDEN_SPORT_TYPES`, including
  yoga 403 and 904, plus any code the census adds.
- **Migration:** a legacy Strava-only row plus an arriving COROS activity collapses to one
  row with `activities.id` and its completion match preserved; an orphan with no COROS
  counterpart survives with metrics intact.
- **Rewrites:** `packages/providers/test/merge-matching.test.ts` becomes COROS-only;
  `apps/worker/test/vertical-loop.test.ts` drops its Strava leg.
- **Guard:** backfill never invokes `importPlan` — asserted directly, since the
  consequence of regression is silently archiving the live plan.
- **Insights:** per-discipline metric selection, `availableDisciplines` correctness, and
  suppression when a discipline has too few sessions.

## Risks

| Risk | Mitigation |
|---|---|
| Historical yoga sits under an unmapped sport code and stays invisible | Phase 0 census runs before anything else and reports every distinct code |
| Backfill archives the live plan via `import-plan` rules 8/9 | Activities-only path with no `importPlan` call, plus an explicit regression test |
| Deep detail-fetch loop hammers COROS | 90-day chunks, configurable inter-request delay, one-shot rather than recurring |
| Dropping `strava_activity_id` orphans real sessions | Backfill runs first so matched rows are absorbed; orphans are kept, not deleted, and reported |
| Discipline-aware insights overstate thin data | Existing `MetricResult` suppression contract is per-discipline; audits specifically cover sparse states |

## Sequencing

Each phase is independently shippable and lands in order: **0** census → **1** backfill
infrastructure → run the backfill and verify yoga/strength arrive → **2** Strava removal
plus data migration → **3** discipline-aware insights → audits.
