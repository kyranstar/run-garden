# Phase 2b — Player, Review, Outbox and Offline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Do a built session in the app — full-screen player, review, save — on the computer and the phone, surviving airplane mode, a reload and a killed tab mid-session, with the result saved exactly once.

**Architecture:** An IndexedDB wrapper (`builds`, `live`, `outbox`) in `@rg/ui/offline`; the `@rg/session-engine` recorder running in the browser against the build payload's exercise slice; a full-screen route outside the tab shell; an idempotent `PUT /api/sessions/performed/:id` that writes the performed session, sets, checks, an `app` activity, the slot match, review changes and a garden resim.

**Tech Stack:** React, TanStack Query v5, IndexedDB (no dependency), vite-plugin-pwa/workbox, Hono/D1, vitest (+ `fake-indexeddb` dev dependency), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-2-adaptive-program-design.md` §2b. Mocks §4–5: https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z.

## Global Constraints

- Prerequisites: Phase 2a merged into this branch (build/start API, `SessionResponse`, `BuildPayload`), Phase 1 recorder with the audit fixes (canonical ids; alternatives valid after a swap).
- Timers are wall-clock anchored (`Date.now()` at start + elapsed); never count ticks.
- The player never fetches its build from the network after Start; it reads IndexedDB.
- `performedId` is a client-generated UUID (`crypto.randomUUID()`), created at Start and stored in `live`.
- Server save is idempotent by `performedId` + `payloadHash` (sha256 of canonical JSON of the payload).
- UI rules as 2a (tiers, 44 px floor, plain labels, no captions); the player route renders no tab bar.
- Tests on Node 21; Playwright offline tests use `context.setOffline(true)`.

## Carried in from the 2a and 2a+ reviews (2026-10-07)

Each lands in the task named; the ledger (`.superpowers/sdd/2026-09-30-phase-2b-player-review-offline/progress.md`)
records the rulings.

- **Start needs the network; everything after Start works offline** (ruling 2b-R1). A preview built the day before is
  never started from IndexedDB; the sheet builds the day's session and Start locks it on the server. Task 4.
- **The stored build carries its place** (`view.location` gains `equipment` and `implements`, which the recorder and
  the ± weight steppers need offline; audit 2a-build M9). Task 2 (the payload the player stores).
- **The app's save is the authority over a watch copy** (audits 2a+ M-4 and open question 5): the save deletes any
  `watch` performed session linked to the same activity, and `upsertWatchSession` already yields to a linked app
  session, so the app session is the durable merge marker. `performed_sessions` is written before its sets. Task 6.
- **A GET that says whether the stored build is still current**, so opening the sheet stops POSTing a build every
  time (Tasks 6–8 report). Task 6.
- **Program-screen leftovers** from the 2a UI re-review: U1 (the when-line reading under 44 px), U2 (ruling 2a-R13
  with two app sessions on one day), U3 (a started session shows the reading it was built with), U4/U5 (a stored
  build adopted by Start writes the row's content; the sheet refreshes Today and Plan after an adoption), U6 (a
  skipped session heading the card drops the to-do furniture), U7 (keyboard on the scale and pre-check), U8 (tests
  that pin their claims). Task 7.
- **Gate before `features.player` flips in production**: one real build request's CPU read from the Workers
  dashboard (ruling 2a-R8; the bench says cache-miss p50 ≈ 5.9 ms, p95 ≈ 9.7 ms against 10 ms), and a real
  `session_builds` insert proving D1 takes a ~130 KB bound payload. Both need a program in production, which is a
  production data change: ask the owner first. Ship checklist, after Task 8.

## Review Focus

1. **The phone locks mid-hold and unlocks 2 minutes later** — the hold is judged by the half-time rule on resume and the timer shows the true remaining time (or has advanced). Task 4.
2. **Save pressed offline, then the app killed, then reopened online** — the outbox drains once; exactly one performed session, one activity, one match. Tasks 2, 6.
3. **The same session saved twice with different edits (two tabs)** — the second is refused `409 conflict`, surfaced in Settings → Data, never silently overwrites. Task 6.
4. **A swap offered offline after an earlier swap** — the alternative applies exactly as offered. Task 5.
5. **A session abandoned after two steps** — Review offers Save (partial, `completed: false`) or Discard; Discard leaves the slot built, not done. Task 7.

---

### Task 1: Offline spike (a report, not kept code)

**Files:** report `docs/reports/2026-09-30-offline-spike.md`; throwaway code under the scratchpad only.

- [ ] On desktop Chrome and on an iPhone PWA (the owner's device is needed for the iPhone half; do the desktop half and document the steps for the owner), prove: IndexedDB survives a relaunch; the service worker serves the shell and `/api/auth/me` offline; `navigator.wakeLock` works; audio unlocked by a tap keeps chiming for 30 minutes with the screen on. Record results; if anything fails, amend spec §2b before Task 2.
- [ ] Commit the report: `docs(report): offline spike — IndexedDB, service worker, wake lock, audio`.

### Task 2: IndexedDB wrapper and the outbox

**Files:** create `packages/ui/src/offline/idb.ts` (open/get/put/delete/all over `rg-offline`, versioned upgrade), `packages/ui/src/offline/outbox.ts` (`enqueue(save)`, `drain(api)`, backoff 1 s/5 s/30 s, triggers on start/online/visible), `packages/ui/src/offline/builds.ts`, `packages/ui/src/offline/live.ts`; tests `packages/ui/test/offline/*.test.ts` with `fake-indexeddb`.

- [ ] Failing tests: put/get round-trip across a "reopen"; outbox drains in order, removes on 2xx and on `409 same_payload`, keeps and flags on `409 conflict`, backs off on network error; two concurrent drains never double-send (a drain lock in IndexedDB with a timeout).
- [ ] Implement; gates; commit `feat(offline): IndexedDB builds, live sessions and an outbox that syncs once`.

### Task 3: Service worker and the offline shell

**Files:** modify `apps/web/vite.config.ts` (add `/api/auth/me` to the NetworkFirst read cache with a 3 s timeout), `packages/ui/src/app.tsx` (an offline `me` falls back to the cached response instead of the "Couldn't reach" screen when a live session exists in IndexedDB).

- [ ] Failing test (Playwright, fixture stack): with a live session in IndexedDB, reload with the network off → the player route renders. Implement; gates; commit `feat(pwa): the app opens offline when a session is in progress`.

### Task 4: The player

**Files:** create `packages/ui/src/screens/player.tsx`, `packages/ui/src/player/{timer.ts,audio.ts,wake.ts,keys.ts}`; route `/session/:workoutId` in `app.tsx` outside `AuthedApp`'s shell (auth wrapper like `OnboardingRoute`); tests `packages/ui/test/player/*.test.tsx`.

Per mocks §4 and spec §2b: timed (get-ready 8 s, 3 s in flows/circuits, countdown ring, chime, auto-advance setting), set (big target, Done → log card with steppers accepting `25`, `25 lb`, `12kg` via `parseWeight`, flag toggle, Confirm → rest), rest (+15 s, Skip, next up), progress bar and "N of M", ✕ (confirm leave; session kept), ⇄ (alternatives from the payload), ⓘ (how-to from the payload slice). Keyboard: Space = primary action only when no control has focus; Enter confirms the log; Esc closes a panel and resumes; ←/→ step; S swap; I how-to; ? shows the key list. Wake lock while playing; audio unlocked by Start; the new-move how-to pauses a running countdown.

- [ ] Failing tests per step kind, keyboard focus rules, Review Focus 1 (fake timers: lock for 120 s mid-hold → on resume the hold is judged by the half-time rule; the remaining time is correct), the log card parsing, leave/resume.
- [ ] Implement; screenshot matrix (360/390/768/1280/1440 × light/dark), zero overflow, tap-target hit tests on every control.
- [ ] Gates; commit `feat(ui): the session player — holds, sets, rests, logging, swaps and how-to`.

### Task 5: Mid-session swap offline

**Files:** `packages/ui/src/player/swap.ts` using `@rg/session-engine` `rebase` and the payload's alternatives (and the post-swap alternatives function from the Phase 1 fix round).

- [ ] Failing test (Review Focus 4): swap slot A, then swap slot B from the recomputed alternatives, all offline → each offered alternative is what the rebuilt steps contain. Implement; gates; commit `feat(ui): swaps mid-session, offline`.

### Task 6: Save — the server

**Files:** create `apps/worker/src/services/session-save.ts`; route `PUT /api/sessions/performed/:id` in `routes/sessions.ts`; api-client `savePerformed`; tests `apps/worker/test/session-save.test.ts`.

Spec §2b steps 1–6 exactly: idempotency (same hash → `200 same_payload`; different → `409 conflict`); performed_sessions + sets (weights as typed + kg) + checks; an `activities` row `id = performedId`, `source = 'app'`, sport per programme spec §9.2, local start from the user's timezone, plus a source link `provider = 'app'`; the slot match `app_session` (refuse if the slot already has an active match: save still succeeds, match skipped, reported); slot → completed, `resolution_date`, `content_state = 'done'`; pending review changes → `exercise_prefs`, graduations → `program_blocks`; `resimulateFrom(local_date)`.

**Carried from Phase 0 Audit 1 (load-bearing):** when the COROS ingest adopts an `app` activity (the watch+app merge), COROS supplies HR, duration and load, but the row keeps the app session's `title` and its sport/discipline (a mobility session the watch filed as Strength stays yoga), and the later COROS refresh path must not overwrite them. Test: app yoga session saved, watch Strength activity ingested twice → one activity, app title, yoga sport, watch HR.

- [ ] Failing tests: each step; the carried merge rule above; Review Focus 2 (drain twice → one of everything) and 3 (conflict); a save for a slot of another user → 404; the activity is excluded from COROS adoption only if `source='import'` (an `app` row IS adoptable — the merge); the garden credits the right axis for a strength vs a mobility session (after the 2d epoch gate lands, gate this assertion on the epoch).
- [ ] Implement; gates; commit `feat(sessions): save a performed session exactly once — sets, checks, activity, match, garden`.

### Task 7: Review and the Today card after save

**Files:** create `packages/ui/src/screens/review.tsx`; modify the Today card (2a) for `done` and "Saved · will sync"; Settings → Data gains the "Couldn't sync one session" row (Retry / Discard) for outbox conflicts; tests `packages/ui/test/review.test.tsx`.

Per mocks §5: post-check grid, per-exercise done sets (editable with the same steppers), 👍 / 👎 / not-for-me, graduation offers (Switch / Not yet), records from `records.forSession` (engine), note, Save; Discard. Nothing persists before Save (engine pending change set).

- [ ] Failing tests incl. Review Focus 5; implement; screenshot matrix; gates; commit `feat(ui): the review — post-check, sets, ratings, graduations, records`.

### Task 8: End-to-end offline journeys

**Files:** `apps/web/e2e/session-offline.spec.ts` (both Playwright projects).

- [ ] Journeys: (a) build → start → play every step → review → save online; (b) network off after Start → play → save → "Saved · will sync" → network on → exactly one performed session, activity and match (assert via API); (c) reload mid-session offline → resumes on the same step; (d) close the page mid-session and reopen → resumes; (e) save offline, close, reopen online → drains once.
- [ ] Gates + e2e green locally; commit `test(e2e): the session journeys online, offline, reloaded and reopened`.

## Self-Review

- Spec §2b coverage: spike (1), storage + outbox (2), service worker (3), player behaviour contract (4), offline swap (5), save server steps 1–6 (6), review + save UX (7), network-off/reload/kill tests (8).
- Review Focus → tests: 1 in Task 4, 2 in Tasks 6 and 8, 3 in Tasks 2 and 6, 4 in Task 5, 5 in Task 7.
- `features.player` flips to `true` in Task 7's commit (Start and program creation become visible).
