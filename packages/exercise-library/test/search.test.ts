import { describe, expect, test } from "vitest";
import { EXERCISES, searchLibrary } from "../src/index.js";

describe("searchLibrary", () => {
  test("an empty query and no filters returns every record, by name", () => {
    const all = searchLibrary(EXERCISES, "");
    expect(all).toHaveLength(EXERCISES.length);
    const names = all.map(e => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test("exact name first, then prefix, then contains", () => {
    const hits = searchLibrary(EXERCISES, "goblet squat");
    expect(hits[0]!.id).toBe("gobletSquat");
    const q = "squat";
    const tiers = searchLibrary(EXERCISES, q).map(e => (e.name.toLowerCase() === q ? 0 : e.name.toLowerCase().startsWith(q) ? 1 : 2));
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
  });

  test("filters combine, and the fit breaks ties before the name", () => {
    const hits = searchLibrary(EXERCISES, "", { purpose: "activation", maxDifficulty: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(e => e.purposes.includes("activation") && e.difficulty <= 2)).toBe(true);
    const first = hits[0]!.id;
    const ranked = searchLibrary(EXERCISES, "", { purpose: "activation", maxDifficulty: 2 }, { fit: e => (e.id === first ? 1 : 0) });
    expect(ranked[ranked.length - 1]!.id).toBe(first);
  });

  test("accepts narrows without disturbing the order", () => {
    const some = searchLibrary(EXERCISES, "", {}, { accepts: e => e.difficulty === 1 });
    expect(some.length).toBeGreaterThan(0);
    expect(some.every(e => e.difficulty === 1)).toBe(true);
  });
});
