import { describe, expect, test } from "vitest";
import {
  CONTRACTIONS, EQUIPMENT_IDS, EXERCISES, PATTERNS, POSITIONS, PURPOSES, REGIONS, ROLES, TAGS, type ExerciseRecord, type Purpose, type Region,
} from "../src/index.js";

// COVERAGE TARGETS (Task 13, A9 + R9): what the library must hold so a coach can build a varied session for any area and
// any purpose without reaching for the same few moves. The audit found 0 quad stretches, 1 hamstring stretch, no barbell,
// machine or pull-up-bar move and no vertical pull, and every mobility session repeating the towel hamstring stretch.
// The targets are floors: a record removed or re-tagged so a count drops below one fails here, by region and purpose.

/** At least this many records per region for a purpose ("stretch" = the stretch purpose itself; "strength" likewise). */
const REGION_TARGETS: Partial<Record<Region, Partial<Record<Purpose, number>>>> = {
  quads: { strength: 8, stretch: 3 },
  hamstrings: { strength: 6, stretch: 3 },
  glutes: { strength: 8, stretch: 3 },
  calves: { strength: 4, stretch: 2 },
  hips: { strength: 4, stretch: 8, mobility: 8 },
  ankles: { strength: 2, mobility: 2 },
  core: { strength: 8 },
  "low-back": { stretch: 2 },
  "upper-back": { strength: 6, mobility: 3 },
  thoracic: { mobility: 6 },
  lats: { strength: 4, stretch: 2 },
  chest: { strength: 3, stretch: 2 },
  shoulders: { strength: 6, mobility: 4 },
  arms: { strength: 4 },
  neck: { stretch: 3 },
  jaw: { "condition-care": 8 },
};
/** Slow-lowering (eccentric) work, by region: the legs a runner brakes with, and the library as a whole. */
const ECCENTRIC_TARGETS: Partial<Record<Region, number>> = { quads: 3, glutes: 3, hamstrings: 2, calves: 2 };
const ECCENTRIC_TOTAL = 10;
/** Gym gear the athlete's places list: each has moves to choose between. */
const GEAR_TARGETS: Partial<Record<(typeof EQUIPMENT_IDS)[number], number>> = { barbell: 2, machine: 2, cable: 3, "pull-up-bar": 2 };
/** Patterns a gym day reaches for. */
const PATTERN_TARGETS: Partial<Record<(typeof PATTERNS)[number], number>> = { "pull-v": 2, "pull-h": 4, squat: 6, hinge: 6, lunge: 6 };
/**
 * Vocabulary values no move uses yet, named so a gap is a decision, not an accident: the coach's search builds its
 * filters from the values the library uses, and these stay out of them until a move fills one.
 */
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = { role: ["finisher"], purpose: ["conditioning"] };

const count = (keep: (e: ExerciseRecord) => boolean): number => EXERCISES.filter(keep).length;

describe("coverage targets per region and purpose", () => {
  for (const [region, targets] of Object.entries(REGION_TARGETS) as Array<[Region, Partial<Record<Purpose, number>>]>) {
    test(region, () => {
      for (const [purpose, min] of Object.entries(targets) as Array<[Purpose, number]>) {
        const n = count((e) => e.regions.includes(region) && e.purposes.includes(purpose));
        expect(n, `${region} × ${purpose}: ${n} moves, at least ${min} wanted`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  test("the lower-limb stretches the audit found missing: quads, hamstrings, inner thighs, each in more than one position", () => {
    const stretches = (keep: (e: ExerciseRecord) => boolean) => EXERCISES.filter((e) => e.purposes.includes("stretch") && keep(e));
    for (const region of ["quads", "hamstrings"] as const) {
      const here = stretches((e) => e.regions.includes(region));
      expect(new Set(here.map((e) => e.position)).size, `${region} stretch positions`).toBeGreaterThanOrEqual(2);
      // A stretch you can do standing, with nothing to lie on (after a run, at a trailhead).
      expect(here.some((e) => e.position === "standing" && e.equipment.all.length === 0), `${region}: a standing stretch with no gear`).toBe(true);
    }
    expect(stretches((e) => e.muscles.primary.includes("adductors")).length).toBeGreaterThanOrEqual(2);
    // The filters the audit saw return nothing.
    expect(count((e) => e.roles.includes("stretch") && e.regions.includes("quads"))).toBeGreaterThanOrEqual(2);
    expect(count((e) => e.tags.includes("thoracic"))).toBeGreaterThanOrEqual(3);
  });

  test("slow-lowering strength for the legs, and enough of it overall", () => {
    const eccentric = EXERCISES.filter((e) => e.contraction.includes("eccentric"));
    expect(eccentric.length).toBeGreaterThanOrEqual(ECCENTRIC_TOTAL);
    for (const [region, min] of Object.entries(ECCENTRIC_TARGETS) as Array<[Region, number]>) {
      expect(eccentric.filter((e) => e.regions.includes(region)).length, `eccentric ${region}`).toBeGreaterThanOrEqual(min);
    }
    // The tag marks the moves whose point is the lowering, and each of them is eccentric.
    for (const e of EXERCISES.filter((x) => x.tags.includes("eccentric-emphasis"))) expect(e.contraction, e.id).toContain("eccentric");
  });

  test("the gym's gear and the patterns a gym day reaches for", () => {
    for (const [gear, min] of Object.entries(GEAR_TARGETS)) {
      expect(count((e) => [...e.equipment.all, ...e.equipment.oneOf].includes(gear as never)), gear).toBeGreaterThanOrEqual(min!);
    }
    for (const [pattern, min] of Object.entries(PATTERN_TARGETS)) expect(count((e) => e.patterns.includes(pattern as never)), pattern).toBeGreaterThanOrEqual(min!);
  });

  test("every vocabulary value has a move, except the named gaps", () => {
    const vocab: Array<[string, readonly string[], (e: ExerciseRecord) => readonly string[]]> = [
      ["pattern", PATTERNS, (e) => e.patterns],
      ["region", REGIONS, (e) => e.regions],
      ["role", ROLES, (e) => e.roles],
      ["purpose", PURPOSES, (e) => e.purposes],
      ["tag", TAGS, (e) => e.tags],
      ["equipment", EQUIPMENT_IDS, (e) => [...e.equipment.all, ...e.equipment.oneOf]],
      ["position", POSITIONS, (e) => [e.position]],
      ["contraction", CONTRACTIONS, (e) => e.contraction],
    ];
    for (const [name, values, of] of vocab) {
      const empty = values.filter((v) => !EXERCISES.some((e) => of(e).includes(v)));
      expect(empty, name).toEqual(KNOWN_GAPS[name] ?? []);
    }
  });
});
