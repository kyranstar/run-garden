/**
 * A MOVE THAT SAYS IT JUMPS (the safety audit, 2026-11-06, S2 and S3). The condition gates read a jump only through its
 * plyometric contraction (`isPlyometric`): a reader model that called an imported "Pogo hops" isotonic, or a free-text
 * "Box jumps" with no record at all, went past them. `plyometricWord` is the deterministic check both use: the word in a
 * move's name — or, narrower, in its summary and steps — that says it hops, jumps, bounds or lands; none when a word is
 * taken back ("no-jump", "don't jump", "without hopping"). The public library is its test bed: every plyometric record's
 * name says so, and no other record's does.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES, isPlyometric, plyometricWord } from "../src/index.js";

describe("plyometricWord — the words that say a move jumps", () => {
  it("finds the word in a name: hop, jump, bound, pogo, skip, depth, box jump, landing, leap, plyo, burpee, snap-down", () => {
    const cases: Array<[string, string]> = [
      ["Pogo hops", "pogo"],
      ["Box jump, step down", "jump"],
      ["Depth drop", "depth drop"],
      ["Lateral bounds", "bounds"],
      ["A-skips", "skips"],
      ["Skipping rope", "skipping"],
      ["Single-leg hop and stick", "hop"],
      ["Drop landing", "landing"],
      ["Split leaps", "leaps"],
      ["Plyo push-up", "plyo"],
      ["Burpees", "burpees"],
      ["Snap-down", "snap down"],
      ["Jumping jacks", "jumping"],
      ["Double unders", "double unders"],
      ["Zorbex tuck jumps", "jumps"],
    ];
    for (const [name, word] of cases) expect(plyometricWord(name), name).toBe(word);
  });

  it("none in a name that doesn't jump, nor a word taken back", () => {
    for (const name of ["Skater squat", "Goblet squat", "Hip hinge drill", "Landmine press", "Box step-up", "Bounded breathing? no", "No-jump burpee", "Low-impact jumping jacks", "Squat (no jump)"]) {
      expect(plyometricWord(name), name).toBeNull();
    }
  });

  it("reads the summary and steps for the plain words only — a jump, a hop, a bound — never skip or landing there", () => {
    expect(plyometricWord("Zorbex explosive squat", "Sink into a squat, then jump as high as you can.")).toBe("jump");
    expect(plyometricWord("Zorbex lunge switch", "Hop to switch legs in the air.")).toBe("hop");
    expect(plyometricWord("Zorbex hip flow", "Skip this if your knees hurt. Land the hips softly on the mat.")).toBeNull();
    expect(plyometricWord("Zorbex step-back", "Step back, don't jump. Keep it slow.")).toBeNull();
    expect(plyometricWord("Zorbex squat", "Without jumping, rise onto the toes.")).toBeNull();
  });

  it("the public library: every plyometric record's name says so, and no other record's does", () => {
    for (const ex of EXERCISES) {
      expect(plyometricWord(ex.name) !== null, `${ex.id} (${ex.name})`).toBe(isPlyometric(ex));
    }
  });
});
