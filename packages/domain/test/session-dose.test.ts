/**
 * A built session's moves in words (Phase 2a Tasks 6–7): the dose line under each move in the session sheet, and
 * the Today card's lead — one formatter, so the two can never disagree.
 */
import { describe, expect, it } from "vitest";
import { doseText, secondsText, sessionLead, type DoseStep, type DoseTarget } from "../src/session-dose.js";

const set = (over: Partial<DoseStep> = {}): DoseStep => ({ slotKey: "core:0", kind: "set", seconds: 50, side: null, setCount: 3, ...over });
const timed = (over: Partial<DoseStep> = {}): DoseStep => ({ slotKey: "prep:0", kind: "timed", seconds: 45, side: null, setCount: 1, ...over });
const target = (over: Partial<DoseTarget> = {}): DoseTarget => ({ lo: 6, hi: 10, type: "reps", w: null, reps: 6, secs: null, action: "start", ...over });

describe("secondsText", () => {
  it("reads seconds under two minutes as seconds, whole minutes as minutes, the rest as both", () => {
    expect(secondsText(45)).toBe("45 s");
    expect(secondsText(90)).toBe("90 s");
    expect(secondsText(120)).toBe("2 min");
    expect(secondsText(150)).toBe("2 min 30 s");
  });
});

describe("doseText", () => {
  it("a lift: sets × reps @ the weight as typed", () => {
    const steps = [set(), set(), set()];
    expect(doseText({ sets: 3, steps, target: target({ w: { v: 30, u: "lb" } }), perSide: false })).toBe("3 × 6 @ 30 lb");
  });

  it("a one-sided lift says each side; a bodyweight one has no weight", () => {
    expect(doseText({ sets: 3, steps: [set()], target: target({ reps: 10, w: { v: 12.5, u: "kg" } }), perSide: true })).toBe(
      "3 × 10 @ 12.5 kg each side",
    );
    expect(doseText({ sets: 2, steps: [set()], target: target({ reps: 8 }), perSide: false })).toBe("2 × 8");
  });

  it("a timed hold set reads its seconds", () => {
    expect(doseText({ sets: 3, steps: [set()], target: target({ type: "time", reps: null, secs: 30, lo: 30, hi: 40 }), perSide: false })).toBe("3 × 30 s");
    expect(doseText({ sets: 1, steps: [timed({ seconds: 30 })], target: target({ type: "time", reps: null, secs: 30 }), perSide: false })).toBe("30 s");
  });

  it("a timed move reads its window, each side when it is played per side", () => {
    expect(doseText({ sets: 1, steps: [timed({ seconds: 90 })], target: null, perSide: false })).toBe("90 s");
    expect(
      doseText({ sets: 1, steps: [timed({ seconds: 40, side: "Left" }), timed({ seconds: 40, side: "Right" })], target: null, perSide: true }),
    ).toBe("40 s each side");
  });

  it("a timed move played in rounds says how many", () => {
    expect(doseText({ sets: 1, steps: [timed({ seconds: 40 }), timed({ seconds: 40 })], target: null, perSide: false })).toBe("2 × 40 s");
  });

  it("a set with no target falls back to its count", () => {
    expect(doseText({ sets: 3, steps: [set()], target: null, perSide: false })).toBe("3 sets");
  });
});

describe("sessionLead", () => {
  const build = {
    items: [
      { slotKey: "prep:0", block: "prep", exerciseId: "catCow", sets: 1 },
      { slotKey: "core:0", block: "core", exerciseId: "goblet", sets: 3 },
      { slotKey: "core:1", block: "core", exerciseId: "kbDeadlift", sets: 3 },
      { slotKey: "accessory:0", block: "accessory", exerciseId: "birdDog", sets: 2 },
    ],
    steps: [
      timed({ slotKey: "prep:0", seconds: 50 }),
      set({ slotKey: "core:0" }),
      set({ slotKey: "core:1" }),
      set({ slotKey: "accessory:0" }),
    ],
    targets: {
      goblet: target({ w: { v: 30, u: "lb" }, action: "up" }),
      kbDeadlift: target({ reps: 8 }),
      birdDog: target({ reps: 6 }),
    },
    exercises: {
      catCow: { name: "Cat-cow", laterality: "bilateral" },
      goblet: { name: "Goblet squat", laterality: "bilateral" },
      kbDeadlift: { name: "KB deadlift", laterality: "bilateral" },
      birdDog: { name: "Bird dog", laterality: "alternating" },
    },
  };

  it("leads with the core lifts, marks one going up, and counts the rest", () => {
    expect(sessionLead(build)).toEqual({
      moves: [
        { name: "Goblet squat", dose: "3 × 6 @ 30 lb", up: true },
        { name: "KB deadlift", dose: "3 × 8", up: false },
      ],
      more: 2,
    });
  });

  it("a session with no core lift leads with its first moves", () => {
    const yoga = { ...build, items: [build.items[0]!, build.items[3]!] };
    expect(sessionLead(yoga)).toEqual({
      moves: [
        { name: "Cat-cow", dose: "50 s", up: false },
        { name: "Bird dog", dose: "2 × 6", up: false },
      ],
      more: 0,
    });
  });

  it("a move the slice does not name is skipped rather than printed as an id", () => {
    const odd = { ...build, exercises: { ...build.exercises, goblet: undefined } };
    expect(sessionLead(odd).moves.map((m) => m.name)).toEqual(["KB deadlift", "Cat-cow"]);
  });
});
