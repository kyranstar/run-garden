# Plans with a purpose, and one source of truth (design, 2026-11-05)

**Status:** draft for the owner's review. Nothing here is built.

**Read with:** `docs/principles/workout-system-principles.md`; `2026-10-20-training-lines-design.md` (what a plan row says today); `2026-09-30-phase-5-programs-remodel-design.md` (the earlier re-model, never run; its inventory of behaviours is still the checklist); `2026-10-28-watch-mirrors-the-plan-design.md`.

## 1. Intent

**The owner's asks, verbatim (2026-11-05):**

> Is there a way we can make a simpler abstraction that empowers plans to actually have a purpose, such as informing the AI how to extend the capabilities into the future? … And nothing should "drift" ever, and the data should always be consistent from a single source of truth and all steps that write it should be 100% accurate with the correct data and outputs.

> When a running plan ends, we should have a coach dialogue that asks us how we want to extend the plan, for a relevant goal if any, or perhaps for some should just continue them without asking, like TRE. For running it should definitely ask, for most other things it should automatically continue.

**The definition the owner agreed:** a plan is sessions with one purpose that you'd stop together. A one-off workout isn't a plan. A reusable template isn't one either: it has no dates.

**Why now.** Today what counts as a plan depends on who or what wrote the sessions, not on what they're for. A plan has no field saying what it's for, so nothing can tell the coach how to carry it forward. And a plan's facts are stored apart from the sessions they describe, so they come apart. A read-only audit (2026-11-05) found these failures in the code, and one is confirmed in production:

| Fact | Where it's stored | How it fails |
|---|---|---|
| A plan's dates | `coach_plans` dates and the rows' dates, with nothing joining them | Move a block's last session past its end: it leaves the plan's weeks and adherence |
| A Studio plan's contents | `studio_plans.plan` JSON, while the rows sit under a hidden `training_plans` container | **Confirmed in production:** the sheet shows lifts and progress that aren't what's scheduled or done |
| Race day | Settings, `coach_plans.race_date`, a race row, and `athlete_profiles.events` | Settings drives the race hub, the plan's copy drives the guardrails: change one and the other guards the old day |
| Session content | Columns, stage rows, `stage_summary`, `structured_json`, `workout_doc` | Shortening a lift changes its minutes, not its moves |
| Completion | `completion_state`, a live match, `activities.completion_match_id`, `content_state`, `performed_sessions` | Written in separate statements in places, and nothing checks they agree |
| Week shape | `coach_plan_weeks.state` and the rows | A reshaped outline week can hold sessions and still read as outline |
| Who writes sessions | About 76 write statements in 28 files, four content families | No single path to make right |

These are failure paths in the code. How many have bitten real data outside the Studio plan is unmeasured; Stage 3's check measures it.

## 2. Goals, non-goals, anti-goals

**Goals**
- One simple plan abstraction every kind of plan fits, with a purpose and a brief the coach reads.
- Each plan says what happens when its sessions run out: ask, or continue.
- Every fact about a plan or a session has one home inside the database.
- Every session write goes through one module; a test refuses any other.
- A daily check that reports anything inconsistent, so a miss is seen within a day.

**Non-goals**
- New screens or flows (Q-130, logic first). Small additions to existing sheets only, logic in pure modules.
- Changing how the coach designs workouts, or the review loop.
- Merging COROS's own data with ours: COROS stays the source of the sessions it wrote.
- Answering LifeOS's Q-129 (where training data lives). This design keeps the worker as the home and makes the later move easier.

**Anti-goals: what would make this a failure even if it worked**
- A second copy introduced "for speed" that can disagree (§5.2 allows only a cache one writer owns).
- The migration changing what's on the watch, on the calendar or in the garden's history, other than the listed behaviour changes.
- A plan the athlete has to maintain by hand. Purpose and brief are written once and rarely touched.
- A plan changing without the athlete's tap, or the coach spending without one, beyond the single case the owner ruled on (§4.2). "Nothing starts without the athlete's tap" (§12, 2026-11-05) otherwise stands.

