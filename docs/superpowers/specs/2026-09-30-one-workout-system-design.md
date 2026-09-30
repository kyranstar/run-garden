# One workout system: programs, an exercise library, condition profiles and in-app sessions

Date: 2026-09-30
Status: approved direction (conversation 2026-09-30); this document is the programme spec. Phases 2–5 each get
their own detailed spec when reached.
Extends: `2026-08-11-coach-plan-rework-design.md`, `2026-09-20-coach-plan-management-design.md`,
`2026-08-03-plan-studio-design.md` (which this programme retires).

## 1. Why

Run Garden knows what the athlete did on the watch, plans running and lifting, reads recovery, and turns
consistency into a garden. It cannot run a workout itself, it never sees a weight lifted (COROS returns no reps or
loads for strength), its lift "progressions" are prescriptions rather than performance, and it has no idea what
exercises are good or bad for someone with a health condition.

A standalone exercise tool (plain HTML, `localStorage`) already does those things well for one adaptive programme
built around a condition profile: a tagged exercise library with how-to text, a deterministic session builder with
modes, blocks, formats and reasons, an in-browser player with set logging, progression from logged loads, and
symptom checks before and after each session.

This programme makes Run Garden the **one place for all workouts**: the standalone tool's engine and library move in,
generalized, and its programme becomes one instance of a general **program** concept that eventually also replaces
Run Garden's three plan kinds.

What "done" feels like:

- Today proposes a session and says why; the athlete can override anything and do it on the computer, the phone or
  the watch.
- Core lifts repeat in blocks so strength measurably builds; everything else rotates by what has been neglected.
- Every exercise anywhere in the app has a how-to and condition ratings.
- Logged weights drive progression, records and graphs — actuals, not prescriptions.
- A health-condition profile (the first one: TMJ) is respected by every program and by the coach.
- The garden, Activity, insights and the coach all see these sessions, counted exactly once.

## 2. Decisions

Made by the product owner on 2026-09-30. Do not re-open without them.

| # | Topic | Decision |
|---|---|---|
| D1 | Depth of the program abstraction | Full re-model: one programs model replaces `training_plans`, `studio_plans`, `coach_plans`, all data migrated — **last** (Phase 5). |
| D2 | Garden axes | Existing three axes. Strength → Lift. Mobility, jaw care and breathing → the third axis, relabelled **"Yoga & mobility"** (internal id stays `yoga`; no resim). No new decay clock. |
| D3 | Adaptive sessions | Flexible slots placed on preferred days; content built fresh on the day; on-demand sessions by parameters; the coach reshapes sessions by parameters and the engine rebuilds them. |
| D4 | Moves COROS doesn't know | Best effort to the watch: unmapped moves become generic steps carrying the real name and cue; the app previews exactly what the watch gets. Spike first; if COROS refuses, those sessions stay phone/computer-only. |
| D5 | Public repo | The exercise library (names, how-to, tags, condition ratings) is public. Personal provenance (saved-post links, creators) and all health data live only in the database, loaded by local imports. |
| D6 | Condition rules | A general **condition profile** concept; while a profile is active its rules apply across every program and the coach. TMJ is the first profile. |
| D7 | Production migration safety | Staging rehearsal with prod copied **inside Cloudflare, never to disk**; prod migrated behind a D1 Time Travel bookmark with a written rollback. |
| D8 | The standalone tool | Retired after ~2 weeks of parallel use with matching data; the new player works offline mid-session and syncs afterwards. |
| P1 | Phasing | Build the new model additively and deliver the adaptive program end to end first (Phases 1–4); migrate the existing plan kinds last (Phase 5). |
| P2 | 09-20 coach spec leftovers | Fix the coach `remove`/`restore`/`adjust` route-parity bugs and run its lap reps/weight probe in Phase 0; watch removals (its §7 Phase B) join Phase 5. |
| P3 | Landing | Small gated merges to `main` (every push deploys): full gates + independent review per slice; owner render approval for UI; the owner is asked before any schema-changing push. |
| P4 | Staging | Built in Phase 0, inert; prod data copied in only for a rehearsal and wiped afterwards (owner OK each time). Old tables drop 2 weeks after the prod cutover. |
| P5 | Studio | Folds into the coach plus program detail: authoring hidden early, existing plans migrate in Phase 5, code deleted in Phase 6. |
| P6 | Weights | A weight-unit preference separate from km/mi, default lb. Any field accepts `25`, `25 lb`, `12kg`; stored as typed plus kg; displayed as typed. |
| P7 | Offline | Mid-session including reload/relaunch; a session never opened needs a connection. |
| P8 | Imported history in the garden | Epoch-gated out; counts shown at import; flipping later is a deliberate resim. |
| P9 | Library growth from private saves | Curate strength, mobility, posture and general-fitness moves with the standalone tool's curation rules; flagged-for-review items stay out until reviewed. |
| P10 | CI | Add the refreshed e2e smoke suite to CI. No lint. |
| A1 | Where the engine runs | **Server builds, client plays.** A pure package; the Worker builds and stores a session's content; the payload carries swap alternatives so the player works offline. |
| A2 | Program storage | **Final-shape `programs` table now, ids kept.** Phase 5 copies the three old plan kinds in with their ids unchanged, so `planned_workouts.plan_id` never changes. |
| A3 | How app sessions reach everything else | **As activities plus a completion match.** A saved session becomes an activity with `source = 'app'`; COROS adoption becomes the deliberate merge. |

