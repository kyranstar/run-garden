# Sync & reconciliation

How Run Garden keeps four systems honest with each other: the COROS schedule,
its own intended schedule, Google Calendar, and completed activities from
COROS + Strava. Implementation: `apps/worker/src/services/import-plan.ts`
(rules 1–11), `jobs.ts` (write queue), `reconcile-daily.ts` (grace periods),
`calendar-sync.ts` + `packages/calendar/src/reconcile.ts` (calendar),
`completion.ts` + `packages/providers/src/{merge,matching}.ts` (activities).

## COROS schedule reconciliation — rules 1–11

Every bridge (or fixture) snapshot import runs these rules per workout.
Importing the same snapshot twice is a no-op. Rule numbers 4–9 are cited in
the code comments of `import-plan.ts`.

| # | Situation | Behavior |
|---|---|---|
| 1 | **New workout** appears upstream | Create it: all three dates = the COROS date; default time-of-day from preferences (long/race → morning; otherwise the user's default window); calendar state `pending` (rest days: `not_created`); COROS state `synced` if writes available, else `calendar_only` |
| 2 | **Unchanged** (same date, same content fingerprint) | No-op; counted as `unchanged`. Any sighting resets the absence counter (`missingReads = 0`) |
| 3 | **Pending move not yet landed** — COROS still shows a pending job's `originalDate` | Keep waiting; nothing changes |
| 4 | **Pending move landed** — COROS now reports the job's `destinationDate` | Job → `verified`; workout `lastVerifiedCorosDate` updated; `corosSyncState` → `synced` |
| 5 | **Upstream date change, no pending job** (moved in the COROS app) | Accept it: `lastVerifiedCorosDate` and `effectiveDate` follow COROS; **time of day is preserved**; `originalPlanDate` untouched (history); calendar → `pending` (unless `user_deleted`) |
| 6 | **Conflict** — upstream date changed while a local move was pending, and it is not the destination | Workout and job both → `needs_attention`; the user decides. Nothing is overwritten silently |
| 7 | **Content changed upstream** (fingerprint differs) | Refresh title/category/subtype/stages, re-run the duration estimate, update fingerprints; calendar → `pending` if it was synced. Placement (`effectiveDate`/`effectiveTime`) untouched |
| 8 | **Disappeared upstream** | Only counts if the workout's `lastVerifiedCorosDate` lies inside the snapshot's range (absence outside the window proves nothing). `missingReads` increments; at **2 consecutive absent reads** the workout is archived and a `workout_removed` calendar suppression removes its event. Only `scheduled` workouts can be archived this way — completed history is never deleted |
| 9 | **Different plan became active** | The old plan and its still-`scheduled` workouts are archived; completed history preserved untouched |
| 10 | **Version capture** | Any create/content-update/archive appends a `training_plan_versions` row (and the first import always does) |
| 11 | **Range honesty** | All absence judgments are scoped to the snapshot's `[rangeStart, rangeEnd]`; a snapshot never makes claims about dates it did not cover |

## The five COROS sync states

`CorosSyncState` (`packages/domain/src/states.ts`) with its exact UI labels:

| State | Label | Meaning |
|---|---|---|
| `synced` | **Synced** | COROS agrees with Run Garden's intended date; the last write (if any) was verified by a read |
| `syncing` | **Syncing** | A write job is queued/claimed and a bridge device is online (seen < 3 min ago, not paused) |
| `waiting_for_device` | **Waiting for Mac** | A write job is queued but no bridge device is online — it will run when the Mac wakes |
| `calendar_only` | **Calendar only** | COROS writing unavailable (no capable device, writes disabled, or a job permanently failed after 5 attempts) — the calendar still reflects the intent; COROS keeps the old date |
| `needs_attention` | **Needs attention** | Conflict, failed verification, or ambiguity that a human must resolve |

Time-of-day-only changes never leave `synced`: COROS has no time-of-day, so
there is nothing to write (`jobs.ts: applyMove`). Races cannot be moved at all.

### Watch-sync truthfulness

There is no server-side push to the watch and no way to verify watch delivery
(`verifyWatchSync` is always `false`). After a verified write the product says
**"COROS calendar updated · Open COROS to sync your watch"** — never "Updated
on watch". Calendar changes reach the watch when the COROS phone app next
syncs. See [COROS_WRITE_PROTOCOL.md](COROS_WRITE_PROTOCOL.md).

## Calendar reconciliation

`syncCalendar` runs every 30 minutes (and after imports/moves/job results).
Window: `mirrorWeeksBehind` (default 2) back to `mirrorWeeksAhead` (default 8)
ahead. One managed event per non-rest workout, carrying private extended
properties (workout id + content fingerprint). Reads are incremental via the
Google sync token, falling back to a windowed full read when the token expires.

Decisions are pure (`packages/calendar/src/reconcile.ts`):

| Observation | Operation |
|---|---|
| Desired event with no link/event | `create` |
| Content fingerprint differs from `last_written_fingerprint` | `update` (idempotent otherwise) |
| Event times differ but *we* didn't change content | `accept_user_move` — the user dragged the event: the new start (plus the before-buffer offset) becomes `effectiveDate`/`effectiveTime` via the same `applyMove` path as an in-app move, queueing a COROS write if the date changed |
| Event cancelled, or vanished from the feed | `mark_user_deleted` — never recreated; a suppression row records it; the app offers an explicit restore (`restoreCalendarEvent`) |
| Description changed while our properties/fingerprint are intact | `preserve_notes_update` — the user's notes block is extracted, stored on the link, and spliced back into every future rewrite ahead of the managed footer |
| Workout archived/removed upstream | `delete` the managed event |

Event blocks are padded (`bufferBeforeMinutes` before + `bufferAfterMinutes`
after, defaults 10/15) and carry the reminder plan: morning runs get a
previous-evening "protect tonight's sleep" reminder at `eveningReminderTime`
(default 20:30) plus a 30-minute pre-run reminder; evening runs get a single
60-minute reminder (`packages/scheduling/src/reminders.ts`).

## Missed-run grace periods

A slow provider sync must never be misread as a missed run
(`reconcile-daily.ts`, hourly cron):

| Transition | Rule |
|---|---|
| `scheduled → unresolved` | Only once `effectiveDate` < today − **1 day** (`SYNC_GRACE_DAYS`) — the app then asks "Did this run happen?" |
| `unresolved → missed` | After **7 days** (`AUTO_MISS_DAYS`) with no match and no answer; `resolutionDate` = the day it aged out (the garden charges the miss then, not retroactively). Still reversible by a later match |
| Rest days | Never become unresolved/missed |
| Rest mode | Pauses the entire missed pipeline while active |

The garden has its own grace: a day is simulated once it is ≥ 2 days old, or
earlier if every workout on it is resolved (`garden-sync.ts`).

## Strava webhook idempotency

`POST /api/strava/webhook` (`apps/worker/src/routes/strava.ts`):

- Dedupe key = `strava:{object_type}:{object_id}:{aspect_type}:{event_time}`,
  the primary key of `webhook_events`; a duplicate delivery returns
  `{ok, duplicate: true}` without reprocessing (Strava retries up to 3 times).
- The 200 is returned immediately; processing happens in
  `executionCtx.waitUntil` to respect Strava's 2-second budget.
- Only activity create/update events are processed; deletes and athlete events
  are recorded as `ignored`. Failures mark the row `error` with a sanitized
  `sync_errors` entry — the row remains for reprocessing/diagnosis.
- Subscription validation: the GET handler echoes `hub.challenge` as JSON when
  `hub.verify_token` matches `STRAVA_WEBHOOK_VERIFY_TOKEN`.

## Activity dedup (COROS ⇄ Strava)

One physical run = one `activities` row with links from both providers
(`packages/providers/src/merge.ts`). Pair scoring (0–1): start-time proximity
up to 0.35 (full ≤ 2 min, zero ≥ 15 min), sport match 0.15, duration
similarity up to 0.2 (full ≤ 5% apart), distance similarity up to 0.2 (full
≤ 3%; a missing side scores a weak-neutral 0.05), COROS device-name hint 0.1.
Titles are never used for identity. Pairing floor: **0.6**. Confidence bands
(`mergeConfidenceBand`): **high ≥ 0.85**, **medium ≥ 0.6**, low below. On
merge, COROS wins all metrics; Strava contributes title, polyline, timezone.

## Completion matching confidence bands

Planned↔completed matching (`packages/providers/src/matching.ts`):

- **Pass 1 — explicit COROS plan link**: the activity's `planId`/`programId`
  matches the workout's program → confidence **1.0**, method `coros_plan_link`.
- **Pass 2 — transparent score**: date (0.3 on `effectiveDate`, 0.2 on
  `originalPlanDate`, 0.1 for ±1 day; anything further is never a match) +
  sport 0.15 (mismatch is a hard reject) + duration up to 0.2 (vs the estimate)
  + distance up to 0.15 + same-day start-time proximity up to 0.1 + 0.1 base.
- Bands (`matchBand`): **high ≥ 0.75** and **medium ≥ 0.5** auto-match
  (`scored_auto`); **low < 0.5** goes to the review queue in the UI — never
  auto-matched. Matching is greedy one-to-one.
- A Strava-only match sets `provisionally_completed` (`provisional = true`);
  when the richer COROS copy arrives and merges, the match is upgraded and the
  workout becomes `completed`. Matches are reversible (`undoneAt`), and manual
  match/unmatch endpoints exist.
