# Phase 1 — the unified model, the exercise library and the session engine

Date: 2026-09-30
Status: design for Phase 1 of `2026-09-30-one-workout-system-design.md` (the programme spec, which is the authority).
Scope: additive only. Nothing existing changes behaviour; nothing new is visible in the UI.

## 1. What Phase 1 delivers

1. `@rg/exercise-library` — the ported library data, vocabularies, formats, themes, targets, skeletons, location
   presets, the TMJ condition profile, and validation.
2. `@rg/session-engine` — a TypeScript port of the standalone engine and recorder, with every condition-specific
   rule behind the profile contract (§4), and every standalone test ported (§7).
3. Weight parsing and formatting in `@rg/domain`; the `weightUnit` and `equipmentWishlist` preferences.
4. Migrations `0024`+ for the programme spec §8 tables and columns; Drizzle schema; registration in the table
   registry, export/restore and delete-all.
5. COROS catalog enrichment: `coros_exercises.raw` keeps `muscle`, `part`, `equipment`, `exerciseType`,
   `targetType`.

## 2. Packages

```
packages/exercise-library/
  src/vocab.ts         patterns, regions, roles, positions, laterality, loads, doseTypes, equipment ids,
                       loadImplements, modes, labels, positionGroup
  src/formats.ts       FORMATS (straight, superset, circuit, ladder, flow, holds) — no condition caps
  src/themes.ts        THEMES; a theme may carry `profile: "<id>"` (shown only when that profile's care is on)
  src/targets.ts       CORE_FAMILIES, COVERAGE_TARGETS (base, without condition care targets), MODES
  src/skeletons.ts     SKELETON (block order, fill order, roles, patterns, formats, shares, min, max) with a
                       `care` block placeholder; `skeletonFor(mode, careBlocks)` (§4.4)
  src/equipment.ts     EQUIPMENT labels, LOCATION_PRESETS (generic; no implement weights)
  src/exercises/*.ts   the records (one file per standalone file), typed `ExerciseRecord`
  src/conditions/types.ts   the ConditionProfile contract (§4)
  src/conditions/tmj.ts     the TMJ profile
  src/conditions/index.ts   PROFILES registry: Record<ProfileId, ConditionProfile>
  src/validate.ts      validateLibrary(): string[] (§3.3)
  src/index.ts
packages/session-engine/
  src/types.ts         EngineInput, HistorySession, Plan, Step, Target, BuildResult, …
  src/rng.ts  lib.ts  hist.ts  coverage.ts  prog.ts  proposal.ts  blocks.ts  select.ts  builder.ts
  src/records.ts  planner.ts  recorder.ts
  src/index.ts
```

Neither package has runtime dependencies beyond `zod` (library) and `@rg/exercise-library` + `@rg/domain` (engine,
for dates and weights). Both are source-consumed like every `@rg/*` package (no build step).

**No globals.** The standalone code reads a global `Data` registry. The port passes an explicit `EngineData`:

```ts
interface EngineData {
  exercises: readonly ExerciseRecord[];
  formats: readonly Format[];
  themes: readonly Theme[];
  coreFamilies: readonly CoreFamily[];
  targets: CoverageTargets;         // base ∪ care targets of cared-for profiles (§4.4)
  modes: Record<Mode, ModeSpec>;
  skeleton: SkeletonSpec;           // composed per build (§4.4)
  profiles: { active: readonly ConditionProfile[]; care: readonly ConditionProfile[] };
}
```

`makeEngineData({ activeProfiles, careProfiles })` in the library builds it; the worker calls it once per build.
Library lookups (`Lib.get`, legacy ids) are indexed per `EngineData` instance, not cached on a global.

## 3. The library

### 3.1 Record

`ExerciseRecord` is the programme spec §5.1 shape. Mechanical conversion from the standalone records:

- `jaw: {clench, neckLoad, faceDown}` → `conditions: { tmj: {clench, neckLoad, faceDown} }`
- `text.jaw` → `text.conditions.tmj`
- `sources` removed (provenance is private, §6)
- registry defaults (`legacyIds`, `easier`, `harder`, `tags`, `equipment.all/oneOf` → `[]`) applied by a typed
  `defineExercises([...])` helper so every exported record is complete
