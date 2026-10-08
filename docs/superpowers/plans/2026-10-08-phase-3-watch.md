# Phase 3 — Program Sessions on the Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send today's built program session to the COROS watch exactly as previewed, behind a switch that is off, and bring the watch session back as one counted session with a quick review prefilled from the watch's own logged sets.

**Architecture:** A T-code mapping from the library to the COROS catalog; a pure builder in `@rg/coros` that turns watch steps into the spike-proven strength program shape, and a preview read back off that same program; a worker service (`watch-push.ts`) that derives watch steps from the locked build, locks and enqueues a `program_session_push` job, and a new branch in the existing cloud write lane that runs it through `createWorkout`. The import treats a sent program row as app-owned (never rewritten, never archived by absence). After the session, a `watch_review` save on the watch's activity replaces the derived `watch` session. A Worker var, `WATCH_PUSH_ENABLED`, absent by default, guards every write Phase 3 adds.

**Tech Stack:** Hono/D1/Drizzle, zod, vitest + better-sqlite3 (`makeTestDb`), the COROS mock server (`packages/coros/test/mock-coros-server.ts`) plus a renormalizing wrapper (Task 3), React + TanStack Query v5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-3-watch-design.md` (updated 2026-10-08; its §0 lists what changed). Authority: `docs/superpowers/specs/2026-09-30-one-workout-system-design.md` D4, §11. Evidence: `docs/reports/2026-10-04-coros-spikes.md` (§1 lap wire facts, §2 outcome A). Ledgers: `.superpowers/sdd/2026-10-04-phase-2a-plus/progress.md` (2a+-R1..R4), `.superpowers/sdd/2026-09-30-phase-2b-player-review-offline/progress.md` (2b-R3, R5, R7, R9, R18, R19), `.superpowers/sdd/2026-09-30-phase-2a-programs-slots-builds/progress.md` (2a-R4, 2a-R7).

## Global Constraints

- Base: `main` at `a175e19` or later (Phase 2 complete in production; player and import on).
- **The switch.** `WATCH_PUSH_ENABLED` is a Worker var; only `"1"` is on. It stays absent from `wrangler.toml` `[vars]` and `[env.staging.vars]` until Task 12's owner-approved commit. Off: session responses carry `watch: null`, the watch routes answer 404, and the executor never claims `program_session_push`. Deletes and unpushes run whatever the switch says.
- **No COROS write from a session that was not explicitly sent.** The only Phase 3 writes are `program_session_push` (from the send route) and the unpush of a sent copy (`coach_delete_workout`, the existing delete lane). Every other path that can enqueue a COROS job skips `origin = 'program' | 'on_demand'` rows (ruling 2a-R4, extended).
- **Idempotent jobs.** Push id `push:<buildId>`, unpush id `unpush:<buildId>`, both inserted with `onConflictDoNothing`. Ownership is the stamp, proven by the executor before every write (`createWorkout`, `deleteWorkout`), never assumed. Stamps are read back through `coros-stamp.ts`, never stored in a column.
- **Workers Free limits.** At most 3 jobs per `executeCloudJobs` run (`cap` 3, shared with coach jobs) and at most 50 subrequests per invocation. Task 5 measures a three-push run against the mock.
- **D1.** At most 100 bound variables per statement (`D1_BIND_LIMIT`), at most 5 terms per compound SELECT (`D1_COMPOUND_SELECT_LIMIT`). Use `chunkIds` and `insertBatches`, no `UNION`. Write tests with `makeTestDb({ boundVariableCap: D1_BIND_LIMIT })`. No migration: the new state lives in `coros_write_jobs.payload`, `session_builds.payload` (json_set) and existing columns.
- **Garden determinism.** One physical session is counted once. Any test that saves, reviews or merges asserts one activity, one active match and unchanged day inputs where the spec says unchanged.
- **Mock fidelity.** The mock echoes bytes, so it cannot catch a read-after-write bug. Every verify or drift comparison is also tested against `renormalizingCoros` (Task 3), which re-encodes what it stores the way real COROS does. After any real COROS write, do two real reads (never the cached read-now, which single-flights on a 90 s window).
- **Privacy.** No personal data in code, fixtures, snapshots or screenshots. Use synthetic program names ("Strength program", "Mobility program") and library move names. Catalog data is T-codes plus synthesized ids. Grep the diff for the account email before every push (programme spec §16.5).
- **UI.** Three `min-width` tiers, no `max-width` layout queries, a 44 px tap floor, plain labels, no explainer captions. Screenshot matrix at 360 / 390 / 768 / 1280 / 1440, light and dark, zero horizontal overflow, tap-target hit tests (centre plus four 4 px-inset corners). Copy: "Send to watch", "Send", "Sending…", "On your watch", "Couldn't send", "Retry", "Take off watch", "Too long for the watch", "Log your session", "Save", "Not now".
- **Tests.** vitest on Node 21 (Node 22 is for wrangler only). Gates for every task: `pnpm -r typecheck`, `pnpm test`, `TZ=UTC pnpm test`, `pnpm build:web`. Pin the clock with `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(...)`, and pass `today` explicitly to `createWorkout` / `deleteWorkout` (their observation span would otherwise turn a fixed `happenDay` into a time bomb). Before each audit, run the full suite with the clock shifted +45 and +180 days (the `shift-date.mjs` / `RG_DATE_OFFSET_DAYS` technique).
- **Landing.** Small commits; every push to `main` deploys (P3). Batches deploy dark (switch off). Record rulings and progress in `.superpowers/sdd/2026-10-08-phase-3-watch/progress.md`.

## Decisions this plan makes (record as rulings 3-R1..3-R10 in the ledger)

- **3-R1** Mappings key on the T-code; only `exact` is pushed; the computed tier is exact English name only. Cost if wrong: a move goes as free text that could have been a catalog step (it still shows its real name).
- **3-R2** Send has Start's preconditions: today only, current build, pre-check answered, not done. Cost if wrong: no sending a day ahead; the athlete sends on the day.
- **3-R3** A sent session moved in the app is taken off the watch (unpush) and becomes an outline. It is never re-dated on COROS. Cost if wrong: the athlete sends again on the new day.
- **3-R4** The switch is a global Worker var, not a preference (the athlete could flip a preference). Cost if wrong: none for a single-user app.
- **3-R5** A stamp is at most 36 characters, the longest proven to round-trip live (the spike's), with the program name cut to fit and " (2)", " (3)" added on a same-day collision. Cost if wrong: shorter stamps than needed.
- **3-R6** Free-text step names are cut at a word boundary to 30 characters; overviews to 80. Cost if wrong: cosmetic.
- **3-R7** The review pairs watch sets with build entries by library id, then by order only when both sides have the same number left; anything unpaired shows targets. Cost if wrong: a set prefilled against the wrong move, visible and editable before Save.
- **3-R8** A slot holds at most one `app` or `watch_review` session. The first to arrive wins; the other gets 409 `slot_done` (2b-R18 extended). Cost if wrong: a fuller later log is refused; the outbox conflict row shows it.
- **3-R9** The import never rewrites a program row's content. Absence on COROS clears the address and never archives the slot. A program row is a claimant of a wire workout only when the workout carries that row's recorded stamp. Cost if wrong: none; COROS-side edits to a sent session are reported and not adopted.
- **3-R10** Unpushes and deletes run with the switch off; cleanup is the safe direction. Cost if wrong: none.

## Carried in

- 2a+ owner check still pending: open one recent strength session in Activity and confirm the exercises, reps and weights. Task 12 repeats it on the pushed session.
- 2b-R3 / R5 / R18 / R19, the merge, and 2a-R4 / R7 are shipped. Phase 3 extends R18 (3-R8), 2a-R4 (3-R3) and R7's day check (Task 6) and changes nothing else in them.
- Re-review 2b-B2 M-1 (first arrival wins) is the precedent for 3-R8.

## Order

Batch 3-A: Tasks 1–7 (Task 1 runs alongside; Tasks 2 → 3 → 4 → 5 → 6 → 7 in order) → **Audit 3-A** (COROS write safety, idempotency, the import, limits) → **Fix wave 3-A** + narrow re-review → deploy dark.
Batch 3-B: Tasks 8–11 (8 and 10 wait for Task 1's approved mocks) → **Audit 3-B** (UX and responsive, single counting and garden determinism, the review save, privacy) → **Fix wave 3-B** + narrow re-review → deploy dark.
Then Task 12: the owner-approved first live push (the gate).

## Review Focus

1. **Two program sessions on one day, both sent** (or a coach session with the same title that day): each gets its own stamp ("(2)"), each row records its own address, and taking one off never touches the other. Test in Task 5.
2. **The athlete moves or deletes the sent session in the COROS app**: a move is adopted (the build stays, and the review and save accept the new day); a deletion clears the address and posts one note. The slot is never archived, and the app never sends it again on its own. Tests in Tasks 6 and 7.
3. **The athlete moves the slot in the app while its push is running**: the push verifies, then the unpush is queued at once. The watch ends with nothing on the old day, and the new day's slot is an unsent outline. Tests in Tasks 5 and 6.
4. **A watch session that differs from the build** (an extra set, a weight typed in lb, a skipped move, a move added on the watch, free-text laps with no key): the review shows what the watch logged, pairs it correctly, falls back to targets only where nothing was logged, and keeps the extra move. Test in Task 9.
5. **A COROS that re-encodes what it stores** (numbers as strings, an empty overview dropped, recalculated duration): the push verifies, the recorded fingerprints are the observed ones, and the next import posts no "Changed in COROS" note. Tests in Tasks 3 and 7.

---

## Batch 3-A

### Task 1: Mocks (owner approval)

**Files:** none in the repo. One artifact; its URL goes in the ledger.

- [ ] **Step 1:** Mock three surfaces at 390 and 1280, light and dark, in the 2b mocks' system (https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z):
  (a) The session sheet with "Send to watch" beside Start. The preview sheet lists each step as the watch shows it: name, target ("8 reps", "30 s"), weight ("11.3 kg · 25 lb" or nothing for bodyweight), the overview line, the rest. Below the list sit Send and "Too long for the watch" when refused. The sheet states are "Sending…", "On your watch" with Take off watch, and "Couldn't send" with Retry.
  (b) The Today line for a sent session.
  (c) The quick review sheet "Log your session": one row per exercise with set steppers prefilled, the post-check grid, a note, Save and Not now. Today shows a "Log your session" line.
- [ ] **Step 2:** Ask the owner to approve. Record the URL and the approval in the ledger. Tasks 8 and 10 wait for it; nothing else does.

### Task 2: Library ↔ COROS mapping by T-code

**Files:**
- Modify: `packages/exercise-library/src/record.ts` (`CorosMapping.originId` → `key`)
- Modify: `packages/exercise-library/src/validate.ts` (a present `providers.coros.key` matches `/^T\d{4}$/`)
- Modify: `packages/exercise-library/src/exercises/{lower,upper,core-carry,extra-strength,extra-core}.ts` (curated entries)
- Create: `apps/worker/src/services/coros-exercise-map.ts`
- Modify: `apps/worker/src/services/watch-sets.ts` (`libraryResolver` keys on the T-code and makes no catalog read; `libraryIdsByOrigin` removed)
- Modify: `apps/worker/src/services/logged-sets.ts` (`loggedTopKgByWeek` claims the library id through the catalog key)
- Test: `packages/exercise-library/test/coros-mapping.test.ts`, `apps/worker/test/coros-exercise-map.test.ts`; update `apps/worker/test/watch-sets*.test.ts` and the progressions tests that use `libraryIdsByOrigin`

**Interfaces:**
- Consumes: `COROS_EXERCISE_NAMES` (`@rg/providers`), `normalizeExerciseKey` (`exercise-catalog.ts`), `EXERCISES` (`@rg/exercise-library`), the fixture `liveExerciseCatalog()` (`packages/domain/test/coach-survival/catalog.ts`, imported by relative path in tests only).
- Produces:
```ts
// packages/exercise-library/src/record.ts
export interface CorosMapping {
  /** The COROS catalog T-code ("T1041") — what `coros_exercises.name` and a lap's `exerciseNameKey` carry. */
  key: string;
  confidence: "exact" | "close" | "generic";
  method: "curated" | "computed";
}

