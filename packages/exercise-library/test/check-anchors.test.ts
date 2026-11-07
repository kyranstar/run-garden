import { describe, expect, it } from "vitest";
import { PROFILES, TMJ, type CheckReading } from "../src/index.js";

// A check's scale carries short reference points ("what a 5 feels like"), in the profile's own words, so a sheet or a
// board row never has to hold them. They are few, ascending and inside the scale, and the flare point is the line the
// profile's own rule draws.

const at = (pre: number): CheckReading => ({ pre, post: null, feelingOff: false });

describe("every profile's check anchors", () => {
  it.each(Object.values(PROFILES).map((p) => [p.id, p] as const))("%s: at most four, whole numbers inside the scale, strictly ascending, each with words", (_id, p) => {
    const { anchors, min, max } = p.check;
    expect(anchors.length).toBeLessThanOrEqual(4);
    for (const a of anchors) {
      expect(Number.isInteger(a.value)).toBe(true);
      expect(a.value).toBeGreaterThanOrEqual(min);
      expect(a.value).toBeLessThanOrEqual(max);
      expect(a.words.trim()).toBe(a.words);
      expect(a.words.length).toBeGreaterThan(0);
      expect(a.words.length).toBeLessThanOrEqual(40);
    }
    expect(anchors.map((a) => a.value)).toEqual([...new Set(anchors.map((a) => a.value))].sort((x, y) => x - y));
  });
});

describe("the TMJ check's anchors", () => {
  it("are the four words, the flare point among them", () => {
    expect(TMJ.check.anchors).toEqual([
      { value: 0, words: "Nothing" },
      { value: 2, words: "There, easy to ignore" },
      { value: 5, words: "Bothering me: an easy day" },
      { value: 8, words: "Hard to eat or talk" },
    ]);
  });

  it("the anchor that says an easy day sits exactly where the profile's rule starts calling a day a flare", () => {
    const { min, max } = TMJ.check;
    const scale = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    const firstFlare = scale.find((n) => TMJ.flare(at(n)));
    expect(firstFlare).toBeDefined();
    expect(scale.filter((n) => TMJ.flare(at(n))).every((n) => n >= firstFlare!)).toBe(true);
    expect(TMJ.check.anchors.find((a) => a.value === firstFlare)?.words).toBe("Bothering me: an easy day");
    // …and no lower anchor claims it.
    expect(TMJ.check.anchors.filter((a) => a.value < firstFlare!).every((a) => !TMJ.flare(at(a.value)))).toBe(true);
  });
});
