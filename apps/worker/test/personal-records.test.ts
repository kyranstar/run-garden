/** A personal move's record: built from an extracted move, then checked by the library's own validation (personal mode). */
import { describe, expect, it } from "vitest";
import { PROFILE_IDS } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import { PURPOSE_RULES, repairDraft, toPersonalRecord, validatePersonalRecord } from "../src/services/personal-records.js";

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

/**
 * Purposes and roles come from how the post's move is done (final review I7; coach-context audit I1b): one table, a test
 * per row. Each case is a draft that row decides; the expected labels mirror the public library's own (a jaw or neck
 * move is condition-care / jaw-care; a mobility drill is mobility + warm-up; a relaxed stretch is a cool-down's).
 */
describe("purposes and roles, from the draft's patterns, contraction and load", () => {
  const unloaded = { load: "none" as const, equipment: [] as ExtractedMove["equipment"], dose: { text: "30 s", type: "time" as const, range: [20, 40] as [number, number] } };
  const cases: Array<{ rule: string; draft: Partial<ExtractedMove>; purposes: string[]; roles: string[] }> = [
    { rule: "jaw or neck care", draft: { ...unloaded, patterns: ["mobility"], regions: ["jaw"], contraction: ["isotonic"] }, purposes: ["condition-care", "mobility", "warmup"], roles: ["jaw-care", "mobility", "warmup"] },
    { rule: "plyometric", draft: { load: "bodyweight", equipment: [], patterns: ["squat"], regions: ["quads"], contraction: ["plyometric"] }, purposes: ["power"], roles: ["accessory"] },
    { rule: "external load", draft: {}, purposes: ["strength"], roles: ["accessory"] },
    { rule: "breath or release", draft: { ...unloaded, patterns: ["release"], regions: ["hips"], contraction: ["passive"] }, purposes: ["recovery", "cooldown"], roles: ["downshift", "cooldown"] },
    { rule: "relaxed stretch", draft: { ...unloaded, patterns: ["mobility"], regions: ["hamstrings"], contraction: ["passive"] }, purposes: ["stretch", "cooldown", "recovery"], roles: ["stretch", "cooldown", "downshift"] },
    { rule: "passive", draft: { ...unloaded, patterns: ["hinge"], regions: ["low-back"], contraction: ["passive"] }, purposes: ["recovery"], roles: ["downshift"] },
    { rule: "held stretch", draft: { ...unloaded, patterns: ["mobility"], regions: ["hips"], contraction: ["isometric"] }, purposes: ["mobility", "stretch"], roles: ["mobility", "stretch"] },
    { rule: "mobility drill", draft: { ...unloaded, patterns: ["mobility", "rotate"], regions: ["hips"], contraction: ["isotonic"] }, purposes: ["mobility", "warmup"], roles: ["mobility", "warmup"] },
    { rule: "trunk control", draft: { load: "bodyweight", equipment: [], patterns: ["anti-extend"], regions: ["core"], contraction: ["isometric"] }, purposes: ["activation", "strength"], roles: ["activation", "accessory"] },
    { rule: "primer", draft: { load: "none", equipment: [], patterns: ["hinge"], regions: ["glutes"], contraction: ["isotonic"] }, purposes: ["activation", "warmup"], roles: ["activation", "warmup"] },
    { rule: "bodyweight strength", draft: { load: "bodyweight", equipment: [], patterns: ["push-h"], regions: ["chest"], contraction: ["isotonic"] }, purposes: ["strength"], roles: ["accessory"] },
    { rule: "otherwise", draft: { load: "bodyweight", equipment: [], patterns: ["rotate"], regions: ["core"], contraction: ["isotonic"] }, purposes: ["conditioning"], roles: ["accessory"] },
  ];

  it("has one case here for every row of the table, in its order", () => {
    expect(cases.map(c => c.rule)).toEqual(PURPOSE_RULES.map(r => r.rule));
  });

  for (const c of cases) {
    it(`${c.rule}: ${c.purposes.join(", ")} → ${c.roles.join(", ")}`, () => {
      const rec = toPersonalRecord(id, move(c.draft));
      expect(rec.purposes).toEqual(c.purposes);
      expect(rec.roles).toEqual(c.roles);
      expect(validatePersonalRecord(rec)).toEqual([]);
    });
  }

  it("care rides beside the move's own labels: a passive neck release, a neck stretch", () => {
    const release = toPersonalRecord(id, move({ ...unloaded, patterns: ["release"], regions: ["neck"], contraction: ["passive"] }));
    expect(release.purposes).toEqual(["condition-care", "recovery", "cooldown"]);
    expect(release.roles).toEqual(["jaw-care", "downshift", "cooldown"]);
    const stretch = toPersonalRecord(id, move({ ...unloaded, patterns: ["mobility"], regions: ["neck", "shoulders"], contraction: ["passive"] }));
    expect(stretch.roles).toEqual(["jaw-care", "stretch", "cooldown", "downshift"]);
  });

  it("no care for a loaded neck move, or for a move that works the neck among other regions", () => {
    const shrug = toPersonalRecord(id, move({ patterns: ["carry"], regions: ["neck", "upper-back"] }));
    expect(shrug.purposes).toEqual(["strength"]);
    const child = toPersonalRecord(id, move({ ...unloaded, patterns: ["mobility"], regions: ["low-back", "hips", "neck"], contraction: ["passive"] }));
    expect(child.purposes).not.toContain("condition-care");
    expect(child.roles).not.toContain("jaw-care");
  });

  it("a bodyweight mobility drill (a lunge with a reach) is still mobility, not strength", () => {
    const rec = toPersonalRecord(id, move({ load: "bodyweight", equipment: [], patterns: ["lunge", "mobility", "rotate"], regions: ["hips"], contraction: ["isotonic"] }));
    expect(rec.purposes).toEqual(["mobility", "warmup"]);
    expect(rec.roles).toEqual(["mobility", "warmup"]);
  });

  it("a personal move is never a core lift", () => {
    for (const c of cases) expect(toPersonalRecord(id, move(c.draft)).roles).not.toContain("core");
  });
});

describe("repairDraft", () => {
  it("an external load with no loadable implement is stored as bodyweight, with a line saying so", () => {
    for (const equipment of [[], ["band"], ["bench", "wall"]] as ExtractedMove["equipment"][]) {
      const { draft, repairs } = repairDraft(move({ load: "external", equipment }));
      expect(draft.load).toBe("bodyweight");
      expect(repairs).toEqual(["load read as external with no loadable implement; stored as bodyweight"]);
      expect(validatePersonalRecord(toPersonalRecord(id, draft))).toEqual([]);
    }
  });

  it("leaves a loaded move with its implement, and a bodyweight move, alone", () => {
    expect(repairDraft(move({ load: "external", equipment: ["kettlebell"] }))).toEqual({ draft: move({ load: "external", equipment: ["kettlebell"] }), repairs: [] });
    expect(repairDraft(move({ load: "bodyweight", equipment: [] })).repairs).toEqual([]);
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
