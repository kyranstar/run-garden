import { describe, expect, test } from "vitest";
import {
  EXERCISES, LOCATION_PRESETS, NO_EQUIPMENT_GEAR, TMJ, hasEquipment, makeEngineData, recordFlareSafe, searchLibrary, validateLibrary, type ExerciseRecord,
} from "../src/index.js";

// Task 13 (A9, R9): the lower-limb stretches, slow-lowering strength and gym moves the library lacked, each held to the
// library's standard and rated honestly for the jaw profile — the heavy lifts for the bracing they invite.

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => {
  const r = byId.get(id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};

const STRETCHES = ["standingHamstringStretch", "halfKneelingHamstringStretch", "standingQuadStretch", "sideLyingQuadStretch", "frogStretch"];
const MOBILITY = ["adductorRockBack"];
const ECCENTRIC = ["bentKneeHeelDrop", "eccentricPushup", "singleLegBoxSit", "hamstringSlideOut", "eccentricPullUp"];
const BARBELL = ["barbellBackSquat", "barbellRdl"];
const GYM = [...BARBELL, "latPulldown", "bandAssistedPullUp", "legPress"];
const ADDED = [...STRETCHES, ...MOBILITY, ...ECCENTRIC, ...GYM];
/** Heavy loads, or pulling the body's own weight: the lifts that invite a brace through the jaw. */
const BRACING = [...BARBELL, "legPress", "bandAssistedPullUp", "eccentricPullUp"];
const tmj = (id: string) => rec(id).conditions.tmj as { clench: number; neckLoad: number; faceDown: boolean };
const gear = (id: string) => LOCATION_PRESETS.find((l) => l.id === id)!.equipment;

describe("the added records", () => {
  test("all exist, come last in the library, and the library still validates with them", () => {
    for (const id of ADDED) expect(byId.has(id), id).toBe(true);
    expect(EXERCISES.slice(-ADDED.length).map((e) => e.id).sort()).toEqual([...ADDED].sort());
    expect(validateLibrary(makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES }))).toEqual([]);
  });

  test("each is rated for the jaw profile with its own note; none is face down", () => {
    for (const id of ADDED) {
      expect(tmj(id).faceDown, id).toBe(false);
      expect(rec(id).text.conditions.tmj?.trim().length ?? 0, id).toBeGreaterThan(40);
    }
    const notes = ADDED.map((id) => rec(id).text.conditions.tmj);
    expect(new Set(notes).size).toBe(notes.length);
  });

  test("honest jaw ratings: the stretches ask nothing of it; the heavy lifts and the pull-ups invite a brace, said in their notes", () => {
    for (const id of [...STRETCHES, ...MOBILITY]) {
      expect({ clench: tmj(id).clench, neckLoad: tmj(id).neckLoad }, id).toEqual({ clench: 0, neckLoad: 0 });
      expect(recordFlareSafe(TMJ, rec(id)), id).toBe(true);
    }
    for (const id of BRACING) {
      expect(tmj(id).clench, id).toBe(2);
      expect(rec(id).text.conditions.tmj, id).toMatch(/brac|clench|grit/i);
      // Never on a flare day, never in a recovery session, and never in a circuit (the profile's clench caps).
      expect(recordFlareSafe(TMJ, rec(id)), id).toBe(false);
      expect(TMJ.fitsMode(rec(id).conditions.tmj!, "recovery"), id).toBe(false);
      expect(TMJ.fitsFormat(rec(id).conditions.tmj!, "circuit"), id).toBe(false);
      expect(TMJ.never(rec(id).conditions.tmj!), id).toBe(false);
    }
    // The bar across the upper back, the heavy bar in the hands, the hang: the neck is loaded too.
    for (const id of [...BARBELL, "bandAssistedPullUp", "eccentricPullUp", "latPulldown"]) expect(tmj(id).neckLoad, id).toBe(1);
    // Slow single-leg and plank lowering: a little bracing, with a cue for it.
    for (const id of ["bentKneeHeelDrop", "eccentricPushup", "singleLegBoxSit", "hamstringSlideOut"]) expect(tmj(id).clench, id).toBe(1);
  });

  test("the stretches let go; the rock-back moves in and out of its stretch; none of them loads", () => {
    for (const id of STRETCHES) {
      expect(rec(id).contraction, id).toEqual(["passive"]);
      expect(rec(id).purposes, id).toContain("stretch");
      expect(rec(id).roles, id).toContain("stretch");
      expect(rec(id).load, id).toBe("none");
    }
    // The rock-back moves in and out of its stretch to warm the hips: a warm-up drill, never a cool-down's held stretch.
    expect(rec("adductorRockBack").contraction).toEqual(["isotonic"]);
    expect([...rec("adductorRockBack").purposes].sort()).toEqual(["mobility", "warmup"]);
    // Hamstrings, quads and inner thighs, each where its muscle sits.
    for (const id of ["standingHamstringStretch", "halfKneelingHamstringStretch"]) expect(rec(id).muscles.primary, id).toEqual(["hamstrings"]);
    for (const id of ["standingQuadStretch", "sideLyingQuadStretch"]) expect(rec(id).muscles.primary, id).toEqual(["quads"]);
    for (const id of ["adductorRockBack", "frogStretch"]) expect(rec(id).muscles.primary, id).toEqual(["adductors"]);
    // The couch stretch stretches the quads as well as the hip flexors (the audit's region fix).
    expect(rec("couchStretch").regions).toEqual(expect.arrayContaining(["hips", "quads"]));
  });

  test("the slow-lowering moves are about the lowering: eccentric, tagged so, and slow per rep", () => {
    for (const id of ECCENTRIC) {
      expect(rec(id).contraction, id).toContain("eccentric");
      expect(rec(id).tags, id).toContain("eccentric-emphasis");
      expect(rec(id).dose.secsPerRep ?? 0, id).toBeGreaterThanOrEqual(5);
      expect(rec(id).purposes, id).toContain("strength");
    }
    // The bent-knee heel drop works the deep calf muscle, and is the bent-knee raise's next rung.
    expect(rec("bentKneeHeelDrop").muscles.primary).toEqual(["soleus"]);
    expect(rec("bentKneeHeelDrop").family).toBe("calfRaise");
    expect(rec("bentKneeCalfRaise").harder).toEqual(["bentKneeHeelDrop"]);
    expect(rec("bentKneeHeelDrop").easier).toEqual(["bentKneeCalfRaise"]);
    expect(rec("bentKneeHeelDrop").text.setup.join(" ")).toMatch(/30–45°/);
    expect(Object.values(rec("bentKneeHeelDrop").text).flat().join(" ")).toMatch(/never below/i);
  });

  test("every ladder link points the right way: easier is easier, harder is harder", () => {
    for (const id of ADDED) {
      const r = rec(id);
      for (const e of r.easier) expect(rec(e).difficulty, `${id} easier ${e}`).toBeLessThan(r.difficulty);
      for (const h of r.harder) expect(rec(h).difficulty, `${id} harder ${h}`).toBeGreaterThan(r.difficulty);
    }
    expect(rec("barbellBackSquat").easier).toEqual(["gobletSquat"]);
    expect(rec("barbellRdl").easier).toEqual(["rdl"]);
    // An older lift does not graduate to a barbell one on its own: the barbell is a choice where the place has one.
    expect(rec("gobletSquat").harder).not.toContain("barbellBackSquat");
    expect(rec("rdl").harder).not.toContain("barbellRdl");
  });

  test("gear: the barbell and machine moves only where a place has them; the stretches anywhere", () => {
    for (const id of BARBELL) expect(rec(id).equipment.all, id).toEqual(["barbell"]);
    expect(rec("legPress").equipment.all).toEqual(["machine"]);
    expect([...rec("latPulldown").equipment.oneOf].sort()).toEqual(["cable", "machine"]);
    expect([...rec("bandAssistedPullUp").equipment.all].sort()).toEqual(["band", "pull-up-bar"]);
    expect(rec("eccentricPullUp").equipment.all).toEqual(["pull-up-bar"]);
    for (const id of GYM) {
      expect(hasEquipment(rec(id), gear("gym")), `${id} at the gym`).toBe(true);
      expect(hasEquipment(rec(id), gear("home")), `${id} at home`).toBe(false);
    }
    for (const id of [...STRETCHES, ...MOBILITY]) expect(hasEquipment(rec(id), NO_EQUIPMENT_GEAR), `${id} in a bare room`).toBe(true);
    // The heavy lifts start from the empty bar.
    for (const id of BARBELL) expect(rec(id).dose.startKg, id).toBe(20);
  });

  test("the gym lifts that are core lifts, and the vertical pulls that are accessory work", () => {
    for (const id of [...BARBELL, "legPress"]) expect(rec(id).roles, id).toEqual(["core", "accessory"]);
    for (const id of ["latPulldown", "bandAssistedPullUp", "eccentricPullUp"]) {
      expect(rec(id).roles, id).toEqual(["accessory"]);
      expect(rec(id).patterns, id).toEqual(["pull-v"]);
    }
  });

  test("COROS: the gym lifts the catalog holds go to the watch as its steps; the band changes the pull-up, so it doesn't", () => {
    const coros = (id: string) => rec(id).providers?.coros ?? null;
    expect(coros("barbellBackSquat")).toEqual({ key: "T1061", confidence: "exact", method: "curated" }); // Squats
    expect(coros("barbellRdl")).toEqual({ key: "T1287", confidence: "exact", method: "curated" }); // Romanian Deadlift
    expect(coros("latPulldown")).toEqual({ key: "T1342", confidence: "exact", method: "curated" }); // Lat Pulldowns
    expect(coros("legPress")).toEqual({ key: "T1065", confidence: "exact", method: "curated" }); // Incline Leg Press
    expect(coros("bandAssistedPullUp")).toEqual({ key: "T1002", confidence: "close", method: "curated" }); // Pull-ups
    for (const id of [...STRETCHES, ...MOBILITY, ...ECCENTRIC]) expect(coros(id), id).toBeNull();
  });
});

