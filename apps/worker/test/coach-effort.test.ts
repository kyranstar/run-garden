/**
 * Effort-package golden tests (effort-analysis spec §3): all sections
 * present, unknowns explicit on a bare activity, deterministic, inside the
 * token budget, and telemetry/splits/plan-context rendered with real units.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { buildEffortPackage } from "../src/services/coach-effort.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const SECTIONS = [
  "THIS EFFORT",
  "CONDITIONS",
  "SPLITS",
  "PLAN CONTEXT",
  "ZONES",
  "HISTORY",
  "LOAD",
  "MEMORY",
];

async function seedActivity(
  db: Db,
  userId: string,
  overrides: Partial<typeof schema.activities.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: "2026-08-06T12:08:02Z",
    startTimeLocal: "2026-08-06T05:08:02",
    sport: "run",
    durationSeconds: 4038,
    elapsedSeconds: 4174,
    distanceMeters: 9489,
    avgHeartRate: 153,
    maxHeartRate: 180,
    avgPaceSecPerKm: 425.5,
    elevationGainMeters: 119,
    trainingLoad: 146,
    title: "Aerobic Endurance with Hill Strides",
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...overrides,
  });
  return id;
}

describe("buildEffortPackage", () => {
  it("returns null for missing or foreign activities", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    expect(await buildEffortPackage(db, userId, "nope")).toBeNull();
    const otherId = await seedActivity(db, "someone-else");
    expect(await buildEffortPackage(db, userId, otherId)).toBeNull();
  });

  it("renders all sections with explicit unknowns on a bare activity", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await seedActivity(db, userId, { telemetry: null });
    const pkg = (await buildEffortPackage(db, userId, id))!;
    for (const s of SECTIONS) expect(pkg.sections).toContain(s);
    expect(pkg.text).toContain("cadence unknown");
    expect(pkg.text).toContain("no weather record on this activity");
    expect(pkg.text).toContain("self-reported feel: not logged");
    expect(pkg.text).toContain("no splits recorded");
    expect(pkg.text).toContain("unplanned effort — no workout matched");
    expect(pkg.text).toContain("no zone data");
    expect(pkg.text).toContain("none recorded");
    expect(pkg.approxTokens).toBeLessThanOrEqual(8_000);
    expect(pkg.date).toBe("2026-08-06");
  });

  it("is deterministic and renders telemetry, splits, plan targets, history, load", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await seedActivity(db, userId, {
      telemetry: {
        avgCadenceSpm: 152,
        maxCadenceSpm: 184,
        avgPowerWatts: 160,
        maxPowerWatts: 383,
        avgStrideLengthCm: 93,
        aerobicEffect: 2.9,
        anaerobicEffect: 3,
        vo2maxEstimate: 53,
        bestKmSecPerKm: 342,
        pauseSeconds: 136,
        pauseCount: 4,
        longestPauseSeconds: 64,
        deviceTempC: 28,
        weatherTempC: 25.5,
        weatherFeelsLikeC: 31.4,
        humidityPercent: 59,
        windKph: 1.8,
        feelRating: 4,
        hrZones: [
          { lo: 138, hi: 155, seconds: 492 },
          { lo: 156, hi: 163, seconds: 748 },
          { lo: 176, hi: 182, seconds: 0 },
        ],
        paceZones: [{ loSecPerKm: 412, hiSecPerKm: 347, seconds: 3338 }],
      },
    });
    await db.insert(schema.activityLaps).values({
      id: `${id}:1`,
      activityId: id,
      lapIndex: 1,
      durationSeconds: 300,
      distanceMeters: 530,
      avgHeartRate: 133,
      avgPaceSecPerKm: 566,
      splitType: "workout",
      avgCadenceSpm: 143,
      minHeartRate: 112,
      maxHeartRate: 148,
      avgGradePercent: 3,
      elevGainMeters: 26,
    });
    // Matched planned workout with a pace-target stage.
    await db.insert(schema.plannedWorkouts).values({
      id: "pw1",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:pw1",
      title: "Hill Strides",
      category: "quality",
      sport: "run",
      originalPlanDate: "2026-08-06",
      lastVerifiedCorosDate: "2026-08-06",
      effectiveDate: "2026-08-06",
      effectiveTime: "05:00",
      completionState: "completed",
      resolutionDate: "2026-08-06",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 4200,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.plannedWorkoutStages).values({
      id: "st1",
      workoutId: "pw1",
      ord: 1,
      kind: "warmup",
      durationType: "time",
      durationSeconds: 300,
      targetType: "pace",
      targetLow: 500,
      targetHigh: 560,
    });
    await db.insert(schema.workoutCompletionMatches).values({
      id: "m1",
      workoutId: "pw1",
      activityId: id,
      confidence: 1,
      method: "coros_plan_link",
      matchedAt: nowInstant(),
    });
    // A prior run (history + 90d best km + load window).
    await seedActivity(db, userId, {
      id: "prior1",
      startTime: "2026-08-01T12:00:00Z",
      startTimeLocal: "2026-08-01T05:00:00",
      title: "Long Run",
      durationSeconds: 4488,
      distanceMeters: 10007,
      avgPaceSecPerKm: 448,
      trainingLoad: 132,
      telemetry: { bestKmSecPerKm: 421, weatherTempC: 25.3 },
    });
    // Wellness for the morning + baseline window.
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:2026-08-06`,
      userId,
      date: "2026-08-06",
      restingHeartRate: 47,
      hrv: 88,
      contentFingerprint: "h1",
      updatedAt: nowInstant(),
    });
    // Sleep records are wake-date keyed: the night before an 08-06 effort is
    // the record dated 08-06.
    await db.insert(schema.sleepRecords).values({
      id: `${userId}:2026-08-06`,
      userId,
      date: "2026-08-06",
      durationSeconds: 7 * 3600,
      contentFingerprint: "s1",
      updatedAt: nowInstant(),
    });
    await db.insert(schema.coachMemory).values({
      id: "mem1",
      userId,
      kind: "fact",
      body: "Right achilles gets cranky on back-to-back hill days",
      provenance: { source: "message", at: nowInstant() },
      learnedAt: nowInstant(),
      active: true,
    });

    const a = (await buildEffortPackage(db, userId, id))!;
    const b = (await buildEffortPackage(db, userId, id))!;
    expect(a.text).toBe(b.text);

    expect(a.text).toContain("cadence 152spm (max 184)");
    expect(a.text).toContain("power 160W (max 383)");
    expect(a.text).toContain("aerobic 2.9 · anaerobic 3.0");
    expect(a.text).toContain("weather 25.5°C (feels 31.4°C) · humidity 59% · wind 2km/h");
    expect(a.text).toContain("watch thermometer 28°C");
    expect(a.text).toContain("self-reported feel: 4/5");
    expect(a.text).toContain("pauses 4× / 2:16 total / longest 1:04");
    expect(a.text).toContain("lap 1: 5:00 · 0.53km · 9:26/km · HR 133 (112–148) · 143spm · grade 3.0% · +26m");
    expect(a.text).toContain('planned: "Hill Strides" · quality');
    expect(a.text).toContain('warmup: 5:00 @ 8:20/km–9:20/km');
    expect(a.text).toContain("HR 138–155bpm: 8.2min");
    expect(a.text).not.toContain("HR 176–182bpm"); // zero-second zones dropped
    expect(a.text).toContain("pace 6:52/km–5:47/km: 55.6min");
    expect(a.text).toContain('2026-08-01 · "Long Run"');
    expect(a.text).toContain("90d best km: 5:42/km");
    expect(a.text).toContain("that morning: sleep 7.0h · HRV 88ms · RHR 47bpm");
    expect(a.text).toContain("trailing 7d load 278 · 28d 278");
    expect(a.text).toContain("achilles");
  });
});
