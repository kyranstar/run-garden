# Phase 2 — the adaptive program end to end, on the computer and the phone

Date: 2026-09-30
Status: design for Phase 2 of `2026-09-30-one-workout-system-design.md` (the programme spec, the authority). UI
follows the mocks published for the owner's review (private artifact
https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z); where a mock and this text disagree, the mock wins for layout
and copy, this text wins for behaviour.

Phase 2 ships in four slices. Each lands on `main` separately, dark until its data exists: nothing new renders for
an account with no program, so 2a can ship before 2b without a half-feature showing.

## 2a — Programs, slots and builds

### Programs API

| Route | Behaviour |
|---|---|
| `GET /api/programs` | The user's programs (adaptive now), each with config, status, current block summary (`number`, `week`, `weeks`, core lifts by family with names) and this week's slot count vs goal. |
| `POST /api/programs` | Create an adaptive program `{name, config}` (config validated by `adaptiveConfigSchema`); places slots; returns the program. |
| `PATCH /api/programs/:id` | Update `name`, `config`, `status` (`active`/`retired`); re-places future outline slots (below). |

### Slot placement (`services/program-slots.ts`)

`placeSlots(db, userId, programId, today, prefs)` — idempotent:

- For each ISO week from this week to `placementWeeksAhead` weeks ahead, count this program's slots **by
  `originalPlanDate` week**, including skipped, completed, moved and user-removed rows — so a slot the athlete
  moved, skipped or removed is never re-placed. Rows archived by re-placement (`program_replaced`) do **not** count:
  a dropped day or a raised goal must be able to refill, and a day wanted again revives that same row (and drops its
  suppression) rather than inserting a new one.
- Missing slots go on `preferredDays` in order, then the week's remaining days Monday→Sunday, skipping dates before
  today and dates that already hold a slot of this program.
- Row: `id = slot-<programId>-<date>`, `plan_id = programId`, `source_workout_id = id`, `title = program.name`,
  `category`/`sport` from the program's default discipline (`yoga` unless the config says strength),
  `original_plan_date = effective_date = date`, `last_verified_coros_date = ''`, `effective_time = windowTimeFor`,
  `calendar_block_duration_seconds = fallback_estimated_duration_seconds = defaultMinutes × 60`,
  `source_content_fingerprint = 'program'`, `coros_sync_state = 'calendar_only'`, `completion_state = 'scheduled'`,
  `origin = 'program'`, `content_state = 'outline'`. Then `separateDayCollisions` over the placed dates.
- Re-placement after an edit: future **outline** slots that are unmoved (`effective_date = original_plan_date`) and
  no longer wanted (goal lowered, day dropped) are archived with `archive_reason = 'program_replaced'` and a
  `user_removed` suppression via `removeFromPlan`'s suppression path; then `placeSlots` fills the new pattern.
- Runs on program create/edit and in the hourly cron for every active adaptive program.

### Build API (`services/session-build.ts`, `routes/sessions.ts`)

| Route | Behaviour |
|---|---|
| `GET /api/sessions/:workoutId` | The slot, its latest build (or none), today's recorded checks, and whether it is locked. |
| `POST /api/sessions/:workoutId/build` | `{checks?, overrides?, swaps?}` → build or return the stored build when the inputs hash is unchanged. |
| `POST /api/sessions/:workoutId/start` | `{buildId}` → lock that build (`content_state = 'started'`, `session_builds.locked_at`) while it is still the day's latest and the day's inputs still hash to it; otherwise `409 {error:"stale", session}` with the fresh build, nothing locked (audit 2a I3). Idempotent for a started or done slot. |
| `POST /api/conditions/checks` | Record a daily check `{profileId, value, feelingOff}` (the Today chip). |

Build rules:

- Only rows with `origin` `program` or `on_demand`, live, for this user. `effective_date > today` → a preview build
  (returned, stored with `version = 0`, overwritten by the next preview, never lockable). `effective_date < today`
  → `409 {error:"not_today"}` (the sheet offers "Move to today" — the existing move verb).
- A started/done row returns its locked build and `409 {error:"locked"}` for any change.
- Checks in the body are recorded as `pre` checks for this workout and date (one per profile, replaced on re-check).
  The slot's reading is the latest answer of its own pre-check and a daily check recorded today for the same profile
  (the Today chip and the pre-check are one reading, ruling 2a-R13). A check with no number and no "feeling off" is no answer: it records nothing and clears the slot's own (audit 2a I2).
