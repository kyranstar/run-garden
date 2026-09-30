# Phase 2a — Programs, Slots and Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adaptive programs that place flexible slots on the athlete's preferred days, build each slot's session on its day through the ported engine, and show today's program session on the Today card and the session sheet — dark for any account without a program.

**Architecture:** Worker services (`programs`, `program-slots`, `engine-inputs`, `session-build`) around `@rg/session-engine`; new routes `/api/programs`, `/api/sessions`, `/api/conditions`; DTO extensions on `/api/plan/today` and the workout DTO; UI in `@rg/ui` per the published mocks.

**Tech Stack:** Hono, Drizzle/D1, zod, vitest + better-sqlite3 (`makeTestDb`), React + TanStack Query v5, Playwright for the screenshot matrix.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-2-adaptive-program-design.md` §2a (authority: `2026-09-30-one-workout-system-design.md`; engine contract: `2026-09-30-phase-1-model-library-engine-design.md`). Mocks: https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z (sections 1, 2, 6).

## Global Constraints

- Prerequisites merged into this branch: Phase 0 Tasks 1–9, Phase 1 Tasks 1–11 (engine, library, migrations 0024–0027, domain `program.ts`/`performed.ts`/`weights.ts`, registry entries).
- Tests on the default Node 21; wrangler on Node 22 only. Gates per task: `pnpm -r typecheck`, `pnpm test`, `pnpm build:web`.
- D1: ≤ 100 bound variables per statement (`chunkIds`); `makeTestDb({ boundVariableCap: 100 })` in every new DB test.
- Program rows: `lastVerifiedCorosDate = ''`, `corosSyncState = 'calendar_only'`, `origin = 'program'`, `sourceContentFingerprint = 'program'`, ids `slot-<programId>-<YYYY-MM-DD>`.
- The engine is called only from `session-build.ts`; routes never touch engine internals.
- No new LLM calls. No COROS writes. Calendar changes only through the existing reconciler.
- UI: the four-tab nav is unchanged; responsive tiers sm 640 / md 900 / lg 1024 with `min-width` queries only; 44 px tap floor; plain labels, no explainer captions; every new surface renders nothing for an account with no program.
- No personal data in fixtures.

## Review Focus

1. **A slot the athlete moved to another week, then the weekly goal changes** — placement must neither duplicate it nor delete it. Task 2.
2. **Opening a slot whose date has passed, or a future slot** — past → `not_today` with a Move offer; future → preview only, never locked. Task 4.
3. **A build request after Start** — returns the locked build unchanged, `409 locked` for any change. Task 4.
4. **History containing sessions whose exercises left the library** — builds still succeed. Task 3.
5. **Two sessions on one day (a run and a program slot)** — the Today card shows both and the run keeps its existing actions. Task 6.

---

### Task 1: Programs service and routes

**Files:** create `apps/worker/src/services/programs.ts`, `apps/worker/src/routes/programs.ts`; mount in `apps/worker/src/index.ts`; api-client `listPrograms`, `createProgram`, `updateProgram` + types; test `apps/worker/test/programs.test.ts`.

**Interfaces:**
```ts
export interface ProgramDto { id: string; kind: "adaptive"; name: string; status: "active" | "retired";
  config: AdaptiveConfig; block: { number: number; week: number; weeks: number; core: { family: string; exerciseId: string | null; name: string | null }[] } | null;
  week: { placed: number; done: number; goal: number } }
