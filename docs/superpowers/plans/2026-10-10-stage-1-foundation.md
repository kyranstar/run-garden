# Stage 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One rich, versioned workout document for every workout; a library rich enough for intentional design (contraction types, muscles, purposes, tags, themes, new condition-gated plyometric / ski / yoga moves); the athlete's profile and objectives with computed key results; converters, storage, dual-write, backfill and read APIs — the ground the Studio and the coach designer stand on.

**Architecture:** A new pure package `@rg/workout` holds the document's derivations, validation, converters and adapters (it depends on `@rg/domain` for the schema and `@rg/exercise-library` for the vocabulary), so the Worker and the UI share one implementation. The schema itself lives in `@rg/domain`. Storage is additive (JSON columns + three tables); every source dual-writes the document; readers switch in later stages.

**Tech Stack:** TypeScript, zod, pnpm workspaces, Cloudflare Workers + D1 (Drizzle), Hono, vitest + better-sqlite3 (`makeTestDb`).

**Spec:** `docs/superpowers/specs/2026-10-10-studio-coach-programme-design.md` §3 (Stage 1). **Principles (binding):** `docs/principles/workout-system-principles.md`. **Private companion** (personal specifics; never copied into the repo): `/Users/kyranadams/src/run-garden/.superpowers/private/athlete-context.md`.

## Global Constraints

- Public repository: no personal data in code, tests, fixtures, snapshots, commit messages or screenshots (principles §0, §8). Personal specifics only in the database and the private companion.
- Every request ≤ 45 combined D1 statements + external fetches (Workers Free); pin with a counting test (`makeTestDb({ onStatement })`).
- D1: ≤ 100 bound parameters per statement (`makeTestDb({ boundVariableCap: 100 })`), ≤ 5 terms per compound SELECT; chunk `IN` lists (`chunkIds`).
- Never export a non-function from `apps/worker/src/index.ts` (constants → `apps/worker/src/services/cron-limits.ts`).
- Node: vitest on the default node 21; node 22 only for wrangler (`PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`, `WRANGLER_WRITE_LOGS=false`).
- Gates per commit: `pnpm -r typecheck` clean. Per batch end: `pnpm test` and `TZ=UTC pnpm test` (`--maxWorkers=4` on a loaded machine).
- Schema changes additive only; every new user table registered in `apps/worker/src/services/account-tables.ts` (export, restore, delete-all) — keyed by a single `id` column (`<user_id>:<…>` convention where it is per-user singleton).
- Production data writes (seed, backfill) only via the steps that say so, dry run first, verified (owner-approved 2026-10-10).
- Test first (record RED), then mutation-check each guard (revert → a test fails). Commit messages in the repo's style, ending with the two attribution lines.
- UI copy rules (if any text surfaces): plain words, no explainer captions.
- Library records: every text in plain English; no links or handles (existing validation); condition ratings with a note for every active profile (TMJ).

## Review Focus

1. **A legacy exercise id or a renamed move inside an old workout** — converters must canonicalise through `legacyIds` and keep unknown names as `free_exercise`, never drop the item. Test in Task 9.
2. **A plyometric move on a high-symptom or recovery day** — the engine, the validator and (later) the coach must never place it; the gate is the TMJ profile rule keyed on the `plyometric` contraction. Tests in Tasks 5 and 8.
3. **Weights typed in lb** — the document stores `{ typed, kg }`; converters from coach weights ("25 lb", "12kg", "bodyweight") and stages (`loadKg`, `loadBodyweight`) round-trip; display stays as typed. Test in Task 9.
4. **The backfill killed mid-way or run twice** — resumable and idempotent; a second run writes nothing; no row's existing columns change. Test in Task 14.
6. **A coach, Studio or template workout on a flare day, an unanswered check day or a future day**: every profile rule applies to every source (validator parity, Amendment A in Task 8); unanswered is not allowed; a future gated item needs a passing alternate. Tests in Task 8.
5. **An empty or malformed `workout_doc` on read** (old rows, partial writes) — every reader of the column tolerates null and invalid JSON (falls back to the old format, reports via the parity diagnostic), never 500s. Tests in Tasks 6 (`parseStoredWorkoutDoc`) and 12 (parity).

---

## Batch 1A — the richer library (no schema change)

### Task 1: Vocabularies and record fields

**Files:**
- Modify: `packages/exercise-library/src/vocab.ts` (add `MUSCLES`, `MUSCLE_REGION`, `CONTRACTIONS`, `PURPOSES`, `TAGS`, `THEME_IDS` export if not already exported, labels)
- Modify: `packages/exercise-library/src/record.ts` (`ExerciseRecord` gains `contraction`, `muscles`, `purposes`, `themes`; `text.summary` documented as the ≤ 90-char card line)
- Modify: `packages/exercise-library/src/define.ts` (defaults: none for the new required fields — they must be written)
- Modify: `packages/exercise-library/src/validate.ts` (validate the new fields)
- Modify: `packages/exercise-library/src/index.ts` (export the new vocabularies)
- Test: `packages/exercise-library/test/validate.test.ts`, new `packages/exercise-library/test/enrichment.test.ts`

**Interfaces — Produces:**
```ts
export const MUSCLES = [ /* as built in Task 1 (9512ac8) — the draft list was refined before curation:
  jaw → masseter, temporalis, pterygoids; calves → gastrocnemius, soleus; abductors → glute-min-tfl; added suboccipitals,
  sternocleidomastoid, levator-scapulae, peroneals, serratus-anterior, middle-traps, multifidus, pelvic-floor */ ] as const;
export type MuscleId = (typeof MUSCLES)[number];
/** Each muscle sits under one region (the anatomy view and region filters agree). */
export const MUSCLE_REGION: Record<MuscleId, Region>;   // e.g. "glute-med" → "glutes", "deep-hip-rotators" → "hips", "masseter" → "jaw", "diaphragm" → "core"
export const CONTRACTIONS = ["isometric", "isotonic", "eccentric", "plyometric"] as const;
export type Contraction = (typeof CONTRACTIONS)[number];
export const PURPOSES = ["warmup", "activation", "strength", "power", "balance", "mobility", "stretch", "cooldown",
  "recovery", "condition-care", "conditioning"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const TAGS = ["posture", "ski", "hip-opening", "glute-activation", "single-leg", "landing", "deceleration",
  "anti-rotation", "desk-relief", "breath", "thoracic", "ankle", "balance", "rotational", "lateral", "grip",
  "core-stability", "elastic", "eccentric-emphasis", "isometric-hold"] as const;
export type Tag = (typeof TAGS)[number];
// ExerciseRecord additions:
contraction: readonly Contraction[];                 // ≥ 1
muscles: { primary: readonly MuscleId[]; secondary: readonly MuscleId[] };   // primary ≥ 1
purposes: readonly Purpose[];                        // ≥ 1
themes: readonly string[];                           // theme ids from themes.ts (may be empty)
tags: readonly Tag[];                                // was readonly string[]; now the controlled vocabulary
```