- The program's `modes` bind the build (ruling 2a-R7), except a recovery proposed by a condition profile's own
  recovery rule or "feeling off", which stands (ruling 2a-R10).
- Inputs: history = every `performed_sessions` row of the user (all sources) mapped to `HistorySession` with its
  sets and checks; program state = the program's latest `program_blocks` row; prefs = `exercise_prefs`;
  `savedIds` = `exercise_provenance.exercise_id`; location = the override or the program's default `locations` row;
  unit = `prefs.weightUnit`; profiles = active `user_conditions`, care = `config.careProfiles ∩ active`.
- Output persisted: a new `session_builds` version; block changes (start / rotation / graduation) written to
  `program_blocks`; the row's `title` (`<program name> · <theme>`), `category`/`sport` (§9.2 of the programme spec),
  `calendar_block_duration_seconds` and `fallback_estimated_duration_seconds` (planned seconds rounded up to 5 min),
  `content_state = 'built'`, `session_params = {checks, overrides, swaps}`.
- Response: `{ build, view: { mode, proposedMode, modeReasons, theme, proposedTheme, themeReasons, minutes,
  location, block: {number, week, weeks, core, events}, newMove } }`.

**CPU budget.** Workers on the free plan allow 10 ms of CPU per request. A Node benchmark test builds a session
over a 200-session synthetic history and asserts p50 < 5 ms after warm-up; alternatives are computed in the same
pass as the build (never one build per slot). If the budget cannot be met, the fallback is recorded in this spec
before 2a merges: builds cached by inputs hash are already free; the next lever is computing alternatives lazily
per slot on first swap.

### Today and Plan DTOs

- `GET /api/plan/today` gains `todaySessions`: every live row dated today (not only the next), each with `origin`,
  `contentState`, and for program rows `{mode, theme, minutes}` from the latest build. The Today card renders from
  it (below). `nextWorkout` keeps its meaning for existing surfaces.
- The workout DTO gains `origin`, `contentState`, `programId`.
- `GET /api/plan/week` returns program slots like any row (they are planned workouts).

### UI (per mocks)

- **Today card:** today's sessions as lines inside the one card, the primary (first by time) with the existing
  controls; a program session reads "Jaw care · Consistent · 30 min" with **Start** (or **Continue** when started,
  **Done** when saved). The condition chip ("Jaw 2") sits beside the readiness chip and opens the check sheet.
- **Session sheet** (the workout sheet for program rows, reached from Today and Plan): the pre-check row first when
  unanswered; then mode · theme · time · place as chips (tap to override); the exercise list grouped by block with
  the dose target and format marker; each row opens how-to, and ⇄ offers the payload's alternatives; **Start** at the
  bottom. Reasons appear as one line under the mode chip (data, not captions).
