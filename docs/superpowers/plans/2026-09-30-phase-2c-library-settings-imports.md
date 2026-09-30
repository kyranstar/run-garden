# Phase 2c — Library, Settings and Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse and tune the exercise library; manage health conditions, places and equipment, weight units and the wishlist; import the standalone tool's backup and the private saved-post provenance; grow the library from the owner's saves.

**Architecture:** Library routes over `@rg/exercise-library` + `exercise_prefs`/`exercise_provenance`; settings routes over `user_conditions`/`locations`/prefs; a zod-validated, idempotent standalone import; a local provenance builder script whose output file is imported through Settings; a curation pass that produces public library records and private provenance.

**Tech Stack:** Hono/D1/zod, React/TanStack Query, vitest, Node scripts (`.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-30-phase-2-adaptive-program-design.md` §2c. Mocks §3, §6–7: https://claude.ai/artifact/7TTG8ua9pxUVPaCpbQWy6Z.

## Global Constraints

- The public repo never receives saved-post URLs, creator handles, post codes, captions or health data — not in code, tests, fixtures, commit messages or reports. The provenance builder reads its inputs from command-line paths and writes its output outside the repo. A test greps the library package and the import fixtures for URLs/handles.
- The standalone import's fixtures are synthetic (built from the standalone repo's synthetic `tests/fixtures.js` shapes, never from a real backup).
- Imports are idempotent: sessions merge by `(user, 'import', source_ref)`; first-import-only fields never overwrite later local edits.
- Imported history never enters the garden (P8; the gate lands in 2d — until then the importer is not reachable from the UI).
- UI rules as 2a.

## Review Focus

1. **A backup exported from the standalone tool twice a week apart** — the second import adds only the new sessions and changes nothing else. Task 4.
2. **A v1 (pass-1) session with legacy exercise ids and `bilateral: true`** — resolves to canonical ids, per-side volume counted ×2, `plan.phase === "flare"` → recovery. Task 4.
3. **A weight list typed as "10, 15, 20 lb, 12kg"** — stored as typed, each parsed in its own unit, displayed as typed. Task 3.
4. **Excluding a move that is a block's core lift** — the next build resolves the family to another variant, and the block records the rotation with a reason. Task 1.
5. **Turning a condition off and on again** — `since` keeps the original date; rules apply only while active. Task 2.

---

### Task 1: Library API and prefs

**Files:** create `apps/worker/src/routes/library.ts`, `apps/worker/src/services/library-view.ts`; api-client `listLibrary`, `getLibraryItem`, `setExercisePrefs`; tests `apps/worker/test/library-routes.test.ts`.

Spec §2c "Library API": slim list with filters (`q`, pattern, region, role, equipment, location, safe-for-active-profiles), item detail (full text, dose, active profiles' notes and ratings, easier/harder with names, provenance link when saved, the user's last 5 entries and best), prefs write (`rating ±1|null`, `excluded`, `pinned`), wishlist unlock counts (moves that become eligible at the default place if the item is added).

- [ ] Failing tests incl. Review Focus 4 (excluding a core lift → next build resolves another variant; block rotation recorded "not for me"); implement; gates; commit `feat(library): browse, detail and preferences`.

### Task 2: Conditions, places, units and wishlist — the server

**Files:** create `apps/worker/src/routes/conditions.ts`, `apps/worker/src/routes/places.ts`; modify prefs handling for `weightUnit`/`equipmentWishlist`; tests.

