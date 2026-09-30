import type { ExerciseRecord } from "../record.js";
import { BREATH_DOWNSHIFT } from "./breath-downshift.js";
import { CORE_CARRY } from "./core-carry.js";
import { EXTRA_CORE } from "./extra-core.js";
import { EXTRA_JAW_NECK } from "./extra-jaw-neck.js";
import { EXTRA_MOBILITY } from "./extra-mobility.js";
import { EXTRA_STRENGTH } from "./extra-strength.js";
import { JAW_NECK } from "./jaw-neck.js";
import { LOWER } from "./lower.js";
import { MOBILITY } from "./mobility.js";
import { UPPER } from "./upper.js";

/** Every library record, in the standalone tool's load order (library order breaks ties in selection). */
export const EXERCISES: readonly ExerciseRecord[] = [
  ...BREATH_DOWNSHIFT, ...JAW_NECK, ...MOBILITY, ...CORE_CARRY, ...LOWER, ...UPPER,
  ...EXTRA_JAW_NECK, ...EXTRA_MOBILITY, ...EXTRA_STRENGTH, ...EXTRA_CORE,
];
