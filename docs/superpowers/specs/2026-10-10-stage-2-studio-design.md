# Stage 2 — The Studio (design)

**Status:** written by the lead under the owner's overnight autonomy (2026-10-10: "keep going into the Studio" — built
from the lead's own mocks; the owner reviews it live). **Authority:** `docs/principles/workout-system-principles.md`
(binding), the programme spec `2026-10-10-studio-coach-programme-design.md` (§2 stage table, §3.11 Amendment A), and
Stage 1's workout document, library fields and read APIs. Personal specifics stay in the database and the private
companion; this document is generic.

## 1. What the Studio is for

One place to **see every move, understand it quickly, and turn moves into workouts with intention**:

- every exercise, found by **typeahead search**, with a **short summary and metadata** so the list stays concise;
  **expandable** to learn more, with **tooltips** that explain each term;
- organised along **themes**, searchable and filterable by **tags**;
- **prompting and structure around warm-ups and cool-downs** — a workout has parts with purposes, and the Studio
  suggests what belongs in each;
- everything **addable to a plan**; the builder is **highly customisable and intelligent, with a simple, elegant
  surface** (principles §7);
- **saved templates**, **edits** of planned workouts (as revisions), and **instant quick-starts** that need no AI.

The coach's composer ("what do you want to do?", *Now* / *Later today*) lives at the top of the Studio but arrives in
Stage 3; Stage 2 reserves its place and ships everything around it. Check-in and feedback screens are Stage 4; the
muscle map comes later.

## 2. Navigation and layout

- A fifth tab, **Studio** (`/studio`), between Plan and Activity: Garden · Plan · Studio · Activity · Settings. Icon:
  a simple dumbbell-and-leaf or a grid; the bottom bar keeps five equal links; the side rail gains the entry.
- `/studio` uses the **wide** treatment (like `/plan`): one column on phones, two at `md` (list + detail), three at
  `lg` (filters · list · detail/builder).
- Sub-routes: `/studio` (home and search), `/studio/move/:id` (detail; a sheet over the list on phones, the right pane
  on wide screens), `/studio/build/new`, `/studio/build/template/:id`, `/studio/build/workout/:workoutId` (the
  builder), `/studio/templates`.
- The old, hidden AI plan generator called "Studio" inside the Plan screen's plan modal is retired: its two entry
  points and its screen code go; the coach-plan detail and the coach interview intake that share the modal stay.
  Its server routes and tables stay until the owner approves dropping them (dropping is a deletion).

## 3. Studio home

```
┌ Studio ─────────────────────────────────────────┐
│ ┌ 🔍 Search moves, muscles, tags ──────────────┐ │
│ └──────────────────────────────────────────────┘ │
│ [ Coach composer — Stage 3 ]                     │
│                                                  │
│ Quick starts                                     │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐ │
│ │Jaw care  │ │Desk reset│ │Hip opener│ │+ yours│ │
│ │5 min     │ │8 min     │ │10 min    │ │       │ │
│ └──────────┘ └──────────┘ └──────────┘ └───────┘ │
│                                                  │
│ [ New workout ]            Templates (4) ›       │
│                                                  │
│ Browse                                           │
│ Warm-up · Activation · Strength · Power ·        │
│ Balance · Mobility · Stretch · Care · Cool-down  │
│                                                  │
│ Themes                                           │
│ ┌ Hips & posture ┐ ┌ Ski prep ┐ ┌ Athletic base ┐│
│ │12 moves        │ │9 moves   │ │14 moves       ││
│ └────────────────┘ └──────────┘ └───────────────┘│
│ Tags  posture · ski · hip opening · single-leg · │
│       landing · desk relief · …                  │
└──────────────────────────────────────────────────┘
```

- Typing in search replaces the browse sections with results instantly (the library is in the client bundle; search
  is a pure function — no network, works offline).
- A browse chip, a theme card or a tag opens the same result list with that filter applied (shown as a removable
  chip under the search field).
- Quick starts are instant (§9). The condition-care quick start appears only while a condition profile is active.

## 4. Search and filters

