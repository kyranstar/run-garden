/**
 * buildRunProgram (coach Plan A Task A10): the wire shape must be exactly
 * the live-verified minimal run topology (COROS_WRITE_PROTOCOL.md TEST B) —
 * sequential TIME blocks, warmup-first when ≥2, intensityType "none", no
 * groups — and distance targets are refused until a spike verifies them.
 */
import { describe, expect, it } from "vitest";
import {
  buildRunProgram,
  RUN_WARMUP_ORIGIN_ID,
  RUN_WORK_ORIGIN_ID,
  TOP_SORT,
} from "@rg/coros";

const session = (blocks: Array<{ kind: "duration" | "distance"; value: number }>) => ({
  category: "easy" as const,
  title: "Steady 40",
  durationMinutes: blocks.reduce((a, b) => a + (b.kind === "duration" ? b.value : 0), 0) || 40,
  run: { blocks },
});

describe("buildRunProgram", () => {
  it("two duration blocks become warmup + training in the verified shape", () => {
    const program = buildRunProgram({
      happenDay: "20260810",
      name: "Fall Half — wk 1 · Steady",
      session: session([
        { kind: "duration", value: 5 },
        { kind: "duration", value: 20 },
      ]),
    });
    expect(program.sportType).toBe(1);
    expect(program.subType).toBe(65535);
    expect(program.exerciseNum).toBe(2);
    expect(program.totalSets).toBe(0);
    const [warmup, work] = program.exercises as Array<Record<string, unknown>>;
    expect(warmup).toMatchObject({
      id: 1,
      exerciseType: 1,
      sportType: 1,
      targetType: 2,
      targetValue: 300,
      intensityType: 5,
      sets: 1,
      isGroup: false,
      groupId: "0",
      sortNo: TOP_SORT,
      originId: RUN_WARMUP_ORIGIN_ID,
    });
    expect(work).toMatchObject({
      id: 2,
      exerciseType: 2,
      targetType: 2,
      targetValue: 1200,
      originId: RUN_WORK_ORIGIN_ID,
      sortNo: TOP_SORT * 2,
    });
  });

  it("a single block is plain training (no warmup)", () => {
    const program = buildRunProgram({
      happenDay: "20260810",
      name: "x",
      session: session([{ kind: "duration", value: 40 }]),
    });
    expect(program.exerciseNum).toBe(1);
    expect((program.exercises as Array<Record<string, unknown>>)[0]).toMatchObject({
      exerciseType: 2,
      targetValue: 2400,
    });
  });

  it("refuses distance blocks (unverified on the wire) and non-run sessions", () => {
    expect(() =>
      buildRunProgram({
        happenDay: "20260810",
        name: "x",
        session: session([{ kind: "distance", value: 8000 }]),
      }),
    ).toThrow(/distance targets/);
    expect(() =>
      buildRunProgram({
        happenDay: "20260810",
        name: "x",
        session: { category: "strength", title: "Pull", durationMinutes: 45 } as never,
      }),
    ).toThrow(/not a run session/);
  });
});
