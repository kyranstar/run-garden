import { describe, expect, test } from "vitest";
import { EXERCISES, PROFILES, defineExercises, makeEngineData, validateLibrary, validateRecord, type ExerciseRecord } from "../src/index.js";
import { ex } from "./fixtures.js";

const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
const profiles = Object.values(PROFILES);
const PERSONAL = /^my[A-Z][A-Za-z0-9]{1,60}$/;
const ctx = (mode: "library" | "personal", knownIds: ReadonlySet<string> = new Set()) => ({
  themes: data.themes, profiles, knownIds, mode, personalId: PERSONAL,
});
const rec = (id: string, overrides: Record<string, unknown> = {}): ExerciseRecord => defineExercises([ex(id, overrides)])[0]!;

describe("validateRecord", () => {
  test("the current library still validates cleanly, record by record and whole", () => {
    expect(validateLibrary(data)).toEqual([]);
    const seen = new Set<string>();
    for (const r of EXERCISES) { expect(validateRecord(r, ctx("library", seen))).toEqual([]); seen.add(r.id); }
  });

  test("library mode: provenance and the camelCase id rule apply", () => {
    const withAt = rec("myMove", { text: { ...ex("x").text, summary: "from @someone" } });
    const issues = validateRecord(withAt, ctx("library"));
    expect(issues.some(i => i.includes("provenance"))).toBe(true);
    expect(issues.some(i => i.includes("camelCase"))).toBe(false); // "myMove" is camelCase
    expect(validateRecord(rec("My_move"), ctx("library")).some(i => i.includes("camelCase"))).toBe(true);
  });

  test("personal mode: text may carry an @, the id must be a personal id, easier/harder may be empty", () => {
    const withAt = rec("myMove", { text: { ...ex("x").text, summary: "from @someone" } });
    expect(validateRecord(withAt, ctx("personal"))).toEqual([]);
    expect(validateRecord(rec("squat"), ctx("personal")).some(i => i.includes("personal move id"))).toBe(true);
  });

  test("personal mode still needs every profile's rating and note", () => {
    const missing = rec("myMove", { conditions: {} });
    expect(validateRecord(missing, ctx("personal")).some(i => i.includes("conditions.tmj is missing"))).toBe(true);
    const noNote = rec("myMove", { text: { ...ex("x").text, conditions: {} } });
    expect(validateRecord(noNote, ctx("personal")).some(i => i.includes("text.conditions.tmj"))).toBe(true);
    const unreadable = rec("myMove", { conditions: { tmj: { clench: 9, neckLoad: 0, faceDown: false } } });
    expect(validateRecord(unreadable, ctx("personal")).some(i => i.includes("conditions.tmj.clench"))).toBe(true);
  });

  test("a known id is a duplicate", () => {
    expect(validateRecord(rec("myMove"), ctx("personal", new Set(["myMove"])))).toContain("myMove: duplicate id");
  });

  test("validateLibrary's results on a broken library are unchanged", () => {
    const d = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: [
      ...EXERCISES.slice(0, 20),
      ...defineExercises([ex("a", { name: "", patterns: [], tags: ["elastic"] }), ex("a"), ex("Bad_id", { conditions: {}, difficulty: 9 })]),
    ] });
    const out = validateLibrary(d);
    expect(out.filter(i => i.startsWith("a: "))).toEqual(expect.arrayContaining(["a: missing name", "a: duplicate id", "a: needs at least one pattern"]));
    expect(out).toContain("Bad_id: id must be camelCase");
  });
});
