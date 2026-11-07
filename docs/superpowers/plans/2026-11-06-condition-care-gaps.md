# Condition care gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps between what a condition plan's brief says matters and what the app can act on: a measure of the condition's daily check, reference points on that check's scale, stress beside sleep for the coach, a daytime cue, and a short posture and neck practice.

**Architecture:** Everything hangs off what exists. A new key result measure reads `condition_checks`. Reference points and the cue's words live on the `ConditionProfile`, so no screen knows a condition. Stress is stored where the watch's sleep already goes. The cue is one recurring calendar event per time of day. The practice is a second `CourseDefinition`. No new screens or flows (Q-130): real daytime prompts you can answer wait for the LifeOS integration, and go on its list.

**Tech Stack:** pnpm monorepo, Cloudflare Worker (Hono, D1, drizzle), React UI, pure packages (`@rg/domain`, `@rg/exercise-library`, `@rg/workout`, `@rg/calendar`), vitest.

**Spec:** the evidence and the plan's own words are in `docs/superpowers/specs/2026-11-05-plans-with-a-purpose-design.md` for courses and plans; the conditions' evidence is §12 of `docs/principles/workout-system-principles.md` (2026-10-23).

## Global Constraints

- The repo is public: no personal data, real plan names, targets, figures or dates in code, tests or commits. A target, a chosen weekday or a chosen time is data, set through the API after landing.
- No new screens or flows. A line on an existing sheet or row is fine.
- Worker and UI code name no condition and no course: words come from the profile or the definition.
- About 45 D1 statements a request. Bytes and prompt pins are re-measured, with a dated note, never raised blind.
- Migrations only add. `SCHEMA_VERSION` follows, and the number must be unique.
- Node 22 is for wrangler only; tests run on the default node.

## Review Focus

1. A check logged twice in a day, or a day with only `pre`/`post` rows: the average counts each day once, from the `daily` row, in the athlete's local date.
2. No readings in the window: the measure says nothing rather than zero, which would read as a perfect score.
3. A reference point that disagrees with the rule it describes: the flare line's words read the same constant as the rule.
4. Calendar: an existing sync must never delete, re-time or re-book a cue event, and turning cues off removes exactly what was added.
5. A session with no watch copy (the practice) must not read as failing to sync, and must count once when marked done.

---

### Task 1: A measure of the daily check, and its reference points

**Files:**
- Modify: `packages/domain/src/profile.ts` (`keyResultMeasureSchema`, `canonicalUnitOf`, `naturalDirection`), `apps/worker/src/services/key-result-measures.ts`, `apps/worker/src/services/design-tools/read-objectives.ts` (`measureWords`), `packages/exercise-library/src/conditions/types.ts`, `packages/exercise-library/src/conditions/tmj.ts`, `packages/ui/src/components/condition-check-sheet.tsx`, the objectives board's row (`packages/ui/src/screens/.../quests.tsx`, `objectives-model.ts`)
- Test: `apps/worker/test/key-result-measures.test.ts` (or its current home), `packages/exercise-library/test`, `packages/ui/test`

**Interfaces:**
- Measure: `{ kind: "condition_check", profileId: string, windowDays: number }`, `windowDays` 7 to 60. Unit `score`. Natural direction `down`. Value: the mean of the profile's `daily` rows with a non-null `value`, one per local date, over the last `windowDays` days ending today in the athlete's zone. Null with no rows in the window.
- `ConditionProfile.check` gains `anchors: readonly { value: number; words: string }[]`, at most 4, ascending, each inside `min` to `max`. The profile's flare anchor uses `HIGH_PRE`, so its words can't drift from the rule.
- Words for this profile: 0 "Nothing"; 2 "There, easy to ignore"; `HIGH_PRE` "Bothering me: an easy day"; 8 "Hard to eat or talk".

- [ ] **Step 1: Write failing tests:** the mean over a window, with `pre` and `post` rows ignored; a re-check counts once, its latest; a day just outside the window at 23:30 local, and just inside; no rows gives null, not 0; another profile's rows don't count; a `down` measure reads as progress when it falls; `read_objectives` says what it measures; a key result with it is accepted by `POST /api/objectives` and by `propose_objective`; every profile's anchors validate; the flare anchor's value equals what `flare` treats as a flare; the sheet shows the anchors as one quiet line under the grid, and shows none for a profile with no anchors; the board's row says the target's words when an anchor matches it, and nothing when none does.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** The board adds words only: no new control.
- [ ] **Step 4: Run, expect pass,** local time and `TZ=UTC`. Check the statement pins for the objectives read: one more read at most, in the existing batch of measures if it can be.
- [ ] **Step 5: Commit** `feat(objectives): a key result can measure a condition's daily check, and the check's scale has reference points`.

### Task 2: Stress beside sleep

