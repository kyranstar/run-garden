import { describe, expect, test } from "vitest";
import { CONTRACTIONS, label, EXERCISES, MUSCLES, MUSCLE_REGION, PURPOSES, REGIONS, TAGS, THEMES } from "../src/index.js";

// The curation to-do list: one test per record, each failure naming the record id and field.

describe("vocabularies", () => {
  test("MUSCLE_REGION covers every muscle and maps into REGIONS", () => {
    for (const m of MUSCLES) {
      expect(MUSCLE_REGION[m], `${m} has no region`).toBeTruthy();
      expect(REGIONS as readonly string[], `${m} maps to an unknown region`).toContain(MUSCLE_REGION[m]);
    }
    expect(Object.keys(MUSCLE_REGION).sort()).toEqual([...MUSCLES].sort());
  });

  test("no vocabulary has duplicate ids", () => {
    for (const list of [MUSCLES, CONTRACTIONS, PURPOSES, TAGS]) expect(new Set(list).size).toBe(list.length);
  });
});

describe("labels", () => {
  test("every hyphenated vocabulary id has a hand-written label (single words read fine capitalised)", () => {
    const fine = new Set(["single-leg", "anti-rotation"]); // read well as plain capitalisation
    const naive = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
    for (const id of new Set<string>([...MUSCLES, ...PURPOSES, ...TAGS, ...CONTRACTIONS])) {
      if (id.includes("-") && !fine.has(id)) expect(label(id), `${id} reads as its raw id`).not.toBe(naive(id));
    }
  });
});

const themeIds = THEMES.map(t => t.id);

describe("every record is curated", () => {
  for (const e of EXERCISES) {
    test(e.id, () => {
      const problems: string[] = [];
      const bad = (field: string, msg: string) => problems.push(`${e.id}.${field}: ${msg}`);
      const checkList = (field: string, list: readonly string[] | undefined, vocab: readonly string[], min: number) => {
        if (!list || list.length < min) return bad(field, `needs at least ${min}`);
        for (const v of list) if (!vocab.includes(v)) bad(field, `"${v}" is not in the vocabulary`);
      };
      checkList("contraction", e.contraction, CONTRACTIONS, 1);
      checkList("purposes", e.purposes, PURPOSES, 1);
      checkList("muscles.primary", e.muscles?.primary, MUSCLES, 1);
      checkList("muscles.secondary", e.muscles?.secondary ?? (e.muscles ? [] : undefined), MUSCLES, 0);
      checkList("tags", e.tags, TAGS, 0);
      checkList("themes", e.themes, themeIds, 0);
      if (e.text.summary.length > 90) bad("text.summary", `is ${e.text.summary.length} chars (max 90)`);
      if (e.muscles && ![...e.muscles.primary, ...e.muscles.secondary].some(m => (e.regions as readonly string[]).includes(MUSCLE_REGION[m]))) {
        bad("muscles", "no primary or secondary muscle sits in the record's regions");
      }
      for (const m of e.muscles?.primary ?? []) if (e.muscles!.secondary.includes(m)) bad("muscles", `"${m}" is in both primary and secondary`);
      for (const [field, list] of [["muscles.primary", e.muscles?.primary], ["muscles.secondary", e.muscles?.secondary], ["purposes", e.purposes], ["contraction", e.contraction], ["tags", e.tags], ["themes", e.themes]] as const) {
        if (list && new Set(list).size !== list.length) bad(field, "repeats an entry");
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("themes for the new tags", () => {
  test("skiPrep and athleticBase exist, are never recovery themes, and have records to draw on", () => {
    for (const id of ["skiPrep", "athleticBase"]) {
      const t = THEMES.find(x => x.id === id);
      expect(t, `${id} is missing`).toBeTruthy();
      expect(t!.modes, `${id} must not be a recovery theme`).not.toContain("recovery");
      expect(t!.modes.length).toBeGreaterThan(0);
      expect(EXERCISES.filter(e => (e.themes ?? []).includes(id)).length, `${id} has no records tagged with it`).toBeGreaterThanOrEqual(3);
    }
  });

  test("plyoIntro waits for its moves (Task 5)", () => {
    expect(THEMES.some(t => t.id === "plyoIntro")).toBe(false);
  });
});
