import { describe, expect, test } from "vitest";
import {
  agentSearch,
  EXERCISES,
  FACET_VALUES,
  libraryLine,
  offeredValues,
  searchLibrary,
  usedValues,
  wordRank,
  type ExerciseRecord,
  type SearchFacet,
} from "../src/index.js";

// The coach's search (Task 13 fix wave, audit (b) I2 / F2): an agent writes a list of what it wants, so every word
// AND-ed is the wrong contract — the moves with every word come first (the Studio's own ranking), then the moves with
// some of them, by how many, each naming the words it has. The Studio's narrowing search is not this one.

const ids = (r: ReturnType<typeof agentSearch>) => r.hits.map((h) => h.record.id);
const gearOf = (e: ExerciseRecord) => [...e.equipment.all, ...e.equipment.oneOf] as string[];

describe("agentSearch: every word first, then some of them", () => {
  test.each([
    ["hamstring calf stretch", {}],
    ["hip flexor hamstring stretch", { role: "stretch" }],
    ["leg warmup mobility hips ankles", { role: "warmup" }],
    ["hip thrust glute bridge", { region: "glutes", purpose: "strength" }],
    ["breathing downshift", { role: "downshift" }],
    ["thoracic opening", {}],
  ] as const)("%s finds moves, each missing word said", (query, filters) => {
    const r = agentSearch(EXERCISES, query, filters);
    expect(r.hits.length, query).toBeGreaterThan(0);
    for (const h of r.hits) {
      for (const [k, v] of Object.entries(filters)) {
        const values: Record<string, readonly string[]> = { role: h.record.roles, region: h.record.regions, purpose: h.record.purposes };
        expect(values[k], `${h.record.id} ${k}`).toContain(v);
      }
      // A move with only some of the words names them; a move with all of them names none.
      if (h.matched) {
        expect(h.matched.length).toBeGreaterThan(0);
        expect(h.matched.length).toBeLessThan(r.words.length);
        for (const w of h.matched) expect(r.words).toContain(w);
      }
    }
    // Ranked by how many words: a move with more never comes after one with fewer.
    const counts = r.hits.map((h) => h.matched?.length ?? r.words.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  test("the moves with every word come first, in the Studio's own order", () => {
    const r = agentSearch(EXERCISES, "goblet squat");
    expect(r.hits[0]!.record.id).toBe("gobletSquat");
    expect(r.hits[0]!.matched).toBeUndefined();
    const studio = searchLibrary(EXERCISES, "goblet squat").map((e) => e.id);
    expect(ids(r).slice(0, studio.length)).toEqual(studio);
    expect(r.allWords).toBeGreaterThanOrEqual(studio.length);
    // The rest have one of the two words.
    expect(r.hits.slice(r.allWords).every((h) => h.matched?.length === 1)).toBe(true);
  });

  test("the Studio's search still narrows: a word no move has empties it, as the athlete types", () => {
    expect(searchLibrary(EXERCISES, "hamstring calf stretch")).toEqual([]);
    expect(agentSearch(EXERCISES, "hamstring calf stretch").allWords).toBe(0);
  });

  test("roles, patterns and themes are words the coach can search by", () => {
    const downshift = agentSearch(EXERCISES, "downshift");
    expect(downshift.hits.length).toBeGreaterThan(0);
    expect(downshift.hits.every((h) => h.record.roles.includes("downshift") || h.matched === undefined)).toBe(true);
    expect(downshift.hits.some((h) => h.record.roles.includes("downshift"))).toBe(true);
    const theme = EXERCISES.find((e) => e.themes.length > 0)!;
    const themeId = theme.themes[0]!;
    expect(ids(agentSearch(EXERCISES, themeId))).toContain(theme.id);
    const hinge = agentSearch(EXERCISES, "hinge");
    expect(hinge.hits.some((h) => h.record.patterns.includes("hinge"))).toBe(true);
  });

  test("small words don't count: a/the/for/with never make a move match", () => {
    const r = agentSearch(EXERCISES, "a stretch for the calves");
    expect(r.words).toEqual(["stretch", "calves"]);
    expect(r.allWords).toBeGreaterThan(0);
  });

  test("filters and the caller's own yes/no hold for every hit, those with some words too", () => {
    const r = agentSearch(EXERCISES, "hip hamstring stretch", { position: "standing" }, { accepts: (e) => e.difficulty <= 2 });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.record.position).toBe("standing");
      expect(h.record.difficulty).toBeLessThanOrEqual(2);
    }
  });

  test("an empty query is every move the filters allow, by the Studio's order", () => {
    const r = agentSearch(EXERCISES, "", { purpose: "mobility" });
    expect(ids(r)).toEqual(searchLibrary(EXERCISES, "", { purpose: "mobility" }).map((e) => e.id));
    expect(r.words).toEqual([]);
  });
});

describe("agentSearch: bounded work (fix wave 13, round 2, C1)", () => {
  test("at most eight words count; the rest are said, never searched", () => {
    const query = "hip hamstring calf stretch mobility warmup glute bridge ankle thoracic";
    const r = agentSearch(EXERCISES, query);
    expect(r.words).toEqual(["hip", "hamstring", "calf", "stretch", "mobility", "warmup", "glute", "bridge"]);
    expect(r.dropped).toEqual(["ankle", "thoracic"]);
    for (const h of r.hits) for (const w of h.matched ?? []) expect(["ankle", "thoracic"]).not.toContain(w);
    expect(agentSearch(EXERCISES, "hip stretch").dropped).toEqual([]);
  });

  test("the some-words tier still forgives what the Studio forgives: an everyday word, a typo", () => {
    // "sore" stands for what eases (a stretch, passive work, recovery); "hamstrng" is one letter short.
    const sore = agentSearch(EXERCISES, "sore zqxv");
    expect(sore.hits.length).toBeGreaterThan(0);
    expect(sore.hits.every((h) => h.matched?.join() === "sore")).toBe(true);
    expect(sore.hits.some((h) => h.record.purposes.includes("stretch"))).toBe(true);
    const typo = agentSearch(EXERCISES, "hamstrng zqxv");
    expect(typo.hits.some((h) => h.record.muscles.primary.includes("hamstrings") && h.matched?.join() === "hamstrng")).toBe(true);
    // A typo is found in the index itself: two unknown words before it, which spend the Studio's record-by-record
    // fallback, don't stop it.
    const late = agentSearch(EXERCISES, "zqxvw zqxvy hamstrng");
    expect(late.hits.some((h) => h.record.muscles.primary.includes("hamstrings") && h.matched?.join() === "hamstrng")).toBe(true);
  });

  test("a word matches a record's words by their start, a plural by its singular — never a shorter stem's other words", () => {
    const r = agentSearch(EXERCISES, "lunges zqxv");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.record.name.toLowerCase().includes("lunge") || h.record.patterns.includes("lunge") || h.record.text.summary.toLowerCase().includes("lunge"))).toBe(true);
  });
});

