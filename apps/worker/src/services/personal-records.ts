import {
  PROFILES, PROFILE_IDS, THEMES, defineExercises, validateRecord,
  type Dose, type DoseType, type ExerciseRecord, type Purpose, type Role,
 LOAD_IMPLEMENTS } from "@rg/exercise-library";
import { PERSONAL_ID_RE, type ExtractedMove } from "@rg/saves";

// A personal move: a move extracted from the owner's saved posts that the public library doesn't have, stored per
// account as an ExerciseRecord. It is built from the extraction's draft and held to the library's own validation
// (ratings and notes for every condition profile included), minus the public repository's provenance and id rules.

/** What a draft with no stated dose gets, by type: a plain, modest prescription the owner can change. */
const DEFAULT_RANGE: Readonly<Record<DoseType, readonly [number, number]>> = {
  reps: [8, 12], time: [20, 40], breaths: [5, 8], carry: [20, 40],
};

function doseOf(draft: ExtractedMove): Dose {
  const type: DoseType = draft.dose.type ?? "reps";
  const dose: Dose = { type, range: draft.dose.range ?? DEFAULT_RANGE[type] };
  return draft.dose.sets ? { ...dose, sets: draft.dose.sets } : dose;
}

type Pattern = ExtractedMove["patterns"][number];
type Region = ExtractedMove["regions"][number];

const any = (have: readonly string[], want: readonly string[]): boolean => have.some(x => want.includes(x));
const passive = (d: ExtractedMove): boolean => d.contraction.length > 0 && d.contraction.every(c => c === "passive");
/** Mobility work with no weight in the hands: a mobility drill (bodyweight too), or an unloaded rotation. */
const mobilityDrill = (d: ExtractedMove): boolean =>
  d.load !== "external" && (d.patterns.includes("mobility") || (d.load === "none" && d.patterns.includes("rotate")));
const TRUNK: readonly Pattern[] = ["anti-extend", "anti-rotate", "anti-lateral"];
const STRENGTH_PATTERNS: readonly Pattern[] = [
  "squat", "hinge", "lunge", "push-h", "push-v", "pull-h", "pull-v", "carry", "calf-raise", "toe-raise",
];
/** The regions a jaw or neck move may also name and still be care (the library's trap, levator and scalene stretches). */
const CARE_REGIONS: readonly Region[] = ["jaw", "neck", "upper-back", "shoulders", "thoracic"];
/** Jaw or neck work, alone and unloaded: what the library labels condition-care / jaw-care. */
const care = (d: ExtractedMove): boolean =>
  d.load !== "external" &&
  !d.contraction.includes("plyometric") &&
  (d.regions.includes("jaw") || (d.regions.includes("neck") && d.regions.every(r => CARE_REGIONS.includes(r))));

/** One row of the purpose table: the draft it decides, and the purposes it gives. */
export interface PurposeRule {
  readonly rule: string;
  readonly when: (d: ExtractedMove) => boolean;
  readonly purposes: readonly Purpose[];
  /** The row adds its purposes and the table reads on (care rides beside what the move does). */
  readonly adds?: true;
}

/**
 * The draft carries no purposes; they are read from how the move is done, mirroring the public library's labels (a
 * mobility drill is mobility + warm-up, a relaxed stretch a cool-down's, jaw and neck work condition-care). Read in
 * order: an `adds` row contributes and the table reads on; the first other row that matches decides. Passive moves keep
 * `recovery`.
 */
export const PURPOSE_RULES: readonly PurposeRule[] = [
  { rule: "jaw or neck care", when: care, purposes: ["condition-care"], adds: true },
  { rule: "plyometric", when: d => d.contraction.includes("plyometric"), purposes: ["power"] },
  { rule: "external load", when: d => d.load === "external", purposes: ["strength"] },
  { rule: "breath or release", when: d => any(d.patterns, ["breathe", "release"]), purposes: ["recovery", "cooldown"] },
  { rule: "relaxed stretch", when: d => passive(d) && d.patterns.includes("mobility"), purposes: ["stretch", "cooldown", "recovery"] },
  { rule: "passive", when: passive, purposes: ["recovery"] },
  { rule: "held stretch", when: d => mobilityDrill(d) && d.contraction.every(c => c === "isometric"), purposes: ["mobility", "stretch"] },
  { rule: "mobility drill", when: mobilityDrill, purposes: ["mobility", "warmup"] },
  { rule: "trunk control", when: d => any(d.patterns, TRUNK), purposes: ["activation", "strength"] },
  { rule: "primer", when: d => d.load === "none" && any(d.patterns, STRENGTH_PATTERNS), purposes: ["activation", "warmup"] },
  { rule: "bodyweight strength", when: d => any(d.patterns, STRENGTH_PATTERNS), purposes: ["strength"] },
  { rule: "otherwise", when: () => true, purposes: ["conditioning"] },
];

