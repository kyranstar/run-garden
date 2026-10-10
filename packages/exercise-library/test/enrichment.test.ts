import { describe, expect, test } from "vitest";
import { CONTRACTIONS, EXERCISES, MUSCLES, MUSCLE_REGION, PURPOSES, REGIONS, TAGS, THEMES } from "../src/index.js";

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
      if (e.muscles && !e.muscles.primary.some(m => (e.regions as readonly string[]).includes(MUSCLE_REGION[m]))) {
        bad("muscles.primary", "no primary muscle sits in the record's regions");
      }
      expect(problems).toEqual([]);
    });
  }
});
