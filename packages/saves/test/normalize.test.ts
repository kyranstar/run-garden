import { describe, expect, it } from "vitest";
import { nearDuplicateOf, normalizeMoveName, sameMoveType, type NearCandidate } from "../src/index.js";

describe("normalizeMoveName", () => {
  it("maps spellings of one move to one string", () => {
    const a = normalizeMoveName("90/90 Hip Switch");
    expect(a).toBe("90 90 hip switch");
    expect(normalizeMoveName("90-90 hip switches")).toBe(a);
    expect(normalizeMoveName("the 90 90 hip switch")).toBe(a);
  });
  it("folds accents, drops stop words, collapses spaces", () => {
    expect(normalizeMoveName("  Café_Lunge with  your Band ")).toBe("cafe lunge band");
    expect(normalizeMoveName("A Glute Bridges")).toBe("glute bridge");
    expect(normalizeMoveName("Lunges")).toBe("lunge");
  });
  it("reads a plural as its singular, whatever letter the singular ends on (audit bug 1)", () => {
    const same: Array<[string, string]> = [
      ["Calf raises", "Calf raise"],
      ["Rib releases", "Rib release"],
      ["Child's poses", "Child's pose"],
      ["Glute squeezes", "Glute squeeze"],
      ["Hip circles", "Hip circle"],
      ["Box jumps", "Box jump"],
      ["Bench presses", "Bench press"],
      ["Pushes", "Push"],
      ["Boxes", "Box"],
      ["Crunches", "Crunch"],
      ["Lateral raises", "Lateral raise"],
    ];
    for (const [plural, singular] of same) expect(normalizeMoveName(plural), plural).toBe(normalizeMoveName(singular));
    expect(normalizeMoveName("Calf raises")).toBe("calf raise");
    expect(normalizeMoveName("Rib releases")).toBe("rib release");
  });
  it("keeps the s of a word that isn't a plural", () => {
    expect(normalizeMoveName("Bench press")).toBe("bench press");
    expect(normalizeMoveName("Cross crawl")).toBe("cross crawl");
    expect(normalizeMoveName("Abs roll")).toBe("abs roll");
    expect(normalizeMoveName("Zorbex torus hold")).toBe("zorbex torus hold");
  });
});

describe("nearDuplicateOf", () => {
  const m = (name: string, over: Partial<NearCandidate> = {}): NearCandidate => ({ id: name, name, load: "none", doseType: "reps", ...over });
  it("finds near names and refuses far ones", () => {
    expect(nearDuplicateOf(m("Zorbex dynamic rotational swing"), [m("Zorbex rotational swing")])?.id).toBe("Zorbex rotational swing");
    expect(nearDuplicateOf(m("Zorbex cobra chest lift"), [m("Zorbex cobra hold")])?.id).toBe("Zorbex cobra hold");
    expect(nearDuplicateOf(m("Zorbex leg glute bridge"), [m("Zorbex leg calf raise")])).toBeNull();
    expect(nearDuplicateOf(m("Zorbex bug"), [m("Zorbex hang")])).toBeNull();
    expect(nearDuplicateOf(m("Zorbex plank", { load: "external" }), [m("Zorbex plank")])?.id).toBe("Zorbex plank");
  });
  it("prefers the largest overlap, then pool order", () => {
    const a = m("Zorbex cobra hold"), b = m("Zorbex cobra chest hold");
    expect(nearDuplicateOf(m("Zorbex cobra chest lift"), [a, b])?.id).toBe(b.id);
    expect(nearDuplicateOf(m("Zorbex cobra lift"), [m("Zorbex cobra hold"), m("Zorbex cobra reach")])?.id).toBe("Zorbex cobra hold");
  });
  it("sameMoveType differs only when both are known and unequal", () => {
    expect(sameMoveType(m("a", { load: "external" }), m("b"))).toBe(false);
    expect(sameMoveType(m("a", { doseType: null }), m("b"))).toBe(true);
    expect(sameMoveType(m("a", { load: null }), m("b"))).toBe(true);
  });
});