function purposesOf(draft: ExtractedMove): Purpose[] {
  const out: Purpose[] = [];
  for (const row of PURPOSE_RULES) {
    if (!row.when(draft)) continue;
    for (const p of row.purposes) if (!out.includes(p)) out.push(p);
    if (!row.adds) break;
  }
  return out;
}

const ROLE_OF: Partial<Record<Purpose, Role>> = {
  warmup: "warmup", activation: "activation", mobility: "mobility", stretch: "stretch", cooldown: "cooldown", recovery: "downshift",
  "condition-care": "jaw-care", strength: "accessory", power: "accessory", conditioning: "accessory", balance: "accessory",
};

/** The slots a personal move can fill, from its purposes. Never `core`: a saved move is not made a main lift. */
function rolesOf(purposes: readonly Purpose[]): Role[] {
  const roles = [...new Set(purposes.flatMap(p => ROLE_OF[p] ?? []))];
  return roles.length ? roles : ["accessory"];
}

/** The record for a personal move. It may not pass `validatePersonalRecord`: a draft that is missing something says so there. */
/**
 * Repairs a reading the library's rules would refuse where the fix is plain, instead of paying for a second extraction
 * that says the same (the first live night, 2026-10-26: "external load needs a loadable implement" cost a post two full
 * calls). Each repair is a line for the owner; a repaired move is flagged to check.
 */
export function repairDraft(draft: ExtractedMove): { draft: ExtractedMove; repairs: string[] } {
  const repairs: string[] = [];
  let out = draft;
  if (out.load === "external" && !out.equipment.some((e) => (LOAD_IMPLEMENTS as readonly string[]).includes(e))) {
    // Bands, a bench, a wall or nothing: not a load the app logs — the move counts as bodyweight.
    out = { ...out, load: "bodyweight" };
    repairs.push("load read as external with no loadable implement; stored as bodyweight");
  }
  return { draft: out, repairs };
}

export function toPersonalRecord(id: string, draft: ExtractedMove): ExerciseRecord {
  const purposes = purposesOf(draft);
  const conditions = Object.fromEntries(PROFILE_IDS.map(p => [p, { ...draft.conditions[p].attrs }]));
  const notes = Object.fromEntries(PROFILE_IDS.map(p => [p, draft.conditions[p].note]));
  return defineExercises([{
    id,
    name: draft.name,
    family: id,
    patterns: draft.patterns,
    regions: draft.regions,
    roles: rolesOf(purposes),
    equipment: { all: draft.equipment, oneOf: [] },
    position: draft.position,
    laterality: draft.laterality,
    load: draft.load,
    dose: doseOf(draft),
    difficulty: draft.difficulty,
    contraction: draft.contraction,
    muscles: { primary: [], secondary: [] },
    purposes,
    themes: [],
    text: {
      summary: draft.summary,
      setup: [],
      steps: draft.steps,
      focus: draft.cues,
      mistakes: draft.mistakes,
      breathing: "",
      why: draft.purpose.trim() ? draft.purpose : draft.summary,
      conditions: notes,
    },
    conditions,
  }])[0]!;
}

/** Every problem with a personal record as "<id>: <message>"; empty means it can be stored. */
export function validatePersonalRecord(rec: ExerciseRecord): string[] {
  return validateRecord(rec, {
    themes: THEMES, profiles: Object.values(PROFILES), knownIds: new Set(), mode: "personal", personalId: PERSONAL_ID_RE,
  });
}
