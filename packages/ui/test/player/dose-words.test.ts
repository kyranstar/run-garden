/** The player's words for a dose: the audit's "wrong units", and a move that never said it has two sides. */
import { describe, expect, it } from "vitest";
import { eachSide, eachSideOnTimer, setMetric } from "../../src/player/dose-words.js";

const move = (laterality: string, type = "reps") => ({ laterality, dose: { type } });

describe("a set's unit", () => {
  it("is what the move is counted in: breaths are never reps, a hold or a carry is seconds", () => {
    expect(setMetric(move("bilateral", "breaths"))).toBe("breaths");
    expect(setMetric(move("bilateral", "time"))).toBe("s");
    expect(setMetric(move("unilateral", "carry"))).toBe("s");
    expect(setMetric(move("bilateral", "reps"))).toBe("reps");
    expect(setMetric(undefined)).toBe("reps");
  });

  it("reps asked of a timed move are reps: a coach's slow reps of a hold never read 8–12 s", () => {
    expect(setMetric(move("bilateral", "carry"), { type: "reps" })).toBe("reps");
    expect(setMetric(move("bilateral", "time"), { reps: 8 })).toBe("reps");
    expect(setMetric(move("bilateral", "carry"), { type: "carry", reps: null })).toBe("s");
    expect(setMetric(move("bilateral", "time"), null)).toBe("s");
  });
});

describe("each side", () => {
  it("a counted set says it for a one-sided or an alternating move", () => {
    expect(eachSide(move("unilateral"))).toBe(" each side");
    expect(eachSide(move("alternating"))).toBe(" each side");
    expect(eachSide(move("bilateral"))).toBe("");
    expect(eachSide(undefined)).toBe("");
  });

  it("a timer says it only for a one-sided move: an alternating move's one window holds both sides", () => {
    expect(eachSideOnTimer(move("unilateral", "time"))).toBe(" each side");
    expect(eachSideOnTimer(move("alternating", "time"))).toBe("");
    expect(eachSideOnTimer(move("bilateral", "time"))).toBe("");
  });
});