**Files:**
- Create: `packages/database/migrations/0037_daily_stress.sql`
- Modify: `packages/database/src/schema/*` (the table the watch's daily sleep goes to), `packages/database/src/version.ts`, `apps/worker/src/services/coros-mcp.ts` (the parser at about line 646), `apps/worker/src/services/design-tools/read-readiness.ts`, `apps/worker/src/services/design-tools/record-answer.ts` (`CHECKIN_QUESTIONS`)
- Test: the parser's suite, `read-readiness`'s, `record-answer`'s, `account-tables`

**Interfaces:**
- One additive nullable column for the day's average stress, in the table the sweep already writes. The parser keeps the number it currently discards; a report with no stress line stores null and fails nothing.
- `read_readiness` gives the coach recent days' stress beside sleep. `CHECKIN_QUESTIONS` gains `sleep_quality` and `stress`, with the existing shape and a freshness window. No new question on any sheet.

- [ ] **Step 1: Write failing tests** from a real captured report's shape if `docs/reports/` holds one; otherwise say so and pin the shape the parser reads now. A missing line, an odd value, an old row with null stress; the export and restore round trip carries it; the coach's read says stress only when it has it.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass,** including the prompt pins, re-measured with a dated note if moved.
- [ ] **Step 5: Commit** `feat(coach): the watch's daily stress is kept beside sleep, and the coach can ask about both`.

### Task 3: A daytime cue on the calendar

**Files:**
- Create: `apps/worker/src/services/condition-cues.ts`, `apps/worker/test/condition-cues.test.ts`
- Modify: `apps/worker/src/routes/*` (the conditions routes), `packages/exercise-library/src/conditions/types.ts`, `tmj.ts`, `packages/calendar/src/*`, `packages/domain` preferences

**Interfaces:**
- `ConditionProfile.cue?: string`: this profile's words, "Teeth apart, jaw soft".
- `PUT /api/conditions/:profileId/cues` with `{ times: string[] }`, 24-hour "HH:MM", at most 4, and `DELETE` to turn them off. Each time is one recurring event on the athlete's Google Calendar: 5 minutes, marked free, an alert at its start, recurring on the first 7 days of each month (`FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7`), in the athlete's zone. The event ids are kept in preferences. Idempotent: the same times change nothing; other times replace them. No Google connection answers a plain refusal.
- Nothing on a screen. The API is the switch for now; a toggle goes on the LifeOS list.

- [ ] **Step 1: Write failing tests:** puts one recurring event per time with the rule and the alert; a repeat makes no second set; other times remove the old ones first and leave nothing behind if a call fails part way, or say which remain; delete removes exactly those; no connection refuses; a condition with no cue refuses; **a full `syncCalendar` afterwards doesn't touch them** (read how it decides what's its own, and pin that it never lists these as stale); a token that has expired refreshes as other calls do.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Reuse the calendar client and its token handling.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(conditions): a daytime cue as a recurring calendar event`.

### Task 4: A short posture and neck course, with no watch copy

**Files:**
- Create: `packages/workout/src/posture-neck-course.ts`, `packages/workout/test/posture-neck-course.test.ts`
- Modify: `packages/workout/src/courses.ts` (`CourseDefinition.watch?: false`, a new entry), `apps/worker/src/services/course-sessions.ts`
- Test: `apps/worker/test/course-sessions.test.ts`

**Interfaces:**
- A second entry in `COURSES`, id `posture-neck`, name "Posture & neck". `sessionDoc(n, { ease })` rotates a small set of documents, 5 to 8 minutes each, from moves needing nothing beyond a wall or a chair: chin nods, wall angels, door openers, chair thoracic extension, and jaw-reset breathing (check the ids against the library, and that each is `conditions.tmj` clean). `ease` shortens it. `sessionLabel` is always null; `afterLabel` says what the row reads. Purpose and brief are generic, for the plan's own words to begin with.
- `watch: false` on a definition: its written sessions go out with the row's existing "keep off my watch" state set, and the mirror owes them nothing. Worker code reads only the flag.

- [ ] **Step 1: Write failing tests:** every session validates clean for an athlete with the profile, on a calm day, a flare day and as a template; each runs 5 to 8 minutes; the moves are in the library; the player's steps work; the rotation repeats without a number that ends; a written session of this course owes no mirror and queues no push, and reads as off the watch rather than failing to sync; a mark done counts once and the garden credits it once; **no worker or UI file names it**, and a start through `POST /api/plans/courses` works with no other change; TRE's course still pushes as before.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass,** local time and `TZ=UTC`.
- [ ] **Step 5: Commit** `feat(courses): a short posture and neck practice, kept off the watch`.

### Task 5: Land it

No code unless verification finds something. **The owner has OKed migration 0037.**

- [ ] **Step 1:** `pnpm -r typecheck`, the whole suite in local time and `TZ=UTC`, one fixture-stack run on real local D1 exercising the new statements.
- [ ] **Step 2:** Record a D1 Time Travel bookmark, fetch and merge main, re-check the migration number is the highest and unique, confirm no coach run is live, push, and confirm CI and Deploy by full SHA.
- [ ] **Step 3:** From the signed-in browser, with the values the owner chose: create the objective and its key result; link it to the condition's plan; set the cues; start the practice. Read each back.
- [ ] **Step 4:** Add to `~/src/lifeos/docs/rungarden/INTEGRATION_NOTES.md`, from a lifeos worktree: real daytime check-ins you can answer, a toggle for cues, a one-step change of a course's days, Start again on a stopped course.
