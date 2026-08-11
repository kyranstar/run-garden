# Coach & Plan rework: ambient reads + the new plan page

**Date:** 2026-08-11
**Status:** Approved (user approved mocks + recommendations; two hard requirements added)
**Mocks:** https://claude.ai/code/artifact/2df941b6-a639-4faa-bb05-b32662225877
**Supersedes:** `2026-08-07-plan-page-block-map-design.md` (draft, never built)
**Builds on:** `2026-08-06-coach-ux-design.md` (proposal machine, tray, memory — all kept)

## Decisions locked

1. Coach placement: **floating window** on desktop (≥1024px), pill + sheet on mobile.
2. Read model tier: **strong** (`AI_STUDIO_MODEL_STRONG`), overridable via `AI_COACH_READ_MODEL`.
3. Backfilled history: **one batch-digest read per backfill run**, not per-activity reads.
4. Page stays named **Plan**.
5. Brief chips: sessions done/planned · time done/planned · 4-wk adherence + trend · load 7d/28d.
6. The embedded Studio section and the Manage-plans sheet **retire**; the studio modal absorbs both.

## Hard requirements (user-stated, non-negotiable)

### R1 — No overflow/clipping on mobile

Every surface this project touches must render at 360px and 390px with **no
horizontal body scroll and no clipped content**. Concretely:

- Horizontal groups (brief chips, picker header, action rows, prog chips) either
  wrap or scroll inside their own `overflow-x: auto` container — never the body.
- All SVG charts are `width: 100%` with `viewBox` (never fixed pixel widths).
- The studio modal on mobile is a full-height bottom sheet with internal scroll.
- Long titles clamp with `-webkit-line-clamp`, never push their row wider.
- Verification is a required step, not a hope: fixture-stack screenshots at
  360/390/768/1280/1440, light + dark, checked for `document.scrollingElement
  .scrollWidth <= innerWidth` on every mobile capture.

### R2 — LLM exactly-once

Opening the app N times, racing tabs, cron overlapping a user action, or
re-ingesting an activity must never produce a duplicate LLM call for the same
logical work item. Mechanisms:

- **Reads:** `coach_reads` has `UNIQUE(user_id, activity_id)`. Work is claimed by
  an atomic conditional UPDATE (`status='queued' AND next_attempt_at <= now` →
  `status='running'`, checked via `changes()==1`); only the claimer calls the LLM.
  A `running` row older than 10 min is reclaimable (crash recovery). Re-ingest
  with a changed fingerprint does **not** re-read (strictest interpretation);
  only an explicit user "Fresh read" regenerates, updating the same row.
- **Wake:** single-flight per user via a `coach_locks` table (`PK(user_id, kind)`),
  claimed with an atomic upsert that only succeeds when the existing claim is
  absent or stale (>10 min). Losers get `{status:"busy"}`; the client shows the
  existing "Coach is thinking…" state and refetches. The cheap `openWakeIsFresh`
  gate stays in front of the lock.
- **Weekly review:** already fingerprint-cached — unchanged.
- **Budget/ledger writes** happen once, by the claimer, after the call returns.

## 1. Server: the read ledger

New table `coach_reads` (migration 0013):

```
id TEXT PK · user_id · activity_id · status ('queued'|'running'|'done'|'failed'|'skipped')
attempt INT · next_attempt_at · claimed_at · glance TEXT · body TEXT · flags JSON
model TEXT · created_at · completed_at
UNIQUE(user_id, activity_id); INDEX(user_id, status, next_attempt_at)
```

**Enqueue:** after successful ingest of a *new* activity (`completion.ts` insert
path, and backfill), insert-or-ignore a `queued` row — but only when the
activity's `startTime` is within 14 days of ingest. Older activities are covered
by the backfill digest (below). Enqueue is a cheap DB write; no LLM at ingest.

**Process:** two drivers, one claim path:
- `ctx.waitUntil(processReads(userId, {cap: 2}))` after ingest — reads appear
  minutes after sync.
- Hourly cron sweep `processReads(userId, {cap: 2})` per user — catch-up for
  failures and missed waitUntils. Cron never blocks on more than 2 calls/user.

**Guards, in claim order:** fixture mode → `AI_GATEWAY_API_KEY` present →
`prefs.aiEnabled` / `AI_DEFAULT_ENABLED` → budget: auto-reads pause when the
7-day rolling spend exceeds **$12** (interactive surfaces keep the remaining $8
of the $20 cutoff) → atomic claim → LLM. Failures: `attempt+1`,
`next_attempt_at = now + min(2^attempt × 15min, 24h)`; after 5 attempts →
`failed` (surfaced as a quiet "couldn't read this one" in the sheet, retryable
by the user).

