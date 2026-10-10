# Stage 3 — The coach designer (design)

**Status:** written by the lead under the owner's overnight autonomy (2026-10-10: Stage 3 "all the way", live
against the real model within the weekly cap, audited and fixed). **Authority:** `docs/principles/workout-system-principles.md`
§2 and §6 (binding — this spec implements them, it does not restate them), the programme spec §3.11 (Amendment A),
the Stage 1 foundation and the Stage 2 Studio. Generic: personal specifics live in the database and the private
companion only.

## 1. What it does

The athlete types what they want — or taps **Now** / **Later today** and lets the coach decide — and gets a
**designed** workout (or a set of them) drawn from the library, with an intent, reasons, and a visible
self-review along explicit dimensions, proposed for one-tap approval. While it works, the athlete **sees what it is
doing**: what it looked at, what it found, the draft, the review's scores and what changed. It is empowered, not
scripted (principles §6.1): it chooses what to read, whether to ask, and how to design, inside hard rules that code
enforces.

## 2. Shape of the system

```
 Studio composer / Now / Later today / Plan my week
        │  POST /api/coach/runs { scope, request? }
        ▼
   coach_runs (main) ──► step ──► step ──► …   (one model call per step; state persisted between steps)
        │                 │
        │                 └─ tool calls executed inside the step (reads, validate, ask, propose)
        │
        ├─ now / later today: the main run IS the designer (no orchestration needed)
        └─ week / next N: main plans the set → one designer run per workout → main reviews the set
                                   │
                         each designer: draft → reviewer run (independent) → revise (≤ 2 rounds)
        ▼
   coach_proposals (one proposal, op kind `doc_workout` per workout; approve all or some)
        ▼
   approve → planned_workouts rows with documents (the Stage 2 create / revise path)
```

- **Runs** (`coach_runs`, from migration 0028): role `main` | `designer` | `reviewer`, `parent_id` for sub-runs,
  `scope`, `request` (the athlete's words — data), `status`, compact resumable `state` (the message list the model
  sees, trimmed), `steps`, `cost_usd`, `proposal_id`. **Events** (`coach_run_events`): one plain-language line per
  thing that happened (tool called, what it returned in summary, draft, review, revision, question, error) with a
  bounded JSON payload — the transparency view reads only these.
- **Steps are driven by the client** (like the coach drain): `POST /api/coach/runs/:id/step` runs one model call
  for the run that is due (the main run or its next due sub-run), executes the tool calls the model asked for within
  the request budget, persists state and events, and answers `{ status, nextDue }`. The client loops while the run
  is active and the screen is open; a cron sweep advances or expires orphaned runs (one step per cron run, the cron
  limits apply). A step that cannot finish its tool calls inside the budget persists the remainder as pending tool
  calls and the next step executes them before calling the model.
- **Budget per step** (Workers Free): ≤ 45 combined D1 statements and fetches. Each tool declares its statement cost;
  the step executes tool calls in order until the next would exceed the budget. The model call is one fetch.
- **The model**: the strongest available Claude model through the Vercel AI Gateway's **native Messages endpoint**
  (`/v1/messages` on the same host and key) — it carries tools, prompt caching (`cache_control`) and the real effort
  setting. The model id is configuration (`AI_DESIGN_MODEL`), verified by the gateway's free schema probe before
  first use; the reviewer may use the same model.
- **Cost**: every model call is recorded in `llm_usage` (kind `design_main` | `design_workout` | `design_review`) and
  counts toward the existing weekly cap ($5 warn, $20 cutoff, shown in the UI). A run has its own ceiling (default
  $1.50 for now / later today, $6 for a week; settings) and stops gracefully at it with what it has. Before a week
  run the UI shows an estimate from measured averages.

## 3. The opening prompt — only what the agent must know (principles §6.3)

Layout, cache-friendly:

1. **[cached]** The principles (§2 and the parts of §6 the agent acts on), written as reasons and examples, plus the
   worked archetypes (§6.10); the tool contracts; a short profile summary (goals with the athlete's words, focus
   areas, active objectives with ids, default place).
