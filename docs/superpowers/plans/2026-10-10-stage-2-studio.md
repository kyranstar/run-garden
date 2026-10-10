# Stage 2 — The Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Studio tab where the athlete finds any move in a keystroke, understands it in a glance (summary, metadata, tooltips), browses by part, theme and tag, and turns moves into intentional workouts — built, saved as templates, scheduled, edited as revisions, started in the player — with instant quick starts that need no AI.

**Architecture:** Pure logic in packages (`@rg/exercise-library`: search, glossary; `@rg/workout`: suggestions, quick starts, the document editor reducer) shared by the UI and the Worker; thin Worker routes over Stage 1's storage (`workout_doc`, revisions, templates); React screens in `packages/ui` following the repo's components, tokens and tests.

**Tech Stack:** TypeScript, React (react-router v6, TanStack Query), the repo's global stylesheet and tokens, Hono on Cloudflare Workers + D1 (Drizzle), vitest (node env, `renderToStaticMarkup` for components), Playwright (iPhone 13 + desktop).

**Spec:** `docs/superpowers/specs/2026-10-10-stage-2-studio-design.md`. **Principles (binding):** `docs/principles/workout-system-principles.md` §2, §3, §4, §7. Stage 1 (must be complete): `docs/superpowers/plans/2026-10-10-stage-1-foundation.md`.

## Global Constraints