**Output contract:** one JSON object `{glance: ≤90 chars, body: prose ≤180
words, flags: string[] ⊆ {hr_drift, strain_high, breakthrough, pace_regression,
fueling, comeback, none}}` — zod-validated with one repair round-trip (same
pattern as wake). Stored on the row. Reads write **nothing** to
`coach_messages` — that's what fixes the freshBriefing reset, thread crowding,
and dossier crowding.

**Backfill digest:** a backfill run that ingested >5 activities older than the
14-day window enqueues one synthetic digest read (`activity_id =
'digest:<backfillRunId>'`) summarizing the batch (counts, spans, notable
sessions) so the coach knows the history without N calls.

**Migration of old analyses:** existing `refs.kind='analysis'` messages stay in
`coach_messages` as history; `freshBriefing` and the dossier tail now exclude
them by filter. The analyze cache-read path moves to `coach_reads` only (old
messages are not consulted).

## 2. Server: analyze route becomes read-through

`POST /api/coach/analyze/:activityId` → ensure-read semantics: row exists+done →
return it; missing → enqueue + claim + generate synchronously (this path is the
existing user-facing latency); `running` (someone else generating) →
`{status:"working"}` and the client polls. `force:true` → regenerate in place
(same row, `attempt` reset, glance/body/flags replaced). Honors every guard in
§1 including the kill switches the old path skipped. Response shape gains
`{glance, flags}` alongside the prose body.

## 3. Server: triggers, dossier, focus

- New trigger kind `notable_read`: fires (dedup rules identical to existing
  kinds, 72h refire window) when a `done` read since the last wake carries any
  flag other than `none`. Evidence = `{activityId, glance, flags}`.
- Dossier gains section **RECENT READS**: glance lines (max 7) for reads
  completed since the newest briefing; replaces per-analysis crowding of the
  conversation tail. Conversation tail filter: `role='coach' AND refs.kind IS
  NULL` for staleness/briefing logic.
- `wakeOutputSchema` gains `focus: string|null` (≤160 chars) — the single
  action line. Persisted in the briefing message's `refs.focus`. The wake prompt
  instructs: name the week's anchor, at most one adjustment, garden voice.

## 4. Server: new read routes

**`GET /api/plan/week?start=YYYY-MM-DD`** (defaults to current ISO week) — one
call powering brief + week view:

```
{ weekStart, days: [{date, workouts: [...existing PlanResponse shape...]}×7],
  plannedSeconds, doneCount, sessionCount,
  weekIndex, weekTotal,            // from active coach/studio plan covering start, else null
  adherence4w: {pct, trend},       // trend: 'up'|'flat'|'down' via prior-4wk comparison
  loadRatio,                       // 7d/28d trainingLoad, all sports
  headline,                        // 'on_track'|'behind'|'ahead'|'rebuilding'|'race_week'|'resting'
  focus: {text, at} | null }       // latest briefing refs.focus, null if >3 days old
```

Headline derivation (deterministic): race_week if active plan raceDate within
7d; resting if current week is a coached deload/wind-down; else by adherence4w
(≥80 on_track, 60–79 behind→"slightly behind", <60 rebuilding) with ahead when
adherence ≥95 and loadRatio ≥1.0. Copy mapping lives client-side.

**`GET /api/coach/plans/:id/detail`**:

```
{ plan: CoachPlanDto, weeks: [{weekStart, state: 'firm'|'shape', volumeTarget?,
  keySessions?, summary, done, current}],
  progressions: [{key, label, unit, from, to, now,
    series: [{week, value, done?}]}],
  sessions: {planned, done} }
```

Progression extractors (deterministic, server-side):
- **Lift (studio-source plans):** for each of the 3 most-frequent `originId`s in
  the plan JSON: top-set weight by week (prescribed), `done` marked via
  `studio_plan_pushes`→`workout_completion_matches`. Plus weekly total sets.