2. *(cache breakpoint)* Pinned memory (facts and rules; ≤ 20 items).
3. **[per request]** The today header: date, weekday, time, timezone; units; each active condition's hard rules —
   **generated from the condition profile** so prompt and code cannot disagree — and today's reading with its time,
   or "none today"; one line of today's plan; dated events within the scope's horizon; the scope and its limits; the
   **availability index** (counts and dates, not contents: "check-ins: condition today 2 (07:40) · soreness none in
   3 d · history: last strength Oct 8, last run Oct 9 · plan: next 7 d 3 runs, 1 programme session · objectives: 3
   active · readiness: HRV 2 d old · templates: 4 · feedback: 6 ratings in 30 d"); the request (marked as the
   athlete's words).

Everything else — history, balance, soreness, feedback, the library, past workouts, the plan, readiness, memory
beyond the pinned core, past proposals — is reached by tools when the agent decides it needs it. The step log
records which tools each run called, so the context audit (§13) can see what the agent chose to look at.

## 4. Tools

Contracts: compact, ranked, paginated (`limit`, `cursor`), every result carries **provenance and freshness** (where
it came from, when, and what is missing), and **untrusted text fields are marked** (`{ text, untrusted: true }` —
notes, imported names, free-text answers). Errors are teachable (`{ error, why, fix }`), never a thrown stack.

**Read**
| Tool | Returns |
|---|---|
| `read_profile` | goals, focus areas (with refs), events, places (equipment, implements), units, conditions |
| `read_day(date?)` | the day's condition readings, plan line(s), what is already done, time left in the day |
| `read_plan(from, to)` | planned workouts with category, minutes, origin, completion; programme blocks and outline slots |
| `list_workouts(from, to, q?)` / `get_workout(id)` | document workouts with intent; a workout's document, revision, actuals and feedback |
| `read_history(from, to, kind?)` | performed sessions (moves, sets, flags) and runs (distance, pace, HR, feel), compact |
| `read_balance(from, to)` | `derivePerformed` over the range: contraction balance, region / muscle exposure, aerobic and mobility minutes, days since each focus area was trained |
| `read_readiness(days)` | HRV, resting HR, sleep, training load and the app's readiness verdict, each with staleness |
| `read_answers(question?, area?, since?)` | check-in answers and feedback (soreness, tightness, pain by area; exercise and workout ratings) with freshness |
| `read_objectives` | objectives and key results with progress (`measureKeyResult`) and evidence quality |
| `search_library(query, filters)` / `get_exercise(id)` | `searchLibrary` results (summary, purposes, contraction, muscles, fit today, last done) / the full record with the athlete's history |
| `list_templates` | saved templates (name, minutes, intent) |
| `read_proposals(status?)` | past proposals and how they ended (approved, declined, edited) |
| `recall_memory(query?)` | memory beyond the pinned core, with provenance and confidence |

**Act**
| Tool | Effect |
|---|---|
| `validate_workout(doc, date)` | `validateWorkoutDoc` with the day context + `deriveDoc` → issues (fatal / advisory) and derived fields — free to call as often as needed |
| `ask_athlete(questions[≤ 2])` | each `{ text, chips[], allowFreeText: true, why }`; the run pauses (`waiting_athlete`); answers are recorded as `athlete_answers` and the run resumes |
| `record_answer(...)` | records something the athlete stated in the request (e.g. soreness by area) as an answer, shown in the receipt with one-tap undo |
| `remember(kind, body, confidence, evidence?)` | memory v2 write (§9); inferred items are marked as inference |
| `propose_workout(doc, target, review)` | designer only: target `{ kind: "new", date, time? }` or `{ kind: "revise", workoutId, baseRev }`; refuses with a reason on fatal issues, a stale base, a resolved or programme row |
| `plan_set(briefs[])` | main only (week / next N): one brief per workout (date, purpose, emphasis, constraints, why) → spawns designer runs |
| `finish(summary)` | ends the run with one plain line for the thread |

## 5. Design → review → revise (principles §6.4)

- The **designer** gathers what it needs, drafts a document, and runs `validate_workout` until no fatal issue
  remains (the validator's advisory notes are costs it may accept with a reason).
- An **independent reviewer** run receives the draft, the request and scope, the validator's issues and derived
  fields, and the designer's tool results with provenance — not the designer's reasoning — and may call read tools
  itself. It scores each dimension 1–5 with one line each: intent clarity; sequencing (activation before loading,
  power while fresh); goal and objective alignment; balance over the week and month; progression vs history;
  diversity and novelty; recovery (soreness, the 48-hour rule); condition safety; time fit; equipment fit;
  specificity (not generic); honesty of the explanation. It lists **must-fix** items (anything scoring ≤ 2) and
  optional improvements.
- The designer **revises** against the review (≤ 2 rounds). The proposed version is the best-scoring one that passes
  every hard check; the review (scores, notes, what changed) is attached to the proposal and visible.
- **Fatal only when wrong** (memory of past failures: one objection must never bin a whole proposal): fatal = a hard
  condition rule, an unknown exercise, a past date, a resolved or programme row, a stale base. Everything else is a
  trade-off line above Approve.
- **Small requests stay small, never unreviewed**: for a short care or recovery request the designer and the
  reviewer each get a small step budget; review always precedes the proposal (the owner's words). Instant relief
  without AI lives in the Studio's quick starts.

## 6. Scope and orchestration (principles §6.9)

- **Now / Later today** (default; one tap): one designer run. "Later today" picks a sensible time after now (the
  athlete's usual training time, or the next free slot) and says which.
- **This week / next N workouts**: the main run reads the plan, history, balance, objectives and events, then
  `plan_set` — what each workout is for, spacing for recovery, the balance of qualities across the set, objective
  coverage, fit around runs and rest days. One designer per workout (each with its own reviewer), run as sibling
  sub-runs; the main run then reviews the set (balance, interference, progression from one to the next) and proposes
  it as **one proposal** that can be approved in whole or in part.
- **Settings** (Settings → Coach): default scope; how many workouts for "next N" (default 3); preferred training
  times; per-run cost ceilings; the model. Stored in `athlete_profiles.preferences.coach`.

## 7. Asking (principles §6.10)

- `ask_athlete` whenever an answer would change the design, at any point; never for what a tool can read; one or two
  questions at a time; chips plus free text. A run waiting on an answer shows the question at the top of the run
  view; answering resumes the run; dismissing lets the coach proceed on its best judgement and say so.
- The prompt carries the worked asking examples and workout archetypes from principles §6.10 as examples to reason
  from, not rules.

## 8. Proposals and approval

- A new op kind `doc_workout` in `coach_proposals.ops`: `{ target, date, time?, doc, review: { scores, notes,
  changes }, issues }`. Manifest lines are computed from the documents (title, date, minutes, parts), never from
  prose.
- Approve (all or some) creates or revises planned workouts through the same service the Studio uses (Stage 2 §10),
  queueing watch / calendar writes the way approvals already do (the drain). **Edit before approve** opens the draft
  in the Studio builder; saving it there approves the edited version (`basedOn: { kind: "proposal" }`).
- Declined and approved proposals stay readable by `read_proposals`, so the coach learns what the athlete accepts.

## 9. Memory v2 (principles §6.7)

- Kinds: fact, rule, note (expires), **observation** (learned from outcomes, with evidence). Each item carries
  provenance, **confidence** (`stated` | `inferred` | `confirmed`), `pinned`, and `superseded_by` (history kept).
- The pinned core rides in the cached prompt; the rest is recalled by tool. Inferred items are confirmed gently
  before they drive a big decision.
- Settings → Coach → Memory: see, edit, pin, delete every item; the run view shows what was remembered or used, with
  undo. Profile-shaped memories (goals, focus areas, places, events) move into the profile (a one-time, reviewed
  migration in this stage, dry run first).
- The existing coach's thread, triggers, per-activity reads, weekly review and questions continue; its memory reads
  and writes move to the v2 fields with defaults.

## 10. Transparency — the run view

```
┌ Coach · designing ────────────────────── $0.21 ─┐
│ "a 30-minute lower-body session at home"         │
│ ✓ Read today — check-in 2 at 07:40, run at 6pm   │
│ ✓ Checked recent work — legs last trained 5 days │
│   ago; two runs this week                        │
│ ✓ Searched the library — single-leg, 14 moves    │
│ ✓ Draft — "Wake, load, open": 31 min             │
│ ✓ Review — 4.3 avg · sequencing 5 · novelty 3    │
│   "Two moves repeat Tuesday's" → swapped         │
│ ● Revising…                                      │
└──────────────────────────────────────────────────┘
```

- Live while it works (poll run events every 2 s while a step is running), kept with the proposal afterwards; each
  line expands to the detail (tool arguments and a summary of what came back; the review's full scores).
- Failures say plainly what failed and what happens next ("The AI account is out of credits — here are three ways to
  train now: …" with the day's programme session, a liked workout, a template or a quick start).
- The composer lives at the top of the Studio (and the Plan screen's coach sheet links to it): a text field, **Now**,
  **Later today**, and a scope menu (This week · Next 3 workouts).

## 11. Objectives board (OKR)

- `/studio/objectives`: one card per objective — its key results as progress toward the target (current, baseline,
  target, the trend over the window, evidence quality: measured / sparse / capped / none), the workouts that served
  it recently, and the coach's one-line note. Gentle gamification: a "best ever" marker, a quiet progress ring, a
  streak of weeks with a workout serving the objective — never guilt, never a broken-streak alarm (principles §2.10).
- The coach links designed workouts to objectives (`intent.objectiveIds`) and may include **test** items
  (`item.test`, `dose.max`) so key results are measured, not guessed. The athlete adds, edits, pauses and completes
  objectives here.

## 12. Data and privacy

The athlete's data reaches only the model call itself; nothing personal is logged beyond what the app already
stores; run events hold summaries, not raw payload dumps; prompts never include secrets; free text is data.

## 13. Testing and audits

- **Deterministic first**: every tool, the step loop (budget, pending tool calls, resume after `waiting_athlete`,
  orphan sweep), proposal creation and approval, run cost ceilings — tested with a scripted model (the recorded-model
  fixture server and scripted tool-call sequences); no key needed.
- **Survival instrument**: generate hundreds of plausible drafts (from the library and quick-start builders, mutated)
  and measure the fraction that pass validation and proposal creation, with ranked failure causes (the lesson of the
  past coach's failures).
- **Live** (within the weekly cap, a budget of ≈ $8 for the suite): a scenario suite of the athlete's common
  journeys — quick condition relief, soreness recovery, tight hips at home, a gym strength day, a run + mobility day,
  "something like last week's", a flare day, a vague request, an aggressive request, an impossible request, plan my
  week, next three workouts — each run captured (context, tool calls, events, draft, review, proposal) and judged:
  (a) against the principles by an expert-coach agent; (b) the context against "interview-style" agentic design
  principles (programme §10.2); (c) a scenario red-team of the built system (principles §10).
- Survival, cost and latency per scope are recorded in the ledger.

## 14. Risks

- **Cost** → per-run ceilings, caching, small budgets for small requests, the estimate before a week run, the cap.
- **Latency** (minutes for a full design and review) → the run view makes the wait legible; quick starts give instant
  relief; steps persist so closing the app loses nothing.
- **Tool-call sprawl** → the availability index tells the agent what exists; tools are ranked and paginated; the
  context audit checks what it chose.
- **Two coaches** (the existing thread coach and the designer) → one memory, one proposal surface, one spend cap; the
  designer is invoked from the Studio and from the thread when a request is a workout design.