## 3. The abstraction

**A plan is a purpose plus how its next sessions get made. Everything else is worked out from its sessions.**

`programs` becomes the one registry of plans, as Phase 5 intended, keeping every id so `planned_workouts.plan_id` never changes meaning. Additive columns:

| Field | Meaning |
|---|---|
| `name` | Exists. What the plan is called |
| `purpose` | New. Why it exists, in the athlete's words: one sentence |
| `brief` | New. What the next sessions must respect: the rules, the progression, what it's working toward. At most 1,000 characters. Intent, never facts the app can compute |
| `kind` | Exists. Who makes its sessions (§3.1) |
| `on_end` | New. `ask`, `continue` or `finish` (§4) |
| `paused_until` | New. Optional date: until then it makes no new sessions (§4.4) |
| `objective_ids` | New. Optional: the objectives it serves, so "is this working?" has numbers to read and the dialogue has goals to offer (§4.1). A statement of intent; each session's own `intent.objectiveIds` stays its own |
| `disciplines` | Exists. A plan can hold several sports |
| `status` | Exists. `active` or `retired` (stopped) are the only states anything writes. Ended is computed |
| `config` | Exists. Kind-specific settings (days and minutes for the engine; course and days for a course) |

**Computed from the sessions, never stored:** start, end, weeks, week n of m, progress, adherence, whether it has ended, next session, race.

### 3.1 Kinds: who makes the sessions

| `kind` | Makes sessions by | Example |
|---|---|---|
| `adaptive` | The session engine, from `config` | Condition care |
| `course` (new) | Code, from a fixed definition in `@rg/workout` | TRE |
| `coach` | The coach, from the brief | A running plan |
| `coros_import` | COROS; the app only reads them | A plan built on the watch |

### 3.2 Phases

A training line today is worked out at read time, so it has no identity and nowhere to hold a purpose. It becomes stored:
- A coach block stays a `coach_plans` row, as a phase, and gains `program_id` naming its plan. It gets no `programs` row of its own: that would copy its name and status, which is the drift this design removes.
- A plan is the `programs` row: what the list shows, what holds the purpose and brief, and what Stop acts on.
- Sessions keep their `plan_id` (the block's), so no session row is rewritten. "The plan of a session" is its block's `program_id`, else its `plan_id`.
- A new block joins a plan only when its proposal says so. `propose_plan`'s `createPlan` must name the plan it continues, or give a new plan's name and purpose. Dates decide nothing: two plans of one sport can have different purposes.
- Backfill: today's `linesOf` result is written as parents, once. The date rule isn't used after that.

### 3.3 One-offs have no plan

One function, `isOneOffPlan(planId)`, says so for the existing `adhoc-*` and `studio-*` buckets. They're never listed, and every one-off's sheet says "One-off", the Studio bucket's too (today only `adhoc-` does). `plan_id` stays NOT NULL: dropping that needs a full table rebuild in SQLite for no gain.

### 3.4 Which plan a session belongs to

A session belongs to a plan when it's made for that plan, whoever makes it:
- **Engine and course sessions:** always their plan.
- **`propose_plan`:** its plan, as today.
- **`plan_set` and `propose_workout`:** today they always file under the Studio bucket (`doc-workouts.ts`, `designed-runs.ts`). They gain an optional `planId`, carried through the proposal and approval to the row. The coach names the plan when a workout is made for one; with none it's a one-off. This changes only where a session is filed, not how it's designed or reviewed.
- **Continuing a plan that isn't running:** its coming days are reviewed workouts through `plan_set`, as the prompt already says, each with the plan's id; its later weeks are outline through `propose_plan`.
- **Existing bucket rows stay one-offs.** They aren't re-filed: nothing reliable says which plan each was made for.

### 3.5 Existing plans, after migration

- **Running:** a parent `coach` plan, `on_end: ask`, its blocks as phases.
- **Condition care:** the existing `adaptive` programme. It already continues.
- **The Studio strength plan:** one `coach` plan whose id is the hidden container's, so its rows are already its sessions. It reads only those rows. `studio_plans` stops being read for it, and it replaces both list entries. Stray rows in the container are out of scope for its sheet by date (from the plan's first Studio session).
- **TRE:** a new `course` plan. Sessions already done or under way keep what they hold. Those still ahead become outlines (§4.2) and their watch copies come off through the normal delete path, verified by a real read. Sessions played before this lands count as done.
- **COROS plans:** `coros_import`; listed as today.
- **`studio_plan_pushes`:** kept as the watch ledger until no pushed session remains ahead. `training_plans` stays as the import's sync ledger, not a plan.

