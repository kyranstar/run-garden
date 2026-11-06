# Coach — Where You Stand and Drift (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every main coach run opens knowing where the athlete stands — objectives against target and due date, planned
versus done per discipline, the next 14 days, readiness values, the last review and flagged reads, and how much memory
lies beyond the core — and drift (a discipline slipping, sessions piling up unlogged, a key result falling behind)
becomes one "needs you" chip on Today and in the coach whose run diagnoses with the athlete first and remembers what it
concluded until a check-back date.

**Architecture:** One module, `where-you-stand.ts`, reads the facts in ONE statement (scalar JSON subqueries) plus the
key-result measures its objectives need (a pure count of the measure kinds — the run labels are skipped), words them as a
bounded block, and applies the drift rules — all pure past the read. The opening context (main runs only) and the nudges
read (`readCoachOpening`) both use it, so the coach's block and the chip can never disagree. A drift chip's tap creates a
run with `nudge: <drift id>`; the run keeps it as `settings.diagnose`, and its opening context carries the diagnose-first
instruction (app text). `remember` takes `drift` and `checkBack`: the item is pinned (within the cap) and the drift stays
held until that day. No schema change (the check-back rides in `coach_memory.provenance`).

**Tech Stack:** TypeScript; Hono on Cloudflare Workers (Free) with D1/drizzle; zod; React 18 + TanStack Query; Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md` §2.4, §3.6, §7, §10, §13.5; audit
`docs/reports/2026-11-05-import-trail-audit.md` §6; principles §2.9, §2.10, §5.2, §6.3 (amended by §12, 2026-11-05),
§6.7, §6.10, §8, §9, §11.

## Global Constraints

- Workers Free: ≤ 45 D1 statements per request including the run's own; every changed count updates its pin to the exact new number with a comment naming "where you stand".
- D1: ≤ 100 bound parameters a statement; lists bound as one JSON text (`json_each`).
- Public repo: synthetic names only (Zorbex …, made-up objectives); no personal data in code, tests or docs.
- Untrusted text (objective titles, key-result labels, the weekly review's narrative, an activity read's glance, memory bodies) reaches a model only through `markUntrusted`; the UI renders every label as text.
- The owner's voice: brisk, one next step, no explainers on the page. Chips are observations and questions, never accusations; a session the app only knows as unresolved is "not logged", never "missed".
- Proactive = chips on Today and in the coach. No push, nothing starts without the athlete's tap (spec §2.2, §13.5).
- Node v21 (`nvm use 21` or the v21 on PATH); run from the worktree root: `pnpm vitest run <paths>`; typecheck per package: `pnpm --filter <pkg> typecheck`.
- Prompt-size pins rebased as `REBASED 2026-11-06 (where you stand): <what grew> — measured N`, keeping ≥ 100 tokens headroom.
- Git: never `git stash`; commit by explicit paths; never `.superpowers/`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push. Do not touch `apps/saves-extension/**`, `packages/saves/**`, `apps/worker/src/services/saves-*.ts`, `import-*.ts`.
- Suites in local time and `TZ=UTC`; a 5 s timeout in an untouched test is the machine: rerun it alone.

## Review Focus

1. **An empty account** (no objectives, no plan, no health): the block still appears, each part says "none" in a few words, no drift fires, and the statement count is the base pin exactly. Test in Task 3.
2. **A session only known as unresolved** (yesterday's or older, nothing logged): counted "not known", never "missed"; the chip words say "not logged". Tests in Tasks 2 and 4.
3. **A key result with no baseline, no due date or no target**: pace "no data" with its reason, never a division by zero or "behind". Test in Task 3.
4. **A drift the coach already talked through** (a live memory item with `drift` and a `checkBack` after today): no chip, the block says "held until …"; on the check-back day the chip may return. Test in Task 4.
5. **A rich account at the edges** (12 objectives × 10 key results, 3 flagged reads, a long review narrative, 14 busy days): the block stays within its caps (≤ 1,500 chars on the synthetic rich athlete; every clipped list ends with the tool that has the rest). Test in Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/worker/src/services/key-result-measures.ts` | checkin and test measured from answers; `labels: false`; `measureStatements()` |
| `apps/worker/src/services/where-you-stand.ts` (new) | `readStandFacts`, `standBlock`, `driftsOf`, `driftNudge`, pace and discipline rules |
| `apps/worker/src/services/coach-nudges.ts` | the nudge bugs; the drift chip; asked-by-id |
| `apps/worker/src/services/design-context.ts`, `design-prompt.ts` | the block in a main run's header; the diagnose section; prompt lines |
| `apps/worker/src/services/coach-runs.ts`, `routes/coach-runs.ts` | `nudge` on create → `settings.diagnose` → `ContextRun.diagnose` |
| `apps/worker/src/services/design-tools/remember.ts`, `coach-memory.ts` | `drift` + `checkBack`, pinned within the cap |
| `packages/api-client/src/index.ts` | `nudge` on `coachRunCreate` |
| `packages/ui/src/screens/studio/coach-conversation-model.ts`, `coach-opening.tsx`, `coach-conversation.tsx`, `coach-sheet.tsx`, `coach-focus.ts` | chips not crowded out; a tap carries its nudge id; the sheet opened with an ask |
| `packages/ui/src/components/needs-you-today.tsx` (new), `screens/garden.tsx` | Today's drift chip |

---

### Task 1: Check-in and test key results are measured

**Files:** Modify `apps/worker/src/services/key-result-measures.ts`, `design-tools/read-objectives.ts` (statementCost and comment); Test `apps/worker/test/key-result-measures.test.ts`, the read_objectives counting test.

**Interfaces — Produces:**
- `MeasureContext.labels?: boolean` — `false` skips run_best's labels (no `runFacts`/`raceDaysOf`); points keep `label: "training"`.
- `measureStatements(measures: readonly KeyResultMeasure[], ctx: { library: boolean; labels: false }): number` — exact count with the library given and labels off: strength 4, running (run_best / pace_at_hr) 1, threshold (threshold_pace / predicted_time) 1, answers (checkin / test) 1, each once if any measure of its group is present.
- `ANSWER_WINDOW_DAYS = 90`.

Rules: a `checkin` reads `athlete_answers` with `question_id = questionId` and a numeric `value_num`; a `test` reads those with `question_id = testId` (the test's result kept as an answer under its id — Ruling: no writer exists yet, so a test reads "none" until one does, with the honest `missing`). One point per local day: the mean of that day's numeric answers (areas averaged), one decimal; `current` = the latest point; evidence by count (≥ 3 measured, else sparse); none → `missing: "No numeric <questionId> answers in the last 90 days."` / `"No result of test <testId> recorded in the last 90 days."`. Both kinds share one statement (`question_id in json_each(list)`).

- [ ] **Step 1:** failing tests — replace the "checkin and test" describe: energy answers 6 (day −3), 7 and 8 (day −1, areas or not) → series `[{date: −3, value: 6}, {date: −1, value: 7.5}]`, current 7.5, evidence sparse; a text-only answer and one 91 days back are ignored; another account's are ignored; a test with answers under its id → measured with three days; none → `missing` as above. `measureStatements([{kind:"checkin",…},{kind:"test",…}], {library:true,labels:false})` is 1, a hold_max + run_best + threshold_pace + checkin set is 7, and a counting db confirms each.
- [ ] **Step 2:** run `pnpm vitest run apps/worker/test/key-result-measures.test.ts` — FAIL.
- [ ] **Step 3:** implement; `read_objectives` statementCost +1 (answers) with the comment updated.
- [ ] **Step 4:** run `key-result-measures*.test.ts objectives*.test.ts design-tools` read_objectives tests — PASS.
- [ ] **Step 5:** commit `feat(objectives): check-in and test key results are measured from answers`.

### Task 2: The nudge bugs (audit §6), each test first

**Files:** Modify `apps/worker/src/services/coach-nudges.ts`, `reconcile-daily.ts` (export only), `packages/ui/src/screens/studio/coach-conversation-model.ts`, `coach-opening.tsx`; Test `apps/worker/test/coach-nudges.test.ts`, `packages/ui/test/…coach-conversation-model…` (find the existing model test with `grep -rl openingChips packages/ui/test`).

**Interfaces — Produces:** `reconcile-daily.ts` exports `UNRESOLVED_AFTER_DAYS = SYNC_GRACE_DAYS + 1` (a session dated D is first unresolved on D + 2); `coach-nudges.ts` `MISSED_WINDOW_DAYS = NUDGE_MISSED_DAYS + UNRESOLVED_AFTER_DAYS` (4). UI: `OPENING_CHIPS_MAX = 3` (total), `OWN_CHIPS_MAX = 2`.

- [ ] **Step 1 (window):** failing test — an `unresolved` session dated today−4 (marked on today−2 by reconcile) still shows its chip today; one dated today−5 doesn't. Then widen the read to `today − MISSED_WINDOW_DAYS`.
- [ ] **Step 2 (words):** failing tests — one `unresolved` session: label `Rework my week around Tuesday's tempo`, request `Rework my week around Tuesday's tempo — nothing was logged for it.`; one `skipped`: request ends `— I skipped it.`; one `missed`: `— I missed it.`; two with any unresolved: label `Rework my week around the sessions not done`, request names each with its word: `Rework my week around the sessions not done: Monday's easy run (missed) and Tuesday's tempo (nothing logged).`; all athlete-known: label stays `Rework my week around the sessions I missed`.
- [ ] **Step 3 (comeback):** failing test — a 3-minute walk today after a run 9 days ago, with a run 20 days before that: no comeback chip computed from the walk (the gap reads run-to-run: none, since the latest real activity is 9 days old); a 30-minute run today after a gap of 9 days → `I'm back after 9 days away.` even with a 2-minute activity between. Filter the activities read by `duration_seconds >= SESSION_MIN_SECONDS` (the opening's own pick already requires it).
- [ ] **Step 4 (crowded out):** failing model test — `openingChips(opening with 2 chips + review offer, 2 nudges)` returns 1 own + 2 needs (needs last, both kept); with 1 nudge: 2 own + 1 needs; with none: 2 own. Implement the caps above.
- [ ] **Step 5:** run `apps/worker/test/coach-nudges.test.ts` and the ui model test — PASS; commit `fix(coach): the "needs you" chips — reconcile's window, words that match what's known, no 3-minute comeback, never crowded out`.

### Task 3: Where you stand — the facts and the block

**Files:** Create `apps/worker/src/services/where-you-stand.ts`; Test `apps/worker/test/where-you-stand.test.ts`.

**Interfaces — Produces:**
```ts
export type Discipline = "runs" | "strength" | "mobility and care" | "yoga";
export function disciplineOf(w: { category: string; origin: string | null }): Discipline | null; // runs: recovery|easy|long|quality|race|unknown; strength; yoga+appAuthoredRow → mobility and care; yoga otherwise → yoga; else null
export type Pace = "ahead" | "on track" | "behind" | "reached" | "no data";
export function paceOf(kr: { direction: "up" | "down"; start: number | null; target: number | null; startDate: string; due: string | null }, current: number | null, today: string):
  { pace: Pace; done?: number; elapsed?: number; why?: string };
export interface StandFacts { today: string; objectives: StandObjective[]; plan: StandPlanRow[]; unplanned: Array<{ date: string; discipline: Discipline }>;
  health: ReadinessHealthRow-like rows (14 d, newest first); sleep: Array<{ date: string; seconds: number }>; review: { weekStart: string; narrative: string } | null;
  reads: Array<{ date: string; sport: string; seconds: number; flags: string[]; glance: string | null }>; beyondCore: Record<string, number>;
  conclusions: Array<{ id: string; drift: string; checkBack: string; at: string }> }
export function standRowsSql(userId: string, today: string, opts: { library: boolean }): SQL; // the one statement
export async function readStandRows(db: Db, userId: string, today: string, opts: { library: boolean }): Promise<StandRows>;
export async function standFactsFrom(db: Db, userId: string, rows: StandRows, opts: { today: string; library?: AccountLibrary; raceDate?: string | null }): Promise<StandFacts>; // the measures, after the library is known
export async function readStandFacts(db: Db, userId: string, opts: { today: string; raceDate?: string | null }): Promise<StandFacts>; // both, the library in the stand's own statement
export function standStatements(measures: readonly KeyResultMeasure[], library: boolean): number; // 1 + measureStatements(…)
export function standBlock(f: StandFacts, drifts: readonly Drift[]): string;
```
Reads (one statement, every term scoped to the user): active objectives with their key results (`sort`, `position` order); planned rows today−28 … today+13, not archived; activities ≥ 300 s today−28 … today−1 with no live completion match (unplanned); `daily_health` today−14 … today; `sleep_records` today−6 … today; the newest `weekly_reviews` row; `coach_reads` done with a non-empty `flags` for activities dated today−6 … today (at most 3 read); live memory beyond the core by kind (`memoryCoreIds`); live items whose `provenance.drift` is set (newest first, at most 10); and `personalMovesSql` when no library is given. Then `measureKeyResults(…, { today, library, labels: false })` for the parsed measures (a key result whose measure no longer parses is "no data").

Planned vs done (windows: the 14 and 28 days BEFORE today — Ruling: today's own sessions are in "Next 14 days"): planned = rows of a discipline, not rest, not a coach-sanctioned skip; done = `completed`; missed = `missed`; skipped = `skipped` (the athlete's); not known = `unresolved` or still `scheduled` on a past day. A discipline with nothing planned and nothing unplanned in 4 weeks is left out.

Pace: start = baseline, else the series' first point; startDate = the key result's created local date; `done` = progress fraction toward target (direction-aware), `elapsed` = fraction of startDate → due gone (clamped 0–1). reached when current meets target; ahead when done ≥ elapsed + 0.1; behind when done < elapsed − 0.1; else on track. No current → no data ("nothing measured"); no target → no data ("no target"); no due → no data ("no due date"); target == start → no data ("target equals start"). Past due and not reached → behind.

The block (header `# Where you stand (the app's figures for <today>)`), in this order, each part capped:
- `Objectives — current → target by due: pace` — one line per key result, at most 4 (then `- and N more (read_objectives)`); `- <objectiveId>: <marked label> <current> → <target> by <due>: <pace> (<done>% there, <elapsed>% of the time gone)`; evidence `sparse`/`capped` said after the current; units in the key result's unit. No objectives → `Objectives: none active.`
- `Planned → done, 14 d | 4 wk (missed · skipped · not known):` then `- runs 6/8 | 13/16 (1·0·1 | 1·1·1), +2 not on the plan` per discipline; none → `Planned → done: nothing planned in 4 weeks.`
- `Next 14 days:` one line per day `Thu 6 Nov: easy run 40 min; strength 30 min` (rest → `rest`; nothing → `—`), at most 3 items a day then `+N`.
- `Readiness: <verdict level or "no verdict (too little data)">. Last 7 d, oldest first — HRV 55 58 – 61 (usual 59, rising) · resting HR … (falling) · sleep 6.9 h avg (6.1–7.8)` — integers for HRV and RHR, "–" for a day without; trend = mean of the newest 3 vs the oldest 3 readings (≥ 2 each), ±3 % "steady".
- `Last weekly review (week of <dayLabel>): <marked "coach read" first sentence, ≤ 140 chars>` or `Last weekly review: none yet.`
- `Activity reads flagged in 7 d:` up to 2 lines `- Tue 4 Nov run 42 min — hr_drift: <marked glance ≤ 90 chars>`, then `and N more (read_history)`; none → `Activity reads flagged in 7 d: none.`
- `Memory beyond the core: 3 notes, 2 observations (recall_memory).` or `Memory beyond the core: none.`
- `Needs you:` each drift line from Task 4, or `Needs you: nothing the app sees.`

- [ ] **Step 1:** failing pure tests — `disciplineOf`, `paceOf` (each branch above, with numbers: up 60 → 120 s, current 75, created 40 d ago, due 30 d ahead → behind, done 25, elapsed 57), and `standBlock` against a captured text for a synthetic athlete (Zorbex objectives) — `expect(block).toBe(EXPECTED)` — plus the empty block captured, and the rich-edge fixture ≤ 1,500 chars with its "and N more" lines.
- [ ] **Step 2:** failing DB test — `readStandFacts` over a seeded account (planned rows in each state, a coach-sanctioned skip, an archived row, rest, an unplanned run, a 3-min activity, health with values, a review, a flagged and an unflagged read, memory core + beyond, another account's rows) gives the facts asserted; statements counted = `standStatements(measures, false)` exactly, and with a library given 1 fewer measure path (`library: true`).
- [ ] **Step 3:** implement; run `pnpm vitest run apps/worker/test/where-you-stand.test.ts` — PASS.
- [ ] **Step 4:** commit `feat(coach): where you stand — objectives, planned vs done, the fortnight, readiness, reviews, memory beyond the core`.

### Task 4: Drift — the rules, the chip words, the check-back

**Files:** Modify `where-you-stand.ts`; Test `where-you-stand.test.ts`.

**Interfaces — Produces:**
```ts
export interface Drift { id: string; rule: "discipline" | "none" | "missed" | "key_result"; observation: string; held: { until: string; memoryId: string } | null; since?: { at: string; memoryId: string } }
export const DRIFT_ID: RegExp; // /^drift:(discipline|none|missed|key_result)(:[A-Za-z0-9_ -]{1,80})?$/
export function driftsOf(f: StandFacts, progress: …): Drift[]; // most pressing first
export function driftNudge(d: Drift): CoachNudge; // { id, label: `${observation} — talk it through?`, request: `${observation} — let's talk it through.` }
```
Rules (Ruling: numbers within spec §7.2), over the 21 days before today unless said:
- `drift:discipline:<discipline>` — planned ≥ 3 and done × 2 < planned: `2 of 6 planned lifts logged in 3 weeks` (nouns: runs, lifts, mobility sessions, yoga sessions).
- `drift:none:<discipline>` — planned 1–2, done 0 and nothing of it unplanned: `No yoga sessions logged in 3 weeks`.
- `drift:missed` — over 14 days, ≥ 3 sessions `missed` or `unresolved`: `4 sessions not logged in 2 weeks`.
- `drift:key_result:<krId>` — behind by more than 0.25 (elapsed − done > 0.25) with under half its time left (elapsed > 0.5): `<label ≤ 32 chars> is behind pace with 5 weeks left` (days < 14 → "N days left").
Order: discipline/none (lowest done ratio first), then missed, then key results (furthest behind first). Held: a conclusion with that id whose `checkBack > today` → `held` (no chip; the block line ends `— talked through <date>, held until <checkBack> (<memoryId>)`); a conclusion whose check-back has come → `since` (the block line ends `— talked through <date> (<memoryId>): check back now`). Block line: `- <observation> (<id>)`.

- [ ] **Step 1:** failing tests — each rule at its edge (2 of 4 strength → fires; 2 of 4 → 2×2 = 4 not < 4 → doesn't; 3 planned / 1 done fires; 2 planned / 0 done with an unplanned strength activity → none doesn't fire); unresolved counted in `missed` and worded "not logged"; a held drift and a check-back-day drift; `driftNudge` words; no drift on the empty account.
- [ ] **Step 2:** implement; PASS; commit `feat(coach): drift — a discipline slipping, sessions not logged, a key result behind, held until the check-back`.

### Task 5: The block in every main run's opening context

**Files:** Modify `design-context.ts`, `design-prompt.ts`; Test `design-context.test.ts`, `design-prompt.test.ts`, `design-fix13-prompt.test.ts` (caps).

**Interfaces — Consumes:** Task 3/4. **Produces:** `contextStatements(role, focus?, conversation?)` main base +1 (the stand statement; designer/reviewer unchanged); `DESIGN_CONTEXT_STATEMENTS` = previous 13 + 1 + 7 (the measures' most) = 21; `UntrustedSource` gains `"coach read"`.

- Main role only: the stand facts read in parallel with the others, the library from the counts statement passed in (so no `personalMovesSql` twice: the measures run after it); the block goes after the index section.
- `SHARED_PROMPT`: the opening-message sentence names "where the athlete stands (objectives against target, planned versus done, the next 14 days, readiness, the last review, flagged reads, what memory holds beyond the core, and any drift)"; the Tone line becomes "Notice a stall or a drift kindly: an observation and a question, then a next step; a session not logged is not a miss."; the untrusted paragraph adds `from="coach read"`: an earlier model reading of a week or an activity.
- [ ] **Step 1:** failing tests — a main header contains `# Where you stand` with the fixture's figures (HRV rounded: `78`); a designer's and a reviewer's don't; statements: the quiet fixture spends `contextStatements("main")` exactly (11 + 1 = 12); an account with a hold_max and a checkin key result spends `contextStatements("main") + measureStatements([...], {library: true, labels: false})` (= 12 + 5); `DESIGN_CONTEXT_STATEMENTS` ≤ `CONTEXT_STATEMENT_BUDGET` (37). SENTINELS still never appear.
- [ ] **Step 2:** implement; rebase the prompt pins `REBASED 2026-11-06 (where you stand): …— measured N`; PASS on `design-context*.test.ts design-prompt.test.ts design-fix13-prompt.test.ts coach-runs*.test.ts` (scoped); commit `feat(coach): every main run opens knowing where the athlete stands`.

### Task 6: The drift chip in the coach and on Today's read

**Files:** Modify `coach-nudges.ts`, `routes/coach-nudges.ts` (pin comment); Test `coach-nudges.test.ts`.

- `readCoachOpening` reads the stand facts (no library: in its own statement) beside its reads and puts the first unheld drift's chip second in the order (after missed, before comeback); `NUDGES_MAX` stays 2. The "asked" read also selects `json_extract(state, '$.settings.diagnose')`; a chip is asked when its label's words are in a recent request OR its id is a recent run's diagnose id.
- [ ] **Step 1:** failing tests — a strength drift → chip `{ id: "drift:discipline:strength", label: "1 of 4 planned lifts logged in 3 weeks — talk it through?", request: "1 of 4 planned lifts logged in 3 weeks — let's talk it through." }`; held by a conclusion → none; a run created yesterday with `settings.diagnose` = that id → none; statements: quiet account 4 + 1, the route 8 + 1 (+ measures when key results exist, pinned exactly in a test with one checkin key result).
- [ ] **Step 2:** implement; PASS; commit `feat(coach): drift is a "needs you" chip`.

### Task 7: The diagnose run, and remember's check-back

**Files:** Modify `routes/coach-runs.ts`, `services/coach-runs.ts`, `design-context.ts`, `design-prompt.ts` (`DIAGNOSE_LINES`), `design-tools/remember.ts`, `coach-memory.ts`; Test `coach-runs` route test (create), `design-context.test.ts`, `design-tools` remember test.

**Interfaces — Produces:** POST `/api/coach/runs` `{ nudge?: string }` — 400 `bad_nudge` unless it matches `DRIFT_ID`; kept as `settings.diagnose` (main run only; no statement). `ContextRun.diagnose?: string`, `DesignRun.diagnose?: string | null`. Header (main): after the stand, `diagnoseSection(drift | null, id)` — the drift's observation (or "the app no longer sees it — ask whether it still matters") and `DIAGNOSE_LINES(id)`:
"Diagnose with them before you decide. First ask what's in the way — one question at a time with ask_athlete, two to four tappable answers (free text is always there); never ask what the stand or a tool already says. Then decide what serves their goals best — change the plan, the objective or the approach — and propose it, or say plainly why nothing should change. Then remember the conclusion with drift "<id>" and checkBack, the day to look again (usually one to three weeks out): it is pinned, and this chip stays away until then. An observation, never blame: a session not logged is not a miss."
`remember` input gains `drift` (matches `DRIFT_ID`) and `checkBack` (YYYY-MM-DD, after today, within 56 days) — both or neither (`refuse("check_back_pair", …)`); written with `provenance.drift`/`provenance.checkBack` and `pinned = live pins < MEMORY_PIN_CAP` in its insert (a replaced item's pin still kept); the answer says `pinned: false` past the cap. Statement count unchanged (3).
- [ ] **Step 1:** failing tests — create with `nudge: "drift:discipline:strength"` keeps `settings.diagnose`; `nudge: "x"` → 400; the context of such a run carries the observation and `DIAGNOSE_LINES`; another main run's doesn't; remember with drift+checkBack writes a pinned item whose provenance holds both, and the next `readStandFacts` holds the drift; past the pin cap it's written unpinned; checkBack alone refused; checkBack today refused.
- [ ] **Step 2:** implement; PASS on the touched tests; commit `feat(coach): a drift chip's run diagnoses first, and remembers its conclusion until the check-back`.

### Task 8: The chip in the app — the coach and Today

**Files:** Modify `packages/api-client/src/index.ts` (`nudge?: string` on `coachRunCreate`), `coach-focus.ts` (`CoachOpenArgs.ask?: { request: string; nudge: string }`), `coach-sheet.tsx` (passes `ask`), `coach-conversation.tsx` (`send(words, { nudge })`; an `ask` sent once as the conversation settles, like `fit`), `coach-opening.tsx` (`onAsk(request, nudgeId?)` for `drift:` chips); Create `packages/ui/src/components/needs-you-today.tsx`; Modify `screens/garden.tsx` (under `SavesTodayCard`); Test `packages/ui/test/needs-you-today.test.tsx` and the conversation test that checks a chip's send.
- Today: `NeedsYouToday` reads `api.coachNudges()` (`[...NUDGES_QUERY, "today"]`, staleTime 60 s, retry false) only when `useCoach()` is there, and shows the first `drift:` nudge as one chip (`chip coach-chip coach-chip--needs`, 44 px); a tap opens the coach with `ask: { request, nudge: id }, seeing: null`; nothing when there is none or the read fails.
- [ ] **Step 1:** failing tests — Today shows the drift chip's label and a tap opens the coach with the ask; no chip without a drift nudge or without the coach; the coach's opening sends `nudge` with a drift chip's request and none with another chip's.
- [ ] **Step 2:** implement; PASS; `pnpm --filter @rg/ui typecheck` `pnpm --filter @rg/api-client typecheck`; commit `feat(ui): the drift chip on Today and in the coach — a tap starts a diagnosis`.

### Task 9: Finish

- [ ] Docs: the spec §7 marked built with this plan's rulings; principles §6.3 points at the §12 row.
- [ ] Full scoped suites (worker, ui, api-client, domain, database) in local time and `TZ=UTC`; typechecks per package; rebase on `origin/main`; rerun; commit.
