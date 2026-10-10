# Studio, Coach Designer and the Workout Document — programme design, and Stage 1 (Foundation)

**Status:** design for review (2026-10-10). **Governing principles:**
[`docs/principles/workout-system-principles.md`](../../principles/workout-system-principles.md) — read it first; this
spec applies it and never overrides it. Personal specifics (goals, focus areas, condition, objectives, the owner's
request verbatim) are in the private companion named there, never here.

## 1. What the owner asked for

A new **Studio** tab over the whole exercise library (typeahead search, themes, tags, short summaries with detail on
tap, structured warm-ups and cool-downs, everything addable to a highly customizable yet simple plan); a **coach**
that designs workouts from the library on request or at one tap ("for now / later today"), reviews its own design along
several dimensions before proposing, works from the athlete's design principles toward their long-term goals
(balancing development and diversity; isometric, isotonic and plyometric work; recovery and yoga; focus areas), and
**shows its thinking**; **standardized check-ins** with free-text answers, the coach choosing what to ask;
**objectives and key results** visualized in a gently gamified board with the coach; all built on **one common rich
workout definition**, with agent tools designed to a high standard, and audited at the end against every part of the
request and against agent-design principles. A muscle-map view comes later.

## 2. Programme stages

Each stage: spec → plan → test-first implementation in batches → audits (finders → verifiers → fixes → re-review) →
gated deploy. Owner decisions are logged in the principles' §12.

| Stage | Delivers | Depends on |
|---|---|---|
| **1. Foundation** (this spec, §3 onward) | The workout document v1; converters from every existing format; storage and dual-write; the enriched library (contraction types, muscles, purposes, tags, short summaries) and new curated moves (graded plyometrics, ski-specific, yoga flows), condition-gated; the athlete's profile and objectives with computed key results; read APIs the Studio and the coach will use. | — |
| **2. Studio tab** | A new tab replacing the old Studio: library browse and typeahead search, filters (purpose, theme, tag, region, equipment, condition fit), compact cards with detail on tap, warm-up/cool-down structure and prompts, the Add sheet (into a workout's right part, or keep in rotation / pin in a program), a simple workout builder over the document with live time and balance; **saved templates** (save any workout as a named template — a workout document plus a name — browse, use and vary them). Old Studio screens, routes and tables retired after their plans convert. | 1 |
| **3. Coach designer** | The coach as a tool-using agent (library search, history, plan, profile, objectives, check-ins, memory, ask_athlete, propose_workout); designer → independent reviewer (rubric) → revision loop; one step per request; the transparent "thinking" view; **one simple coach control with a scope** — default *now / later today*, plus *this week* ("plan my week") and *the next N workouts*, with settings for how many and when; multi-workout scopes **orchestrated by a main agent that plans the set and delegates each workout to its own designer/reviewer sub-agent**, then reviews the set; the coach asks on its own judgement (worked examples, principles §6.10); memory v2 and the carried-forward features (below); **saved templates** reusable by the athlete and the coach; the objectives board (OKR-style, gently gamified). | 1, 2 |
| **4. Check-ins & feedback** | Standardized question definitions (scale/choice/yes-no + free text), storage and freshness, the coach's `ask_athlete`/`read_checkins` integration, a short daily surface; the existing condition check becomes one definition among them; **exercise feedback after sessions** (👍/👎, felt it where intended, too easy / too hard) feeding the coach and shown on the library card. | 1, 3 |
| **5. Final audits** | The owner's request audited verbatim, theme by theme, by separate agents; the coach's real context and behaviour audited under varied situations against agent-design principles; principles conformance. | 1–4 |
| Later | A muscle-map (anatomy) view driven by the library's muscle metadata. | 1 |

**Carried forward into Stage 3, and improved** (principles §6.7–6.8): the coach's memory becomes memory v2 — facts,
rules, notes and evidence-backed *observations*; provenance and confidence on every memory, the coach's inferences
marked until confirmed; pin, edit, delete and one-tap undo; a cached core plus `recall_memory` for the rest; expiry,
re-confirmation and supersession with history; profile-shaped memories move into the profile. Also kept and upgraded:
tap-to-approve with the computed manifest (plus approving part of a proposal, and editing before approving);
receipts; evidence that links to its data; the per-activity read (tied to objectives); triggers (showing why the coach
spoke up); the weekly review and focus line (with objectives and the week's balance); spend tracking (with cost per
design). The old Studio's plan brief (the athlete's stated constraints) migrates into the profile and memory.

