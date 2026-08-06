# The Coach — Intelligence & Backend Design (phase 2 of 3)

*2026-08-06 · Companion to `2026-08-06-coach-ux-design.md` (the UX contract this backend serves). Locked decisions: **think-on-open** (deterministic triggers mark, the LLM runs only when the user shows up or speaks), **one-shot full-dossier architecture**, **hard-floor + soft-flag guardrails**, **rolling plan detail**, **~$20/wk budget guard**, propose-only (nothing changes without approval), coach authors both disciplines. Phase 3 (garden incentives) comes separately.*

## 0. Cost & wake model — when the LLM runs at all

A **wake** is one strong-model call. Wakes happen only on:

1. **User message** (freetext, question-chip answer, "Why?" expansion request) — always wakes.
2. **Page open with cause** — the panel mounts AND (≥1 pending trigger row OR the cached briefing is >20h old). Otherwise the panel renders entirely from cache: last briefing, live proposal rows, thread — **zero LLM calls on a quiet open**.
3. **Approval side-effects never wake.** Applying ops is deterministic (§7).

Budget: reuse the `llm_usage` ledger with a **$20 rolling-week cap**. At cap, wakes degrade honestly (UX §9 "coach is resting"); user messages queue a receipt rather than silently dropping. Token policy follows the house rule: caps exist to never be hit (64k strong / 16k cheap, 300s timeout, one in-place retry on transient errors). Realistic spend at one open + a few messages per day lands well under the cap.

## 1. Triggers — the free, deterministic layer

`coach_triggers` rows written by cheap SQL checks, evaluated piggyback on existing reads (the hourly reconcile cron + `/api/plan/today`): `{id, kind, evidence JSON, firedAt, consumedAt}`. Kinds (v1):

| kind | rule (deterministic, no LLM) |
|---|---|
| `sleep_deficit` | 3-night avg sleep < 6h, or HRV 3-day avg z-score < −1 vs 30d baseline |
| `missed_workout` | a planned workout resolved `skipped`/`missed` since last wake |
| `plan_horizon` | < 14 days of firm detail remain on an active coached plan (drives rolling firm-up) |
| `plan_ending` | active plan ends within 21 days (drives the extend conversation) |
| `race_proximity` | race day within 14 days (race-week posture check) |
| `comeback` | first completion after ≥ 7 idle days |

Triggers are marks, not thoughts: firing costs a SQL query. A wake consumes all pending triggers at once (one call covers them). Duplicate suppression: a kind re-fires only after its prior row is consumed or 72h lapse.

## 2. The dossier — packaging COROS data for one call

`apps/worker/src/services/coach-context.ts` — grows out of `buildAthleteContext` (studio-llm) into the comprehensive, compact athlete document. Sections, each with a freshness stamp, total budget ≈ 12k tokens:

1. **Athlete** — durable memory facts + goals + standing rules (verbatim from `coach_memory`, grouped by kind).
2. **Plans** — every active plan (both disciplines): week X/Y, firm weeks with full sessions, shape weeks as `{weekly volume, key sessions}` (§6), adherence % this block, anchors in force.
3. **Last 14 days** — one table row per session: date · planned vs actual · duration · distance · avg pace/HR · load · completion state. Unmatched/unplanned sessions included and labeled.
4. **Wellness 14d** — per day: sleep duration, HRV, resting HR — each with its 30d baseline and delta. (Tables: `sleep_records`, `daily_health`.)
5. **Signals** — the pending trigger rows with their evidence, verbatim.
6. **Recent milestones** — new records (existing `records` machinery), garden consistency chain (one line; deeper garden coupling is phase 3).
7. **Open items** — pending proposals (so the coach never double-proposes), open question (≤1), unresolved workouts.
8. **Conversation tail** — last 10 thread messages verbatim (long-term knowledge lives in memory, not scrollback).

Format: terse labeled tables, ISO dates, explicit units, explicit `unknown` for gaps (never invented). A `dossier()` fixture snapshot test pins the shape.

## 3. The call — one structured exchange per wake

Strong model (existing `AI_STUDIO_MODEL_STRONG` env, default opus-class) via the existing gateway `chatCompletion` + `extractJson` + zod-with-one-repair-retry. Output schema (zod, exhaustive):

```ts
{
  briefing: string | null,          // markdown prose for the thread; null = nothing worth saying
  proposals: Array<{
    title: string,                  // "Ease tomorrow, protect Saturday"
    evidence: string,               // one line, data-cited: "slept 5h avg · HRV −9%"
    rationale: string,              // the full Why? expansion
    expiresAt: string,              // min(end of first affected day, +72h) — matches UX §3
    flags: string[],                // soft-rule violations it consciously makes (§4)
    ops: Op[]                       // typed operations, validated before anything persists
  }>,
  question: { text: string, chips: string[] } | null,   // ≤1, and only if memory can't answer it
  memoryOps: Array<
    | { op: "add", kind: "fact" | "rule" | "note", text: string, expiresAt?: string }
    | { op: "update", id: string, text: string }
    | { op: "expire", id: string }
  >
}
```

**Op vocabulary** (the only ways the coach can touch a plan):

`ease(workoutId, session)` · `move(workoutId, toDate)` · `swap(dayA, dayB)` · `skip(workoutId, reason)` · `add(date, session)` · `reshapeWeek(planId, weekStart, sessions[])` · `firmUp(planId, weekStart, sessions[])` · `extendPlan(planId, shapeWeeks[])` · `windDown(planId)` · `createPlan(intake → full rolling-detail draft)` · `retirePlan(planId)`

