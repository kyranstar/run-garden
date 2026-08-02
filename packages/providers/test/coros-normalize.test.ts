import { describe, expect, it } from "vitest";
import { flattenStages, deriveWorkoutSeconds, estimateDuration } from "@rg/scheduling";
import {
  corosDayToLocalDate,
  corosProgramFingerprint,
  localDateToCorosDay,
  normalizeCorosActivity,
  normalizeCorosLaps,
  normalizeCorosSchedule,
} from "../src/coros/normalize.js";
import {
  corosSportName,
  COROS_GARDEN_SPORT_TYPES,
  type RawCorosActivityListItem,
} from "../src/coros/raw-types.js";
import { fixtureRawSchedule, FIXTURE_PLAN_ID } from "../src/fixtures/coros-schedule.js";
import { fixtureCorosCompletedThreshold } from "../src/fixtures/activities.js";

const BASE = "2026-08-03"; // Monday

describe("COROS schedule normalization (contract)", () => {
  const raw = fixtureRawSchedule(BASE);
  const normalized = normalizeCorosSchedule(raw);

  it("reads the active plan identity", () => {
    expect(normalized.planId).toBe(FIXTURE_PLAN_ID);
    expect(normalized.planName).toBe("Fall Half Marathon Build");
    expect(normalized.planStart).toBe("2026-08-03");
    expect(normalized.maxIdInPlan).toBe(20);
  });

  it("converts happenDay ints to LocalDates and back", () => {
    expect(corosDayToLocalDate(20260804)).toBe("2026-08-04");
    expect(corosDayToLocalDate("20260804")).toBe("2026-08-04");
    expect(localDateToCorosDay("2026-08-04")).toBe(20260804);
  });

  it("normalizes every scheduled entity including rest days", () => {
    expect(normalized.workouts).toHaveLength(11);
    const rest = normalized.workouts.find((w) => w.date === "2026-08-03");
    expect(rest?.isRestDay).toBe(true);
    expect(rest?.estimatedDurationSeconds).toBeUndefined();
  });

  it("extracts the COROS-native duration estimate from programs[].duration", () => {
    const threshold = normalized.workouts.find((w) => w.title === "Threshold 5x5")!;
    expect(threshold.estimatedDurationSeconds).toBe(3240); // 54 min native
    expect(threshold.sourceIdInPlan).toBe("11");
    expect(threshold.sourceProgramId).toBe("9000000000000011");
  });

  it("converts COROS centimetre distances to meters", () => {
    const long = normalized.workouts.find((w) => w.title === "Long Run" && w.date === "2026-08-08")!;
    expect(long.estimatedDistanceMeters).toBe(18_000);
  });

  it("normalizes nested repeat structure with pace targets in sec/km", () => {
    const threshold = normalized.workouts.find((w) => w.title === "Threshold 5x5")!;
    const repeat = threshold.stages.find((s) => s.kind === "repeat")!;
    expect(repeat.repeatCount).toBe(5);
    const work = threshold.stages.find((s) => s.parentStageId === repeat.id && s.kind === "work")!;
    expect(work.durationSeconds).toBe(300);
    expect(work.targetType).toBe("pace");
    expect(work.targetLow).toBe(255); // 4:15/km from 255000 ms/km
    expect(work.targetHigh).toBe(266);
    const flat = flattenStages(threshold.stages);
    expect(flat).toHaveLength(1 + 5 * 2 + 1); // warmup + 5×(work+recovery) + cooldown
  });

  it("derived fallback matches the native estimate closely for time-based workouts", () => {
    const threshold = normalized.workouts.find((w) => w.title === "Threshold 5x5")!;
    const derived = deriveWorkoutSeconds(threshold.stages, { defaultPaceSecPerKm: 390 });
    expect(derived.seconds).toBe(900 + 5 * (300 + 120) + 600); // 3600
    // Native (3240) differs — and must win in the estimator.
    const est = estimateDuration({
      sourceEstimatedDurationSeconds: threshold.estimatedDurationSeconds,
      stages: threshold.stages,
      category: "quality",
      paceContext: { defaultPaceSecPerKm: 390 },
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
    });
    expect(est.source).toBe("coros_native");
    expect(est.workoutSeconds).toBe(3240);
    expect(est.calendarSeconds).toBe(3240 + 1500);
  });

  it("workouts without native estimates fall back to stage derivation", () => {
    const strides = normalized.workouts.find((w) => w.title === "Easy + Strides")!;
    expect(strides.estimatedDurationSeconds).toBeUndefined();
    const est = estimateDuration({
      stages: strides.stages,
      category: "easy",
      paceContext: { defaultPaceSecPerKm: 390 },
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
    });
    expect(est.source).toBe("derived_from_stages");
    // warmup 1500 + 6×(100m @ 230s/km ≈ 23s + 60s rest) + cooldown 600
    expect(est.workoutSeconds).toBe(1500 + 6 * (23 + 60) + 600);
  });

  it("content fingerprint ignores the date but not the structure", () => {
    const raw2 = fixtureRawSchedule(BASE);
    const moved = normalizeCorosSchedule({
      ...raw2,
      entities: raw2.entities!.map((e) =>
        String(e.idInPlan) === "11" ? { ...e, happenDay: 20260806 } : e,
      ),
    });
    const a = normalized.workouts.find((w) => w.sourceIdInPlan === "11")!;
    const b = moved.workouts.find((w) => w.sourceIdInPlan === "11")!;
    expect(b.date).toBe("2026-08-06");
    expect(a.contentFingerprint).toBe(b.contentFingerprint);

    const program = raw2.programs!.find((p) => String(p.idInPlan) === "11")!;
    const edited = { ...program, exercises: program.exercises!.slice(0, 3) };
    expect(corosProgramFingerprint(edited)).not.toBe(corosProgramFingerprint(program));
  });
});