// apps/worker/src/services/coros-exercise-map.ts
/** The generic catalog steps (Warm Up, Training, Cool Down, Rest): never a movement's mapping. */
export const GENERIC_COROS_KEYS: ReadonlySet<string>; // T1120..T1123
/** The unique T-code whose English name normalizes to the record's name; null for none or several. */
export function computedCorosKey(record: Pick<ExerciseRecord, "name">): string | null;
/** The key the watch gets for a library move: a curated `exact` mapping, else the computed one, else null. */
export function corosKeyOf(exerciseId: string, library?: readonly ExerciseRecord[]): string | null;
/** T-code → library id for every key `corosKeyOf` yields; a key two records yield maps to neither. */
export function libraryIdsByKey(library?: readonly ExerciseRecord[]): Map<string, string>;
```

- [ ] **Step 1: Write the failing library test** (`coros-mapping.test.ts`):
```ts
import { describe, expect, it } from "vitest";
// Relative, as the fixture itself imports it: the library package does not depend on @rg/providers.
import { COROS_EXERCISE_NAMES } from "../../providers/src/coros/exercise-names.js";
import { EXERCISES } from "../src/index.js";
import { liveExerciseCatalog } from "../../domain/test/coach-survival/catalog.js";

const liveKeys = new Set(liveExerciseCatalog().values());
const curated = EXERCISES.filter((e) => e.providers?.coros?.method === "curated");

