# Workout System Principles

The standing principles for Run Garden's workout system: the workout document, the exercise library, the Studio, the
coach that designs workouts, the athlete's profile and objectives, and check-ins. **Every spec, plan, implementation
brief and audit in this area cites this document and is judged against it.** It changes only by an explicit, dated
decision of the product owner (§12).

Written 2026-10-10, when the owner asked for "a Studio … a coach that designs workouts from the library … built with
the philosophy of abstracting all workouts to a common rich definition", and for these principles to be written down
"so agents can revisit them in perpetuity".

---

## 0. How to use this document

**Read it before** writing a spec, a plan, a subagent brief, or an audit for anything in this area, and before
changing the coach's prompt, tools or context.

**Precedence**, highest first:
1. The owner's explicit words in the current conversation.
2. The owner's dated decisions (§12, and the decision tables of the specs that cite this file).
3. This document.
4. A spec or plan. Where a spec contradicts this document, the spec is wrong unless it records an owner decision.

**The private companion.** This repository is **public**. Everything personal about the athlete — their goals in
their own words, their condition and its history, their tight areas, objectives, measurements, equipment, and the
owner's original request verbatim — lives **outside the repository**:
- in the athlete's profile in the database (what the coach reads at run time), and
- in a private, git-ignored companion file on the owner's machine, at the root of the main checkout:
  `.superpowers/private/athlete-context.md` (not committed; agent worktrees do not contain it — briefs must give
  agents its absolute path; the canonical copy is the main checkout's, kept in sync with any working copy).

This document speaks of "the athlete", "their goals", "a condition profile, e.g. TMJ" — never of the person. An agent
that needs the specifics reads the companion; an agent that writes to the repository never copies from it.

**Words used here.**
- *Workout* — one session of training on one day: a run, a lift, a mobility or yoga session, or a mix.
- *Workout document* — the single, versioned definition every workout has (§3).
- *Part* — a purposeful section of a workout (warm-up, activation, main, power, accessory, cool-down…).
- *Item* — one thing inside a part: a library exercise with its dose, or a run segment with its target.
- *Library* — the curated, public exercise library (§4).
- *Profile* — the athlete's private goals, focus areas, conditions, objectives, equipment and preferences (§5).
- *Objective / key result* — something the athlete is working on over time, and the measurable numbers that show it (§5.2).
- *Coach* — the AI agent that designs and adjusts workouts (§6).
- *Proposal* — what the coach produces; nothing changes until the athlete approves it.

---

## 1. Purpose

Run Garden is one athlete's training system, built for them. It is the one place where every workout — runs from a
COROS plan, strength, mobility, yoga, condition care — is planned, done (on the computer, the phone or the watch),
logged, counted and learned from.

**The promise:** every workout is designed **with intention and with awareness of the possibilities**. It knows
what it is for, why each part is there and why in that order; it was chosen from the whole library, not from a
template; and over weeks and months the workouts add up to the athlete's long-term goals — development *and*
diversity, strength *and* recovery, without generic filler.

**What "good" feels like to the athlete:**
- They can see what a workout is for in one sentence, and why any exercise is in it with one tap.
- The coach's suggestions feel like they came from someone who knows them, their history, their goals and their
  body today — never like a generic plan.
- Their objectives visibly move, and the system notices when one stalls.
- Nothing the app shows disagrees with what is on the watch.
- Nothing scolds them.

---

## 2. Training principles

These are principles to **reason with**, not rules to apply mechanically. Hard safety invariants are enforced in code
(§2.7, §6.6), never left to a prompt.

### 2.1 Intention in every workout
- **A workout has an intent** — one sentence a person can read: what it is for today ("wake the glutes, then load the
  hinge; finish by opening the hips"). The intent comes first; the exercises serve it.
- **Every part has a purpose and a reason**, and the order serves the intent:
  - prepare the patterns and tissues the main work will use;
  - **activate before loading** (e.g. glute activation before a heavy hinge, so the target muscles do the work);
  - power and plyometric work early, while fresh, never after fatigue;
  - main strength work at the point of best quality;
  - accessories that support the main work or pay down neglect;
  - mobility and down-regulation at the end, moving through the range just opened;
  - condition care (e.g. jaw care) wherever its profile places it.
- **Every exercise has a reason in this workout**, short enough to show on tap ("activation before loading",
  "hips untrained for 6 days", "week 3 of 5 — up one rep").

### 2.2 Awareness of the possibilities
- Design from the **whole library** and the athlete's whole situation, not from a habit or a favourite.
- **Demands first, exercises second**: before choosing, name what the goal asks of the body — tissues, contraction
  types, planes, effort duration and repetition, environment.
- **Honour the intent behind a named exercise**: when the athlete names a movement they want a quality; keep their
  choice when it is good, and offer the higher-leverage option with a plain reason.
- **Consider alternatives**: for each important slot, know the 2–3 next-best choices and why they were not chosen.

### 2.3 Long-term development and diversity
- **Core lifts repeat in blocks** (about 5 weeks) so strength measurably builds; they rotate when a block ends or
  progress stalls.
- **Everything else rotates by neglect**: weekly exposure targets per pattern and region; a pattern or area that
  falls behind earns priority (coverage debt).
- **Novelty is a feature**: a new move each week; repetition across consecutive sessions is penalised.
- **Diversity is judged over weeks and months**, not within one day: planes of motion, unilateral and bilateral,
  stable and unstable, slow and fast, loaded and unloaded, every region the goals need.
- **Development is the point**: a workout either develops something, maintains it, or recovers — and says which.

### 2.4 Balance of qualities and contraction types
- Track and balance, over time: **isometric** (holds, positional strength — e.g. wall sits, planks),
  **isotonic** (concentric and eccentric work through range, including slow-lowering eccentric emphasis),
  **plyometric / elastic** (landing, rebounding, bounding — gated by condition profiles), and **aerobic**
  (runs, conditioning).
- Also balance: strength and mobility, power and control, tension and relaxation, single-leg and bilateral,
  sagittal / frontal / transverse planes.
- The **balance profile** of a workout is computed from its items (never authored), so the coach can see the
  week's and month's balance and correct drift toward any one quality.
- Balance is in service of the athlete's goals (their sport's demands, posture, alignment, athleticism), not an
  end in itself: a goal can rightly tilt the balance.

### 2.5 Progression at every scale
- **Within a workout**: activation → loading; easy → hard → easy; range opened → range used.
- **Across workouts**: +1 rep, +hold time or +load when the last sessions were clean; consistent mode needs two
  clean top-of-range sessions before going up; a flag or a symptom rise steps down; at the top of a range offer the
  harder variation ("graduate") or a slower tempo.
- **Across blocks**: rotate to a related variation; keep progress per exercise; group by family.
- **Across objectives**: each objective (§5.2) has a thread through the weeks — progressive exposures, periodic
  tests, and a visible trajectory.
- **Dose against the horizon**: a few weeks buys motor rehearsal, tolerance and freshness, not a transformation;
  say so. Unaccustomed eccentric or high-tension work is dosed in bouts (a first exposure, a second 48–72 h later),
  not daily.
- **Logged actuals drive everything** — what was done, not what was prescribed.

### 2.6 Recovery is training
- Modes: **recovery**, **consistent**, **build** — chosen from the athlete's state (checks, flags, history gaps,
  the 48-hour rule after building strength, weekly goals).
