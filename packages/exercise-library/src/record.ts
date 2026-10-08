import type { Attrs } from "./conditions/types.js";
import type { DoseType, EquipmentId, Laterality, Load, Pattern, Position, Region, Role } from "./vocab.js";

// The exercise record (programme spec §5.1). Condition ratings and notes are keyed by profile id.

export interface Dose {
  type: DoseType;
  /** [low, high]: reps, seconds, breaths, or carry seconds. */
  range: readonly [number, number];
  /** [min, max] working sets. */
  sets?: readonly [number, number];
  restSec?: number;
  secsPerRep?: number;
  /** Starting weight in kg when there's no history. */
  startKg?: number;
}

export interface ExerciseText {
  summary: string;
  setup: readonly string[];
  steps: readonly string[];
  focus: readonly string[];
  mistakes: readonly string[];
  breathing: string;
  why: string;
  /** A note per condition profile, keyed by profile id. */
  conditions: Readonly<Record<string, string>>;
}

/**
 * A library move's place in the COROS strength catalog (Phase 3, spec §2). Only `exact` is ever pushed; `close` and
 * `generic` stay on record and the move goes to the watch as free text (spike outcome A).
 *
 * CURATING ONE. `exact` means the same movement with the same implement CLASS (`IMPLEMENT_CLASS`): kettlebell and
 * dumbbells are one class, a hand-held free weight; barbell, cable, machine and band are each their own. So a row done
 * with a kettlebell or dumbbells is exact to COROS's "One Arm Dumbbell Row" (the watch may name a dumbbell for a
 * kettlebell set — same lift, and `exact` is what lets a lap pair by T-code), while our kettlebell-or-dumbbell deadlift
 * is only `close` to COROS's "Deadlifts" (the barbell lift) and a band face pull only `close` to its cable one. A COROS
 * name that names no implement ("Goblet Squat") is judged on the movement alone. Audit 3-A W-5; the library's
 * coros-mapping test holds every exact key whose COROS name names an implement to this rule.
 */
export interface CorosMapping {
  /** The COROS catalog T-code ("T1041") — what `coros_exercises.name` and a lap's `exerciseNameKey` carry. */
  key: string;
  confidence: "exact" | "close" | "generic";
  method: "curated" | "computed";
}

export interface ExerciseEquipment {
  all: readonly EquipmentId[];
  oneOf: readonly EquipmentId[];
}

export interface ExerciseRecord {
  /** Permanent camelCase id; history, prefs and blocks key on it. */
  id: string;
  /** Renames keep history. */
  legacyIds: readonly string[];
  name: string;
  family: string;
  patterns: readonly Pattern[];
  regions: readonly Region[];
  roles: readonly Role[];
  equipment: ExerciseEquipment;
  position: Position;
  laterality: Laterality;
  load: Load;
  dose: Dose;
  /** 1–5. */
  difficulty: number;
  easier: readonly string[];
  harder: readonly string[];
  tags: readonly string[];
  text: ExerciseText;
  /** Ratings per condition profile, keyed by profile id; each profile's attribute specs say what's inside. */
  conditions: Readonly<Record<string, Attrs>>;
  providers?: { coros?: CorosMapping };
}
