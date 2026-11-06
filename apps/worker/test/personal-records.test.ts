/** A personal move's record: built from an extracted move, then checked by the library's own validation (personal mode). */
import { describe, expect, it } from "vitest";
import { PROFILE_IDS, moveProblems } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import { buildPersonalRecord } from "../src/services/personal-moves.js";
import { doseFromText, PURPOSE_RULES, repairDraft, toPersonalRecord, validatePersonalRecord } from "../src/services/personal-records.js";

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

describe("a reading can't make the audit's mistakes", () => {
  const noWords = { dose: { text: "" } };
  const held = { ...noWords, contraction: ["passive" as const], load: "none" as const, equipment: [], patterns: ["mobility" as const] };

  it("a lopsided setup plays both sides, whatever the reading said", () => {
    for (const laterality of ["bilateral", "alternating"] as const) {
      const { draft, repairs } = repairDraft(move({ position: "half-kneeling", laterality, load: "bodyweight", equipment: [] }));
      expect(draft.laterality).toBe("unilateral");
      expect(repairs).toEqual([expect.stringContaining("half-kneeling")]);
    }
    expect(repairDraft(move({ position: "side-lying", laterality: "bilateral", load: "bodyweight", equipment: [] })).draft.laterality).toBe("unilateral");
  });

  it("steps that change sides make a bilateral reading one-sided; a symmetric move stays as it is", () => {
    const sided = repairDraft(move({ steps: ["Row the weight.", "Finish the reps, then switch sides."] }));
    expect(sided.draft.laterality).toBe("unilateral");
    expect(sided.repairs).toHaveLength(1);
    expect(repairDraft(move()).repairs).toEqual([]);
  });

  it("a one-sided move's steps reach the other side, without a second line when they already do", () => {
    const steps = toPersonalRecord(id, move({ laterality: "unilateral" })).text.steps;
    expect(steps.at(-1)).toBe("Repeat on the other side.");
    const said = ["Row the weight.", "Finish the reps, then switch sides."];
    expect(toPersonalRecord(id, move({ laterality: "unilateral", steps: said })).text.steps).toEqual(said);
  });

  it("an alternating move's line says the sides take turns, without saying it twice", () => {
    const line = (summary: string, laterality: "alternating" | "bilateral" = "alternating") => toPersonalRecord(id, move({ laterality, summary })).text.summary;
    expect(line("On your back, lower opposite arm and leg.")).toBe("On your back, lower opposite arm and leg, alternating sides.");
    expect(line("Glide the jaw side to side.")).toBe("Glide the jaw side to side.");
    expect(line("Stand tall and breathe.", "bilateral")).toBe("Stand tall and breathe.");
    // So the import has nothing left to flag about it.
    const record = toPersonalRecord(id, move({ laterality: "alternating", summary: "On your back, lower opposite arm and leg." }));
    expect(moveProblems(record).filter((p) => /take turns/.test(p))).toEqual([]);
  });

  it("no stated type: a hold or relaxed stretch runs on the clock, never 8-12 reps", () => {
    expect(toPersonalRecord(id, move(held)).dose).toEqual({ type: "time", range: [20, 40] });
    expect(toPersonalRecord(id, move({ ...held, contraction: ["isometric"] })).dose.type).toBe("time");
    expect(toPersonalRecord(id, move({ ...noWords, patterns: ["carry"] })).dose.type).toBe("carry");
    expect(toPersonalRecord(id, move(noWords)).dose).toEqual({ type: "reps", range: [8, 12] });
    // A logged weight on a clock is a carry, the timed type that takes a load: validation refuses `time` on one.
    const loaded = toPersonalRecord(id, move({ ...noWords, contraction: ["isometric"] }));
    expect(loaded.dose).toEqual({ type: "carry", range: [20, 40] });
    expect(validatePersonalRecord(loaded)).toEqual([]);
    const stated = repairDraft(move({ contraction: ["isometric"], dose: { text: "", type: "time", range: [20, 30] } }));
    expect(stated.draft.dose.type).toBe("carry");
    expect(stated.repairs).toEqual([expect.stringContaining("stored as carry")]);
    expect(validatePersonalRecord(toPersonalRecord(id, stated.draft))).toEqual([]);
  });

  it("a dose given only in words keeps the post's numbers instead of the default (the live moves' own words)", () => {
    expect(doseFromText("10-15 reps")).toEqual({ type: "reps", range: [10, 15] });
    expect(doseFromText("6-10 reps per side")).toEqual({ type: "reps", range: [6, 10] });
    expect(doseFromText("8-10 circles")).toEqual({ type: "reps", range: [8, 10] });
    expect(doseFromText("2–3 sets of 8–12 reps per side")).toEqual({ type: "reps", range: [8, 12], sets: [2, 3] });
    expect(doseFromText("8 reps × 3 sets")).toEqual({ type: "reps", range: [8, 8], sets: [3, 3] });
    // No unit named: the numbers count whatever the move counts, reps for a row and seconds for a stretch.
    expect(doseFromText("3 x 15")).toEqual({ range: [15, 15], sets: [3, 3] });
    expect(toPersonalRecord(id, move({ dose: { text: "3 x 15" } })).dose).toEqual({ type: "reps", range: [15, 15], sets: [3, 3] });
    expect(toPersonalRecord(id, move({ ...held, dose: { text: "3 x 15" } })).dose).toEqual({ type: "time", range: [15, 15], sets: [3, 3] });
    // "x" before a stated unit: its sets still count, and a weight is no count of anything.
    expect(doseFromText("3 x 30 s")).toEqual({ type: "time", range: [30, 30], sets: [3, 3] });
    expect(doseFromText("3 x 20 kg")).toEqual({ sets: [3, 3] });
    expect(doseFromText("15 sec × 3 sets")).toEqual({ type: "time", range: [15, 15], sets: [3, 3] });
    expect(doseFromText("30-60 seconds per foot")).toEqual({ type: "time", range: [30, 60] });
    expect(doseFromText("2 min")).toEqual({ type: "time", range: [120, 120] });
    expect(doseFromText("3-5 deep breaths per side")).toEqual({ type: "breaths", range: [3, 5] });
    expect(doseFromText("Perform 2-3 sets per leg")).toEqual({ sets: [2, 3] });
    expect(doseFromText("3-5 rounds of exhale holds")).toEqual({ sets: [3, 5] });
    expect(doseFromText("Hold stretch position")).toEqual({ type: "time" });
    // A number with another unit says nothing about the dose.
    expect(doseFromText("8–10 kg kettlebell")).toEqual({});
    expect(doseFromText("Daily for 7 days")).toEqual({});
    expect(doseFromText("As prescribed")).toEqual({});
  });

  it("reads a stated dose whole: decimals, NxMs, m:ss, a side's count (audit bug 3)", () => {
    expect(doseFromText("1.5 min")).toEqual({ type: "time", range: [90, 90] });
    expect(doseFromText("0.5 min")).toEqual({ type: "time", range: [30, 30] });
    expect(doseFromText("1-1.5 minutes")).toEqual({ type: "time", range: [60, 90] });
    expect(doseFromText("2x30s")).toEqual({ type: "time", range: [30, 30], sets: [2, 2] });
    expect(doseFromText("3x45 sec")).toEqual({ type: "time", range: [45, 45], sets: [3, 3] });
    expect(doseFromText("1:30 hold")).toEqual({ type: "time", range: [90, 90] });
    expect(doseFromText("10 each side")).toEqual({ range: [10, 10] });
    expect(doseFromText("8/side")).toEqual({ range: [8, 8] });
    expect(doseFromText("6-8 per leg")).toEqual({ range: [6, 8] });
    expect(doseFromText("45-60s")).toEqual({ type: "time", range: [45, 60] });
  });

  it("a record's dose knows where it came from: the reading's numbers, the post's words, or the default (audit bug 3)", () => {
    const from = (dose: ExtractedMove["dose"]) => {
      const built = buildPersonalRecord(id, move({ dose }));
      if (!built.ok) throw new Error(built.issues.join("; "));
      return built.doseOrigin;
    };
    expect(from({ text: "3 x 15", range: [15, 15] })).toBe("reading");
    expect(from({ text: "2x30s" })).toBe("post");
    expect(from({ text: "slowly, with control" })).toBe("default");
  });

  it("the words reach the record: the stated range, not 8-12; a stated hold on the clock, with or without a weight", () => {
    expect(toPersonalRecord(id, move({ dose: { text: "10-15 reps" } })).dose).toEqual({ type: "reps", range: [10, 15] });
    // The model's own range still wins over its words.
    expect(toPersonalRecord(id, move({ dose: { text: "10-15 reps", range: [6, 8] } })).dose.range).toEqual([6, 8]);
    // Seconds of a stated type: a timed carry takes them; a count asked for by type doesn't take a number of seconds.
    expect(toPersonalRecord(id, move({ dose: { text: "30 seconds", type: "carry" } })).dose).toEqual({ type: "carry", range: [30, 30] });
    expect(toPersonalRecord(id, move({ dose: { text: "30 seconds", type: "reps" } })).dose).toEqual({ type: "reps", range: [8, 12] });
    const loadedHold = toPersonalRecord(id, move({ dose: { text: "Hold stretch under load" }, contraction: ["passive", "isotonic"] }));
    expect(loadedHold.dose).toEqual({ type: "carry", range: [20, 40] });
    expect(validatePersonalRecord(loadedHold)).toEqual([]);
    expect(toPersonalRecord(id, move({ ...held, dose: { text: "Hold stretch position" } })).dose).toEqual({ type: "time", range: [20, 40] });
  });

  it("reps a post never stated for a relaxed hold become time; reps it did state stay, and get flagged", () => {
    const inferred = repairDraft(move({ ...held, dose: { text: "", type: "reps", range: [8, 12] } }));
    expect(inferred.draft.dose).toEqual({ text: "", type: "time" });
    expect(inferred.repairs).toEqual([expect.stringContaining("relaxed hold")]);
    const stated = move({ ...held, dose: { text: "10 reps", type: "reps", range: [10, 10] }, evidence: { name: "stated", dose: "stated", steps: "stated" } });
    expect(repairDraft(stated).draft.dose.type).toBe("reps");
    const built = buildPersonalRecord(id, stated);
    expect(built.ok && built.repairs).toEqual([expect.stringContaining("relaxed hold")]);
  });

  it("a slow rep's tempo and any-one-of gear reach the record", () => {
    const rec = toPersonalRecord(id, move({ dose: { text: "5 slow", type: "reps", range: [5, 5], secsPerRep: 10 }, equipment: [], equipmentOneOf: ["bench", "chair"], load: "bodyweight" }));
    expect(rec.dose.secsPerRep).toBe(10);
    expect(rec.equipment).toEqual({ all: [], oneOf: ["bench", "chair"] });
    // Any-one-of gear can carry the weight: it stays a logged load.
    expect(repairDraft(move({ equipment: [], equipmentOneOf: ["kettlebell", "dumbbells"] })).draft.load).toBe("external");
  });

  it("what repair can't settle flags the move and never loses the paid reading", () => {
    const vague = move({ position: "half-kneeling", laterality: "unilateral", load: "bodyweight", equipment: [], summary: "Half-kneel beside a wall and turn.", steps: ["Turn.", "Change sides."] });
    const built = buildPersonalRecord(id, vague);
    expect(built.ok).toBe(true);
    expect(built.ok && built.repairs).toEqual([expect.stringContaining("which knee")]);
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

describe("repairDraft: a weight counted in breaths (live finding, 2026-11-05)", () => {
  it("is stored as bodyweight with a note, never refused as 'external load needs reps or carry dosing'", () => {
    const draft = move({ load: "external", equipment: ["kettlebell"], dose: { text: "5 breaths", type: "breaths", range: [5, 5] } });
    const { draft: out, repairs } = repairDraft(draft);
    expect(out.load).toBe("bodyweight");
    expect(out.dose).toEqual(draft.dose);
    expect(repairs).toContain("a weight counted in breaths; stored as bodyweight (the app logs a weight on reps or a timed carry)");
    const built = buildPersonalRecord(id, draft);
    expect(built.ok).toBe(true);
  });
});
