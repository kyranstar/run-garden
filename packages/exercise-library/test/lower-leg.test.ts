import { describe, expect, test } from "vitest";
import {
  EXERCISES, GLOSSARY, LOCATION_PRESETS, NO_EQUIPMENT_GEAR, PATTERNS, TAGS, TMJ, hasEquipment, label, makeEngineData, recordFlareSafe, searchLibrary,
  validateLibrary, type ExerciseRecord,
} from "../src/index.js";

// R10 (CUJ J04, sore calves and hamstrings after a long run): the library's lower leg. Searching "calf" used to find only
// hops and ankle rocks, and "sore" found nothing. These records fill the gap: calf stretches with the knee straight and
// bent, calf raises (both feet, knees bent, one foot), an eccentric heel drop, a tibialis raise, a calf release and ankle
// circles — each held to the library's standard, rated for the jaw profile with a note.

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => {
  const r = byId.get(id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};

const STRETCHES = ["calfStretch", "soleusStretch"];
const RAISES = ["calfRaise", "bentKneeCalfRaise", "singleLegCalfRaise", "eccentricHeelDrop"];
const LOWER_LEG = [...STRETCHES, ...RAISES, "tibialisRaise", "calfRelease", "ankleCircles"];
const passiveOnly = (e: ExerciseRecord) => e.contraction.every((c) => c === "passive");
/** A move that loads a sore area: a lift, a jump, or added weight. */
const loads = (e: ExerciseRecord) =>
  e.purposes.some((p) => p === "strength" || p === "power") || e.contraction.includes("plyometric") || e.load === "external";
/** A move that eases: passive, or for stretching or recovery — and never one that loads. */
const easing = (e: ExerciseRecord) => (passiveOnly(e) || e.purposes.some((p) => p === "stretch" || p === "recovery")) && !loads(e);

describe("the lower-leg records", () => {
  test("all exist, and the library still validates with them", () => {
    for (const id of LOWER_LEG) expect(byId.has(id), id).toBe(true);
    expect(validateLibrary(makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES }))).toEqual([]);
  });

  test("each is rated for the jaw profile with a note: calf work is low jaw load, nothing face down, all flare-safe", () => {
    for (const id of LOWER_LEG) {
      const r = rec(id);
      const tmj = r.conditions.tmj as { clench: number; neckLoad: number; faceDown: boolean };
      expect(tmj, id).toBeTruthy();
      expect(tmj.clench, id).toBeLessThanOrEqual(1);
      expect(tmj.neckLoad, id).toBe(0);
      expect(tmj.faceDown, id).toBe(false);
      expect(recordFlareSafe(TMJ, r), id).toBe(true);
      expect(r.text.conditions.tmj?.trim().length ?? 0, id).toBeGreaterThan(20);
    }
    // One-legged work invites bracing: rated a little above the rest, with a cue for it.
    for (const id of ["singleLegCalfRaise", "eccentricHeelDrop"]) {
      expect(rec(id).conditions.tmj!.clench, id).toBe(1);
      expect(rec(id).text.conditions.tmj, id).toMatch(/brac/i);
    }
  });

  test("honest contraction: the stretches and the release let go, the raises lift and lower, the heel drop is about the lowering", () => {
    for (const id of [...STRETCHES, "calfRelease"]) expect(rec(id).contraction, id).toEqual(["passive"]);
    for (const id of ["calfRaise", "bentKneeCalfRaise", "singleLegCalfRaise", "tibialisRaise", "ankleCircles"]) expect(rec(id).contraction, id).toEqual(["isotonic"]);
    const drop = rec("eccentricHeelDrop");
    expect(drop.contraction).toEqual(["isotonic", "eccentric"]);
    expect(drop.tags).toContain("eccentric-emphasis");
    expect(LOWER_LEG.filter((id) => rec(id).tags.includes("eccentric-emphasis"))).toEqual(["eccentricHeelDrop"]);
  });

  test("honest anatomy: a straight knee stretches the big calf muscle, a bent knee the deep one, and the tibialis lifts the toes", () => {
    expect(rec("calfStretch").muscles.primary).toEqual(["gastrocnemius"]);
    expect(rec("soleusStretch").muscles.primary).toEqual(["soleus"]);
    // With the knee bent the big calf muscle is slack: it is not stretched, nor the bent-knee raise's driver.
    expect(rec("soleusStretch").muscles.secondary).not.toContain("gastrocnemius");
    expect(rec("bentKneeCalfRaise").muscles.primary).toEqual(["soleus"]);
    for (const id of ["calfRaise", "singleLegCalfRaise", "eccentricHeelDrop", "calfRelease"]) expect(rec(id).muscles.primary, id).toEqual(["gastrocnemius", "soleus"]);
    expect(rec("tibialisRaise").muscles.primary).toEqual(["tibialis"]);
    // The shin muscle lifts the toes: it does nothing in a calf raise, so no raise names it.
    for (const id of RAISES) expect([...rec(id).muscles.primary, ...rec(id).muscles.secondary], id).not.toContain("tibialis");
    for (const id of LOWER_LEG) expect(rec(id).regions.some((g) => g === "calves" || g === "ankles"), id).toBe(true);
  });

  test("the ankle mobility family names one thing: the muscle the move loosens, the deep calf first", () => {
    for (const id of ["ankleRocks", "ankleCircles"]) {
      expect(rec(id).family, id).toBe("ankleMobility");
      expect(rec(id).muscles.primary, id).toEqual(["soleus"]);
      expect(rec(id).muscles.secondary, id).toEqual(expect.arrayContaining(["gastrocnemius", "tibialis"]));
    }
  });

  test("a calf raise is not a squat, nor a shin raise: lifting the heels and lifting the toes are patterns of their own", () => {
    expect(PATTERNS).toEqual(expect.arrayContaining(["calf-raise", "toe-raise"]));
    expect(PATTERNS as readonly string[]).not.toContain("ankle-raise");
    expect(label("calf-raise")).toBe("Calf raises");
    expect(label("toe-raise")).toBe("Shin raises");
    for (const id of RAISES) expect(rec(id).patterns, id).toEqual(["calf-raise"]);
    expect(rec("tibialisRaise").patterns).toEqual(["toe-raise"]);
    expect(EXERCISES.filter((e) => e.patterns.includes("calf-raise")).map((e) => e.id).sort()).toEqual([...RAISES].sort());
    expect(EXERCISES.filter((e) => e.patterns.includes("toe-raise")).map((e) => e.id)).toEqual(["tibialisRaise"]);
  });

  test("the heel drop says how much discomfort is fine and what to do about pain at the heel", () => {
    const text = Object.values(rec("eccentricHeelDrop").text).flat().join(" ");
    expect(text).toMatch(/next morning/i);
    expect(text).toMatch(/sharp pain/i);
    expect(text).toMatch(/back of the heel bone/i);
    expect(text).toMatch(/never below/i);
    // Its jaw note is its own, not the eccentric step-down's.
    expect(rec("eccentricHeelDrop").text.conditions.tmj).not.toBe(rec("stepDownHeelTap").text.conditions.tmj);
    expect(rec("eccentricHeelDrop").text.conditions.tmj).toMatch(/heel/i);
  });

  test("the bent-knee raise cues its knee bend, 30–45°", () => {
    expect([...rec("bentKneeCalfRaise").text.setup, ...rec("bentKneeCalfRaise").text.steps].join(" ")).toMatch(/30–45°/);
  });

  test("the calf ladder: both feet, then the eccentric heel drop, then one foot", () => {
    expect(rec("calfRaise").harder[0]).toBe("eccentricHeelDrop");
    expect(rec("eccentricHeelDrop").easier).toEqual(["calfRaise"]);
    expect(rec("eccentricHeelDrop").harder).toEqual(["singleLegCalfRaise"]);
    expect(rec("singleLegCalfRaise").easier).toEqual(["eccentricHeelDrop"]);
    const d = ["calfRaise", "eccentricHeelDrop", "singleLegCalfRaise"].map((id) => rec(id).difficulty);
    expect(d).toEqual([1, 2, 3]);
    for (const id of RAISES) expect(rec(id).family, id).toBe("calfRaise");
    // Every link points at a record of the right difficulty.
    for (const id of LOWER_LEG) {
      const r = rec(id);
      for (const e of r.easier) expect(rec(e).difficulty, `${id} easier ${e}`).toBeLessThan(r.difficulty);
      for (const h of r.harder) expect(rec(h).difficulty, `${id} harder ${h}`).toBeGreaterThan(r.difficulty);
    }
  });

  test("gear: a wall for the stretches and the tibialis raise, nothing for the raises, a roller or a ball for the release", () => {
    for (const id of [...STRETCHES, "tibialisRaise"]) expect(rec(id).equipment, id).toEqual({ all: ["wall"], oneOf: [] });
    for (const id of [...RAISES, "ankleCircles"]) expect(rec(id).equipment, id).toEqual({ all: [], oneOf: [] });
    expect(rec("calfRelease").equipment).toEqual({ all: [], oneOf: ["foam-roller", "massage-ball"] });
    // A bare room (a hotel, a park) has everything but the release.
    for (const id of LOWER_LEG) expect(hasEquipment(rec(id), NO_EQUIPMENT_GEAR), id).toBe(id !== "calfRelease");
    expect(hasEquipment(rec("calfRelease"), LOCATION_PRESETS.find((l) => l.id === "gym")!.equipment)).toBe(true);
    // The step for the heel drop is optional: the setup says what to do without one.
    expect(rec("eccentricHeelDrop").text.setup.join(" ")).toMatch(/no step\?/i);
  });

  test("tags follow the tag rule: running where running is the point, single-leg where one leg does the work", () => {
    expect(TAGS).toContain("running");
    expect(GLOSSARY.running).toBeTruthy();
    expect(LOWER_LEG.filter((id) => rec(id).tags.includes("running")).sort()).toEqual(["bentKneeCalfRaise", "calfRaise", "eccentricHeelDrop", "singleLegCalfRaise", "tibialisRaise"]);
    expect(LOWER_LEG.filter((id) => rec(id).tags.includes("single-leg")).sort()).toEqual(["eccentricHeelDrop", "singleLegCalfRaise"]);
    for (const id of [...STRETCHES, "calfRelease"]) expect(rec(id).tags, id).toEqual([]);
    // The same rule on the older lower-leg moves: the pogo hops build springy calves for running; the ankle rocks and
    // the ankle circles are about the ankle.
    expect(rec("pogoHop").tags).toContain("running");
    for (const id of ["ankleRocks", "ankleCircles"]) expect(rec(id).tags, id).toContain("ankle");
  });

  test("the stretches and the release are cool-down moves; the raises are accessory work; nothing is a core lift", () => {
    for (const id of [...STRETCHES, "calfRelease"]) {
      expect(rec(id).roles, id).toContain("cooldown");
      expect(rec(id).purposes, id).toContain("cooldown");
    }
    for (const id of [...RAISES, "tibialisRaise"]) {
      expect(rec(id).roles, id).toContain("accessory");
      expect(rec(id).purposes, id).toContain("strength");
    }
    for (const id of LOWER_LEG) expect(rec(id).roles, id).not.toContain("core");
  });
});