Earlier product rules that stand: modes **recovery / consistent / build**, proposed with reasons and overridable;
core lifts rotate in **5-week blocks** (4–6 configurable); a **mixed timer** (holds count down, sets are self-paced
with logging, rests are timed); condition checks **before and after** each session; saved-post moves get a small
selection bonus and a "from your saves" label (private provenance only).

## 3. Verified facts this design relies on

Checked against `main` at `f4c007d` on 2026-09-30. Several correct the handoff that preceded this spec.

**Plans and planned workouts**

- `planned_workouts.plan_id` is NOT NULL, has no foreign key, and points at **either** `training_plans.id`
  (`newId()`) **or** `coach_plans.id` (`cp-<proposal>-<i>`, `adhoc-<discipline>-<user8>`). It never points at
  `studio_plans`: Studio sessions come back through the COROS import under the container plan's `training_plans`
  row and are linked to Studio only by `planId:idInPlan`.
- Rows are **inserted** in two places only (`import-plan.ts`, `coach-apply.ts insertSession`) but **updated** in about
  forty (jobs, write executors, completion, reconcile, day placement, calendar sync, plan routes, repairs).
- `sourceProvider: "coros"` is a domain/DTO literal, not a column.
- `lastVerifiedCorosDate = ''` marks rows COROS never confirmed (app-authored, unpushed, or failed
  delete-and-create). Import rule 8 will not archive them.
- The unique index is `(user_id, plan_id, source_workout_id)`; coach rows use `source_workout_id = id`.

**Garden**

- Determinism keys on workout and activity ids (`species:`, `tree:`, `fungi:`, plant ids, positions). Resims delete
  and rebuild day inputs **from live tables**, so any row written for a past date changes past gardens on the next
  resim.
- `buildDayInput` reads completed planned rows (discipline from `category`/`sport`, start time via the active
  match), unmatched activities (only `run`/`strength`/`yoga` count as sessions; any other sport id may be an
  "adventure", and `isAdventureSport` is true for **unknown** ids), skipped/missed rows, rest and taper, health rows,
  and prefs.
- **Plan gap reads `training_plans` only.** **Coached-block credit reads `coach_plans`** (`end_date`, `status`, and the
  `adhoc-` id prefix for loose plans). A merged table must reproduce both exactly.
- `DEW_EPOCH` is the precedent for an input-side epoch gate. `SIMULATION_VERSION = 6`.

**Activities**

- No `source` column; provenance lives in `activity_source_links.provider` (`coros` only). Ids are random UUIDs.
- **The COROS ingest adopts any activity row without a COROS id** within ±1 h and a matching score ≥ 0.6, and
  `repairTimestamps` can delete such rows. App-recorded activities need a source column and a guard before they
  exist.
- `workout_completion_matches` is one-to-one only by convention; manual match does not check an existing active
  match, and matching treats every non-run sport as equal (a yoga activity can complete a strength workout).
- `activity_laps` has no reps or weight columns.

**COROS strength writes**

- `buildStrengthProgram` sends the **catalog** name and refuses any exercise without an `originId`; one unmapped move
  keeps the whole session off the watch (three layers: resolver, `watchPushable`, builder).
- Weight on the wire is kg only (`round(kg × 1000)`); per-side becomes two steps plus "each side" in the step
  overview; tempo goes in the overview; no RPE.
- Recorded captures show COROS storing `originId: "0"` steps with free-text names in run and bike programs, and the
  catalog contains generic steps (Training, Warm Up, Cool Down, Rest). Neither has been tried on a strength program.
- The COROS catalog query returns `muscle[]`, `part[]`, `equipment[]`; `snapshot.ts` keeps only `{id, name}`.
- The program fingerprint ignores step `name`, `originId` and `overview`, so drift detection would not notice COROS
  renaming a step.

**Coach**

- 15 op kinds + 5 selector ops; selectors expand at the seam in `coach-wake.ts` before guardrails; 14 guardrails
  (6 fatal, 8 advisory) plus a soft channel; a 20k-token dossier with protected sections.
- `remove`, `restore` and `adjust` skip side effects their manual routes perform: a coach removal writes no
  `user_removed` suppression (so import presence-healing can undo it), restore writes no override and does not
  resimulate, adjust leaves estimates and stages stale. `resultingCalendar` has no case for them.

**Ops**

- `wrangler.toml` has no `[env.*]`; crons always run for every user; `FIXTURE_MODE` only gates `/api/dev/*`; Google
  Calendar has no stub; `AI_DEFAULT_ENABLED` only gates the weekly review. There is no global kill switch.
- `deploy.yml` applies `d1 migrations apply --remote` before `wrangler deploy`, with no backup step. Every migration
  must be compatible with the code already live.
- The Drizzle migration journal ends at 0016; 0017–0021 are hand-authored and applied by directory. `db:generate` is
  unsafe; migrations stay hand-authored.
- `GET /api/settings/export` covers 11 of ~57 user tables and there is no restore. The delete-all coverage guard
  enumerates schema tables automatically.
- No IndexedDB anywhere. The service worker caches a few read endpoints but not `/api/auth/me`, so an offline launch
  lands on the "Couldn't reach Run Garden" screen.
- The garden's Today card shows exactly one workout (`nextWorkout` from `GET /api/plan/today`, which can be
  tomorrow's).
- Yoga calendar events are titled "Run · …" (the prefix map has no yoga entry). Mobility coach blocks do not render
  in plan cards.

**Standalone tool** (the port source)

