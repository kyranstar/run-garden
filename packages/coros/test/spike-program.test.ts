/**
 * The unmapped-move spike program (Task 16): four steps built by the
 * production strength builder, with one of them — the `originId: "0"`
 * free-text step — deliberately off the catalog. The production builder's own
 * refusal of that step must be untouched.
 */
import { describe, expect, it } from "vitest";
import type { RawCorosExercise } from "@rg/providers";
import { buildStrengthProgram, TOP_SORT, SUB_SORT } from "../src/create-executor.js";
import {
  buildSpikeProgram,
  isSpikeStamp,
  SPIKE_STAMP_PREFIX,
  spikeStamp,
  spikeStepFields,
  spikeWorkout,
  type SpikeProgramInputs,
} from "../src/spike-program.js";

const GENERIC_ID = "900000000000001121";
const BIRD_DOG_ID = "900000000000001150";
const CATALOG = new Map([
  ["900000000000001120", "T1120"],
  [GENERIC_ID, "T1121"],
  [BIRD_DOG_ID, "T1150"],
]);

function inputs(over: Partial<SpikeProgramInputs> = {}): SpikeProgramInputs {
  return {
    happenDay: "20261014",
    name: spikeStamp("2026-09-30"),
    catalog: CATALOG,
    genericTrainingOriginId: GENERIC_ID,
    exerciseOriginId: BIRD_DOG_ID,
    exerciseLabel: "Bird Dog",
    ...over,
  };
}

const realSteps = (exercises: RawCorosExercise[]): RawCorosExercise[] =>
  exercises.filter((e) => e.isGroup !== true);

describe("spike stamp", () => {
  it("is the fixed prefix plus a date, and nothing else matches", () => {
    expect(spikeStamp("2026-09-30")).toBe("RG SPIKE — SAFE TO DELETE 2026-09-30");
    expect(isSpikeStamp("RG SPIKE — SAFE TO DELETE 2026-09-30")).toBe(true);
    expect(isSpikeStamp(`${SPIKE_STAMP_PREFIX} 2026-09-30 (mine)`)).toBe(false);
    expect(isSpikeStamp(`x ${SPIKE_STAMP_PREFIX} 2026-09-30`)).toBe(false);
    expect(isSpikeStamp("RG SPIKE - SAFE TO DELETE 2026-09-30")).toBe(false); // hyphen, not em dash
    expect(isSpikeStamp(SPIKE_STAMP_PREFIX)).toBe(false);
    expect(isSpikeStamp(undefined)).toBe(false);
    expect(() => spikeStamp("30/09/2026")).toThrow();
  });
});

