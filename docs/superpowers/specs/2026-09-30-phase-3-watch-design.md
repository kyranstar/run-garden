# Phase 3 — Program sessions on the watch

Date: 2026-09-30
Status: design for Phase 3 of `2026-09-30-one-workout-system-design.md` (the authority; D4). The unmapped-move
strategy in §3 is chosen from the Phase 0 spike's report (`docs/reports/2026-09-30-coros-unmapped-spike.md`); the
variants below are written so the spike result selects one without redesign.

## 1. Scope

1. Library ↔ COROS mapping for every library exercise (curated for core lifts, computed otherwise, with confidence).
2. "Send to watch" for a built program or on-demand session: pre-check required, the build locks, a preview shows
   exactly what the watch will show, and a new write-job kind pushes it through the existing lane.
3. After a watch session: the COROS activity imports and matches the slot; the Today card asks for a quick review that
   logs weights, reps and the post-check (COROS sends none of them).
4. One physical session counted once: the app/COROS merge (the adoption path from Phase 0, with the Phase 2b rule that
   the app's title and discipline survive the refresh).

## 2. Mapping

- `providers.coros` on each library record: `{ originId, confidence: "exact" | "close" | "generic", method:
  "curated" | "computed" }`. Curated mappings (the core lifts, the most-used accessories) are written by hand against
  the English catalog names and reviewed; computed ones come from `resolveExerciseOriginId` with a stricter threshold
  (Jaccard ≥ 0.8, containment only when the catalog name adds no load-changing word). The catalog's `muscle[]`,
  `part[]` and `equipment[]` (kept since Phase 1) break ties and veto a mapping whose equipment contradicts the
  library record.
- A test asserts every curated mapping names an id present in the synced catalog snapshot fixture (ids only, which
  are public COROS catalog ids, not personal data).

## 3. Unmapped moves (chosen by the spike)

| Spike result | Strategy |
|---|---|
| A — COROS stores a free-text step name on `originId: "0"` and the watch shows it | Unmapped moves are `originId: "0"` steps with the library name and the cue in `overview`. |
| B — the name is replaced, but a generic catalog step (Training) keeps our `overview` and the watch shows it | Unmapped moves are generic Training steps; the watch shows "Training" with the move name and cue as the step note. The preview says so. |
| C — neither survives | Sessions with any unmapped move are phone/computer-only; "Send to watch" is disabled with the reason "N moves aren't in the watch's library". |

Whatever the result, timed holds use `targetType 2`, sets use reps, per-side moves become two steps with "each side"
in the overview, weights go in kg (COROS's only unit; the preview shows the athlete's unit beside it), tempo goes in
the overview, rests use the rest fields.

## 4. Send to watch

- `POST /api/sessions/:workoutId/send-to-watch` requires an answered pre-check, locks the build (as Start does), and
  enqueues `program_session_push` with the stamp `<program name> — <date>` (the coach stamp shape) and the built
  steps. The cloud executor creates the workout through the existing verified path (3 jobs per run, stamp
  uniqueness, read-back), stamps `planned_workouts` with the COROS address, and keeps `lastVerifiedCorosDate` semantics.
- The program fingerprint for this job kind includes step names and overviews (the existing fingerprint ignores
  them), so a COROS rename is detected and reported.
- The preview is computed from the same builder as the wire payload (one function, two renderings), listing each step
  exactly as the watch will show it.
- Moving or skipping a sent session uses the existing move/delete lanes; removing it unpushes (Ruling A1).

## 5. After the watch session

- The COROS activity matches the slot through `coros_plan_link` (the stamp/address).
- The Today card shows "Log your session" for a matched watch session without a performed session; the quick review
  is prefilled from the locked build's targets and the laps (one lap per step): weights, reps, holds, the post-check.
  Save writes a performed session with `source = 'watch_review'` linked to that activity (no new activity).
- If the athlete also used the phone player (an `app` activity exists), the merge applies and the quick review is not
  offered (the app session already has the sets).

## 6. Verification on the real account

The whole path is proven live on the owner's account before Phase 3 closes: push one session, read back twice (two
real reads, never the cached read-now), check the watch display once with the owner, complete it on the watch,
import, quick review, single counting in the garden and Activity. Never against the mock alone (it echoes bytes).
