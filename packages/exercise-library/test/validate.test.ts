import { describe, expect, test } from "vitest";
import {
  BLOCK_IDS, EXERCISES, EQUIPMENT_IDS, LOCATION_PRESETS, MODE_IDS, TMJ, defineExercises, hasEquipment, makeEngineData, validateLibrary,
  type EngineData, type ExerciseRecord,
} from "../src/index.js";
import { ex, lifted } from "./fixtures.js";

// Ported from the standalone tests/data.test.js (all but the coverage loop) and tests/engine-validate.test.js.

const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
const get = (id: string): ExerciseRecord | undefined => EXERCISES.find(x => x.id === id || x.legacyIds.includes(id));
const withExercises = (exercises: readonly ExerciseRecord[]): EngineData => ({ ...data, exercises });

const PASS1_IDS = ["breath", "chinTuck", "jawOpen", "jawMassage", "legsUp", "finalJaw", "childBlock", "childHands", "thoracicBlock", "thoracicTowel", "catCow", "threadNeedle", "lowLungeBlock", "lowLunge", "puppyBlock", "puppyFloor", "blockSideBend", "seatedSideBend", "supineTwist", "hingeDrill", "bridgeBlock", "bridge", "plankBlock", "inclinePlank", "sidePlankKnees", "deadlift", "rdl", "gobletSquat", "splitSquat", "supportedRow", "chestSupportedRow", "floorPress", "suitcaseCarry", "suitcaseMarch", "tempoSquat", "bwSplitSquat", "slRdlReach", "singleLegBridge", "proneYTW", "inclinePushup", "deadBug"];

describe("the real library (data.test.js)", () => {
  test("the library validates cleanly", () => {
    expect(validateLibrary(data)).toEqual([]);
  });

  test("the library has about 70 exercises and keeps every pass-1 id", () => {
    expect(EXERCISES.length).toBeGreaterThanOrEqual(65);
    expect(EXERCISES.length).toBe(159);
    for (const id of PASS1_IDS) expect(get(id), `missing pass-1 id ${id}`).toBeTruthy();
  });

  test("text follows the contract", () => {
    for (const e of EXERCISES) {
      expect(e.text.summary.length, `${e.id}: summary is ${e.text.summary.length} chars`).toBeLessThanOrEqual(120);
      expect(e.text.steps.length, `${e.id}: needs at least 2 steps`).toBeGreaterThanOrEqual(2);
    }
  });

  test("instructions agree with how the timer runs sides", () => {
    for (const e of EXERCISES) {
      const text = [e.text.summary, ...e.text.setup, ...e.text.steps].join(" ");
      expect(/halfway/i.test(text), `${e.id}: timer splits sides, so "halfway" contradicts it`).toBe(false);
      if (e.laterality === "bilateral") expect(/(switch sides|other side|switch hands)/i.test(text), `${e.id}: bilateral but asks to switch sides`).toBe(false);
    }
    const scm = get("scmStretch")!.text.steps.join(" ");
    expect(scm, "SCM stretch should turn toward the stretched side").toMatch(/toward the (side|stretched side)/i);
  });

  test("wishlist equipment unlocks moves that are otherwise hidden", () => {
    const home = LOCATION_PRESETS.find(l => l.id === "home")!.equipment;
    const withBall = [...home, "massage-ball", "band"];
    const count = (eq: readonly string[]) => EXERCISES.filter(e => hasEquipment(e, eq)).length;
    expect(count(withBall)).toBeGreaterThan(count(home));
  });
});

