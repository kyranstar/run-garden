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
