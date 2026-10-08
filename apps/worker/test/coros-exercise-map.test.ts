/**
 * The library ↔ COROS mapping by T-code (Phase 3 Task 2, spec §2, ruling
 * 3-R1). A curated entry is a human's judgment and wins outright: `exact` is
 * the key the watch gets, `close` and `generic` stay on record and send
 * nothing. A record with no curated entry gets the computed key: the unique
 * strength-catalog T-code whose English name normalizes to the record's name.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import {
  computedCorosKey,
  corosKeyOf,
  GENERIC_COROS_KEYS,
  libraryIdsByKey,
} from "../src/services/coros-exercise-map.js";
import { liveExerciseCatalog } from "../../../packages/domain/test/coach-survival/catalog.js";

type Coros = NonNullable<ExerciseRecord["providers"]>["coros"];
const rec = (id: string, name: string, coros?: Coros) =>
  ({ id, name, ...(coros ? { providers: { coros } } : {}) }) as unknown as ExerciseRecord;
const curated = (key: string, confidence: "exact" | "close" | "generic" = "exact"): Coros => ({
  key,
  confidence,
  method: "curated",
});

describe("computedCorosKey", () => {
  it("matches the catalog's English name across case and plural", () => {
    expect(computedCorosKey({ name: "Goblet squats" })).toBe("T1301"); // COROS: "Goblet Squat"
    expect(computedCorosKey({ name: "seated cable row" })).toBe("T1053"); // COROS: "Seated Cable Row"
  });

  it("is null for a name two T-codes share", () => {
    expect(computedCorosKey({ name: "Plank Jacks" })).toBeNull(); // T1077 and T1259
  });

  it("is null for a name the catalog does not hold", () => {
    expect(computedCorosKey({ name: "Chin tuck hold" })).toBeNull();
  });

  it("never returns a generic step", () => {
    for (const name of ["Warm up", "Training", "Cool down", "Rest"]) expect(computedCorosKey({ name })).toBeNull();
    expect([...GENERIC_COROS_KEYS].sort()).toEqual(["T1120", "T1121", "T1122", "T1123"]);
  });

  it("only ever names a strength-catalog key (never a run segment or a coach)", () => {
    // "Run" is a T3xxx run-workout segment, not a strength exercise.
    expect(computedCorosKey({ name: "Run" })).toBeNull();
  });
});

describe("corosKeyOf", () => {
  it("prefers a curated exact mapping over the computed key", () => {
    const library = [rec("gobletSquat", "Goblet squat", curated("T1099"))];
    expect(corosKeyOf("gobletSquat", library)).toBe("T1099");
  });

  it("ignores a curated close (or generic) mapping, and does not fall back to the computed key", () => {
    // The curator judged the catalog's entry not the same movement: the watch gets free text.
    expect(corosKeyOf("gobletSquat", [rec("gobletSquat", "Goblet squat", curated("T1099", "close"))])).toBeNull();
    expect(corosKeyOf("gobletSquat", [rec("gobletSquat", "Goblet squat", curated("T1099", "generic"))])).toBeNull();
  });

  it("uses the computed key for a record no one curated", () => {
    expect(corosKeyOf("gobletSquat", [rec("gobletSquat", "Goblet squat")])).toBe("T1301");
  });

  it("is null for an unknown id or a name the catalog lacks", () => {
    expect(corosKeyOf("ghost", [rec("gobletSquat", "Goblet squat")])).toBeNull();
    expect(corosKeyOf("chinTuck", [rec("chinTuck", "Chin tuck hold")])).toBeNull();
  });

  it("reads the shipped library by default", () => {
    const goblet = EXERCISES.find((e) => e.id === "gobletSquat")!;
    expect(corosKeyOf("gobletSquat")).toBe(goblet.providers?.coros?.key ?? computedCorosKey(goblet));
  });
});

describe("libraryIdsByKey", () => {
  it("maps every key corosKeyOf yields back to its library id", () => {
    const library = [
      rec("gobletSquat", "Goblet squat"),
      rec("benchPress", "Bench press variant", curated("T1041")),
      rec("oneArmRow", "One-arm row", curated("T1055", "close")),
      rec("chinTuck", "Chin tuck hold"),
    ];
    expect([...libraryIdsByKey(library).entries()].sort()).toEqual([
      ["T1041", "benchPress"],
      ["T1301", "gobletSquat"],
    ]);
  });

  it("drops a key two records yield", () => {
    const library = [rec("gobletSquat", "Goblet squat"), rec("gobletSquats", "Goblet squats"), rec("benchPress", "Bench press")];
    expect([...libraryIdsByKey(library).entries()]).toEqual([["T1041", "benchPress"]]);
  });

  it("over the shipped library: every key is a live, non-generic T-code, and each id appears once", () => {
    const live = new Set(liveExerciseCatalog().values());
    const map = libraryIdsByKey();
    expect(map.size).toBeGreaterThan(0);
    for (const [key, id] of map) {
      expect(live.has(key) || /^T1\d{3}$/.test(key), `${id} → ${key}`).toBe(true);
      expect(GENERIC_COROS_KEYS.has(key)).toBe(false);
      expect(corosKeyOf(id)).toBe(key);
    }
    expect(new Set(map.values()).size).toBe(map.size);
  });

  it("over the shipped library: every lift the computed tier would map was looked at by hand", () => {
    // A name match is not a movement match ("Glute bridge" computes to COROS's Hip Thrust through an alias).
    const unreviewed = EXERCISES.filter(
      (e) => e.roles.some((r) => r === "core" || r === "accessory") && !e.providers?.coros && computedCorosKey(e) !== null,
    ).map((e) => e.id);
    expect(unreviewed).toEqual([]);
  });
});
