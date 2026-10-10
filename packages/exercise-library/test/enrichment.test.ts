import { describe, expect, test } from "vitest";
import { CONTRACTIONS, label, EXERCISES, MUSCLES, MUSCLE_REGION, PURPOSES, REGIONS, TAGS, THEMES, plyometricDay } from "../src/index.js";

// The curation to-do list: one test per record, each failure naming the record id and field.

describe("vocabularies", () => {
  test("MUSCLE_REGION covers every muscle and maps into REGIONS", () => {
    for (const m of MUSCLES) {
      expect(MUSCLE_REGION[m], `${m} has no region`).toBeTruthy();
      expect(REGIONS as readonly string[], `${m} maps to an unknown region`).toContain(MUSCLE_REGION[m]);
    }
    expect(Object.keys(MUSCLE_REGION).sort()).toEqual([...MUSCLES].sort());
  });

  test("no vocabulary has duplicate ids", () => {
    for (const list of [MUSCLES, CONTRACTIONS, PURPOSES, TAGS]) expect(new Set(list).size).toBe(list.length);
  });
});

describe("labels", () => {
  test("every hyphenated vocabulary id has a hand-written label (single words read fine capitalised)", () => {
    const fine = new Set(["single-leg", "anti-rotation"]); // read well as plain capitalisation
    const naive = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
    for (const id of new Set<string>([...MUSCLES, ...PURPOSES, ...TAGS, ...CONTRACTIONS])) {
      if (id.includes("-") && !fine.has(id)) expect(label(id), `${id} reads as its raw id`).not.toBe(naive(id));
    }
  });
});

const themeIds = THEMES.map(t => t.id);

