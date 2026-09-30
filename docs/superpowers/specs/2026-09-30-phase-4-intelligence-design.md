# Phase 4 — Intelligence: the combined day proposal, unified progression and records, and the coach

Date: 2026-09-30
Status: design for Phase 4 of `2026-09-30-one-workout-system-design.md` (the authority). Builds on Phases 1–3.

## 1. Scope

1. **The combined day proposal** — the adaptive session's mode considers readiness and plan context, not only the
   condition check and consistency.
2. **Unified progression** — logged loads drive "next time" for every logged strength exercise, in every program;
   coach and Studio prescriptions become targets; lift graphs show actuals against prescriptions.
3. **Unified records and moments** — the engine's records and milestones join the existing records and the garden's
   earned moments.
4. **The coach** — new dossier sections, parameter ops for program sessions, condition guardrails, a flare advisory.
5. **On-demand sessions from the coach and the Plan page.**

No new LLM calls: every coach change rides the existing wake. The weekly budget (warn $5, cutoff $20, absolute $25)
is unchanged.

## 2. The combined day proposal

`@rg/session-engine` gains an optional `context` input to `Proposal.mode`:

```ts
interface DayContext {
  readiness: { level: "good" | "caution" | "poor"; reasons: string[] } | null;   // domain readinessVerdict
  hardTomorrow: { title: string; category: string } | null;   // a quality/long/race session tomorrow
  hardToday: { title: string; category: string } | null;      // another hard session today (e.g. a run)
  raceInDays: number | null;
  adventureToday: boolean;
}
```

Rules, evaluated after the profiles' recovery triggers and before the general build checks:

- `readiness.level === "poor"` → recovery, reason from the verdict ("HRV well below your baseline").
- `readiness.level === "caution"` → build is not proposed (consistent), reason from the verdict.
- `hardToday` (a quality/long/race run the same day) → build is not proposed; core families that load the legs
  (squat, hinge) are deprioritised for the day's block pick (a `familyBias` of −3), reason "Tempo run today — easy
  on the legs".
- `hardTomorrow` → no squat/hinge core lift at build volume (consistent sets), reason "Long run tomorrow".
- `raceInDays ≤ 7` → consistent at most; `≤ 2` → recovery. Reasons name the race.
- `adventureToday` → recovery, reason "Hike today".

Every rule is a pure function with its own reason and test; the user's override always wins. The worker assembles
`DayContext` from the Today DTO's existing readiness and the planned rows of today and tomorrow.

For **non-adaptive** sessions the same context yields **advisory notes only** (never a change): a lift on a poor
readiness day shows the verdict line in its sheet; nothing is rewritten.

## 3. Unified progression

- **History source.** Every performed session (app, watch review, import) is history for progression, regardless
  of program. `Prog.historyFor` already keys by canonical exercise id.
- **Coach and Studio exercises resolve to library ids** at apply time (`resolveLibraryId(name)`, the library
  analogue of `resolveExerciseOriginId`: aliases, containment, Jaccard ≥ 0.7, curated overrides) and store the id in
  `structured_json.exercises[].libraryId`. Unresolved exercises keep working as today (no how-to, no progression).
- **Targets.** For a coach/Studio session built from a prescription, the displayed target for a resolved exercise is
  the engine's `suggest` when history exists (with the prescription shown as "plan"), else the prescription.
  The prescription never silently changes; the watch push (Phase 3) sends the engine's target when the athlete has
  opted in (`prefs.coachTargetsFromLogs`, default on) and the prescription otherwise.
- **Graphs.** `plan-progressions.ts` fills `actual` from logged top sets per week for resolved exercises
  (`liftProgressions`), keeping the prescribed series. The card headline uses actuals when present.

## 4. Records and moments

- `computeRecords` (analytics) gains strength records from logged sets per discipline `strength`: heaviest top set
  per core family, most reps at the heaviest weight, longest hold, first time on a core lift; `yoga` gains longest
  hold and first time. Weights display as typed.
- The engine's milestones (10/25/50/100 sessions, goal-week streaks, calm streaks from the active profile, block
  complete, heaviest implement, all core families in one week) become garden **beat lines** (not ceremonies) via
  `arrival.ts` `BEAT_PRIORITY`, one at a time, gentle ("Ten sessions in. The moss campion noticed."). Records keep
  their existing "never regress" merge.
- Records move out of the insights GET into a service called on save and on ingest, so they are computed where
  data changes (and GET stays read-only — the Phase 0 restore marker rule).

## 5. The coach

### 5.1 Dossier (within the 20k budget; PLANS stays protected)

- **PROGRAMS** (after PLANS): each active program — kind, weekly goal, this week's done/placed, block N week W of
  weeks with core lifts, the last 7 days' modes.
- **CONDITIONS** (inside ATHLETE): active profiles, the last 14 days' checks (pre/post means, flare days), set flags
  in the last 7 sessions. Numbers only, no raw notes.
- **RECENT STRENGTH DETAIL** (extended): logged top sets per resolved exercise for the last 14 days, weights as typed.
- **EQUIPMENT**: places and their equipment (replaces the Studio brief's equipment line).

### 5.2 New ops (each with a drift-tested worked example and survival-harness coverage)

| Op | Meaning |
|---|---|
| `reshapeSession { workoutId, params }` | For program and on-demand rows: set `session_params` (minutes, focus regions, location, excluded equipment, mode); the engine rebuilds; refused when locked. |
| `newSession { date, params, programId? }` | An on-demand session with parameters (a row under the on-demand program, built on its day). |
| `setProgram { programId, weeklyGoal?, preferredDays?, defaultMinutes?, modes? }` | Program settings; placement re-runs. |
| `pinLift { programId, family, exerciseId \| null }` | Pin or unpin a block's core lift. |
| `rotateLift { programId, family, reason }` | Rotate a core lift now (the engine picks the variant). |
| `createProgram { name, config }` | An adaptive program. |

They expand at the selector seam into apply-ready ops; the manifest renders the **rebuilt** session (computed, never
narrated).

### 5.3 Condition guardrails

- **Fatal:** any coach-authored exercise (in `add`/`ease`/firm sessions) that resolves to a library exercise an
  active profile's `never` rule forbids; any `reshapeSession`/`newSession` params that would force such a move
  (they cannot — the engine enforces it — but the guardrail asserts the built result).
- **Advisory:** coach-authored exercises that exceed an active profile's `fitsMode` caps for the proposed intensity,
  or that are not flare-safe on a day the latest check is a flare; imported COROS content that violates a rule is
  flagged in the session sheet (never changed — COROS owns it).
- `allowedNowLines` and the prompt's limits block state the never-rule in the profile's own words.

### 5.4 The flare advisory

When today's check meets the profile's flare definition, the wake trigger `condition_flare` fires once per day; the
coach may propose easing today's hard session(s). Always a proposal; the premise line names the check value. No
automatic change.

## 6. On-demand sessions

"New session…" on Plan (and the coach's `newSession`): minutes, focus (regions), place, mode, optional theme →
a row with `origin = 'on_demand'` under a per-user "On-demand" program, built immediately; Start now or schedule.

## 7. Testing

Engine: table-driven tests per context rule with reasons; property test that overrides always win. Worker: dossier
sections under budget (existing budget test extended); each new op through parse → expand → guardrails → apply in
the survival harness (≥ 200 generated op sets, survival rate reported); condition guardrail fatal/advisory split;
records never regress. UI: the combined proposal reasons on the session sheet; lift cards with actuals.
