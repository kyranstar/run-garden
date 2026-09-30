import { describe, expect, it } from "vitest";
import { isRunning } from "../src/workout.js";

describe("isRunning", () => {
  it("does not count yoga as a run", () => {
    expect(isRunning({ category: "yoga" })).toBe(false);
  });
  it("counts easy runs", () => {
    expect(isRunning({ category: "easy" })).toBe(true);
  });
});
