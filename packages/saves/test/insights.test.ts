import { describe, expect, it } from "vitest";
import { keepInsight } from "../src/index.js";

describe("keepInsight", () => {
  it("drops a restated dose, a description of a move and an empty one; keeps guidance", () => {
    expect(keepInsight("3 sets of 10 reps", [])).toBe(false);
    expect(keepInsight("Hold 30 seconds each side", [])).toBe(false);
    expect(keepInsight("Perform 3 sets of each movement to build spinal extension", ["Builds spinal extension through the upper back."])).toBe(false);
    expect(keepInsight("", [])).toBe(false);
    expect(keepInsight("Do these before a run to wake the hips", ["Opens the hips."])).toBe(true);
    expect(keepInsight("Good for desk workers who sit all day", ["Opens the hips."])).toBe(true);
    expect(keepInsight("Twice a week is enough", [])).toBe(true);
  });
});
