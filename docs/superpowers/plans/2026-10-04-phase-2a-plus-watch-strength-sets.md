# Phase 2a+ — Watch Strength Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every strength session done on the COROS watch lands in Run Garden as logged sets (reps and weight per set), visible in Activity and on lift progression cards.

**Architecture:** A masked probe settles the wire scale; the COROS activity ingest derives a `watch` performed session + sets from `lapItemList`; DTOs and plan progressions read them.

**Tech Stack:** Hono/D1/Drizzle, vitest + better-sqlite3, React.

**Spec:** `docs/superpowers/specs/2026-10-04-phase-2a-plus-watch-strength-sets-design.md`.

## Global Constraints

- No COROS writes. Reads only through the existing ingest.
- Performed rows: `source = 'watch'`, `source_ref = <activity id>`; idempotent; refresh replaces sets; app-merged activities never get a `watch` session.
- Weights stored in kg as reported, converted from the wire scale pinned by Task 1; displayed in the athlete's weight unit.
- Exercise names humanized once at the DTO boundary (`COROS_EXERCISE_NAMES`), never per surface.
- Node 21 for tests; gates `pnpm -r typecheck`, `pnpm test`, `pnpm build:web`.

## Review Focus

1. **A strength activity with rest laps, zero-rep laps, or bodyweight sets (weight 0)** — rest skipped; zero reps kept only if a duration exists; weight 0 = bodyweight (load null).
2. **The same activity re-ingested after an edit on COROS** — sets replaced, ids stable for the session.
3. **An app session merged with the watch activity** — no duplicate sets.
4. **A COROS exercise with no library mapping** — stored as `coros:<originId>` and displayed by its humanized COROS name.
5. **Mixed units on the watch** — conversion from the wire scale is exact to 0.01 kg.

---

### Task 1: Masked scale probe

- [ ] Add `GET /api/coros/debug/strength-set-stats?days=60` (requireUser): counts only (lap items, reps>0, weight>0, magnitude buckets of weight, share where weight and intensityValue agree in scale). Test that no raw value appears. Commit; deploy with the next batch; run once from the owner's browser; record the finding in `docs/reports/2026-10-04-coros-spikes.md` §1.

### Task 2: Ingest watch sets

- [ ] `services/watch-sets.ts`: `deriveWatchSession(detail, activityId, userId) → {session, sets}` (pure) + `upsertWatchSession(db, …)`; called from the COROS activity detail ingest path; tests per Review Focus 1–5 with synthetic fixtures in the real skeleton shape. Commit.

### Task 3: Activity feed and lift progressions

- [ ] Activity DTO: attach performed sets (any source) to the activity row; the feed's inline expansion lists them grouped by exercise (per mocks §8). `plan-progressions.ts` `liftProgressions` fills `actual` per week from logged top sets. Tests; screenshot matrix for the feed row. Commit.

## Self-Review

- Spec §2 items 1–5 → Tasks 1, 2, 2, 3, 2 (history: performed sessions already feed the engine).
