# Phase 3 — Program sessions on the watch

Date: 2026-09-30, updated 2026-10-08 (after the COROS spikes, Phase 2a+ and Phase 2b).
Status: design for Phase 3 of `2026-09-30-one-workout-system-design.md` (the authority; D4). The unmapped-move
strategy in §3 was chosen by the spike: **outcome A** (`docs/reports/2026-10-04-coros-spikes.md` §2). Plan:
`docs/superpowers/plans/2026-10-08-phase-3-watch.md`.

## 0. What changed since 2026-09-30

Later work changed facts this design relied on. Each item below is reflected in the sections that follow.

1. **The spike chose outcome A.** COROS kept an `originId: "0"` step with a free-text name exactly, kept a custom
   name on the generic Training step, kept a step `overview`, and kept a per-side pair. Unmapped moves go to the
   watch as `"0"` steps carrying their real names, cues in the overview. Still unknown: what the watch itself shows
   after a phone sync (the owner looks once, §8).
2. **COROS does send per-set reps and weights** (Phase 2a+, rulings 2a+-R1..R4). "COROS sends none of them" was
   wrong. Lap `weight` is kg × 1000 (grams); a weight typed in pounds arrives as the exact grams of that many pounds;
   every item appears under two `lapType` codes and only the lowest is read; items group by (`exerciseIndex`,
   `setIndex`) into work + rest pairs; `time` is 1/100 s; an exercise's identity is `exerciseNameKey` (the catalog's
   T-code), never `exerciseId`. The ingest already stores a `watch` performed session per strength activity. The quick
   review therefore **prefills from the watch's logged sets**, falling back to the locked build's targets.
3. **Identity is the T-code, and the repo has no real catalog ids.** The test catalog fixture
   (`packages/domain/test/coach-survival/catalog.ts`) carries the live T-code set with synthesized ids. Mappings key
   on the T-code; the athlete's catalog id (`originId`) is resolved from `coros_exercises` at send time.
4. **Outcome A makes a doubtful catalog match worse than none.** A wrong catalog step puts another movement's name and
   animation on the watch; a free-text step carries the right name. The computed tier is exact-name only (no fuzzy
   match, no tag veto), and only `exact` mappings are pushed.
5. **Phase 2b shipped the save, the merge and the outbox.** The app save joins a watch activity that arrived first and
   deletes its `watch` session (2b-R3); an app session supersedes automatic matches (2b-R5); a slot holds at most one
   app session (2b-R18); program/on-demand rows without a watch address never enqueue COROS jobs (2a-R4).
6. **The import echo lesson (2026-08-18).** Three times, COROS's echo of a session we wrote was read back as the
   authority and rewrote the app's copy. A sent program session's content belongs to its locked build; the import
   never rewrites it.
7. **Owner decision (2026-10-08).** Phase 3 is built behind a switch that is off. Before the first real push to the
   owner's watch the owner is asked; then the owner glances at the watch once to confirm the session shows correctly.

## 1. Scope

1. Library ↔ COROS mapping by T-code: curated for the lifts, computed (exact English name) for the rest.
2. "Send to watch" for today's built program or on-demand session: the pre-check answered, the build locks, a preview
   shows exactly what the watch will show, and a new write-job kind (`program_session_push`) pushes it through the
   existing lane.
3. A sent session's lifecycle: Start in the app as well, Discard, moves, removal, and what the import does when COROS
   reports the session moved, changed or deleted.
4. After a watch session: the COROS activity imports and matches the slot; the Today card offers a quick review,
   prefilled from the watch's logged sets, that adds the post-check and corrects sets. It saves a `watch_review`
   performed session on the watch's activity (no new activity).
5. One physical session counted once, including the app + watch merge proven live.
6. A switch, off by default, that guards every COROS write Phase 3 adds.

## 2. Mapping

