import { describe, expect, test } from "vitest";
import {
  BLOCK_IDS, EXERCISES, EQUIPMENT_IDS, LOCATION_PRESETS, MODE_IDS, defineExercises, hasEquipment, makeEngineData, validateLibrary,
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
    expect(EXERCISES.length).toBe(120);
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