- Recovery triggers at a pre-check **≥ 5** (not 6), a rise of ≥ 2 last session, ≥ 2 clenched lifts last session, or
  "feeling off". Build needs all of: level ≤ 2, no pre ≥ 5 and mean post ≤ 3 over 7 days, a clean last session, the
  last build ≥ 2 calendar days ago, sessions in 7 days ≥ goal − 1.
- Its code allows vertical pushing when the pre-check is **unanswered**; the port requires an answered pre-check ≤ 2
  (the stated rule, and the safer one).
- 120 exercise records, 219 node tests (18 of them the 12-week simulation), 41+ e2e checks.
- The v1 field `bilateral` and the v2 field `perSide` both mean "the logged number is per side; volume counts both
  sides".

## 4. Architecture

```
packages/exercise-library   (new, public)  records, vocabularies, themes, formats, targets,
                                           condition-profile definitions, COROS mappings, validation
packages/session-engine     (new, pure)    proposal, blocks, selection, builder, progression,
                                           records, planner, recorder — profile hooks, no I/O
packages/domain                            zod schemas for programs, builds, performed sessions, checks,
                                           locations; weightUnit pref; weight parsing/formatting
packages/database                          new tables + columns (hand-authored migrations)
apps/worker                                programs service (slot placement), session-build (build/lock),
                                           session-save (idempotent ingest), imports, parity/staging tools
packages/ui                                player route, review, library, settings sections, IndexedDB
                                           outbox, Today/Plan/Activity integration
```

Boundaries:

- **`exercise-library` has no dependencies** besides zod. It is data plus validators. The engine and the worker import
  it; the UI receives library slices through the API (never bundles the whole library into the first paint).
- **`session-engine` is pure**: every function takes plain data (library, history, prefs, block, check values, date,
  seed) and returns plain data. No clock reads (the date is an input), no randomness except seeded RNG. It runs in
  the Worker (build, alternatives, progression, records) and in the browser (the recorder only, plus
  alternative-rebase for offline swaps).
- **The Worker is authoritative** for builds, saves and everything derived from them. The browser owns only
  in-progress session state until it is saved.

## 5. Exercise library

### 5.1 Record shape

The standalone tool's schema, with three changes:

```ts
{
  id: "gobletSquat",           // permanent camelCase id; history, prefs and blocks key on it
  legacyIds: [],               // renames keep history
  name, family, patterns[], regions[], roles[],
  equipment: { all: [], oneOf: [] },
  position, laterality,        // bilateral | unilateral | alternating
  load,                        // external | bodyweight | none
  dose: { type, range, sets?, restSec?, secsPerRep?, startKg? },   // reps | time | breaths | carry
  difficulty,                  // 1–5
  easier[], harder[], tags[],
  text: { summary, setup[], steps[], focus[], mistakes[], breathing, why,
          conditions: { tmj: "…" } },            // was text.jaw
  conditions: { tmj: { clench: 0-3, neckLoad: 0-3, faceDown: bool } },   // was jaw
  providers: { coros?: { originId, confidence: "exact" | "close" | "generic", method: "curated" | "computed" } },
}
```

- `sources` is **removed** from the public record. Provenance lives in `exercise_provenance` (per user, private).
- Every condition profile the library knows is **required** on every record (the validator enforces it), so adding a
  profile means rating every exercise — a data change, reviewed, not an engine change.
- `providers.coros` is curated where a human checked it and computed (resolver) otherwise; `generic` marks a move
  that will go to the watch as a generic step (§11).

### 5.2 Vocabularies and data

Ported verbatim from the standalone tool: patterns, regions, roles, positions, laterality, loads, dose types,
equipment ids, formats (straight, superset, circuit, ladder, flow, holds), themes, core families, weekly coverage
targets, mode skeletons, block roles, block min/max. Condition-specific pieces (the jaw-care block, jaw/neck coverage
targets, jaw themes) move into the profile (§6).

### 5.3 Validation (tests)

Every record: required fields, vocabularies, sane dose ranges, non-empty text, all profiles rated, easier/harder links
resolve with no self-links. Coverage per location preset × mode: every core family has an eligible move and every
role a skeleton needs has ≥ 3 candidates. Every move eligible in recovery satisfies each attached profile's
flare-safe predicate. No record carries a URL or a creator handle (a test greps the package).

### 5.4 Growth

1. Port the 120 records (sources stripped; `jaw` → `conditions.tmj`; `text.jaw` → `text.conditions.tmj`).
2. Curate further moves from the owner's private saves catalogue (strength, mobility, posture, general fitness) with
   the standalone tool's rules: skip impact, max effort, heavy bracing, loaded overhead, hard jaw/neck pressure, gear
   outside the vocabulary, near-duplicates; flagged-for-review items wait for review. Text is rewritten in the
   library's own words. The public record carries no link to the save.
3. COROS mappings: resolver-computed for every record, curated for the core lifts.

### 5.5 Per-user exercise data (database)

`exercise_prefs` (rating ±1, excluded, pinned, introduced date) and `exercise_provenance` (source type, URL, creator,
source key — imported locally, never committed). Coach- and Studio-authored exercises resolve to library ids where a
name matches, so how-to text and condition ratings appear on every session.

## 6. Condition profiles

A profile is data plus rules, defined in code in `exercise-library/src/conditions/`:

