// Controlled vocabularies for exercise records. Library validation rejects anything else.

export const PATTERNS = [
  "squat", "hinge", "lunge", "push-h", "push-v", "pull-h", "pull-v", "carry", "rotate", "anti-rotate", "anti-extend",
  "anti-lateral", "mobility", "breathe", "release",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const REGIONS = [
  "jaw", "neck", "upper-back", "thoracic", "shoulders", "chest", "lats", "arms", "core", "low-back", "hips", "glutes",
  "hamstrings", "quads", "calves", "ankles", "feet", "full-body",
] as const;
export type Region = (typeof REGIONS)[number];

export const ROLES = [
  "warmup", "activation", "core", "accessory", "finisher", "jaw-care", "mobility", "stretch", "downshift", "cooldown",
] as const;
export type Role = (typeof ROLES)[number];

export const POSITIONS = [
  "standing", "half-kneeling", "kneeling", "seated", "supine", "prone", "side-lying", "quadruped", "hanging",
] as const;
export type Position = (typeof POSITIONS)[number];

export const LATERALITY = ["bilateral", "unilateral", "alternating"] as const;
export type Laterality = (typeof LATERALITY)[number];

export const LOADS = ["external", "bodyweight", "none"] as const;
export type Load = (typeof LOADS)[number];

export const DOSE_TYPES = ["reps", "time", "breaths", "carry"] as const;
export type DoseType = (typeof DOSE_TYPES)[number];

export const EQUIPMENT_IDS = [
  "mat", "yoga-block", "kettlebell", "dumbbells", "bench", "chair", "wall", "towel", "band", "massage-ball",
  "foam-roller", "pull-up-bar", "cable", "barbell", "machine",
] as const;
export type EquipmentId = (typeof EQUIPMENT_IDS)[number];

export const MODE_IDS = ["recovery", "consistent", "build"] as const;
export type Mode = (typeof MODE_IDS)[number];

/** Session blocks, in play order. `care` is the cared-for condition's block (its content comes from the profile). */
export const BLOCK_IDS = ["arrive", "prep", "core", "accessory", "care", "cooldown"] as const;
export type BlockId = (typeof BLOCK_IDS)[number];

export const FORMAT_IDS = ["straight", "superset", "circuit", "ladder", "flow", "holds"] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

/** Implements whose weight gets logged. */
export const LOAD_IMPLEMENTS = ["kettlebell", "dumbbells", "barbell", "cable", "machine"] as const;
export type LoadImplement = (typeof LOAD_IMPLEMENTS)[number];

const LABELS: Record<string, string> = {
  squat: "Squats", hinge: "Hinging", lunge: "Lunges", carry: "Carries", rotate: "Rotation",
  mobility: "Mobility work", breathe: "Breathing", release: "Release work",
  "push-h": "Pushing", "push-v": "Overhead pressing", "pull-h": "Rows", "pull-v": "Vertical pulling",
  "anti-rotate": "Anti-rotation", "anti-extend": "Anti-extension", "anti-lateral": "Side-bend resistance",
  "upper-back": "Upper back", "low-back": "Low back", "full-body": "Full body",
};

/** A readable label for a pattern or region key. */
export const label = (key: string): string => LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

/** Floor positions flow into each other; standing and hanging are their own groups. */
export const positionGroup = (p: string): "standing" | "hanging" | "floor" =>
  p === "standing" ? "standing" : p === "hanging" ? "hanging" : "floor";

/** The standalone tool's `Vocab` object, for code that reads the vocabularies as lists. */
export const Vocab = {
  patterns: PATTERNS,
  regions: REGIONS,
  roles: ROLES,
  positions: POSITIONS,
  laterality: LATERALITY,
  loads: LOADS,
  doseTypes: DOSE_TYPES,
  equipment: EQUIPMENT_IDS,
  modes: MODE_IDS,
  blocks: BLOCK_IDS,
  loadImplements: LOAD_IMPLEMENTS,
  label,
  positionGroup,
} as const;
