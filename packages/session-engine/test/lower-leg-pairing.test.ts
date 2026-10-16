import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Swapping } from "../src/index.js";

// R10 fix round 1: a calf raise lifts the heels and a tibialis raise lifts the toes, opposite movements with patterns of
// their own. So the two pair in a superset (the engine pairs moves that share no pattern), while two calf raises,
// sharing theirs, never do.

const rec = (id: string): ExerciseRecord => {
  const r = EXERCISES.find((e) => e.id === id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};
const pairable = (a: string, b: string) => Swapping.pairable(Swapping.pairingOf(rec(a)), Swapping.pairingOf(rec(b)));
const CALF_RAISES = ["calfRaise", "bentKneeCalfRaise", "eccentricHeelDrop", "singleLegCalfRaise"];

describe("the calf raises and the tibialis raise in a superset", () => {
  test("every standing calf raise pairs with the tibialis raise: front and back of the lower leg, back to back", () => {
    for (const id of CALF_RAISES) expect(pairable(id, "tibialisRaise"), id).toBe(true);
  });

  test("two calf raises never pair: they share their pattern", () => {
    for (const a of CALF_RAISES) for (const b of CALF_RAISES) if (a !== b) expect(pairable(a, b), `${a} + ${b}`).toBe(false);
  });
});