The existing programme's Phase 4 (intelligence) and Phase 5 (re-model of the three plan kinds) are **folded into these
stages**: Phase 4's dossier/ops/guardrail work becomes Stage 3's tools and validators; Phase 5's plan-kind migration is
served by Stage 1's document and converters and completes when the old readers are retired. Phase 6 (retire the
standalone tool after its parallel run; drop old tables after verification) is unchanged.

---

## 3. Stage 1 — Foundation

### 3.1 Goals and non-goals

**Goals:** (1) the workout document v1 as the single definition, written by every source and convertible from every
existing format, without loss; (2) a library rich enough for intentional design (§4 of the principles); (3) the
athlete's profile and objectives with key results computed from logged data; (4) server APIs the Studio and the coach
will build on; (5) no behaviour change for the athlete except where noted.

**Non-goals in Stage 1:** the Studio UI, the coach's new behaviour, check-in UI, switching every existing reader to the
document (readers switch as later stages touch them — the watch wire and the player first in Stage 2/3), anything
GPS/route-based, intra-set variations (drop sets).

### 3.2 The workout document v1 (`packages/domain/src/workout-doc.ts`)

A zod schema plus TypeScript types, versioned, pure.

```ts
WorkoutDoc {
  version: 1;
  title: string;                       // plain, ≤ 80 chars
  intent: {
    summary: string;                   // one sentence: what this workout is for (≤ 200 chars)
    goals: GoalId[];                   // goal vocabulary (§3.4) — e.g. "ski", "posture", "athleticism", "alignment", "condition-care", "aerobic-base"
    focus: FocusRef[];                 // regions or muscles (library vocabularies)
    effort: "recover" | "maintain" | "develop" | "peak";
    objectiveIds?: string[];           // objectives it advances (profile)
  };
  parts: Part[];                       // ≥ 1, ordered
  source: { kind: "engine" | "coach" | "studio" | "coros_import" | "standalone_import" | "athlete"; ref?: string };
  notes?: string;                      // athlete-visible, optional
}

Part {
  purpose: "arrive" | "warmup" | "activation" | "main" | "power" | "accessory" | "conditioning" | "run" | "care" | "cooldown";
  why?: string;                        // ≤ 160 chars
  format: "straight" | "superset" | "circuit" | "flow" | "intervals" | "steady" | "ladder";
  rounds?: number;                     // circuits / supersets / intervals
  restBetweenRoundsSec?: number;
  items: Item[];                       // ≥ 1
}

Item =
  | { kind: "exercise"; libraryId: string;           // must resolve in the library (legacy ids accepted, canonicalised)
      dose: Dose; side?: "left" | "right";            // set only when a one-sided item is split explicitly
      why?: string; progression?: string }
  | { kind: "free_exercise"; name: string; dose: Dose; why?: string;   // ONLY for imports naming a move the library lacks
      coros?: { key?: string } }
  | { kind: "run"; target: { durationSec?: number; distanceM?: number };
      effort: "easy" | "steady" | "threshold" | "interval" | "rest" | "strides"; why?: string }
  | { kind: "rest"; seconds: number };

Dose {
  sets?: number;
  reps?: number | { min: number; max: number };
  holdSec?: number; breaths?: number; carryM?: number;
  perSide?: boolean;
  tempo?: { eccentricSec?: number; pauseSec?: number; concentricSec?: number };
  load?: { typed: string; kg: number } | "bodyweight";
  restSec?: number;
}
```

**Computed, never stored as authored** (`packages/domain/src/workout-doc-derive.ts`, pure): estimated minutes;
**balance profile** `{ isometricSec, isotonicReps, eccentricEmphasisReps, plyoContacts, aerobicSec, mobilitySec }` and
per-region/per-muscle exposure (from the library's metadata); garden discipline (`run` | `lift` | `yoga`, the existing
three axes, by dominant content); condition summary (max ratings per active profile); watch step count. These derive
from the document plus the library; tests pin them.