- `providers.coros` on a library record: `{ key, confidence: "exact" | "close" | "generic", method: "curated" |
  "computed" }`, where `key` is the COROS catalog T-code (`"T1041"`). It replaces the unused `originId` field (no
  record carries a mapping today).
- **Curated:** records whose roles include `core` or `accessory`, mapped by hand when the COROS catalog holds the same
  movement with the same implement class. Only `exact` is pushed; `close` and `generic` stay on record for later and
  go to the watch as free text.
- **Computed:** for every other record, `computedCorosKey(record)` is the unique live T-code whose English name
  (`COROS_EXERCISE_NAMES`) normalizes (`normalizeExerciseKey`) to the record's name. Two T-codes with that name, or
  none, means no mapping. Pure and deterministic, from public data only.
- **At send:** key → the athlete's catalog id through `coros_exercises.name`. A key the athlete's catalog lacks, or
  holds twice, goes as free text.
- **At ingest (2a+):** the reverse mapping keys on the T-code (`exerciseNameKey` → library id) with no catalog read.
  New watch sets of mapped moves store the library id; older sessions keep `coros:<key>` until re-derived. Lift
  progressions claim both ids.
- A test asserts every curated key is a live T-code in the fixture and has an English name. The fixture holds T-codes
  and synthesized ids only (public, no personal data).

## 3. Unmapped moves: outcome A

| Spike result | Strategy |
|---|---|
| **A (observed)** — COROS stores a free-text name on `originId: "0"` | Unmapped moves are `originId: "0"` steps with the library name and the cue in `overview`. |
| B — the name is replaced, a generic Training step keeps `overview` | Not used. |
| C — neither survives | Not used. |

Every step, mapped or not:

- Timed windows (holds, breaths) use `targetType 2` with the seconds; sets use `targetType 3` with the reps; a set with
  neither is an open step (`targetType 0`).
- Per-side work is two steps; the build already plays them as Left and Right, and each step's overview names its side
  ("left side", "right side").
