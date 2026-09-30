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

export interface CorosMapping {
  originId: string;
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
