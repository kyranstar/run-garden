/**
 * APPROVING A DESIGNED WORKOUT'S PROPOSAL (Stage 3 Task 8; spec §8).
 *
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { opIdOf } from "../src/services/proposal-kinds.js";

describe("an op's id", () => {
  it("is the run that designed it: each run holds one op of its main run's proposal", () => {
    expect(opIdOf({ by: { runId: "run-a" } })).toBe("run-a");
  });
});