**Validation** (`validateWorkoutDoc(doc, { library, activeProfiles })`, pure): schema; every `libraryId` resolves;
every exercise's condition rating against active profiles — **"never" is a hard error**; part/format compatibility
(e.g. a superset needs 2 items; intervals need run or timed items); dose fits the exercise's dose type; sane bounds.
Errors are structured `{ path, code, message, fix? }` so a model can repair them (principles §6.2).

### 3.3 Converters (lossless in; adapters out)

Pure functions, each with a round-trip test over every shape that exists in the fixtures and in recorded real data
shapes (never personal content in tests):

| From | Converter | Notes |
|---|---|---|
| COROS stages (`plannedStageSchema`, imported runs and strength) | `docFromStages` | run stages → run parts; strength stages → parts with `free_exercise` items unless a T-code maps to a library id; original stages kept beside the doc for anything inexpressible. |
| Coach sessions (`CoachSession`: run / lift / mobility) | `docFromCoachSession` | lift/mobility exercises resolve to library ids where they can; otherwise `free_exercise`. |
| Old Studio sessions (`StudioSession`) | `docFromStudioSession` | originId → library id via the COROS mapping where exact. |
| Engine builds (`session-engine` payload) | `docFromBuild` | blocks → parts 1:1 (arrive/prep/core/accessory/care/cooldown → arrive/warmup·activation/main/accessory/care/cooldown); the engine's "why" reasons carried over. |
| Program watch pushes (`ProgramWatchSession`) | — | derived *from* the doc in Stage 3 (adapter out); in Stage 1 a parity test shows the doc yields the same watch steps as today's builder. |

**Adapters out** (Stage 1 provides them; later stages switch readers to them): `stagesFromDoc` (calendar/stage summary),
`watchProgramFromDoc` (run and strength wire, using the existing builders), `playerStepsFromDoc`.

### 3.4 Storage and dual-write

- **Schema (additive; owner OK required before deploy):**
  - `planned_workouts.workout_doc` (JSON text, nullable) — the document for every planned workout.
  - `session_builds.workout_doc` (JSON text, nullable) — the document of a built session (the engine writes it).
  - `athlete_profiles` (one row per user: goals JSON, focus areas JSON, preferences JSON, updated_at).
  - `objectives` (id, user, title, status, created/updated) and `key_results` (id, objective, label, measure JSON,
    target, unit, due date, direction up/down).
- **Dual-write**: every source writes the document alongside its existing format from Stage 1 on (engine builds, coach
  creates/edits, imports, the standalone import). Readers keep reading the old formats until their stage switches
  them; a parity check (below) proves the two agree.
- **Backfill**: a resumable job converts every existing planned workout and build into a document — bounded per
  request (≤ 45 D1 statements per step, principles §8), run by the cron or an admin route, with a dry-run report first.
  **Production data write: ask the owner before running it.**
- **Parity diagnostic**: a read-only admin route (counts and ids only) comparing doc-derived summaries (title,
  minutes, discipline, stage summary, watch step count) with the current ones, so drift is visible before any reader
  switches.

### 3.5 Library enrichment (`packages/exercise-library`)

**New record fields** (all validated against vocabularies):
- `summary` → kept as the **one-line card summary** (≤ 90 chars; existing ones rewritten where longer); the long how-to
  stays in `text`.
- `contraction: ("isometric" | "isotonic" | "eccentric" | "plyometric")[]` — at least one.
- `muscles: MuscleId[]` — primary and secondary: `{ primary: MuscleId[]; secondary?: MuscleId[] }` from a new
  vocabulary of about 30 muscles, each under an existing region (e.g. glute-max, glute-med, deep-hip-rotators,
  hip-flexors, adductors, hamstrings, quads, calves, tibialis, obliques, rectus-abdominis, transverse-abdominis,
  erector-spinae, thoracic-extensors, lats, rhomboids, lower-traps, upper-traps, rotator-cuff, pecs, deep-neck-flexors,
  scalenes, masseter/temporalis (jaw), feet-intrinsics…).
- `purposes: PurposeId[]` — warmup, activation, strength, power, balance, mobility, stretch, cooldown, recovery,
  condition-care, conditioning.
- `tags` — a real, controlled tag vocabulary (posture, ski, hip-opening, glute-activation, single-leg, landing,
  deceleration, anti-rotation, desk-relief, breath, thoracic, ankle, balance, rotational, lateral, plus any new tag via
  a vocabulary change).
