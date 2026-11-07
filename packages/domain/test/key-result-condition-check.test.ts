import { describe, expect, it } from "vitest";
import { canonicalUnitOf, defaultUnitFor, keyResultCreateSchema, keyResultMeasureSchema, naturalDirection, unitsFor } from "../src/index.js";

// A key result can measure a condition's daily 0-10 check: the mean of a profile's daily rows over a window of 7 to 60
// days. Lower is better, in the `score` unit.

describe("the condition_check measure", () => {
  const m = (over: object = {}) => ({ kind: "condition_check", profileId: "p-x", windowDays: 14, ...over });

  it("is a profile and a window of 7 to 60 days, 14 when none is given", () => {
    expect(keyResultMeasureSchema.parse(m())).toEqual(m());
    expect(keyResultMeasureSchema.parse({ kind: "condition_check", profileId: "p-x" })).toEqual(m());
    for (const days of [7, 60]) expect(keyResultMeasureSchema.safeParse(m({ windowDays: days })).success).toBe(true);
    for (const days of [6, 61, 90, 7.5]) expect(keyResultMeasureSchema.safeParse(m({ windowDays: days })).success).toBe(false);
  });

  it("needs a profile id, and takes nothing else", () => {
    expect(keyResultMeasureSchema.safeParse({ kind: "condition_check", windowDays: 14 }).success).toBe(false);
    expect(keyResultMeasureSchema.safeParse(m({ profileId: "" })).success).toBe(false);
    expect(keyResultMeasureSchema.safeParse(m({ questionId: "q" })).success).toBe(false);
  });

  it("is a score where lower is better", () => {
    const measure = keyResultMeasureSchema.parse(m());
    expect(canonicalUnitOf(measure)).toBe("score");
    expect(naturalDirection(measure)).toBe("down");
    expect(unitsFor(measure)).toEqual(["score"]);
    expect(defaultUnitFor(measure, { weightUnit: "kg", units: "km" })).toBe("score");
  });

  it("as a key result: direction is optional but must be down, and the unit must be score", () => {
    const kr = (over: object) => keyResultCreateSchema.safeParse({ label: "Calmer days", measure: m(), target: 2, ...over });
    expect(kr({}).success).toBe(true);
    expect(kr({ direction: "down", unit: "score" }).success).toBe(true);
    expect(kr({ direction: "up" }).success).toBe(false);
    expect(kr({ unit: "s" }).success).toBe(false);
  });
});
