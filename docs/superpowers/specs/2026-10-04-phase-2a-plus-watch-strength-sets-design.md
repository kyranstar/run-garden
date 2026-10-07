# Phase 2a+ — Logged sets from watch strength sessions

Date: 2026-10-04
Status: owner-requested pull-forward (2026-10-04) of part of Phases 3/4 of
`2026-09-30-one-workout-system-design.md`. Evidence: `docs/reports/2026-10-04-coros-spikes.md` §1.

## 1. Why

COROS strength activities carry per-set data (`lapItemList[]`: `exerciseId`, `exerciseNameKey`, `setIndex`, `sets`,
`reps`, `weight`, `targetType`, `targetValue`, `intensityValue`, `lapType`; summary `totalReps`, `totalWeight`,
`sets`, `exercises`), and the importer drops all of it. Storing it gives lift graphs and Activity the athlete's real
sets for every strength session done on the watch — including today's COROS and coach lift plans — and feeds the same
history the session engine progresses from.

## 2. Scope

1. A masked scale probe first: for the athlete's recent strength activities, report counts only — lap items, items
   with reps > 0, with weight > 0, the weight field's order-of-magnitude buckets, and whether `weight` and
   `intensityValue` agree in scale on items where both are set. This settles the wire unit (the program wire uses
   kg × 1000) before any conversion code is written. No values leave the Worker.
2. Ingest: when a COROS strength activity's detail is ingested (or refreshed), derive a performed session with
   `source = 'watch'`, `source_ref = <COROS activity id (labelId)>`, `activity_id`, `workout_id` = the matched
   planned row if any, and one `performed_sets` row per work lap item (rest items skipped): exercise id resolved to a
   library id through the reverse COROS mapping when one exists, else `coros:<exerciseNameKey>` (the COROS i18n key;
   `exerciseId` is not an identity); reps; load stored as reported (kg, converted from the wire scale) with
   `load_kg`; set index; flags `[]`. Idempotent by `(user, 'watch', source_ref)`; a refresh replaces the sets. The
   session row carries `payload_hash = 'pending'` until its sets have all landed, and every reader treats such a
   session as absent.
3. Precedence: if the activity was adopted from an app session (the app+watch merge), the app's performed session is
   the authority for sets — no `watch` performed session is created.
4. Display: the Activity feed's inline expansion shows the sets grouped by exercise (names humanized once at the DTO
   boundary), weights in the athlete's weight unit; lift progression cards fill `actual` from logged top sets per week
   for exercises matching the plan's exercises (by COROS originId — through the catalog's exercise key to
   `coros:<key>` — or library id).
5. The session engine's history includes `watch` performed sessions (all sources are history).

## 3. Not in scope

Watch writes; the quick review after a watch session (Phase 3); the garden (already counts the activity).

## 4. Testing

Fixtures shaped like the real lap skeleton (synthetic values); idempotence on re-ingest; the app-merge precedence; the
unit conversion pinned by the probe's finding; DTO and progression tests; delete-all/export cover the new rows via the
registry (no new tables).
