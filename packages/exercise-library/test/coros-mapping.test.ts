/**
 * Curated COROS mappings (Phase 3 Task 2, spec §2): a library lift names the
 * COROS catalog T-code of the same movement with the same implement class.
 * Every key is live (the fixture is the live catalog's T-code set), has an
 * English name, and is never one of the generic steps.
 */
import { describe, expect, it } from "vitest";
// Relative, as the fixture itself imports it: the library package does not depend on @rg/providers.
import { COROS_EXERCISE_NAMES } from "../../providers/src/coros/exercise-names.js";
import { EXERCISES, IMPLEMENT_CLASS, defineExercises, makeEngineData, validateLibrary } from "../src/index.js";
import { liveExerciseCatalog } from "../../domain/test/coach-survival/catalog.js";
import { ex } from "./fixtures.js";

const liveKeys = new Set(liveExerciseCatalog().values());
const curated = EXERCISES.filter((e) => e.providers?.coros?.method === "curated");

describe("curated COROS mappings", () => {
  it("exist for the lifts", () => expect(curated.length).toBeGreaterThan(0));
  it.each(curated.map((e) => [e.id, e.providers!.coros!] as const))("%s names a live, English-named, non-generic T-code", (_id, m) => {
    expect(liveKeys.has(m.key)).toBe(true);
    expect(COROS_EXERCISE_NAMES[m.key]).toBeTruthy();
    expect(["T1120", "T1121", "T1122", "T1123"]).not.toContain(m.key);
  });
  it("are only on core or accessory records", () =>
    curated.forEach((e) => expect(e.roles.some((r) => r === "core" || r === "accessory")).toBe(true)));
  it("never share an exact key", () => {
    const keys = curated.filter((e) => e.providers!.coros!.confidence === "exact").map((e) => e.providers!.coros!.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the implement-class rule for an exact mapping (audit 3-A W-5)", () => {
  /** The implement class a COROS English name names; null when it names none ("Goblet Squat", "Deadlifts"). */
  const namedClass = (english: string): string | null => {
    const w = english.toLowerCase();
    if (/\b(dumbbells?|kettlebells?)\b/.test(w)) return IMPLEMENT_CLASS.dumbbells;
    if (/\bbarbells?\b/.test(w)) return IMPLEMENT_CLASS.barbell;
    if (/\bcable\b/.test(w)) return IMPLEMENT_CLASS.cable;
    if (/\b(machine|smith|lever)\b/.test(w)) return IMPLEMENT_CLASS.machine;
    if (/\bbands?\b/.test(w)) return IMPLEMENT_CLASS.band;
    return null;
  };
  const classesOf = (e: (typeof EXERCISES)[number]): string[] =>
    [...e.equipment.all, ...e.equipment.oneOf].flatMap((id) => (id in IMPLEMENT_CLASS ? [IMPLEMENT_CLASS[id as keyof typeof IMPLEMENT_CLASS]] : []));
  const exact = curated.filter((e) => e.providers!.coros!.confidence === "exact");

  it("kettlebell and dumbbells are one class; barbell, cable, machine and band are each their own", () => {
    expect(IMPLEMENT_CLASS.kettlebell).toBe(IMPLEMENT_CLASS.dumbbells);
    const classes = [IMPLEMENT_CLASS.dumbbells, IMPLEMENT_CLASS.barbell, IMPLEMENT_CLASS.cable, IMPLEMENT_CLASS.machine, IMPLEMENT_CLASS.band];
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("an exact key whose COROS name names an implement is to a move done with that implement class", () => {
    const naming = exact.filter((e) => namedClass(COROS_EXERCISE_NAMES[e.providers!.coros!.key]!) !== null);
    expect(naming.length).toBeGreaterThanOrEqual(3); // supportedRow, rdl, cableRow at least: the rule is exercised
    for (const e of naming) {
      const english = COROS_EXERCISE_NAMES[e.providers!.coros!.key]!;
      expect(classesOf(e), `${e.id} → ${english}`).toContain(namedClass(english));
    }
  });

  it("so a kettlebell-or-dumbbell row and Romanian deadlift are exact to COROS's dumbbell lifts", () => {
    const of = (id: string) => EXERCISES.find((e) => e.id === id)!;
    for (const [id, key] of [["supportedRow", "T1309"], ["rdl", "T1305"]] as const) {
      expect(of(id).providers?.coros).toEqual({ key, confidence: "exact", method: "curated" });
      expect(of(id).equipment.oneOf).toEqual(["kettlebell", "dumbbells"]);
      expect(namedClass(COROS_EXERCISE_NAMES[key]!)).toBe(IMPLEMENT_CLASS.kettlebell);
    }
  });
});

describe("validateLibrary — a COROS mapping's key", () => {
  const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
  const withOne = (key: string) =>
    validateLibrary(
      { ...data, exercises: defineExercises([ex("mapped", { providers: { coros: { key, confidence: "exact", method: "curated" } } })]) },
      { presets: [] },
    ).filter((e) => e.startsWith("mapped:"));

  it("accepts a T-code", () => expect(withOne("T1301")).toEqual([]));
  it.each(["1301", "T130", "T13011", "Goblet Squat", ""])("refuses %j", (key) =>
    expect(withOne(key)).toEqual([`mapped: providers.coros.key "${key}" is not a COROS T-code`]));
});