where `session` is the discipline-generic structured workout (category, title, duration/distance blocks for runs — the COROS-write-confirmed topology — sets/reps/exercise for lifts, reusing the studio's session schema).

## 4. The validator — hard floor outside the model

`packages/domain/src/coach-guardrails.ts` (pure, unit-tested): `validate(ops, planState, wellnessState, rules) → { hard: Violation[], soft: Violation[] }`.

**Hard rules (proposal rejected, one repair retry with violations quoted, then dropped with a log — never shown broken):**
- weekly load/volume ramp > 10% vs trailing 4-week average (per discipline);
- hard sessions (quality/long/race, heavy lifts) on consecutive days;
- touching a completed, past, or currently-unresolved workout;
- edits beyond the firm horizon except via `firmUp`/`extendPlan`/`reshapeWeek`;
- race week: no new intensity inside 7 days of a race;
- `skip` of a race.

**Soft rules (allowed, must be flagged):** every standing rule in memory ("quality on Tuesdays", "long runs Saturday") — a violating proposal MUST carry the matching `flags[]` entry; the validator adds any the model forgot, so the UI's "breaks your rule" chip is guaranteed truthful.

## 5. Memory — the single knowledge store

`coach_memory`: `{id, kind: fact|rule|note, text, provenance: {messageId|source, at}, learnedAt, expiresAt?, active}`.

- Written ONLY via `memoryOps` from wakes + user edits in Settings (full CRUD API: `GET/PATCH/DELETE /api/coach/memory`). Deletion is immediate and total — the next dossier simply lacks the item.
- The prompt carries current memory verbatim with ids, plus the standing instruction: *never ask what memory answers; never re-add near-duplicates; prefer `update` over `add`.*
- `note` kind auto-expires (`expiresAt`), emitting a receipt when it lapses ("travel note expired").
- **Question ledger** `coach_questions`: `{id, text, askedAt, answeredAt?, memoryId?}` — at most one open row; a question is only insertable if no active memory item answers it (the wake prompt includes recently-asked questions so the model cannot loop).

## 6. Plans — rolling detail model

- `plannedWorkouts` remains the single source for firm sessions (everything the calendar, sync, matching, and garden already consume — untouched contracts).
- New `coach_plans`: `{id, discipline, name, status: draft|active|completed|retired, startDate, endDate, raceDate?, stampPrefix}` and `coach_plan_weeks`: `{planId, weekStart, state: firm|shape, shape: {volumeTarget, keySessions[]} | null}`.
- **Rolling firm-up:** `plan_horizon` trigger → wake proposes `firmUp` for the next shape week (a normal proposal; approving materializes `plannedWorkouts` rows). Shape weeks render in the calendar as outline chips ("wk of Sep 8 · ~40k · long 20k + tempo").
- **Import from COROS:** one-time adoption maps the imported plan's remaining weeks into a coached plan (existing weeks become firm), stamped thereafter. The legacy import pipeline keeps running for any un-adopted COROS plan (read-only to the coach).

## 7. Apply path — approval to watch

Approve → within the 10s undo window nothing dispatches → then, deterministically:

1. Ops mutate `plannedWorkouts`/`coach_plan_weeks` app-side (create/update/archive), recording sync intents (existing ledger — the reconcile decision table already arbitrates against COROS reads).
2. Watch mirroring rides the **studio push machinery generalized**: per-coach-plan program stamp (`${plan.name} — wk N` pattern), `create-executor` safety core extended with the run-workout topology the spike verified (duration/distance blocks). Writes-OFF → app-only apply with the UX §9 banner; writes-ON → queued, verified read-after-write, receipts reflect job outcomes.
3. Proposal transitions (`approved/declined/superseded/expired`) emit thread receipts; `superseded` is set only by a newer wake proposing against the same (plan, day).

## 8. Thread persistence

`coach_messages`: `{id, role: coach|user|receipt, body, refs: {proposalId?|memoryIds?|questionId?}, at}`. Receipts are stored messages (uniform pagination); the panel paginates; wakes see only the tail (§2.8). No summarization pass in v1 — memory is the compression.

## 9. Failure honesty

- Gateway failure after retry → thread receipt "couldn't think just now — try again"; triggers stay unconsumed (next open retries).
- Validator double-failure on a proposal → that proposal dropped, others survive; log carries the rejected ops.
- Zod repair failure → same as gateway failure (the house never-truncate/over-provision policy applies).
- Worker crash mid-apply → sync intents + idempotent ops make re-apply safe (same pattern as studio push).

## 10. Testing

- `coach-guardrails` exhaustive unit suite (each hard rule, flag injection).
- Dossier golden-fixture snapshot (shape + token ceiling assertion).
- Wake pipeline in fixture mode (existing `FIXTURE_MODE` LLM stubbing): trigger → wake → schema → validator → proposal rows.
- Proposal state machine transitions incl. expiry sweep (piggyback the hourly cron).
- Apply-path integration: ops → plannedWorkouts → intents (in-memory D1 harness, as everywhere).
- Live COROS run-workout create/delete spike extension before the push lane ships (protocol doc gains a run-topology section).

## Out of scope (phase 3+)

Garden incentive coupling; notifications; multi-athlete; voice; auto-apply tiers.