- **One search function** in `@rg/exercise-library` — `searchLibrary(records, query, filters, ctx)` — used by the
  Studio (client) and `GET /api/library` (server), so both rank alike. Matching covers the name, family, summary,
  tags, purposes, contraction, muscle and region labels, and equipment. Ranking: exact name → name prefix → word
  prefix in name → summary/tag/muscle match → the rest; ties by condition fit for today, then the athlete's rating and
  pins, then name. Typos: a one-edit tolerance on words of five or more letters.
- **Filters** (a "Filters" button opens a sheet; active filters show as chips): part/purpose, contraction (isometric,
  isotonic, eccentric, plyometric, passive), body area (region → muscles), equipment (defaults to the current place's
  equipment, with "any equipment"), tags, theme, difficulty, **fits today** (passes every active condition rule for
  today's reading — on by default when a profile is active), and *pinned* / *not for me*.
- The result count and "Clear" sit beside the chips. An empty result says what to loosen, in plain words.

## 5. A move in the list, and tooltips

```
┌──────────────────────────────────────────────────┐
│ Goblet squat                                [＋] │
│ Squat holding one weight at your chest.          │
│ Strength · Isotonic ⓘ · Quads, glutes · Dumbbell │
│ 3 × 8 · last done 6 days ago · ✓ fits today      │
└──────────────────────────────────────────────────┘
```

- Line 1: name and the Add button. Line 2: the ≤ 90-character summary. Line 3: purpose · contraction · primary muscles
  · equipment. Line 4: the default dose, history (last done; times in 30 days), the condition fit (fits / care /
  not today, never colour-only).
- **Tooltips**: every term chip (a contraction, a purpose, a tag, a muscle) is a button that opens a small popover
  with one plain sentence (e.g. *Isometric — holding still against resistance*). The glossary is data
  (`GLOSSARY` in `@rg/exercise-library`, one sentence per vocabulary id), so the coach and the Studio explain terms
  alike. A new accessible `Tooltip` component: a button with `aria-expanded` / `aria-controls`, tap or Enter toggles,
  Escape and outside-tap close, never hover-only.
- Tapping the row opens the detail.

## 6. Move detail

A sheet (phones) or pane (wide), in this order: name and summary; the metadata chips; **How** (setup, steps); **Focus**;
**Common mistakes**; **Breathing**; **Why** (the move's purpose in plain words); the **condition note** for each active
profile in plain words (e.g. "Keep your teeth apart"); **Muscles** (primary, then secondary); **Easier / Harder**
(the progression ladder, each a link); **Your history** (last done, times in 30 days, best set or hold, your rating,
and the *pin* / *not for me* toggles); footer: **Add**.

## 7. Add — one small sheet

```
┌ Add Goblet squat ────────────────────────────────┐
│ ○ To the workout I'm building  "Hips & posture"  │
│ ○ To a planned workout          Thu · Strength ▾ │
│ ○ To a new workout                               │
│ ○ To a template                 Pick ▾           │
│ ──────────────────────────────────────────────── │
│ [ Pin — keep it in my rotation ]                 │
│                                       [ Add ]    │
└──────────────────────────────────────────────────┘
```

- The move lands **in the part its purpose belongs to** (warm-up → warm-up; activation → activation; strength → main;
  power → power; balance → accessory; mobility, stretch, recovery and passive moves → cool-down; condition care →
  care; conditioning → conditioning), creating the part if needed; the athlete can move it after.
- Planned workouts listed are only those the Studio may edit: document-origin rows (Studio, coach, template) that are
  not completed, skipped or missed. A programme's own sessions are built by the engine, so for those the sheet
  offers **Pin** (the engine prefers pinned moves) instead.
- After Add: a quiet confirmation line with **Open** and **Undo**.

## 8. The builder

```
┌ ‹ Hips & posture ─────────────────── [Save ▾] ───┐
│ Why: Open the hips and wake the glutes before    │
│      a heavier hinge.                            │
│ Effort  Recover · Maintain · [Develop] · Peak    │
│ Goals   posture · ski                            │
│ ┌ 34 min · Lift · Home ────────────────────────┐ │
│ │ Holds ▮▮▮▯  Through range ▮▮▮▮▮  Jumps ▯     │ │
│ │ Works hips, glutes, upper back               │ │
│ │ ⚠ Copenhagen plank: not in a circuit on a     │ │
│ │   high jaw day                       Fix ›   │ │
│ └──────────────────────────────────────────────┘ │
│ Warm-up · 5 min                           ⋯      │
│   Cat-cow                    2 × 6        ⋯      │
│   Suggested: Hip airplane · Ankle rocks  ＋      │
│ Activation                                ⋯      │
│   Glute bridge               2 × 10       ⋯      │
│ Main · superset × 3                       ⋯      │
│   Romanian deadlift      3 × 8 · 25 lb    ⋯      │
│   Copenhagen plank           3 × 20 s     ⋯      │
│ Cool-down                                 ⋯      │
│   Suggested: Couch stretch · 90/90 ＋            │
│ [ ＋ Add a part ]                                 │
│──────────────────────────────────────────────────│
│ [ Start now ]          [ Schedule… ]             │
└──────────────────────────────────────────────────┘
```

- **The document is the model.** The builder edits a `WorkoutDoc` through a pure reducer (`docEditor` in
  `@rg/workout`: add/remove/move items and parts, set dose, swap, set format/rounds, set intent) so every edit is
  testable without a browser. Undo is the reducer's history (last 20 edits).
- **New workouts start with structure**: Warm-up, Main and Cool-down parts, empty, each with suggestions; Activation,
  Power, Accessory, Care and Conditioning parts are one tap away.
- **Suggestions** — the "prompting around warm-ups and cool-downs" — come from a pure function
  `suggestForPart(doc, partIndex, library, ctx)`: a **warm-up** rehearses the main part's patterns and raises
  temperature (warm-up / mobility moves for the main part's regions); **activation** wakes the main part's prime
  movers before they load (e.g. glute activation before a hinge or squat — principles §2.5); a **cool-down** lengthens
  what the main part worked and the athlete's focus areas (stretch, mobility, passive); **care** offers the active
  condition's care moves. Up to three, ranked by fit today, novelty (not done recently) and the athlete's pins;
  each shows the reason on tap ("wakes the glutes before the deadlift").
- **Items**: tap opens an item sheet — dose (steppers for sets, reps or hold, load as typed with the athlete's unit,
  per side), cue, swap (the item's alternates first, then easier / harder, then same-purpose moves), move up / down,
  remove. Reordering uses buttons (no drag-only gesture).
- **Parts**: the header menu sets purpose, format (straight, superset, circuit, holds, flow, ladder), rounds, rest,
  and the part's one-line why.
- **Live summary**: `deriveDoc` gives minutes, discipline, the balance (holds / through range / eccentric / jumps /
  aerobic / mobility) and the areas worked; `validateWorkoutDoc` (with today's day context, the place's equipment and
  the athlete's "not for me" list) gives notes — errors block Start and Schedule with the reason and a **Fix** where
  one exists (swap to the suggested alternate); warnings are shown as costs, never as blocks (principles §2.7–2.8).
- **Save ▾**: *Save as template* (name); for a planned workout, *Save changes* writes a new revision (stale base →
  "This workout changed elsewhere — reload").
- **Schedule…**: a date (default today) and an optional time ("Later today" picks the next sensible slot after now);
  creates a planned workout (§10). **Start now**: schedules for today and starts it in the player.

## 9. Templates and quick starts

- **Templates** (`/studio/templates`): name, minutes, discipline, last used; pinned first. Open → builder; Start;
  Schedule; Rename; Delete (confirm). Using a template stamps `basedOn: { kind: "template" }`; at a place missing
  equipment, the validator's notes offer the alternates.
- **Quick starts** are documents built instantly by a pure function `quickStartDoc(kind, library, ctx)` — no AI:
  *condition care* (≈ 5 min, the active profile's care and passive moves, recovery mode), *desk reset* (≈ 8 min,
  desk-relief and posture moves), *hip opener* (≈ 10 min, hip-opening and focus-area moves), each varied by novelty so
  it is not the same every day; plus the athlete's pinned templates. Tap → the builder (pre-filled) with **Start now**
  in reach — two taps to a running session.

## 10. Server (Worker)

- `POST /api/workouts` `{ date, time?, doc }` → validates (`validateWorkoutDoc` with the day context; errors → 422 with
  the issues) → a `planned_workouts` row: origin `studio` (or `template` when `basedOn.kind` is template), title, the
  category / sport / duration from `deriveDoc`, `workout_doc`, `workout_doc_rev = 1`, a revision row; calendar and
  watch behaviour exactly as the app's own on-demand sessions (find how `origin: on_demand` rows are created and
  follow it, including which plan row they hang from). ≤ 45 statements.
- `PUT /api/workouts/:id/doc` `{ doc, baseRev }` → a new revision when the row is document-origin and unresolved;
  409 `stale_revision` / `not_editable` otherwise. If a watch copy exists, the response says so (the UI offers
  "Send the new version").
- `POST /api/sessions/:id/build` for a document-origin row **materialises the build from the document**
  (`playerStepsFromDoc`; the build's `workout_doc` is the snapshot) instead of running the engine; Start re-gates
  through the validator with the day's reading (an item now gated is swapped to its passing alternate, or Start
  explains why it cannot).
- Templates: `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`, `POST /api/templates/:id/use` (bumps uses).
- Read routes from Stage 1 (`GET /api/library`, `/api/library/:id`, `/api/workouts`, `/api/workouts/:id/doc`) serve
  the Studio; the list uses the shared `searchLibrary`.
- Every route user-scoped, counted (≤ 45 statements + fetches), tested with `boundVariableCap: 100`.

## 11. Player

- **To max** (`dose.max`): the timer counts up past the target and logs the actual seconds when the athlete taps Done
  (the capped hold today makes a hold-time objective unmeasurable).
- **Swap** offers the item's `alternates` first, then the engine's usual offers.
- **Cues**: an item's `cue` shows under its name.

## 12. Offline and caching

- The library and search are in the bundle (offline by construction). The builder works offline on drafts kept in
  IndexedDB; Schedule and Save queue through the existing outbox pattern only where the app already does so —
  otherwise they say plainly that they need a connection.
- Add `/api/templates` and `/api/workouts` reads to the service worker's read cache.

## 13. Copy

Plain words, no explainer captions; one voice per fact; depth one tap down; status never colour-only; units as the
athlete set them (miles, lb, °F where chosen). Labels come from the vocabularies' `LABELS`.

## 14. Testing

- Pure: `searchLibrary` ranking and typo tolerance; `suggestForPart` (activation before the main part's prime movers;
  cool-down covers worked areas and focus areas; condition fit); `quickStartDoc` (valid, within minutes, varied);
  `docEditor` reducer (every action, undo).
- UI: component tests with `renderToStaticMarkup` (the repo's convention); containment and responsive rules
  (`containment.test.tsx`, `responsive.test.tsx`) extended to the Studio.
- Worker: routes, revisions, stale base, the document-materialised build and re-gate at Start, budgets.
- E2E (Playwright, iPhone and desktop): search → detail → Add → builder → Schedule → it appears on the Plan; a quick
  start → Start now → the player opens; a template saved and reused.
- Screenshot QA in light and dark at phone, tablet and desktop widths, reviewed by the lead before the owner sees it.
- No personal data in fixtures or screenshots.

## 15. Risks

- **The fifth tab crowds the bottom bar** on small phones → labels stay short; icons carry the tab; checked at 320 px.
- **Two builders of a session** (the engine for programmes; documents for the Studio and coach) → one execution path
  for documents (§10) and the engine untouched; programme rows are never edited by the Studio.
- **Validator noise** → only errors block; warnings read as costs with a fix; the review gate measures how many
  notes a typical quick start shows (target: none).
- **Old Studio removal breaks the plan modal** → only the two Studio entry points and its screen go; the modal's coach
  plan detail and intake stay, with tests.