- [ ] `GET/PUT /api/conditions` (profiles from the library registry with `active`, `since`; PUT toggles; Review Focus 5 — `since` preserved on re-activation, rules off while inactive).
- [ ] `GET/POST/PATCH/DELETE /api/places` (name, equipment ids validated against the vocabulary, implements as typed lists validated by `parseWeightList`, one default; deleting the default promotes another; a place referenced by a program's `defaultLocationId` cannot be deleted — 409 naming the program).
- [ ] Failing tests; implement; gates; commit `feat(settings): health conditions, places and equipment — the server`.

### Task 3: Settings UI

**Files:** modify `packages/ui/src/screens/settings.tsx` (cards: Health conditions, Places & equipment, Units gains Weights lb/kg, Import); create `packages/ui/src/components/place-sheet.tsx`; tests.

Per mocks §7. Review Focus 3 (the implement list round-trips exactly as typed).

- [ ] Failing tests; implement; screenshot matrix; gates; commit `feat(ui): health conditions, places, weights and import in Settings`.

### Task 4: The standalone import

**Files:** create `apps/worker/src/services/standalone-import.ts`, `packages/domain/src/standalone-backup.ts` (zod schema for the backup: v2 and v1 sessions), route `POST /api/import/standalone` (+ `?dryRun=1` for the summary sheet); tests `apps/worker/test/standalone-import.test.ts` with synthetic backups.

Spec §2c "Standalone import" exactly, including the oracle numbers in the response (session count, sessions per week for the last 8 weeks, weekly volume for the last 8 weeks with per-side ×2, best set per core lift, records count, pre/post pair count, block number and week) and the first-import-only fields.

- [ ] Failing tests: v2 sessions → performed_sessions/sets/checks/activities (`source = 'import'`, no match, weights as typed + kg); v1 normalisation (Review Focus 2); invalid sessions reported and skipped; re-import idempotent and additive (Review Focus 1); program + block + places + prefs + condition + weightUnit + wishlist on first import only; dry run writes nothing and returns the same summary; oracle numbers equal the standalone `Stats`/`Records` computed over the same synthetic backup (port the standalone `stats.test.js` expectations as the oracle test).
- [ ] Implement; gates; commit `feat(import): the standalone tool's backup, idempotently, with oracle numbers`.

### Task 5: Import UI

**Files:** the Settings → Import rows; a summary sheet per mocks §7 (dry-run numbers, "History stays out of the garden", Import); a result sheet with the oracle numbers side by side for the owner to compare against the standalone Progress tab; tests.

- [ ] Failing tests; implement; screenshot matrix; gates; commit `feat(ui): import the standalone backup from Settings`.

### Task 6: Provenance builder and import

**Files:** create `apps/worker/scripts/build-provenance.mjs` (args: `--library <standalone data/exercises dir> --saves <saves exercises.json> --out <path outside the repo>`; reads each standalone record's `sources` (`type`, `url`, `creator`, `key`) and writes `{format:"rg-provenance", version:1, items:[{exerciseId, sourceType, url, creator, sourceKey}]}`; refuses an `--out` inside the repo); route `POST /api/import/provenance` upserting `exercise_provenance` by `(user, source_type, source_key)`; the Settings "Saved-post links…" row; tests with a synthetic provenance file.

- [ ] Failing tests (route idempotence; script refuses an in-repo `--out`; the script's own test uses synthetic temp files); implement; gates; commit `feat(import): saved-post links, built locally and imported privately`.

### Task 7: Library growth from saves (content)

**Files:** new records in `packages/exercise-library/src/exercises/*.ts` (public text only); nothing else committed. The shortlist (names, proposed tags, TMJ ratings, reasons, and the private save references) is written to the scratchpad and published to the owner as a PRIVATE artifact for review; accepted moves become records; their provenance goes into the provenance file (Task 6), never the repo.

- [ ] Curate from the saves catalogue's strength, mobility, posture and general-fitness moves (flagged-for-review posts excluded) with the standalone import rules (programme spec §5.4); write each accepted move in the library's own words with every field, all profiles rated, and condition notes.
- [ ] `validateLibrary` passes; coverage tests pass; the no-provenance test passes; the engine simulation still passes its properties.
- [ ] Commit `feat(library): N new moves` (N, not names of sources).

## Self-Review

- Spec §2c coverage: library API (1), settings server (2) + UI (3), standalone import (4) + UI (5), provenance (6), library growth (7).
- The importer stays unreachable from the UI until the 2d garden gate is merged (Task 5 renders only when `features.import` is true; flipped in 2d).