describe("searching for the lower leg", () => {
  const ids = (q: string) => searchLibrary(EXERCISES, q).map((e) => e.id);

  test("\"calf\" and \"calves\" find the calf stretches and raises before any hop or the ankle rocks", () => {
    for (const q of ["calf", "calves"]) {
      const hits = ids(q);
      const calfWork = [...STRETCHES, ...RAISES].map((id) => hits.indexOf(id));
      expect(calfWork.every((i) => i >= 0), q).toBe(true);
      const others = hits.filter((id) => rec(id).contraction.includes("plyometric") || id === "ankleRocks").map((id) => hits.indexOf(id));
      expect(others.length, q).toBeGreaterThan(0);
      expect(Math.max(...calfWork), q).toBeLessThan(Math.min(...others));
    }
  });

  test("\"sore calves\" lists only what eases, the stretches and the release first; never a raise or a hop", () => {
    for (const q of ["sore calves", "sore calf", "calf soreness", "calves sore"]) {
      const hits = searchLibrary(EXERCISES, q);
      expect(hits.length, q).toBeGreaterThan(0);
      expect(hits.filter((e) => !easing(e)).map((e) => e.id), q).toEqual([]);
      expect(hits.slice(0, 3).map((e) => e.id).sort(), q).toEqual(["calfRelease", "calfStretch", "soleusStretch"]);
      expect(hits.slice(0, 3).every(passiveOnly), q).toBe(true);
    }
  });

  test("\"sore\" alone finds stretches, passive work and recovery moves, none that loads; \"sore hamstrings\" finds the hamstring stretch", () => {
    for (const q of ["sore", "soreness"]) {
      const hits = searchLibrary(EXERCISES, q);
      expect(hits.length, q).toBeGreaterThan(10);
      expect(hits.filter(loads).map((e) => e.id), q).toEqual([]);
      // Every passive or recovery move is there.
      const gentle = EXERCISES.filter((e) => passiveOnly(e) || e.purposes.includes("recovery")).map((e) => e.id);
      expect(hits.map((e) => e.id), q).toEqual(expect.arrayContaining(gentle));
    }
    expect(ids("sore hamstrings")).toContain("towelHamstringStretch");
    // A word that only looks like an alias key finds nothing, and never throws.
    expect(() => searchLibrary(EXERCISES, "constructor")).not.toThrow();
  });

  test("everyday words reach the new moves: shin, soleus, foam roll, heel drop, heel raise, achilles, ankle circles", () => {
    expect(ids("tibialis")[0]).toBe("tibialisRaise");
    expect(ids("shin")).toContain("tibialisRaise");
    expect(ids("shins")).toContain("tibialisRaise");
    expect(ids("toe raise")).toContain("tibialisRaise");
    // The moves that work or loosen the deep calf first, the bent-knee raise and stretch among them.
    const soleus = searchLibrary(EXERCISES, "soleus");
    const primary = soleus.filter((e) => e.muscles.primary.includes("soleus"));
    expect(soleus.slice(0, primary.length)).toEqual(primary);
    expect(primary.map((e) => e.id)).toEqual(expect.arrayContaining(["bentKneeCalfRaise", "soleusStretch"]));
    expect(ids("foam roll")).toContain("calfRelease");
    expect(ids("heel drop")[0]).toBe("eccentricHeelDrop");
    expect(ids("heel raise")[0]).toBe("calfRaise");
    expect(ids("achilles")).toEqual(expect.arrayContaining(["eccentricHeelDrop", ...STRETCHES]));
    expect(ids("ankle circles")[0]).toBe("ankleCircles");
    expect(ids("running")).toEqual(expect.arrayContaining(["calfRaise", "singleLegCalfRaise", "eccentricHeelDrop", "tibialisRaise", "pogoHop"]));
  });

  test("\"sore\" with another area never lists the calf stretches or the release by a word of their card line", () => {
    const calfOnly = new Set([...STRETCHES, "calfRelease"]);
    for (const q of ["sore back", "sore low back", "sore lower back", "sore knee", "sore shins"]) {
      const hits = searchLibrary(EXERCISES, q);
      expect(hits.filter((e) => calfOnly.has(e.id)).map((e) => e.id), q).toEqual([]);
      expect(hits.filter(loads).map((e) => e.id), q).toEqual([]);
    }
    // A sore back finds back moves first.
    for (const q of ["sore back", "sore low back", "sore lower back"]) {
      const first = searchLibrary(EXERCISES, q)[0];
      expect(first?.regions.some((g) => g === "low-back" || g === "upper-back"), `${q}: ${first?.id}`).toBe(true);
    }
    expect(searchLibrary(EXERCISES, "sore lower back")[0]!.regions, "sore lower back").toContain("low-back");
    // Sore shins: what eases the shin muscle, not the hip stretches whose card lines rest a shin somewhere.
    const shins = searchLibrary(EXERCISES, "sore shins");
    expect(shins.map((e) => e.id)).toContain("ankleCircles");
    for (const e of shins) expect([...e.muscles.primary, ...e.muscles.secondary], e.id).toContain("tibialis");
  });

  test("\"tight calves\" lists what loosens the calves, never a hop", () => {
    const hits = searchLibrary(EXERCISES, "tight calves");
    expect(hits.map((e) => e.id)).toEqual(expect.arrayContaining([...STRETCHES, "calfRelease"]));
    expect(hits.filter(loads).map((e) => e.id)).toEqual([]);
  });
});
