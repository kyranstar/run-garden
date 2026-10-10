/**
 * A WORKOUT DOCUMENT'S WATCH STEPS (programme spec §3.3, Amendment A): the document → the steps the player plays
 * (`playerStepsFromDoc`, @rg/workout) → today's builder (`watchStepsFromBuild`). One builder per output (principles
 * §3.2): nothing here re-derives a watch rule, so the document and today's build path cannot disagree — the parity
 * test (watch-doc.test.ts) holds it for 50 seeded builds.
 *
 * It lives in the worker, not in @rg/workout, because today's builder does: the package cannot import the worker.
 * Moves the library cannot name (free-text items) and run segments play with no move id, and the watch walk skips
 * them, as it skips any step without a move; Stage 3's watch program for documents decides how they go.
 */
import type { WorkoutDoc } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { makeLibraryIndex, playerStepsFromDoc } from "@rg/workout";
import type { ExerciseSlice } from "./session-build.js";
import { watchStepsFromBuild, type WatchPlan, type WatchPlanDeps } from "./watch-push.js";

export function watchStepsFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[], deps: WatchPlanDeps): WatchPlan {
  const steps = playerStepsFromDoc(doc, library);
  const find = makeLibraryIndex(library);
  const exercises: Record<string, ExerciseSlice> = {};
  for (const s of steps) {
    if (!s.exerciseId || exercises[s.exerciseId]) continue;
    const record = find(s.exerciseId);
    if (!record) continue;
    const { providers: _providers, ...slice } = record;
    exercises[s.exerciseId] = slice;
  }
  return watchStepsFromBuild({ steps, exercises }, deps);
}