describe("COROS activity normalization (contract)", () => {
  const { item, detail } = fixtureCorosCompletedThreshold("2026-08-04T14:02:05Z");

  it("normalizes times, distances (cm), calories (cal→kcal), and device", () => {
    const a = normalizeCorosActivity(item, detail);
    expect(a.provider).toBe("coros");
    expect(a.startTime).toBe("2026-08-04T14:02:05Z");
    expect(a.startTimeLocal).toBe("2026-08-04T07:02:05");
    expect(a.durationSeconds).toBe(3255);
    expect(a.elapsedSeconds).toBe(3312);
    expect(a.distanceMeters).toBe(9860);
    expect(a.avgHeartRate).toBe(158);
    expect(a.calories).toBe(612);
    expect(a.deviceName).toBe("COROS PACE 3");
    expect(a.trainingLoad).toBe(82);
  });

  it("carries the plan/program linkage for completion matching", () => {
    const a = normalizeCorosActivity(item, detail);
    expect(a.sourcePlannedWorkoutId).toBe("9000000000000011");
  });

  it("normalizes structured laps (centisecond times, cm distances)", () => {
    const laps = normalizeCorosLaps(detail);
    expect(laps).toHaveLength(11);
    expect(laps[0]).toMatchObject({ lapIndex: 1, durationSeconds: 900, distanceMeters: 2500 });
    expect(laps[1]!.avgPaceSecPerKm).toBe(197);
    expect(laps.every((l) => l.splitType === "workout")).toBe(true);
  });

  it("normalizes a yoga session (904) without distance or pace", () => {
    const item: RawCorosActivityListItem = {
      labelId: "coros-yoga-1",
      date: 20260805,
      name: "Morning Flow",
      sportType: 904,
      startTime: Math.floor(Date.parse("2026-08-05T13:00:00Z") / 1000),
      totalTime: 180_000, // centiseconds → 1800s
      workoutTime: 180_000,
      avgHr: 98,
      calorie: 220_000,
    };
    const a = normalizeCorosActivity(item);
    expect(a.sport).toBe("yoga");
    expect(a.distanceMeters).toBeUndefined();
    expect(a.avgPaceSecPerKm).toBeUndefined();
    expect(a.durationSeconds).toBe(1800);
  });
});

describe("corosSportName / COROS_GARDEN_SPORT_TYPES", () => {
  it("admits run/strength/yoga sportTypes into the garden import set", () => {
    expect(COROS_GARDEN_SPORT_TYPES.get(100)).toBe("run");
    expect(COROS_GARDEN_SPORT_TYPES.get(101)).toBe("run");
    expect(COROS_GARDEN_SPORT_TYPES.get(102)).toBe("run");
    expect(COROS_GARDEN_SPORT_TYPES.get(103)).toBe("run");
    expect(COROS_GARDEN_SPORT_TYPES.get(402)).toBe("strength");
    expect(COROS_GARDEN_SPORT_TYPES.get(403)).toBe("yoga");
    expect(COROS_GARDEN_SPORT_TYPES.get(904)).toBe("yoga");
    // Bike stays excluded — no entry in the admitted map.
    expect(COROS_GARDEN_SPORT_TYPES.has(200)).toBe(false);
  });

  it("names known sportTypes and falls back to coros_<n> for unknowns", () => {
    expect(corosSportName(100)).toBe("run");
    expect(corosSportName(402)).toBe("strength");
    expect(corosSportName(403)).toBe("yoga");
    expect(corosSportName(904)).toBe("yoga");
    expect(corosSportName(555)).toBe("coros_555");
  });
});
