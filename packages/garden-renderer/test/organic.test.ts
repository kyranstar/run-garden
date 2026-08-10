import { describe, expect, it } from "vitest";
import { rng } from "@rg/garden-engine";
import { blobPath, wobbleLine } from "../src/organic";

describe("organic helpers", () => {
  it("blobPath is deterministic, closed, and finite", () => {
    const a = blobPath(rng("t:blob"), 0, -40, 30, 22);
    expect(a).toBe(blobPath(rng("t:blob"), 0, -40, 30, 22));
    expect(a.endsWith("Z")).toBe(true);
    expect(a).not.toMatch(/NaN|Infinity/);
  });

  it("blobPath consumes a fixed draw count so neighbors don't reshuffle", () => {
    const r1 = rng("t:count");
    blobPath(r1, 0, 0, 10, 10, 0.3, 9);
    const r2 = rng("t:count");
    for (let i = 0; i < 9; i++) r2();
    expect(r1()).toBe(r2());
  });

  it("wobbleLine stays within amp of the straight line", () => {
    // Vertical line: every x coordinate in the path is the perpendicular jitter.
    const d = wobbleLine(rng("t:wl"), 0, 0, 0, -60, 5, 3);
    const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)];
    expect(coords.length).toBeGreaterThan(2);
    for (const [, x] of coords) expect(Math.abs(Number(x))).toBeLessThanOrEqual(3.5);
  });

  it("wobbleLine lands exactly on its endpoint", () => {
    const d = wobbleLine(rng("t:wl2"), 3, 4, -20, -50, 4, 2);
    expect(d.endsWith("L-20,-50")).toBe(true);
  });
});
