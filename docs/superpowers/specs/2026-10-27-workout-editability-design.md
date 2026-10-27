# Workout editability — design

Date: 2026-10-27. Status: **approved by the owner** (answers in §10). Follows the saves-flow redesign (`2026-10-26-saves-flow-redesign-design.md`); fixes what the first real fit exposed. A second project, "the watch mirrors the plan" (automatic sync), follows this one and is NOT in scope here (§7).

## 1. Intent

The owner's rule: **the coach can edit any workout.** Where there is a clear reason it can't, that reason comes with a path forward, and the coach (and the Studio) know a workout's editability *before* acting on it, never only from a refusal. A fit that ends without placing anything hands the batch back at once.

What happened (2026-10-27 21:50 UTC): the first fit run drafted a revision of tomorrow's coach session, the validator passed it, and `propose_workout` refused it as `not_editable` ("It isn't a Studio or template workout"). The coach stopped there. Nothing released the batch, so Today read "Fitting in…" for an hour. Every one of the owner's upcoming sessions with a document is refused the same way.

## 2. Why the rule exists today, and why it can go

A row's `origin` decides who owns its content. `studio`/`template` rows are **document workouts**: the document is the truth; stages are built from it at session time; imports, the watch and the hourly document backfill leave them alone. Rows with `origin` NULL are **watch-shaped**: the coach's own plan sessions (`cw-` ids, written by `coach-apply.ts sessionRowInsert`) and COROS-plan imports. Their truth is stage rows + `structured_json` + the copy on the watch; their document is a derived copy. Revising only that document is not safe: the plan still renders the old stages, the import's content rewrite and `plan-repair`'s rename set the document aside, and the thread-coach retime rule keeps treating the stale stages as the row's blocks. That is the clear reason — and it is a reason to *convert the row*, not to refuse.

Production at the time of writing (upcoming, scheduled, with a document, origin NULL): ten COROS-plan sessions (with stages, on the watch) and seven coach sessions (two without stages, five with), all on the watch. Zero `studio`/`template` rows upcoming. (These facts stay out of tests: fixtures use invented ids and titles.)

## 3. Decision: a revise adopts the row

**Adoption.** A revise (the coach's `propose_workout` revise approved, or the Studio's `PUT /api/workouts/:id/doc`) of a revisable row whose origin is not app-authored converts it into a Studio document workout in the same atomic write that stores the new document:

- `origin` → `studio`; the new `workout_doc`, `workout_doc_rev` +1 (a row with no document yet revises from rev 0), `title`/`category`/`sport`, booked length, calendar state — exactly as a Studio revise writes them today;
- its stage rows deleted; every content column `createDocWorkout` writes as null cleared: `structured_json`, `stage_summary`, `expected_distance_meters`, `quality_subtype`, `source_estimated_duration_seconds`, `duration_estimate`, `source_version`; `source_content_fingerprint` set as `createDocWorkout` sets it (builder's call M1);
- `plan_id` kept: an adopted row stays in its plan, so Stop this plan and a week re-plan still archive it, and an `adhoc-` one-off still reads as one (M4);
- its **watch address kept** (`source_workout_id` and the COROS id the row carries): the copy on the watch now belongs to this row (§4).

After adoption the row is app-authored, so the existing guards do the right thing without change: the backfill fills only rows with no document and never touches it; the import's content rewrite skips it; `plan-repair` keeps its document; the thread-coach retime rule (`adjust-retime.ts threadCoachRun`, which needs stage rows) no longer matches it; Undo is refused as for any app-authored row. The lane already supersedes a queued `coach_create_workout` / `coach_update_workout` for a row that is app-authored when it claims the job (`coros-write-cloud.ts`), so the adoption write queues no cancel (A2). A create the lane had **already claimed** when adoption lands can still put the old session on the watch and write its address onto the row: it counts as "being sent", so the row reads older-on-watch (M8, §4).

**Not adopted, with a path forward** (the clear reasons; every refusal and every read carries the `instead`):

| reason | when | why (shown) | instead (shown) |
|---|---|---|---|
| `programme` | `origin = program` or `on_demand` (the engine builds it on its day) | It's a programme's session: the programme builds it on the day. | Put moves in its pool with pin_moves, change the programme with change_programme, or propose a new workout for that day and skip the slot with adjust_plan. |
| `resolved` | completion done / skipped / missed | It's already done. / It was skipped. / It was missed. | Propose a new workout. |
| `under_way` | content started / done | It's under way. | Propose one for later. |
| `run` | its document is a run; with no document, `sport`/`category` says run | It's a run: runs are re-planned, not revised. | adjust_plan changes its length or eases it; propose a new run to replace it. |
| `rest` | category rest | It's a rest day. | Propose a new workout for that day. |
| `race` | category race | It's race day. (adjust_plan's `race_day` wording) | Leave it; design around it. |
| `past` | its date is before today | Its day has passed. | Propose for today or later. |

