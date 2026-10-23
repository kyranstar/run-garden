# Training lines: fewer plans, one per thing you're training for (design, 2026-10-20)

**Status:** draft for the owner's review.
**The ask (2026-10-20):** "It's kind of annoying how many plans I have. I should really only have a couple. The adhoc ones shouldn't be plans … maybe at the very least having them expire."
The owner chose option B, "training lines", from three:
- A: tidy up only;
- B: phases chain into one plan;
- C: one standing plan per sport.

**Research:** a read-only map of every plan reader and writer, with file:line references. Its findings are summarised in §2.

## 1. What changes, in one paragraph

"Your plans" shows one entry per thing being trained:
- **One line per sport.** A coach-made running plan built from several blocks in a row (a bridge block, then a base block, then a race build) reads as one entry, **Running**. Its phases sit inside it ("Phase 2 of 3 · Base block · week 1 of 4"), and its goal is "toward <race day>" when its last phase has one.
- **Studio plans and programmes** stay one entry each, as now.
- **One-offs.** The coach's one-off sessions are never listed as plans. They stay on the week and the calendar as ordinary sessions.
- **Ended plans.** A plan whose last day has passed leaves the list at once and moves to **Past plans**, one tap down. It no longer waits for the hourly job.
- **No database change.** Lines are worked out when the plans are read, so nothing in the database changes and nothing needs migrating.

## 2. Why there are so many today

Each of these causes has its own fix in this design:
1. **Every session must belong to a plan.** `planned_workouts.plan_id` is NOT NULL.
   - So each one-off the coach adds is filed in a per-sport bucket (`adhoc-<sport>-<user>`, named "Coach one-offs", created by `ensureAdhocPlan`).
   - The buckets are listed as plans: one each for lifting, mobility and running.
2. **The coach starts a new plan for each phase.** Nothing links one block to the next. `read_plans` even tells the coach to "plan what comes after it as a new plan". Three blocks in a row therefore show as three plans.
3. **An ended block stays "active" until the hourly sweep flips it.** Until then it reads "Week 4 of 4 · ends <past date>". After the flip it disappears, and there is no Past view.
4. **The chips are block-blind.** "Plan what comes after my <block> plan" fires even when the next block already follows on.

## 3. Decisions (vetoable)

1. **Lines are worked out at read time; no link column.**
   - **Rule:** a line is a maximal chain of the athlete's coach blocks of one sport, excluding buckets and retired blocks, ordered by start date, where each block starts no more than 8 days after the previous one ends — at most 7 whole rest days between, so a full rest week between two Monday-to-Sunday blocks keeps one line (owner, 2026-10-23; it was 7 days, which split such blocks). Overlapping blocks join too.
   - **Why derived:**
     - The existing data already chains (the owner's three running blocks abut exactly).
     - Nothing has to be backfilled in production.
     - A new block the coach places right after a line joins it automatically.
     - A real break of more than a week starts a new line, which is what a break is.
   - **The cost:** a line has no stored name or identity.
     - Its name is the sport ("Running", "Lifting", "Mobility").
     - The API gives each line a `key` (`<sport>:<first phase id>`) for the UI to key and open it by, plus `currentPhaseId` for the actions that act on a phase. Neither is stored.
   - **Veto option:** a stored `line_id` (one nullable column and a migration). It is only worth it if derived chaining proves wrong in practice.
2. **What a line row says.**
   - The sport's name.
   - The goal, when the line's last phase has its own race day (`planRaceDate`, never Settings' fallback): "Toward <race day>".
   - The current phase: "Phase 2 of 3 · <phase name> · week 1 of 4".
   - Before the line starts: "Starts <date>".
   - A line of one phase reads exactly as a block does today.
3. **The line's sheet.**
   - It shows the phases in order: past ones collapsed, the current one open with its weeks as today, later ones as a heading and dates.
   - **Rename** is per phase, from the phase's own heading.
   - **Change race** applies to the last phase, which is the line's goal.
   - **Extend** and **Wind down** apply to the last phase. These are the line's end, and the words they write say so: "Extend my running plan by two weeks".
   - **Retire** becomes **Stop this plan**. It retires the current phase and every later phase, with one confirm that says how many sessions leave the calendar, and never touches past phases.
   - Adherence and the garden's credits stay per phase, so the Keystone pine and grove are unchanged.