- Public repository: no personal data in code, tests, fixtures, snapshots, screenshots or commit messages.
- Every request ≤ 45 combined D1 statements + external fetches; counting tests (`makeTestDb({ onStatement })`); ≤ 100 bound parameters per statement.
- Never export a non-function from `apps/worker/src/index.ts`.
- Node: vitest on default node 21; node 22 only for wrangler.
- Gates per commit: `pnpm -r typecheck`. Per batch end: `pnpm test`, `TZ=UTC pnpm test`, the Playwright e2e on the fixture stack.
- UI: tokens only (no raw px/rem in padding, margin, gap, font-size, weight, radius); breakpoints only 640 / 900 / 1024 (`responsive.test.tsx`); containment rules (`containment.test.tsx`); status never colour-only; light and dark; 44 px tap floor; plain words, no explainer captions; depth one tap down; labels from the vocabularies' `LABELS`; units from the athlete's settings.
- No schema change in this stage (Stage 1's migration 0028 carries the templates table).
- Test first; mutation-check each guard; commit messages in the repo's style with the session trailer.

## Review Focus

1. **A programme's own session** — the Studio never edits it; Add offers Pin instead; `PUT /api/workouts/:id/doc` refuses `not_editable`. Tests in Tasks 3 and 6.
2. **A stale or resolved workout** — editing a row changed elsewhere (base revision moved) or already done → 409 with a plain message; never a silent overwrite. Tests in Task 3.
3. **A gated move on the day it is played** — a document scheduled earlier is re-gated at Start with today's reading; the gated item swaps to its passing alternate or Start explains. Tests in Task 3.
4. **Offline** — search, detail, the builder and quick starts work with no network; Schedule / Save say plainly when they need one. Tests in Tasks 4 and 9.
5. **Small screens** — five tabs at 320 px; the builder's footer actions stay reachable; no horizontal scroll. Tests in Tasks 4 and 9.

---

## Batch 2A — pure logic and server

### Task 1: Glossary, search and suggestions

**Files:** `packages/exercise-library/src/glossary.ts` (+ index export), `packages/exercise-library/src/search.ts` (if Task 4 of Stage 1 placed `searchLibrary` elsewhere, extend it there), `packages/workout/src/suggest.ts`, `packages/workout/src/quick-start.ts`; tests beside each.

**Produces:**
```ts
export const GLOSSARY: Record<string, string>;   // every CONTRACTIONS / PURPOSES / TAGS id and the region ids → one plain sentence (≤ 90 chars)
export function searchLibrary(records, query: string, filters: LibraryFilters, ctx: SearchCtx): RankedRow[];   // Stage 1 signature; add one-edit typo tolerance on words ≥ 5 letters
export function suggestForPart(doc: WorkoutDoc, partIndex: number, library: readonly ExerciseRecord[], ctx: SuggestCtx): Array<{ libraryId: string; reason: string }>;  // ≤ 3
export type SuggestCtx = { activeProfiles: readonly ConditionProfile[]; day: DayContext | null; focusRefs: readonly string[]; recentIds: readonly string[]; pinned: readonly string[]; excluded: readonly string[]; equipment: readonly string[] };
export function quickStartDoc(kind: "condition_care" | "desk_reset" | "hip_opener", library: readonly ExerciseRecord[], ctx: SuggestCtx & { seed: number }): WorkoutDoc;
```
Rules: warm-up → warm-up / mobility moves for the main part's regions; activation → moves whose primary muscles are the main part's prime movers with purpose activation (glute activation before a hinge or squat); cool-down → stretch / mobility / passive moves for the regions the main part worked and the focus refs; care → the active profile's care moves; every suggestion passes the validator for the day (no errors), not already in the document, not excluded; rank by fit, novelty (not in `recentIds`), pins. Quick starts: condition care ≈ 5 min (recovery mode, care + passive), desk reset ≈ 8 min (desk-relief + posture), hip opener ≈ 10 min (hip-opening + focus refs); valid, within ± 2 min, varied by `seed`.

- [ ] Failing tests (glossary covers every id; search typo "gobelt" finds goblet squat; suggestions: a doc whose main part is a hinge gets a glute activation suggestion first; a cool-down after squats suggests quad / hip stretches; nothing suggested fails the validator on a flare day; quick starts validate clean for every kind and 20 seeds, minutes within range, two seeds differ) → implement → pass → commit `feat(studio): glossary, search with typo tolerance, part suggestions and quick starts`.

### Task 2: The document editor reducer

**Files:** `packages/workout/src/editor.ts`, test `packages/workout/test/editor.test.ts`.

**Produces:**
```ts
export type EditAction =
  | { type: "setTitle"; title: string } | { type: "setIntent"; intent: Partial<WorkoutDoc["intent"]> }
  | { type: "addPart"; purpose: PartPurpose; at?: number } | { type: "removePart"; part: number } | { type: "movePart"; part: number; to: number }
  | { type: "setPart"; part: number; patch: Partial<Omit<WorkoutPart, "items">> }
  | { type: "addItem"; item: WorkoutItem; part?: number }   // no part → the part its library purpose belongs to (spec §7), created if missing
  | { type: "removeItem"; part: number; item: number } | { type: "moveItem"; from: [number, number]; to: [number, number] }
  | { type: "setDose"; part: number; item: number; dose: WorkoutDose } | { type: "swapItem"; part: number; item: number; libraryId: string }
  | { type: "setCue"; part: number; item: number; cue: string | undefined };
export interface EditorState { doc: WorkoutDoc; past: WorkoutDoc[]; future: WorkoutDoc[] }   // history ≤ 20
export function newDoc(kind: "blank" | "structured", meta: { title: string; source: WorkoutDoc["source"] }): WorkoutDoc;   // structured = warm-up, main, cool-down (empty parts are allowed in drafts; `toProposable` drops them)
export function edit(state: EditorState, action: EditAction, library: readonly ExerciseRecord[]): EditorState;
export function undo(state: EditorState): EditorState; export function redo(state: EditorState): EditorState;
export function placementFor(record: ExerciseRecord): PartPurpose;   // spec §7 mapping
export function toProposable(doc: WorkoutDoc): WorkoutDoc | null;    // drops empty parts; null when nothing is left
```
- [ ] Failing tests per action (incl. placement mapping for every purpose; swap keeps dose shape when compatible and converts reps ↔ hold when the record's dose type differs; history bound 20; undo/redo) → implement → pass → commit `feat(workout): the document editor — actions, placement by purpose, undo`.

### Task 3: Server — create, revise, build from a document, templates

**Files:** `apps/worker/src/services/doc-workouts.ts`, `apps/worker/src/routes/workouts.ts` (extend the Stage 1 read routes' file), `apps/worker/src/routes/templates.ts`, the session build path (`apps/worker/src/services/session-build.ts` / the `/api/sessions/:id/build` and `/start` handlers), `packages/api-client/src/index.ts`; tests in `apps/worker/test/`.

**Produces:** `POST /api/workouts { date, time?, doc }` → `{ workout }` | 422 `{ issues }`; `PUT /api/workouts/:id/doc { doc, baseRev }` → `{ workout, rev, watchHasOlder: boolean }` | 409 `{ error: "stale_revision" | "not_editable" }`; build from document for document-origin rows (payload via `playerStepsFromDoc`, `workout_doc` snapshot) and **re-gate at Start** (validator with today's reading; a gated item swaps to its passing alternate, else 409 `{ error: "gated", issues }`); `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`, `POST /api/templates/:id/use`. Rows: follow exactly how `origin: on_demand` rows are created (plan row, calendar, watch behaviour) — origin `studio` or `template`. Service `createDocWorkout` / `reviseDocWorkout` is the one path the coach's approval (Stage 3) will reuse.
- [ ] Failing tests: create → row + rev 1 + revision row, category/minutes from `deriveDoc`; 422 on a fatal issue; revise → rev 2, revision row, `watchHasOlder` when pushed; stale base → 409; programme row → `not_editable`; completed row → `not_editable`; build from document equals `playerStepsFromDoc`; Start on a flare day swaps a gated item or refuses; templates CRUD user-scoped (another user's id → 404); budgets ≤ 45 each → implement → pass → commit `feat(studio): create and revise document workouts, build them for the player, and keep templates`.

**Batch 2A end:** gates; audit (correctness, budgets, Review Focus 1–3); fixes; re-review.

## Batch 2B — the Studio UI

### Task 4: The tab, the home, search and filters

**Files:** `packages/ui/src/shell.tsx` (NAV), `packages/ui/src/icons.tsx` (a Studio icon), `packages/ui/src/app.tsx` (routes), `packages/ui/src/screens/studio/home.tsx`, `studio/search.tsx`, `studio/filters-sheet.tsx`, `studio/move-row.tsx`, `packages/ui/src/components/tooltip.tsx`, `packages/ui/src/components/search-field.tsx`, styles in `styles.css` (a `/* Studio */` section, tokens only); tests in `packages/ui/test/studio-*.test.tsx`.
- Home per spec §3; results per §4–5; the wide treatment on `/studio*`; the coach composer slot rendered empty (Stage 3 fills it).
- [ ] Failing tests: NAV has five entries in order; `/studio` renders search, quick starts, browse, themes, tags; typing filters results (pure `searchLibrary` over the bundled library); a filter chip removes; the tooltip is a button with `aria-expanded` and closes on Escape; status words accompany every fit colour; the containment and responsive tests cover the new classes → implement → pass → commit `feat(studio): the Studio tab — search, browse by part, themes and tags, concise moves with tooltips`.

### Task 5: Move detail and Add

**Files:** `studio/move-detail.tsx`, `studio/add-sheet.tsx`, `packages/ui/src/studio-drafts.ts` (the current draft in IndexedDB, one at a time, via the existing `offline/idb.ts` pattern); tests.
- Detail per spec §6 (sheet on phones, right pane ≥ md); Add per §7 (targets: the current draft, an editable planned workout, a new workout, a template; Pin for programme sessions); confirmation line with Open and Undo.
- [ ] Failing tests (sections in order; condition note in plain words; Easier/Harder links; Add lands by purpose; programme sessions offer Pin only; Undo restores) → implement → pass → commit `feat(studio): move detail and the one small Add sheet`.

### Task 6: The builder

**Files:** `studio/builder.tsx`, `studio/item-sheet.tsx`, `studio/part-menu.tsx`, `studio/summary-card.tsx`, `studio/schedule-sheet.tsx`; tests.
- Per spec §8 on the Task 2 reducer: structured new workouts with suggestions in empty parts; item sheet (dose steppers, load as typed in the athlete's unit, per side, cue, swap: alternates → easier/harder → same purpose, move, remove); part menu; live summary (`deriveDoc`) and notes (`validateWorkoutDoc` with today's day context); errors block Start/Schedule with Fix; Save ▾ (template; revision for a planned workout with the stale-base message); Schedule (date default today, "Later today"); Start now (create for today → build → player).
- [ ] Failing tests (a new workout shows warm-up / main / cool-down with suggestions; adding a hinge surfaces a glute activation suggestion; a fatal issue disables Start with its reason and Fix swaps; Save as template calls the API; a stale revise shows the reload line; reordering by buttons) → implement → pass → commit `feat(studio): the builder — parts with suggestions, items, live summary and notes, save, schedule, start`.

### Task 7: Templates and quick starts

**Files:** `studio/templates.tsx`, quick-start cards on the home; tests.
- Per spec §9.
- [ ] Failing tests (list pinned first; open → builder; delete confirms; quick start → builder pre-filled with Start in reach; the condition-care card only with an active profile) → implement → pass → commit `feat(studio): templates and instant quick starts`.

### Task 8: Player — to max, alternates, cues

**Files:** `packages/ui/src/player/*` (timer, swap, step view), `packages/session-engine` recorder if the logged seconds are capped there; tests.
- [ ] Failing tests (a `max` hold counts up past target and logs actual seconds; swap lists alternates first; a cue renders under the name) → implement → pass → commit `feat(player): holds to max log the real time; swaps offer the planned alternates; cues show`.

### Task 9: Retire the old Studio; offline; e2e

**Files:** `packages/ui/src/screens/studio.tsx` (remove), `studio-modal.tsx` (remove the two Studio entries; keep coach plan detail and intake), `plan-brief.tsx` if only the old Studio used parts of it, CSS `studio-*` selectors no longer used, `apps/web/sw-routes.ts` (read cache adds `/api/templates` and `/api/workouts`), `apps/web/e2e/studio.spec.ts`; tests.
- Server routes and tables of the old Studio stay (dropping them needs the owner's OK); note it in the ledger for the morning report.
- [ ] Failing tests / specs: the plan modal still renders coach plan detail and intake without the Studio entries; e2e (iPhone + desktop): search → detail → Add → builder → Schedule → visible on Plan; quick start → Start now → player opens; template saved and reused; offline: search and detail work with the network off → implement → pass → commit `feat(studio): retire the old plan generator's screens; Studio reads cached offline; end-to-end journeys`.

**Batch 2B end:** gates + e2e; screenshot QA (light/dark; 320, 390, 768, 1280) reviewed by the lead; audit (spec §1–15 conformance, principles §7, accessibility, containment, privacy); fixes; re-review; deploy (no schema change); verify on prod in the browser.
