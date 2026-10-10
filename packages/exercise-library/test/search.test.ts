import { describe, expect, test } from "vitest";
import { EXERCISES, searchLibrary, textTier } from "../src/index.js";

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

  test("a typo of one edit in a word of five or more letters still finds the move", () => {
    const ids = (q: string) => searchLibrary(EXERCISES, q).map(e => e.id);
    expect(ids("gobelt")).toContain("gobletSquat"); // two letters swapped
    expect(ids("goblot")).toContain("gobletSquat"); // one letter wrong
    expect(ids("goblt")).toContain("gobletSquat"); // one letter missing
    expect(ids("gobleet")).toContain("gobletSquat"); // one letter extra
    expect(ids("gobelt squat")[0]).toBe("gobletSquat");
    expect(ids("deadlfit")).toEqual(expect.arrayContaining(["deadlift", "suitcaseDeadlift"]));
  });

  test("no tolerance past one edit, or on a word shorter than five letters", () => {
    expect(searchLibrary(EXERCISES, "gbolte").map(e => e.id)).not.toContain("gobletSquat"); // two swaps
    expect(searchLibrary(EXERCISES, "lnge")).toEqual([]); // four letters: exact only
    expect(searchLibrary(EXERCISES, "squt")).toEqual([]);
  });

  test("a typo match ranks after every exact match", () => {
    const goblet = EXERCISES.find(e => e.id === "gobletSquat")!;
    expect(textTier(goblet, "goblet")).toBe(1);
    expect(textTier(goblet, "gobelt")).toBe(3);
    expect(textTier(goblet, "gbolte")).toBeNull();
    const hits = searchLibrary(EXERCISES, "bridge");
    const exact = hits.filter(e => textTier(e, "bridge")! < 3).length;
    expect(hits.slice(0, exact).every(e => textTier(e, "bridge")! < 3)).toBe(true);
  });

  test("words match in any order, and through muscle, region, purpose and gear labels", () => {
    expect(searchLibrary(EXERCISES, "squat goblet")[0]!.id).toBe("gobletSquat");
    const deepAbs = searchLibrary(EXERCISES, "deep abdominals");
    expect(deepAbs.length).toBeGreaterThan(0);
    expect(deepAbs.every(e => [...e.muscles.primary, ...e.muscles.secondary].includes("transverse-abdominis"))).toBe(true);
    expect(searchLibrary(EXERCISES, "foam roller").every(e => [...e.equipment.all, ...e.equipment.oneOf].includes("foam-roller"))).toBe(true);
    expect(searchLibrary(EXERCISES, "foam roller").length).toBeGreaterThan(0);
    expect(searchLibrary(EXERCISES, "cool-down").map(e => e.id)).toEqual(expect.arrayContaining(EXERCISES.filter(e => e.purposes.includes("cooldown")).map(e => e.id)));
  });

  test("accepts narrows without disturbing the order", () => {
    const everything = searchLibrary(EXERCISES, "");
    const some = searchLibrary(EXERCISES, "", {}, { accepts: e => e.difficulty === 1 });
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(everything.length);
    expect(some.map(e => e.id)).toEqual(everything.filter(e => e.difficulty === 1).map(e => e.id));
  });
});