Archived rows are `not_found`, as now. Error codes: `past` keeps `past_date`, `run` keeps `run_unsupported`; the rest are `not_editable` with `cause` = the reason (`resolved` replaces the three completion causes; `programme`, `under_way`, `rest`, `race`; `unknown` stays for an applier miss). The UI's cause words follow (M5).

## 4. The copy on the watch (owner's answers, §10)

Until the sync project lands, the app can push a document workout only on its day (the Studio's Send). So:

- **A changed session keeps its old copy on the watch, marked older, until the new version goes on.** The row reads "older on watch" (`watchHoldsOlder` true) when it carries a watch address whose copy was not pushed from a session build, or a coach create is in flight for it (A3, M8). The Studio's Send on the day **replaces** that copy: it takes the old one off (the stamp-checked delete the coach lane already uses for its own rows) and pushes the new build. Remove, and Stop this plan / a week re-plan, take the old copy off the same way (A4). A Plan move of an adopted row still moves its copy (today's `appOnlySession` rule, unchanged).
- **The import keeps the copy attached to the adopted row** (A1): a wire workout at an adopted row's address is claimed by that row (today only a verified program push claims one for an app-authored row), so the read neither inserts a duplicate nor collides on `planned_workouts_source_unique`. Adopted rows are recognised by `origin = studio` with a watch address, not by id prefix.
- **A session from the COROS training plan may be changed like any other** (owner: "we should be able to change any session"). Adoption takes ownership of it; its original stays on the watch as the "older" copy and is replaced by the app's Send. This deliberately reverses `plan-mutations.ts`' "an imported COROS session is never touched on the watch" for adopted rows only: a row the owner or the coach has rewritten is the app's.

## 5. One predicate, everywhere

`revisability(row, today)` in `@rg/domain` (next to `docOriginRow`): inputs `origin`, `category`, `sport`, `completionState`, `contentState`, `effectiveDate`, `archived`, `hasDoc`, `isRun` (from the document when there is one; from sport/category with none); returns `{ ok: true, adopts: boolean }` or `{ ok: false, reason, why, instead }` with §3's exact strings. `docOriginRow` keeps its meaning (a row whose document is already the truth) — adoption makes it true afterwards; nothing else changes its semantics.