## 4. What a plan does when its sessions run out

**"Ending" is computed:** an active plan is ending when its last session is at most 21 days ahead (the existing chip's horizon) and nothing else follows. It has ended when no session or outline week is left ahead.

**`on_end` is set when the plan is made, and a coach plan's changes by telling the coach.** Running asks; most other plans continue (owner, 2026-11-05). By kind:

| `kind` | `on_end` |
|---|---|
| `coach` | A plan holding any running defaults to `ask`; others to `continue`; any of the three can be set. `finish` suits something time-boxed, such as rehab or trip prep |
| `adaptive`, `course` | `continue`: making sessions costs nothing and asks nothing, and Stop is how they end. The tool refuses `ask` for these and says so. A course whose definition has a last session would `finish`; TRE's has none |
| `coros_import` | Running plans `ask`, and the answer becomes a new `coach` plan, because COROS's sessions aren't ours to extend. Others have no chip and nothing to continue |

### 4.1 `ask`: the coach dialogue

1. **The prompt.** The existing "needs you" chip fires as today ("Plan what comes after my running plan — it ends in 12 days"), now for any `ask` plan, not only coach lines. Chips only show on the coach's opening screen, so the plan's row in "Your plans" says "What's next?" too, and a tap sends the same words. It costs nothing, and a tap is the only spend.
2. **The dialogue.** A tap opens the conversation. The coach reads the plan's purpose, brief and objectives, and asks how to extend it and toward what goal, with `ask_athlete`: tappable choices drawn from what's relevant (the plan's objectives and current goal, upcoming dated events, other active objectives, "keep building", "stop here") and free text always. It skips the question when the request already says.
3. **The proposal.** The answer becomes a `propose_plan` for a next phase of the same plan, approved with a tap. A new goal updates the brief on the same card.
4. **No answer:** the plan simply runs out, and the chip stays quietly available. Nothing is marked missed, and nothing scolds.

"Asks first" is guidance in the tool's description and in `read_plans` (`onEnd: "ask"`), held by a scenario eval, not a refusal: a code gate can't tell when the request already answered it (§6.1 of the principles).

### 4.2 `continue`: it keeps going without asking

- **`adaptive`:** already does, through hourly placement.
- **`course`: placed ahead as outlines, written on the day (owner, 2026-11-06).** Works as a programme's slots do, with no model call, and runs until the plan is stopped.
  - **Ahead:** the hourly pass, beside `placeSlotsForAllPrograms`, keeps outline rows placed up to `placementWeeksAhead`, on the days and time in `config`. They count by the day planned on, as slots do, so what the athlete moved or removed is never undone. A `quietDaysBeforeRace` setting holds new ones back before the goal race. An outline holds a title and a booked length, and no document, so nothing goes to the watch yet.
  - **On the day:** the first of the day's hourly pass or the session being opened writes its document, once, from `sessionDoc(n)`, where **n is the plan's sessions actually done, plus one**. A skipped or missed session therefore changes nothing, and "the first ten" means ten done. The row keeps its number in `planned_workouts.course_session`, which is also what marks it as the course's own: a workout the coach filed under the plan doesn't count. The mirror then sends it to the watch by its normal path.
  - **Shown ahead:** the plan's row says "Session n of 10" from the same count. A sheet for a day ahead previews the dose by computing it, never storing it.
  - **Videos, and doing it another way:** videos read from the plan's course, since an outline has no document (`videosOfSource` today reads the document's ref). A course session's sheet offers "Mark done", because following a video records nothing today and the number counts sessions done. It records the athlete's own say-so as the session's evidence (§5.1).
  - **Easing the next session:** `config.easeNext`, set by a change the athlete approves in the coach, is used and cleared in the same batch that writes the next session. Each course says what easing means; for TRE, half the tremor.
- **`coach` with `continue`, such as a lifting plan: the coach drafts, the athlete taps (owner, 2026-11-06).** This is the one exception to "nothing starts without the athlete's tap", and it covers spending only.
  - **When:** the hourly pass sees a plan ending, and starts one coach run with a system-written request naming the plan, at most once per ending (keyed by the plan and its last session's date).
  - **Bounds:** the run's own ceiling and the weekly cap. At the cap, or on any failure, nothing retries on its own: the existing chip appears, and says plainly what happened.
  - **What it makes:** the plan's next stretch from its brief (§3.4), as a normal reviewed proposal under a "needs you" chip, and "Next stretch ready" on the plan's row. **Nothing reaches the plan until the athlete approves it.** Ignored, it stays there, the plan runs out, and no second draft starts unless asked.
  - **Until this ships,** these plans keep today's chip, so nothing goes quiet.
- **`coros_import`:** nothing to continue; COROS makes its sessions.

**`finish`:** nothing happens when it ends: no question, no draft, no chip. It moves to Past plans.

### 4.3 The coach always has this, and so does the athlete

`read_plans` returns each plan's purpose, brief, objectives, `on_end`, kind, pause, computed dates and next sessions. The opening context's computed block (§12, 2026-11-05) gains one line per active plan: name and purpose. The brief stays behind the tool. A coach tool changes a plan's purpose, brief, objectives, `on_end` or pause as a proposal the athlete taps; each change is kept in `program_versions`.

The athlete sees what steers the coach: the plan sheet shows the purpose and how it ends, with the brief one tap down. A "Change" there opens the coach with the words written, the athlete's to send.

The rule "whole sequence for ten sessions, then floor; halve after a bad 48 hours" moves from each TRE session's notes to the plan's brief, once, so the coach can act on it (§4.2, Easing). The athlete still sees the 48-hour rule where it matters: it's in the floor tremor move's how-to, which the player opens. Nothing applies it automatically: the app can't tell how you feel two days later unless you say.

### 4.4 Pausing

For illness or travel: until `paused_until`, `adaptive` and `course` plans place and write no new sessions. Their flexible sessions inside the pause come off through the existing retraction, so nothing piles up or reads as missed; anything the athlete moved stays. A course's number is untouched: it counts sessions done. On a `coach` plan the pause holds its draft and its prompts, and the coach reworks the sessions if asked; they're designed work, so nothing removes them on its own. The pause ends by itself on its date. It's set by telling the coach, for now.

## 5. One source of truth

### 5.1 One home per fact

| Fact | Its one home | What happens to the others |
|---|---|---|
| When a session is | The row's `effective_date`, `effective_time` | Plan dates computed; `coach_plans` dates and hourly status flip stop being read, then go |
| What a session is | The row's `workout_doc`. For a session made on its day, its current build; before that it has no content, so there's nothing to disagree with | Columns become a cache (§5.2). Stage rows, `stage_summary`, `structured_json` stop being read, then stop being written. A rest day has no document: its row says so. An import whose conversion fails is still written, so COROS never breaks a sync, and the check reports it |
| What a session's move means | The library, by id | Unchanged |
| A plan's contents | Its sessions; ahead of them, `coach_plan_weeks` outline | An outline entry is read only for a week holding no sessions, so the two can't disagree. `state` stops being read. `studio_plans` stops being read |
| The goal race's day | Settings' `raceDate`, the one date the hub, the garden and placement already read, so the garden's history is untouched | A plan's goal reads it, and the sheet's Change race writes it. `coach_plans.race_date` and `programs.race_date` stop being read; where they disagree today, Settings wins and each case is shown to the owner first. Changing the date moves the goal's race session in the same batch when the app owns it; a COROS-owned one keeps today's conflict banner. `athlete_profiles.events` keeps other dated events |
| Which sessions are races | A mark the race verb sets, so tune-ups can be races too | `category = 'race'` isn't a cache of the document: `deriveDoc` calls any race-pace run a race, and the mark must win over that |
| Whether a session is done | `completion_state`, written with its evidence (match, activity link, performed session, or the athlete's own "Mark done") in one batch | `content_state` means only the content's lifecycle; "done" reads move to `completion_state` |
| A plan's progress and adherence | Computed from its sessions, unclipped by dates | Keystone credit reads the computed end |
| The watch copy's name | The verified job's stamp | `watch_copy_name` goes, as `coros-stamp.ts` already warns |

**Snapshots stay:** `workout_doc_revisions`, locked builds, performed sessions, `training_plan_versions`. They record what was, and nothing reads them as what is. Done, skipped and missed rows keep their document: the import stops rewriting their columns.

**What a move does now.** Moving a session changes its date and nothing else. The plan's dates follow by themselves.

**What a shorten does now.** A length-only change to a lift becomes a revision of its document, or is refused with what to do instead. Runs already re-time (`retimeRun`).

**A course's code versus its rows.** A session's written document is the truth for that session. Changing a course's code affects sessions written afterward and never rewrites one already written.

### 5.2 One door for writes

`apps/worker/src/services/session-store.ts` owns every insert and update of `planned_workouts`, with named verbs (place, revise, move, resolve, archive, record-sync-state). A verb takes the whole intent and writes everything that follows from it in one batch. Column values derived from the document come from one function, `sessionColumnsOf(doc)`.

- **A stored derived value is allowed only as a cache:** one writer, from its source, in the same batch, and the check (§5.3) recomputes it.
- **The guard:** a test lists every write to the table in `apps/worker/src`, against an allowlist that only ever shrinks and reaches zero at the end of Stage 3. Restoring an account and the staging copier stay exempt: they copy whole rows verbatim.
- **Completion** gets one verb, and a partial unique index allows one live match per session.

### 5.3 The daily check

A pure `checkAccount(...)` over rows, plans, matches and builds returns violations:
- a cache that differs from what its document computes
- a session whose plan doesn't exist, or that's in two plans' sessions
- completed with no evidence, or evidence on a session not completed
- more than one live match
- a stopped plan with live sessions ahead
- an active plan's outline week also holding sessions
- a course's sessions out of order
- a watch-owed session past its retry ladder

It runs in three places:
1. **After every store verb in integration tests.** A seeded random sequence of verbs must leave it empty.
2. **Daily in the cron,** as one bounded heavy step, paged within the free plan's budget, read-only, never auto-fixing.
3. **On demand:** `GET /api/health/consistency` answers counts and ids, never titles.

A violation surfaces through the existing sync notes, so the athlete sees it, and each kind of violation is a bug to fix at its cause. Nothing silently repairs.

### 5.4 Outside systems, and what can't be promised

- **Watch and Google Calendar are copies in systems the athlete can edit directly.** A difference can't be prevented. The row is the truth for what the app wrote: the app detects a difference, says so with the existing status lines, and repairs one way. COROS stays the truth for sessions it wrote, until the athlete revises one (adoption, as today).
- **"100% accurate" can't be proved of every write.** This design makes wrong writes hard to express, refuses them at one door, and catches the rest within a day.
- **The coach's words can be wrong.** That's why a brief holds intent, and computed facts are never authored (§2.9).

## 6. Stages

Each stage lands on its own, with CI and Deploy green, run in local time and UTC. Each schema change is additive and asks the owner first. Each deploy takes a D1 Time Travel bookmark first; there's no rollback past the Durable Object, so forward fixes only. A stage with behaviour changes lists them and shows them on real data before landing.

**Stage 1. Plans have a purpose.** It lands in small pieces, in this order:
1. Migration 0035: the new columns and the `course` kind. `programs` rows for every existing plan (§3.5), idempotent, with parents backfilled. The list reads this registry; the API's shape stays, with new fields optional. The owner approves the purpose and brief seeded for each existing plan: they live in the database, never the repo.
2. Purpose, brief, objectives and `on_end` reach the coach, and show on the plan sheet (§4.3). `plan_set` and `propose_workout` carry a plan id (§3.4), and `createPlan` must name its plan (§3.2).
3. TRE becomes a `course` plan, written on the day, listed, stoppable, with "Mark done", reading "Session 3 of 10" (§4.2). Pausing (§4.4).
4. The `ask` dialogue and "What's next?" on the plan's row (§4.1), and `finish` (§4.2).
5. The unprompted draft (§4.2), the only piece that adds background spend, so it lands last and alone.

*Done when:* the list shows one row per plan, TRE continues past its last placed session on its own, a pause holds it, tapping the running prompt gets the question, and an ending lifting plan produces one draft that changes nothing until approved.

**Stage 2. Plans are computed from sessions.** Dates, weeks, progress, adherence, ended and week naming read rows. The Studio strength plan's sheet reads its rows. Race day has one home. Hourly status flip retired. `isOneOffPlan` everywhere. *Done when:* the audit's first three failures can't be reproduced in tests. *Behaviour changes to list:* the Studio strength plan's numbers change to the true ones; lifting may now name a week; Keystone credit follows the computed end. Course plans and programmes never name a week.

**Stage 3. One door, one check.** Session-store verbs; the allowlist reaches zero; content readers move to the document; legacy forms stop being written; length-only adjust resolved; completion batched; the daily check on. Expect this to be the largest stage, done file family by file family. *Done when:* the guard's allowlist is empty and the daily check has been clean on production for two weeks, or each violation has a named fix.

**Stage 4. Retire.** Drop what nothing reads: `coach_plans` dates and status, `coach_plan_weeks.state`, `studio_plans` once no pushed session remains ahead, the `race_date` columns, `watch_copy_name`, legacy content columns, `linesOf`. Each drop is its own migration, after a Time Travel bookmark and the owner's OK.

## 7. Constraints

- **Workers Free plan.** At most about 45 D1 statements plus fetches a request, with CPU pinned by the benches; hourly work is one heavy step; D1 binds 100 parameters and 5 compound terms. Computed plan facts must stay within these: the list's read is one or two grouped statements, not a read per plan.
- **Plan ids persist elsewhere** (proposals' ops, trigger evidence, write jobs, URLs): every id is preserved exactly.
- **Public repository.** Purposes, briefs, real plan names and figures live in the database and the private companion, never in a spec, a test or a commit.
- **LifeOS.** The worker moves into the lifeos repo with native screens on the same backend, so route shapes change additively, and new logic goes in pure packages. Check the move's timing before Stage 3: it shouldn't straddle a change of repo.
- **Q-130.** No new screens. Additions to existing surfaces, with their logic in pure modules: on the plan sheet, the purpose, how it ends and the brief one tap down; on the list row, its words and "What's next?" or "Next stretch ready"; on a course session's sheet, "Mark done"; and the one-off label.
- **Concurrent sessions** commit to `main` daily and touch these files. Land small, rebase often, and never hold Stage 3 on a long branch.
- **Prompt size.** `coach-shape-pins` caps the prompt: rebase with a dated note if the plan line needs room.

## 8. Testing

Failing test first, then mutate each guard, per the principles §9.
- **Pure:** computed plan facts, table-driven, including a moved last session, an outline week with sessions, overlapping phases, several sports and an empty plan. `isOneOffPlan`. Course numbering with skips, misses and "Mark done". A pause starting, ending and overlapping a race's quiet days. `checkAccount`, each violation seeded.
- **Integration:** the seeded random sequence of store verbs (§5.3). Hourly course placement idempotent, within budget, undoing nothing the athlete did. A course session written exactly once whichever comes first, the pass or the open. Stop removing every live session ahead, on the watch and calendar too.
- **The draft:** one run per ending, however many hourly passes see it; none at the cap; failure falls back to the chip; nothing on the plan changes before approval.
- **Scenario evals (coach):** the dialogue asks on a tapped chip; doesn't when the request already says; uses a relevant goal; reads the brief; continues a line as a phase of the same plan; a drafted stretch files under the plan and respects its brief.
- **Parity before each read switch:** the garden's full-history hash and DTO hashes, as Phase 5 specified, with listed behaviour changes as the only differences.

## 9. Decided, my calls, and left to the builder

**The owner decided**
- The definition (§1); purpose and how sessions are made as the abstraction; nothing drifts.
- Running asks through the coach about extending and the goal; most other plans continue without asking, TRE among them.
- A coach-made plan that isn't running continues by an unprompted draft the athlete taps to approve (§4.2): a recorded exception to "nothing starts without the athlete's tap", to add to the principles' §12 on approval.
- A course session is written on its day, so its number counts sessions actually done, and it reaches the watch that day rather than weeks ahead (§4.2).
- Approved 2026-11-06 with the additions from a final stress test: pausing, `finish`, a plan naming the plans it continues, objective links, "What's next?" on the row, "Mark done", and the brief visible on the sheet.

**Considered, and deliberately not generalised**
- **Courses as stored data rather than code.** A coach plan with a strict brief covers a one-off protocol. Worth doing when a second or third fixed course appears; `config.course` is a lookup, so the change stays small.
- **Plans inside plans.** Phases are the only nesting, and nothing has needed more.
- **More than one goal race at a time.** Other dated events live in the profile.
- **A rule language for how plans end.** Three values cover every case found.

**For later (the LifeOS ideas list, since they're new flows)**
- A Pause button on the plan sheet.
- A check-in two days after a TRE session that sets the halving by itself.

**My calls, for the owner to check**
- `programs` as the registry, and `coach_plans.program_id` for phases, instead of re-pointing sessions or mirroring blocks into `programs`. It rewrites no session row and copies nothing.
- A stored plan link, replacing derived lines (the training-lines design's listed veto option), because a plan's purpose needs a home.
- 21 days as the "ending" horizon, kept from today's chip.
- Asks-first as guidance plus an eval, not a code gate.
- Daily check reports, never repairs.
- Course plans and programmes don't name the week.
- Settings holds the goal race's day, not a session: it's what the garden's history already replays from, and it allows one goal race at a time, which matches how the app is used.
- `plan_set` and `propose_workout` gain a plan id (§3.4). Existing one-offs aren't re-filed.
- An engine session's content stays its build rather than a copy on the row (§5.1), so Condition care changes least.
- `on_end` is limited by kind (§4).
- The 48-hour rule lives in the move's how-to and the brief; nothing applies it automatically (§4.3).
- Phase 5's dual-write mirror is dropped: copying into a second table during migration is the problem this design removes. Reads switch stage by stage instead.

**Left to the builder**
- The verbs' exact names and signatures; the order of file families in Stage 3.
- How the list's reads stay within budget.
- The health route's exact shape, and the sync note's wording.
- Whether `sessionColumnsOf` extends `deriveDoc`, and how a race mark survives it.
- How `planId` passes through the proposal's stored ops.