- Rest days are training; "daily" is usually the wrong answer — a free daily piece plus 2–4 real loading sessions.
- Read the day before and after any session; interference is proven by counting, not asserted.
- One budget, one body: adding to one discipline costs another; say what was taken out to pay for it.
- Taper into anything the athlete cares about (a race, a trip, a ski day), with a named cutoff date.

### 2.7 Conditions and safety
- A **condition profile** (the first: TMJ) rates every exercise and sets rules: moves it **never** allows, caps per
  mode, checks before and after, flags during a session, recovery triggers, a care block.
- While a profile is active its rules apply to **every** workout from **every** source — the engine, the coach, the
  Studio builder, imports.
- **"Never" is enforced in code** at every write path; a design that contains a forbidden move cannot be saved,
  proposed or sent to the watch. Softer rules ("fits this mode") are advisory and shown to the athlete.
- Impact and plyometric work are **condition-gated**: each such move carries the profile's ratings; the profile's
  rules decide when it may appear (e.g. never in recovery, only on a low symptom day, the gentlest variant first).
- Name a specific risk once, without alarm; no disclaimers, no "see a professional", no repetition.

### 2.8 The athlete decides
- The coach **proposes, never acts**. Every change is a proposal the athlete taps to approve; the costs the app can
  compute are printed beside it.
