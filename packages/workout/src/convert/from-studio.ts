/**
 * An old Plan Studio session (`StudioSession`) → the workout document (programme spec §3.3).
 *
 * RULES
 * - One main part of straight sets, the exercises in order.
 * - An exercise: its COROS catalog id through `originIdToLibraryId` (exact mappings only) → a library item; else a
 *   free-text item by its name. sets, reps, restSeconds → restSec, note → cue; kilos → a load typed in kilos,
 *   bodyweight → bodyweight. Every catalog id is kept (the document names moves by the library, and the push needs
 *   the athlete's catalog id).
 * - The weekday is kept (the planned workout's date is the schedule); the title is the title and the intent's
 *   summary; the source is the Studio, effort maintain. No exercises → an open block of 45 minutes, kept.
 */
import type { StudioSession, WorkoutDoc, WorkoutDose, WorkoutItem } from "@rg/domain";
import { bounded, loadOfKg, openBlock, OPEN_BLOCK_NAME, type Converted, type KeptEntry } from "./shared.js";

export interface StudioMeta {
  /** The athlete's COROS catalog id → a library id where the mapping is exact, else null. */
  originIdToLibraryId: (id: string) => string | null;
}

/** An old Studio session's length when it names nothing (the Studio's own default brief). */
const DEFAULT_SECONDS = 45 * 60;

export function docFromStudioSession(session: StudioSession, meta: StudioMeta): Converted<WorkoutDoc> {
  const kept: KeptEntry[] = [{ at: "session", field: "weekday", value: session.weekday, why: "the planned workout's date is the schedule" }];
  const items: WorkoutItem[] = session.exercises.map((e, i) => {
    const at = `exercise ${i + 1}`;
    kept.push({ at, field: "originId", value: e.originId, why: "the document names moves by the library, not the athlete's COROS catalog" });
    const dose: WorkoutDose = {
      sets: e.sets,
      reps: e.reps,
      load: e.weight.type === "bodyweight" ? "bodyweight" : loadOfKg(e.weight.value),
      restSec: e.restSeconds,
    };
    const cue = e.note ? bounded(e.note, 160, kept, at, "note") : undefined;
    const libraryId = meta.originIdToLibraryId(e.originId);
    if (libraryId) return { kind: "exercise", libraryId, dose, ...(cue ? { cue } : {}) };
    return { kind: "free_exercise", name: bounded(e.name, 80, kept, at, "name"), dose, ...(cue ? { cue } : {}) };
  });
  if (items.length === 0) {
    kept.push({ at: "session", field: "exercises", value: [], why: "no exercises named: an open block stands in" });
    items.push(openBlock(OPEN_BLOCK_NAME, DEFAULT_SECONDS));
  }
  return {
    doc: {
      version: 1,
      title: session.title,
      intent: { summary: session.title, goals: [], focus: [], effort: "maintain" },
      parts: [{ purpose: "main", format: "straight", items }],
      source: { kind: "studio" },
    },
    kept,
  };
}
