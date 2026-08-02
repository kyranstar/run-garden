# Plan Studio — LLM-Authored Lifting Plans, Written to COROS

**Date:** 2026-08-03
**Decisions (user-approved):** lifting-first (running later, yoga stays ad-hoc); strong-LLM
generation + cheap-LLM edits; draft-then-explicit-push; embedded in the Plan screen.
**Capability basis:** live-verified COROS write findings in
`docs/research/plan-write-capability.md` §LIVE VERIFICATION (create/delete proven,
plan-scoped identity mandatory, program names round-trip, 382-entry exercise catalog).

## Goal

A Studio mode on the Plan screen: a short structured intake → a strong LLM generates a
fully structured lifting plan → a cheap-LLM edit loop refines it → the user reviews a
draft/diff → "Push to COROS" writes each session as a real strength workout on the
account's own plan container, verified read-after-write, reaching the watch via COROS's
normal sync. Pushed sessions flow into the existing planned-workout pipeline (calendar
mirroring, completion matching, the garden's strength axis) with zero new wiring.

## Non-goals (v1)

- Running-plan authoring (explicit later phase); yoga scheduling (COROS has none);
  bike/swim plans.
- COROS plan-object creation (`plan/add`) — per-workout creates into the container plan
  are the verified, sufficient mechanism.
- Auto-sync (draft-then-push only); Strava anything; insights metrics; workout-detail
  set/rep rendering on the existing calendar list (the studio's own grid shows structure).

## Architecture

### 1. Domain (`packages/domain`)

Zod schemas, exported types:

```ts
PlanBrief {
  goal: "strength" | "hypertrophy" | "general";
  durationWeeks: number;          // 2..16
  sessionsPerWeek: number;        // 1..6
  preferredDays: number[];        // ISO weekday 1..7, length == sessionsPerWeek
  sessionMinutes: number;         // 20..120
  equipment: string;              // free text ("full gym", "dumbbells + bench")
  constraints: string;            // free text (injuries, exclusions)
  notes: string;                  // free text extras
  startDate: LocalDate;
}
StudioExercise {
  originId: string;               // must exist in the synced COROS catalog
  name: string;                   // display name (from catalog)
  sets: number; reps: number;
  weight: { type: "bodyweight" } | { type: "kg"; value: number };
  restSeconds: number;
  note?: string;
}
StudioSession { title: string; weekday: number; exercises: StudioExercise[] }
StudioWeek { sessions: StudioSession[] }
LiftingPlan { name: string; brief: PlanBrief; weeks: StudioWeek[]; }
```

### 2. Database (Drizzle migration — the repo's first since 0000)

- `studio_plans`: id, brief JSON, plan JSON, version (int, bumped per accepted edit),
  createdAt, updatedAt.
- `studio_plan_pushes`: one row per pushed session instance — planId, planVersion,
  happenDay, sessionTitle (the stamp), corosIdInPlan, corosProgramId, corosEntityId,
  status (`pending`|`verified`|`failed`|`deleted`), error, updatedAt.
- `coros_exercises`: id (originId), name, raw JSON, updatedAt — synced catalog.
- Generated via `pnpm db:generate`, committed, applied remotely by deploy.yml.

### 3. LLM service (`apps/worker/src/services/studio-llm.ts`)

Reuses `llm.ts`'s proven shape verbatim where possible: Vercel AI Gateway transport
(the repo's established pattern — no new deps, budget metering wired), budget check
BEFORE any call, `llmUsage` cost rows, never-throws graceful degradation.

- `generatePlan(brief, catalog)` — strong tier: env `AI_STUDIO_MODEL_STRONG`, default
  `anthropic/claude-opus-5`. Output: strict JSON matching `LiftingPlan`; zod-validated;
  one retry with the validation errors fed back; then honest failure (UI shows why).
- `editPlan(plan, request, major)` — cheap tier: env `AI_STUDIO_MODEL_EDIT`, default
  the existing `anthropic/claude-haiku-4.5`. Returns a compact operations list
  (`[{op: "replace"|"add"|"remove", path, value?}]`, RFC-6902 subset) applied
  server-side, then full zod re-validation (reject ops that break the schema —
  feedback-retry once). `major: true` routes to the strong model as a regeneration
  with the current plan + request as context.
- **Token efficiency:** prompts are structured stable-prefix-first (rules + catalog
  first, volatile brief/plan/request last). The implementation investigates gateway
  prompt-cache passthrough and uses it if available; it is an optimization, not
  load-bearing — the efficiency design is compact plan JSON + cheap-tier diffs, and
  the $2/$8/$10 rolling budget caps worst case regardless.
- Prompt content: exercise selection restricted to the synced catalog (name + originId
  pairs in the prompt); weight guidance in kg or bodyweight per the verified wire
  encoding; safety rails (progressive overload sanity, rest days respected).

### 4. Exercise catalog sync

The bridge fetches `GET /training/exercise/query?sportType=4` (proven in the spike,
382 entries) and includes `exerciseCatalog: [{id, name}]` in its snapshot payload when
the worker's stored catalog is stale (>7 days; worker echoes staleness in the sync
response). Worker upserts into `coros_exercises`. The LLM prompt embeds the catalog
(compact `name|id` lines); if prompt size becomes a problem the implementer may cap to
a curated subset (≥150 common lifts) — cap documented in code, never silent.

### 5. Push pipeline (productionizing the spike machinery)

- **Domain:** `jobs.ts` kind union gains `create_scheduled_workout` and
  `delete_scheduled_workout` (existing: `move_scheduled_workout`).
- **Bridge:** the spike's proven core is refactored into
  `services/coros-bridge/src/create-executor.ts` shared by the spike and the product:
  plan-scoped schedule read → observed-max id derivation → occupancy check → program
  build from `StudioSession` (verified §(d) encodings: repeat-group containers,
  weight table with string `"6"`/`"7"` display units, catalog originIds) →
  calculate-then-add → status:1 create → read-after-write verify by
  (target plan, happenDay, program-name stamp) → server-id recovery. Deletes:
  triple-addressed, ownership re-proven immediately before every delete,
  refuse-on-ambiguity. THE INVARIANT: no write or delete ever addresses anything
  outside the target container plan, and no delete ever targets a workout whose
  recorded stamp does not match.
- **Worker orchestration:** "Push" computes the diff between the draft and
  `studio_plan_pushes` (added / changed / removed sessions); enqueues creates for
  added, delete+create for changed, deletes for removed. The bridge executes on its
  normal poll; the worker verifies results into `studio_plan_pushes`. Per-session
  status surfaces in the UI; failures are retryable individually. Session workout
  names are the stamp (e.g. "Upper A — wk 3"); names are recorded before push.
- **Drift detection:** before enqueueing, the worker compares the last snapshot's
  container-plan contents against `studio_plan_pushes`; a mismatch (user edited/deleted
  in COROS) marks affected rows and the UI shows "changed on COROS" instead of
  clobbering.
- **Honest copy:** after verification, "COROS calendar updated · open COROS to sync
  your watch" — never "on your watch".

### 6. UI (Plan screen extension, `packages/ui`)

A "Studio" section at the top of the Plan screen (collapsible; the calendar list below
is unchanged — pushed workouts appear there via the normal COROS sync loop):

- **Empty state:** "Create a lifting plan" → intake form (the PlanBrief fields; selects
  and chips for goal/weeks/sessions/days/minutes, free-text for equipment/constraints/
  notes).
- **Draft state:** week-by-week grid — session cards (weekday, title, `exercise ×
  sets×reps @ weight` lines); an edit-request box with a "Major revision" toggle; a
  diff strip vs pushed state (`+N new · ~N changed · −N removed`); "Push to COROS".
- **Pushed state:** per-session status chips (pending / verified / failed-retry /
  changed-on-COROS); "COROS calendar updated…" line.
- **Usage meter:** 7-day LLM spend + the budget ceiling (from `llmUsage`), tiny and
  honest, with the existing warn/cutoff states.
- Discipline color: the studio uses the lifting terracotta `#b5652f` as its accent.

### 7. API routes (worker)

`GET /api/studio` (plan + push status + usage), `POST /api/studio/generate` (brief),
`POST /api/studio/edit` ({request, major}), `POST /api/studio/push`,
`POST /api/studio/push/retry` ({happenDay}). Same auth/session middleware as the rest.

### 8. Fixture mode

`FIXTURE_MODE=1` returns a deterministic canned `LiftingPlan` from `generatePlan`/
`editPlan` (no gateway call), so the full Studio UI works in fixture mode, is
screenshot-testable, and the seeded world exercises push-state rendering (canned push
rows). Live-verification of a real push happens against the real account post-deploy
(reversible: the studio's own delete path removes it).

## Testing

- Domain schema + patch-application unit tests (invalid ops rejected; zod re-validation).
- studio-llm: prompt-builder determinism, budget-gate behavior, retry-on-invalid path,
  fixture mode (gateway stubbed exactly as llm.ts tests do it — follow that pattern).
- Bridge create-executor against the multi-plan mock: build-from-session encodings
  (weight table cases: bodyweight, kg, explicit 0), create+verify+delete cycle, drift
  and ambiguity refusals; the spike's regression suite keeps passing (shared core).
- Worker: route tests for generate/edit/push with stubbed LLM + mock bridge results;
  diff computation; push-state machine transitions.
- UI: typecheck + fixture screenshots (Studio intake, draft grid, pushed chips).
- Full 376+-test suite green throughout; deploy gate enforces.

## Rollout order

1. Domain schemas + DB migration + catalog sync (bridge→worker).
2. Create-executor refactor in the bridge (spike shares the core; spike suite green).
3. Job kinds + worker push orchestration + drift detection.
4. studio-llm service (fixture mode first, then live prompts).
5. API routes.
6. UI (intake → draft grid → edit loop → push/status).
7. Fixture world + screenshots; full suite; deploy.
8. Post-deploy live verification: generate a real 2-week plan, push, verify on COROS,
   delete via the studio, verify restoration.