export async function createAdaptiveProgram(db: Db, userId: string, input: { name: string; config: AdaptiveConfig }, now: string): Promise<string>;
export async function listPrograms(db: Db, userId: string, today: string): Promise<ProgramDto[]>;
export async function updateProgram(db: Db, userId: string, id: string, patch: { name?: string; config?: AdaptiveConfig; status?: "active" | "retired" }, now: string): Promise<void>;
```
- [ ] Failing tests: create validates config (zod errors → 422 with issues), lists only this user's programs, update merges config and bumps `updated_at`; a retired program places nothing (asserted in Task 2).
- [ ] Implement; routes call `placeSlots` after create/update (Task 2 stub returns `[]` until Task 2 lands — write Task 2 first if preferred; do not leave a TODO).
- [ ] Gates; commit `feat(programs): adaptive programs — create, list, update`.

### Task 2: Slot placement

**Files:** create `apps/worker/src/services/program-slots.ts`; modify `apps/worker/src/index.ts` (`hourly`: `placeSlotsForAllPrograms`); test `apps/worker/test/program-slots.test.ts`.

**Interfaces:** `export async function placeSlots(db: Db, userId: string, programId: string, today: string, prefs: UserPreferences, now: string): Promise<{ placed: string[]; archived: string[] }>`

Behaviour: spec §2a "Slot placement" exactly (count by `original_plan_date` ISO week including moved/skipped/completed/archived-by-replacement; preferred days then Mon→Sun; never before today; one slot per program per date; row shape per Global Constraints; `separateDayCollisions` over placed dates; re-placement archives only future, unmoved, outline slots no longer wanted, with `archive_reason = 'program_replaced'` and a `user_removed` suppression).

- [ ] Failing tests: fresh program with goal 4 and preferred [Mon, Wed, Fri, Sat] places 4 per week for this week (from today) and `placementWeeksAhead` weeks; running twice places nothing new; a slot moved to next week is not re-placed this week and next week does not get an extra; a skipped slot is not re-placed; lowering the goal to 3 archives the latest unmoved outline slot in each future week; dropping a preferred day moves nothing that was moved by hand; a retired program places nothing; the hourly job covers every active adaptive program of every user; `archive_reason 'program_replaced'` rows get exactly one suppression.
- [ ] Implement (add `'program_replaced'` to the archive-reason union wherever it is typed).
- [ ] Gates; commit `feat(programs): flexible slots on preferred days, placed idempotently`.

### Task 3: Engine inputs from the database

**Files:** create `apps/worker/src/services/engine-inputs.ts`; test `apps/worker/test/engine-inputs.test.ts`.

**Interfaces:**
```ts
export async function loadHistory(db: Db, userId: string): Promise<HistorySession[]>;            // performed_sessions + sets + checks, all sources, date-ascending
export async function loadProgramState(db: Db, programId: string): Promise<Block | null>;        // latest program_blocks row → engine Block
export async function saveProgramState(db: Db, programId: string, block: Block, now: string): Promise<void>; // insert new number or update intent
export async function loadEngineContext(db: Db, userId: string, programId: string, opts: { locationId?: string }): Promise<{ prefs: Prefs; savedIds: string[]; location: EngineLocation; unit: WeightUnit; activeProfiles: string[]; careProfiles: string[] }>;
```
- [ ] Failing tests: history maps sets (weights as typed), flags, checks per profile, `perSide`, formats; an exercise id not in the library passes through unchanged (the engine ignores it); two users never mix; `loadProgramState`/`saveProgramState` round-trip a block with rotations; location falls back to the default place, then to the first; `implements` parse from the stored typed list with `parseWeightList`.
- [ ] Implement with chunked queries.
- [ ] Gates; commit `feat(sessions): engine inputs from performed sessions, blocks, prefs and places`.

### Task 4: Build, start and checks

**Files:** create `apps/worker/src/services/session-build.ts`, `apps/worker/src/routes/sessions.ts` (+ `/api/conditions/checks`); api-client `getSession`, `buildSession`, `startSession`, `recordCheck` + types; tests `apps/worker/test/session-build.test.ts`, `apps/worker/test/session-build-bench.test.ts`.

**Interfaces:**
```ts
export interface BuildRequest { checks?: Record<string, { pre: number | null; feelingOff: boolean }>; overrides?: { mode?: Mode; theme?: string; minutes?: number; locationId?: string }; swaps?: Swaps }
export interface SessionView { mode: Mode; proposedMode: Mode; modeReasons: string[]; theme: { id: string; name: string } | null; proposedTheme: { id: string; name: string } | null; themeReasons: string[]; minutes: number; location: { id: string; name: string }; block: { number: number; week: number; weeks: number; core: { family: string; name: string | null }[]; events: string[] } | null; newMove: string | null }
export interface SessionResponse { workoutId: string; date: string; contentState: "outline" | "built" | "started" | "done"; locked: boolean; checks: Record<string, { pre: number | null; feelingOff: boolean }>; build: BuildPayload | null; view: SessionView | null }
export async function buildSession(db: Db, userId: string, workoutId: string, req: BuildRequest, ctx: { today: string; now: string; prefs: UserPreferences }): Promise<SessionResponse>;
export async function startSession(db: Db, userId: string, workoutId: string, now: string): Promise<SessionResponse>;
```
`BuildPayload` = the programme spec §7.3 shape (`engineVersion`, `inputsHash`, `builtAt`, `steps`, `exercises` slice with full how-to text for the moves in the plan and in its alternatives, `alternatives`, `targets`, `newMove`, plus the view fields).

- [ ] Failing tests (Review Focus 2 and 3 included): build today stores version 1 and returns it; an identical request returns the same version (inputs hash); an override rebuilds as version 2; a swap applies; checks are stored as `pre` rows and replaced on re-check; a daily check today is used when the request has none; future date → preview (`version 0`, not lockable, start → 409); past date → 409 `not_today`; start locks; build after start → 409 `locked` with the locked build; the row's title/category/sport/duration/content_state/session_params are updated per spec (§9.2 discipline: core lift present → strength, else yoga); a block rotation event is persisted to `program_blocks`; another user's workout → 404.
- [ ] Benchmark test: 200-session synthetic history, 20 warm builds, p50 < 5 ms (skip-with-reason on CI if the runner is slower than a stated calibration loop; never silently).
- [ ] Implement.
- [ ] Gates; commit `feat(sessions): build a slot's session on its day, preview ahead, lock on start`.