- `providers.coros` is added in Phase 1 only for records the resolver maps with confidence `exact` against the
  English catalog names; curated mappings follow in Phase 3

### 3.2 Location presets

Generic presets (Home, Gym, Mat only) with equipment lists and **no implement weights**. A person's actual places
and bell weights come from the database (`locations`), seeded by the standalone import or by Settings.

### 3.3 Validation

`validateLibrary(data)` returns every problem as `"<id>: <message>"`; the test asserts `[]`. It ports the standalone
`Lib.validate` plus: every profile in `PROFILES` is rated on every record against that profile's attribute specs;
`text.conditions[profile]` is non-empty for every profile; no record contains `http`, `www.`, `instagram` or `@`
(provenance never enters the public package); coverage per preset × mode (standalone `data.test.js`) holds with the
TMJ profile both active and cared-for.

## 4. The condition-profile contract

### 4.1 Definition

```ts
type AttrValue = number | boolean;
interface AttributeSpec { kind: "scale"; min: number; max: number } | { kind: "flag" };

interface CheckReading { pre: number | null; post: number | null; feelingOff: boolean }

interface ConditionProfile {
  id: string;                              // "tmj"
  label: string;                           // "TMJ"
  attributes: Record<string, AttributeSpec>;
  check: { label: string; min: 0; max: 10 };             // "Jaw / head"
  setFlag: { id: string; label: string; pastTense: string } | null;  // clenched / "Clenched" / "You clenched"

  // Exercise rules (everywhere the profile is active)
  never(a: Attrs): boolean;                               // TMJ: clench ≥ 3
  fitsMode(a: Attrs, mode: Mode): boolean;               // per-mode caps
  fitsFormat(a: Attrs, formatId: FormatId): boolean;     // circuit/ladder/flow ≤ 1, others ≤ 2
  allowPattern(pattern: Pattern, mode: Mode, today: CheckReading): boolean; // push-v: build + answered pre ≤ 2
  coreCandidate(a: Attrs): boolean;                      // clench ≤ 2 (block family candidates)
  blockAssignable(ex: ExerciseRecord): boolean;          // push-v never assigned as a block's core lift
  flareSafe(a: Attrs): boolean;                          // clench ≤ 1 && neckLoad ≤ 1 && !faceDown

  // Proposal (mode) — reasons are the profile's own words
  recoveryReason(ctx: ProposalCtx): string | null;       // feeling off / pre ≥ 5 / rise ≥ 2 / ≥ 2 flags last session
  buildChecks(ctx: ProposalCtx): Array<[ok: boolean, reason: string]>;  // calm level, week flare, clean last session
  buildLabel(ctx: ProposalCtx): string;                  // "Jaw calm (2)"

  // Progression
  entryClean(e: HistoryEntry, s: HistorySession): boolean;          // no flag, no rise ≥ 2
  stepDownCause(e: HistoryEntry, s: HistorySession): "flag" | "symptom" | null;
  holdReason(today: CheckReading, last: HistorySession | null): string | null;  // pre ≥ 5; pre rose ≥ 2
  quietPhrase: string;                                   // "with a quiet jaw"

  // Selection, rotation, milestones
  flagPenaltyWeight: number;                             // 2 (× the exercise's flag rate)
  rotateReason(log: HistoryEntry[]): string | null;      // flagged in 2 of the last 3
  calmStreakLabel: string | null;                        // "calm-jaw" → "5 calm-jaw sessions in a row"

  // Care content — only when a program cares for this profile
  care: {
    block: { label: string; roles: Role[]; formats: FormatId[];
             share: Record<Mode, number>; min: Record<Mode, number>; max: Record<Mode, number> };
    coverageTargets: Partial<CoverageTargets>;           // TMJ: regions.jaw = 4
  } | null;
}
```

Attributes are read as `ex.conditions[profile.id]`. The engine never names a profile id; a test greps
`packages/session-engine/src` for `tmj`, `jaw`, `clench` and fails on any hit.

### 4.2 Where the standalone rules go

