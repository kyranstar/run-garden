/** A personal move's record: built from an extracted move, then checked by the library's own validation (personal mode). */
import { describe, expect, it } from "vitest";
import { PROFILE_IDS } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import { toPersonalRecord, validatePersonalRecord } from "../src/services/personal-records.js";

const move = (over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name: "Dumbbell Row",
  aliases: [],
  summary: "Row the weight to your ribs.",
  steps: ["Hinge with a flat back.", "Row the weight to your ribs."],
  cues: ["Shoulders down"],
  mistakes: ["Shrugging"],
  purpose: "Wakes up the upper back.",
  dose: { text: "3 x 15" },
  patterns: ["pull-h"],
  regions: ["upper-back"],
  equipment: ["dumbbells"],
  position: "standing",
  laterality: "bilateral",
  load: "external",
  contraction: ["isotonic"],
  difficulty: 2,
  conditions: Object.fromEntries(PROFILE_IDS.map(p => [p, { attrs: { clench: 0, neckLoad: 1, faceDown: false }, note: "Easy on the jaw." }])) as unknown as ExtractedMove["conditions"],
  evidence: { name: "stated", dose: "inferred", steps: "stated" },
  confidence: "high",
  ...over,
});
const id = personalMoveId("Dumbbell Row", "salt");

describe("toPersonalRecord", () => {
  it("builds a record the personal validation accepts", () => {
    const rec = toPersonalRecord(id, move());
    expect(validatePersonalRecord(rec)).toEqual([]);
    expect(rec.id).toBe(id);
    expect(rec.family).toBe(id);
    expect(rec.themes).toEqual([]);
    expect(rec.tags).toEqual([]);
    expect(rec.muscles).toEqual({ primary: [], secondary: [] });
    expect(rec.providers?.coros).toBeUndefined();
    expect(rec.text.focus).toEqual(["Shoulders down"]);
    expect(rec.text.why).toBe("Wakes up the upper back.");
    expect(rec.text.conditions.tmj).toBe("Easy on the jaw.");
    expect(rec.conditions.tmj).toEqual({ clench: 0, neckLoad: 1, faceDown: false });
    expect(rec.equipment.all).toEqual(["dumbbells"]);
  });

  it("takes the dose from the draft, and defaults honestly when it has no type or range", () => {
    const given = toPersonalRecord(id, move({ dose: { text: "30 s", type: "time", range: [30, 45], sets: [2, 3] } }));
    expect(given.dose).toMatchObject({ type: "time", range: [30, 45], sets: [2, 3] });
    const bare = toPersonalRecord(id, move({ dose: { text: "a few" } }));
    expect(bare.dose.type).toBe("reps");
    expect(validatePersonalRecord(bare)).toEqual([]);
  });

  it("falls back to the summary when there is no purpose, and accepts empty cues and mistakes", () => {
    const rec = toPersonalRecord(id, move({ purpose: "", cues: [], mistakes: [] }));
    expect(rec.text.why).toBe(rec.text.summary);
    expect(validatePersonalRecord(rec)).toEqual([]);
  });

  it("a post naming a handle in its text is fine in a personal record", () => {
    expect(validatePersonalRecord(toPersonalRecord(id, move({ summary: "Shown by @someone." })))).toEqual([]);
  });
});

describe("validatePersonalRecord", () => {
  it("fails a record missing a profile rating", () => {
    const rec = toPersonalRecord(id, move());
    const broken = { ...rec, conditions: {} };
    expect(validatePersonalRecord(broken).some(i => i.includes("conditions.tmj is missing"))).toBe(true);
  });

  it("fails a record whose id is not a personal id", () => {
    expect(validatePersonalRecord(toPersonalRecord("squat", move())).some(i => i.includes("personal move id"))).toBe(true);
  });

  it("fails a draft with no steps or no patterns", () => {
    expect(validatePersonalRecord(toPersonalRecord(id, move({ steps: [] }))).length).toBeGreaterThan(0);
    expect(validatePersonalRecord(toPersonalRecord(id, move({ patterns: [] }))).length).toBeGreaterThan(0);
  });
});