Used by, replacing their own rules: `propose.ts whyNotEditable`; `design-approve.ts notEditableCause` + `NOT_EDITABLE_WHY` (the `programme` mislabel for NULL-origin rows goes); `doc-workouts.ts reviseDocWorkout` (its pre-check, and its SQL guard `inArray(origin, DOC_ORIGINS)` → `origin IS NULL OR origin NOT IN ('program','on_demand')` — the NULL trap, M2); `adjust-plan.ts` `revise_instead` (same inputs, the table's strings); the Studio's `editableWorkout` (`add-model.ts`) and `doneWith` (`session-sheet.tsx`), so the owner can open and edit these rows in the Studio too, through the same adopting `PUT`.

## 6. The coach sees it first

Every read that lists a planned workout carries `revisable`: `true`, or `{ no: <why>, instead: <instead> }` — `read_plan` items (beside `rev`), `list_workouts` and `get_workout` (beside `rev`), `read_plans`' next-session line, and the opening context's plan lines (`design-context.ts planItemWords`: a short marker). A NULL-origin row no longer prints nothing for its origin: it reads "coach session" (`cw-`) or "watch plan session" (a COROS plan), and `revisable: true`.

Prompt guidance (`design-prompt.ts`): the lines "a Studio or template workout is revised with propose_workout" (adjust_plan's line, the now/later-today line, the planned-workout opening) become "a workout whose revisable is true is revised with propose_workout (target revise, from get_workout's rev); one whose revisable says no: take its instead"; the fatal list keeps "a workout that is resolved or built by a programme" and adds "— its revisable says so and names what to do instead". `# Integrating saved moves` adds: "A refusal is never the end of a fit: take the refusal's or the read's instead (pin_moves puts the moves in the pool; a new workout places them), then finish." The `not_editable` refusal's fix text becomes the row's `instead`.

## 7. A fit ends when its run ends

The batch id lives in the run's `state.settings.savesBatchId` (A6). When the **main** run of a fit reaches a terminal status with no proposal (none from this step, none on the run, none from "propose what it has") — in the run-end write (`coach-runs.ts`, where `finishedAt` is set), in `cancelRun`, and in the stale sweep that fails a run (M6) — clear that batch's `fit_started_at` in one statement: `where id = batch and user_id = user and fitted_at is null and fit_started_at is not null and fit_started_at <= run.created_at` (`fitBatch` stamps the batch before the client creates the run, so the guard holds). Never an error once the run's end is written. The app re-reads the open batch on focus (`staleTime 0`), and the coach surface invalidates it when a fit run ends, so "Fit them in" is back the moment the coach answers. `FIT_STARTED_TTL_MS` stays as the backstop.

## 8. Non-goals

Automatic watch sync (pushing ahead of the day, re-pushing on the day, automatic removal): the next project. Revising run documents (runs stay re-planned, with the `run` path above). Programme slots. Changing `docOriginRow`'s meaning for rows nobody has edited. The thread coach's own apply path (being retired) — it keeps writing NULL-origin rows; adoption handles them when touched. A migration of existing rows (adoption is lazy).

## 9. Tests (what pins it)

Domain: the `revisability` table (every reason; `adopts` true for NULL-origin, false for studio/template; the no-document run and rest/race cases). Worker: adoption through `reviseDocWorkout` on a NULL-origin row with stage rows and a synced watch copy (origin studio, stages gone, content columns cleared, plan_id kept, address kept, rev +1, `watchHasOlder` true); the backfill then skips it; `plan-repair` rename keeps its document; the import claims the copy at an adopted row's address (no duplicate, no unique-index collision, for a plan row and for a coach row); Send on the day takes the old copy off before pushing; Remove and Stop this plan take it off; a claimed-in-flight create counts as "being sent"; `propose_workout` revise of a NULL-origin row is accepted and approve adopts it; the NULL guard (M2); reads carry `revisable` for every reason and for an adoptable row; the `not_editable` refusal's fix is the `instead`; a fit run ending in words, cancelled, or failed by the sweep releases the batch (one ending with a proposal does not); `design-prompt` wording; `REVISE_BASE` raised to the new statement count (M7). UI: `editableWorkout` true for a NULL-origin doc row today or later; the session sheet's edit path for it; the cause words. Existing tests that pin the old rule (`app-authored.test.ts`, `doc-workouts.test.ts` 572–644, `design-act-tools.test.ts` 657–663, `design-approve.test.ts` 399–417, `design-plan-adjust*.test.ts`, `design-plan-powers.test.ts`, the UI cause-word tests) are updated to the table's strings, not deleted.

## 10. Owner answers (2026-10-27)

1. The watch between a change and its Send: the old version stays on the watch, marked older, and Send replaces it (b). Stated goal: "the COROS watch is just always synced by default" — that is the next project; this one leaves nothing on the watch untracked.
2. COROS-plan sessions: "we should be able to change any session if we want" — yes, the app may replace one on the watch once it has been changed in the app.

Builder's calls folded in: M1–M9 above (M3 rest/race/no-document; M5 causes; M6 cancel/sweep release; M7 statement count; M9 fixtures).

## 11. Left to the builder

The exact `instead` strings' final wording within the table's meaning; the `revisable` marker's exact words in the opening context; how the Studio's session sheet labels an adoptable row before its first edit; where the claim-by-address lives in the import's read (beside the verified-push claim).