| Standalone site | Port |
|---|---|
| `Lib.flareSafe` | `profile.flareSafe` (all active profiles) |
| `Lib.fitsMode`: clench ≥ 3 | `profile.never` |
| `Lib.fitsMode`: clench/neck/faceDown caps | `profile.fitsMode` |
| `Lib.fitsMode`: difficulty cap | general (`MODES[mode].maxDifficulty`) |
| `Lib.fitsMode`: recovery excludes external load | general (`MODES.recovery.allowExternalLoad = false`) |
| `Lib.fitsMode`: push-v only in build | `profile.allowPattern` |
| `builder.calmEnough` (push-v needs pre ≤ 2) | `profile.allowPattern` — **now requires an answered pre** |
| `builder.accepts`: `f.maxClench` | `profile.fitsFormat` (formats lose `maxClench`) |
| `Blocks.familyCandidates`: clench ≤ 2 | `profile.coreCandidate` |
| `Blocks.pickVariant`: no push-v | `profile.blockAssignable` |
| `Blocks.rotateReason`: clenched 2 of 3 | `profile.rotateReason`; "no progress in 3 sessions" stays general |
| `Proposal.mode` recovery triggers | `profile.recoveryReason` (first non-null, in profile order) |
| `Proposal.mode` build checks 1–3 | `profile.buildChecks`, evaluated before the general checks (48 h since last build, weekly goal − 1), preserving the standalone order and first-failing reason |
| build success reason | `[...profiles.map(buildLabel), "N sessions in the last 7 days"].join(" · ") + "."` |
| `Prog.rose/clean/holdReason` | `profile.entryClean`, `profile.stepDownCause`, `profile.holdReason` |
| "Hit 8 with a quiet jaw — go up." | `` `Hit ${hi}${quiet ? " " + quiet : ""} — go up.` `` |
| `Select` clench penalty | Σ `profile.flagPenaltyWeight × flagRate` |
| `Records` calm streak | `profile.calmStreakLabel` over its checks |
| skeleton `jaw` block, blockRoles/Formats/Min/Max for `jaw` | `profile.care.block` as the `care` block (§4.4) |
| `targets.regions.jaw` | `profile.care.coverageTargets` |
| theme `jawReset` | `THEMES` entry with `profile: "tmj"` |

Every user-facing string that names the condition comes from the profile. The TMJ profile reproduces the standalone
strings **exactly**; ported tests assert them unchanged.

### 4.3 Checks and flags in history

The engine's history shape carries checks and flags generically:

```ts
interface HistorySession {
  id: string; date: LocalDate; startedAt: string | null;
  mode: Mode | null; theme: string | null; blockNumber: number | null;
  checks: Record<string, CheckReading>;            // by profile id
  done: Array<{ id: string; secs: number }>;
  entries: HistoryEntry[];
}
interface HistoryEntry {
  id: string; implement: string | null; perSide: boolean; format: FormatId | null;
  flags: string[];                                  // e.g. ["clenched"]
  sets: Array<{ w: Weight | null; reps: number | null; secs: number | null }>;
}
```

Standalone v1 sessions are normalised to this shape **at import** (`plan.phase === "flare"` → `mode: "recovery"`,
`bilateral` → `perSide`, `clenched` → `flags`, pre/post → `checks.tmj`), so the engine sees one shape.

### 4.4 Skeleton composition

`SKELETON` holds the standalone per-mode shares **with** the care block (the standalone numbers exactly, block id
`care` in place of `jaw`). `skeletonFor(mode, careBlocks)`:

- one cared-for profile: its `care.block` supplies roles, formats, min, max; the share is the table's `care` share
  (TMJ's shares equal the table's, so TMJ reproduces the standalone skeleton exactly);
- no cared-for profile: drop the `care` block and renormalise the remaining shares to sum to 1;
- more than one: not built (YAGNI); `makeEngineData` throws if asked, with a clear message.

## 5. Behaviour changes relative to the standalone engine

Each is a deliberate fix with its own test:

1. Vertical pushing requires an **answered** pre-check ≤ 2.
2. A second session on the same day does not repeat that day's theme (`Proposal.theme` avoids today's theme too).
3. The 48-hour build rule's reason reads "You built strength yesterday" only when the last build was yesterday; a
   same-day build reads "You built strength earlier today".
4. The recorder's review state (ratings, graduation acceptance) is returned as a **pending** change set applied on
   save, never mutated during review.
5. Library lookups are per-`EngineData` (no stale global cache).

