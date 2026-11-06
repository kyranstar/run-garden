import type { ExerciseRecord } from "./record.js";
import { label, MUSCLE_REGION, MUSCLES, REGIONS, type MuscleId, type Region } from "./vocab.js";

// An athlete's focus areas against the library: region and muscle ids, read one way by the day's build, the quick starts
// and the suggestions.

export const REGION_SET: ReadonlySet<string> = new Set<string>(REGIONS);
const MUSCLE_SET: ReadonlySet<string> = new Set<string>(MUSCLES);

/** Area words a reason reads better with than the chip's label. */
const AREA_WORDS: Readonly<Record<string, string>> = { thoracic: "upper spine", "full-body": "whole body" };

/** An area (region or muscle) in the words of a reason. */
export const areaWord = (id: string): string => AREA_WORDS[id] ?? label(id).toLowerCase();

/** Region and muscle ids among `ids`, each once, in order. */
export function focusIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => REGION_SET.has(id) || MUSCLE_SET.has(id));
}

/** The first focus area the move meets, or null: a region through its regions or a primary muscle under it, a muscle through its primary muscles. */
export function focusMet(rec: Pick<ExerciseRecord, "regions" | "muscles">, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (REGION_SET.has(id) && (rec.regions.includes(id as Region) || rec.muscles.primary.some((m) => MUSCLE_REGION[m] === id))) return id;
    if (MUSCLE_SET.has(id) && rec.muscles.primary.includes(id as MuscleId)) return id;
  }
  return null;
}
