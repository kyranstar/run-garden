/**
 * Coach-authored run workouts carry pace targets onto the watch
 * (2026-08-14). The wire contract is spike-verified: intensityType 3 with
 * MILLISECONDS per km, fast edge in intensityValue and slow edge in
 * intensityValueExtend, plus program-level referExercise/fastIntensityTypeName.
 */
import { describe, expect, it } from "vitest";
import { buildRunProgram } from "../src/create-executor.js";
import type { CoachSession } from "@rg/domain";

const session: CoachSession = {
  category: "quality",
  title: "Threshold 3×10",
  durationMinutes: 50,
  run: {
    blocks: [
      { kind: "duration", value: 15, intensity: "easy" },
      { kind: "duration", value: 30, intensity: "threshold" },
      { kind: "duration", value: 5, intensity: "rest" },
    ],
  },
};

describe("buildRunProgram pace targets", () => {
  it("emits ms/km bounds per block from the athlete's threshold", () => {
    const p = buildRunProgram({
      happenDay: "20261024",
      name: "Threshold 3×10 — 2026-10-24",
      session,
      thresholdPaceSecPerKm: 289,
    });
    const [warmup, work, rest] = p.exercises as Array<Record<string, number>>;
    // easy 349–409 s/km → ms/km, fast edge first.
    expect(warmup).toMatchObject({ intensityType: 3, intensityValue: 349_000, intensityValueExtend: 409_000 });
    // threshold 289–313 — the same numbers COROS prescribes itself.
    expect(work).toMatchObject({ intensityType: 3, intensityValue: 289_000, intensityValueExtend: 313_000 });
    // A rest block gets no target at all.
    expect(rest!.intensityType).toBe(5);
    expect(rest!.intensityValue).toBe(0);
    expect(rest!.intensityValueExtend).toBeUndefined();
    // Program-level pace declaration rides along.
    expect(p.fastIntensityTypeName).toBe("pace");
    expect((p.referExercise as { intensityType: number }).intensityType).toBe(3);
    // Durations are untouched by the pace work.
    expect(work!.targetType).toBe(2);
    expect(work!.targetValue).toBe(1800);
  });

  it("without a threshold reading it pushes exactly as before — no invented targets", () => {
    const p = buildRunProgram({ happenDay: "20261024", name: "n", session });
    for (const ex of p.exercises as Array<Record<string, number>>) {
      expect(ex.intensityType).toBe(5);
      expect(ex.intensityValue).toBe(0);
      expect(ex.intensityValueExtend).toBeUndefined();
    }
    expect(p.fastIntensityTypeName).toBe("weight");
    expect((p.referExercise as { intensityType: number }).intensityType).toBe(1);
  });

  it("an implausible threshold is refused rather than prescribed", () => {
    const p = buildRunProgram({ happenDay: "20261024", name: "n", session, thresholdPaceSecPerKm: 3 });
    expect((p.exercises as Array<Record<string, number>>)[1]!.intensityType).toBe(5);
    expect(p.fastIntensityTypeName).toBe("weight");
  });
});