Standalone behaviour that is kept on purpose, even where its own spec said otherwise: the repetition penalty
(−5 × appearances in the last 3 sessions), the "saved" and "prep" score terms, swaps as `{from, to}`, pins in prefs,
consistent mode stepping weight up only after two clean top-of-range sessions.

`saved` (the "from your saves" bonus) reads a per-user set of exercise ids passed in `EngineInput.savedIds`
(from `exercise_provenance`), not a field on the public record.

## 6. Data model (migrations 0024+)

Hand-authored; one migration per concern so each can be reviewed alone.

```sql
-- 0024_programs.sql
CREATE TABLE `programs` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `kind` text NOT NULL, `name` text NOT NULL,
  `status` text NOT NULL, `disciplines` text NOT NULL, `start_date` text, `end_date` text, `race_date` text,
  `source` text, `config` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `archived_at` text);
CREATE INDEX `programs_user_idx` ON `programs` (`user_id`, `status`);
CREATE TABLE `program_versions` (
  `id` text PRIMARY KEY NOT NULL, `program_id` text NOT NULL, `version_num` integer NOT NULL,
  `captured_at` text NOT NULL, `fingerprint` text NOT NULL, `summary` text);
CREATE INDEX `program_versions_program_idx` ON `program_versions` (`program_id`);
CREATE TABLE `program_blocks` (
  `id` text PRIMARY KEY NOT NULL, `program_id` text NOT NULL, `number` integer NOT NULL, `kind` text NOT NULL,
  `start_date` text NOT NULL, `weeks` integer NOT NULL, `intent` text NOT NULL,
  `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE UNIQUE INDEX `program_blocks_number_unique` ON `program_blocks` (`program_id`, `number`);

-- 0025_planned_session_columns.sql
ALTER TABLE `planned_workouts` ADD `origin` text;
ALTER TABLE `planned_workouts` ADD `content_state` text;
ALTER TABLE `planned_workouts` ADD `session_params` text;

-- 0026_performed_sessions.sql
CREATE TABLE `session_builds` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `workout_id` text NOT NULL, `version` integer NOT NULL,
  `engine_version` text NOT NULL, `inputs_hash` text NOT NULL, `payload` text NOT NULL, `locked_at` text,
  `created_at` text NOT NULL);
CREATE UNIQUE INDEX `session_builds_version_unique` ON `session_builds` (`workout_id`, `version`);
CREATE TABLE `performed_sessions` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `workout_id` text, `activity_id` text, `build_id` text,
  `source` text NOT NULL, `source_ref` text, `local_date` text NOT NULL, `started_at` text, `ended_at` text,
  `seconds` integer NOT NULL DEFAULT 0, `planned_seconds` integer, `mode` text, `theme` text, `location_id` text,
  `block_ref` text, `completed` integer NOT NULL DEFAULT 0, `steps_total` integer, `steps_done` integer,
  `note` text, `new_move` text, `payload_hash` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `performed_sessions_user_date_idx` ON `performed_sessions` (`user_id`, `local_date`);
CREATE UNIQUE INDEX `performed_sessions_source_unique` ON `performed_sessions` (`user_id`, `source`, `source_ref`);
CREATE TABLE `performed_sets` (
  `id` text PRIMARY KEY NOT NULL, `performed_session_id` text NOT NULL, `entry_index` integer NOT NULL,
  `exercise_id` text NOT NULL, `implement` text, `format` text, `per_side` integer NOT NULL DEFAULT 0,
  `set_index` integer NOT NULL, `side` text, `reps` integer, `seconds` integer, `load_value` real,
  `load_unit` text, `load_kg` real, `done` integer NOT NULL DEFAULT 1, `flags` text NOT NULL DEFAULT '[]');
CREATE INDEX `performed_sets_session_idx` ON `performed_sets` (`performed_session_id`);
CREATE INDEX `performed_sets_exercise_idx` ON `performed_sets` (`exercise_id`);
CREATE TABLE `condition_checks` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `profile_id` text NOT NULL, `kind` text NOT NULL,
  `value` integer, `feeling_off` integer NOT NULL DEFAULT 0, `local_date` text NOT NULL, `at` text NOT NULL,
  `performed_session_id` text, `workout_id` text);
CREATE INDEX `condition_checks_user_date_idx` ON `condition_checks` (`user_id`, `local_date`);