describe("every record is curated", () => {
  for (const e of EXERCISES) {
    test(e.id, () => {
      const problems: string[] = [];
      const bad = (field: string, msg: string) => problems.push(`${e.id}.${field}: ${msg}`);
      const checkList = (field: string, list: readonly string[] | undefined, vocab: readonly string[], min: number) => {
        if (!list || list.length < min) return bad(field, `needs at least ${min}`);
        for (const v of list) if (!vocab.includes(v)) bad(field, `"${v}" is not in the vocabulary`);
      };
      checkList("contraction", e.contraction, CONTRACTIONS, 1);
      checkList("purposes", e.purposes, PURPOSES, 1);
      checkList("muscles.primary", e.muscles?.primary, MUSCLES, 1);
      checkList("muscles.secondary", e.muscles?.secondary ?? (e.muscles ? [] : undefined), MUSCLES, 0);
      checkList("tags", e.tags, TAGS, 0);
      checkList("themes", e.themes, themeIds, 0);
      if (e.text.summary.length > 90) bad("text.summary", `is ${e.text.summary.length} chars (max 90)`);
      if (e.muscles && ![...e.muscles.primary, ...e.muscles.secondary].some(m => (e.regions as readonly string[]).includes(MUSCLE_REGION[m]))) {
        bad("muscles", "no primary or secondary muscle sits in the record's regions");
      }
      for (const m of e.muscles?.primary ?? []) if (e.muscles!.secondary.includes(m)) bad("muscles", `"${m}" is in both primary and secondary`);
      for (const [field, list] of [["muscles.primary", e.muscles?.primary], ["muscles.secondary", e.muscles?.secondary], ["purposes", e.purposes], ["contraction", e.contraction], ["tags", e.tags], ["themes", e.themes]] as const) {
        if (list && new Set(list).size !== list.length) bad(field, "repeats an entry");
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("themes for the new tags", () => {
  test("skiPrep and athleticBase exist, are never recovery themes, and have records to draw on", () => {
    for (const id of ["skiPrep", "athleticBase"]) {
      const t = THEMES.find(x => x.id === id);
      expect(t, `${id} is missing`).toBeTruthy();
      expect(t!.modes, `${id} must not be a recovery theme`).not.toContain("recovery");
      expect(t!.modes.length).toBeGreaterThan(0);
      expect(EXERCISES.filter(e => (e.themes ?? []).includes(id)).length, `${id} has no records tagged with it`).toBeGreaterThanOrEqual(3);
    }
  });

  test("every tag a theme emphasises is a real tag that some record carries", () => {
    const carried = new Set<string>(EXERCISES.flatMap(e => e.tags));
    for (const t of THEMES) {
      for (const tag of Object.keys(t.emphasis.tags ?? {})) {
        expect(TAGS as readonly string[], `${t.id}: ${tag} is not a tag`).toContain(tag);
        expect(carried.has(tag), `${t.id}: no record carries "${tag}"`).toBe(true);
      }
    }
  });

  test("the themes the day's proposal must not pick are marked out of the rotation", () => {
    const studioOnly = ["skiPrep", "athleticBase", "plyoIntro"];
    for (const id of studioOnly) expect(THEMES.find(t => t.id === id)!.inRotation, id).toBe(false);
    for (const t of THEMES.filter(x => !studioOnly.includes(x.id))) expect(t.inRotation, t.id).not.toBe(false);
  });

  test("athleticBase is single-leg strength and a braced trunk, with no rotation work", () => {
    const t = THEMES.find(x => x.id === "athleticBase")!;
    expect(Object.keys(t.emphasis.patterns ?? {})).not.toContain("rotate");
    for (const id of ["pallofIsoHoldHalfKneel", "cablePallofPress", "bandPallofPress", "wallPallofHold", "birdDog", "slRdlReach", "slRdlKneeDrive"]) {
      expect(EXERCISES.find(e => e.id === id)!.themes, id).toContain("athleticBase");
    }
  });

  test("plyoIntro lands with its moves: never a recovery theme, and every move tagged with it is plyometric", () => {
    const t = THEMES.find(x => x.id === "plyoIntro");
    expect(t, "plyoIntro is missing").toBeTruthy();
    expect(t!.modes).not.toContain("recovery");
    const moves = EXERCISES.filter(e => e.themes.includes("plyoIntro"));
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const e of moves) expect(e.contraction, e.id).toContain("plyometric");
    // The jumping day: the only theme that emphasises plyometric work, and it weights no movement pattern.
    expect(THEMES.filter(x => plyometricDay(x)).map(x => x.id)).toEqual(["plyoIntro"]);
    expect(t!.emphasis.patterns ?? {}).toEqual({});
  });
});

// Task 5: a graded plyometric ladder, ski-specific moves and yoga flows.
const byId = (id: string) => EXERCISES.find(e => e.id === id);
const LADDER = [
  "landingStick", "snapDown", "pogoHop", "lineHopForwardBack", "lineHopLateral", "skaterBoundLow", "skaterBoundStick",
  "lateralHopStick", "broadJumpStick", "boxJumpStepDown", "dropLanding", "tuckJump",
];
const SKI = ["wallSitSingleLegShift", "singleLegBalanceReach", "nordicCurlAssisted", "lateralLungeToBalance", "skaterSquat", "stepDownHeelTap", "pallofIsoHoldHalfKneel"];
const FLOWS = ["hipOpeningFlow", "thoracicFlow", "downRegulationFlow", "skiHipFlow", "morningMobilityFlow"];

describe("the plyometric ladder", () => {
  const plyometric = EXERCISES.filter(e => e.contraction.includes("plyometric"));

  test("every rung exists, and the only plyometric moves are the ladder's", () => {
    for (const id of LADDER) expect(byId(id), id).toBeTruthy();
    expect(plyometric.map(e => e.id).sort()).toEqual([...LADDER].sort());
  });

  test("difficulty rises up the ladder: the landing drills first, the tuck jump alone at the top", () => {
    const d = LADDER.map(id => byId(id)!.difficulty);
    for (let i = 1; i < d.length; i++) expect(d[i], LADDER[i]).toBeGreaterThanOrEqual(d[i - 1]!);
    expect(byId("landingStick")!.difficulty).toBe(1);
    expect(byId("tuckJump")!.difficulty).toBe(5);
    expect(plyometric.filter(e => e.difficulty === 5).map(e => e.id)).toEqual(["tuckJump"]);
  });

  test("easier links point down and harder links up, so each family starts at its gentlest variant", () => {
    for (const e of plyometric) {
      for (const id of e.easier) expect(byId(id)!.difficulty, `${e.id} easier ${id}`).toBeLessThanOrEqual(e.difficulty);
      for (const id of e.harder) expect(byId(id)!.difficulty, `${e.id} harder ${id}`).toBeGreaterThanOrEqual(e.difficulty);
      const family = plyometric.filter(x => x.family === e.family);
      const gentlest = Math.min(...family.map(x => x.difficulty));
      if (e.difficulty > gentlest) expect(e.easier.some(id => family.some(x => x.id === id)), `${e.id} links down its family`).toBe(true);
    }
  });

  test("accessory work only (recovery has no accessory block), dosed in contacts with generous rest", () => {
    for (const e of plyometric) {
      expect(e.roles, e.id).toEqual(["accessory"]);
      expect(e.dose.type, e.id).toBe("reps");
      expect(e.dose.restSec ?? 0, e.id).toBeGreaterThanOrEqual(60);
      expect(e.load, e.id).toBe("bodyweight");
    }
  });

  test("honest jaw ratings: every jump clenches at least a little, the tuck jump and drop landing most", () => {
    for (const e of plyometric) {
      const r = e.conditions.tmj as { clench: number; neckLoad: number; faceDown: boolean };
      expect([1, 2], e.id).toContain(r.clench);
      expect(r.faceDown, e.id).toBe(false);
      expect(e.text.conditions.tmj, e.id).toMatch(/teeth apart, tongue up, soft landing/i);
    }
    expect(byId("tuckJump")!.conditions.tmj!.clench).toBe(2);
    expect(byId("dropLanding")!.conditions.tmj!.clench).toBe(2);
  });
});

describe("ski-specific moves and yoga flows", () => {
  test("the new ski moves exist and extend the existing families rather than duplicating them", () => {
    for (const id of SKI) expect(byId(id), id).toBeTruthy();
    // Already in the library: the wall sit, the split-squat hold and the short-lever Copenhagen plank.
    for (const id of ["isometricSplitSquatHold", "copenhagenPlankShort"]) expect(byId(id), id).toBeUndefined();
    expect(byId("wallSit")!.harder).toContain("wallSitSingleLegShift");
    expect(byId("wallSitSingleLegShift")!.family).toBe("wallSit");
    expect(byId("pallofIsoHoldHalfKneel")!.family).toBe("pallof");
    // The Nordic curl names the hamstring bridge as its easier move, but a core lift's "ready for the next" never
    // jumps to an accessory the block can't take.
    expect(byId("nordicCurlAssisted")!.easier).toContain("hamstringBridgeChair");
    expect(byId("hamstringBridgeChair")!.harder).not.toContain("nordicCurlAssisted");
    // The single-leg eccentric step-down leads into the skater squat.
    const heelTap = byId("stepDownHeelTap")!;
    expect(heelTap.family).toBe(byId("skaterSquat")!.family);
    expect(heelTap.contraction).toEqual(["isotonic", "eccentric"]);
    expect(heelTap.tags).toEqual(expect.arrayContaining(["ski", "single-leg"]));
    expect(heelTap.harder).toContain("skaterSquat");
    expect(byId("skaterSquat")!.easier).toContain("stepDownHeelTap");
    expect(byId("cossackSquat")!.easier).toContain("lateralLungeToBalance");
  });

  test("the flows move continuously, for mobility or recovery, with a quiet jaw", () => {
    for (const id of FLOWS) {
      const e = byId(id)!;
      expect(e, id).toBeTruthy();
      expect(e.contraction, id).toContain("isotonic");
      expect(e.purposes.some(p => p === "mobility" || p === "recovery"), id).toBe(true);
      expect(e.conditions.tmj, id).toEqual({ clench: 0, neckLoad: 0, faceDown: false });
    }
    expect(byId("skiHipFlow")!.text.steps.join(" ")).toMatch(/lizard[\s\S]*pigeon[\s\S]*90\/90/i);
  });
});