describe("buildSpikeProgram", () => {
  it("builds the four questions with the production strength builder's wire shapes", () => {
    const program = buildSpikeProgram(inputs());
    expect(program.name).toBe("RG SPIKE — SAFE TO DELETE 2026-09-30");
    expect(program.sportType).toBe(4);
    expect(program.subType).toBe(65535);

    const exercises = program.exercises ?? [];
    // Straight sets: one repeat-group container per exercise, sets 1 each.
    const containers = exercises.filter((e) => e.isGroup === true);
    expect(containers).toHaveLength(4);
    for (const c of containers) {
      expect(c.exerciseType).toBe(0);
      expect(c.sets).toBe(1);
      expect(c.originId).toBe("0");
    }
    const steps = realSteps(exercises);
    expect(steps).toHaveLength(5);
    expect(program.exerciseNum).toBe(5);
    expect(program.totalSets).toBe(5);

    const [a, b, c, d1, d2] = steps as [
      RawCorosExercise,
      RawCorosExercise,
      RawCorosExercise,
      RawCorosExercise,
      RawCorosExercise,
    ];
    // (a) free text on id "0", 30 s time target, no cue.
    expect(a).toMatchObject({ name: "Chin tuck hold", originId: "0", targetType: 2, targetValue: 30 });
    expect(a.overview).toBe("");
    // (b) the generic Training step's own id, renamed, 30 s.
    expect(b).toMatchObject({
      name: "Chin tuck hold (generic)",
      originId: GENERIC_ID,
      targetType: 2,
      targetValue: 30,
    });
    expect(b.overview).toBe("");
    // (c) a real movement: the CATALOG's name (a T-code), reps, and the cue.
    expect(c).toMatchObject({
      name: "T1150",
      originId: BIRD_DOG_ID,
      targetType: 3,
      targetValue: 8,
      overview: "cue: long neck",
    });
    // (d) the per-side pair: two identical children of one container.
    for (const d of [d1, d2]) {
      expect(d).toMatchObject({
        name: "T1150",
        originId: BIRD_DOG_ID,
        targetType: 3,
        targetValue: 8,
        overview: "each side",
      });
    }
    expect(d1.groupId).toBe(d2.groupId);
    expect(d1.sortNo).toBe(TOP_SORT * 4 + SUB_SORT);
    expect(d2.sortNo).toBe(TOP_SORT * 4 + SUB_SORT * 2);

    // Every real step is a bodyweight main step, exactly as a lift push.
    for (const s of steps) {
      expect(s).toMatchObject({ exerciseType: 2, sportType: 4, intensityType: 1, intensityValue: "" });
    }
  });

  it("is exactly what createWorkout's builder makes of the spike session and catalog", () => {
    const { session, catalog } = spikeWorkout(inputs());
    const viaBuilder = buildStrengthProgram(
      { happenDay: "20261014", name: spikeStamp("2026-09-30"), session },
      catalog,
    );
    expect(buildSpikeProgram(inputs())).toEqual(viaBuilder);
  });

  it("leaves the production builder's refusal of an off-catalog step intact", () => {
    const { session } = spikeWorkout(inputs());
    // The athlete's real catalog has no "0": the production path still refuses.
    expect(() =>
      buildStrengthProgram({ happenDay: "20261014", name: "Tuesday lift", session }, CATALOG),
    ).toThrow(/originId 0 .* is not in the COROS exercise catalog/);
  });

  it("refuses anything but a well-formed spike", () => {
    expect(() => buildSpikeProgram(inputs({ name: "Tuesday lift" }))).toThrow(/non-spike name/);
    expect(() => buildSpikeProgram(inputs({ genericTrainingOriginId: BIRD_DOG_ID }))).toThrow(
      /T1121/,
    );
    expect(() => buildSpikeProgram(inputs({ genericTrainingOriginId: "missing" }))).toThrow(/T1121/);
    expect(() => buildSpikeProgram(inputs({ exerciseOriginId: "missing" }))).toThrow(
      /not in the COROS exercise catalog/,
    );
    expect(() => buildSpikeProgram(inputs({ exerciseOriginId: GENERIC_ID }))).toThrow(/real movement/);
  });
});

describe("spikeStepFields", () => {
  it("reads real steps in wire order, containers dropped", () => {
    const program = buildSpikeProgram(inputs());
    // Shuffle the array: order comes from sortNo, not position.
    const shuffled = { ...program, exercises: [...(program.exercises ?? [])].reverse() };
    expect(spikeStepFields(shuffled)).toEqual([
      { name: "Chin tuck hold", originId: "0", overview: "", targetType: 2, targetValue: 30 },
      {
        name: "Chin tuck hold (generic)",
        originId: GENERIC_ID,
        overview: "",
        targetType: 2,
        targetValue: 30,
      },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "cue: long neck", targetType: 3, targetValue: 8 },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "each side", targetType: 3, targetValue: 8 },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "each side", targetType: 3, targetValue: 8 },
    ]);
  });

  it("reports absent fields as null rather than inventing them", () => {
    expect(
      spikeStepFields({ idInPlan: 1, exercises: [{ id: 1, exerciseType: 2, name: "x" }] }),
    ).toEqual([{ name: "x", originId: null, overview: null, targetType: null, targetValue: null }]);
    expect(spikeStepFields(undefined)).toEqual([]);
  });
});
