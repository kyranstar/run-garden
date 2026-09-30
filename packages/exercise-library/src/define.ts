import type { ExerciseEquipment, ExerciseRecord } from "./record.js";

/** A record as written in the data files: the registry defaults may be left out. */
export type ExerciseInput = Omit<ExerciseRecord, "legacyIds" | "easier" | "harder" | "tags" | "equipment"> & {
  legacyIds?: readonly string[];
  easier?: readonly string[];
  harder?: readonly string[];
  tags?: readonly string[];
  equipment?: Partial<ExerciseEquipment>;
};

/** Fills the optional fields so every exported record is complete and the engine never sees undefined. */
export function defineExercises(list: readonly ExerciseInput[]): ExerciseRecord[] {
  return list.map(r => ({
    legacyIds: [], easier: [], harder: [], tags: [],
    ...r,
    equipment: { all: [], oneOf: [], ...(r.equipment ?? {}) },
  }));
}