- `themes` — membership of the existing themes (and new ones: ski-prep, athletic-base, plyo-intro), so Studio filters
  and the engine share one definition.

**Curation of the existing 126 records**: every record gains the new fields (a reviewed data change, one file at a time,
validated). **New records** (curated to the same standard, sources noted, no personal provenance):
- a **graded plyometric ladder**: landing/stick drills, snap-downs, pogo hops, line hops, skater bounds (low → high),
  lateral hops, broad jump to stick, box jump (step-down), drop landing — each rated for the active condition profiles;
  the profiles' rules gate them (never in recovery; only on low-symptom days; gentlest variant first).
- **ski-specific**: wall sit variations (isometric), single-leg balance and reach, Copenhagen plank, Nordic curl
  (eccentric), lateral lunge to balance, skater squat, tuck jump (gated), rotational stability holds.
- **yoga flows** for hips, thoracic spine and down-regulation.
Each new record passes `validate.ts`, has a one-line summary, full how-to, condition ratings with notes, and COROS
mapping only where exact.

**Engine compatibility**: the session engine keeps working unchanged (new fields optional to it); new records are
eligible by their existing fields (roles, patterns, equipment); the condition profile's rules gate the plyometrics in
the engine exactly as everywhere else.

### 3.6 Profile and objectives

- **Profile service** (`apps/worker/src/services/profile.ts`): read/update the athlete's goals, focus areas,
  preferences; condition profiles stay in `user_conditions` (read through the same service).
- **Objectives service** (`objectives.ts`): CRUD; **key-result measures** are typed and computed from logged data:
  - `hold_max { libraryId | familyId }` — longest hold in a window (performed sets + watch sets),
  - `best_set { libraryId | familyId, metric: "e1rm" | "load_at_reps" | "reps_at_load" }`,
  - `run_best { distanceM }` — best effort time from COROS activities (whole runs or splits where available),
  - `pace_at_hr { hrLow, hrHigh, minDurationSec }` — running economy trend,
  - `checkin { questionId }` and `test { testId }` (Stage 4 adds the question definitions).
  Each returns `{ current, series[], lastMeasuredAt, sampleSize, evidence: "measured" | "sparse" | "none" }`.
- **Seed** the owner's profile and first objectives from the private companion — **a production data write: with the
  owner's OK, once the service ships**.

### 3.7 Read APIs (for Stage 2/3; Stage 1 ships them with tests, no UI)