- [ ] **Step 1: Write the failing tests** in `enrichment.test.ts`: every record has `contraction.length ≥ 1`, `muscles.primary.length ≥ 1`, `purposes.length ≥ 1`; every value is in its vocabulary; `text.summary.length ≤ 90`; every `themes` id exists in `THEMES`; at least one primary muscle's region (`MUSCLE_REGION[m]`) is listed in the record's `regions` (curation must not change `regions` — the engine's coverage depends on them); `MUSCLE_REGION` covers every `MUSCLES` entry and maps to a `REGIONS` value; tags ⊂ `TAGS` (the existing `desk-relief` stays valid).
- [ ] **Step 2: Run** `cd packages/exercise-library && npx vitest run test/enrichment.test.ts` — expect FAIL (fields missing).
- [ ] **Step 3: Implement** the vocabularies, record fields and `validate.ts` checks (each failure message names the record id and the field, the existing style). Land the four fields **optional** in `ExerciseInput` and `ExerciseRecord` for now (so every commit typechecks), with `defineExercises` leaving them undefined; the enrichment test stays RED until Tasks 2–3 curate every record, and Task 4 flips them to required.
- [ ] **Step 4: Commit** `feat(library): vocabularies for muscles, contraction types, purposes and tags`.

### Task 2: Curate the existing records — lower body, upper body, core and carry

**Files:**
- Modify: `packages/exercise-library/src/exercises/lower.ts`, `upper.ts`, `core-carry.ts`, `extra-strength.ts`, `extra-core.ts`

**Rules (apply to every record; principles §4):**
- `contraction`: what the move trains: holds (`dose.type: "time"` and static) → `isometric`; reps through range → `isotonic`; a deliberate slow lowering cue or a Nordic-type move → add `eccentric`; jumps, hops, bounds, rebounds → `plyometric`. A record may carry several (a tempo split squat: `isotonic`, `eccentric`).
- `muscles.primary`: the 1–3 muscles that limit the move; `secondary`: the main assistants. Use the anatomy, not the region list blindly (e.g. goblet squat → primary `quads`, `glute-max`; secondary `adductors`, `erector-spinae`).
- `purposes`: from roles and intent (a core-role squat → `strength`; a glute bridge → `activation`, `strength`; a dead bug → `strength` with tag `core-stability`).
- `tags`: from the vocabulary only where they truly apply (`single-leg` for unilateral leg work; `posture` for moves whose `why` is posture; `ski` for moves that build ski demands — lateral control, eccentric quads, isometric hip/knee holds, single-leg balance).
- `themes`: the theme ids whose emphasis the move serves (read `themes.ts`).
- `text.summary` ≤ 90 characters, one line, plain words (rewrite only where longer; keep the meaning).

- [ ] **Step 1:** The enrichment test from Task 1 is RED for these files' records.
- [ ] **Step 2:** Curate each record in the five files per the rules.
- [ ] **Step 3:** Run `npx vitest run test/enrichment.test.ts -t` scoped to these records (or the whole file and count the remaining failures) — these files' records pass.
- [ ] **Step 4: Commit** `feat(library): curate lower, upper, core and carry moves — contraction, muscles, purposes, tags, themes`.

### Task 3: Curate the existing records — mobility, jaw and neck, breath and downshift, pass-two

**Files:**
- Modify: `packages/exercise-library/src/exercises/mobility.ts`, `extra-mobility.ts`, `jaw-neck.ts`, `extra-jaw-neck.ts`, `breath-downshift.ts`, `extra-pass-two.ts`

Same rules as Task 2; mobility and stretches are usually `isotonic` (moving through range) or `isometric` (held stretches, loaded end-range holds); breathing → `isometric` is wrong — breathing drills are `isotonic` with purpose `recovery`/`condition-care` and muscle `diaphragm`; jaw-care moves carry the jaw muscles they work (`masseter`, `temporalis`, `pterygoids`) and purpose `condition-care`.

- [ ] **Step 1–3:** as Task 2 for these files.
- [ ] **Step 4: Commit** `feat(library): curate mobility, jaw, breath and second-pass moves`.

### Task 4: Required fields, themes for the new tags, and the route filters

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- Slim rows gain `lastDoneOn: string | null` and `timesDone30d: number` from ONE grouped query over the athlete's performed work (find the performed-sets / moves-done tables in `packages/database/src/schema/performed.ts`; chunk ids; count statements).
- `GET /api/library/:id`: each history set carries its `flags` (e.g. the clenched flag).
- Extra filters `position`, `laterality`, `maxDifficulty`, `limit` (default 50, max 200); results ranked: exact name, then name prefix, then name/summary/tag contains, then the rest; ties by condition fit then name.
- `validate.ts` (deferred from Task 1): reject a muscle listed in both `primary` and `secondary` and repeats in any list; enforce the muscle-region rule over primary AND secondary muscles (at least one of them sits in the record's `regions`), as ruled after the curation review.
- The `plyoIntro` theme lands in Task 5 with its moves, not here.

**Files:**
- Modify: `packages/exercise-library/src/define.ts`, `record.ts` (fields required)
- Modify: `packages/exercise-library/src/themes.ts` (new themes `skiPrep`, `athleticBase`, `plyoIntro` with emphasis on the new tags/patterns; modes as in the existing ones — `plyoIntro` is never a recovery theme)
- Modify: `apps/worker/src/routes/library.ts` and `apps/worker/src/services/library-view.ts` (query filters `purpose`, `tag`, `theme`, `muscle`, `contraction`; slim rows include `summary`, `purposes`, `contraction`, `tags`, primary muscles)
- Test: `packages/exercise-library/test/enrichment.test.ts` (now GREEN), `apps/worker/test/library-routes.test.ts` (find the existing test file with `grep -rln "api/library" apps/worker/test`; add cases)

- [ ] **Step 1: Write failing route tests**: `GET /api/library?purpose=activation` returns only records with that purpose; `?contraction=plyometric` only plyometric ones; `?muscle=glute-med`; `?tag=ski`; `?theme=hipsPosture`; an unknown value → 422 `invalid_query`; a combined filter; statements ≤ 45.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the filters (pure filtering in `library-view.ts` over the package's records — the library is in memory; no D1 for the filter itself) and make the new record fields required.
- [ ] **Step 4: Run** the library package tests, the route tests, `pnpm -r typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(library): the new fields are required; themes for ski prep, athletic base and plyometric intro; the library route filters by purpose, tag, theme, muscle and contraction`.

### Task 5: New moves — graded plyometrics, ski-specific, yoga flows — condition-gated

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- The plyometric rule lives in a new optional `ConditionProfile` hook `allowRecord?(ex: ExerciseRecord, mode: Mode, today: CheckReading): boolean` (default allow) in `conditions/types.ts`, called by `eligibility.ts` beside `allowPattern`; TMJ implements it. The validator (Task 8) calls the same hook.
- `wallSit` already exists (curated in Task 2): extend existing records instead of duplicating; check every name first.
- The `plyoIntro` theme lands here, never a recovery theme.
- New records follow the curation rulings: `contraction` may be `passive` (no deliberate effort against resistance); the muscle-region rule is over primary and secondary.

**Files:**
- Create: `packages/exercise-library/src/exercises/athletic.ts` (plyometrics + ski-specific), `packages/exercise-library/src/exercises/flows.ts` (yoga flows)
- Modify: `packages/exercise-library/src/exercises/index.ts` (register both)
- Modify: `packages/exercise-library/src/conditions/tmj.ts` (a rule for `plyometric` moves)
- Test: `packages/exercise-library/test/profile-tmj.test.ts`, `packages/session-engine/test/` (a new `plyometric-gate.test.ts`)

**Content (curate each to the existing standard — full text, dose, difficulty, easier/harder links, TMJ ratings with notes, `providers.coros` only when exact):**
- Plyometric ladder (difficulty rising; `contraction: ["plyometric"]`, tags `landing`/`elastic`/`deceleration` as fit): `landingStick` (drop from a small step to a quiet, stuck landing), `snapDown`, `pogoHop`, `lineHopForwardBack`, `lineHopLateral`, `skaterBoundLow`, `skaterBoundStick`, `lateralHopStick`, `broadJumpStick`, `boxJumpStepDown`, `dropLanding` (from a low box), `tuckJump` (hardest; build only).
- Ski-specific: `wallSit` (isometric), `wallSitSingleLegShift`, `singleLegBalanceReach` (balance), `copenhagenPlankShort` (adductors, isometric), `nordicCurlAssisted` (eccentric hamstrings), `lateralLungeToBalance`, `skaterSquat`, `isometricSplitSquatHold`, `pallofIsoHoldHalfKneel` (anti-rotation) — only those not already in the library (check names and families first; extend an existing record instead of duplicating).
- Yoga flows (`purposes` mobility/recovery; `isotonic`): `hipOpeningFlow`, `thoracicFlow`, `downRegulationFlow`, `skiHipFlow` (lizard → pigeon → 90/90 sequence as one flowing move with its steps), `morningMobilityFlow`.
- TMJ ratings: jumps and bounds carry real clench and neck-load risk — rate honestly (most plyometrics `clench: 1–2`; `tuckJump`/`dropLanding` `clench: 2`); notes cue "teeth apart, tongue up, soft landing".
- **TMJ rule** (`tmj.ts`): a record whose `contraction` includes `plyometric` is **never in recovery mode**, and in other modes only when the day's pre-check is answered and ≤ 2 (mirror the existing overhead-pressing rule at `tmj.ts:75`); the gentlest variant (lowest difficulty in its family) first — the engine's difficulty ladder already prefers it.

- [ ] **Step 1: Write failing tests**: library `validate` passes for the new records; `profile-tmj.test.ts`: the plyometric rule rejects a plyometric move in recovery and when the pre-check is unanswered or > 2, allows it at ≤ 2 in consistent/build; engine `plyometric-gate.test.ts`: over 200 seeded builds in recovery mode no plyometric move appears; with pre-check 4 none appears; with pre-check 1 in build mode plyometrics may appear and only from the low-difficulty end first.
- [ ] **Step 2: Run** — FAIL (records absent, rule absent).
- [ ] **Step 3: Implement** the records and the rule.
- [ ] **Step 4: Run** the library and engine suites; the coverage-presets test (every block still has ≥ 3 candidates per mode) — PASS.
- [ ] **Step 5: Commit** `feat(library): graded plyometrics, ski-specific moves and yoga flows — the jaw profile gates every plyometric`.

**Batch 1A end:** full gates; audit (principles conformance for the library §4, curation accuracy on a sample, safety of the plyometric gate, privacy); fix wave; re-review; deploy (no schema change).

---

## Batch 1B — the workout document (pure code)

### Task 6: The schema (`@rg/domain`)

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- **Exercise item** adds `cue?: string (max 160)`, `alternates?: Array<{ libraryId: string; why?: string (max 120) }> (max 3)`, `test?: { keyResultId?: string }`. **Free exercise** adds `cue?`.
- **Dose** adds `max?: true` ("to max": `holdSec` / `reps` become a floor or target, not a cap).
- **Run item**: `target` = `{ durationSec?, distanceM?, typed?: string (max 20, the distance as typed, e.g. "3 mi"), open?: true (lap button), pace?: { fastSecPerKm: number; slowSecPerKm: number }, hr?: { low: number; high: number }, zone?: { kind: "pace" | "hr"; index: number (1-6) } }`, refined to need a duration, a distance or `open`; plus `cue?`. `RUN_EFFORTS` = `easy, recovery, steady, long, tempo, threshold, interval, hills, strides, race, by_feel`.
- `PART_FORMATS` adds `"holds"`.
- **Document** adds `setting?: { placeId?: string; equipment?: string[] (max 20, ids checked by the validator); targetMinutes?: number }` and `basedOn?: { kind: "workout" | "template" | "performed" | "proposal"; id: string; rev?: number }` (lineage; `source` stays who wrote it).
- A comment in `workout-doc.ts`: vocabulary (enum) additions after v1 require `version: 2` and a converter, because older cached clients parse strictly. Unknown optional keys are stripped, not rejected (zod default).
- Rest-day rows carry no document.

**Files:**
- Create: `packages/domain/src/workout-doc.ts`; Modify: `packages/domain/src/index.ts` (export it)
- Test: `packages/domain/test/workout-doc.test.ts`

**Interfaces — Produces** (exact):
```ts
import { z } from "zod";
export const WORKOUT_DOC_VERSION = 1;
export const GOAL_IDS = ["ski", "posture", "athleticism", "alignment", "condition-care", "aerobic-base", "speed", "strength", "mobility", "recovery"] as const;
export const PART_PURPOSES = ["arrive", "warmup", "activation", "main", "power", "accessory", "conditioning", "run", "care", "cooldown"] as const;
export const PART_FORMATS = ["straight", "superset", "circuit", "flow", "intervals", "steady", "ladder"] as const;
export const RUN_EFFORTS = ["easy", "steady", "threshold", "interval", "rest", "strides"] as const;
export const EFFORT_LEVELS = ["recover", "maintain", "develop", "peak"] as const;
export const DOC_SOURCES = ["engine", "coach", "studio", "coros_import", "standalone_import", "athlete", "template"] as const;

export const doseSchema = z.object({
  sets: z.number().int().min(1).max(20).optional(),
  reps: z.union([z.number().int().min(1).max(200), z.object({ min: z.number().int().min(1), max: z.number().int().min(1) })]).optional(),
  holdSec: z.number().min(1).max(3600).optional(),
  breaths: z.number().int().min(1).max(200).optional(),
  carryM: z.number().min(1).max(5000).optional(),
  perSide: z.boolean().optional(),
  tempo: z.object({ eccentricSec: z.number().min(0).max(20).optional(), pauseSec: z.number().min(0).max(30).optional(), concentricSec: z.number().min(0).max(20).optional() }).optional(),
  load: z.union([z.object({ typed: z.string().min(1).max(20), kg: z.number().min(0).max(500) }), z.literal("bodyweight")]).optional(),
  restSec: z.number().min(0).max(900).optional(),
});
export const itemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exercise"), libraryId: z.string().min(1).max(80), dose: doseSchema, side: z.enum(["left", "right"]).optional(), why: z.string().max(160).optional(), progression: z.string().max(120).optional() }),
  z.object({ kind: z.literal("free_exercise"), name: z.string().min(1).max(80), dose: doseSchema, why: z.string().max(160).optional(), coros: z.object({ key: z.string().max(20).optional() }).optional() }),
  z.object({ kind: z.literal("run"), target: z.object({ durationSec: z.number().min(1).max(86400).optional(), distanceM: z.number().min(1).max(500000).optional() }).refine((t) => t.durationSec !== undefined || t.distanceM !== undefined, "a run segment needs a duration or a distance"), effort: z.enum(RUN_EFFORTS), why: z.string().max(160).optional() }),
  z.object({ kind: z.literal("rest"), seconds: z.number().min(1).max(3600) }),
]);
export const partSchema = z.object({
  purpose: z.enum(PART_PURPOSES), why: z.string().max(160).optional(), format: z.enum(PART_FORMATS),
  rounds: z.number().int().min(1).max(50).optional(), restBetweenRoundsSec: z.number().min(0).max(900).optional(),
  items: z.array(itemSchema).min(1).max(60),
});
export const workoutDocSchema = z.object({
  version: z.literal(WORKOUT_DOC_VERSION),
  title: z.string().min(1).max(80),
  intent: z.object({
    summary: z.string().min(1).max(200),
    goals: z.array(z.enum(GOAL_IDS)).max(6),
    focus: z.array(z.string().min(1).max(40)).max(12),          // region or muscle ids — checked against the library vocabularies by `validateWorkoutDoc`
    effort: z.enum(EFFORT_LEVELS),
    objectiveIds: z.array(z.string().min(1).max(80)).max(10).optional(),
  }),
  parts: z.array(partSchema).min(1).max(20),
  source: z.object({ kind: z.enum(DOC_SOURCES), ref: z.string().max(200).optional() }),
  notes: z.string().max(500).optional(),
});
export type WorkoutDoc = z.infer<typeof workoutDocSchema>;
export type WorkoutPart = z.infer<typeof partSchema>;
export type WorkoutItem = z.infer<typeof itemSchema>;
export type WorkoutDose = z.infer<typeof doseSchema>;
/** Parse a stored column: null or invalid → null (never throws; callers fall back to the old format). */
export function parseStoredWorkoutDoc(raw: unknown): WorkoutDoc | null;
```
- [ ] **Step 1: Failing tests**: a full valid document parses; each constraint rejects (no parts, empty part, run segment with neither duration nor distance, unknown purpose, title too long, version 2); `parseStoredWorkoutDoc(null)`, `("not json")`, `({})` → null; a valid JSON string → the doc.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(domain): the workout document v1 — intent, purposeful parts, library items`.

### Task 7: The `@rg/workout` package — derivations

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- `DocDerived` adds `category: "easy" | "long" | "quality" | "recovery" | "race" | "strength" | "yoga"` (a run part with threshold / interval / tempo / hills is quality; race is race; long, or easy for 75 min or more, is long; easy / recovery by effort; else strength when lift dominates; else yoga), `mode: Mode`, `equipment: { all: string[]; oneOf: string[][] }`, `disciplines: Array<"run" | "lift" | "yoga">` (every axis present, dominant first; `discipline` stays the dominant one).
- Export `modeOfEffort(e)` (recover to recovery, maintain to consistent, develop or peak to build) and `effortOfMode(m)`.
- Balance: `passive` items count toward no contraction (their seconds count as mobility only when their purpose is mobility or stretch, else recovery time).
- Add `derivePerformed(input, library)`: the same balance / exposure / minutes / discipline rules applied to what was actually done. `input = { entries: Array<{ exerciseId; perSide; sets: Array<{ reps: number|null; seconds: number|null; loadKg: number|null; done: boolean; flags: readonly string[] }> }>; movesDone: Array<{ exerciseId; seconds }>; activity?: { sport; durationSeconds; distanceMeters: number|null } | null }`. Test: a session done exactly as prescribed derives the same balance as `deriveDoc` of its document.

**Files:**
- Create: `packages/workout/package.json` (name `@rg/workout`, deps `@rg/domain`, `@rg/exercise-library`, `zod`; scripts `test`, `typecheck` like the sibling packages), `tsconfig.json`, `vitest.config.ts` (copy a sibling package's), `src/index.ts`, `src/derive.ts`
- Modify: root workspace config if packages are listed explicitly (check `pnpm-workspace.yaml`); `apps/worker/package.json` and `packages/ui/package.json` add `@rg/workout`
- Test: `packages/workout/test/derive.test.ts`

**Interfaces — Produces:**
```ts
export interface BalanceProfile { isometricSec: number; isotonicReps: number; eccentricReps: number; plyoContacts: number; aerobicSec: number; mobilitySec: number }
export interface DocDerived {
  estimatedMinutes: number;
  balance: BalanceProfile;
  regionExposure: Record<string, number>;    // region id → weighted exposure (sets or minutes)
  muscleExposure: Record<string, number>;    // muscle id → weighted exposure (primary 1, secondary 0.5)
  discipline: "run" | "lift" | "yoga";       // the garden's three axes, by dominant content
  conditionMax: Record<string, Record<string, number>>;   // profile id → attribute → max rating among items
  watchStepCount: number;
}
export function deriveDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): DocDerived;
```
Rules (document them in `derive.ts`): minutes = Σ items (sets × (reps × secsPerRep or hold) + rests) + run durations (distance → time at an easy pace of 6:00/km when no duration) + round rests; balance counts per contraction from the library record (an item counts toward every contraction its record lists; reps for isotonic/eccentric, seconds for isometric, contacts = reps × sets for plyometric; run seconds → aerobic; mobility-purpose items' seconds → mobility); discipline = run when run seconds ≥ 50 % of minutes, else lift when strength/power/activation items dominate, else yoga; watch steps = Σ sets × (perSide ? 2 : 1) for exercise items + run segments.

- [ ] **Step 1: Failing tests** with a fixture document per discipline (an easy run + strides + mobility; an activation → hinge → hip-opening lift; a recovery flow) and expected numbers computed by hand in the test.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(workout): derive a document's minutes, balance profile, exposures, discipline and condition maxima`.

### Task 8: Validation

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- The day is explicit: `validateWorkoutDoc(doc, ctx: { library; activeProfiles; day: DayContext | null /* null only for templates and library contexts */; excluded?: readonly string[]; equipment?: readonly string[] })` with `DayContext = { date: string; today: string; readings: Record<profileId, CheckReading | null>; recent?: { last: HistorySession | null; week: readonly HistorySession[] } }`.
- Full condition-rule parity (principles §2.7: a profile's rules apply to every workout from every source). New codes: `condition_pattern` (error: `allowPattern` false), `condition_gate` (error: `allowRecord` false for today, or the reading is null: unanswered means not allowed), `condition_gate_pending` (warning: a future date and the item is gated; allowed only if it carries an alternate that passes in recovery mode, else error), `condition_mode` (warning: `fitsMode` false for `modeOfEffort(doc.intent.effort)`), `condition_format` (warning: `fitsFormat` false; doc formats map straight to straight, superset to superset, circuit to circuit, ladder to ladder, flow to flow, holds to holds, intervals to circuit, steady to straight), `condition_flare` (warning: `flare(reading)` and the item is not `flareSafe`), `mode_above_day` (warning: the doc's mode exceeds what the profile allows today; message = the profile's own `recoveryReason` / `buildChecks` words), `excluded_by_athlete` (warning), `equipment_unavailable` (warning). The validator never names a profile.
- Circuit size outside 3-6 is a warning, not an error (engine builds must validate clean).
- Tests: a push-v item in a consistent doc at reading 1 gives `condition_pattern`; a plyometric item with a null reading gives `condition_gate`; the same on a future date with no alternate is an error, with a flare-safe alternate a `condition_gate_pending` warning; a circuit holding a clench-2 move gives `condition_format`; a high reading with a develop doc gives `mode_above_day` carrying the profile's sentence. Mutation-check each.

**Files:** Create `packages/workout/src/validate.ts`; Test `packages/workout/test/validate.test.ts`

**Interfaces — Produces:**
```ts
export interface DocIssue { path: string; code: "unknown_exercise" | "condition_never" | "format_mismatch" | "dose_mismatch" | "unknown_focus" | "bounds"; message: string; fix?: string; severity: "error" | "warning" }
export function validateWorkoutDoc(doc: WorkoutDoc, ctx: { library: readonly ExerciseRecord[]; activeProfiles: readonly ConditionProfile[]; mode?: Mode; preCheck?: number | null }): DocIssue[];
```
Rules: every `exercise.libraryId` resolves (legacy ids accepted — report a `warning` with the canonical id as `fix`); **a move a profile marks `never` → `error` `condition_never`**; the TMJ plyometric rule (Task 5) evaluated when `mode`/`preCheck` are given → `error`; a superset needs exactly 2 exercise items; a circuit 3–6; intervals need run or timed items; a `reps` dose on a time-dosed record → `dose_mismatch` warning with a fix; focus ids must be a region or muscle id.

- [ ] **Step 1–4:** failing tests per rule (incl. the plyometric gate) → implement → pass.
- [ ] **Step 5: Commit** `feat(workout): validate a document against the library and the condition profiles`.

### Task 9: Converters in, adapters out

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- A COROS `recovery` stage becomes a `run` item with effort `recovery` keeping its distance / duration (a jog is not a rest); pace / HR targets and zones carry into `target`; nested repeats go to `kept`.
- Coach `note` becomes `cue`; an engine build's swap alternatives become `alternates` (max 3); the build's mode maps through `effortOfMode`.
- Add `adapt/to-watch.ts`: `watchStepsFromDoc(doc, library, prefs)` via `playerStepsFromDoc` and the existing build-to-watch step function (search the worker and packages for the function that turns a build into watch steps); parity test over 50 seeded builds: the doc yields the same watch steps as today's builder (spec §3.3).
- Test: `deriveDoc(docFromCoachSession(s)).category === s.category` for every coach fixture.

**Files:** Create `packages/workout/src/convert/{from-stages,from-coach,from-studio,from-build}.ts`, `packages/workout/src/adapt/{to-stages,to-player}.ts`; Test `packages/workout/test/convert.test.ts`, `adapt.test.ts`

**Interfaces — Produces:**
```ts
export function docFromStages(stages: PlannedStage[], meta: { title: string; sport: string; corosKeyToLibraryId: (key: string) => string | null }): { doc: WorkoutDoc; kept: unknown[] };
export function docFromCoachSession(session: CoachSession, meta: { resolveName: (name: string) => string | null }): { doc: WorkoutDoc; kept: unknown[] };
export function docFromStudioSession(session: StudioSession, meta: { originIdToLibraryId: (id: string) => string | null }): { doc: WorkoutDoc; kept: unknown[] };
export function docFromBuild(build: BuildPayload): WorkoutDoc;
export function stagesFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): PlannedStage[];
export function playerStepsFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): Step[];   // the session engine's Step type
```
Mapping rules: stages — warmup → part `warmup`, work → `main` (runs: `run` part with `run` items; strength stages: exercise items), recovery → `rest` items inside intervals, cooldown → `cooldown`, repeat → a part with `rounds`; coach — run blocks → run items with efforts as given; lift → `main`; mobility → `main` with format `flow`; engine build blocks — arrive → `arrive`, prep → `warmup` (activation-role items → `activation` part), core → `main`, accessory → `accessory`, care → `care`, cooldown → `cooldown`, the build's reasons → `why`. Weights: coach `"25 lb"` → `{ typed: "25 lb", kg: 11.34 }`, `"bodyweight"` → `"bodyweight"`; stage `loadKg` → `{ typed: "<kg> kg", kg }`; `loadBodyweight` → `"bodyweight"`. Unknown names → `free_exercise`; anything inexpressible → `kept`.

- [ ] **Step 1: Failing tests**: one test per source shape (use the existing fixtures: `grep -rln "plannedStageSchema\|coachSessionSchema" packages/*/test apps/worker/test` for sample objects; build payloads via `buildToday` in `apps/worker/test/watch-push-fixture.ts` or the session-engine fixtures); Review Focus 1 (a legacy id canonicalised; an unknown name kept as `free_exercise`), Review Focus 3 (lb/kg/bodyweight); round-trip: `stagesFromDoc(docFromStages(s))` equals `s` on the fields stages carry; `playerStepsFromDoc(docFromBuild(b))` equals the build's own steps (order, exercise ids, doses) for 50 seeded builds.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(workout): convert every workout format into the document, and adapt it back to stages and player steps`.

**Batch 1B end:** gates; audit (principles §3 conformance; lossless-ness; Review Focus 1 and 3); fixes; re-review; deploy (pure code).

---

## Batch 1C — storage, dual-write, profile and objectives, APIs (schema change: owner-approved)

### Task 10: Migration and Drizzle schema

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
Add to migration 0028 (same file):
```sql
ALTER TABLE `planned_workouts` ADD `workout_doc_rev` integer;   -- bumped on every workout_doc write; NULL = no doc
--> statement-breakpoint
CREATE TABLE `workout_doc_revisions` (
	`id` text PRIMARY KEY NOT NULL,     -- `<workout_id>:<rev>`
	`user_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`rev` integer NOT NULL,
	`doc` text NOT NULL,
	`source_kind` text NOT NULL,        -- DOC_SOURCES or 'athlete_edit'
	`source_ref` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workout_doc_revisions_workout_idx` ON `workout_doc_revisions` (`workout_id`, `rev`);
--> statement-breakpoint
CREATE TABLE `athlete_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,      -- 'soreness' | 'tightness' | 'pain' | 'energy' | 'sleep_feel' | 'stress' | 'exercise_feedback' | 'workout_feedback' | ... (Stage 4 owns the registry)
	`subject_kind` text,              -- 'region' | 'muscle' | 'focus_area' | 'exercise' | 'workout' | 'performed_session' | 'condition'
	`subject_id` text,
	`value_num` real,
	`value_choice` text,
	`text` text,                      -- the athlete's own words: data, never instructions
	`source` text NOT NULL,           -- 'checkin' | 'ask_athlete' | 'request' | 'session_pre' | 'session_post' | 'review' | 'watch_review'
	`local_date` text NOT NULL,
	`at` text NOT NULL,
	`workout_id` text,
	`performed_session_id` text,
	`proposal_id` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `athlete_answers_user_q_idx` ON `athlete_answers` (`user_id`, `question_id`, `local_date`);
--> statement-breakpoint
CREATE INDEX `athlete_answers_subject_idx` ON `athlete_answers` (`user_id`, `subject_kind`, `subject_id`);
```
One answer row per area ("sore: calves 6, hamstrings 3" is two rows sharing `at`). `athlete_profiles` adds `events text NOT NULL DEFAULT '[]'` (JSON `[{ id, label, kind: race|trip|ski|travel|other, start, end?, priority: A|B|C, taper: boolean }]`); `focus_areas` JSON is `[{ id: slug, label, refs: string[] /* at least 1 region or muscle id */, note? }]`; `preferences` holds only what no other table owns (`{ sessionMinutes?: { default; max? }, trainingDays?: number[], defaultPlaceId? }`). `objectives` adds `goal_ids text NOT NULL DEFAULT '[]'` and `sort integer NOT NULL DEFAULT 0`. Register `athlete_answers` and `workout_doc_revisions` in the account registry too.

**Amendment B (one schema deploy, 2026-10-10) — binding:** migration 0028 also carries the storage Stages 2 and 3 need, so the schema deploys once under the owner's Stage 1 approval (nothing reads these until those stages):
```sql
CREATE TABLE `workout_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,              -- a WorkoutDoc (source.kind 'template')
	`pinned` integer NOT NULL DEFAULT 0,
	`uses` integer NOT NULL DEFAULT 0,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workout_templates_user_idx` ON `workout_templates` (`user_id`, `pinned`);
--> statement-breakpoint
CREATE TABLE `coach_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,                 -- a sub-agent's main run
	`role` text NOT NULL,             -- 'main' | 'designer' | 'reviewer'
	`scope` text NOT NULL,            -- JSON: { kind: 'now' | 'later_today' | 'week' | 'next_n', n?, from?, to? }
	`request` text,                   -- the athlete's words: data, never instructions
	`status` text NOT NULL,           -- 'queued' | 'running' | 'waiting_athlete' | 'done' | 'failed' | 'cancelled' | 'expired'
	`state` text,                     -- JSON: the resumable agent state (kept compact)
	`steps` integer NOT NULL DEFAULT 0,
	`cost_usd` real NOT NULL DEFAULT 0,
	`proposal_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `coach_runs_user_status_idx` ON `coach_runs` (`user_id`, `status`);
--> statement-breakpoint
CREATE INDEX `coach_runs_parent_idx` ON `coach_runs` (`parent_id`);
--> statement-breakpoint
CREATE TABLE `coach_run_events` (
	`id` text PRIMARY KEY NOT NULL,   -- `<run_id>:<seq>`
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,             -- 'tool_call' | 'tool_result' | 'draft' | 'review' | 'revision' | 'question' | 'note' | 'error'
	`summary` text NOT NULL,          -- one plain line for the transparency view
	`payload` text,                   -- JSON detail (bounded)
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coach_run_events_run_idx` ON `coach_run_events` (`run_id`, `seq`);
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `pinned` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `confidence` text NOT NULL DEFAULT 'stated';   -- 'stated' | 'inferred' | 'confirmed'
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `superseded_by` text;
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `evidence` text;                                -- JSON: what supports an observation
--> statement-breakpoint
ALTER TABLE `coach_memory` ADD `updated_at` text;
```
Register `workout_templates`, `coach_runs` and `coach_run_events` in the account registry (check how `coach_memory` is registered and follow it). Drizzle schema: templates beside the profile tables; the coach additions in `packages/database/src/schema/coach.ts`. Tests: the migration applies; export / restore / delete-all cover the new tables; existing coach-memory reads and writes are unchanged (defaults fill the new columns).

**Files:**
- Create: `packages/database/migrations/0028_workout_documents_profile_objectives.sql`; update `packages/database/migrations/meta/_journal.json` only if the existing migrations are journaled (the programme noted 0017+ are hand-authored and unjournaled — follow what 0024–0027 did)
- Modify: `packages/database/src/schema/schedule.ts` (`plannedWorkouts.workoutDoc: text("workout_doc", { mode: "json" })`), `performed.ts` (`sessionBuilds.workoutDoc`), new `packages/database/src/schema/profile.ts` (`athleteProfiles`, `objectives`, `keyResults`), `packages/database/src/schema/index.ts`
- Modify: `apps/worker/src/services/account-tables.ts` (register the three tables; scope by `user_id`; key results reach the user through their objective — follow how child tables like `performed_sets` are registered)
- Test: `packages/database/test/` (schema/migration test — follow the existing one), `apps/worker/test/account-*.test.ts` (export/restore/delete-all include the new tables — the existing registry test should fail until registered)

SQL (exact):
```sql
-- 0028: the workout document on planned workouts and builds; the athlete's profile and objectives (Stage 1, 2026-10-10).
ALTER TABLE `planned_workouts` ADD `workout_doc` text;
--> statement-breakpoint
ALTER TABLE `session_builds` ADD `workout_doc` text;
--> statement-breakpoint
CREATE TABLE `athlete_profiles` (
	`id` text PRIMARY KEY NOT NULL,          -- = user_id (one row per user)
	`user_id` text NOT NULL,
	`goals` text NOT NULL DEFAULT '[]',      -- JSON: [{ id: GoalId, words: string }]
	`focus_areas` text NOT NULL DEFAULT '[]',-- JSON: [{ id: region|muscle id, label: string, note?: string }]
	`preferences` text NOT NULL DEFAULT '{}',-- JSON
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_profiles_user_unique` ON `athlete_profiles` (`user_id`);
--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`why` text,
	`status` text NOT NULL DEFAULT 'active',  -- active | paused | done | dropped
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `objectives_user_idx` ON `objectives` (`user_id`, `status`);
--> statement-breakpoint
CREATE TABLE `key_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`objective_id` text NOT NULL,
	`label` text NOT NULL,
	`measure` text NOT NULL,                  -- JSON: a KeyResultMeasure (Task 13)
	`direction` text NOT NULL,                -- up | down
	`baseline` real,
	`target` real,
	`unit` text NOT NULL,
	`due_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `key_results_objective_idx` ON `key_results` (`objective_id`);
```
- [ ] **Step 1–4:** the account-registry test fails for the new tables → add schema + migration + registry → the migration applies in `makeTestDb` (it builds from the migrations dir — confirm) → tests pass; `makeTestDb` round-trip of export → restore includes the new tables.
- [ ] **Step 5: Commit** `feat(db): the workout document column, the athlete's profile, objectives and key results (additive)`.

### Task 11: Dual-write from every source

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- Every writer of `planned_workouts.workout_doc` also bumps `workout_doc_rev` and inserts a `workout_doc_revisions` row in the same batch; a row whose completion state is completed / skipped / missed never gets a new revision (one helper, tested). `session_builds.workout_doc` is a snapshot (no revisions).
- Counting tests: +1 statement per writer at most, still within 45.

**Files:** Modify the writers: session builds (`apps/worker/src/services/session-build.ts` — the build insert), coach creates/edits (`coach-apply.ts` — where `structured_json` is written), the COROS import (`import-plan.ts` — where stages are written), the standalone import (`standalone-import*.ts` — where performed/planned rows are written; grep), the old Studio push (`studio-push.ts` — planned rows). Create `apps/worker/src/services/workout-doc-store.ts` (one helper per source that converts and returns the JSON to write).

**Interfaces — Produces:**
```ts
export function docForBuild(build: BuildPayload): WorkoutDoc;                       // Task 9 converter
export function docForCoachSession(session: CoachSession, catalog: ResolveCtx): WorkoutDoc;
export function docForStages(stages: PlannedStage[], meta: StagesMeta): WorkoutDoc;
export function docForStudioSession(session: StudioSession, ctx: StudioCtx): WorkoutDoc;
```
Each writer sets `workout_doc` in the SAME statement/batch that writes its existing columns (no extra statements where possible; budgets unchanged ± 0 — assert the existing counting tests still pass). A conversion that throws must not fail the write: log `workout doc conversion failed: <code>` (no titles), write null, and let the backfill/parity pick it up.

- [ ] **Step 1: Failing tests**: after each writer runs (use the existing tests' setups), the row's `workout_doc` parses with `parseStoredWorkoutDoc` and `deriveDoc` gives the same minutes/discipline as the row's existing columns; a converter that throws → the write still succeeds with `workout_doc` null (inject a throwing converter).
- [ ] **Step 2–4:** FAIL → implement → PASS; the existing budget tests unchanged.
- [ ] **Step 5: Commit** `feat(workout): every source writes the workout document beside its existing format`.

### Task 12: The parity diagnostic

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- Also ship the read routes: `GET /api/workouts/:id/doc` returns `{ doc, derived, rev }`, tolerant (`{ doc: null, reason: "missing" | "invalid" }`, never a 500); `GET /api/workouts?from=&to=&q=&limit=` returns `[{ id, date, title, intentSummary, category, completionState, docRev, minutes }]` (the list "like last week's" needs; `q` matches title / intent; user-scoped; within 45 statements).
- The parity diagnostic exempts rest-day rows.

**Files:** Create `apps/worker/src/services/workout-doc-parity.ts`; route `GET /api/settings/diagnostics/workout-docs` in `apps/worker/src/routes/misc.ts` (the diagnostics family, user-scoped, read-only); Test `apps/worker/test/workout-doc-parity.test.ts`

**Produces:** `{ checked, withDoc, missing: number, invalid: number, mismatched: Array<{ id: string; field: "minutes" | "discipline" | "title" | "steps" }>, sample: string[] }` — counts and ids only, no titles; paginated (`?after=<id>&limit=100`); ≤ 45 statements.

- [ ] **Step 1–4:** tests: a row with no doc counts `missing`; an invalid JSON doc counts `invalid` (Review Focus 5 — never throws); a doc whose derived minutes differ from the row's → `mismatched` with the field; pagination; budget → implement → pass.
- [ ] **Step 5: Commit** `feat(workout): a read-only parity diagnostic between the document and the old formats`.

### Task 13: Profile and objectives — services, measures, routes

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- Profile: `GET /api/profile` returns `{ goals, focusAreas, events, preferences, units: { distance, weight, temperature } (read-only, from user_preferences), places: [{ id, name, equipment, implements, isDefault }], conditions: [{ profileId, active, since }] }`; `PUT /api/profile` accepts goals / focusAreas / events / preferences only (a test fails if it accepts units).
- Measures: `hold_max` / `best_set` count a set as capacity evidence only when its item was a test (`dose.max`, via the build's or planned row's document) or the logged value exceeds the prescription; otherwise `evidence: "capped"`. Add `threshold_pace { windowDays }` (from the daily health table's threshold pace, per day) and `predicted_time { distanceM }` (the race hub's prediction, per day: find `racePrediction`); `run_best` labels each point `race | test | training` from the matched planned document's run effort. A key result's `target` is stored in the athlete's unit with `unit`; measures return canonical and display values.

**Files:** Create `apps/worker/src/services/profile.ts`, `objectives.ts`, `key-result-measures.ts`; routes `apps/worker/src/routes/profile.ts` (mount `/api/profile`, `/api/objectives` in `apps/worker/src/index.ts` like the other routes); `packages/api-client/src/index.ts` (typed calls); `packages/domain/src/profile.ts` (zod schemas for profile, objective, key result, measure)
Test: `apps/worker/test/profile.test.ts`, `objectives.test.ts`, `key-result-measures.test.ts`

**Interfaces — Produces:**
```ts
export const keyResultMeasureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hold_max"), libraryIds: z.array(z.string()).min(1), windowDays: z.number().int().min(7).max(365).default(90) }),
  z.object({ kind: z.literal("best_set"), libraryIds: z.array(z.string()).min(1), metric: z.enum(["e1rm", "load_at_reps", "reps_at_load"]), reps: z.number().int().optional(), loadKg: z.number().optional(), windowDays: z.number().int().default(90) }),
  z.object({ kind: z.literal("run_best"), distanceM: z.number().min(1000), windowDays: z.number().int().default(180) }),
  z.object({ kind: z.literal("pace_at_hr"), hrLow: z.number().int(), hrHigh: z.number().int(), minDurationSec: z.number().int().default(1200), windowDays: z.number().int().default(90) }),
  z.object({ kind: z.literal("checkin"), questionId: z.string() }),
  z.object({ kind: z.literal("test"), testId: z.string() }),
]);
export interface KeyResultProgress { current: number | null; series: Array<{ date: string; value: number }>; lastMeasuredAt: string | null; sampleSize: number; evidence: "measured" | "sparse" | "none" }
export function measureKeyResult(db: Db, userId: string, measure: KeyResultMeasure, ctx: { today: string }): Promise<KeyResultProgress>;
// Routes: GET/PUT /api/profile; GET/POST /api/objectives; PUT /api/objectives/:id; GET /api/objectives/:id/progress
```
Measure rules: `hold_max` — max `performed_sets` hold seconds for those exercises in the window (app sessions + `watch` sessions); `best_set` — Epley e1RM = kg × (1 + reps/30) per set, max; `run_best` — fastest COROS activity whose distance ≥ distanceM, time scaled to exactly distanceM (`time × distanceM / distance` only when within 10 % over; else skip); `pace_at_hr` — runs ≥ minDuration with average HR in [hrLow, hrHigh], series of pace (s/km) per run; `checkin`/`test` return evidence "none" until Stage 4 adds them. Every measure reads only the needed columns, is user-scoped, chunked, ≤ 45 statements.

- [ ] **Step 1: Failing tests** per measure with seeded synthetic data (a wall-sit-like hold series; squat sets in lb and kg; synthetic COROS runs) and per route (validation 422s, 404 for another user's objective, budgets).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(profile): the athlete's profile, objectives and key results measured from logged data`.

### Task 14: The backfill

**Amendment A (scenario red-team, 2026-10-10) — binding; where it differs from the text below, it wins:**
- The backfill writes `workout_doc_rev = 1` and a revision row (`source_kind` from the row's origin) with each document; size the rows per call to stay within 45 statements.

**Files:** Create `apps/worker/src/services/workout-doc-backfill.ts`; admin route `POST /api/admin/workout-docs/backfill?dryRun=1&limit=` (follow `routes/admin.ts`'s auth); a cron hook in `hourly()` only if needed (prefer the admin route driven by the lead, one bounded step per call); Test `apps/worker/test/workout-doc-backfill.test.ts`

**Produces:** `{ dryRun, scanned, converted, failed: Array<{ id, code }>, nextAfter: string | null }`; converts planned workouts and session builds whose `workout_doc` IS NULL, ≤ 45 statements per call (≈ 15 rows per call), keyset by id, writes only `workout_doc` (no other column), idempotent.

- [ ] **Step 1: Failing tests** (Review Focus 4): dry run writes nothing and reports; a real run converts N rows; killed after k writes (throw from the db after k) → the next call resumes and the end state equals one uninterrupted run; a second full run converts 0; no other column changes (snapshot every column before/after); budget per call.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(workout): a resumable, bounded backfill of workout documents`.

### Task 15: Keep per-session feedback (no UI)

**Amendment A (scenario red-team):** today the session review's +1/-1 ratings overwrite `exercise_prefs.rating` (latest only), so per-session history is lost on every save. Run this task right after Task 11.

**Files:** Modify `apps/worker/src/services/session-save.ts` (where `review.ratings` fold into exercise prefs) and `apps/worker/src/services/session-watch-review.ts`; the review's wire schema in `packages/domain` (find `review` / `ratings`); Test: the existing session-save and watch-review tests.

- In the same batch, write each rating as an `athlete_answers` row (`question_id 'exercise_feedback'`, `subject_kind 'exercise'`, `subject_id` = library id, `value_num` +1/-1, `source 'review'` or `'watch_review'`, `performed_session_id`, `local_date`, `at`): one multi-row insert (chunked to 100 bound parameters); the prefs fold stays.
- Accept an optional workout-level slot `review.session?: { rating?: 1|2|3|4|5; difficulty?: "too_easy" | "right" | "too_hard"; text?: string (max 500) }` as one `workout_feedback` row (`subject_kind 'performed_session'`); the wire stays backward compatible; Stage 4 adds the UI.

- [ ] **Step 1: Failing tests**: a save with two ratings writes two answer rows linked to the session; a re-save (the idempotent save path) does not duplicate them; the watch review does the same; the workout-level slot writes one row; budgets still within 45 (update the counting tests by at most +1).
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(sessions): keep every session's exercise ratings, and an optional workout rating, as answers`.

**Batch 1C end:** gates; audit (schema, account registry, privacy, budgets, Review Focus 4–5); fixes; re-review; **deploy with the migration** (owner-approved: additive; `npx wrangler d1 migrations apply run-garden-db --remote` is run by the Deploy workflow — confirm in `.github/workflows/deploy.yml`); verify prod health; then:
1. **Seed** (owner-approved): from the private companion, build the profile JSON and the first objectives the companion names, each key result choosing the measure that fits (`hold_max`, `best_set`, `pace_at_hr` with the athlete's easy HR band read from their zones, `run_best`) and write them through the API from the signed-in browser if available, else with a single `wrangler d1 execute --remote` of parameter-free INSERTs generated in memory (never written to disk); verify with `GET /api/objectives`.
2. **Backfill** (owner-approved): dry run → read the report → real run in bounded calls until `nextAfter` is null → the parity diagnostic shows `missing: 0` and the mismatches explained (or fixed) — record the numbers in the ledger.