```ts
interface ConditionProfile {
  id: "tmj";
  label: string;
  attributes: AttributeSpec[];                 // e.g. clench 0–3, neckLoad 0–3, faceDown boolean
  checks: CheckSpec[];                         // e.g. "Jaw / head" 0–10, before + after; optional daily
  setFlags: FlagSpec[];                        // e.g. "clenched" on a logged exercise
  never(ex): string | null;                    // never selected anywhere (TMJ: clench 3)
  modeLimits: Record<Mode, (ex) => boolean>;   // per-mode attribute caps
  modeRules: ModeRule[];                       // e.g. push-v only in build with an answered pre ≤ 2
  flareSafe(ex): boolean;                      // clench ≤ 1 && neckLoad ≤ 1 && !faceDown
  proposal: ProposalRule[];                    // recovery triggers and build gates, each with a reason
  progression: ProgressionGate[];              // symptom rise / high pre → hold; flag → step down
  care?: {                                     // only for programs that attach the profile
    block: { id, roles, share: Record<Mode, number>, min: Record<Mode, number>, max: Record<Mode, number> };
    coverageTargets; themes;
  };
}
```

- **Rules apply everywhere while the profile is active** (`user_conditions`): the engine for every program,
  on-demand sessions, coach-authored content (fatal guardrail for `never`; advisory for mode limits), and imported
  COROS content (flagged, advisory — COROS owns it).
- **Care content applies only to programs that attach the profile** (an adaptive program's config lists attached
  profiles). A general strength program with the profile active gets the rules, not the jaw-care block.
- **Checks** are stored in `condition_checks`. A flare (profile-defined) switches the day's adaptive session to
  recovery and, from Phase 4, lets the coach **propose** easing other hard sessions. Never automatic.
- **TMJ** is the only profile built now. A second profile (low back, knee) must be a data addition plus attribute
  ratings. No engine code may name `tmj`; a test asserts the engine package never references a profile id.

## 7. Session engine

### 7.1 Port

A TypeScript port of `rng`, `lib`, `hist`, `coverage`, `prog`, `proposal`, `blocks`, `select`, `builder`, `records`,
`planner` and the recorder. Behaviour is preserved except where this spec says otherwise:

- Every read of `ex.jaw.*`, the pre/post rules, the clench flag and the `jaw` block goes through the attached/active
  profiles.
- Vertical pushing requires an **answered** pre-check ≤ 2 (the standalone code allowed unanswered).
- Known standalone defects are fixed in the port rather than copied: unvalidated imports; "yesterday" after a
  same-day save; theme repeating within a day; review ratings persisting before Save; player key handling
  (Escape on the swap panel resumes the timer; Space/Enter never override a focused button; the new-move sheet pauses
  a running countdown).
- Pins live in prefs (as in the code, not the spec); swaps are `{slotKey: {from, to}}`.

All 219 standalone tests are ported, including the 12-week simulation and its property checks (time budget,
recovery ⇒ flare-safe, core-family frequency, weekly new move, repetition bounds, block rotation, determinism), plus
the recorder regressions: a timed hold counts only at ≥ half its time and is logged at the time held; editing a set
propagates to later untouched sets; a mid-session swap replaces only that slot's remaining sets (`rebase`); swapping
a swapped slot keeps the original `from`; withdrawn graduation offers are pruned at save; typing during a rest is
kept.

### 7.2 Determinism

A build is a pure function of `(library version, profiles, program config, block, history, prefs, check values,
overrides, swaps, date, minutes, location)`. The seed is derived from the date and the program id. A build stores
its engine version and an inputs hash; re-opening an unchanged slot returns the stored build instead of rebuilding.

### 7.3 Build payload

```ts
{
  engineVersion, inputsHash, builtAt,
  mode, modeReasons[], theme, themeReasons[], minutes, locationId, blockRef, weekOfBlock,
  steps: Step[],                      // the flat step list the player plays (timed | set | rest)
  exercises: { [id]: LibrarySlice },  // everything the player and how-to sheet need, offline
  alternatives: { [slotKey]: Alternative[] },   // top 2–3 per slot, each with its expanded steps
  targets: { [exerciseId]: ProgressionTarget },  // from logged history
  newMove: exerciseId | null,
}
```

## 8. Data model

All additive in Phase 1; nothing reads it until Phase 2. Hand-authored migrations, `IF NOT EXISTS` guards where
sensible, every new user table in export, restore and delete-all.

### 8.1 Programs (final shape)

```
programs            id PK, user_id, kind (adaptive | coros_import | coach | studio), name, status
                    (draft | active | completed | retired | archived), disciplines JSON, start_date, end_date,
                    race_date, source JSON (kind-specific refs: COROS plan id + pb_version, stamp prefix, …),
                    config JSON (zod per kind), created_at, updated_at, archived_at
program_versions    id PK, program_id, version_num, captured_at, fingerprint, summary JSON
program_blocks      id PK, program_id, number, start_date, weeks, kind (core_block | firm_week | shape_week),
                    intent JSON (core lift per family + rotations; or {volumeTarget, keySessions}), created_at,
                    updated_at
```

Adaptive config (`programs.config`, zod): `weeklyGoal`, `preferredDays[]`, `defaultMinutes`, `defaultLocationId`,
`blockWeeks` (4–6), `modes[]`, `attachedProfiles[]`, `sessionDiscipline` rules (§9.2), `placementWeeksAhead`.

Phase 5 inserts rows for every `training_plans`, `coach_plans` and `studio_plans` row **with the same id**, then
switches readers. The garden's plan-gap reader becomes `kind = 'coros_import'` and coached credit becomes
`kind = 'coach'` (the `adhoc-` prefix check preserved), so their semantics cannot move.