4. **One-offs aren't plans.**
   - **The data stays.** The buckets remain as internal containers, because `plan_id` stays NOT NULL. They are never listed: not in "Your plans", not in the coach's plan reads, not in the dormant dossier.
   - **The bucket's Rename and Retire go away.** That was the only bulk clear of one-offs; a one-off is skipped or removed from its own sheet as any session is.
   - **A one-off's own sheet** says "One-off" where a plan session would name its plan.
   - **Internal uses are unchanged.** The authorship check (`guardrailCtx.coachPlanIds`) still knows the bucket ids, because a one-off is still the coach's.
5. **Ended means past, at read time.**
   - **What counts as ended:**
     - a block, once its `endDate` is before today in the athlete's zone;
     - a line, once its last phase has ended;
     - a Studio plan, once its end has passed (as it already reads).
   - **Ended plans leave "Your plans" at once.** They appear under **Past plans**, a disclosure at the foot of the list: the most recent first, each with its dates and adherence, opening the same sheet read-only.
   - **Retired plans stay out of the list**, as now.
   - **The hourly sweep still flips the stored status** and writes the "Block complete" receipt, unchanged. The read-time rule only stops the list waiting for it.
   - **`propose_plan` gains the same rule:** a block past its end can't be extended by id. The coach proposes the next phase instead, which the line picks up.
6. **The week line and the brief agree, and see lines.**
   - **One rule picks the phase that names a week:** the current phase of the line holding the most sessions that week. Ties go to the run line with a race, then to the earlier start. The server (`covering`) and the client (`week-view`) both use it, from one shared function in `@rg/domain`.
   - **Phases of one line never count as "+1".** Only a different line does.
   - **Paging back to a past week** still names that week's phase, including a past one.
   - The week-jump menu numbers weeks within the line.
7. **The coach sees lines.**
   - **`read_plans`:**
     - lists each line with its phases (past ones within 30 days, as now);
     - lists the Studio plan, read-only. Today the coach can't see it at all;
     - replaces "plan what comes after it as a new plan" with: "to continue a line, propose its next phase starting the day after the line's last phase ends; it joins the line".
   - **The chips (`coach-nudges`):**
     - **"Plan what comes after my running plan"** fires only for a line's last phase ending within 21 days, and only when no next phase follows.
     - **"Fill in next week"** names the line: "Fill in next week of my running plan".
   - **The sleeping thread-coach trigger `plan_ending`** gets the same line rule, so it is right if it is ever switched back on.

## 4. What the owner sees

On deploy, "Your plans" shows three entries:
- **Running**, with three phases;
- **the Studio strength plan**;
- **the programme**.

The three "Coach one-offs" entries are gone, and their sessions stay where they are. When the bridge block ends on Friday, Running moves to its next phase on its own. Nothing moves to Past plans until the whole running line has ended.

## 5. Out of scope

- Making `plan_id` nullable, or moving one-offs out of the bucket rows.
- Merging programmes or Studio plans into lines.
- Any change to the COROS-imported plan entries (they already leave once they hold no future run).

These are reconsidered only if the result still feels like too many.

## 6. Risks and how they're covered

- **Chaining a block that shouldn't chain.** Example: a coach-made 1-week deload placed 5 days after a block. That is fine: it is part of the line. A separate goal started after a week's rest or less from another of the same sport would wrongly chain. Tests pin the rule (7 rest days join, 8 split), and the veto option (a stored link) stays open.
- **Two readers disagreeing about the phase that names a week.** One shared function, pinned by a table of cases that both the server and client tests run.
- **Bulk "Stop this plan".** The confirm names the count. Past phases and completed sessions are never touched, which is pinned. It uses the existing chunked `retirePlan` per phase, within the per-request statement budget.
- **Budgets.** Lines are grouped in memory from the rows `GET /api/coach/plans` already reads, so no statement is added. The line sheet reads its phases' details in one request, within 45 statements, or the client pages them. The plan decides which, and the result is measured and pinned.

## 7. Testing

- **Pure functions** in `@rg/domain`: the line grouping (`linesOf`), the ended rule, the week-naming rule and the row's words.
- **Table-driven tests:**
  - abutting blocks;
  - 7 and 8 whole rest days between two blocks (one line, then two);
  - overlaps;
  - a retired middle phase;
  - a bucket among blocks;
  - a line all past;
  - a one-phase line;
  - a Studio plan beside a lifting line.
- **Route tests:**
  - `/plans` returns no buckets;
  - lines and past plans;
  - `read_plans` shows lines and the Studio plan;
  - the chips' line rules;
  - "Stop this plan" retires only the current and later phases.
- **UI tests:** "Your plans" with lines and Past plans, the line sheet's actions, and a one-off's sheet saying "One-off".
- **E2E:** extend coach-plans or coach-plan-retire for a two-phase line, both projects.
- **Each change:** RED first, then mutants on the pure functions.
