import { describe, expect, test } from "vitest";
import { EXERCISES, searchLibrary, textTier, wordRank } from "../src/index.js";

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
    expect(textTier(goblet, "gobelt")).toBe(5);
    expect(textTier(goblet, "gbolte")).toBeNull();
    const hits = searchLibrary(EXERCISES, "bridge");
    const exact = hits.filter(e => textTier(e, "bridge")! < 5).length;
    expect(hits.slice(0, exact).every(e => textTier(e, "bridge")! < 5)).toBe(true);
    // Inside the any-field tier a typo comes last: "romanain" reaches the Romanian deadlift only through a typo.
    expect(wordRank(EXERCISES.find(e => e.id === "rdl")!, "romanain")).toBeGreaterThan(wordRank(EXERCISES.find(e => e.id === "rdl")!, "romanian")!);
  });

  test("tiers: a word of the name, then the name, then the card line or a tag, then any field", () => {
    const rank = (q: string) => searchLibrary(EXERCISES, q);
    // "squat": the squats, before a move that only mentions squatting.
    const squat = rank("squat");
    const named = squat.filter(e => /(^|[^a-z])squat/i.test(e.name));
    expect(named.length).toBeGreaterThan(5);
    expect(squat.slice(0, named.length)).toEqual(named);
    expect(squat.findIndex(e => e.id === "morningMobilityFlow")).toBeGreaterThanOrEqual(named.length);
    // "lunge" (and "lunges"): the lunges first.
    for (const q of ["lunge", "lunges"]) {
      const lunge = rank(q);
      const named = lunge.filter(e => /(^|[^a-z])lunge/i.test(e.name));
      expect(named.length, q).toBeGreaterThan(1);
      expect(lunge.slice(0, named.length), q).toEqual(named);
    }
    // A name that merely contains the query beats a card line that mentions it.
    expect(textTier(EXERCISES.find(e => e.id === "farmerCarry")!, "arm")).toBe(3);
    expect(textTier(EXERCISES.find(e => e.id === "threadNeedle")!, "arm")).toBe(4);
  });

  test("inside the any-field tier: a primary muscle or region, then a tag, purpose or gear, then a secondary muscle", () => {
    // "hamstring": the hamstring lifts before any jump that only lists the hamstrings among its areas.
    const ham = searchLibrary(EXERCISES, "hamstring");
    const lastLift = Math.max(...ham.map((e, i) => (e.purposes.includes("strength") && e.muscles.primary.includes("hamstrings") ? i : -1)));
    const firstJump = ham.findIndex(e => e.contraction.includes("plyometric"));
    expect(firstJump).toBeGreaterThan(-1);
    expect(lastLift).toBeLessThan(firstJump);
    // "glute med": the moves it drives first, then the ones it only helps.
    const med = searchLibrary(EXERCISES, "glute med");
    const drives = med.filter(e => e.muscles.primary.includes("glute-med"));
    expect(drives.length).toBeGreaterThan(2);
    expect(med.slice(0, drives.length)).toEqual(drives);
    expect(med.length).toBeGreaterThan(drives.length);
  });

  test("a word matches at the start of a word, never inside one: \"arm\" does not find warm-ups by \"warm\"", () => {
    const arm = searchLibrary(EXERCISES, "arm");
    expect(arm.length).toBeGreaterThan(0);
    for (const e of arm) {
      const says = [e.name, e.text.summary, ...e.regions, ...e.muscles.primary, ...e.muscles.secondary].join(" ").toLowerCase();
      expect(/(^|[^a-z])arm/.test(says) || e.name.toLowerCase().includes("arm"), e.id).toBe(true);
    }
    for (const id of ["catCow", "hingeDrill", "ankleRocks", "morningMobilityFlow", "hip9090"]) expect(arm.map(e => e.id)).not.toContain(id);
  });

  test("everyday words and plurals: calf, abs, ham, glutes", () => {
    const has = (q: string, ok: (e: (typeof EXERCISES)[number]) => boolean) => {
      const hits = searchLibrary(EXERCISES, q);
      expect(hits.length, q).toBeGreaterThan(0);
      expect(hits.every(ok), q).toBe(true);
    };
    has("calf", e => e.regions.includes("calves") || [...e.muscles.primary, ...e.muscles.secondary].some(m => m === "gastrocnemius" || m === "soleus"));
    has("abs", e => e.regions.includes("core") || /core/.test(e.text.summary + e.tags.join(" ")));
    expect(searchLibrary(EXERCISES, "abs").map(e => e.id)).not.toContain("dropLanding"); // "absorb" is not "abs"
    has("ham", e => /ham/i.test(e.name) || e.regions.includes("hamstrings") || [...e.muscles.primary, ...e.muscles.secondary].includes("hamstrings"));
    const glute = (e: (typeof EXERCISES)[number]) => e.regions.includes("glutes") || e.muscles.primary.some(m => m.startsWith("glute"));
    expect(searchLibrary(EXERCISES, "glutes").slice(0, 10).every(glute)).toBe(true);
  });

  test("the athlete's lean breaks ties after the fit, never across tiers", () => {
    // "bridge": the name-word tier holds several bridges, in name order.
    const plain = searchLibrary(EXERCISES, "bridge").map(e => e.id);
    const tier2 = plain.filter(id => textTier(EXERCISES.find(e => e.id === id)!, "bridge") === 2);
    expect(tier2.length).toBeGreaterThan(2);
    const start = plain.indexOf(tier2[0]!);
    const lastOf2 = tier2.at(-1)!;
    const lean = (ids: string[]) => (id: string) => (ids.includes(id) ? 1 : 0);
    // A lean lifts the last of the tier to its head, and no further.
    expect(searchLibrary(EXERCISES, "bridge", {}, { boost: lean([lastOf2]) }).map(e => e.id)[start]).toBe(lastOf2);
    expect(searchLibrary(EXERCISES, "bridge", {}, { boost: lean([lastOf2]) })[0]!.id).toBe(plain[0]);
    // A lean never beats a better fit.
    const fit = (e: (typeof EXERCISES)[number]) => (e.id === lastOf2 ? 1 : 0);
    expect(searchLibrary(EXERCISES, "bridge", {}, { boost: lean([lastOf2]), fit }).map(e => e.id)[start]).not.toBe(lastOf2);
    // Nor a better tier: the very last result, leaned on, stays behind every better tier.
    const tail = plain.at(-1)!;
    const tailTier = textTier(EXERCISES.find(e => e.id === tail)!, "bridge")!;
    const firstOfTail = plain.findIndex(id => textTier(EXERCISES.find(e => e.id === id)!, "bridge") === tailTier);
    expect(searchLibrary(EXERCISES, "bridge", {}, { boost: lean([tail]) }).map(e => e.id).indexOf(tail)).toBe(firstOfTail);
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