- An aggressive request the athlete can defend is answered, with its cost, not refused.
- Restraint is a complete answer — until they ask; a direct request to plan is a request for detail.

### 2.9 Honesty
- Never state in prose what the system can compute and print (counts, dates, the manifest); the model supplies
  reasoning, the app supplies facts.
- Numbers carry their meaning; weak evidence is named as weak (stale, one night, no baseline).
- Never invent a figure or the contents of something not seen — say what could not be seen.
- What the athlete already has is theirs, not the coach's.

### 2.10 Tone
- Brief, warm, specific — a coach, not an app.
- Gamification is gentle: the garden and the objectives board **encourage, never accuse**; a stall is noticed
  kindly, with a next step, never as guilt.

---

## 3. The workout document — one common, rich definition

**Every workout, from every source, is one document in one versioned format.** Sources write it (the session
engine, the coach, the Studio builder, the COROS import, the standalone import); readers read only it (the watch
wire, the player, the calendar, the garden, insights, the coach). The app and the watch cannot disagree because
both come from one document.

### 3.1 Shape
- **Intent**: a one-sentence summary; the goals it serves; the focus areas; an effort level
  (recover / maintain / develop / peak); the objectives it advances.
- **Parts**, ordered, each with a **purpose** (arrive, warm-up, activation, main, power, accessory, conditioning,
  run, care, cool-down), a **why**, and a **format** (straight, superset, circuit, flow, intervals, steady, ladder),
  with rounds and rest where the format needs them.