### 8.2 Planned sessions

`planned_workouts` gains three nullable columns:

- `origin`: `program` | `on_demand` now; `coros` | `coach` | `studio` backfilled in Phase 5. Null reads as the
  inferred origin (from which table the `plan_id` lives in).
- `content_state`: `outline` → `built` → `started` → `done` (null for rows with fixed content).
- `session_params`: JSON — minutes, focus regions, location, mode, theme, equipment exclusions (on-demand and
  coach-edited sessions), plus the day's overrides and swaps.

Program rows use `plan_id = programs.id`, `source_workout_id = id`, `lastVerifiedCorosDate = ''`,
`coros_sync_state = 'calendar_only'`. Every existing column keeps its meaning.

### 8.3 Builds, performed sessions, sets, checks

```
session_builds      id PK, user_id, workout_id, version, engine_version, inputs_hash, payload JSON,
                    locked_at, created_at            -- unique (workout_id, version)
performed_sessions  id PK (client-generated, the idempotency key), user_id, workout_id NULL, activity_id NULL,
                    build_id NULL, source (app | watch_review | import), source_ref NULL (import: the source's own
                    session id), local_date, started_at, ended_at, seconds, planned_seconds, mode, theme,
                    location_id, block_ref, completed, steps_total, steps_done, note, new_move, payload_hash,
                    created_at, updated_at            -- unique (user_id, source, source_ref)
performed_sets      id PK, performed_session_id, entry_index, exercise_id, implement, format, per_side,
                    set_index, side NULL, reps NULL, seconds NULL, load_value NULL, load_unit NULL, load_kg NULL,
                    done, flags JSON
condition_checks    id PK, user_id, profile_id, kind (pre | post | daily), value 0–10 NULL, feeling_off,
                    local_date, at, performed_session_id NULL, workout_id NULL
```

Weights are stored **exactly as entered** (`load_value`, `load_unit`) plus `load_kg` (derived, for maths). Display
uses the entered value and unit; comparisons use kg with a 0.05 kg tolerance, as the standalone tool does.

### 8.4 Per-user settings

```
user_conditions     user_id, profile_id, active, since, settings JSON          -- PK (user_id, profile_id)
locations           id PK, user_id, name, equipment JSON, implements JSON (e.g. bell weights as typed),
                    is_default, created_at, updated_at
exercise_prefs      user_id, exercise_id, rating NULL, excluded, pinned, introduced_on NULL  -- PK (user_id, exercise_id)
exercise_provenance id PK, user_id, exercise_id, source_type, url, creator, source_key, created_at
```

Prefs JSON gains `weightUnit: "lb" | "kg"` (default `lb`) and `equipmentWishlist: string[]`.

### 8.5 Existing tables

- `activities.source`: `coros` (default, backfilled for every existing row) | `app` | `import`.
  - COROS adoption never considers `import` rows. Adopting an `app` row is the deliberate merge (§10.6); legacy
    `coros` rows without a COROS id keep today's adoption behaviour.
  - `repairTimestamps` and every repair or dedupe path skip non-`coros` rows.
- `activity_source_links.provider` gains `app` and `import`.
- `workout_completion_matches.method` gains `app_session`.
- `coros_exercises.raw` keeps the catalog's `muscle`, `part`, `equipment` (and `exerciseType`, `targetType`).

## 9. Programs and slots

### 9.1 Placement

An adaptive program places **slots** (planned rows with `origin = 'program'`, `content_state = 'outline'`) on its
preferred days up to the weekly goal, `placementWeeksAhead` weeks ahead (default 2), idempotently (re-running never
duplicates; a moved or skipped slot is never re-placed). Placement runs on program create/edit and in the hourly
cron. Slots are `calendar_only`: they get Calendar events through the existing reconciler, are movable and skippable
with the existing verbs, and count in "% of plan" and the week ribbon. A skip keeps its meaning: it did not happen.

### 9.2 Discipline of a slot

The garden credits one discipline per session. Before build a slot carries the program's default discipline; on
build it becomes `strength` when the built session contains a core lift, otherwise `yoga` (mobility, jaw care,
breathing). The row's `sport`/`category` update with the build.

### 9.3 On-demand sessions

"New session…" takes parameters (minutes, focus regions, location/equipment, mode, optional theme). It creates a
row with `origin = 'on_demand'` under a per-user "On-demand sessions" program (the `adhoc-` pattern), builds it
immediately, and the athlete does it now or schedules it.

### 9.4 Coach edits (Phase 4)

A coach op carries **parameters**, never a session body, for program and on-demand rows. It expands at the selector
seam into a parameter update; the engine rebuilds. The manifest renders the rebuilt session. Rows whose content is
locked (started, or sent to the watch) refuse the edit with a clear reason.

## 10. Session lifecycle

### 10.1 Open and build

Opening a slot (Today card or the session sheet) on its day shows the proposal: the pre-check first, then mode and
reasons, theme, time, place, the exercise list with "why this", swaps and how-to. `POST /api/sessions/:workoutId/build`
builds (or returns the stored build if the inputs hash is unchanged). Overrides and swaps rebuild. A build for a
future date is allowed (preview) but not stored as locked.

### 10.2 Start and lock

Start locks the build (`content_state = 'started'`, `locked_at`). From then on the content never changes on the
server; mid-session swaps are recorded in the performed session.