describe("agentSearch: a word means what it means in the Studio (round 3, R2-I1)", () => {
  // The some-words tier credits a word to exactly the moves the Studio's own `wordRank` credits it to — its everyday
  // words ("abs" is the core, "tight" what eases) by their meaning, never by a raw prefix ("absorb", "butterfly") —
  // plus the roles, patterns and themes the coach's index adds.
  const credited = (w: string) =>
    agentSearch(EXERCISES, `${w} zqxvw`)
      .hits.filter((h) => h.matched?.includes(w))
      .map((h) => h.record.id)
      .sort();
  const studio = (w: string) => EXERCISES.filter((e) => wordRank(e, w) !== null).map((e) => e.id).sort();

  test.each(["abs", "butt", "tight", "achilles", "tspine", "calf", "sore", "hamstrings", "glute", "lunges", "hamstrng"])("%s: the Studio's moves, every one", (w) => {
    const theirs = studio(w);
    expect(theirs.length, w).toBeGreaterThan(0);
    const ours = credited(w);
    expect(ours).toEqual(expect.arrayContaining(theirs));
    // Anything more is a move whose role, pattern or theme says the word — never a raw prefix the Studio turns away.
    for (const id of ours.filter((x) => !theirs.includes(x))) {
      const ex = EXERCISES.find((e) => e.id === id)!;
      const extras = [...ex.roles, ...ex.patterns, ...ex.themes].join(" ").toLowerCase();
      expect(extras, `${w}: ${id}`).toMatch(new RegExp(w.slice(0, 4)));
    }
  });

  test("the reviewer's table: everyday words keep their moves, and only those", () => {
    // An everyday word is read only as what it stands for: exactly the Studio's moves (no role, pattern or theme starts
    // with these words as written; "abs" never reaches the "core" role, a session's main lift).
    for (const w of ["abs", "butt", "tight", "achilles", "tspine", "sore"]) expect(credited(w), w).toEqual(studio(w));
    expect(credited("abs")).not.toContain("dropLanding");
    expect(credited("butt")).not.toContain("reclinedButterfly");
    for (const w of ["abs", "butt", "tight", "achilles"]) expect(credited(w).length, w).toBeGreaterThanOrEqual(15);
    const tight = agentSearch(EXERCISES, "tight hamstrings");
    expect(tight.hits.length).toBeGreaterThanOrEqual(studio("tight").length);
  });
});