- **Plan:** a program card (name, this week's count vs goal, block N week W of 5, the core lifts); slots in the week
  view.

## 2b — Player, review, the outbox and offline

### Spike first

A one-day spike proves, on a real phone PWA (iOS Safari standalone) and desktop Chrome, that: IndexedDB survives a
relaunch; the service worker serves the shell and `/api/auth/me` offline; `navigator.wakeLock` works on the phone;
audio unlocked by a tap keeps playing chimes for 30 minutes with the screen on. Findings go in
`docs/reports/2026-10-07-offline-spike.md`; anything that fails changes this section before the slice starts.

### Client storage (`packages/ui/src/offline/`)

A ~150-line IndexedDB wrapper (no dependency), database `rg-offline`, stores:

- `builds` — `workoutId → { build, view, savedAt }`, written whenever a session sheet or player loads a build.
- `live` — `workoutId → recorder state + current step index + timer anchor (epoch ms) + paused flag`, written on
  every state change (debounced 250 ms, flushed on `visibilitychange`/`pagehide`).
- `outbox` — `performedId → { payload, payloadHash, attempts, lastError, createdAt }`.

The outbox drains on app start, `online`, and `visibilitychange → visible`: `PUT /api/sessions/performed/:id`; 2xx or
`409 same_payload` removes the entry; `409 conflict` keeps it and surfaces a quiet "Couldn't sync one session" row in
Settings → Data with Retry and Discard; network errors back off (1 s, 5 s, 30 s, then on the next trigger).

### Service worker

The shell is precached (as today). `/api/auth/me` joins the NetworkFirst read cache so an offline launch reaches the
app; the player reads its build from IndexedDB, never from the network, once started.

### Player (`/session/:workoutId`, outside the tab shell)

Per mocks. Behaviour contract:

- Steps come from the locked build. The recorder (`@rg/session-engine` `recorder`) runs in the browser against the
  payload's exercise slice (never the whole library).
- Timed steps: an 8 s get-ready (3 s chime inside flows/circuits), countdown, chime, auto-advance (setting). Sets:
  self-paced, Done opens the log card prefilled from the target; the steppers accept `25`, `25 lb`, `12kg` through
  `parseWeight`; confirm starts the rest. Rests: countdown with +15 s and Skip.
- Timers are anchored to wall-clock (`Date.now()` at start + elapsed), so a backgrounded tab or a relaunch resumes
  with the right remaining time, and a hold interrupted by a relaunch is judged by the half-time rule on resume.
- Mid-session swap from `build.alternatives[slotKey]`, applied with `recorder.rebase`.
- The profile's set flag ("Clenched") is a toggle on the log card.
- Keyboard (desktop): Space = primary action only when no button has focus; Enter = confirm log; Esc closes a panel
  and resumes the timer; ←/→ previous/next step. The new-move how-to pauses a running countdown.
- Wake lock while playing; audio unlocked by Start.

### Review and save

Post-check (0–10, per active profile), each exercise's done sets (editable), 👍 / 👎 / not-for-me, graduation
offers, records from `records.forSession`, a note, **Save**. Save builds the `performedSessionSaveSchema` payload,
writes it to the outbox, clears `live`, and returns to Today ("Saved" or "Saved · will sync").

`PUT /api/sessions/performed/:id` (server, `services/session-save.ts`):

1. Validate; same id + same `payloadHash` → `200 {status:"same_payload"}`; same id + different hash → `409 conflict`.
2. Insert `performed_sessions`, `performed_sets`, `condition_checks` (post, and pre if not already recorded).
3. Insert an `activities` row: `id = performedId`, `source = 'app'`, sport from the build (§9.2), `start_time` =
   `startedAt` (UTC) and `start_time_local` from the user's timezone, `duration_seconds = seconds`, title = the row's
   title; plus an `activity_source_links` row `provider = 'app'`.
4. Match to the slot (`method = 'app_session'`, confidence 1) when `workoutId` is present and the slot has no active
   match; slot → `completed`, `resolution_date = local_date`, `content_state = 'done'`.
5. Apply the pending review changes: ratings/excluded/introduced → `exercise_prefs`; accepted graduations →
   `program_blocks`.
6. `resimulateFrom(local_date)`.

An unplanned app session (on-demand without a slot is impossible — on-demand always has a row) is not a case.

## 2c — Library, settings and imports

### Library API

- `GET /api/library?q=&pattern=&region=&role=&equipment=&location=&safe=` → slim rows (id, name, family, patterns,
  regions, roles, equipment, difficulty, condition safety per active profile, rating, excluded, pinned, saved,
  unlocks-with).
- `GET /api/library/:id` → the full record (how-to text, dose, condition notes for active profiles, easier/harder
  links, provenance link when saved) plus the user's history for it (last 5 entries, best).
- `PUT /api/library/:id/prefs` `{rating?, excluded?, pinned?}`.
- The library payload never includes `providers` internals.

### Settings sections (per mocks)

- **Health conditions:** each profile with an on/off switch; on writes `user_conditions` (active, since).
- **Places & equipment:** locations list; each with equipment toggles and implement weights typed as a list
  (`10, 15, 20 lb`, parsed by `parseWeightList`, stored as typed); a default place; the wishlist with "unlocks N moves"
  counts.
- **Units:** the existing distance/temperature units plus **Weights: lb / kg**.
- **Programs:** reached from the Plan program card (weekly goal, preferred days, minutes, place, block length,
  modes, condition care).
- **Import:** "Import from the standalone tool…" accepts the backup file; a summary sheet lists what will be
  imported (session count, first and last date, locations, block) and what the garden will do ("History stays out of
  the garden"), then Import.

### Standalone import (`services/standalone-import.ts`, `POST /api/import/standalone`)

- zod-validated backup (`app: "tmj_tool"`, `version: 2`), both session versions accepted; invalid sessions are
  reported and skipped, never half-imported.
- Normalisation to `HistorySession` (Phase 1 spec §4.3): v1 `plan.phase === "flare"` → recovery; `bilateral` →
  `perSide`; `clenched` → `flags: ["clenched"]`; legacy ids through `legacyIds`; `pre`/`post` → TMJ checks.
- Writes, idempotent by `(user, source='import', source_ref = session id)`: `performed_sessions`, `performed_sets`
  (weights as typed + kg), `condition_checks`, an `activities` row (`source = 'import'`, sport per §9.2, no match).
- First import only (never overwrites later local edits): the adaptive program (named after the cared-for
  profile's care label, "Jaw care", renamable;
  config from backup settings: weekly goal, block weeks, default minutes, default location), its current block
  (`program_blocks` from `block`), `locations` (from `locations`, implement weights as typed), `exercise_prefs`
  (ratings, excluded, pinned, introduced), `user_conditions` TMJ active since the first session date, `weightUnit`
  from `settings.unit`, `equipmentWishlist` from `wishlist`.
- Response: counts plus **oracle numbers** the owner compares with the standalone Progress tab: session count,
  sessions per week (last 8), weekly volume (last 8 weeks, per-side ×2), best set per core lift, records count,
  pre/post pairs count, block number and week.

### Provenance import

`apps/worker/scripts/build-provenance.mjs` (committed; reads paths given on the command line, never hard-coded)
reads the standalone library's `sources` (`key`, `url`, `creator` per exercise id) and writes a provenance file
**outside the repo**. Settings → Import accepts it (`format: "rg-provenance"`) and upserts `exercise_provenance` by
`(user, source_type, source_key)`. The owner runs the script locally and deletes the file after importing.

### Library growth from saves

A curation pass over the private saves catalogue (strength, mobility, posture, general fitness; flagged-for-review
items excluded) produces a shortlist the owner can review (names, proposed tags, TMJ ratings, one-line reasons —
published as a private artifact, never committed). Accepted moves become library records written in the library's
own words (public), and their provenance joins the provenance file (private). Rules: the standalone tool's import
rules (skip impact, max effort, heavy bracing, loaded overhead, hard jaw/neck pressure, gear outside the vocabulary,
near-duplicates — link the save to the existing record instead).

## 2d — Progress, Activity and the garden

- **Garden:** `buildDayInput` excludes `activities.source = 'import'` at all three activity read sites (unplanned
  sessions, adventures, dew) and excludes `source = 'app'` rows dated before `APP_SESSION_EPOCH` (the 2d ship date,
  a constant beside `DEW_EPOCH`). App sessions credit through the completed-slot path. A test proves an imported
  history leaves the garden byte-identical and a post-epoch app session credits the right axis.
- **Activity feed:** app sessions render like other activities; the inline expansion shows the logged sets
  (grouped by exercise, weights as typed) and the check values ("Jaw 3 → 1").
- **Progress** (Activity page, per mocks): a condition tile (pre vs post over 8 weeks; flare days;
  `insufficient_data` below 4 paired sessions); weekly strength volume; lift tiles for the block's core lifts from
  logs; consistency across all programs uses the existing consistency metric (slots are planned rows).
- **The third axis label** becomes "Yoga & mobility" everywhere it is rendered (display only).

## Testing (all slices)

Every route has DB-backed tests on `makeTestDb({boundVariableCap: 100})`. The build and save paths have a golden
test: import a synthetic backup, build today's session, play it through the recorder programmatically, save, and
assert the activity, match, sets, checks, block and garden credit. The outbox has unit tests with a fake IndexedDB
(`fake-indexeddb` dev dependency) and a Playwright test with `context.setOffline(true)` mid-session, a reload
mid-session, and a closed-and-reopened page mid-session, each ending in exactly one saved session after
reconnecting. UI slices follow the §16.2 matrix (360/390/768/1280/1440, light and dark, zero overflow, tap targets,
no reflow).