describe("curated COROS mappings", () => {
  it("exist for the lifts", () => expect(curated.length).toBeGreaterThan(0));
  it.each(curated.map((e) => [e.id, e.providers!.coros!] as const))("%s names a live, English-named, non-generic T-code", (_id, m) => {
    expect(liveKeys.has(m.key)).toBe(true);
    expect(COROS_EXERCISE_NAMES[m.key]).toBeTruthy();
    expect(["T1120", "T1121", "T1122", "T1123"]).not.toContain(m.key);
  });
  it("are only on core or accessory records", () =>
    curated.forEach((e) => expect(e.roles.some((r) => r === "core" || r === "accessory")).toBe(true)));
  it("never share an exact key", () => {
    const keys = curated.filter((e) => e.providers!.coros!.confidence === "exact").map((e) => e.providers!.coros!.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```
- [ ] **Step 2: Write the failing worker tests** (`coros-exercise-map.test.ts`): `computedCorosKey` matches across case and plural ("Goblet squats" ↔ the catalog's "Goblet Squat" T-code); returns null for a name two T-codes share ("Plank Jacks" is T1077 and T1259); never returns a generic key; `corosKeyOf` prefers a curated `exact` over the computed key and ignores a curated `close`; `libraryIdsByKey` drops a key claimed by two records. In `watch-sets` tests: a lap item whose `exerciseNameKey` is a mapped key stores the library id and runs no `coros_exercises` statement (use `makeTestDb`'s `onStatement` hook); an unmapped key stays `coros:<key>`. In the progressions test: `loggedTopKgByWeek` finds a library-id set for a plan `originId` through its catalog row's key.
- [ ] **Step 3: Run them to confirm they fail** (`pnpm --filter @rg/exercise-library test coros-mapping`, `pnpm --filter @rg/worker test coros-exercise-map watch-sets`). They should fail on missing exports, not on syntax.
- [ ] **Step 4: Implement.** Write the curated entries by hand. The rule: the COROS entry is the same movement with the same implement class (a goblet squat is not "Barbell Squat"). When unsure, write no entry; outcome A makes free text safe. Find candidates with `grep -n '"T1[0-9]\{3\}": "<word>' packages/providers/src/coros/exercise-names.ts`. In `watch-sets.ts`, `libraryResolver` becomes `(nameKey) => libraryIdsByKey(library).get(nameKey) ?? null` with no D1 read. In `loggedTopKgByWeek`, replace the `byOrigin` loop with a claim of `libraryIdsByKey(plan.library).get(r.name)` for each catalog row read.
- [ ] **Step 5: Run the gates.** Expected: all green. Watch-set tests that asserted `coros:<key>` for a key that is now mapped are updated, each with a one-line reason.
- [ ] **Step 6: Commit** `feat(library): map library moves to the COROS catalog by T-code`.

### Task 3: The program wire builder, its preview and the text fingerprint

**Files:**
- Create: `packages/domain/src/watch-push.ts` (export from `packages/domain/src/index.ts`)
- Modify: `packages/providers/src/coros/normalize.ts` (`programTextFingerprint`)
- Modify: `packages/coros/src/create-executor.ts`. Extract `strengthContainer` and `strengthChild` from `buildStrengthProgram` as a pure refactor; the existing tests prove nothing changed. Widen `CreateWorkoutSpec.session`, dispatch in `buildProgramFor`, and add `CreateResult.wireTextFingerprint`.
- Create: `packages/coros/src/program-watch.ts` (export from `packages/coros/src/index.ts`)
- Create: `packages/coros/test/renormalizing-coros.ts`
- Test: `packages/coros/test/program-watch.test.ts`, `packages/providers/test/coros-normalize.test.ts` (add)

**Interfaces:**
- Produces:
```ts
// packages/domain/src/watch-push.ts
export const WATCH_NAME_MAX = 30;
export const WATCH_OVERVIEW_MAX = 80;
export const WATCH_STAMP_MAX = 36;
export const WATCH_MAX_STEPS = 200;
export const programWatchStepSchema = z.object({
  /** The athlete's catalog id, or "0" for a move the catalog does not hold (spike outcome A). */
  originId: z.string().min(1).max(40),
  /** The catalog T-code for a catalog step; the move's own name for a "0" step. */
  name: z.string().min(1).max(WATCH_NAME_MAX),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("reps"), reps: z.number().int().min(1).max(500) }).strict(),
    z.object({ kind: z.literal("hold"), seconds: z.number().int().min(1).max(3600) }).strict(),
    z.object({ kind: z.literal("open") }).strict(),
  ]),
  /** kg × 1000 as the wire carries it; null = bodyweight. */
  grams: z.number().int().min(0).max(500_000).nullable(),
  restSeconds: z.number().int().min(0).max(900),
  overview: z.string().max(WATCH_OVERVIEW_MAX),
  /** A per-side pair: a "left" step directly followed by its "right" step shares one container. */
  side: z.enum(["left", "right"]).nullable(),
}).strict();
export type ProgramWatchStep = z.infer<typeof programWatchStepSchema>;
export const programWatchSessionSchema = z.object({
  kind: z.literal("program_watch"),
  /** The athlete-facing title — what the stamp reader un-stamps to. */
  title: z.string().min(1).max(200),
  steps: z.array(programWatchStepSchema).min(1).max(WATCH_MAX_STEPS),
}).strict();
export type ProgramWatchSession = z.infer<typeof programWatchSessionSchema>;
export function isProgramWatchSession(s: unknown): s is ProgramWatchSession;

// packages/providers/src/coros/normalize.ts
/** Names and overviews of a program's real steps (containers dropped), in wire order (sortNo, then index). */
export function programTextFingerprint(program: RawCorosProgram): string;

// packages/coros/src/program-watch.ts
export function buildProgramWatchProgram(spec: CreateWorkoutSpec & { session: ProgramWatchSession }, catalog: Map<string, string>): RawCorosProgram;
export interface ProgramPreviewStep {
  /** As the watch shows it: the English name of a catalog step, the free text of a "0" step. */
  name: string;
  freeText: boolean;
  target: ProgramWatchStep["target"];
  grams: number | null;
  overview: string;
  restSeconds: number;
}
/** Read straight off the wire program — the preview IS the wire. */
export function previewOfProgram(program: RawCorosProgram, englishName: (key: string) => string | undefined): ProgramPreviewStep[];

// packages/coros/src/create-executor.ts
export interface CreateWorkoutSpec { /* … */ session: StudioSession | CoachSession | ProgramWatchSession; }
export interface CreateResult { /* … */ /** `programTextFingerprint` of the program the read-back found. */ wireTextFingerprint?: string; }
```
- Consumes: `FREE_TEXT_ORIGIN_ID` (`spike-program.ts`), `applyWeightIntensity`, `EXERCISE_METADATA`, `TOP_SORT`, `SUB_SORT`.

- [ ] **Step 1: Write the failing builder tests** (`program-watch.test.ts`):
  - Shape: each step becomes a container (`exerciseType 0`, `sets 1`) plus one child. A left/right pair shares one container with two children. `exerciseNum` counts children only. `sortNo` follows `TOP_SORT`/`SUB_SORT`. Compare with the spike's per-side pair from `buildSpikeProgram` (the shape proven live).
  - Targets: reps → `targetType 3`, hold → `targetType 2`, open → `targetType 0`. Grams 11340 → `intensityValue 11340`, `intensityCustom 0`; null → `intensityValue ""`, `intensityCustom 1`; `intensityDisplayUnit "6"`. Rest → `restType 1`, `restValue`; 0 → `restType 3`.
  - Names: a catalog step's name is `catalog.get(originId)` (the T-code); a `"0"` step's name is its own `name`. A non-`"0"` id missing from `catalog` throws before any wire call. A `"0"` step needs no catalog entry.
  - Refusals: zero steps or more than 200 throw (`WATCH_MAX_STEPS`).
  - Preview: `previewOfProgram(buildProgramWatchProgram(x), englishName)` lists exactly `x.steps` in order. Names are English for catalog steps and verbatim for `"0"` steps; targets, grams, overview and rest are equal.
  - End to end: `createWorkout(client, { happenDay, name: "Strength program — 2026-10-09", session }, { catalog, today: "2026-10-09" })` against `mockCorosServer()` returns `ok` with `wireTextFingerprint`. Against `renormalizingCoros()` it is still `ok`, and `wireTextFingerprint === programTextFingerprint(<what the server stored>)`.
  - Refactor proof: the existing `spike-program`, `content-update` and `write-executor` suites pass unchanged.
- [ ] **Step 2: Write `renormalizingCoros()`.** It wraps `mockCorosServer()` and, on every program write, stores what real COROS stores: numeric strings become numbers (`"871.00"` → `871`), an empty `overview` is dropped, `intensityValue: ""` with `intensityCustom 1` loses the key, and `duration` is recalculated. Reads return the re-encoded program. Document in its header which recorded capture (`docs/reports/coros-*.json`) each rule comes from.
- [ ] **Step 3: Run to confirm failure** (`pnpm --filter @rg/coros test program-watch`). Expect missing exports.
- [ ] **Step 4: Implement.** Do the refactor first and run the existing suites. Then `programTextFingerprint` (beside `corosProgramFingerprint`, over `[name, overview ?? ""]` of steps that are not groups and not `exerciseType 0`), then `buildProgramWatchProgram`, `previewOfProgram`, the `buildProgramFor` dispatch (`isProgramWatchSession` checked first) and `wireTextFingerprint` (taken from `found.program` after the read-back, as `wireFingerprint` is).
- [ ] **Step 5: Run the gates.** Commit `feat(coros): a program session's wire program and its preview, one builder`.

### Task 4: Watch steps from a locked build

**Files:**
- Create: `apps/worker/src/services/watch-push.ts` (the pure part: `watchStepsFromBuild`, `programStamp`)
- Test: `apps/worker/test/watch-push-plan.test.ts`

**Interfaces:**
- Consumes: `BuildPayload` (`session-build.ts`), `corosKeyOf` (Task 2), `ProgramWatchStep` and the limits (Task 3), `toKg` and `stampName`/`STAMP_SEPARATOR` (`coros-stamp.ts`).
- Produces:
```ts
export interface WatchPlanDeps {
  /** T-code → the athlete's catalog id; keys the catalog holds twice are absent. */
  catalogIdByKey: ReadonlyMap<string, string>;
  /** Library id → T-code (`corosKeyOf`). */
  keyOf: (exerciseId: string) => string | null;
}
export type WatchRefusal = "empty" | "too_long";
export interface WatchPlan { steps: ProgramWatchStep[]; freeText: number; refusal: WatchRefusal | null }
export function watchStepsFromBuild(build: BuildPayload, deps: WatchPlanDeps): WatchPlan;
/** `<program name> — <date>`, ≤ WATCH_STAMP_MAX: the name cut to fit, " (2)", " (3)" while `taken` holds it. */
export function programStamp(programName: string, date: string, taken: ReadonlySet<string>): string;
```

- [ ] **Step 1: Write the failing tests** with synthetic builds (library move names only):
  - A `timed` step → hold with its `seconds`. A `set` with `target.reps` → reps; with `target.secs` and no reps → hold; with neither → open.
  - `target.w = { v: 25, u: "lb" }` → `grams: 11340`. No `w` → `null`.
  - `side: "Left"` then `"Right"` → two steps, sides `"left"`/`"right"`, overviews starting "left side" / "right side".
  - Consecutive `rest` steps add up onto the previous step's `restSeconds` (capped at 900); a leading rest is dropped.
  - A move with a key the catalog holds → `originId` from `catalogIdByKey` and `name` = the T-code. With no key, or a key absent from the catalog → `"0"` and the library name.
  - "Single-leg Romanian deadlift with reach" → a name of at most 30 characters ending on a whole word. The overview is the side and `text.focus[0]`, joined by " · ", at most 80 characters.
  - 201 work steps → `refusal: "too_long"`; none → `"empty"`. The same build twice gives the same steps.
  - `programStamp("Strength program", "2026-10-09", new Set())` → `"Strength program — 2026-10-09"`. A 40-character name is cut so the whole stamp is at most 36 characters, keeping the separator and date. With the base taken → `" (2)"`; with base and (2) taken → `" (3)"`.
- [ ] **Step 2: Run to confirm failure.** **Step 3: Implement** the loop:
```ts
for (const s of build.steps) {
  if (s.kind === "rest") {
    const prev = steps.at(-1);
    if (prev) prev.restSeconds = Math.min(900, prev.restSeconds + s.seconds);
    continue;
  }
  if (!s.exerciseId) continue;
  const record = build.exercises[s.exerciseId];
  if (!record) continue;
  const key = deps.keyOf(s.exerciseId);
  const originId = key ? deps.catalogIdByKey.get(key) : undefined;
  steps.push({
    originId: originId ?? FREE_TEXT_ORIGIN_ID,
    name: originId ? key! : cutAtWord(record.name, WATCH_NAME_MAX),
    target: targetOf(s),
    grams: s.target?.w ? Math.round(toKg(s.target.w) * 1000) : null,
    restSeconds: 0,
    overview: overviewOf(s.side, record.text.focus[0]),
    side: s.side === "Left" ? "left" : s.side === "Right" ? "right" : null,
  });
}
```
- [ ] **Step 4: Run the gates.** Commit `feat(watch): a locked build's steps as the watch will hold them`.

### Task 5: The switch, the routes, the job and the lane

**Files:**
- Modify: `apps/worker/src/env.ts` (`WATCH_PUSH_ENABLED?: string`; `watchPushEnabled`)
- Modify: `apps/worker/wrangler.toml` (a comment beside `IMPORT_ENABLED` saying the var is absent until the owner-approved gate; no value set)
- Modify: `packages/domain/src/jobs.ts` (`programSessionPushJobSchema`, `PROGRAM_STAMPING_JOB_KINDS`, `STAMPING_JOB_KINDS`, `WATCH_CREATE_JOB_KINDS`)
- Modify: `apps/worker/src/services/coros-stamp.ts` (`CREATE_KINDS` and `recordedStampFor` use `STAMPING_JOB_KINDS`)
- Modify: `apps/worker/src/services/watch-push.ts` (`watchPreview`, `sendToWatch`, `takeOffWatch`, `watchStateOf`, `enqueueProgramUnpush`)
- Modify: `apps/worker/src/services/session-build.ts`. Factor Start's lock into `lockCurrentBuild(…, { as: "start" | "send" })`; `send` leaves `content_state` as it is. Add `SessionResponse.watch` and `sentBuildIdOf`, and export `BuildCtx`. Every session route (`GET`, build, start, unstart and the three new ones) attaches `watch` through one helper, `withWatch(c, session)`, so no response omits it.
- Modify: `apps/worker/src/services/coros-write-cloud.ts` (the `program_session_push` branch; `excludeKinds` gains it while the switch is off)
- Modify: `apps/worker/src/services/plan-mutations.ts` (`WATCH_PLACING_KINDS` + `program_session_push`), `apps/worker/src/routes/plan.ts` (`pushedIds` reads `WATCH_CREATE_JOB_KINDS`)
- Modify: `apps/worker/src/routes/sessions.ts` (three routes), `packages/api-client/src/index.ts` (types + `watchPreview`, `sendToWatch`, `takeOffWatch`)
- Test: `apps/worker/test/watch-push-routes.test.ts`, `apps/worker/test/watch-push-lane.test.ts`, `apps/worker/test/coros-stamp.test.ts` (add)

**Interfaces:**
- Consumes: Tasks 2–4; `createWorkout`, `deleteWorkout`; `claimNextJob(…, { excludeKinds })`; `enqueueUnpushIfOurs` (as the model for `enqueueProgramUnpush`); `connectTestCoros`, `mockCorosServer`.
- Produces:
```ts
// apps/worker/src/env.ts
export const watchPushEnabled = (env: Env): boolean => env.WATCH_PUSH_ENABLED === "1";

// packages/domain/src/jobs.ts
export const programSessionPushJobSchema = z.object({
  workoutId: z.string().min(1),
  buildId: z.string().min(1),
  happenDay: localDate,
  /** The stamp: program name AND ownership proof, ≤ WATCH_STAMP_MAX. */
  name: z.string().min(1).max(WATCH_STAMP_MAX),
  session: programWatchSessionSchema,
  attempts: z.number().int().min(0).optional(),
  /** Written at verify: the fingerprints of what the read-back found. */
  observed: z.object({ wire: z.string(), text: z.string() }).strict().optional(),
}).strict();
export const PROGRAM_STAMPING_JOB_KINDS = ["program_session_push"] as const;
export const STAMPING_JOB_KINDS = [...COACH_STAMPING_JOB_KINDS, ...PROGRAM_STAMPING_JOB_KINDS] as const;
export const WATCH_CREATE_JOB_KINDS = ["coach_create_workout", "program_session_push"] as const;

// apps/worker/src/services/watch-push.ts
export type WatchUnavailable =
  | "not_today" | "not_built" | "done" | "precheck" | "writes_off" | "not_connected" | "too_long" | "empty"
  /** An unpush of this build is queued or running: Send waits for it (a re-send would be a silent no-op). */
  | "taking_off";
export interface WatchState {
  state: "unavailable" | "ready" | "sending" | "on_watch" | "failed" | "off_watch";
  reason?: WatchUnavailable;
}
export interface WatchPreviewDto {
  buildId: string;
  stamp: string;
  steps: Array<ProgramPreviewStep & { load: Weight | null }>; // load: the step's weight in the athlete's unit, the preview's second figure
  freeText: number;
  refusal: WatchRefusal | null;
}
export async function watchPreview(db: Db, env: Env, userId: string, workoutId: string, ctx: BuildCtx): Promise<WatchPreviewDto>;
export async function sendToWatch(db: Db, env: Env, userId: string, workoutId: string, buildId: string, ctx: BuildCtx): Promise<SessionResponse>;
export async function takeOffWatch(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse>;
type WorkoutRow = typeof plannedWorkouts.$inferSelect;
export async function watchStateOf(db: Db, env: Env, userId: string, row: WorkoutRow, session: SessionResponse, prefs: UserPreferences): Promise<WatchState>;
/** Supersede a queued push, queue `unpush:<buildId>` for a pushed one, unlock the sent build (json_set `$.unsentAt`). */
export async function enqueueProgramUnpush(db: Db, userId: string, row: WorkoutRow, now: string, prefs: Pick<UserPreferences, "corosWritesEnabled">): Promise<void>;

// apps/worker/src/services/session-build.ts
export type BuildCtx = { today: string; now: string; prefs: UserPreferences }; // was file-local
export interface SessionResponse { /* … */ /** Null while the switch is off: nothing about the watch renders. */ watch: WatchState | null; }
/** The slot's locked build that a non-superseded `program_session_push` names; null when none was sent. */
export async function sentBuildIdOf(db: Db, workoutId: string): Promise<string | null>;
```
- Routes: `GET /api/sessions/:workoutId/watch-preview`, `POST /api/sessions/:workoutId/send-to-watch` `{buildId}`, `POST /api/sessions/:workoutId/take-off-watch`. All three return 404 `not_found` while the switch is off. Send answers 409 `not_today` | `not_built` | `done` | `precheck` | `writes_off` | `not_connected` | `too_long` | `empty` | `taking_off`, 409 `stale` with the fresh session, and 404 for another user's slot. After a send, the route runs `waitUntilSafe(c, executeCloudJobs(...))` as the plan routes do.

- [ ] **Step 1: Write the failing route tests** (`watch-push-routes.test.ts`, clock pinned, the user's zone set, `connectTestCoros`, `prefs.corosWritesEnabled = true`, `env.WATCH_PUSH_ENABLED = "1"` unless stated):
  - Switch off: every route → 404; `GET /api/sessions/:id` has `watch: null`; no `coros_write_jobs` row.
  - Writes off → 409 `writes_off`; COROS not connected → `not_connected`; a slot dated tomorrow → `not_today`; a profile on with no pre-check for the day → `precheck`; a build the inputs no longer make → 409 `stale`; a 201-step build → `too_long`; another user's slot → 404. None of these writes a job or locks a build.
  - Success: one job `push:<buildId>`, kind `program_session_push`, `status queued`, payload parsing under `programSessionPushJobSchema`, `name` = `programStamp(...)`; the build `locked_at` set; `content_state` still `built`; `watch.state = "sending"`.
  - Sending twice → one job. A `failed` job, or a `superseded` one (its copy was taken off, Task 7), sent again → `queued` with `attempts` reset to 0 and `observed` cleared. A `verified` job whose row still holds the address → no-op.
  - Review Focus 1: two slots of one program on one day, both sent → stamps `"Strength program — 2026-10-09"` and `"… (2)"`; a coach create with title "Strength program" that day also counts as taken.
  - Take off before the push ran → the push `superseded`, no unpush job, the build unlocked (`$.unsentAt` set), `watch.state = "ready"`. Take off after it verified → `unpush:<buildId>` (`coach_delete_workout`) carries the recorded stamp and the address, the build is unlocked at once (a moved slot must build on its new day), and Send answers 409 `taking_off` until the unpush settles.
- [ ] **Step 2: Write the failing lane tests** (`watch-push-lane.test.ts`, `mockCorosServer` + `executeCloudJobs`):
  - A queued push runs. The row gets `source_workout_id = <plan>:<idInPlan>`, `source_id_in_plan`, `source_program_id`, `last_verified_coros_date = happenDay`, `coros_sync_state 'synced'`, `source_content_fingerprint = wireFingerprint`. The job is `verified` with `payload.observed = { wire, text }`. A second run creates nothing (`already_present`).
  - Switch off: a queued push is never claimed, and a coach move queued behind it still runs.
  - Archived, moved to another day, or holding another locked build before claim → `superseded`, zero COROS write calls (count the mock's writes).
  - Review Focus 3: the row is moved between the create and the executor's re-read (a `fetchImpl` hook updates the row when the create's write call passes). Expect the push `verified` and then `unpush:<buildId>` queued.
  - A catalog id that left `coros_exercises` between send and run → `failed`, `lastErrorCategory 'error'`, nothing written.
  - Budget: count the mock's fetches for one push (typical path) and for a three-push run. The three-push run must stay at or under 45. If the measured worst case is over 45, the branch ends the run after two pushes (`outOfBudget = true`), and a test pins that.
  - `renormalizingCoros`: verified, and `payload.observed` equals the fingerprints of the re-encoded program.
- [ ] **Step 3: Write the failing stamp tests:** `loadOwnProgramNames` maps a program stamp (with or without " (2)") to `session.title`; `recordedStampFor` returns the newest verified program stamp for the row.
- [ ] **Step 4: Run all three to confirm failure.**
- [ ] **Step 5: Implement.** The executor branch, beside `coach_create_workout`:
```ts
} else if (job.kind === "program_session_push") {
  const parsed = programSessionPushJobSchema.safeParse(job.payload);
  // malformed → failed 'malformed_payload' (as the coach branches do)
  const spec = parsed.data;
  const row = job.workout;
  const sent = row ? await sentBuildIdOf(db, row.id) : null; // the slot's locked build id
  if (!row || row.archivedAt || row.effectiveDate !== spec.happenDay || sent !== spec.buildId) {
    // superseded, no wire call
  }
  const catalog = await exerciseNameMap(db);
  const result = await createWorkout(
    client,
    { happenDay: String(localDateToCorosDay(spec.happenDay)), name: spec.name, session: spec.session },
    { catalog, today: todayInZone(prefs.timezone), log: () => undefined },
  );
  // ok → stamp the address, wire fingerprint, 'synced'; job verified + payload.observed;
  //      then re-read the row: archived / moved / build no longer locked → enqueueProgramUnpush
  // not ok → the coach create's retry taxonomy (slot_occupied | not_visible | error | undefined retry, cap 3;
  //          isRuntimeLimit requeues without counting)
}
```
  `claimNextJob` gets `excludeKinds: ["backfill", ...(watchPushEnabled(env) ? [] : ["program_session_push"])]`. `watchStateOf`: no push for the locked build → `ready` or `unavailable` with a reason; queued or claimed → `sending`; failed → `failed`; verified with an address → `on_watch`; verified without one → `off_watch`.
- [ ] **Step 6: Run the gates.** Commit `feat(watch): send today's session to the watch — the switch, the job and the lane`.

### Task 6: A sent session's lifecycle in the app, and no write from an unsent one

**Files:**
- Modify: `apps/worker/src/services/session-build.ts`. Start on a sent build moves it to `started` without a rebuild. `unstartSession` keeps a build with a live or verified push locked.
- Modify: `apps/worker/src/services/jobs.ts`. In `applyMove`, a program or on-demand row never gets a move job. A date change on a sent one calls `enqueueProgramUnpush`, and the slot becomes an outline. `emitPendingWork` closes intents for every program row.
- Modify: `apps/worker/src/services/session-save.ts`. The day check also accepts the slot's `effective_date` when the slot holds a sent build (a COROS-side move, Task 7).
- Modify: `apps/worker/src/services/push-absent.ts`, `apps/worker/src/services/content-converge.ts`, `apps/worker/src/services/heal-legacy-sync.ts` (skip program and on-demand rows)
- Modify: `packages/domain/src/watch-address.ts` (`appAuthoredRow(w: { origin: string | null }): boolean`, the one predicate; `jobs.ts appOnlySession` and `import-plan.ts appAuthoredSession` use it)
- Test: `apps/worker/test/watch-push-lifecycle.test.ts`, `apps/worker/test/no-unsent-writes.test.ts`

**Interfaces:**
- Consumes: Task 5 (`enqueueProgramUnpush`, `lockCurrentBuild`, `sentBuildIdOf`).
- Produces: `appAuthoredRow(w: { origin: string | null }): boolean` (`@rg/domain`), used by Task 7.

- [ ] **Step 1: Write the failing lifecycle tests:**
  - Start on a sent build → `started`, the same build id, no new `session_builds` row.
  - Discard after that → `built`, and the sent build is still locked.
  - Review Focus 3, second half: a sent and verified slot moved to tomorrow → `unpush:<buildId>` queued, no `move_scheduled_workout` job, `content_state 'outline'`, the sent build unlocked. A time-only change on the same day → no job, no unlock.
  - Removed (`removeFromPlan`) → the queued push superseded, or the unpush queued by `enqueueUnpushIfOurs` through the program stamp.
  - The save's day check: a slot with a sent build and `effective_date` two days after the build's date accepts a save dated `effective_date`; without a sent build it still answers 422.
- [ ] **Step 2: Write the failing sweep test** (`no-unsent-writes.test.ts`). An account with COROS connected, writes on and the switch on holds program slots in every state: outline in the future, built today, started, done, skipped, and an on-demand one. Run `emitPendingWork`, `pushAbsentSessions` (live, `dryRun: false`), `convergeDivergedContent` over all rows, `healLegacySyncState`, `applyMove` of each slot, a fixture snapshot import, `placeSlots` (including its `retractSlot` path) and `reconcileCompletionStates`. Assert no `coros_write_jobs` row names a program or on-demand row. Then send one slot and assert exactly one `program_session_push` exists.
- [ ] **Step 3: Run to confirm failure. Step 4: Implement.** The `applyMove` branch:
```ts
if (appAuthoredRow(workout)) {
  // Rulings 2a-R4 and 3-R3: a program session's watch copy is never re-dated — its build is made for its day.
  await resolveIntent(db, intentId, now);
  if (fromDate !== req.toDate) {
    await enqueueProgramUnpush(db, req.userId, workout, now, { corosWritesEnabled: req.corosWritesEnabled });
    corosSyncState = "calendar_only";
  } else {
    corosSyncState = workout.corosSyncState; // a time-only change: the watch copy (if any) is still right
  }
}
```
  The existing `toOutline` step below it then outlines the slot. The sent build was unlocked by `enqueueProgramUnpush`, so the new day builds as any moved slot does.
- [ ] **Step 5: Run the gates.** Commit `feat(watch): a sent session's moves, discards and removals, and no write from an unsent one`.

### Task 7: What the import does with a sent session

**Files:**
- Modify: `apps/worker/src/services/import-plan.ts`
- Modify: `apps/worker/src/services/coros-write-cloud.ts`. When the delete branch succeeds on a program row, reset `source_workout_id` to the row's id and `source_id_in_plan` / `source_program_id` to null, and mark that build's push `superseded`. Only then, never at enqueue: until the delete verifies, the copy is still on the watch and the import must keep recognising its stamp.
- Modify: `apps/worker/src/services/sync-notes.ts`, `packages/api-client/src/index.ts`, `packages/ui/src/components.tsx` (two note kinds, copy, dismiss only), `apps/worker/src/routes/sync.ts` (undo refuses them: 422 `not_undoable`)
- Test: `apps/worker/test/watch-push-import.test.ts`

**Interfaces:**
- Consumes: `programTextFingerprint`, `appAuthoredRow`, the verified push jobs (`payload.observed`, `payload.name`).
- Produces: `SyncNoteKind` gains `"watch_copy_changed"` ("Changed in COROS — Run Garden kept its version") and `"watch_copy_removed"` ("Removed from your watch").

- [ ] **Step 1: Write the failing tests.** Each starts from a verified push (Task 5's lane on the mock), then imports a snapshot built from the mock's schedule:
  - (a) Review Focus 5: the same program re-encoded (`renormalizingCoros`) → no note; title, category, sport, stages and summary unchanged.
  - (b) A step renamed on COROS → title, category, sport, stages and summary unchanged; `source_content_fingerprint` = the new wire value; one `watch_copy_changed` note. A second identical import → no second note.
  - (c) The wording heal never touches the row (`appAuthoredIds` reads `WATCH_CREATE_JOB_KINDS`).
  - (d) Review Focus 2: moved on COROS → `effective_date` follows (the existing adopted note), the sent build stays locked, `watch.state = "on_watch"`.
  - (e) Review Focus 2: absent for two reads → not archived; `last_verified_coros_date ''`, `coros_sync_state 'calendar_only'`, `source_workout_id = id`; one `watch_copy_removed` note; `watch.state = "off_watch"`; no job queued.
  - (f) A wire workout carrying a program stamp of this account at an address no row claims → attached to its slot (address recorded), no new `planned_workouts` row. When its slot is archived or holds another locked build → no new row, and `unpush:<buildId>` is queued. That unpush's payload takes the stamp from the push's own payload and the address from the wire workout, because no verified push has recorded either.
  - (g) The program row's old address recycled by COROS for a foreign workout (another name, another sport) → the program row is not a claimant, so it is not rewritten; the foreign workout is imported as any other.
  - (h) Take off watch, the unpush verified → address reset, the push `superseded`, `watch.state = "ready"`. Send again → the same `push:<buildId>` requeued, and it creates afresh. An unpush that fails → the push stays `verified`, and the stamp is still recognised by the next import.
- [ ] **Step 2: Run to confirm failure. Step 3: Implement.** Load the window's verified program pushes once: `workoutId → { name, buildId, observed }` and `stamp → workoutId`. Drop a program row from a wire workout's claimants unless the wire name equals that row's stamp (3-R9). For a program row's content change, take only the fingerprint branch, and post the note when `programTextFingerprint(src.raw.program)` or `src.contentFingerprint` differs from `observed`. In rule 8, a program row gets the address cleared instead of `absence_confirmed`. The orphan-by-stamp check runs before "New workout from COROS".
- [ ] **Step 4: Run the gates.** Commit `feat(import): a sent program session stays the app's — changes reported, removals un-addressed, never archived`.

### Audit 3-A and Fix wave 3-A

- [ ] Freeze the batch at its merge commit. Dispatch parallel finders by dimension: (1) COROS write safety and idempotency (stamps, ids, the in-flight paths, the switch, every enqueue path); (2) the import's interplay with sent rows (rules 7 and 8, recycled slots, notes); (3) limits (subrequests per run, D1 binds, compound SELECTs, CPU of the send route and of one push); (4) the live-account shape (Task 2 renames new watch sets of mapped moves: check Activity names, lift tiles and engine history on a synthetic history shaped like the live one). Adversarial verifiers try to refute each finding. Write the report to `.superpowers/sdd/2026-10-08-phase-3-watch/audit-3-a.md` (generic, no personal data).
- [ ] Fix wave 3-A: criticals and importants test-first in an isolation worktree, then a narrow re-review. Run the full suite, `TZ=UTC`, and the clock-shift runs. Deploy dark: Deploy and CI green, `GET /api/sessions/:id` has `watch: null`, and the watch routes answer 404 in production.

## Batch 3-B

### Task 8: Send to watch in the session sheet

**Files:**
- Modify: `packages/ui/src/components/session-sheet.tsx` (Send to watch beside Start when `session.watch?.state === "ready"`; the states; Take off watch)
- Create: `packages/ui/src/components/watch-preview-sheet.tsx`
- Modify: `packages/ui/src/components/today-program.tsx` (the sent line)
- Test: `packages/ui/test/watch-preview-sheet.test.tsx`; add to `packages/ui/test/session-sheet.test.tsx`, `today-card-program.test.tsx`, `responsive.test.tsx`, `program-tap-floor.test.ts`

**Interfaces:**
- Consumes: `api.watchPreview`, `api.sendToWatch`, `api.takeOffWatch`, `api.drainWatch`, `SessionDto.watch`, the approved mocks (Task 1).
- **The drain (fix wave 3-A, ruling 3-R11).** Send and Take off only queue: neither runs the push lane in its own request (Workers Free budget, every Phase 3 request ≤ 45 D1 statements + COROS fetches). On a 200 from either, the sheet calls `api.drainWatch()` at once (`POST /api/sessions/watch/drain` → `{executed}`; a new request that runs at most one of this athlete's queued pushes or unpushes; 404 while the switch is off), then reads the session (`api.getSession`) for the state, and polls it while `watch.state === "sending"`. A failed drain call is not an error to show: the hourly lane is the fallback, and the sheet keeps "Sending…".
- **The preview is what is sent (fix wave 3-A, audit W-2 / W-8).** `api.watchPreview` answers `digest`, the digest of the payload it rendered; Send posts `{buildId, digest}` (`api.sendToWatch(workoutId, buildId, digest)`), and the route requires it. When the payload Send would queue differs (another session took the stamp, the catalog synced), it answers 409 `{error: "stale_preview", preview}` and writes nothing: the sheet swaps `preview` in for the one it shows, and the next Send carries its digest. A `failed` push previews what Retry will send (Retry posts that preview's digest, so it never loops on 409); a push queued, running or on the watch previews its own payload. The stamp is fixed at the build's first Send.

- [ ] **Step 1: Write the failing tests:**
  - `watch: null` → nothing about the watch renders (sheet and Today).
  - `ready` → Send to watch opens the preview. Each row shows the name, target, kg with the athlete's unit beside it (`11.3 kg · 25 lb`), the overview, and the rest. Send posts `{buildId, digest}` (the shown preview's) and the sheet shows Sending….
  - `too_long` → no Send, the line "Too long for the watch". `failed` → Couldn't send + Retry (Retry previews first, and posts that preview's digest). `on_watch` → On your watch + Take off watch, which confirms first. `off_watch` → nothing.
  - 409 `stale` → the fresh session replaces the sheet's (as Start does). 409 `stale_preview` → the fresh `preview` replaces the shown one, nothing is sent until the athlete taps Send again.
  - Keyboard: Enter on Send; Esc closes the preview.
- [ ] **Step 2: Implement** to the approved mocks. Run the screenshot matrix (360/390/768/1280/1440 × light/dark), the zero-overflow check, and tap-target hit tests on every new control.
- [ ] **Step 3: Run the gates.** Commit `feat(ui): send to watch — preview, states and take off`.

### Task 9: The quick review — server

**Files:**
- Create: `apps/worker/src/services/session-watch-review.ts`
- Modify: `apps/worker/src/services/session-save.ts`. Dispatch on `source`: `app` as today, `watch_review` → `saveWatchReview`. Export the shared helpers (`setRows`, `startOf`, `claimMergeLocks`, `releaseMergeLocks`). `savedByAnother` counts `app` and `watch_review` (3-R8), and an app save meeting a saved review answers `slot_done`.
- Modify: `apps/worker/src/services/completion.ts` (`appSessionOwns` covers `watch_review`)
- Modify: `apps/worker/src/routes/sessions.ts` (`GET /:workoutId/watch-review`), `apps/worker/src/routes/plan.ts` (Today `watchReviews`), `packages/api-client/src/index.ts`
- Test: `apps/worker/test/session-watch-review.test.ts`

**Interfaces:**
- Consumes: the `watch` performed session (2a+, `WATCH_SOURCE`), `removeWatchSessionStatements`, `runAtomically`, `gardenChangeStatement`, `performedSessionSaveSchema` (`source: "watch_review"` already allowed on the wire).
- Produces:
```ts
export interface WatchReviewEntry {
  exerciseId: string;
  perSide: boolean;
  format: SessionFormat | null;
  implement: string | null;
  sets: Array<PerformedSet & { from: "watch" | "target" }>;
}
export interface WatchReviewBasis {
  workoutId: string; buildId: string; activityId: string;
  /** The COROS activity id: the save's `sourceRef`. */
  sourceRef: string;
  localDate: string; startedAt: string; endedAt: string | null; seconds: number;
  entries: WatchReviewEntry[];
  profiles: ConditionView[];
}
/** 3-R7: by library id, then by order only when both sides have the same count left; unpaired build entries → targets; unpaired watch entries kept. */
export function pairWatchSets(build: BuildPayload, watch: ReadonlyArray<{ exerciseId: string; sets: PerformedSet[] }>): WatchReviewEntry[];
export async function watchReviewBasis(db: Db, userId: string, workoutId: string, ctx: { today: string }): Promise<WatchReviewBasis>; // SessionNotFoundError when not offered
export async function saveWatchReview(db: Db, userId: string, p: PerformedSessionWire, hash: string, ctx: SaveCtx): Promise<SaveOutcome>;
// TodayResponse gains:
watchReviews: Array<{ workoutId: string; title: string; date: string }>; // today's and yesterday's, one query, no UNION
```

- [ ] **Step 1: Write the failing pairing tests** (Review Focus 4): mapped moves pair by library id whatever their order. Two free-text moves and two `coros:` watch entries pair by order; three against two do not pair, and the build's entries show `from: "target"` sets. A move added on the watch is kept as its own entry. A watch weight typed in lb stays `{ v: 25, u: "lb" }`. A per-side entry keeps `side` per set. **One watch lap per side (audit 3-A W-1):** every set of a `perSide` entry — a timed window and, since the fix wave, a one-sided rep set too (`watchStepsFromBuild` sends a unilateral move's unsided set as a Left then a Right step in one container) — reaches the watch as two laps, left then right. The review pairs one watch lap per side: each lap stays one performed set, its `side` assigned by alternation (left, right), and each left/right pair answers one build set's target. A test pins that 3 one-sided sets come back as 6 laps → 6 performed sets (left, right, left, right, left, right) against the 3 build sets, never as 6 unsided sets or 6 build sets. A skipped move (no watch sets) shows its targets with `done: false`.
- [ ] **Step 2: Write the failing basis tests:** offered only for a program or on-demand slot completed by an active `coros_plan_link` or `scored_auto` match to an activity with a COROS id, with a locked build, no `app` and no `watch_review` session, on the session's day or the next. The session's day is the build's, or the slot's own date for a sent build that COROS moved (the day check from Task 6). Every one of those failing → 404. `watchReviews` on Today lists today's and yesterday's offered slots.
- [ ] **Step 3: Write the failing save tests:**
  - A save writes one `watch_review` performed session (`source_ref` = COROS activity id) with its sets and the post-check. It deletes the activity's `watch` session. The activity takes the slot's title and the build's discipline, and the match is unchanged (same id, method). The slot is `done`, there is still exactly one activity and one active match, and the garden replay is recorded.
  - For a strength session the garden's day inputs are byte-identical before and after (`buildDayInput`).
  - The same PUT again → `same_payload`; another payload for the same id → `conflict`.
  - 3-R8 both ways → 409 `slot_done`.
  - A later refresh of the activity: `upsertWatchSession` → `app_owned`, and the title and sport stay (`appSessionOwns`).
  - Under `makeTestDb({ boundVariableCap: D1_BIND_LIMIT })` a 300-set review saves.
  - `sourceRef` not the slot's matched activity, or `buildId` not the locked build → 422.
- [ ] **Step 4: Run to confirm failure. Step 5: Implement** with one `runAtomically` batch, the `pending` marker first and the commit marker last (the app save's order). Take the merge locks the app save takes.
- [ ] **Step 6: Run the gates.** Commit `feat(sessions): the quick review after a watch session — prefilled from the watch, saved once`.

### Task 10: The quick review — UI and Today

**Files:**
- Create: `packages/ui/src/components/watch-review-sheet.tsx` (reuses `set-steppers.tsx` and the review's post-check grid from `screens/review.tsx`)
- Modify: `packages/ui/src/components/today-program.tsx` ("Log your session" from `today.watchReviews`)
- Modify: `packages/ui/src/offline/outbox.ts` only if needed. The save goes through the existing outbox (keyed by performed id + payload hash) so it survives being offline.
- Test: `packages/ui/test/watch-review-sheet.test.tsx`; add to `today-card-program.test.tsx`, `responsive.test.tsx`, `program-tap-floor.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - The sheet renders the basis's entries with steppers prefilled (watch values and targets look the same; nothing labels the source), the post-check grid for each profile, and a note.
  - Save enqueues one outbox entry with `source: "watch_review"`, `sourceRef`, `buildId`, and `localDate` = the basis's. Offline → "Saved · will sync".
  - Not now closes and changes nothing. A 409 `slot_done` → the conflict row in Settings → Data.
  - Today shows "Log your session" for each `watchReviews` item and not for a done slot.
- [ ] **Step 2: Implement** to the approved mocks. Run the screenshot matrix, the overflow gate and the tap-target tests.
- [ ] **Step 3: Run the gates.** Commit `feat(ui): log your session — the quick review after the watch`.

### Task 11: Diagnostics for the gate, and the journeys end to end

**Files:**
- Create: `apps/worker/src/services/watch-readback.ts`; route `GET /api/coros/debug/program-readback/:workoutId` in `apps/worker/src/routes/coros.ts` (requireUser)
- Modify: `apps/worker/src/services/coros-strength-set-probe.ts` and its route (`?providerActivityId=` narrows to one activity; new counts: lap items by key shape `tcode | other | empty`, `programExerciseIndex` present or absent and its distinct count)
- Modify: `apps/worker/src/index.ts` (`POST /api/dev/watch-session`, fixture mode only: a COROS strength activity matched to today's sent slot plus its `watch` session from a synthetic lap detail shaped like `watch-sets-fixture.ts`)
- Modify: `apps/web/e2e/fixture-stack.sh` (`--var WATCH_PUSH_ENABLED:${RG_E2E_WATCH:-0}`)
- Create: `apps/web/e2e/watch.spec.ts`
- Test: `apps/worker/test/watch-readback.test.ts`, `apps/worker/test/coros-strength-set-probe.test.ts` (add)

**Interfaces:**
```ts
export interface ProgramReadback {
  /** Our stamped placement found on the row's recorded day. */
  found: boolean;
  date: string | null;
  /** Our own steps only (names, overviews, targets we wrote) — never another workout's data. */
  steps: SpikeStepFields[];
  /** Per step: equal to the preview the push was built from. */
  matchesPreview: boolean[];
  textFingerprintMatches: boolean;
}
export async function programReadback(db: Db, env: Env, userId: string, workoutId: string, opts?: { fetchImpl?: typeof fetch }): Promise<ProgramReadback>;
```

- [ ] **Step 1: Write the failing tests:**
  - The read-back reads COROS directly with no cache (two calls → two `getRawSchedule` calls), returns only the stamped program's fields, and answers `found: false` after an unpush.
  - The probe's response holds counts only: no names, no values (the existing no-raw-values test pattern).
  - The dev route answers 404 outside fixture mode.
- [ ] **Step 2: Write the Playwright journeys** (`RG_E2E_WATCH=1`, Chromium and WebKit):
  - (a) The switch off (default stack) → no watch control on the sheet or Today.
  - (b) Switch on: answer the pre-check → Send to watch → the preview lists the build's moves → Send → "Sending…" (the fixture stack has no COROS connection, so the job stays queued) → Take off watch → nothing about the watch remains.
  - (c) Send today's session again (the build is locked; the job stays queued) → `POST /api/dev/watch-session` → Today shows "Log your session" → the sheet is prefilled → Save → Today shows the session done; through the API: one activity, one performed session (`watch_review`), no `watch` session.
- [ ] **Step 3: Implement. Run the gates and the e2e locally. Commit** `test(e2e): send, take off and log a watch session; diagnostics for the live gate`.

### Audit 3-B and Fix wave 3-B

- [ ] Freeze the batch at its merge commit. Dispatch finders: (1) UX and responsive (the matrix, the 44 px floor, copy against the mocks, no captions); (2) single counting and garden determinism (a synthetic year walked and resimulated in `TZ=UTC` with a review, an app + watch merge, and a review refused by 3-R8: day inputs and hashes as the spec says); (3) the review save (idempotency, offline, the merge locks, bind caps); (4) privacy (fixtures, screenshots, probe and read-back responses). Adversarial verifiers, as in Audit 3-A. Report: `.superpowers/sdd/2026-10-08-phase-3-watch/audit-3-b.md`.
- [ ] Fix wave 3-B test-first, then a narrow re-review. Run the full suite, `TZ=UTC`, and the clock-shift runs. Deploy dark: Deploy and CI green, the switch still absent, the watch routes 404, Today unchanged for the owner.

## Task 12: The first live push (the gate, owner-approved)

**Files:** `apps/worker/wrangler.toml` (one line, only after the owner's yes); the ledger; `docs/reports/2026-10-04-coros-spikes.md` (a §3 for the watch display and the lap probe, counts and our own strings only).

- [ ] **Step 1: Pre-flight.** Batches 3-A and 3-B are deployed dark, Deploy and CI are green, and production holds no `program_session_push` job (`WRANGLER_WRITE_LOGS=false wrangler d1 execute run-garden-db --remote --command "select count(*) from coros_write_jobs where kind = 'program_session_push'"`, Node 22).
- [ ] **Step 2: Ask the owner.** Use these words: "Phase 3 is deployed with the watch switch off. May I turn it on and send one of today's program sessions to your watch? I will read it back twice, ask you to look at the watch once, and can take it off at once." Wait for an explicit yes. Write the answer, with its time, in the ledger. Without a yes, stop here.
- [ ] **Step 3: Turn the switch on.** Add `WATCH_PUSH_ENABLED = "1"` to `[vars]` only (not staging) in its own commit, `feat(watch): turn on program sessions on the watch (owner-approved <date>)`. Push, and wait for Deploy and CI to go green.
- [ ] **Step 4: Send.** In the owner's signed-in browser (Chrome tab, same-origin `fetch`, or the owner taps), open today's session: pre-check answered → Send to watch → keep the preview, then Send. Confirm the job is `verified` and the row holds its address.
- [ ] **Step 5: Read it back twice.** Call `GET /api/coros/debug/program-readback/<workoutId>`, wait at least 90 s, and call it again. Both must show `found: true`, every `matchesPreview` true, and `textFingerprintMatches` true. The next scheduled sync must post no "Changed in COROS" note. If anything differs, go to Step 9.
- [ ] **Step 6: The owner looks at the watch once** after a phone sync: the names (free-text and catalog), targets, weights, cues and per-side steps read correctly. Record what the owner reports (no screenshots in the repo).
- [ ] **Step 7: Complete and review.** The owner does the session (or part of it) on the watch. After the import: the activity matched the slot (record the method, `coros_plan_link` or `scored_auto`); Today offers "Log your session"; the prefill shows the watch's sets; Save. Then Activity shows one session with the reviewed sets, the garden counts it once (Today's meters and that day's input), and no `watch` session remains for the activity. This also closes the 2a+ owner check.
- [ ] **Step 8: Probe** the activity: `GET /api/coros/debug/strength-set-stats?providerActivityId=<id>` (counts only). Record the key shapes of the lap items and `programExerciseIndex`. If free-text laps carry no key, file a follow-up: name them by program position.
- [ ] **Step 9: Cleanup, only if something is wrong.** Take off watch → the unpush verifies → two read-backs show `found: false` → revert the switch commit (Deploy green) → record what was wrong in the ledger and the report. Leave the slot to the app.
- [ ] **Step 10: Close.** Write the results into the report's §3 and the ledger. Phase 3 closes with the programme's phase audit (§16.3).

## Self-Review

- **Spec coverage.** Mapping by T-code (§2) → Task 2. Outcome A wire rules (§3) → Tasks 3–4. Preconditions, preview = wire and stamp (§4.1–4.2) → Tasks 4–5. The job, the lane and in-flight handling (§4.3) → Task 5. Lifecycle (§4.4) → Tasks 5–6. The import (§4.5) → Task 7. The quick review and one session per slot (§5) → Tasks 9–10. The switch (§6) → Tasks 5 and 12. Invariants and limits (§7) → Global Constraints, Task 5's budget test, Task 6's sweep, and Task 9's bind and garden tests. The gate (§8) → Tasks 11–12. Unknowns (§9) → Task 12 Steps 6–8.
- **Review Focus → tests:** 1 in Task 5; 2 in Tasks 6 and 7; 3 in Tasks 5 and 6; 4 in Task 9; 5 in Tasks 3 and 7.
- **Names are consistent across tasks:** `corosKeyOf` / `libraryIdsByKey` (2 → 4, 9); `ProgramWatchStep`, `programWatchSessionSchema`, `WATCH_*` limits (3 → 4, 5); `buildProgramWatchProgram`, `previewOfProgram`, `programTextFingerprint`, `wireTextFingerprint` (3 → 5, 7, 11); `watchStepsFromBuild`, `programStamp` (4 → 5); `watchPushEnabled`, `WatchState`, `sendToWatch`, `takeOffWatch`, `enqueueProgramUnpush`, `sentBuildIdOf`, `lockCurrentBuild` (5 → 6, 7, 8); `appAuthoredRow` (6 → 7); `pairWatchSets`, `watchReviewBasis`, `saveWatchReview`, `watchReviews` (9 → 10); `programReadback` (11 → 12). Job ids `push:<buildId>` and `unpush:<buildId>` throughout.
- **Placeholders:** none. The curated mapping list is content the implementer writes against a stated rule (Task 2 Step 4). Task 5's budget fallback is a fixed rule with a test.
