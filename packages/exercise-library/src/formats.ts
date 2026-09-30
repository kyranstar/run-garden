import type { DoseType, FormatId, Laterality, Load, Role } from "./vocab.js";

// How a group of exercises is run. The builder only puts an exercise into a format that accepts it.
// Condition caps (how much bracing a format tolerates) live in the condition profiles, not here.

export interface Format {
  id: FormatId;
  name: string;
  roles: readonly Role[];
  loads: readonly Load[];
  doseTypes: readonly DoseType[];
  laterality?: readonly Laterality[];
  /** [min, max] exercises in one group. */
  count: readonly [number, number];
  workSec?: number;
  restSec?: number;
  rounds?: readonly [number, number];
  roundRestSec?: number;
  rungs?: readonly number[];
}

export const FORMATS: readonly Format[] = [
  { id: "straight", name: "Straight sets", roles: ["core", "accessory"], loads: ["external", "bodyweight"], doseTypes: ["reps", "carry", "time"], count: [1, 2] },
  { id: "superset", name: "Superset", roles: ["core", "accessory"], loads: ["external", "bodyweight"], doseTypes: ["reps"], count: [2, 2] },
  { id: "circuit", name: "Circuit", roles: ["accessory", "finisher"], loads: ["bodyweight", "none"], doseTypes: ["reps", "time"], laterality: ["bilateral", "alternating"], count: [3, 4], workSec: 40, restSec: 20, rounds: [2, 3], roundRestSec: 45 },
  { id: "ladder", name: "Ladder", roles: ["accessory", "finisher"], loads: ["bodyweight", "external"], doseTypes: ["reps"], count: [1, 2], rungs: [2, 4, 6, 8], restSec: 20 },
  { id: "flow", name: "Flow", roles: ["mobility", "stretch", "downshift", "jaw-care", "warmup", "activation", "cooldown"], loads: ["none", "bodyweight"], doseTypes: ["time", "breaths", "reps"], count: [1, 12] },
  { id: "holds", name: "Holds", roles: ["stretch", "jaw-care", "downshift", "mobility", "warmup", "activation", "cooldown"], loads: ["none", "bodyweight"], doseTypes: ["time", "breaths", "reps"], count: [1, 12] },
];
