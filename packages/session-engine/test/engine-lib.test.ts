import { Vocab, defineExercises, makeEngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Lib } from "../src/index.js";
import { dataWith, ex, lifted, tmj } from "./fixtures.js";

// Ported from the standalone tests/engine-lib.test.js.

const data = dataWith([
  ex("breath", { patterns: ["breathe"], regions: ["jaw"], roles: ["downshift"] }),
  ex("childBlock", { equipment: { all: ["yoga-block"], oneOf: [] } }),
  lifted("gobletSquat", { legacyIds: ["kbGoblet"] }),
  lifted("halfKneelingPress", { patterns: ["push-v"], conditions: tmj(2, 1, false), difficulty: 3 }),
  ex("proneYTW", { patterns: ["pull-h"], roles: ["core", "accessory"], load: "bodyweight", dose: { type: "reps", range: [5, 10] }, conditions: tmj(0, 1, true) }),
  lifted("heavyThing", { conditions: tmj(3, 0, false) }),
  { id: "sparse", name: "Sparse", family: "x", patterns: ["mobility"], regions: ["hips"], roles: ["mobility"], position: "standing", laterality: "bilateral", load: "none", dose: { type: "time", range: [30, 45] }, conditions: tmj(0), difficulty: 1, text: {} } as never,
]);
const get = (id: string) => Lib.get(data, id)!;

test("addExercises fills optional fields with defaults", () => {
  const s = get("sparse");
  expect(s.equipment).toEqual({ all: [], oneOf: [] });
  // `sources` is no longer part of a record (provenance is private, spec §3.1).
  for (const f of ["legacyIds", "easier", "harder", "tags"] as const) expect(s[f].length, f).toBe(0);
  expect("sources" in s).toBe(false);
});

test("get resolves ids and legacy ids", () => {
  expect(get("gobletSquat").id).toBe("gobletSquat");
  expect(get("kbGoblet").id).toBe("gobletSquat");
  expect(Lib.get(data, "nope")).toBe(null);
  expect(Lib.all(data).length).toBe(7);
});

test("hasEquipment honours all and oneOf", () => {
  expect(Lib.hasEquipment(get("childBlock"), ["mat"])).toBe(false);
  expect(Lib.hasEquipment(get("childBlock"), ["yoga-block"])).toBe(true);
  expect(Lib.hasEquipment(get("gobletSquat"), ["mat"])).toBe(false);
  expect(Lib.hasEquipment(get("gobletSquat"), ["dumbbells"])).toBe(true);
  expect(Lib.hasEquipment(get("breath"), [])).toBe(true);
});

test("implementFor picks the first loaded implement in the exercise's order", () => {
  expect(Lib.implementFor(get("gobletSquat"), ["dumbbells", "kettlebell"])).toBe("kettlebell");
  expect(Lib.implementFor(get("gobletSquat"), ["dumbbells"])).toBe("dumbbells");
  expect(Lib.implementFor(get("breath"), ["kettlebell"])).toBe(null);
});

test("flareSafe needs low clench, low neck load, and no face-down lying", () => {
  expect(Lib.flareSafe(data, get("breath"))).toBe(true);
  expect(Lib.flareSafe(data, get("proneYTW"))).toBe(false);
  expect(Lib.flareSafe(data, get("halfKneelingPress"))).toBe(false);
});

test("fitsMode applies the mode limits", () => {
  expect(Lib.fitsMode(data, get("breath"), "recovery")).toBe(true);
  expect(Lib.fitsMode(data, get("proneYTW"), "recovery")).toBe(false);
  expect(Lib.fitsMode(data, get("gobletSquat"), "recovery")).toBe(false);
  expect(Lib.fitsMode(data, get("gobletSquat"), "consistent")).toBe(true);
  expect(Lib.fitsMode(data, get("halfKneelingPress"), "consistent")).toBe(false);
  expect(Lib.fitsMode(data, get("halfKneelingPress"), "build")).toBe(true);
  expect(Lib.fitsMode(data, get("heavyThing"), "build")).toBe(false);
});

test("eligible combines equipment, mode, and exclusions", () => {
  const g = get("gobletSquat");
  expect(Lib.eligible(data, g, { equipment: ["kettlebell"], mode: "build", excluded: [] })).toBe(true);
  expect(Lib.eligible(data, g, { equipment: ["kettlebell"], mode: "build", excluded: ["gobletSquat"] })).toBe(false);
  expect(Lib.eligible(data, g, { equipment: ["mat"], mode: "build" })).toBe(false);
});

test("coreFamilyOf maps core exercises by pattern", () => {
  expect(Lib.coreFamilyOf(data, get("gobletSquat"))).toBe("squat");
  expect(Lib.coreFamilyOf(data, get("proneYTW"))).toBe("row");
  expect(Lib.coreFamilyOf(data, get("halfKneelingPress"))).toBe("press");
  expect(Lib.coreFamilyOf(data, get("breath"))).toBe(null);
});

test("vocab helpers", () => {
  expect(Vocab.label("upper-back")).toBe("Upper back");
  expect(Vocab.label("hips")).toBe("Hips");
  expect(Vocab.positionGroup("supine")).toBe("floor");
  expect(Vocab.positionGroup("standing")).toBe("standing");
  expect(data.modes.recovery.coreCount[1]).toBe(0);
});

describe("beyond the standalone suite", () => {
  test("the day's checks: overhead pressing needs an answered check of 2 or less (spec §5 change 1)", () => {
    const press = get("halfKneelingPress");
    expect(Lib.fitsMode(data, press, "build", { tmj: { pre: 2, post: null, feelingOff: false } })).toBe(true);
    expect(Lib.fitsMode(data, press, "build", { tmj: { pre: 3, post: null, feelingOff: false } })).toBe(false);
    expect(Lib.fitsMode(data, press, "build", { tmj: { pre: null, post: null, feelingOff: false } })).toBe(false);
    expect(Lib.fitsMode(data, press, "build", {})).toBe(false);
  });

  test("library lookups are per EngineData, never a stale global cache (spec §5 change 5)", () => {
    const a = dataWith([ex("onlyInA")]);
    const b = dataWith([ex("onlyInB", { legacyIds: ["onlyInA"] })]);
    expect(Lib.get(a, "onlyInA")?.id).toBe("onlyInA");
    expect(Lib.get(b, "onlyInA")?.id).toBe("onlyInB");
    expect(Lib.get(a, "onlyInB")).toBe(null);
    // The same library, re-spread into new data with a different exercise list, is re-indexed.
    const c = { ...a, exercises: defineExercises([ex("onlyInC")]) };
    expect(Lib.get(c, "onlyInA")).toBe(null);
    expect(Lib.get(c, "onlyInC")?.id).toBe("onlyInC");
  });

  test("an active profile with no rating on a record fails closed; with no profile active nothing reads ratings", () => {
    const unrated = { ...get("breath"), id: "unrated", conditions: {} };
    const withUnrated = { ...data, exercises: [...data.exercises, unrated] };
    expect(Lib.fitsMode(withUnrated, unrated, "recovery")).toBe(false);
    expect(Lib.flareSafe(withUnrated, unrated)).toBe(false);
    const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: [unrated] });
    expect(Lib.fitsMode(none, unrated, "recovery")).toBe(true);
    expect(Lib.flareSafe(none, unrated)).toBe(true);
  });
});