describe("agentSearch: a zero's diagnosis is bounded (round 3, R2-M1)", () => {
  test("a count needs no diagnosis: explain false leaves a zero unexplained, and moves turned away are counted in the one pass", () => {
    expect(agentSearch(EXERCISES, "zqxva zqxvb", {}, {}, { explain: false }).empty).toEqual([]);
    const away = agentSearch(EXERCISES, "squat", {}, { accepts: () => false }, { explain: false });
    expect(away.hits).toEqual([]);
    expect(away.turnedAway).toBe(agentSearch(EXERCISES, "squat").hits.length);
  });

  test("a zero names every unknown word, from the index (its cost is the CPU bench's gate)", () => {
    const query = "zqxva zqxvb zqxvc zqxvd zqxve zqxvf zqxvg zqxvh";
    const before = agentSearch(EXERCISES, query);
    expect(before.hits).toEqual([]);
    expect(before.empty).toEqual(["zqxva", "zqxvb", "zqxvc", "zqxvd", "zqxve", "zqxvf", "zqxvg", "zqxvh"].map((w) => `no move says "${w}"`));
  });
});

describe("agentSearch: a zero says what emptied it", () => {
  test("a word no move says is named", () => {
    const r = agentSearch(EXERCISES, "zqxv");
    expect(r.hits).toEqual([]);
    expect(r.empty.join(" ")).toMatch(/"zqxv"/);
  });

  test("a filter value no move uses is named, and for gear the gear the moves do use", () => {
    const noBarbell = EXERCISES.filter((e) => !gearOf(e).includes("barbell"));
    const r = agentSearch(noBarbell, "squat", { equipment: "barbell" });
    expect(r.hits).toEqual([]);
    const words = r.empty.join(" ");
    expect(words).toMatch(/no move in the library uses a barbell/);
    expect(words).toMatch(/dumbbells/);
    const noHanging = EXERCISES.filter((e) => e.position !== "hanging");
    expect(agentSearch(noHanging, "", { position: "hanging" }).empty.join(" ")).toMatch(/no move in the library is done hanging/);
  });

  test("a word naming gear no move uses is answered as the gear, not as an unknown word", () => {
    const noBarbell = EXERCISES.filter((e) => !gearOf(e).includes("barbell"));
    expect(agentSearch(noBarbell, "barbell").empty.join(" ")).toMatch(/no move in the library uses a barbell \("barbell"\)/);
  });

  test("filters that each find moves but none together say so", () => {
    const r = agentSearch(EXERCISES, "", { role: "jaw-care", equipment: "kettlebell" });
    expect(r.hits).toEqual([]);
    expect(r.empty.join(" ")).toMatch(/none has them all/);
  });

  test("moves the caller's own yes/no turned away are counted, never called missing from the library", () => {
    const r = agentSearch(EXERCISES, "squat", {}, { accepts: () => false });
    expect(r.hits).toEqual([]);
    expect(r.turnedAway).toBeGreaterThan(0);
    expect(r.empty).toEqual([]);
  });
});

describe("the vocabulary the coach is offered", () => {
  test("every value offered is one some move uses", () => {
    const used = usedValues(EXERCISES);
    for (const facet of Object.keys(FACET_VALUES) as SearchFacet[]) {
      const offered = offeredValues(EXERCISES, facet);
      expect(offered.length, facet).toBeGreaterThan(0);
      for (const v of offered) expect(used[facet], `${facet} ${v}`).toContain(v);
      for (const v of offered) expect(EXERCISES.some((e) => agentSearch([e], "", { [facet]: v }).hits.length === 1), `${facet} ${v}`).toBe(true);
    }
  });

  test("the library line is computed: the count, and what no move uses", () => {
    const noBarbell = EXERCISES.filter((e) => !gearOf(e).includes("barbell") && !e.patterns.includes("pull-v"));
    const line = libraryLine(noBarbell);
    expect(line).toContain(`library: ${noBarbell.length} moves`);
    expect(line).toMatch(/none uses [^;]*a barbell/);
    expect(line).toMatch(/vertical pulling/);
    // A library with every gear in use says nothing is missing there.
    const used = usedValues(EXERCISES);
    expect(libraryLine(EXERCISES)).toContain(`library: ${EXERCISES.length} moves`);
    if (used.equipment.length === FACET_VALUES.equipment.length) expect(libraryLine(EXERCISES)).not.toMatch(/none uses/);
  });
});
