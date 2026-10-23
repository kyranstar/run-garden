import { describe, expect, it } from "vitest";
import { normalizeMoveName } from "../src/index.js";

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
