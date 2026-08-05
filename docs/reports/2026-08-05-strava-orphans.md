# Strava removal — production migration report

**Date:** 2026-08-05
**Migration:** `0007_magenta_blazing_skull.sql`, applied to `run-garden-db` (remote) by
the Deploy workflow, run `30970748481`.

## Verified in production after the migration

| Check | Result |
|---|---|
| `activities.strava_activity_id` | dropped |
| `activities.summary_polyline` | dropped |
| `activities.coros_activity_id` | present |
| `workout_completion_matches.provisional` | dropped |
| `webhook_events` table | dropped |
| `provider_connections` where `provider='strava'` | 0 |
| `activity_source_links` where `provider='strava'` | 0 |
| `planned_workouts` still `provisionally_completed` | 0 |
| Total activities | 9 |

Nothing was deleted. The migration's only destructive statements were schema drops
and the removal of Strava's own OAuth rows and source links.

## Surviving source-less activities

Four activities carry no COROS source. These are real sessions that only ever lived
on Strava — the app never saw a COROS copy of them, most likely because they were
recorded on a phone rather than the watch. **They are kept**, and still count toward
the garden, streaks, records, and the all-sport load signals.

| Start (UTC) | Sport | Duration | Distance | Title | Completion match |
|---|---|---|---|---|---|
| 2026-05-14 22:39 | run | 19 min | 2.90 km | exploring the neighborhood | none |
| 2026-06-19 12:49 | run | 123 min | 17.98 km | Always remember that NYC is a beachtown | none |
| 2026-07-04 13:15 | run | 51 min | 8.11 km | Morning Run | none |
| 2026-07-16 11:33 | run | 60 min | 9.34 km | Morning Run | none |

None of the four holds a completion match, so nothing was at risk of being orphaned
from a planned workout.

## What the backfill will do to these

All four fall inside the backfill's range. When the deep walk runs and COROS turns
out to hold a copy of any of them, `ingestActivities` **adopts** the existing row
rather than inserting beside it — same start time within ±1h, matching sport, score
≥ 0.6 (`ORPHAN_ADOPTION_FLOOR`). The row keeps its id, so nothing downstream notices.

Where COROS has no copy, the row simply stays as it is. Either outcome is correct;
neither produces a duplicate.

## Note on scale

Production holds only 9 activities, because until now the app only ever synced the
rolling 14-day window. The COROS account itself holds **28** activities spanning
2025-12-08 → 2026-08-01 (see `coros-sport-census-2026-08-04.json`). The remaining ~19
arrive when the backfill is run from the desktop app — that is the point of it.