describe("searching for the added moves", () => {
  const ids = (q: string, f = {}) => searchLibrary(EXERCISES, q, f).map((e) => e.id);

  test("everyday words reach them", () => {
    expect(ids("hamstring stretch")).toEqual(expect.arrayContaining(["standingHamstringStretch", "halfKneelingHamstringStretch", "towelHamstringStretch"]));
    expect(ids("quad stretch")).toEqual(expect.arrayContaining(["standingQuadStretch", "sideLyingQuadStretch"]));
    expect(ids("adductor")).toEqual(expect.arrayContaining(["adductorRockBack", "frogStretch"]));
    expect(ids("frog")[0]).toBe("frogStretch");
    expect(ids("barbell")).toEqual(expect.arrayContaining(BARBELL));
    expect(ids("leg press")[0]).toBe("legPress");
    expect(ids("lat pulldown")[0]).toBe("latPulldown");
    expect(ids("pull-up")).toEqual(expect.arrayContaining(["bandAssistedPullUp", "eccentricPullUp"]));
    expect(ids("eccentric")).toEqual(expect.arrayContaining(ECCENTRIC));
  });

  test("the filters the audit saw come back empty now hold moves", () => {
    expect(ids("", { role: "stretch", region: "quads" })).toEqual(expect.arrayContaining(["standingQuadStretch", "sideLyingQuadStretch", "couchStretch"]));
    expect(ids("", { equipment: "barbell" }).sort()).toEqual([...BARBELL].sort());
    expect(ids("", { equipment: "machine" }).sort()).toEqual(["latPulldown", "legPress"]);
    expect(ids("", { pattern: "pull-v" }).sort()).toEqual(["bandAssistedPullUp", "eccentricPullUp", "latPulldown"]);
    expect(ids("", { tag: "thoracic" }).length).toBeGreaterThanOrEqual(3);
    expect(ids("", { tag: "rotational" }).length).toBeGreaterThanOrEqual(3);
    expect(ids("", { tag: "isometric-hold" })).toEqual(expect.arrayContaining(["wallSit", "splitSquatHold"]));
  });

  test("\"sore\" with the new areas lists only what eases", () => {
    for (const q of ["sore hamstrings", "sore quads", "tight hamstrings", "sore inner thighs"]) {
      const hits = searchLibrary(EXERCISES, q);
      for (const e of hits) expect(e.purposes.some((p) => p === "strength" || p === "power") || e.load === "external", `${q}: ${e.id}`).toBe(false);
    }
    expect(ids("sore hamstrings")).toEqual(expect.arrayContaining(["standingHamstringStretch", "halfKneelingHamstringStretch"]));
    expect(ids("sore quads")).toEqual(expect.arrayContaining(["standingQuadStretch", "sideLyingQuadStretch"]));
  });
});
