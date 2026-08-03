# Sync & reconciliation

How Run Garden keeps four systems honest with each other: the COROS schedule,
its own intended schedule, Google Calendar, and completed activities from
COROS + Strava. Implementation: `apps/worker/src/services/import-plan.ts`
(rules 1–11) + `reconcile.ts` (the date-conflict decision table), `jobs.ts`
(write queue) + `sync-intents.ts` + `sync-notes.ts` (intent ledger, undo
notes), `sync-status.ts` (derived status), `reconcile-daily.ts` (grace
periods), `calendar-sync.ts` + `packages/calendar/src/reconcile.ts`
(calendar), `completion.ts` + `packages/providers/src/{merge,matching}.ts`
(activities).

## COROS schedule reconciliation — rules 1–11

Every bridge (or fixture) snapshot import runs these rules per workout.
Importing the same snapshot twice is a no-op. Rules 7 and 8 are still cited
by number in the code comments of `import-plan.ts`; rules 4–6 moved into
`reconcileWorkout`'s decision table (below) and are no longer inline
`switch` cases there.

| # | Situation | Behavior |
|---|---|---|
| 1 | **New workout** appears upstream | Create it: all three dates = the COROS date; default time-of-day from preferences (long/race → morning; otherwise the user's default window); calendar state `pending` (rest days: `not_created`); COROS state `synced` if writes available, else `calendar_only` |
| 2 | **Unchanged** (same date, same content fingerprint) | No-op; counted as `unchanged`. Any sighting resets the absence counter (`missingReads = 0`) |
| 3 | **Pending move not yet landed** — COROS still shows a pending job's `originalDate` | Keep waiting; nothing changes |
| 4–6 | **Upstream date changed** — COROS now reports a date different from `lastVerifiedCorosDate` | Routed through the pure decision table `reconcileWorkout` — see "Reconciliation core" below. Replaces the old "conflict → `needs_attention`" freeze with last-edit-wins |
| 7 | **Content changed upstream** (fingerprint differs) | Refresh title/category/subtype/stages, re-run the duration estimate, update fingerprints; calendar → `pending` if it was synced. Placement (`effectiveDate`/`effectiveTime`) untouched |
| 8 | **Disappeared upstream** | Only counts if the workout's `lastVerifiedCorosDate` lies inside the snapshot's range (absence outside the window proves nothing). `missingReads` increments; at **2 consecutive absent reads** the workout is archived and a `workout_removed` calendar suppression removes its event. Only `scheduled` workouts can be archived this way — completed history is never deleted |
| 9 | **Different plan became active** | The old plan and its still-`scheduled` workouts are archived; completed history preserved untouched |
| 10 | **Version capture** | Any create/content-update/archive appends a `training_plan_versions` row (and the first import always does) |
| 11 | **Range honesty** | All absence judgments are scoped to the snapshot's `[rangeStart, rangeEnd]`; a snapshot never makes claims about dates it did not cover |

## Reconciliation core — `reconcileWorkout`

Rules 4–6, plus the "already converged from the other side" edge no old rule
number covered, collapse into one pure decision table:
`reconcileWorkout` (`reconcile.ts`), unit-tested with no database.
Given a workout's `lastVerifiedCorosDate`, the freshly `observedDate` from a
snapshot, its open move intent (if any), and any pending write job, it
returns exactly one action:

| Action | When | Effect |
|---|---|---|
| `none` | `observedDate === lastVerifiedCorosDate` | Nothing changed upstream — includes a pending move that hasn't landed yet (old rule 3) |
| `verify_job` | COROS now shows the pending job's destination, **or** no job exists but COROS already agrees with the open intent | Job → `verified` (if any); intent resolved; `lastVerifiedCorosDate` → observed; `corosSyncState` → `synced` (old rule 4) |
| `app_wins` | An open intent exists and COROS shows neither the job's destination nor the intent's target | The intent stands, any stale job is superseded and re-derived against the new origin, and COROS's displaced value becomes a `kept_local_change` undo note — replaces old rule 6's `needs_attention` freeze |
| `adopt_coros` | No open intent | COROS is adopted automatically: `effectiveDate`/`lastVerifiedCorosDate` follow it, time-of-day is preserved, and an `adopted_coros_change` note records the previous date (old rule 5) |

The policy in one line (spec §2): an open intent is by definition the most
recent thing the user did in-app, so it wins ties; with no open intent, COROS
is simply correct. `needs_attention` is retired — no current code path
produces it. `heal-legacy-sync.ts` migrates any pre-ledger rows still
carrying it (one-shot per user, audit-marker guarded, run from the hourly
cron): dates that already agree are healed to `synced`, real gaps become a
fresh open intent for the reconciler to act on next.

## The intent ledger

`sync_intents` (`sync-intents.ts`) is an append-only record of every
date-changing action the app itself took — moves, studio pushes/retires,
removals, restores — keyed by `(userId, targetId, kind)`. Recording a new
intent supersedes (never deletes) any prior open one for the same key via
`supersededBy`; `resolveIntent` marks one done once COROS confirms it. Two
read paths matter:

- `openIntentFor` / `openMoveIntents` — the single open intent per workout
  that `reconcileWorkout` and `emitPendingWork` (`jobs.ts`) reason about.
  `emitPendingWork` runs after every move, import, and writes-enabled toggle,
  so intents queued while writing was unavailable heal the moment it isn't.
- `appRequestedDates` — every date the app has ever asked a workout to move
  to (open or resolved), keyed by COROS wire id. The Plan Studio drift check
  uses this to recognize its own moves as `app_moved` rather than misreading
  them as a user editing COROS directly (see "Plan Studio adoption" below).

Despite being named above, Plan Studio pushes/retires do not actually write
intents — push rows (`studio_plan_pushes`) plus `appRequestedDates` already
cover studio drift end to end, so `studio_push`/`studio_retire` in
`IntentSource` are reserved, not currently produced by any code path.

## Last-edit-wins policy + undo notes

One sentence covers the whole conflict policy: **the app's last edit always
wins over a stale COROS read, and every override leaves a note the user can
undo.** Two places apply it:

- **Import time** — `reconcileWorkout`'s `app_wins` action, above.
- **Write-verification time** — `applyJobResult` (`jobs.ts`), when a COROS
  write comes back `upstream_changed`/`verification_failed` and an open
  intent still exists: the job is re-derived against the newly observed
  origin (retried up to `maxAttempts`) and a `kept_local_change` note is
  posted. Only once the intent has no attempts left does the job go `failed`
  and the workout's `corosSyncState` become `sync_issue` — a terminal write
  failure the user can retry, replacing the old open-ended `needs_attention`.

Notes (`sync_notes` / `sync-notes.ts`) are the user-facing residue of
every override: `kept_local_change` (app won a conflict), `adopted_coros_change`
(COROS won, no intent existed), `adopted_coros_edit` / `adopted_coros_removal`
(Plan Studio adoption, below). Each expires after **7 days**, or sooner if
dismissed, or explicitly reversed via `POST /api/sync/notes/:id/undo` for the
two adoption kinds. Rendered by the one `SyncNotesStack` mounted alongside
`SyncStatusLine` on Garden/Plan/Today.

## Derived status vocabulary

Two independent five-value states, both computed fresh on every request
rather than trusted from a stored column. `devicePresence`
(`sync-status.ts`) is the single liveness function both read from —
`registered`/`online`/`paused`/`writeCapable`, honoring `bridgePaused` and
`revokedAt`; online means seen within **3 minutes**.

**Account-wide line** — `SyncStatusState` (`computeSyncStatus`), the one
sentence `SyncStatusLine` renders on Garden/Plan/Today:

| State | Line |
|---|---|
| `in_sync` | "Calendar, COROS and watch in sync · 2m ago" |
| `syncing` | "Syncing N changes…" |
| `waiting_for_mac` | "N changes waiting — wake your Mac…" (or "Sync is paused" if the bridge is paused) |
| `not_synced` | writes off in Settings, or no Mac paired |
| `sync_issue` | "N changes couldn't sync" — the line offers Retry, which calls `read_now` |

**Per-workout** — `CorosSyncState` (`packages/domain/src/states.ts`), computed
per row by `deriveWorkoutSync` and exposed as `WorkoutDto.corosSyncView` (kept
distinct from the stored, backward-compatible `corosSyncState` column, which
UI no longer reads):

| State | Label | Meaning |
|---|---|---|
| `synced` | **Synced** | COROS agrees with Run Garden's intended date |
| `syncing` | **Syncing** | A write job is queued/claimed and a bridge device is online |
| `waiting_for_device` | **Waiting for Mac** | A write job is queued but no bridge device is online |
| `calendar_only` | **Not synced to COROS** | Writing unavailable (no capable device, or writes disabled) — or an `app_wins` override was just re-queued and hasn't landed yet |
| `sync_issue` | **Sync issue** | The last write to COROS failed terminally (retries exhausted); retryable |

`needs_attention` remains in the type for backward compatibility but is a
dead letter — see "Reconciliation core" above. Time-of-day-only changes never
leave `synced`: COROS has no time-of-day, so there is nothing to write
(`jobs.ts: applyMove`). Races cannot be moved at all.

### Watch-sync truthfulness

There is no server-side push to the watch and no way to verify watch delivery
(`verifyWatchSync` is always `false`). After a verified write the product says
**"COROS calendar updated · Open COROS to sync your watch"** — never "Updated
on watch". Calendar changes reach the watch when the COROS phone app next
syncs. See [COROS_WRITE_PROTOCOL.md](COROS_WRITE_PROTOCOL.md).

### Freshness: `read_now` and adaptive polling

`POST /api/sync/read-now` (`apps/worker/src/routes/sync.ts`) lets the UI ask
for a fresh COROS read on demand — the Retry button on a `sync_issue` line,
or "Sync now" in Settings. Gated to avoid hammering COROS: a no-op
(`enqueued: false`) if the last successful read is under **5 minutes** old,
or a `read_now` job is already in flight. Otherwise it queues a `read_now`
job kind — `jobs.ts` treats it as workout-less (self-referencing
`workoutId`, the same trick the studio job kinds use) and `applyJobResult`
just marks it `verified`/`failed`.

The desktop bridge executes it via `pushSnapshot()`, the same path an
ordinary poll cycle uses, then reports back through the normal job-result
flow. The bridge's own poll loop is adaptive
(`services/coros-bridge/src/cloud-sync.ts`): every claim response carries
`pendingCount`, and the next poll is scheduled **10s** later while jobs
remain queued, falling back to the idle **45s** cadence once the queue
drains — so a `read_now` (or any other queued work) is picked up promptly
without polling fast forever.

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

## Plan Studio adoption

Before planning any push, `detectDrift` (`studio-push.ts`) compares
each `verified` push row against the latest COROS snapshot and classifies any
mismatch:

| Finding | Meaning | Effect |
|---|---|---|
| `app_moved` | Row's day differs from `happenDay`, but `appRequestedDates` shows the app itself asked for that day | Not drift — `corosHappenDay` is updated so a future delete targets the right day; the row stays managed |
| `moved` | Row's day differs and the app never asked for it | Genuine external edit → **adopted** |
| `renamed` | Title differs from what the studio pushed | Genuine external edit → **adopted** |
| `missing` | Snapshot confirms the workout archived with `archiveReason: absence_confirmed` | Genuine external edit → **adopted** |

**Adopted** (`status: "adopted"`) means the row is skipped by the next push
(counted in `blocked`, never silently overwritten) and an
`adopted_coros_edit` / `adopted_coros_removal` note offers undo. Both that
note's undo action and the studio's own per-row button call
`undoStudioAdoption`, which re-examines the source workout's last snapshot
and picks one of three repairs:

- **MISSING** — nothing addressable to delete; force a plain recreate.
- **MOVED** — still there, still stamped ours; stale the fingerprint so the
  next push deletes it at its real day and recreates at the plan's day.
- **RENAMED** — refused outright, `409 undo_unsupported_rename`. A renamed
  workout no longer carries the studio's ownership stamp, so nothing can
  prove a delete of it is the studio's to make — refusing is safer than
  risking a delete of a workout the user renamed on purpose. If the user
  later deletes the renamed copy on COROS themselves, that confirms absence
  and undo becomes the (permitted) MISSING recreate path.

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
