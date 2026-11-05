/**
 * THE 2026-11-05 AUDIT, AS RULES: whether an athlete could do a move from its record. The public library must break none
 * of them (`validateRecord`); an owner's own move is never refused for them, because the edit form can't reach every
 * field and a refusal would lock the move against all its other edits (the import repairs or flags it instead).
 */
import { describe, expect, test } from "vitest";
import { EXERCISES, PROFILES, THEMES, countsPerSide, moveProblems, saysAlternating, saysOtherSide, saysToChangeSides, validateRecord, type ExerciseRecord } from "../src/index.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const withText = (r: ExerciseRecord, text: Partial<ExerciseRecord["text"]>): ExerciseRecord => ({ ...r, text: { ...r.text, ...text } });

describe("the rules", () => {
  test("the library breaks none of them", () => {
    expect(EXERCISES.flatMap((e) => moveProblems(e).map((p) => `${e.id}: ${p}`))).toEqual([]);
  });

  test("a lopsided setup is one-sided: half-kneeling or side-lying can't be alternating or bilateral", () => {
    expect(moveProblems({ ...rec("wallRotation"), laterality: "alternating" })).toContainEqual(expect.stringMatching(/half-kneeling setup is one-sided/));
    expect(moveProblems({ ...rec("sidePlank"), laterality: "bilateral" })).toContainEqual(expect.stringMatching(/side-lying setup is one-sided/));
  });

  test("words and fields agree on sides, either way", () => {
    expect(moveProblems(withText(rec("bridge"), { steps: ["Lift the hips.", "Switch sides."] }))).toContainEqual(expect.stringMatching(/says to change sides/));
    expect(moveProblems(withText(rec("figureFour"), { summary: "Cross an ankle.", setup: ["Lie down."], steps: ["Draw the legs in."] }))).toContainEqual(expect.stringMatching(/never says to do the other side/));
    expect(saysOtherSide("Let go slowly before switching sides.")).toBe(true);
    expect(saysOtherSide("Finish the reps, then turn to face the other way.")).toBe(true);
    expect(saysOtherSide("Repeat on the opposite side.")).toBe(true);
    // A foot each side of a door is no change of sides.
    expect(saysToChangeSides("Stand with a foot each side of the door.")).toBe(false);
  });

  test("an alternating move's line says the sides take turns: it plays as one exercise, so nothing else on screen will", () => {
    expect(moveProblems(withText(rec("deadBug"), { summary: "On your back, slowly lower opposite arm and leg." }))).toContainEqual(expect.stringMatching(/summary doesn't say the sides take turns/));
    for (const line of ["Lower one leg, alternating.", "Glide the jaw side to side.", "Turn to one shoulder, then the other.", "Hop from one foot to the other."]) {
      expect(saysAlternating(line), line).toBe(true);
    }
    // A leg that stays straight is no turn taken.
    expect(saysAlternating("Sit into one leg with the other straight.")).toBe(false);
    expect(EXERCISES.filter((e) => e.laterality === "alternating").length).toBeGreaterThan(0);
  });

  test("half-kneeling beside something: the card line says which knee is down, the owner's example", () => {
    const vague = withText(rec("wallRotation"), { summary: "Half-kneel beside a wall and turn the chest toward and away from it, hips still." });
    expect(moveProblems(vague)).toContainEqual(expect.stringMatching(/which knee is down/));
    expect(moveProblems(rec("wallRotation"))).toEqual([]);
    expect(moveProblems(rec("pallofIsoHoldHalfKneel"))).toEqual([]);
  });

  test("units: a relaxed hold isn't counted, and a stated hold fits its rep", () => {
    expect(moveProblems({ ...rec("figureFour"), dose: { type: "reps", range: [8, 12] } })).toContainEqual(expect.stringMatching(/passive move can't be counted/));
    const nod = rec("chinNodHold");
    expect(moveProblems({ ...nod, dose: { ...nod.dose, secsPerRep: 5 } })).toContainEqual(expect.stringMatching(/holds each rep for 10 seconds/));
    expect(moveProblems(nod)).toEqual([]);
  });

  test("the library refuses them; an owner's own move is not refused for them", () => {
    const bad: ExerciseRecord = { ...rec("wallRotation"), laterality: "alternating" };
    const base = { themes: THEMES, profiles: Object.values(PROFILES) };
    expect(validateRecord(bad, { ...base, knownIds: new Set(), mode: "library" })).toContainEqual(expect.stringMatching(/one-sided/));
    const own = { ...bad, id: "pm-wall-rotations-abc123" };
    expect(validateRecord(own, { ...base, knownIds: new Set(), mode: "personal", personalId: /^pm-/ })).toEqual([]);
  });
});

describe("what the audit changed", () => {
  test("the owner's example: both sides, the right knee, in the line the player shows", () => {
    const r = rec("wallRotation");
    expect(r.laterality).toBe("unilateral");
    expect(r.text.summary).toMatch(/far knee down/);
    expect(r.text.setup.join(" ")).toMatch(/front knee, nearest the wall, touches it/);
    expect(r.text.steps.join(" ")).toMatch(/other knee in front/);
  });

  test("a retired move still answers to its old id, so history and saved workouts resolve", () => {
    const merged: Readonly<Record<string, string>> = {
      plankBlock: "inclinePlank", bridgeBlock: "bridge", lowLungeBlock: "lowLunge", blockSideBend: "seatedSideBend", goldfishOpening: "jawOpen", wallHipTurns: "hip9090",
    };
    for (const [old, survivor] of Object.entries(merged)) {
      expect(EXERCISES.some((e) => e.id === old), old).toBe(false);
      expect(rec(survivor).legacyIds, old).toContain(old);
    }
  });

  test("a move's dose counts per side when it's counted, not when one window on a clock holds both sides", () => {
    expect(countsPerSide(rec("wallRotation"))).toBe(true);
    expect(countsPerSide(rec("deadBug"))).toBe(true);
    expect(countsPerSide(rec("thoracicFlow"))).toBe(false);
    expect(countsPerSide(rec("wallSitSingleLegShift"))).toBe(false);
    expect(countsPerSide(rec("bridge"))).toBe(false);
  });

  test("no two moves differ only by a prop: a new pair here is a duplicate unless it earns a reason", () => {
    const KEPT: Readonly<Record<string, string>> = {
      "childBlock|childHands": "the block holds the head higher and leaves the arms long, for stiff hips",
      "thoracicBlock|thoracicTowel": "a place with a towel has no block",
      "puppyBlock|puppyFloor": "raised hands open the shoulder further than forearms on the floor",
      "lineHopForwardBack|lineHopLateral": "another direction, and different ankle control",
    };
    const shape = (e: ExerciseRecord) =>
      JSON.stringify([e.family, e.position, e.laterality, e.load, e.difficulty, e.dose.type, e.dose.range, [...e.muscles.primary].sort()]);
    const pairs = EXERCISES.flatMap((a, i) => EXERCISES.slice(i + 1).filter((b) => shape(a) === shape(b)).map((b) => `${a.id}|${b.id}`));
    expect(pairs.sort()).toEqual(Object.keys(KEPT).sort());
  });

  test("every card line fits, and every name is its own", () => {
    for (const e of EXERCISES) expect(e.text.summary.length, e.id).toBeLessThanOrEqual(90);
    const names = EXERCISES.map((e) => e.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});
