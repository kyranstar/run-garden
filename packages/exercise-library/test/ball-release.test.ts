import { describe, expect, test } from "vitest";
import { BALL_RELEASE } from "../src/exercises/ball-release.js";
import {
  EQUIPMENT,
  EXERCISES,
  LOCATION_PRESETS,
  hasEquipment,
  makeEngineData,
  moveProblems,
  searchLibrary,
  validateLibrary,
  type EquipmentId,
  type ExerciseRecord,
} from "../src/index.js";

// What the evidence review decided (docs/research/2026-11-05-self-release-evidence.md), so a later tidy-up can't undo it.

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const uses = (e: ExerciseRecord, gear: EquipmentId) => [...e.equipment.all, ...e.equipment.oneOf].includes(gear);
const BALL_MOVES = EXERCISES.filter((e) => uses(e, "massage-ball"));
const words = (e: ExerciseRecord) => [...e.text.setup, ...e.text.steps, ...e.text.focus, ...e.text.mistakes].join(" ");

describe("the gear", () => {
  test("a lacrosse ball is the massage ball, with no gear id of its own", () => {
    expect(EQUIPMENT["massage-ball"]).toMatch(/lacrosse/i);
    expect(Object.keys(EQUIPMENT).filter((id) => /lacrosse/.test(id))).toEqual([]);
  });

  test("searching for it by its everyday name finds the moves that use it", () => {
    const hits = searchLibrary(EXERCISES, "lacrosse ball");
    expect(hits.length).toBe(BALL_MOVES.length);
    for (const e of hits) expect(uses(e, "massage-ball"), e.id).toBe(true);
  });

  test("no preset holds the ball, so an athlete has it only once they say so", () => {
    for (const place of LOCATION_PRESETS) expect(place.equipment, place.id).not.toContain("massage-ball");
  });
});

describe("the moves", () => {
  test("the library validates with them and each one reads as a move", () => {
    expect(validateLibrary(makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES }))).toEqual([]);
    for (const e of BALL_RELEASE) expect(moveProblems(e), e.id).toEqual([]);
  });

  test("each is a passive release on a timer, with no load and nothing pressing on the jaw or the face", () => {
    for (const e of BALL_RELEASE) {
      expect(e.patterns, e.id).toEqual(["release"]);
      expect(e.contraction, e.id).toEqual(["passive"]);
      expect(e.load, e.id).toBe("none");
      expect(e.conditions.tmj, e.id).toEqual({ clench: 0, neckLoad: 0, faceDown: false });
    }
  });

  test("every ball move plays the 90 seconds a site below which the evidence shows little, and can drop to a minute", () => {
    for (const e of BALL_MOVES) {
      expect(e.dose.type, e.id).toBe("time");
      expect(e.dose.range, e.id).toEqual([60, 120]);
    }
  });

  test("every ball move names the signs to stop for", () => {
    for (const e of BALL_MOVES) expect(e.text.mistakes.join(" "), e.id).toMatch(/tingl\w*.*numb/i);
  });

  test("a focus-worthy site can lead a cool-down; the sites the evidence calls optional can't", () => {
    const leads = EXERCISES.filter((e) => e.roles.includes("release")).map((e) => e.id).sort();
    expect(leads).toEqual([
      "massageBallDeepHip", "massageBallFrontHip", "massageBallGlute", "massageBallHamstring", "massageBallOuterHip", "massageBallShoulderBlade", "massageBallUpperBack",
    ]);
    for (const id of leads) expect(rec(id).roles, id).toContain("cooldown");
    for (const id of ["massageBallFoot", "massageBallPec", "calfRelease", "massageBallTraps"]) expect(rec(id).roles, id).not.toContain("release");
  });

  test("only the sites safe at any point can land in a warm-up", () => {
    const warm = BALL_MOVES.filter((e) => e.roles.includes("mobility")).map((e) => e.id).sort();
    expect(warm).toEqual(["calfRelease", "massageBallFoot", "massageBallShoulderBlade", "massageBallUpperBack"]);
  });

  test("the hip moves come up in the hip opener and the desk moves in a desk reset", () => {
    for (const id of ["massageBallFrontHip", "massageBallOuterHip", "massageBallDeepHip", "massageBallGlute"]) expect(rec(id).tags, id).toContain("hip-opening");
    for (const id of ["massageBallFrontHip", "massageBallHamstring", "massageBallUpperBack", "massageBallShoulderBlade", "massageBallPec"]) expect(rec(id).tags, id).toContain("desk-relief");
  });
});

describe("the limits", () => {
  test("no ball move works the sites a firm ball doesn't belong on", () => {
    for (const e of BALL_MOVES) {
      expect(e.muscles.primary, e.id).not.toContain("masseter");
      expect(e.muscles.primary, e.id).not.toContain("temporalis");
      expect(e.muscles.primary, e.id).not.toContain("quadratus-lumborum");
      expect(e.muscles.primary, e.id).not.toContain("sternocleidomastoid");
      expect(e.muscles.primary, e.id).not.toContain("scalenes");
      expect(e.regions, e.id).not.toContain("jaw");
      expect(e.regions, e.id).not.toContain("low-back");
    }
  });

  test("the jaw's ball move is retired into the fingertip massage, keeping its history", () => {
    expect(rec("massageBallJaw")).toBeUndefined();
    expect(rec("jawMassage").legacyIds).toContain("massageBallJaw");
    expect(rec("jawMassage").equipment).toEqual({ all: [], oneOf: [] });
  });

  test("each move near a danger zone names it", () => {
    expect(words(rec("massageBallFrontHip"))).toMatch(/belly or the hip crease/);
    expect(words(rec("massageBallOuterHip"))).toMatch(/IT band/);
    expect(words(rec("massageBallDeepHip"))).toMatch(/sciatic nerve/);
    expect(words(rec("massageBallHamstring"))).toMatch(/behind the knee/);
    expect(words(rec("massageBallUpperBack"))).toMatch(/kidneys/);
    expect(words(rec("massageBallUpperBack"))).toMatch(/onto the neck/);
    expect(words(rec("massageBallShoulderBlade"))).toMatch(/back of the upper arm/);
    expect(words(rec("massageBallTraps"))).toMatch(/side or front of the neck/);
    expect(words(rec("massageBallPec"))).toMatch(/armpit/);
    expect(words(rec("calfRelease"))).toMatch(/hot, swollen/);
  });

  test("no move promises more than the evidence does: no tissue change, no posture fix, no effect on the jaw", () => {
    for (const e of BALL_MOVES) {
      expect(`${e.text.summary} ${e.text.why}`, e.id).not.toMatch(/fascia|lengthen|realign|break(?:s)? up|knots?\b|feed|pulls? the/i);
      expect(e.text.why, e.id).not.toMatch(/\bjaw\b/i);
    }
  });

  test("no gear beyond what a home can hold", () => {
    const home = LOCATION_PRESETS.find((l) => l.id === "home")!.equipment;
    for (const e of BALL_RELEASE) expect(hasEquipment(e, [...home, "massage-ball"]), e.id).toBe(true);
  });
});