describe("validation (engine-validate.test.js)", () => {
  const validLib = defineExercises([ex("a"), lifted("b", { harder: ["c"] }), lifted("c", { easier: ["b"], difficulty: 3 })]);

  test("a valid fixture library has no errors", () => {
    const errors = validateLibrary(withExercises(validLib), { presets: [] });
    expect(errors.filter(e => !e.startsWith("theme") && !e.startsWith("format"))).toEqual([]);
  });

  test("validation reports each kind of mistake", () => {
    const exercises = defineExercises([
      ex("Bad-Id"),
      ex("dupe"), ex("dupe"),
      ex("vocab", { patterns: ["jump"], regions: ["toes"], roles: ["hero"], position: "floating", laterality: "both", load: "heavy" }),
      ex("gear", { equipment: { all: ["spaceship"], oneOf: [] } }),
      ex("dose", { dose: { type: "reps", range: [10, 5], sets: [3, 1] } }),
      ex("loaded", { load: "external", dose: { type: "time", range: [30, 60] } }),
      ex("coreNoLog", { roles: ["core"], load: "none" }),
      ex("jaw", { conditions: { tmj: { clench: 4, neckLoad: 0 } } }),
      ex("diff", { difficulty: 9 }),
      ex("text", { text: { summary: "", steps: [] } }),
      ex("links", { harder: ["ghost"], easier: ["links"] }),
    ]);
    const errors = validateLibrary(withExercises(exercises), { presets: [] }).join("\n");
    for (const expected of [
      "Bad-Id: id must be camelCase",
      "dupe: duplicate id",
      'vocab: pattern "jump"', 'vocab: region "toes"', 'vocab: role "hero"', 'vocab: position "floating"', 'vocab: laterality "both"', 'vocab: load "heavy"',
      'gear: equipment "spaceship"',
      "dose: dose.range", "dose: dose.sets",
      "loaded: external load needs reps or carry dosing", "loaded: external load needs a loadable implement",
      "coreNoLog: core lifts must be logged",
      "jaw: conditions.tmj.clench must be 0–3", "jaw: conditions.tmj.faceDown must be true or false",
      "diff: difficulty must be 1–5",
      "text: text.summary is required", "text: text.steps needs at least one line", "text: text.conditions.tmj is required",
      'links: harder link "ghost" does not exist', "links: links to itself",
    ]) {
      expect(errors.includes(expected), `missing: ${expected}\n---\n${errors}`).toBe(true);
    }
  });

  test("a theme emphasising a contraction outside the vocabulary is refused", () => {
    const bad = { ...data, themes: [...data.themes, { ...data.themes[0]!, id: "badContractions", emphasis: { contractions: { bouncy: 1 } as never } }] };
    expect(validateLibrary(bad, { presets: [] })).toContain('theme badContractions: contraction "bouncy" is not in the vocabulary');
  });

  test("a theme emphasising a tag outside the vocabulary is refused", () => {
    const bad = { ...data, themes: [...data.themes, { ...data.themes[0]!, id: "badTags", emphasis: { tags: { bogusTag: 1 } } }] };
    expect(validateLibrary(bad, { presets: [] })).toContain('theme badTags: tag "bogusTag" is not in the vocabulary');
  });

  test("the real formats, themes, and location presets are valid", () => {
    const errors = validateLibrary(data).filter(e => e.startsWith("theme ") || e.startsWith("format "));
    expect(errors).toEqual([]);
    expect(LOCATION_PRESETS.map(l => l.id)).toEqual(["home", "gym", "mat"]);
    for (const loc of LOCATION_PRESETS) for (const i of loc.equipment) expect(EQUIPMENT_IDS.includes(i), `${loc.id}: ${i}`).toBe(true);
    for (const [block, spec] of Object.entries(data.skeleton.blocks)) {
      expect((BLOCK_IDS as readonly string[]).includes(block)).toBe(true);
      for (const f of spec?.formats ?? []) expect(data.formats.some(x => x.id === f), `${block}: ${f}`).toBe(true);
    }
    expect(data.themes.filter(t => t.modes.includes("recovery")).length).toBeGreaterThanOrEqual(2);
    for (const mode of MODE_IDS) expect(data.themes.some(t => t.modes.includes(mode)), mode).toBe(true);
  });
});

