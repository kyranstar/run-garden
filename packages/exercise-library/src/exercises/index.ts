import type { ExerciseRecord } from "../record.js";
import { ATHLETIC } from "./athletic.js";
import { BREATH_DOWNSHIFT } from "./breath-downshift.js";
import { CORE_CARRY } from "./core-carry.js";
import { EXTRA_CORE } from "./extra-core.js";
import { EXTRA_JAW_NECK } from "./extra-jaw-neck.js";
import { EXTRA_MOBILITY } from "./extra-mobility.js";
import { EXTRA_PASS_TWO } from "./extra-pass-two.js";
import { EXTRA_STRENGTH } from "./extra-strength.js";
import { FLOWS } from "./flows.js";
import { JAW_NECK } from "./jaw-neck.js";
import { LOWER } from "./lower.js";
import { LOWER_LEG } from "./lower-leg.js";
import { LOWER_LIMB_GYM } from "./lower-limb-gym.js";
import { MOBILITY } from "./mobility.js";
import { UPPER } from "./upper.js";

/**
 * Every library record, in the standalone tool's load order (library order breaks ties in selection); later additions
 * go last, so the ties among the older records break as before.
 */
export const EXERCISES: readonly ExerciseRecord[] = [
  ...BREATH_DOWNSHIFT, ...JAW_NECK, ...MOBILITY, ...CORE_CARRY, ...LOWER, ...UPPER,
  ...EXTRA_JAW_NECK, ...EXTRA_MOBILITY, ...EXTRA_STRENGTH, ...EXTRA_CORE, ...EXTRA_PASS_TWO, ...ATHLETIC, ...FLOWS,
  ...LOWER_LEG, ...LOWER_LIMB_GYM,
];