- Weights go in grams (kg × 1000, COROS's only unit); no external load is the bodyweight encoding. The preview shows
  the kg the watch shows and the athlete's unit beside it.
- The overview carries the side and the record's first focus cue, joined by " · ", at most 80 characters.
- A rest after a step goes in that step's rest fields (`restType 1`, seconds); rests before the first step are dropped.
- A free-text name is cut at a word boundary to 30 characters, so the preview stays exact if COROS has a limit.
- Each step sits in its own repeat container with `sets: 1`, and a per-side pair shares one container. This is the
  shape the spike proved live, so no untested structure reaches the watch.
- At most 200 wire steps (`MAX_WIRE_STEPS`); a longer session cannot be sent ("Too long for the watch").

## 4. Send to watch

### 4.1 When it is offered

On the session's own day, for a program or on-demand slot that is built, not done, and holds the day's current build
— the same conditions Start has (a preview of a day ahead is never sent). Every switched-on condition profile's
pre-check for the day must be answered. The account must have COROS connected with writes on
(`prefs.corosWritesEnabled`), and the switch (§6) must be on. Otherwise the sheet does not offer it.

### 4.2 The wire, the preview and the stamp

- One builder, two renderings: `watchStepsFromBuild` turns the locked build's steps into watch steps;
  `buildProgramWatchProgram` (in `@rg/coros`, beside the existing strength builder and sharing its container and child
  helpers) turns those into the COROS program. The preview is read back off that program, so it lists each step
  exactly as the wire carries it.
- The stamp is `<program name> — <date>` (the coach stamp shape). It is at most 36 characters — the longest stamp
  proven to round-trip live (the spike's) — with the program name cut to fit. When another push of this account
  already uses that stamp on that day (two sessions on one day), it gains " (2)", " (3)". The stamp reader
  (`coros-stamp.ts`) learns the new kind, so the import shows the program name, never the stamp.
- The payload carries the resolved steps (catalog ids, free-text names, grams), so what was previewed is what is sent.
  The executor re-checks every catalog id against the current catalog before any wire call.

### 4.3 The job

- `POST /api/sessions/:workoutId/send-to-watch` locks the build (sets `locked_at` as Start does; the slot stays `built`
  until it is started or done) and enqueues `program_session_push` with id `push:<buildId>`. A second send of the same
  build is a no-op while that job is queued, running or verified with the copy on the watch. A failed one, or one
  whose copy was taken off (marked superseded once the delete verified), is requeued.
- The cloud executor re-reads the row at claim. A slot that was archived, moved off the push's day, or no longer holds
  that locked build is superseded without a wire call. Otherwise `createWorkout` runs (plan-scoped id, stamp
  uniqueness, calculate, write, read-after-write by stamp). It records the address (`source_workout_id`,
  `source_id_in_plan`, `source_program_id`, `last_verified_coros_date`), the observed wire fingerprint, and — new — the
  observed **text fingerprint** (step names and overviews in wire order) in the job's payload. Transient failures
  retry up to 3 times, as coach creates do.
- If the row was moved or removed while the push ran, the executor queues the unpush as soon as the push verifies.
- Writes stay in the existing lane: at most 3 jobs per run, with program pushes and coach jobs sharing the cap, and
  one run inside the Workers Free limit of 50 subrequests.

### 4.4 A sent session's lifecycle

- **Start in the app** (the athlete takes the phone along): Start on a sent, locked build moves the slot to `started`
  without a rebuild. The player plays the same build the watch holds.
- **Discard** (2b-R9) returns the slot to `built`. A build that is on the watch stays locked.
- **Move to another day** in the app: the watch copy is not re-dated. A build is made for its day (D3, the pre-check,
  2a-R7), so a queued push is superseded, a pushed copy is taken off the watch (the stamp-proven delete lane), the
  build is unlocked, and the slot becomes an outline as any moved slot does. A time-only change on the same day
  writes nothing (COROS has no time of day). Program rows never get a COROS move job, address or not (2a-R4,
  extended).
- **Take off watch** (the sheet): the same delete lane, without the move.
- **Skip** changes nothing on the watch, as for every other session.
- **Removal** (any archive path) settles queued pushes and unpushes a pushed copy (`removeFromPlan` →
  `settleWatchJobsOnArchive` + `enqueueUnpushIfOurs`, which learn the new kind).
- Deletes and unpushes run with the switch off as well: cleanup is the safe direction.

### 4.5 What the import does with a sent session

- **Content is never rewritten.** Rule 7, the recycled-slot rewrite and the wording heal never write a program row's
  title, category, sport, stages or summary. The row records the new wire fingerprint. When the wire's text or
  structure fingerprint differs from what the push observed, the athlete gets one sync note ("Changed in COROS"),
  and the app keeps its version.
- **Moved in COROS:** the existing date adoption applies (the slot follows COROS, with the existing "moved" note), the
  locked build stays, and the save and review accept the slot's new day for that build.
- **Deleted in COROS:** after two reads without it, the row's address is cleared (`calendar_only`) and one sync note
  ("Removed from your watch") is posted. A program row is never archived by absence. The app session stays doable.
- **A copy the row never learned about** (the executor died between write and record): a wire workout whose program
  name is one of this account's program stamps is attached to its slot, never inserted as a new row. If its slot is
  gone or holds another build, it is unpushed instead.
- **No other path writes.** `push-absent`, content convergence, the pending-work emitter and the legacy heal skip
  program and on-demand rows. The only COROS writes for a program row are a send the athlete made and the cleanup of
  that send.

## 5. After the watch session

- The COROS activity matches the slot as any watch session does: by plan link when the summary carries it, else by
  the scorer (a yoga slot accepts a strength activity). Either completes the slot.
- **The quick review is offered** for a program or on-demand slot that a COROS activity completed (an active
  `coros_plan_link` or `scored_auto` match), whose locked build exists, with no `app` or `watch_review` session, on the
  session's day or the next (2b-R7's window; for a sent build that COROS moved, the session's day is the slot's new
  day). Today lists it as "Log your session" (today's and yesterday's).
- **Prefill:** the watch's logged sets (the `watch` performed session of that activity) are paired with the build's
  entries — by library id first, then, for the moves left, by order when both sides have the same number left. Any
  entry still unpaired shows the build's targets. Watch entries that match nothing (a move added on the watch) are
  kept as their own entries.
- **Save** is `PUT /api/sessions/performed/:id` with `source = 'watch_review'`, `sourceRef` = the COROS activity id,
  the slot and the locked build. Same idempotency (client id + payload hash), same one-transaction write. It writes the
  session, its sets (as typed plus kg) and the post-check; deletes the activity's `watch` session; gives the
  activity the slot's title and the build's discipline (kept on refresh, as for app sessions); leaves the match as it
  is; and sets the slot `done`. No new activity, no new match.
- **One session per slot:** a slot holds at most one `app` or `watch_review` session (2b-R18 extended). A review for a
  slot whose app session is saved, or an app save for a slot whose review is saved, answers 409 `slot_done`.
- **Phone and watch together:** the app save joins the watch activity (2b), so the review is not offered.

## 6. The switch

`WATCH_PUSH_ENABLED` is a Worker var, absent (off) by default in every environment, like `IMPORT_ENABLED`. It is a
global switch: the app is single-user, and a per-account preference would be one the athlete could flip.

- Off: the session response's `watch` field is null, the UI renders nothing about the watch, the watch routes (preview,
  send, take off) answer 404, and the executor never claims a `program_session_push` (excluded at claim, so a queued
  one waits).