### 10.3 Player

A full-screen route `/session/:workoutId` outside the tab shell (the onboarding precedent), responsive on every
width: timed holds with a get-ready countdown and chimes; self-paced sets with Done and a log card whose steppers
accept `25`, `25 lb`, `12kg`; rests with +15 s and Skip; a per-exercise flag (the profile's `setFlags`); a mid-session
swap from the payload's alternatives; how-to one tap away; keyboard shortcuts on desktop; wake lock and 44 px targets
on phones; audio unlocked by Start (iOS PWA requirement).

### 10.4 Review and save

The post-check, done/undone sets, 👍 / 👎 / "not for me", graduation offers, new records, a note, Save. Ratings and
graduations persist **only on Save**.

### 10.5 Offline and the outbox

- When a session is opened, the client stores its build payload (steps + library slice + alternatives) in
  IndexedDB. The service worker additionally caches `/api/auth/me` and the shell so a relaunch works offline.
- In-progress state (recorder state, current step, timer anchor) is written to IndexedDB on every change.
- Save writes the result to an IndexedDB **outbox** keyed by the performed session's client-generated id and
  returns immediately ("Saved · will sync" when offline). The outbox drains on reconnect/foreground with
  `PUT /api/sessions/performed/:id`, idempotent: the same id with the same payload hash is a no-op; a different hash
  for an already-saved id is refused (never silently overwritten).
- Tested with the network off mid-session, with a reload mid-session, and with the tab killed mid-session.

### 10.6 What a save writes (server, one transaction-shaped batch)

1. `performed_sessions`, `performed_sets`, `condition_checks`.
2. An `activities` row with `source = 'app'`, sport `strength` or `yoga` (§9.2), duration from the session, no HR.
3. A completion match (`method = 'app_session'`) to the slot, if there is one; the slot becomes `completed`,
   `content_state = 'done'`.
4. Block upkeep (rotation, graduation on accepted offers), prefs (ratings, excluded, introduced).
5. `resimulateFrom(local_date)` for the garden; records and insights recompute on read as today.

**One physical session is counted once.** If the athlete also wore the watch, the COROS activity arrives later; the
ingest's adoption step (which never touches `import` rows) merges into the `app` row: COROS is the authority for HR,
duration and load; the row id, the match and every performed set survive; `activities.source` becomes `coros` and a
source link records both. The garden sees one activity with a stable id.

### 10.7 Imported history

The standalone tool's backup imports as `performed_sessions`/`sets`/`checks` with `source = 'import'`,
`source_ref = <its session id>`, plus `activities` rows with `source = 'import'` and no match. Import merges by
`source_ref`; running it twice changes nothing; a later import adds only new sessions. Block state, prefs, locations
and settings import once (later imports never overwrite local changes). Legacy exercise ids resolve through
`legacyIds`; `bilateral` (v1) and `perSide` (v2) both mean per side. `import` activities **never** enter the garden
(P8); they appear in Activity, Progress and records.

## 11. Watch (Phase 3)

- **Spike first (Phase 0 at the API level; the watch display needs the owner):** a stamped strength program with
  (a) an `originId: "0"` step with a free-text name, (b) a generic catalog step (Training) with a custom name, (c) a
  non-empty step overview, (d) a time-target step and a per-side pair. Read back twice; record what COROS keeps.
  Then look at the watch.
- "Send to watch" requires a pre-check, locks the build, **previews exactly what the watch will show** (names as
  COROS will store them, per-side as two steps, cues in the overview, weights in kg), and enqueues a new write-job
  kind (`program_session_push`) through the existing lane (3 per run, stamp-verified). Unmapped moves use whichever
  spike variant COROS keeps; if none survive, the preview says "this session stays on the phone" and the button is
  disabled.
- The program fingerprint is extended (for this job kind) to include step names and overviews, so a COROS rename is
  detected.
- After the watch session: the COROS activity imports and matches through `coros_plan_link`; the Today card asks for
  a **quick review** prefilled from the prescription (weights, reps, the post-check) which writes a performed session
  with `source = 'watch_review'` linked to that activity.
- `verifyWatchSync` stays false; the existing honest copy stays.

## 12. Integration

### 12.1 Garden (D2, P8)

- Completed program slots credit through the existing completed-planned-row path; `strength` → Lift,
  `yoga` → "Yoga & mobility".
- `buildDayInput` excludes `activities.source = 'import'` everywhere it reads activities (unplanned, adventures,
  dew), and excludes `app` activities dated before `APP_SESSION_EPOCH` (the Phase 2 ship date), following the
  `DEW_EPOCH` pattern. No `SIMULATION_VERSION` bump.
- Adaptive slots count in the week ribbon and "% of plan" like any planned row.

### 12.2 Activity, Progress and insights

- The feed shows app and merged sessions with their logged sets and pre → post check values in the inline expansion.
- Weekly strength volume (weight × reps; per-side counts both sides), lift tiles from real logs, the condition trend
  (pre vs post, flare days) as a `MetricResult` with insufficient-data honesty, consistency across all programs.
- Lift progression graphs (`plan-progressions.ts`) fill `actual` from logged sets (Phase 4).

### 12.3 Coach (Phase 4)

Dossier sections: active programs and blocks (core lifts, mode history), condition trend, logged strength (actual top
sets), equipment and locations (replacing the Studio brief). New ops: generate/edit a session by parameters, set a
program's mode or weekly goal, pin/rotate a core lift, create an adaptive program. Condition guardrails: `never`
rules fatal; limits advisory. Every new op gets a drift-tested worked example and survival-harness coverage.

### 12.4 Records and moments (Phase 4)

The engine's records (best set, heaviest implement, longest hold, first time) and milestones join
`records:v2:{discipline}` and the garden's earned-moment beats, gently.

### 12.5 Calendar

Program slots use the existing reconciler. The fix for the missing yoga prefix ships in Phase 0. A slot's title and
duration change when it is built; that is a normal event patch.

## 13. Data safety

### 13.1 Export, restore, delete-all (Phase 0)

- `GET /api/settings/export` covers **every** user table (a coverage test enumerates the schema like the delete-all
  guard does), versioned with `schemaVersion`.
- `POST /api/settings/restore` takes an export, validates it, refuses a non-empty account unless told to replace,
  inserts in dependency order in chunks within the 100-bind cap, and is round-trip tested (export → wipe → restore →
  export is identical).
- Delete-all keeps its guard; every new table is added.

### 13.2 Staging (Phase 0, P4)

- `[env.staging]`: its own Worker (`run-garden-staging`) and D1 (`run-garden-db-staging`), `crons = []`,
  `STAGING = "1"`, `FIXTURE_MODE = "0"`, `AI_DEFAULT_ENABLED = "0"`, its own `APP_URL`; secrets set separately with a
  **different `TOKEN_ENCRYPTION_KEY`** (copied provider tokens cannot be decrypted) and the same single-account gate.
- **Inert by construction**: with `STAGING = "1"` the Worker installs an outbound fetch allowlist on every request and
  scheduled event (only Google sign-in endpoints pass; COROS, Calendar, the MCP and the LLM gateway throw), the
  scheduled handler returns immediately, and a banner marks every page. Unit-tested.
- **The copier**: a temporary Worker bound to the prod D1 (read) and the staging D1 (write), invoked with a secret,
  copying table by table in pages within D1 limits, resumable, and verifying per-table counts and content hashes
  computed in-Worker on both sides. After the copy it scrubs `provider_connections` tokens in staging. The copier is
  deleted after each rehearsal. Nothing is written to disk. If this fails, stop and ask — never fall back to a local
  export.
- Staging data is wiped after each rehearsal, with the owner's OK.

### 13.3 Parity harness (Phase 0)

Admin endpoints that return **hashes only**, never content:

- garden: a from-genesis resim followed by SHA-256 of the snapshot JSON and the ordered event stream;
- DTOs: `/api/plan/today`, `/api/plan/week` for N weeks, `/api/garden`, the Activity/insights payloads, coach state;
- calendar: every `calendar_event_links.last_written_fingerprint` and suppression;
- COROS: write-job counts by kind and status in a window.

### 13.4 Migration invariants (written as executable checks)

- Every row of every user table maps 1:1 or is untouched (counts per table and per entity, content hashes of mapped
  fields).
- Ids are stable: planned-workout, activity, plan and proposal ids referenced anywhere.
- The garden is byte-identical before the cutover epoch.
- DTO hashes are identical for historical data, except listed intentional differences.
- Calendar fingerprints are stable and suppressions preserved; no write job is enqueued by a migration.
- The standalone import matches the standalone tool's own Progress numbers (session count, weekly volume, records,
  pre/post pairs, block state); weights exact; imports idempotent.

