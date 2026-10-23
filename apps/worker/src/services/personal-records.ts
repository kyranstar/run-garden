import {
  PROFILES, PROFILE_IDS, THEMES, defineExercises, validateRecord,
  type Dose, type DoseType, type ExerciseRecord, type Purpose, type Role,
} from "@rg/exercise-library";
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

/** The draft carries no purposes; read one from how the move is done. */
function purposesOf(draft: ExtractedMove): Purpose[] {
  if (draft.contraction.length && draft.contraction.every(c => c === "passive")) return ["recovery"];
  return [draft.load === "external" ? "strength" : "conditioning"];
}

const ROLE_OF: Partial<Record<Purpose, Role>> = {
  warmup: "warmup", activation: "activation", mobility: "mobility", stretch: "stretch", cooldown: "cooldown", recovery: "downshift",
};

function rolesOf(purposes: readonly Purpose[]): Role[] {
  const roles = [...new Set(purposes.flatMap(p => ROLE_OF[p] ?? []))];
  return roles.length ? roles : ["accessory"];
}

/** The record for a personal move. It may not pass `validatePersonalRecord`: a draft that is missing something says so there. */
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
