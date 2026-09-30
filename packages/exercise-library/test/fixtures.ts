import type { ExerciseInput } from "../src/index.js";

// Minimal valid exercise records for library tests (the standalone tests/fixtures.js, in the new shape).

export const TEXT = {
  summary: "Summary.", setup: ["Set up."], steps: ["Step one.", "Step two."], focus: ["Focus."],
  mistakes: ["Mistake."], breathing: "Breathe.", why: "Because.", conditions: { tmj: "Teeth apart." },
};

// Test records may be deliberately invalid, so overrides are loosely typed.
type Overrides = Record<string, unknown>;

export function ex(id: string, overrides: Overrides = {}): ExerciseInput {
  return {
    id, legacyIds: [], name: overrides.name ?? id, family: id,
    patterns: ["mobility"], regions: ["hips"], roles: ["mobility"],
    equipment: { all: [], oneOf: [] }, position: "standing", laterality: "bilateral", load: "none",
    dose: { type: "time", range: [30, 60] }, conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } }, difficulty: 1,
    easier: [], harder: [], text: TEXT, tags: [],
    ...overrides,
  } as unknown as ExerciseInput;
}

/** A loaded strength lift (kettlebell or dumbbells). */
export function lifted(id: string, overrides: Overrides = {}): ExerciseInput {
  return ex(id, {
    patterns: ["squat"], regions: ["quads"], roles: ["core", "accessory"],
    equipment: { all: [], oneOf: ["kettlebell", "dumbbells"] }, load: "external",
    dose: { type: "reps", range: [5, 8], sets: [2, 4], restSec: 60 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } }, difficulty: 2,
    ...overrides,
  });
}