describe("the curation fields are required and consistent", () => {
  const base = get("gobletSquat")!;
  const errorsFor = (patch: Record<string, unknown>) =>
    validateLibrary(withExercises([{ ...base, id: "probe", ...patch } as ExerciseRecord]), { presets: [] }).filter(e => e.startsWith("probe:") && !e.includes(" link "));

  test("a record missing any curation field is refused", () => {
    for (const field of ["contraction", "muscles", "purposes", "themes"]) {
      expect(errorsFor({ [field]: undefined }).length, field).toBeGreaterThan(0);
    }
    expect(errorsFor({ contraction: undefined })).toContain("probe: contraction needs at least 1");
    expect(errorsFor({ muscles: undefined })).toContain("probe: muscles.primary needs at least 1");
    expect(errorsFor({ purposes: undefined })).toContain("probe: purposes needs at least 1");
    expect(errorsFor({ themes: undefined })).toContain("probe: themes must be a list");
  });

  test("a muscle in both primary and secondary, or a repeat in any list, is refused", () => {
    expect(errorsFor({ muscles: { primary: ["quads"], secondary: ["quads", "glute-max"] } })).toContain('probe: muscle "quads" is in both primary and secondary');
    expect(errorsFor({ muscles: { primary: ["quads", "quads"], secondary: [] } })).toContain('probe: muscles.primary repeats "quads"');
    expect(errorsFor({ muscles: { primary: ["quads"], secondary: ["glute-max", "glute-max"] } })).toContain('probe: muscles.secondary repeats "glute-max"');
    expect(errorsFor({ purposes: ["strength", "strength"] })).toContain('probe: purposes repeats "strength"');
    expect(errorsFor({ contraction: ["isotonic", "isotonic"] })).toContain('probe: contraction repeats "isotonic"');
    expect(errorsFor({ tags: ["ski", "ski"] })).toContain('probe: tags repeats "ski"');
    expect(errorsFor({ themes: ["hipsPosture", "hipsPosture"] })).toContain('probe: themes repeats "hipsPosture"');
  });

  test("a record needs a primary or secondary muscle inside its regions", () => {
    const only = errorsFor({ regions: ["jaw"], muscles: { primary: ["quads"], secondary: ["glute-max"] } });
    expect(only).toContain("probe: no primary or secondary muscle sits in the record's regions");
    expect(errorsFor({ regions: ["glutes"], muscles: { primary: ["quads"], secondary: ["glute-max"] } })).toEqual([]);
    expect(errorsFor({})).toEqual([]);
  });
});

describe("condition ratings (Review Focus 1)", () => {
  const base = get("gobletSquat")!;

  test("a record without its TMJ rating fails validation loudly", () => {
    const { tmj: _dropped, ...otherConditions } = base.conditions;
    const unrated: ExerciseRecord = { ...base, id: "unratedCopy", conditions: otherConditions };
    expect(validateLibrary(withExercises([...EXERCISES, unrated]), { presets: [] })).toContain("unratedCopy: conditions.tmj is missing");
  });

  test("a record without its TMJ note fails validation loudly", () => {
    const silent: ExerciseRecord = { ...base, id: "silentCopy", text: { ...base.text, conditions: {} } };
    expect(validateLibrary(withExercises([...EXERCISES, silent]), { presets: [] })).toContain("silentCopy: text.conditions.tmj is required");
  });

  test("ratings must use each attribute's scale", () => {
    const odd: ExerciseRecord = { ...base, id: "oddCopy", conditions: { tmj: { clench: 1.5, neckLoad: -1, faceDown: false, extra: 1 } } };
    const errors = validateLibrary(withExercises([...EXERCISES, odd]), { presets: [] });
    expect(errors).toContain("oddCopy: conditions.tmj.clench must be 0–3");
    expect(errors).toContain("oddCopy: conditions.tmj.neckLoad must be 0–3");
    expect(errors).toContain('oddCopy: conditions.tmj.extra is not an attribute of "tmj"');
  });

  test("a record that carries a link, a handle, or a sources field fails validation", () => {
    // Assembled at runtime so the repository's privacy grep stays clean.
    const link = ["ht", "tps:/", "/example.org/x"].join("");
    const handle = ["@", "someone"].join("");
    const linked: ExerciseRecord = { ...base, id: "linkedCopy", text: { ...base.text, why: `See ${link}` } };
    const handled: ExerciseRecord = { ...base, id: "handledCopy", text: { ...base.text, why: `From ${handle}` } };
    const sourced = { ...base, id: "sourcedCopy", sources: [] } as ExerciseRecord;
    const errors = validateLibrary(withExercises([...EXERCISES, linked, handled, sourced]), { presets: [] });
    expect(errors).toContain("linkedCopy: carries a link or a handle (provenance stays private)");
    expect(errors).toContain("handledCopy: carries a link or a handle (provenance stays private)");
    expect(errors).toContain("sourcedCopy: sources are private and never part of the library");
  });
});

