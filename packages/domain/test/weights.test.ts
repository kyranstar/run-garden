import { describe, expect, test } from "vitest";
import {
  LB_TO_KG, formatWeight, formatWeightIn, parseWeight, parseWeightList, sameWeight, toKg, userPreferencesSchema, weightInUnit, weightListProblem,
  withWeightUnit,
} from "../src/index.js";

// Ported from the standalone tests/units.test.js (Units.* → the named functions). Weights are kept in the
// unit they were typed in; comparisons happen in kg, with pounds at the exact definition.

describe("weights (units.test.js)", () => {
  test("parse accepts bare numbers in the default unit", () => {
    expect(parseWeight("26", "lb")).toEqual({ v: 26, u: "lb" });
    expect(parseWeight(" 12.5 ", "kg")).toEqual({ v: 12.5, u: "kg" });
  });

  test("parse accepts explicit units in many spellings", () => {
    expect(parseWeight("12kg", "lb")).toEqual({ v: 12, u: "kg" });
    expect(parseWeight("12 KG", "lb")).toEqual({ v: 12, u: "kg" });
    expect(parseWeight("26 lbs", "kg")).toEqual({ v: 26, u: "lb" });
    expect(parseWeight("26lb", "kg")).toEqual({ v: 26, u: "lb" });
    expect(parseWeight("35 pounds", "kg")).toEqual({ v: 35, u: "lb" });
    expect(parseWeight("20 kilos", "lb")).toEqual({ v: 20, u: "kg" });
  });

  test("parse rejects junk and non-positive weights", () => {
    expect(parseWeight("", "lb")).toBe(null);
    expect(parseWeight("abc", "lb")).toBe(null);
    expect(parseWeight("0", "lb")).toBe(null);
    expect(parseWeight("-5 kg", "lb")).toBe(null);
    expect(parseWeight("12 stone", "lb")).toBe(null);
  });

  test("toKg and inUnit convert both ways", () => {
    expect(toKg({ v: 12, u: "kg" })).toBe(12);
    expect(Math.abs(toKg({ v: 26.4555, u: "lb" }) - 12)).toBeLessThan(0.001);
    expect(weightInUnit({ v: 12, u: "kg" }, "lb")).toBe(26.5);
    expect(weightInUnit({ v: 25, u: "lb" }, "lb")).toBe(25);
  });

  test("format shows the entered unit and trims trailing zeros", () => {
    expect(formatWeight({ v: 25, u: "lb" })).toBe("25 lb");
    expect(formatWeight({ v: 12.5, u: "kg" })).toBe("12.5 kg");
    expect(formatWeightIn({ v: 12, u: "kg" }, "lb")).toBe("26.5 lb");
    expect(formatWeightIn({ v: 25, u: "lb" }, "kg")).toBe("11.5 kg");
  });

  test("parseList applies a trailing unit to every number and sorts by weight", () => {
    expect(parseWeightList("20, 8, 12 lb", "kg")).toEqual([{ v: 8, u: "lb" }, { v: 12, u: "lb" }, { v: 20, u: "lb" }]);
  });

  test("parseList handles mixed units and drops duplicates and junk", () => {
    // 26 lb ≈ 11.8 kg, so it sorts before 12 kg
    expect(parseWeightList("12kg, 16 kg, 26lb, 12 kg, x", "lb")).toEqual([{ v: 26, u: "lb" }, { v: 12, u: "kg" }, { v: 16, u: "kg" }]);
  });

  test("same compares weights across units", () => {
    expect(sameWeight({ v: 12, u: "kg" }, { v: 26.455, u: "lb" })).toBe(true);
    expect(sameWeight({ v: 12, u: "kg" }, { v: 25, u: "lb" })).toBe(false);
  });
});

describe("a typed list read the way it was written (Phase 2c Review Focus 3)", () => {
  test("a bare number takes the unit written after it, so each part keeps its own unit", () => {
    expect(parseWeightList("10, 15, 20 lb, 12kg", "kg")).toEqual([
      { v: 10, u: "lb" },
      { v: 15, u: "lb" },
      { v: 20, u: "lb" },
      { v: 12, u: "kg" },
    ]);
    // With no unit after it, the default unit.
    expect(parseWeightList("12 kg, 16", "lb")).toEqual([{ v: 16, u: "lb" }, { v: 12, u: "kg" }]);
    expect(parseWeightList("8, 12, 16", "kg")).toEqual([{ v: 8, u: "kg" }, { v: 12, u: "kg" }, { v: 16, u: "kg" }]);
  });

  test("weightListProblem says what a list cannot hold, and nothing for one it can", () => {
    expect(weightListProblem("10, 15, 20 lb, 12kg")).toBeNull();
    expect(weightListProblem("8 12 16 kg")).toBeNull();
    expect(weightListProblem("  ")).toBe("empty");
    expect(weightListProblem("light, heavy")).toBe("light");
    expect(weightListProblem("10, 12 stone")).toBe("12 stone");
    expect(weightListProblem("10, x, 20 lb")).toBe("x");
    expect(weightListProblem("0, 10 lb")).toBe("0");
  });

  test("a list typed with no unit anywhere is kept with the unit then in force; one that names a unit is kept as typed (Audit 2c-A MINOR-4)", () => {
    expect(withWeightUnit("10, 15, 20", "kg")).toBe("10, 15, 20 kg");
    expect(withWeightUnit(" 8 12 16 ", "lb")).toBe("8 12 16 lb");
    expect(withWeightUnit("10, 15, 20 lb, 12kg", "kg")).toBe("10, 15, 20 lb, 12kg");
    expect(withWeightUnit("12 kg, 16", "lb")).toBe("12 kg, 16");
    expect(withWeightUnit("25#", "kg")).toBe("25#");
    // Read back in any unit, it means what it meant when it was typed.
    expect(parseWeightList(withWeightUnit("10, 15, 20", "kg"), "lb")).toEqual([{ v: 10, u: "kg" }, { v: 15, u: "kg" }, { v: 20, u: "kg" }]);
  });
});

describe("weights — the exact pound", () => {
  test("a pound is exactly 0.45359237 kg", () => {
    expect(LB_TO_KG).toBe(0.45359237);
    expect(toKg({ v: 1, u: "lb" })).toBe(0.45359237);
    expect(toKg({ v: 100, u: "lb" })).toBeCloseTo(45.359237, 10);
  });

  test("sameWeight's tolerance is 0.05 kg", () => {
    expect(sameWeight({ v: 11.35, u: "kg" }, { v: 25, u: "lb" })).toBe(true);    // 25 lb = 11.3398 kg
    expect(sameWeight({ v: 11.4, u: "kg" }, { v: 25, u: "lb" })).toBe(false);
  });
});

describe("preferences", () => {
  test("weightUnit defaults to lb and the equipment wishlist to empty", () => {
    const prefs = userPreferencesSchema.parse({});
    expect(prefs.weightUnit).toBe("lb");
    expect(prefs.equipmentWishlist).toEqual([]);
    expect(userPreferencesSchema.parse({ weightUnit: "kg", equipmentWishlist: ["band"] })).toMatchObject({ weightUnit: "kg", equipmentWishlist: ["band"] });
    expect(() => userPreferencesSchema.parse({ weightUnit: "stone" })).toThrow();
  });
});
