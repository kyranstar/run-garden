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

/** The muscles a record can name; each sits under one region (`MUSCLE_REGION`). */
export const MUSCLES = [
  "glute-max", "glute-med", "deep-hip-rotators", "hip-flexors", "adductors", "glute-min-tfl", "hamstrings", "quads",
  "gastrocnemius", "soleus", "tibialis", "peroneals", "feet-intrinsics", "rectus-abdominis", "obliques", "transverse-abdominis", "erector-spinae",
  "quadratus-lumborum", "thoracic-extensors", "lats", "rhomboids", "lower-traps", "upper-traps", "rotator-cuff",
  "deltoids", "pecs", "biceps", "triceps", "forearms", "deep-neck-flexors", "scalenes", "masseter", "temporalis",
  "pterygoids", "diaphragm", "suboccipitals", "sternocleidomastoid", "levator-scapulae", "serratus-anterior",
  "middle-traps", "multifidus", "pelvic-floor", "suprahyoids", "tongue",
] as const;
export type MuscleId = (typeof MUSCLES)[number];

/** Each muscle sits under one region (the anatomy view and region filters agree). */
export const MUSCLE_REGION: Record<MuscleId, Region> = {
  "glute-max": "glutes", "glute-med": "glutes", "deep-hip-rotators": "hips", "hip-flexors": "hips",
  adductors: "hips", "glute-min-tfl": "hips", hamstrings: "hamstrings", quads: "quads", gastrocnemius: "calves",
  soleus: "calves", tibialis: "ankles", peroneals: "ankles", "feet-intrinsics": "feet", "rectus-abdominis": "core", obliques: "core",
  "transverse-abdominis": "core", "erector-spinae": "low-back", "quadratus-lumborum": "low-back",
  "thoracic-extensors": "thoracic", lats: "lats", rhomboids: "upper-back", "lower-traps": "upper-back",
  "upper-traps": "upper-back", "rotator-cuff": "shoulders", deltoids: "shoulders", pecs: "chest", biceps: "arms",
  triceps: "arms", forearms: "arms", "deep-neck-flexors": "neck", scalenes: "neck", masseter: "jaw", temporalis: "jaw",
  pterygoids: "jaw", diaphragm: "core", suboccipitals: "neck", sternocleidomastoid: "neck", "levator-scapulae": "neck",
  "serratus-anterior": "shoulders", "middle-traps": "upper-back", multifidus: "low-back", "pelvic-floor": "core",
  suprahyoids: "jaw", tongue: "jaw",
};

/** `passive`: no deliberate effort against resistance: release, massage, rest, relaxed breathing, relaxed static stretch. */
export const CONTRACTIONS = ["isometric", "isotonic", "eccentric", "plyometric", "passive"] as const;
export type Contraction = (typeof CONTRACTIONS)[number];

export const PURPOSES = [
  "warmup", "activation", "strength", "power", "balance", "mobility", "stretch", "cooldown", "recovery",
  "condition-care", "conditioning",
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** A tag names what the other fields cannot; tags that echo a contraction, purpose or region (isometric-hold, eccentric-emphasis, balance, thoracic, ankle, core-stability) are used only when that quality is the defining point of the move. */
export const TAGS = [
  "posture", "ski", "hip-opening", "glute-activation", "single-leg", "landing", "deceleration", "anti-rotation",
  "desk-relief", "breath", "thoracic", "ankle", "balance", "rotational", "lateral", "grip", "core-stability",
  "elastic", "eccentric-emphasis", "isometric-hold",
] as const;
export type Tag = (typeof TAGS)[number];

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

/**
 * Implement classes, for curating a COROS mapping (`CorosMapping`, audit 3-A W-5). Kettlebell and dumbbells are ONE
 * class — a hand-held free weight; barbell, cable, machine and band are each their own.
 */
export const IMPLEMENT_CLASS = {
  kettlebell: "hand-held",
  dumbbells: "hand-held",
  barbell: "barbell",
  cable: "cable",
  machine: "machine",
  band: "band",
} as const satisfies Partial<Record<EquipmentId, string>>;

const LABELS: Record<string, string> = {
  squat: "Squats", hinge: "Hinging", lunge: "Lunges", carry: "Carries", rotate: "Rotation",
  mobility: "Mobility work", breathe: "Breathing", release: "Release work",
  "push-h": "Pushing", "push-v": "Overhead pressing", "pull-h": "Rows", "pull-v": "Vertical pulling",
  "anti-rotate": "Anti-rotation", "anti-extend": "Anti-extension", "anti-lateral": "Side-bend resistance",
  "upper-back": "Upper back", "low-back": "Low back", "full-body": "Full body",
  "glute-max": "Glute max", "glute-med": "Glute med", "deep-hip-rotators": "Deep hip rotators", "hip-flexors": "Hip flexors",
  "feet-intrinsics": "Foot muscles", "rectus-abdominis": "Rectus abdominis", "transverse-abdominis": "Deep abdominals",
  "quadratus-lumborum": "Quadratus lumborum", "thoracic-extensors": "Upper-back extensors", "lower-traps": "Lower traps",
  "upper-traps": "Upper traps", "middle-traps": "Middle traps", "rotator-cuff": "Rotator cuff",
  "deep-neck-flexors": "Deep neck flexors", "glute-min-tfl": "Glute min & TFL", "serratus-anterior": "Serratus",
  "pelvic-floor": "Pelvic floor", suprahyoids: "Jaw openers", "levator-scapulae": "Levator scapulae", "erector-spinae": "Erector spinae",
  warmup: "Warm-up", cooldown: "Cool-down", "condition-care": "Condition care",
  "hip-opening": "Hip opening", "glute-activation": "Glute activation", "single-leg": "Single-leg",
  "desk-relief": "Desk relief", "core-stability": "Core stability", "eccentric-emphasis": "Eccentric emphasis",
  "isometric-hold": "Isometric hold", "anti-rotation": "Anti-rotation",
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
  muscles: MUSCLES,
  contractions: CONTRACTIONS,
  purposes: PURPOSES,
  tags: TAGS,
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
