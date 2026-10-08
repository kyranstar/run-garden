/**
 * Curated COROS mappings (Phase 3 Task 2, spec §2): a library lift names the
 * COROS catalog T-code of the same movement with the same implement class.
 * Every key is live (the fixture is the live catalog's T-code set), has an
 * English name, and is never one of the generic steps.
 */
import { describe, expect, it } from "vitest";
// Relative, as the fixture itself imports it: the library package does not depend on @rg/providers.
import { COROS_EXERCISE_NAMES } from "../../providers/src/coros/exercise-names.js";
import { EXERCISES, defineExercises, makeEngineData, validateLibrary } from "../src/index.js";
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
