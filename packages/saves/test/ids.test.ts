import { describe, expect, it } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import { isPersonalId, PERSONAL_ID_RE, personalMoveId } from "../src/index.js";

describe("personal ids", () => {
  it("matches the pattern and is stable", () => {
    const id = personalMoveId("90/90 Hip Switch", "u1:k1");
    expect(PERSONAL_ID_RE.test(id)).toBe(true);
    expect(isPersonalId(id)).toBe(true);
    expect(personalMoveId("90/90 Hip Switch", "u1:k1")).toBe(id);
  });
  it("different salts differ", () => {
    expect(personalMoveId("Hip Switch", "u1:k1")).not.toBe(personalMoveId("Hip Switch", "u1:k2"));
  });
  it("folds accents and is bounded", () => {
    const id = personalMoveId("Crème brûlée squat " + "word ".repeat(30), "s");
    expect(id.startsWith("myCremeBrulee")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(2 + 40 + 6);
    expect(PERSONAL_ID_RE.test(id)).toBe(true);
  });
  it("copes with names that give no words or start with a digit", () => {
    expect(PERSONAL_ID_RE.test(personalMoveId("!!!", "s"))).toBe(true);
    expect(PERSONAL_ID_RE.test(personalMoveId("", "s"))).toBe(true);
    expect(PERSONAL_ID_RE.test(personalMoveId("90/90", "s"))).toBe(true);
  });
  it("no library id looks personal", () => {
    expect(EXERCISES.filter((e) => PERSONAL_ID_RE.test(e.id))).toEqual([]);
    expect(isPersonalId("hipSwitch")).toBe(false);
  });
});