- **Items** inside parts: a **library exercise** by id (its name, how-to, ratings and muscles always come from the
  library) with its dose — sets; reps, hold seconds or breaths; per side; tempo or eccentric emphasis; load as typed
  (lb or kg) plus kg; rest — or a **run segment** (duration or distance, and an effort that becomes a pace band from
  the athlete's measured threshold). Each item may carry a why and a progression note.
- **Computed fields are never authored**: duration estimates, the balance profile, the garden discipline, watch
  step counts. A model or a person writes intent, structure and dose; code derives the rest.

### 3.2 Rules
- **Versioned** (`version: 1` first). Readers accept every version they have shipped; changes are additive.
- **Lossless conversion**: every existing format (COROS stages, coach sessions, old Studio sessions, engine builds,
  watch pushes) converts in; anything a converter cannot express is kept alongside, never dropped.
- **Units as typed**, stored with the canonical value (weights: as typed plus kg; paces: seconds per km).
- **One builder per output**: the watch preview is the wire (byte-for-byte), the player's steps are the document's
  steps.
- **The library is the vocabulary**: an exercise item without a resolvable library id is a validation error, except
  an explicitly marked free-text item (kept for imports that name a move the library lacks).

---

## 4. The exercise library

- **Curated, sourced, public.** Every record: a clear name; a short summary (one line for a card); full how-to
  (setup, steps, focus, common mistakes, breathing); why it matters; ratings for every condition profile with a
  note; difficulty; easier and harder links.
- **Rich, controlled metadata** — every field from a vocabulary, validated:
  - movement patterns, body regions, **muscles** (a muscle vocabulary under the regions; ready for an anatomy view),
  - **contraction type** (isometric / isotonic / eccentric emphasis / plyometric-elastic),
  - **purposes** (warm-up, activation, strength, power, balance, mobility, stretch, cool-down, recovery,
    condition care),
  - roles in a workout, equipment, position, laterality, load, dose type and range,
  - **themes and tags** (e.g. posture, ski, hip opening, glute activation, single-leg, landing, deceleration,
    anti-rotation, desk relief).
- **Growth is curated**, never bulk-imported: new moves pass the same validation and the condition ratings; impact
  and plyometric moves are graded from landing drills upward.
- **No personal provenance in the repository**: saved-post links, creators and anything about the athlete stay in
  the database.
- **Validation is a test**: vocabularies, dose sanity, required text, every profile rated, links resolve, coverage
  per block and per mode.

---

## 5. The athlete's profile, objectives and check-ins

### 5.1 Profile (private, in the database)
Goals in the athlete's words and as structured goal ids; focus areas (e.g. tight areas); active condition profiles;
objectives; equipment and places; preferences (units, days, session length). The athlete edits it; the coach reads
it on every design; nothing in it is ever copied into the repository.

### 5.2 Objectives and key results
- An **objective** is something the athlete is working on over time; its **key results** are numbers that show it,
  each with a current value, a target and (optionally) a date.
- Key results are **measured from logged data**, never typed in by hand when the data exists: hold times, sets ×
  reps × load or an estimated max, run times and pace at heart rate from COROS, test results. Where no automatic
  measure exists yet, a key result can be a check-in answer or a periodic test the coach schedules.
- The coach designs toward objectives, schedules tests, and notices stalls. The dashboard shows them clearly and
  gently gamified (§2.10).

### 5.3 Check-ins
- A **standardized question definition**: an id, plain wording, an answer type (0–10 scale, choice, yes/no), an
  optional free-text answer **always** available, which areas or conditions it concerns, and how long an answer
  stays fresh.
- **The coach decides what it needs to know**: it asks the two or three questions that matter for the decision in
  front of it, never a fixed form; an answer it already has is never asked again.
- Answers are data with timestamps; free text is the athlete's own words and is treated as data, never as
  instructions.

---

## 6. The coach as an agent

The coach is an **empowered designer**: it is given principles (§2), the athlete's situation, and **good tools** —
and it reasons, designs, reviews its own work and proposes. It is not a template-filler and not a rule engine.

### 6.1 Empower, don't script
- Give the coach **principles and the reasons behind them**, plus worked examples of good reasoning — not
  checklists that teach it to tick boxes. Examples teach voice: never put a failure pattern into an example.
- Hard invariants (safety, data integrity, privacy, budgets) are **enforced in code at tool boundaries**, not
  pleaded for in a prompt.
- Judgements about load, adjacency, ramp, rest and taper are **advisory**: shown to the athlete as costs, never a
  reason to silently discard a proposal. **Fatal** only for proposals that are *wrong* (edit the past, reference a
  nonexistent workout or exercise, violate a condition's "never", corrupt data).

### 6.2 Tools (designed as if for an interview question on agent design)
- **Small, typed, composable, well-named**: one clear job each; input and output schemas; a description that says
  what it is for, when to use it and when not to.
- **Read tools retrieve on demand** — search and filter the library (by text, purpose, pattern, region, muscle,
  contraction type, tag, equipment, condition fit), read history (recent sessions, sets, progress per exercise and
  objective), read the plan (upcoming days and their contents), read the profile and recent check-ins. Results are
  **compact, ranked, with ids and provenance** (where it came from, how fresh), paginated, with an explicit "none
  found" — never a dump.
- **Write tools are proposals only**: the model never writes the database directly. A `propose_workout` (and
  plan-level proposal) tool takes a workout document; code validates it (schema, library resolution, condition
  gates, budgets) and returns structured, teachable errors the model can fix.
- **Asking the athlete is a tool**: `ask_athlete` with tappable choices and a free-text option, used only when the
  answer would change the design.
- **Deterministic, idempotent, scoped**: every tool is scoped to the signed-in athlete in code; repeated calls are
  safe; errors say what was wrong and how to fix it.
- **Budget-aware**: tools return what fits; the loop has a step cap and a cost cap.

### 6.3 Context engineering
- **Minimal sufficient context**: a stable, cacheable prefix (principles, the athlete's profile summary, tool
  contracts) plus what the model retrieves. Large data is fetched by tools, not pasted.
- **Unknowns are explicit**: what could not be read, stale data, missing measurements are stated as such.
- **Untrusted text is data**: free-text answers, notes, imported names and anything from outside the app are passed
  as data and never followed as instructions.
- **No secrets in context**; nothing personal leaves the database except to the model call itself.

### 6.4 Design, then review, then revise
- The **designer** drafts a workout (or a plan change) with an intent and reasons.
- An **independent reviewer** — a separate call that sees the draft, the facts and the principles but not the
  designer's private reasoning — scores it along explicit dimensions, e.g.: intent clarity; sequencing (activation
  before loading, power while fresh); goal alignment; balance over the week and month; progression vs history;
  diversity and novelty; recovery and the 48-hour rule; condition safety; time fit; equipment fit; specificity
  (not generic); honesty of the explanation.
- The designer **revises** against the review; the loop is bounded (e.g. two rounds); the best-scoring version that
  passes every hard check is proposed, with the review visible.
- Deterministic validators run before and after the model: anything code can check, code checks.

### 6.5 Transparency
- The athlete can **see the coach think**: which tools it called and what they returned (in summary), what it
  considered, the draft, the review's scores and notes, and what changed in revision — live while it works, and
  kept with the proposal afterwards.
- No step is hidden behind "thinking…"; a failure says plainly what failed (e.g. "the AI account is out of
  credits") and what will happen next.

### 6.6 Measurement, not hope
- **Survival rate across varied requests**: parsing, library resolution, validation and apply are deterministic and
  testable without a model; generate many realistic requests and measure what fraction survive and why the rest
  fail.
- **Scenario evals** for design quality: fixed athlete situations (fresh, sore, flaring, low on time, before a ski
  trip, after a missed week…) judged against the review rubric; regressions block a release.
- **Cost per design** is measured and reported; a weekly cap is enforced; prompt caching is used.

### 6.7 Platform realities for the agent
- The Workers **Free** plan: each request stays within ~45 combined D1 statements + external fetches; an agent loop
  runs **one step per request** (state persisted between steps), which also makes each step a visible event.
- Model: quality first (the strongest available model for design and review), with caching; the model id is
  configuration, not code.

---

## 7. Interface principles

- **Simple surface, intelligent depth.** The fewest visual objects; one card per purpose; plain labels over clever
  ones; **no explainer captions on the page** — explanations live one tap down (tooltips, sheets).
- **The Studio**: the whole library with typeahead search, filters by purpose, theme, tag, region and equipment;
  compact cards (name, one-line summary, the few metadata chips that matter) that expand to the full how-to;
  warm-ups and cool-downs prompted and structured; **Add** opens one small sheet: into a specific workout (it lands in
  the right part) or keep in a program's rotation / pin it.
- **The builder** is direct manipulation: parts, reorder, dose steppers; the computed balance and time update live.
- **The coach** is reachable everywhere it helps: "recommend a workout for now / later today", or type a request.
- **Progressive disclosure, accessible, responsive** (phone first, desktop well), works offline mid-session.
- **Units as the athlete chose** (miles or km; lb or kg), everywhere, including the watch preview.

---

## 8. Data, platform and privacy constraints (verified facts)

- **Cloudflare Workers Free**: keep every request ≤ ~45 combined D1 statements + external fetches; crons do one heavy
  step per run; long work is split into resumable steps; never export a non-function from the Worker entry module.
- **D1**: ≤ 100 bound parameters per statement; ≤ 5 terms per compound SELECT; chunk large `IN` lists.
- **Schema changes** ship only with the owner's OK; migrations are additive first.
- **Production data**: read-only unless the owner approved the write; only the needed rows and columns; never written
  to disk; local copies deleted in the same session and the cleanup verified.
- **COROS wire truths**: pace targets need `intensityMultiplier: 1000` with millisecond values; COROS re-assigns
  group ids, recomputes container totals and drops empty fields on save — verify by value, never by raw bytes;
  addresses (idInPlan) are claims, not identities; prove ownership by stamp or content.
- **Privacy**: the repository is public; personal data lives only in the database and the private companion.

---

## 9. Engineering process

- Work in a git worktree; never bare `git stash`.
- **Test first** (record the failing test), then mutation-check every guard (revert it; a test must fail).
- Run the suite in local time and in **UTC**; check time bombs with the clock shifted (+45, +180, +365 days).
- **Audits**: finders → independent verifiers → fix wave → scoped re-review; never skip the verifiers.
- Ledgers, briefs and reports live in the worktree's git-ignored `.superpowers/` (temporary directories are wiped);
  briefs give agents absolute paths.
- Landing: small gated merges to `main` (every push deploys); CI **and** Deploy must both be green; UI changes get the
  owner's render approval; the owner is asked before schema changes, production data writes, and any COROS write
  that is not the app's normal behaviour.

---

## 10. Audit standards for this programme

Each stage ends with: finders on correctness, safety (conditions, privacy, budgets), and principle conformance
against this document; verifiers; a fix wave; a re-review.

At the end of the programme, additionally:
1. **The request, verbatim**: separate agents audit the result against every theme and sentence of the owner's
   original request (kept in the private companion).
2. **The coach's context**: agents capture the coach's actual context, tool calls and outputs under varied
   situations (fresh, sore, flaring, short on time, before an event, after a missed week, a vague request, an
   aggressive request, a request it cannot fulfil, out of credits) and judge them against §6 as an expert would
   judge an agentic system in a design interview.
3. **Principles conformance**: every section of this document checked against the shipped system.

---

## 11. What this system is not

- Not a generic plan generator: no workout without an intent, no exercise without a reason.
- Not autonomous: nothing changes without the athlete's tap.
- Not a rule engine wearing an AI costume: rules that matter are code; judgement is the coach's.
- Not a place for personal data in the repository.

---

## 12. Decision log

| Date | Decision |
|---|---|
| 2026-10-10 | Build order: **Foundation first** (workout document, richer library, profile and objectives, conversion), then the Studio tab, then the coach designer with self-review and transparency, then check-ins, then the final audits. A muscle-map view comes later. |
| 2026-10-10 | Plyometric and impact work **enter the library, condition-gated** by each profile's ratings. |
| 2026-10-10 | The new **Studio tab replaces the old Studio** (the hidden AI plan generator); its plans convert into the workout document; its screens and code are removed. |
| 2026-10-10 | **Add** from the Studio: into a specific workout (lands in the right part) **or** keep in a program's rotation / pin — one small sheet. |
| 2026-10-10 | Coach quality first: the strongest available model for design and review, with prompt caching; the weekly AI spend cap stays and is shown. |
| 2026-10-10 | The profile starts with four focus areas (in the private companion); check-ins cover a condition check, focus-area tightness, energy and soreness, stress and sleep feel — **the coach chooses what to ask**, free text always allowed. |
| 2026-10-10 | The Studio and its coach cover **everything**, runs included: one definition, one Studio, one coach. |
| 2026-10-10 | Approach A: **one rich workout document**, versioned, read and written by every part of the system. |
| 2026-10-10 | **Objectives and key results** (e.g. a hold time, a lift, a run time and running economy) are part of the foundation; an OKR-style, gently gamified dashboard comes with the coach stage. |
| 2026-10-10 | "Every workout should be designed with intention and awareness of the possibilities … do not be overly prescriptive for the coach, but instead empower the coach." (§2.1, §2.2, §6.1) |