- **Run (coach plans):** long-run distance by week (max `expectedDistanceMeters`
  per ISO week over the plan's planned workouts) and weekly planned minutes;
  actual overlay from matched activities. Shape weeks contribute `volumeTarget`
  text only (no fabricated numbers).

`GET /api/coach/plans` already merges coach + newest studio plan; detail accepts
both id namespaces.

## 5. Server: coach lift structure survives apply

`coach-apply.ts` currently flattens `lift.exercises` into a display string. It
now also persists the structured array to `planned_workouts.structured_json`
(new nullable TEXT column, same migration) so coach-authored lift plans can be
graphed by the extractors in §4. No behavior change for COROS writes.

## 6. UI: the plan page

Route `/plan`, `shell-main--wide` (max 1440px). DOM order (same both widths):

1. **Header** — `h1 Plan` + quiet sync note (SyncPanel `quietWhenHealthy`).
2. **Weekly brief card** — headline serif line + "Needs you · N" pill (pending
   proposals > 0 only) + 4 chips + coach focus line. Data: `/api/plan/week`.
3. **Plan cards** — one per active/draft plan (run + lift), 2-up grid ≥760px,
   stacked rows below: discipline pill, status pill, serif name, `wk n/m` +
   progress track + end date, one headline progression + sparkline. Click →
   studio modal. A discipline with no active plan renders a dashed "+ Plan with
   your coach" card.
4. **Week view** — picker header (‹ › arrows, week label, `plan wk n` pill,
   "jump to week ▾" menu listing plan weeks with months, "back to this week"
   chip when off-current; deep link `?week=YYYY-MM-DD`). Desktop: 7-col grid,
   day cells with full-title workout cards (existing status glyph vocabulary),
   ghost proposals dashed-amber on their days. Mobile: vertical day list; days
   without content collapse except today. Tapping a workout → existing
   `?workout=id` sheet, unchanged. Tapping a ghost → coach window/sheet opens +
   proposal flash (existing focusProposal, now single-mount).
5. **Coach** — desktop: floating window (`coach-window.tsx`, width
   `min(400px, 34vw)`, right-pinned inside the content area, non-modal, above
   page/below sheets) hosting the one `CoachPanel` mount; minimized → `Coach · n`
   pill. Open triggers: pill tap, ghost tap, new coach activity since last-seen
   watermark; minimize marks-seen; `Esc` minimizes; state in localStorage
   (`rg.coachWindow.open/seen`). Mobile (<1024px): existing pill + Sheet,
   unchanged contract, same single `CoachPanel` (window never renders).

Deleted: month almanac (`buildMonths`), `.plan-split`, `StudioSection` embed,
Manage-plans sheet, duplicate CoachPanel mount + `idPrefix` threading, "Today"
button, extend CTA row. `usePlanCoach`, `WorkoutDetail`, move/match sheets, and
all mutations keep working unchanged.

Data: the page keeps `api.workouts(start,end)` for the fetched window (now
picked-week ±4 weeks) for ghosts/detail continuity, plus `/api/plan/week` for
the brief, `coachState`, `coachPlans`.

## 7. UI: the studio modal

One component (`studio-modal.tsx`), routed by `?plan=<id>` so links/back work.
Desktop: centered dialog (max-width 720px). Mobile: full-height bottom sheet.
Existing dialog-stack contract (`useDialogFocus`) — it stacks under the workout
sheet if both open.

**Details mode** (existing plan): header (pills, serif name, dates, race chip,
adherence, close) → progression chips → charts (2-up ≥760px, stacked below;
built on `ChartFrame`/chart-kit: lift = prescribed step line + completed-session
dots; run = weekly planned bars w/ actual fill + long-run step line) → weeks
list (firm/shape, volumeTarget, current highlighted) → actions row: Extend ·
Wind down · Rename · Retire (two-step) · "Talk to your coach about this plan"
(opens coach with a prefilled contextual message). Lift studio-source plans
additionally surface the existing generate/edit/push controls (reusing the
studio flow components) under a "Revise" disclosure — the studio page section
retires but its machinery is unchanged.

**Create mode** (`?plan=new-run` / `new-lift`): coach intake — the existing
canned-message pipeline (`New running plan` / `New lifting plan` sends) plus the
studio brief form for lifts; the draft plan appears as a plan card with status
`draft` and a whole-plan proposal in the tray (existing createPlan op flow).
No new backend — this mode is a front door to existing flows.

## 8. Copy & tone

Garden voice everywhere: the brief names the situation, never scolds
("slightly behind" not "you failed 2 sessions"). Focus line ≤1 adjustment.
Glances are observations, not grades ("HR drifted 6% late — fueling, not
fitness"). Headline states map to copy in one place (`brief-copy.ts`).

## 9. Testing

- **Unit (worker):** claim atomicity (parallel `processReads` on one queue row →
  one LLM call — fake transport counting calls), wake lock single-flight (two
  concurrent wakes → one call + one `busy`), backoff schedule, budget reserve
  cutoff, backfill digest threshold, enqueue-on-ingest 14-day rule, re-ingest
  no-re-read, headline derivation table, progression extractors (lift top-set,
  run long-run, shape-week exclusion), `/api/plan/week` totals vs fixtures.
- **Unit (ui):** week builder (picked week, collapse rules), brief chip
  rendering from fixture payloads, coach window open/seen watermark logic,
  jump-to-week menu content, plan-card progression formatting.
- **Screenshots (R1 gate):** fixture stack, 360/390/768/1280/1440 × light/dark ×
  (page, modal open, coach open, week navigated). Mobile captures assert no
  horizontal overflow programmatically.
- **Manual:** ghost tap round-trip, workout sheet from navigated week, approve
  flow end-to-end, COROS-writes-off banner state.

## 10. Out of scope

- Notifications (desktop shell), garden-voiced coaching (phase 3), coach-declared
  headline progressions in the createPlan op schema (extractors cover v1),
  actual-lifted-weight capture (COROS doesn't send it), re-read on fingerprint
  change, multi-user concerns.