describe("curation fields", () => {
  const base = get("bridge")!;
  const check = (over: Record<string, unknown>) =>
    validateLibrary(withExercises([...EXERCISES, { ...base, id: "curated", ...over } as ExerciseRecord]), { presets: [] });

  test("a well-formed record passes", () => {
    expect(check({ contraction: ["isotonic"], purposes: ["strength"], muscles: { primary: ["glute-max"], secondary: [] }, themes: [] })).toEqual([]);
  });

  test("bad values are named by record id and field", () => {
    const errors = check({
      contraction: [], purposes: ["flying"], muscles: { primary: [], secondary: ["toes"] }, themes: ["nope"], tags: ["nonsense"],
    });
    expect(errors).toContain("curated: contraction needs at least 1");
    expect(errors).toContain('curated: purposes "flying" is not in the vocabulary');
    expect(errors).toContain("curated: muscles.primary needs at least 1");
    expect(errors).toContain('curated: muscles.secondary "toes" is not in the vocabulary');
    expect(errors).toContain('curated: theme "nope" does not exist');
    expect(errors).toContain('curated: tag "nonsense" is not in the vocabulary');
  });
});

describe("jumps in one place (final review): a ladder's links mirror, and a jump-like tag means a jump", () => {
  const jump = (id: string, over: Record<string, unknown> = {}) =>
    ex(id, { contraction: ["plyometric"], purposes: ["power"], tags: ["elastic"], ...over });
  const errorsOf = (exercises: ReturnType<typeof ex>[], options: { jumpTagExempt?: readonly string[] } = {}) =>
    validateLibrary(withExercises(defineExercises(exercises)), { presets: [], ...options });

  test("a plyometric record's harder link is named back as easier, and its easier link back as harder", () => {
    const errors = errorsOf([
      jump("lowHop", { harder: ["highHop"] }), jump("highHop", { difficulty: 2 }),
      jump("stick", { difficulty: 1 }), jump("dropIn", { difficulty: 3, easier: ["stick"] }),
      jump("okA", { harder: ["okB"] }), jump("okB", { difficulty: 2, easier: ["okA"] }),
    ]);
    expect(errors).toContain('lowHop: harder link "highHop" is not mirrored (highHop does not name lowHop as easier)');
    expect(errors).toContain('dropIn: easier link "stick" is not mirrored (stick does not name dropIn as harder)');
    expect(errors.filter(e => e.startsWith("okA") || e.startsWith("okB"))).toEqual([]);
  });

  test("links between other moves may stay one-way (a core lift's easier move is not its graduation)", () => {
    const errors = errorsOf([lifted("liftA", { harder: ["liftB"] }), lifted("liftB", { difficulty: 3 })]);
    expect(errors.filter(e => e.includes("mirrored"))).toEqual([]);
  });

  test("a move tagged elastic or landing must be plyometric, unless the library exempts it by id", () => {
    const tagged = (id: string, tag: string) => ex(id, { tags: [tag] });
    const errors = errorsOf([tagged("springy", "elastic"), tagged("softLand", "landing"), tagged("plain", "posture")]);
    for (const id of ["springy", "softLand"]) {
      expect(errors).toContain(`${id}: a jump-like tag (elastic, landing) needs a plyometric contraction, or an exemption`);
    }
    expect(errors.filter(e => e.startsWith("plain:"))).toEqual([]);
    expect(errorsOf([tagged("softLand", "landing")], { jumpTagExempt: ["softLand"] }).filter(e => e.startsWith("softLand:"))).toEqual([]);
  });

  test("deceleration alone is braking work, not a jump: a slow eccentric step-down may carry it; a real jump keeps its gate", () => {
    // Slowing down well is trained without leaving the floor, so the tag says nothing about flight.
    const stepDown = ex("slowStepDown", { tags: ["deceleration", "single-leg"], contraction: ["isotonic", "eccentric"], purposes: ["strength", "balance"] });
    expect(errorsOf([stepDown]).filter(e => e.startsWith("slowStepDown:"))).toEqual([]);
    // Landing and deceleration together still need the jump's contraction.
    expect(errorsOf([ex("brakeAndLand", { tags: ["deceleration", "landing"] })])).toContain(
      "brakeAndLand: a jump-like tag (elastic, landing) needs a plyometric contraction, or an exemption",
    );
    // The gate rules on the contraction: the step-down is open on a recovery day, the snap-down (tagged deceleration too) is not.
    const [defined] = defineExercises([stepDown]);
    const recoveryDay = { pre: 1, post: null, feelingOff: false };
    expect(defined!.tags).toContain("deceleration");
    expect(TMJ.allowRecord!(defined!, "recovery", recoveryDay)).toBe(true);
    expect(get("snapDown")!.tags).toContain("deceleration");
    expect(TMJ.allowRecord!(get("snapDown")!, "recovery", recoveryDay)).toBe(false);
    expect(TMJ.allowRecord!(get("snapDown")!, "build", recoveryDay)).toBe(true);
  });

  test("the real library's ladders mirror: the box jump leads to the tuck jump both ways, the snap-down to each rung above it", () => {
    const by = (id: string) => get(id)!;
    expect(by("tuckJump").easier).toContain("boxJumpStepDown");
    expect(by("snapDown").harder).toEqual(expect.arrayContaining(["broadJumpStick", "pogoHop", "boxJumpStepDown"]));
    expect(validateLibrary(data).filter(e => e.includes("mirrored") || e.includes("jump-like"))).toEqual([]);
  });

  test("a jump's harder links run gentlest first, so the next step up is the smallest one", () => {
    const errors = errorsOf([
      jump("base", { harder: ["big", "small"] }), jump("small", { difficulty: 2, easier: ["base"] }), jump("big", { difficulty: 4, easier: ["base"] }),
      jump("okBase", { harder: ["okSmall", "okBig"] }), jump("okSmall", { difficulty: 2, easier: ["okBase"] }), jump("okBig", { difficulty: 3, easier: ["okBase"] }),
    ]);
    expect(errors).toContain('base: harder links must run gentlest first ("small", difficulty 2, comes before "big", difficulty 4)');
    expect(errors.filter(e => e.startsWith("ok"))).toEqual([]);
    // The real snap-down: pogo hops (difficulty 2) is the first step up, ahead of the box jump and the broad jump (3).
    const snap = get("snapDown")!;
    expect(snap.harder[0]).toBe("pogoHop");
    const difficulties = snap.harder.map(id => get(id)!.difficulty);
    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
    expect(validateLibrary(data).filter(e => e.includes("gentlest"))).toEqual([]);
  });
});
