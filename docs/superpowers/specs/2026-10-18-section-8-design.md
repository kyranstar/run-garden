# §8: designed runs, whole plans from the coach, and the thread coach steps back (design, 2026-10-18)

**Status:** this builds §8 of `2026-10-17-new-shape-design.md`, which the owner approved ("ship this all … go ahead
autonomously"). It started on the owner's "okay continue" after the new shape went live (prod 25723ee). The decisions
the lead took for the owner are listed in §2; each can be vetoed.
**Research behind it:** `.superpowers/sdd/2026-10-18-section-8/research-*.md` (three read-only reports, with file:line
references). **Principles:** `docs/principles/workout-system-principles.md`.

## 1. What changes, in one paragraph
The conversation coach becomes the only coach.
- **Runs.** It designs them. A designed run is a workout document with warm-up, run and cool-down parts. Its efforts
  become pace bands from the athlete's own threshold, the validator and the reviewer judge it as a run, and once
  approved it goes to the watch as the thread coach's runs do today.
- **Plans.** It works on whole plans. It reads the athlete's plans and can build, extend, firm up, wind down or retire
  one, as one card the athlete approves. It applies them through the thread coach's proven appliers, which are made
  resumable so that a whole plan fits the per-request budget.
- **The old coach.** The thread coach's engine is switched off: no more wakes on Plan visits and no more automatic
  spend. Its free signals (a missed session, a plan running out, a race close) become "needs you" chips on the coach's
  opening screen, and spend only when the athlete taps one.
- **Plan's buttons.** Extend, Wind down and "Plan with the coach" open the conversation with the request written.

## 2. Decisions (taken by the lead under the owner's autonomy; vetoable)
1. **A designed run goes to the watch when it is approved**, as the thread coach's runs do now. This happens only
   when COROS writes are on. It lands in the coach lane, so the body check, adjust_plan's ease and Undo all work on it
   unchanged.
   - **Why:** a run has no in-app player, so the watch is where it is done, and approving it is the athlete's consent.
   - **Unchanged:** the Studio rule that "only the athlete's Send" puts a *strength* document on the watch.
   - **Revising a designed run:** through the coach (adjust_plan, or a new suggestion), not the Studio builder.
2. **What the watch gets (phase 1):** time steps with roles (warm-up, work, recovery, cool-down) and pace bands.
   - The bands come from the athlete's threshold, computed when the run is sent, so the freshest threshold applies.
   - Repeats are written out step by step, at most 60 steps.
   - A distance segment goes as its time at the band's middle pace, and the card says so ("on your watch as 42 min").
   - With no threshold known, the steps carry no pace, and the card says the watch will show time only.
   - This stays inside the wire shape the app already writes and verifies.
3. **Distance targets and repeat groups on the wire (phase 2)** are built and pinned byte for byte against COROS's own
   captured programs, behind a switch that is off. They are switched on only after one live check on the owner's
   account (create on a far date, read back, delete), which needs the owner's explicit yes.
4. **A whole plan's sessions are the thread coach's session specs**, the same shape `createPlan` writes today, not a
   reviewed document per session.
   - **Why:** cost. At about $0.70 per designed workout, a 16-session block would pass the $6 set ceiling.
   - **What a plan holds:** one or two weeks filled in, the rest as shape weeks. The "needs you" chip offers to fill in
     the next week when it comes close.
   - **Watch:** plan sessions go to the watch as the thread coach's do today.
5. **Retire stays the app's own confirm** (no model call). Extend, Wind down and "Plan with the coach" open the
   conversation with the request written, and the athlete sends it.
6. **The thread coach is switched off, not deleted.** A `THREAD_COACH` switch is on only when it is "1", and is off in
   production.
   - **Kept:** its routes (for cached old clients) and its tables. Old proposals stay approvable until they expire,
     within 3 days.
   - **Its outputs:** the focus line and the race line fall back to their deterministic text; the race line gets a
     plain phase sentence.
   - **Untouched:** ambient activity reads (about $0.10 a week) and the Monday review.
   - **Escape hatch:** the switch can be turned back on as a Worker secret, without a deploy.
7. **Not in this wave (the owner's yes needed first):**
   - turning the memory copy into a move;
   - deleting the thread coach's code, tests or data;
   - the phase-2 live wire check.

## 3. Designed runs (stream R)
- **Document:** v1 as it stands. A run document has a `warmup` part, one or more `run` parts (format `intervals` with
  `rounds` for repeats, holding the work and recovery items) and a `cooldown` part.
  - Each run item has an `effort` (one of the 11 `RUN_EFFORTS`), a target (`durationSec` or `distanceM`), a `why` and
    an optional `cue`.
  - **The coach authors the effort; code computes the pace.** An authored pace is allowed only when the athlete asked
    for one (race pace, a stated band).
- **Pace:** `paceBandFor` covers all 11 efforts from threshold. `by_feel` and `strides` get no band.
  - One function serves the card, the validator and the wire.
- **Validator** (new run codes, in the package's validator):
  - `run_mixed` (error): run items appear only in a run document, and a run document holds only run items. This closes
    the hole where a strength document carries a run part.
  - An `open` segment is an error.
  - An authored pace far from its effort's band is an error.
  - With no threshold, a warning ("pace owed").
  - Code-countable load:
    - a quality run within 48 h of another quality run or of hard lower-body strength (warning);
    - a long run over about 30% of the week's planned running (warning);
    - a jump of more than about 10% over the last four weeks' average volume (warning).
- **Context:** one statement brings the athlete's threshold pace, the computed bands and four weeks of run volume.
  - This goes into the opening context when the request or the seen object is about a run, or always if under about
    300 characters (pin the size).
- **Reviewer:** the rubric is chosen by the draft's discipline.
  - **For runs:** structure (warm-up → work → cool-down; the intensity fits the day), progression (volume and long-run
    share against history), recovery (hard runs and hard leg strength nearby), pace (bands fit the effort and the
    athlete's threshold), and intention (the `why`).
  - `parseReview` takes the draft's own dimension list.
- **Prompt:** "never design a run" goes, from the main coach, the designer and `plan_set`.
  - Say when a run is right: the athlete asks, or the plan's day is a run.
  - Say that efforts are named and paces computed.
  - Repeats go in an intervals part.
  - Keep the prompt and tool descriptions generic (no personal facts).
- **Approve:** a run branch in the new-workout op writes the coach-lane row:
  - columns from `deriveDoc` (sport run, category, length, `expectedDistanceMeters`);
  - stage rows from `stagesFromDoc`;
  - the document at rev 1 (`sourceKind: coach`);
  - a `coach_create_workout` job when COROS writes are on, and its drain in the answer.
  - Statement costs are re-pinned within the request budget of 45.
- **Wire:** a new session variant for the job (`run_watch`), built at execution by a new builder dispatched in
  `buildProgramFor`.
  - The create and update job schemas take the union, so the body check's ease and Undo rewrite with the same builder.
  - `watchPushable` and `watchCoverage` learn the shape.
  - "The preview is the wire": the card's steps are built by the same function.
- **Phase 2 (behind the off switch):** distance steps (`targetType 5`, metres × 100) and repeat groups (`exerciseType 0`,
  `isGroup`, `sets`), golden-tested against the captured programs. The renormalizing mock learns distance.
- **UI:**
  - **The suggestion card for a run:** its steps with effort, time or distance and pace in the athlete's units, the
    total time and distance, and "Goes to your watch when you approve" (or "Your watch will show time only").
  - **Today and Plan:** they show a designed run as they show a plan run now. The Start / View workout rules are
    unchanged.
- **E2e (scripted):** a request for a run → a run card → Approve → the row and its queued watch job, with the stored
  wire's pace bytes checked on the COROS mock.

## 4. Plans that resume (stream P)
- The thread coach's structural ops are `createPlan`, `extendPlan`, `windDown`, `retirePlan`, `firmUp`, `reshapeWeek`
  and `resolveRaceConflict`. Each is applied in **chunks within a statement budget**:
  - The chunk entry point is `applyStructuralChunk`, exported from `coach-apply.ts`.
  - It takes the op, its saved progress and a budget, and returns the new progress (or finished) and the statements it
    spent.
  - Ids stay deterministic (keyed by proposal and op index), so a retried chunk does nothing twice. An archive slice
    re-reads what is still scheduled.
- **The thread approve route** (`POST /api/coach/proposals/:id/approve`, for thread proposals) and
  **`POST /api/coach/plans/:id/retire`** use the chunks and answer `remaining` until done. The current client already
  repeats an approve while `remaining`; check the thread path does too, and make it do so if not.
  - **Why:** today a seven-session `createPlan` costs 68 statements against the free plan's 50 per request, so it
    likely fails partway.
- **Budget:** each request stays at or under 45 statements, pinned for create (7 and 40 sessions), extend, wind down,
  retire (a plan with 30 future rows) and firm up.
- **Partial plans:** between requests, a half-applied plan reads sensibly; nothing is half a row.
- **The firm-up gap:**
  - `createPlan` writes `firm` week rows for the weeks it fills.
  - The `plan_horizon` rule counts firm sessions, not only firm rows.
- **CPU:** a bench shape for one create chunk and for `validateOps` over a 40-session plan.

## 5. Whole plans in the conversation (stream W)
- **`read_plans`**, a read tool: the athlete's plans (coach blocks, adaptive programmes, watch plans), each with id,
  kind, name, start, end, race date, firm and shape weeks, the next three sessions, and whether the coach may change
  its structure (only plans it wrote).
  - It costs a few statements, pinned. `read_plan`'s summary points to it.
- **`propose_plan`**, main role only. It takes one structural change, `{ change: createPlan | extendPlan | windDown |
  retirePlan | firmUp | reshapeWeek, …the CoachOp's fields, why }`.
  - **Validation:** `coachOpSchema` and the thread coach's own `validateOps` / guardrails. A fatal finding is refused
    in words, and advisories are kept on the op.
  - **Storage:** a designed proposal with one op of the new kind `plan_structure`.
  - **Size:** at most 2 weeks filled in and at most 40 sessions per proposal.
  - **Ceiling:** the first call raises the run's ceiling to the set ceiling, once, as `plan_set` does, and only when
    the athlete asked for a plan or a stretch of weeks.
- **`programme_change`** (last, if the wave has room): one op mapped onto `updateProgram` + `placeSlots` (weekly goal,
  preferred days, length, modes, care) for an adaptive programme. Approved the same way.
- **Approve:** `design-approve` applies `plan_structure` after plan changes and before workouts, as its own cost
  class, through P's `applyStructuralChunk`, under the existing claim / takeover, answering `remaining` until done.
  The outcome is recorded on the op.
- **Every reader of designed proposals tolerates the new kind:** `isDesignedOp`, `opIdOf`, `statusOfOps`,
  `designedLines`, `read_proposals`, the supersede and expiry sweeps, `cardsOf` / the conversation block, and export
  and restore.
- **Card:** the conversation gets a card of kind `"plan"`: `{ kind: "plan", proposalId, title, summary, status, lines:
  string[] }`.
  - `lines` are the thread coach's own `describeOps` lines, at most 8, then "and N more".
  - One **Approve plan** and one **Not now**, because a whole plan is one intention.
  - While it applies, the card says so and keeps approving while `remaining`; when done, "Added to your plan" with a
    link to Plan.
- **Prompt:**
  - Read the plans before changing one.
  - Build a plan only when asked.
  - Fill in one or two weeks and leave the rest as shape weeks.
  - Ask (`ask_athlete`) when the goal, date or days are unclear: never a form, one question at a time.
  - The "needs you" chips arrive as the athlete's words.
- **E2e (scripted):** "Plan my next four weeks toward a 10K" → a plan card → Approve plan → the plan in Plan's "Your
  plans" and its first week's sessions. "Extend it by two weeks" → extendPlan → approved.

## 6. The thread coach steps back (stream T)
- **The switch:** `THREAD_COACH` (on only when "1"). It is pinned in `wrangler-config.test.ts` and absent from
  production's vars (so off). The fixture stack sets it for the two replay specs that need it, until they are retired.
- **When off:**
  - `/coach/state` says `wakeAdvised: false`, and no triggers are evaluated into wakes.
  - `/wake` answers `{ status: "skipped" }`.
  - `/message` stores the athlete's words with a receipt ("Your coach is now behind the Coach button") and leaves no
    unanswered mark.
  - Question answers are stored as facts, with no wake.
  - Approve and decline of old proposals still work.
  - The hourly cron stops evaluating triggers.
- **The UI:** the Plan page no longer wakes the thread coach on mount (`usePlanCoach`'s auto-wake goes).
  `ThreadCoachCards` stays and renders nothing when there is nothing pending.
- **"Needs you" chips:** a free read gives the opening screen up to two chips from the old trigger rules, computed on
  read with no rows written:
  - a missed session in the last 2 days → "Rework my week around Tuesday's tempo";
  - back after 7 or more quiet days → "Ease me back in";
  - a plan ending within 21 days → "Plan what comes after my half marathon plan";
  - the next week not filled in within 14 days → "Fill in next week of my 10K plan";
  - a race within 21 days → "Get me ready for race day".

  Each chip is `{ id, label, request }`. Tapping it sends the `request` as the athlete's words, and that is the only
  spend. They join, and come before, the general starters. Their cost is pinned.
  - The read's place: the conversation's own read, or a new `GET /api/coach/nudges`. T chooses and tells the lead.
- **Plan sheet:**
  - Extend → `useCoach().open({ request: "Extend my <plan> by two weeks" })`.
  - Wind down → `open({ request: "Wind down my <plan>" })`.
  - "Plan with the coach" comes back in Your plans → `open({ request: "Help me plan my next few weeks" })`.
  - The words are written, not sent, and the athlete sends them.
  - Retire stays as is (P's chunked route).
  - `coach.send` and `THREAD_REQUESTS` go.
- **Race line:** a plain phase sentence from race-hub when there is no recent thread race line ("3 weeks to go —
  sharpening, then the taper").

## 7. Constraints (unchanged)
- **Platform and budgets:** Workers Free (CPU per request), at most 45 D1 statements per request as pinned, and the
  $20 weekly AI cap.
- **Data and deploys:**
  - no schema change (none needed: ops are JSON, plan tables exist);
  - no rollback past the Durable Object class, so forward fixes only;
  - no COROS or Calendar writes beyond what the athlete's approvals queue.
- **Tests:** no live model calls (scripted model). The rolling 7-day spend was $17.85 of $20 on 2026-10-18.
- **Product:** nothing personal in the public repo, a gentle tone, accessibility, both themes, and phone width first.

## 8. Streams and ownership
| Stream | Owns |
|---|---|
| **R** designed runs | `packages/domain` pace + workout-doc run helpers, `packages/workout` validator run rules, `packages/coros` run builder (+ phase-2 builder), worker `designed-runs.ts` (new), the run branch in `design-approve.ts`, `jobs.ts` schema union, `buildProgramFor` dispatch, `watchPushable` / `watchCoverage`, design prompt and review run parts, the run suggestion card, its tests and e2e |
| **P** resumable plans | `coach-apply.ts` structural ops and `applyStructuralChunk`, the thread approve route's structural path and `/plans/:id/retire` in `routes/coach.ts`, the firm-rows gap, budget tests, the bench shape |
| **W** whole plans in the conversation | `design-tools/read-plans.ts`, `design-tools/propose-plan.ts` (new), the `plan_structure` op through every designed-proposal reader, its apply in `design-approve.ts`, `programme_change`, the prompt's plan parts, the conversation `plan` card (UI + api-client type), its tests and e2e |
| **T** the thread coach steps back | the `THREAD_COACH` switch, `routes/coach.ts` wake / message / state / answer paths, `coach-triggers.ts` and the nudges read, the hourly cron, the opening screen's chips, the Plan sheet's actions and "Plan with the coach", the `usePlanCoach` auto-wake removal, the race line |

**Shared files** (commit HEAD + your hunks): `design-prompt.ts` (R, W), `design-approve.ts` (R, W), `routes/coach.ts`
(P, T), `coach-conversation.ts` (R, W), `packages/api-client/src/index.ts`, `packages/ui/src/styles.css`,
`packages/domain/src/index.ts`, and the conversation view's card switch (R, W).
