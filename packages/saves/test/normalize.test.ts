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
