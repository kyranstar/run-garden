import { describe, expect, it } from "vitest";
import { fingerprint } from "@rg/domain";
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
  COROS_ADMITTED_SPORT_TYPES,
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

describe("merged multi-plan schedules (research §3: schedule/query merges every plan)", () => {
  // Two plans in one response with COLLIDING idInPlan values — the live
  // failure mode that aliased studio lifting sessions onto run workouts.
  const merged = {
    id: "111",
    name: "Marathon Block",
    startDay: 20260803,
    endDay: 20260928,
    entities: [
      { idInPlan: 1, planId: "111", happenDay: 20260804 },
      // Same idInPlan, DIFFERENT plan — must not alias.
      { idInPlan: 1, planId: "222", happenDay: 20260805 },
    ],
    programs: [
      { idInPlan: 1, planId: "111", name: "Easy Run", sportType: 1, duration: 2400 },
      { idInPlan: 1, planId: "222", name: "W1 Wed - Lift — wk 1", sportType: 4, duration: 2700 },
    ],
  };
  const normalized = normalizeCorosSchedule(merged as never);

  it("keys workouts and programs by (planId, idInPlan), never bare idInPlan", () => {
    expect(normalized.workouts).toHaveLength(2);
    const [run, lift] = normalized.workouts;
    expect(run!.sourceWorkoutId).toBe("111:1");
    expect(lift!.sourceWorkoutId).toBe("222:1");
    expect(run!.sourcePlanId).toBe("111");
    expect(lift!.sourcePlanId).toBe("222");
  });

  it("attaches each entity's own plan's program (sport, title, duration)", () => {
    const [run, lift] = normalized.workouts;
    expect(run!.sport).toBe("run");
    expect(run!.title).toBe("Easy Run");
    expect(lift!.sport).toBe("strength");
    expect(lift!.title).toBe("W1 Wed - Lift — wk 1");
    expect(lift!.estimatedDurationSeconds).toBe(2700);
  });

  it("falls back to the top-level plan id when rows omit planId (single-plan responses)", () => {
    const single = normalizeCorosSchedule(fixtureRawSchedule(BASE));
    expect(single.workouts.every((w) => w.sourcePlanId === FIXTURE_PLAN_ID)).toBe(true);
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

describe("COROS telemetry extras (probe-verified 2026-08-06)", () => {
  // Field values lifted from a live PACE 4 payload ("Aerobic Endurance with
  // Hill Strides") — the unit conversions asserted here are the contract.
  const item: RawCorosActivityListItem = {
    labelId: "probe-strides",
    date: 20260806,
    name: "Aerobic Endurance with Hill Strides",
    sportType: 102,
    startTime: 1786040482,
    startTimezone: -28,
    device: "COROS PACE 4",
    waterTemperature: 2800, // °C × 100 — the watch thermometer
  };
  const detail = {
    summary: {
      startTimestamp: 178604048295,
      timezone: -28,
      workoutTime: 403770,
      totalTime: 417364,
      distance: 948936,
      avgHr: 153,
      maxHr: 180,
      avgPace: 0, // pace rides in avgSpeed on current payloads
      avgCadence: 152,
      maxCadence: 184,
      avgPower: 160,
      maxPower: 383,
      avgStepLen: 93,
      aerobicEffect: 2.9,
      anaerobicEffect: 3,
      currentVo2Max: 53,
      staminaLevel7d: 0, // sentinel — absent
      bestKm: 342,
      pauseTime: 13594,
      elevGain: 119,
      trainingLoad: 146,
    },
    weather: {
      temperature: 255,
      bodyFeelTemp: 314,
      humidity: 590,
      windSpeed: 18,
      windDirection: 1580,
    },
    sportFeelInfo: { feelType: 4, sportNote: "" },
    zoneList: [
      {
        type: 126,
        zoneType: 3,
        zoneItemList: [
          { leftScope: 138, rightScope: 155, second: 492, zoneIndex: 0 },
          { leftScope: 156, rightScope: 163, second: 748, zoneIndex: 2 },
        ],
      },
      {
        type: 130,
        zoneType: 0,
        zoneItemList: [{ leftScope: 412000, rightScope: 347000, second: 3338, zoneIndex: 0 }],
      },
    ],
    pauseList: [
      { duration: 171 },
      { duration: 6423 },
      { duration: 4614 },
      { duration: 2441 },
    ],
  };

  const a = normalizeCorosActivity(item, detail);
  const t = a.telemetry!;

  it("derives moving pace when summary.avgPace is 0", () => {
    expect(a.avgPaceSecPerKm).toBeCloseTo(425.5, 0);
  });

  it("converts cadence/power/stride/effects/VO2max/best-km verbatim", () => {
    expect(t.avgCadenceSpm).toBe(152);
    expect(t.maxCadenceSpm).toBe(184);
    expect(t.avgPowerWatts).toBe(160);
    expect(t.maxPowerWatts).toBe(383);
    expect(t.avgStrideLengthCm).toBe(93);
    expect(t.aerobicEffect).toBe(2.9);
    expect(t.anaerobicEffect).toBe(3);
    expect(t.vo2maxEstimate).toBe(53);
    expect(t.bestKmSecPerKm).toBe(342);
  });

  it("drops zero sentinels (stamina, note) but keeps real zeros out of temps", () => {
    expect(t.staminaLevel7d).toBeUndefined();
    expect(t.sportNote).toBeUndefined();
  });

  it("decodes temperatures: device °C×100, weather °C×10, humidity %×10, wind ×10", () => {
    expect(t.deviceTempC).toBe(28);
    expect(t.weatherTempC).toBe(25.5);
    expect(t.weatherFeelsLikeC).toBe(31.4);
    expect(t.humidityPercent).toBe(59);
    expect(t.windKph).toBe(1.8);
  });

  it("keeps the self-reported feel and derives pause stats from pauseList", () => {
    expect(t.feelRating).toBe(4);
    expect(t.pauseSeconds).toBe(136); // centiseconds → seconds
    expect(t.pauseCount).toBe(4);
    expect(t.longestPauseSeconds).toBe(64);
  });

  it("stores HR zones (bpm bounds) and pace zones (ms/km → sec/km)", () => {
    expect(t.hrZones).toEqual([
      { lo: 138, hi: 155, seconds: 492 },
      { lo: 156, hi: 163, seconds: 748 },
    ]);
    expect(t.paceZones).toEqual([{ loSecPerKm: 412, hiSecPerKm: 347, seconds: 3338 }]);
  });

  it("normalizes lap telemetry (cadence, min/max HR, grade, power sentinels)", () => {
    const laps = normalizeCorosLaps({
      lapList: [
        {
          lapDistance: 160934,
          lapItemList: [
            {
              lapIndex: 1,
              time: 30000,
              distance: 53000,
              avgHr: 133,
              avgPace: 566.04,
              avgCadence: 143,
              minHr: 112,
              maxHr: 148,
              elevGain: 26,
              avgGrade: 3,
              avgPower: 152,
              maxPower: 0,
            },
          ],
        },
      ],
    });
    expect(laps[0]).toMatchObject({
      avgCadenceSpm: 143,
      minHeartRate: 112,
      maxHeartRate: 148,
      elevGainMeters: 26,
      avgGradePercent: 3,
      avgPowerWatts: 152,
      splitType: "workout",
    });
    expect(laps[0]!.exerciseNameKey).toBeUndefined();
  });

  it("omits the telemetry object entirely when nothing survives", () => {
    const bare = normalizeCorosActivity({
      labelId: "bare",
      date: 20260801,
      sportType: 100,
      startTime: 1785628229,
    });
    expect(bare.telemetry).toBeUndefined();
  });

  it("v2 fingerprint differs from v1 so stored rows refresh once", () => {
    const again = normalizeCorosActivity(item, detail);
    expect(again.contentFingerprint).toBe(a.contentFingerprint); // deterministic
    const v1 = fingerprint({
      id: item.labelId,
      start: 178604048295 / 100,
      durationSeconds: a.durationSeconds,
      distanceMeters: a.distanceMeters,
      hr: 153,
    });
    expect(a.contentFingerprint).not.toBe(v1);
  });
});

describe("corosSportName / COROS_ADMITTED_SPORT_TYPES", () => {
  it("admits run/strength/yoga sportTypes into the garden import set", () => {
    expect(COROS_ADMITTED_SPORT_TYPES.get(100)).toBe("run");
    expect(COROS_ADMITTED_SPORT_TYPES.get(101)).toBe("run");
    expect(COROS_ADMITTED_SPORT_TYPES.get(102)).toBe("run");
    expect(COROS_ADMITTED_SPORT_TYPES.get(103)).toBe("run");
    expect(COROS_ADMITTED_SPORT_TYPES.get(402)).toBe("strength");
    expect(COROS_ADMITTED_SPORT_TYPES.get(403)).toBe("yoga");
    expect(COROS_ADMITTED_SPORT_TYPES.get(904)).toBe("yoga");
    // Bike stays excluded — no entry in the admitted map.
    expect(COROS_ADMITTED_SPORT_TYPES.has(200)).toBe(false);
  });

  it("names known sportTypes and falls back to coros_<n> for unknowns", () => {
    expect(corosSportName(100)).toBe("run");
    expect(corosSportName(402)).toBe("strength");
    expect(corosSportName(403)).toBe("yoga");
    expect(corosSportName(904)).toBe("yoga");
    expect(corosSportName(555)).toBe("coros_555");
  });
});

describe("COROS_ADMITTED_SPORT_TYPES", () => {
  // The backfill ingests exactly what this map admits and silently tallies the
  // rest, so a missing code means years of history quietly never arrive.
  it("admits every run code as run", () => {
    for (const code of [100, 101, 102, 103]) {
      expect(COROS_ADMITTED_SPORT_TYPES.get(code)).toBe("run");
    }
  });

  it("admits strength 402", () => {
    expect(COROS_ADMITTED_SPORT_TYPES.get(402)).toBe("strength");
  });

  it("admits both yoga codes", () => {
    expect(COROS_ADMITTED_SPORT_TYPES.get(403)).toBe("yoga");
    expect(COROS_ADMITTED_SPORT_TYPES.get(904)).toBe("yoga");
  });

  it("does not admit bike or swim", () => {
    expect(COROS_ADMITTED_SPORT_TYPES.has(200)).toBe(false);
    expect(COROS_ADMITTED_SPORT_TYPES.has(300)).toBe(false);
  });

  it("admits ski as 'other' — ingested for load, but not a garden discipline", () => {
    // The load signals (loadRatio, ramp, monotony, hardStack) span every sport
    // and say so. Dropping ski at ingest made them understate a winter block.
    expect(COROS_ADMITTED_SPORT_TYPES.get(500)).toBe("other");
    expect(corosSportName(500)).toBe("ski");
  });
});