### 13.5 Production cutover (Phase 5)

Time Travel availability and retention confirmed; a restore bookmark recorded before each migration deploy; a tested
rollback runbook (restore the bookmark, redeploy the previous commit). Expand → migrate/backfill (idempotent,
resumable, capped per invocation) → switch reads behind parity checks → 2-week verification window → contract (drop
the old tables in a separate, final deploy, as migration 0014 did).

### 13.6 Production data rules (every brief that touches prod)

Read-only unless the owner approved the write; only the columns and rows needed; never `SELECT *` across tables;
never write query results to disk; if a local copy is truly needed, ask first and delete it in the same session;
verify cleanup yourself (grep for the account email, a size sweep of scratch dirs); prefer app-level actions through
the owner's authenticated browser over surgical SQL.

## 14. UX direction (mocks per slice; the owner approves)

- **Today card:** today's program session sits inside the one Today card beside the day's other workout ("Jaw care ·
  consistent · 30 min — Start"); the condition check is a compact chip beside the readiness chip, opening a sheet.
- **Player:** full-screen focus route on every width; the review follows it.
- **Plan:** programs as plan cards (block and core lifts in the program detail); "New session…"; the session sheet
  lists exercises with how-to and swap.
- **Activity:** app and merged sessions in the feed with logged sets and pre → post values; a condition signal tile;
  lift tiles from logs; a mobility filter.
- **Library:** reached from Plan (the nav stays at four tabs): browse, search, filters, how-to, rate/exclude/pin,
  wishlist unlock counts.
- **Settings:** equipment and places (implement weights), health conditions, program defaults, wishlist, weight unit,
  import from the standalone tool, complete export and restore.

Every mock is biased toward fewer visual objects, one card per purpose, plain labels, no explainer captions
(explanations one tap down), one voice per fact, and a garden that asks and never accuses. The responsive system
holds: three `min-width` tiers, no `max-width` layout queries, charts sized to their container, a 44 px tap floor.

## 15. Phases

Each phase ends with a multi-agent audit (§16.3) whose criticals and importants are remediated before the next phase.

**Phase 0 — groundwork and safety nets.** Housekeeping; baseline. The 09-20 parity bugs (coach remove/restore/adjust
side effects, `resultingCalendar` cases, stale guardrail wording), the yoga calendar prefix, sport-aware matching for
non-run sports, a single active match per workout. Complete export + tested restore; delete-all coverage.
`activities.source` + adoption/repair guards (schema, additive). Staging (§13.2) and the copier; the Time Travel
runbook; the parity harness (§13.3). The e2e smoke suite refreshed and added to CI. Spikes: COROS unmapped moves (API
level) and the lap reps/weight probe (masked keys only). (The IndexedDB outbox spike opens Phase 2b, where the
outbox is built.)

**Phase 1 — unified model, additively.** Migrations for §8 (programs, blocks, versions, builds, performed sessions,
sets, checks, conditions, locations, prefs, provenance; the three `planned_workouts` columns). Domain schemas and
weight parsing/formatting. `@rg/exercise-library` with the ported records, vocabularies, validation and the TMJ
profile; COROS catalog enrichment. `@rg/session-engine` ported with its tests. Nothing existing changes behaviour.

**Phase 2 — the adaptive program end to end on computer and phone.** Slices, each mocked first:
2a program + slot placement, build API, Today and Plan integration;
2b player, review, outbox and offline;
2c library, settings (equipment and places, conditions, weight unit, wishlist), the standalone-tool import, the
private provenance import, library growth from saves;
2d Activity/Progress from logged data, garden mapping with the epoch gate.
The owner starts the parallel run with the standalone tool.

**Phase 3 — watch.** Library↔COROS mapping, send-to-watch with preview, post-watch quick review, the app/COROS merge
proven live.

**Phase 4 — intelligence.** The combined day proposal (mode rules + readiness + plan context), unified progression
and records across programs, coach dossier/ops/guardrails, the flare advisory, on-demand sessions from the coach.

**Phase 5 — re-model of the existing plan kinds.** Copy `training_plans`, `coach_plans`, `studio_plans` (+ versions,
weeks) into programs with ids kept; backfill `planned_workouts.origin`; switch every reader (Plan, Today, coach,
garden, analytics, calendar, import rules, write executors); Studio authoring removed; watch removals for imported
sessions (09-20 §7 Phase B). Full staging rehearsal and parity, then the prod cutover.

**Phase 6 — contract and retire.** Drop the old tables after the verification window, in a separate deploy; final
standalone import; retire the standalone tool (banner, read-only); delete the Studio code; update every stale doc
(ARCHITECTURE, DATA_MODEL, SECURITY, TESTING, GARDEN_ENGINE, ANALYTICS, COSTS, DEPLOYMENT, BUILD_STATUS); a final
whole-system audit.

## 16. Quality protocol

### 16.1 Every task

TDD (failing test first, for the right reason). `pnpm -r typecheck`; the full `pnpm test` on **Node 21** (wrangler
and builds on Node 22, never mixed); `pnpm build:web`. Tests pin dates; none reads the real clock.

### 16.2 Every slice

An independent review on the most capable model in a fresh context, focused on input classes the tests do not
cover; findings graded by their effect on the athlete; criticals and importants fixed test-first. For UI: a
Playwright screenshot matrix at 360 / 390 / 768 / 1280 / 1440, light and dark, a hard zero-horizontal-overflow gate,
tap-target hit tests (centre plus four 4 px-inset corners), no reflow of what the eye is on; an independent live
verify (never concurrent with an editor in the same tree); real before/after renders for the owner.

### 16.3 Every phase

Parallel finder agents by dimension (data integrity and migration, COROS/Calendar write safety, garden determinism,
coach and LLM, UX and responsive, security and privacy, offline and sync), adversarial verifiers instructed to
refute each finding, a synthesized report in `docs/reports/` (generic, no personal data), remediation of criticals
and importants.

### 16.4 Every deploy

CI and Deploy green; health check; the edge serves the new bundle; key endpoints respond; the garden is unchanged for
pre-epoch history; sync status healthy; tail errors. After any COROS write, two real reads before believing it.

### 16.5 Privacy gate before every push

No personal data in code, fixtures, snapshots or screenshots: grep the diff for the account email, saved-post URLs
and creator handles; library records carry no URLs.

## 17. Risks

| Risk | Mitigation |
|---|---|
| App activities adopted or deleted by COROS ingest/repair | `activities.source` + guards ship in Phase 0, before any app activity exists. |
| Past gardens drift | Import rows never enter day inputs; app rows gated by `APP_SESSION_EPOCH`; parity hashes on staging. |
| Double counting a watch-worn app session | Adoption merges into the app row (one id); a match per workout enforced. |
| Offline save lost or duplicated | Client-generated id, idempotent PUT, payload-hash conflict refusal; network-off, reload and kill tests. |
| COROS refuses unmapped moves | Spike before Phase 3; sessions stay phone-only with honest copy. |
| Re-model breaks garden semantics | Kind-filtered readers reproduce plan-gap and coached credit; byte-identical resim hash on staging. |
| Staging touches the real COROS account or calendar | Outbound allowlist + no crons + different encryption key + token scrub. |
| Personal data in the public repo | Library carries no provenance; local-only import scripts; the privacy gate. |
| LLM cost | No new LLM calls in Phases 0–3; Phase 4 ops ride existing wakes; budget unchanged. |

## 18. Out of scope

A second condition profile (design for it, do not build it); video or illustrations; multi-user; lint; any new sport
id; a new garden axis or decay clock.