- On: the routes work and queued pushes run.
- The first real push to the owner's watch is a separate, owner-approved step (§8). The switch is turned on in its own
  commit only after the owner says yes.

## 7. Invariants and limits

- No COROS write ever comes from a session that was not explicitly sent. Cleanup of a sent session (unpush) is the only
  other write.
- Jobs are idempotent by id (`push:<buildId>`, `unpush:<buildId>`). Ownership is the stamp, proven by the executor
  before every write; deletes are triple-addressed and re-proven.
- At most 3 jobs per run; at most 50 subrequests per invocation.
- D1: at most 100 bound variables per statement, at most 5 terms per compound SELECT. No migration: the new state
  lives in job payloads and the existing columns.
- Garden determinism: one physical session is counted once. A review changes no garden input except the activity's
  sport; the save records a replay from its day, as the app save does.
- No personal data in fixtures. UI: min-width queries only (three tiers), 44 px tap floor, plain labels, no explainer
  captions. Tests pass under `TZ=UTC` too and pin the clock (no hardcoded-date time bombs).

## 8. Verification on the real account (the gate)

Never against the mock alone (it echoes bytes). With the owner's yes:

1. Turn the switch on (its own commit and deploy).
2. Send today's session from the owner's account. Read it back twice — two real reads straight from COROS, never the
   cached read-now — and compare every step with the preview.
3. The owner syncs the watch and glances once: names, targets and cues show correctly.
4. Complete it on the watch, import, take the quick review, and check single counting in the garden and Activity.
5. Run a counts-only probe of that activity's laps: what a free-text step's lap carries in `exerciseNameKey`, and
   whether `programExerciseIndex` indexes the pushed steps.

**Cleanup if anything is wrong:** Take off watch, two reads showing it gone, then turn the switch off.

## 9. Unknowns the gate settles

- What the watch displays for a `"0"` step after a phone sync, and whether long names are cut.
- What a lap item of a free-text step carries in `exerciseNameKey`. Today's derivation drops items with no key. If
  they have none, those sets prefill from targets, and naming them by program position is a follow-up.
- Whether the activity summary links back to an app-pushed program (`coros_plan_link`) or the scorer matches it.