### Task 5: Today and workout DTOs

**Files:** modify `apps/worker/src/routes/plan.ts` (`/today`: `todaySessions`; workout DTO: `origin`, `contentState`, `programId`); `packages/api-client/src/index.ts` types; test `apps/worker/test/plan-routes.test.ts` additions.

- [ ] Failing tests: a day with a run and a program slot returns both in `todaySessions` ordered by time, each with `origin`/`contentState` and, for the built slot, `{mode, theme, minutes}`; `nextWorkout` unchanged; an account with no program returns `todaySessions` with only its existing rows.
- [ ] Implement; gates; commit `feat(plan): today's sessions, and origin/content state on every workout`.

### Task 6: Today card — the program line and the condition chip

**Files:** modify `packages/ui/src/screens/garden.tsx` (the Today card), create `packages/ui/src/components/condition-check-sheet.tsx`; tests `packages/ui/test/today-program.test.tsx`; screenshot script `apps/web/scripts/shots-2a.mjs` (throwaway, not committed; outputs to the scratchpad).

Per mocks §1: the run keeps its title and actions; a program slot is one line (`dot · name · mode · minutes · time` + Start/Continue/Done); a program-only day gives the program session the title with a one-line summary and Start/Open; the condition chip ("Jaw check" / "Jaw 2") beside the readiness chip opens the check sheet (0–10 grid in two rows of 44 px targets, Feeling off, Save → `recordCheck`). The chip's label comes from the profile (`check.label` first word) — no condition word hard-coded in UI code.

- [ ] Failing component tests for each state (no program; run + slot; slot only, outline; built; started; done; chip before/after check).
- [ ] Implement; `packages/ui/test/responsive.test.tsx` stays green (no max-width queries; `GARDEN_PART_KEYS` order unchanged or updated deliberately).
- [ ] Screenshot matrix 360/390/768/1280/1440 × light/dark on a fixture stack seeded with a program (add a fixture program + two slots to `services/fixtures.ts` — synthetic), zero horizontal overflow, tap-target hit tests (centre + 4 inset corners) on Start and the chip.
- [ ] Gates; commit `feat(ui): today's program session and the condition check on the Today card`.

### Task 7: The session sheet for program slots

**Files:** modify `packages/ui/src/screens/plan.tsx` (`WorkoutDetail` branches on `origin`), create `packages/ui/src/components/session-sheet.tsx`, `packages/ui/src/components/exercise-howto.tsx`; tests `packages/ui/test/session-sheet.test.tsx`.

Per mocks §2–3: pre-check first when unanswered; mode/theme/time/place chips (each a short picker → rebuild); one reason line; blocks with format markers; rows with target, ↑ for "up today", New tag; ⇄ opens the alternatives list (Use → rebuild with the swap; "Don't show again" → exclude); ⓘ opens the how-to sheet (summary, setup, steps, focus/mistakes/breathing, the active profile's note, easier/harder, last time + best, rating/not-for-me/pin — ratings write through `PUT /api/library/:id/prefs` in 2c; until then those controls are omitted, not dead). Start → `startSession` → navigate to `/session/:id` (the route arrives in 2b; until then Start stays hidden behind the same gate as the player: `features.player === false`).

- [ ] Failing tests per state; implement; screenshot matrix as Task 6; gates; commit `feat(ui): the session sheet — pre-check, proposal, moves, swaps and how-to`.

### Task 8: Plan — the program card and program settings

**Files:** modify `packages/ui/src/screens/plan.tsx` / `plan-cards.tsx` (a program card per mocks §6; slots in the week use `--hue-yoga`/`--hue-strength` by category), create `packages/ui/src/components/program-settings-sheet.tsx` (weekly goal, preferred days, minutes, place, block length, modes, care on/off, name, retire); tests `packages/ui/test/program-card.test.tsx`.

Program creation UI ("New program…") is hidden until 2b ships (`features.player`); the card renders for existing programs.

- [ ] Failing tests; implement; screenshot matrix; gates; commit `feat(ui): the program card and its settings`.

## Self-Review

- Spec §2a coverage: programs API (1), placement (2), build API + rules + CPU budget (3, 4), Today/Plan DTOs (5), UI Today (6), session sheet (7), Plan card (8).
- Review Focus → tests: 1 in Task 2, 2–3 in Task 4, 4 in Task 3, 5 in Tasks 5–6.
- Gating: `features.player` (a constant in `packages/ui/src/features.ts`, `false` until 2b) hides Start and program creation; everything else is dark by data.