- `GET /api/library?q=&purpose=&tag=&theme=&region=&muscle=&contraction=&equipment=&fits=` — ranked search over the
  library with condition fit for the athlete (client-side search uses the same package function; the endpoint exists
  for the coach's tools and parity).
- `GET /api/library/:id` — the record with the athlete's history on it (last done, best, rating).
- `GET /api/workouts/:id/doc` — a planned workout's document (+ derived fields).
- `GET/PUT /api/profile`, `GET/POST/PUT /api/objectives`, `GET /api/objectives/:id/progress`.
All user-scoped, ≤ 45 D1 statements + fetches each (counting tests).

### 3.11 Amendment A — the design scenario red-team (2026-10-10)

A scenario red-team walked 61 everyday journeys through this design before Stage 1 code (quick condition relief,
soreness, planning the week, editing, "something like last week's", feedback, objectives, flare days, out of credits,
and more). Its Stage 1 findings are folded into the Stage 1 plan as "Amendment A" (validator parity with every
condition rule; an answers table so soreness, tightness and pain are recorded by area; per-session feedback kept;
document revisions; the document's cues, alternates, "to max" doses, run targets, setting and lineage decided in v1;
balance derived from what was actually done; the profile's events, places and focus-area references; honest
key-result measures; the watch adapter; the workouts list and read routes). Decisions for later stages:

- **Execution path for a document-sourced workout.** An approved coach, Studio or template document for a day becomes
  a `planned_workouts` row with an app origin and its document in `workout_doc`; it is played and pushed through a
  `session_builds` row materialised from the document (payload from `playerStepsFromDoc`, `workout_doc` = the
  snapshot), so Start re-gates and locks it, the performed session points at the exact document performed, and the
  watch uses the app-built Send / Take off path. The coach may propose a **new revision** of a document-origin row,
  never of a programme row, and never of a completed, skipped or missed one.
- **Stage 2 (Studio):** edits write revisions (`athlete_edit`); resolved rows are read-only; an edited workout whose
  watch copy is older offers "Send the new version". Added moves land by purpose (warmup to warmup, activation to
  activation, strength to main, power to power, balance to accessory, mobility / stretch / recovery to cooldown,
  condition-care to care, conditioning to conditioning), and the athlete can move them. Templates get their own table
  and stamp `basedOn`; at another place the equipment check runs and alternates are offered. The player gets an
  open-ended timer for `dose.max` that logs the actual seconds, and a mid-session swap offering the item's alternates.
  **Instant quick-starts** (favourites, templates, a short condition-care routine) start in one tap without a coach
  call.
- **Stage 3 (coach):** tools for readiness (HRV, resting HR, sleep, load and the readiness verdict, with their
  staleness), the profile with places and events, a workouts list and get (document + actuals + feedback), balance
  over a range (from `derivePerformed`), answers (read and record), templates, past proposals, and the plan including
  programme blocks and outline slots. `propose_workout` takes a target: a new workout (date, time) or a revision of a
  workout at a base revision, with a computed diff; a stale base, a resolved row or a programme row is refused with a
  reason the model can act on. Soreness, tightness or pain stated in a request is recorded as an answer (with one-tap
  undo). The reviewer sees the request and scope, the deterministic issues and derived fields, and the designer's tool
  results with their provenance, and may call read tools itself; sub-agents share one fact pack fetched by the main
  agent. Two open questions at a time. Steps are driven by the client with resumable server state; a cron sweep
  finishes or expires orphaned runs. Tool results mark untrusted text fields. The prompt's condition rules are
  generated from the condition profile, so prompt and code cannot disagree. Several tool calls may run in one step
  within the request budget; cost is measured per scope and an estimate is shown before planning a week.
- **Review always precedes a proposal** (the owner's words: the coach "review[s] itself along multiple dimensions
  before proposing"). Speed for quick relief comes from the instant quick-starts above, which do not call the coach;
  for short care or recovery requests the coach's design and review are kept small, not skipped.
- **When the AI is unavailable** (out of credits, over the weekly cap): the coach says so plainly and offers the day's
  programme session, a liked workout, a template or an engine build.
- **Stage 4 (check-ins and feedback):** a question registry with an `areas` answer type (several areas, each with an
  optional 0-10); soreness and energy are separate questions; a pain question names an area and optionally an
  exercise; each question sets its freshness. After a session: a one-tap workout rating ("loved it / fine / not
  again"), optional per-move difficulty and "felt it where intended" / "hurt where?"; the watch's quick review gets the
  same. Library cards show the athlete's feedback history from the answers table. The `checkin` and `test` key-result
  measures read the answers and the test items.

### 3.8 Testing

- Schema, validator, derivations, converters and adapters: unit tests (pure), including round-trip and parity over
  every existing shape.
- Library: `validate.ts` extended; vocabulary coverage; every record has the new fields; condition ratings for every
  new record; plyometrics are excluded in recovery mode by the engine (engine tests).
- Services and APIs: makeTestDb with `boundVariableCap: 100`; budget counting tests; TZ=UTC; clock-shift.
- Backfill: dry run, resumability (kill at any write → resume → identical result), idempotence.
- No personal data in any fixture, snapshot or screenshot.

### 3.9 Rollout

1. Library enrichment and new moves (no schema change) — deploy.
2. Document schema, validator, derivations, converters, adapters (pure code) — deploy.
3. Schema migration + dual-write + parity diagnostic — **ask the owner before the schema deploy**.
4. Profile and objectives services + APIs — deploy; **seed with the owner's OK**.
5. Backfill (dry run → report → owner OK → run) — verify with the parity diagnostic.
Then Stage 1's audits (principles conformance, correctness, privacy, budgets), fixes, re-review.

### 3.10 Risks

- **Curation volume**: ~126 records to enrich plus ~25–30 new ones — split into reviewable batches; validation catches
  vocabulary errors; the owner can veto any new move.
- **Converter loss**: anything inexpressible is kept beside the document; parity diagnostic before any reader switches.
- **Plyometrics and the condition**: gated by ratings and profile rules in code; recovery never includes them; the
  gentlest variant first.
- **Budgets**: every new endpoint and the backfill step are counted in tests.