-- 0027_exercise_settings.sql
CREATE TABLE `user_conditions` (
  `user_id` text NOT NULL, `profile_id` text NOT NULL, `active` integer NOT NULL, `since` text NOT NULL,
  `settings` text NOT NULL DEFAULT '{}', PRIMARY KEY (`user_id`, `profile_id`));
CREATE TABLE `locations` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `name` text NOT NULL, `equipment` text NOT NULL,
  `implements` text NOT NULL DEFAULT '{}', `is_default` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `locations_user_idx` ON `locations` (`user_id`);
CREATE TABLE `exercise_prefs` (
  `user_id` text NOT NULL, `exercise_id` text NOT NULL, `rating` integer, `excluded` integer NOT NULL DEFAULT 0,
  `pinned` integer NOT NULL DEFAULT 0, `introduced_on` text, `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `exercise_id`));
CREATE TABLE `exercise_provenance` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `exercise_id` text NOT NULL, `source_type` text NOT NULL,
  `url` text, `creator` text, `source_key` text, `created_at` text NOT NULL);
CREATE UNIQUE INDEX `exercise_provenance_key_unique` ON `exercise_provenance` (`user_id`, `source_type`, `source_key`);
```

`performed_sets` is a child of `performed_sessions`; `program_versions` and `program_blocks` are children of
`programs`; every other new table is user-scoped. All join the table registry, export/restore and delete-all.

Domain (zod, `packages/domain/src/`):

- `program.ts`: `programKindSchema`, `adaptiveConfigSchema` (`weeklyGoal` 1–7 default 4, `preferredDays` 0–6[],
  `defaultMinutes` 10–90 default 30, `defaultLocationId`, `blockWeeks` 4–6 default 5, `modes`, `careProfiles`,
  `placementWeeksAhead` 1–4 default 2), `blockIntentSchema`.
- `performed.ts`: `performedSessionSaveSchema` (the outbox payload, Phase 2b), `performedSetSchema`,
  `conditionCheckSchema`.
- `weights.ts`: `Weight {v, u}`, `parseWeight(text, defaultUnit)`, `toKg`, `formatWeight`, `formatWeightIn`,
  `parseWeightList`, `sameWeight` (tolerance 0.05 kg); pounds use the exact definition 1 lb = 0.45359237 kg.
- `preferences.ts`: `weightUnit: z.enum(["lb","kg"]).default("lb")`, `equipmentWishlist: z.array(z.string()).default([])`.

## 7. Test port

Every standalone test file becomes a vitest file in the owning package; test names are kept so the port can be
diffed against the source list (219 tests):

| Standalone | Port |
|---|---|
| `data.test.js`, `engine-validate.test.js` | `exercise-library/test/validate.test.ts`, `coverage-presets.test.ts` |
| `engine-lib`, `engine-coverage`, `engine-prog`, `engine-proposal`, `engine-blocks`, `engine-select`, `engine-formats`, `engine-builder`, `engine-records`, `engine-planner` | `session-engine/test/<same>.test.ts` |
| `simulation.test.js` | `session-engine/test/simulation.test.ts` (3 seeds × 84 days × 6 properties) |
| `recorder.test.js` | `session-engine/test/recorder.test.ts` |
| `units.test.js` | `domain/test/weights.test.ts` |
| `stats.test.js`, `store.test.js` | Phase 2 (they test the standalone store and stats, which the import and Progress replace); their fixtures become the import's golden fixtures |

Fixtures are synthetic (the standalone `tests/fixtures.js` is synthetic already). Plus new tests: the engine with **no**
profile active (proposal falls back to the general rules; no care block; renormalised skeleton; no condition
strings in any reason), the `never` rule with a synthetic clench-3 record, the §5 behaviour changes, and the
engine-never-names-a-profile grep.

## 8. COROS catalog enrichment

`snapshot.ts` maps catalog items to `{id, name, muscle, part, equipment, exerciseType, targetType}` (arrays default
`[]`); the upsert writes them into `raw`. `exercise-catalog.ts` exposes `catalogMeta(id)`. No behaviour reads them
yet; the Phase 3 mapping will.

## 9. Out of scope for Phase 1

Any route, any UI, slot placement, builds, saves, imports (Phase 2); watch pushes (Phase 3); coach changes (Phase 4).
