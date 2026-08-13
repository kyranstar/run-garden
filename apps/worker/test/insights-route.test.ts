/**
 * Route-level tests for the insights assembly (`GET /api/insights` in
 * `apps/worker/src/routes/misc.ts`). This layer previously had zero coverage
 * and held every HIGH finding of the 2026-08-03 insights audit, so the cases
 * here are deliberately about *assembly* — what reaches each analytics
 * function — rather than about the metric math (that lives in
 * packages/analytics tests):
 *
 *  (a) sport scoping: a yoga session with a hard heart rate never reaches the
 *      run-only execution metrics;
 *  (b) category scoping: an unmatched run is category "unknown", never a
 *      defaulted "easy", so it cannot enter aerobic efficiency;
 *  (c) user scoping: a second user's activities, laps and matches do not
 *      appear in this user's response — a property guard on this route's
 *      assembly, not a proof that no code path anywhere could leak a row;
 *  (d) evidence rotation: dismissing the top card surfaces the next one
 *      instead of collapsing to null;
 *  (e) records persistence: a stored record survives a regeneration whose
 *      window no longer contains the achieving run;
 *  (f) payload shape: `timeOfDay` is gone, `drift` is now `decoupling`.
 *
 * Mounts `insightRoutes` the same way plan-routes.test.ts mounts `planRoutes`.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { insightRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const {
  activities,
  activityLaps,
  computedMetrics,
  plannedWorkouts,
  workoutCompletionMatches,
} = schema;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

// ── Response shape (mirrors the Task A7 payload contract) ────────────────────

interface MetricEnvelope<T> {
  status: "ok" | "insufficient_data";
  value?: T;
  needed?: number;
  have?: number;
}

interface InterpretedMetricBody {
  id: string;
  title: string;
  status: "ok" | "insufficient_data";
  value?: string;
  band?: "low" | "healthy" | "high" | "watch";
  meaning: string;
  suggestion?: string;
  sampleNote: string;
  gauge?: { min: number; max: number; healthyLo: number; healthyHi: number; value: number };
  series?: Array<{ date: string; value: number }>;
  baseline?: { value: number; lo: number; hi: number; unit: string };
  strip?: Array<{ date: string; on: boolean }>;
  staleNote?: string;
  bandNote?: string;
  detail?: {
    explain: string;
    runs: Array<{
      activityId: string;
      over?: boolean;
      value?: string;
      note?: string;
      delta?: number;
    }>;
  };
}

interface WeekTotals {
  weekStart: string;
  partial: boolean;
  durationSeconds: number;
  lowSeconds: number;
  highSeconds: number;
}

interface InsightsBody {
  discipline: "run" | "strength" | "yoga";
  availableDisciplines: Array<"run" | "strength" | "yoga">;
  consistency: { planned: number; completed: number; pending: number; days: unknown[] };
  weekly: { weeks: WeekTotals[]; fourWeekAvgDuration?: number };
  // Absent (not empty) for strength and yoga: pace-based, so the question does
  // not apply rather than the data being missing.
  efficiency?: MetricEnvelope<{ perRun: Array<{ activityId: string; efficiency: number }> }>;
  decoupling?: MetricEnvelope<{
    perRun: Array<{ activityId: string }>;
    excluded: { count: number; reasons: string[] };
  }>;
  records: Array<{ id: string; value: string; achievedOn: string; numeric: number }>;
  evidence: { id: string; text: string } | null;
  reviews: unknown[];
  interpreted: InterpretedMetricBody[];
}

let db: Db;

function client(cookie: string) {
  const app = mountRoutes(db, "/api/insights", insightRoutes);
  return {
    get: async (discipline?: string): Promise<InsightsBody> => {
      const path = discipline ? `/api/insights?discipline=${discipline}` : "/api/insights";
      const res = await app.request(path, { headers: { Cookie: cookie } }, makeEnv());
      expect(res.status).toBe(200);
      return (await res.json()) as InsightsBody;
    },
    raw: () => app.request("/api/insights", { headers: { Cookie: cookie } }, makeEnv()),
    dismiss: (cardId: string) =>
      app.request(
        "/api/insights/dismiss",
        {
          method: "POST",
          headers: { Cookie: cookie, "content-type": "application/json" },
          body: JSON.stringify({ cardId }),
        },
        makeEnv(),
      ),
  };
}

// ── Seeding ─────────────────────────────────────────────────────────────────

interface SeedActivityOpts {
  date: string;
  sport?: string;
  durationSeconds?: number;
  avgHeartRate?: number | null;
  maxHeartRate?: number | null;
  distanceMeters?: number;
  trainingLoad?: number | null;
  title?: string;
  /** 0 leaves the activity lapless. */
  lapCount?: number;
  lapHeartRate?: number;
  startLocalTime?: string;
  /**
   * Per-lap multipliers on lap DURATION (distance stays even), so a run can
   * have a genuinely faster or slower second half. Default: every lap 1.0,
   * i.e. a dead-even split.
   */
  lapDurationFactors?: number[];
  /**
   * Per-lap multipliers on lap DISTANCE, normalized so the run's total
   * distance is unchanged. Default: every lap the same size. Needed to build a
   * run whose laps are genuinely uneven — the shape that exposes how halves
   * are split.
   */
  lapDistanceFactors?: number[];
  /** Watch time-in-zone record, stored on telemetry (audit#2 (a)). */
  hrZones?: Array<{ lo: number; hi: number; seconds: number }>;
}

/**
 * One activity plus evenly-sized laps. The default 3000s / 5×600s shape is
 * deliberately the smallest one that satisfies BOTH aerobic efficiency (which
 * drops laps ending inside the first 600s and then the final lap, needing 2+
 * survivors) and decoupling (40+ minutes, 4+ usable laps after the same
 * warm-up trim).
 */
async function seedActivity(userId: string, o: SeedActivityOpts): Promise<string> {
  const id = newId();
  const durationSeconds = o.durationSeconds ?? 3000;
  const distanceMeters = o.distanceMeters ?? 10_000;
  const avgHeartRate = o.avgHeartRate === undefined ? 130 : o.avgHeartRate;
  const startLocal = `${o.date}T${o.startLocalTime ?? "07:00:00"}`;
  await db.insert(activities).values({
    id,
    userId,
    startTime: `${startLocal}Z`,
    startTimeLocal: startLocal,
    timezone: "America/Los_Angeles",
    sport: o.sport ?? "run",
    durationSeconds,
    elapsedSeconds: durationSeconds,
    distanceMeters,
    avgHeartRate,
    maxHeartRate: o.maxHeartRate === undefined ? 180 : o.maxHeartRate,
    avgPaceSecPerKm: (durationSeconds / distanceMeters) * 1000,
    trainingLoad: o.trainingLoad ?? null,
    title: o.title ?? "Morning run",
    telemetry: o.hrZones ? { hrZones: o.hrZones } : null,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });

  const lapCount = o.lapCount ?? 5;
  const distanceFactorSum = o.lapDistanceFactors
    ? o.lapDistanceFactors.slice(0, lapCount).reduce((s, f) => s + f, 0)
    : lapCount;
  for (let i = 0; i < lapCount; i++) {
    const lapSeconds = (durationSeconds / lapCount) * (o.lapDurationFactors?.[i] ?? 1);
    const lapMeters = (distanceMeters * (o.lapDistanceFactors?.[i] ?? 1)) / distanceFactorSum;
    await db.insert(activityLaps).values({
      id: newId(),
      activityId: id,
      lapIndex: i,
      durationSeconds: lapSeconds,
      distanceMeters: lapMeters,
      avgHeartRate: o.lapHeartRate ?? avgHeartRate ?? null,
      avgPaceSecPerKm: (lapSeconds / lapMeters) * 1000,
    });
  }
  return id;
}

async function seedWorkout(
  userId: string,
  o: {
    date: string;
    category?: string;
    completionState?: string;
    effectiveTime?: string;
    title?: string;
    sport?: string;
  },
): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "plan-1",
    sourceWorkoutId: `src-${id.slice(0, 8)}`,
    title: o.title ?? "Easy run",
    category: o.category ?? "easy",
    sport: o.sport ?? "run",
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: o.effectiveTime ?? "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    completionState: o.completionState ?? "completed",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** Link an activity to a planned workout the way completion matching does. */
async function matchActivity(workoutId: string, activityId: string): Promise<string> {
  const matchId = newId();
  await db.insert(workoutCompletionMatches).values({
    id: matchId,
    workoutId,
    activityId,
    confidence: 0.95,
    method: "scored_auto",
    matchedAt: nowInstant(),
  });
  await db
    .update(activities)
    .set({ completionMatchId: matchId })
    .where(eq(activities.id, activityId));
  return matchId;
}

/** An activity matched to a planned workout of `category`, in one call. */
async function seedMatchedRun(
  userId: string,
  category: string,
  o: SeedActivityOpts,
): Promise<string> {
  const workoutId = await seedWorkout(userId, { date: o.date, category });
  const activityId = await seedActivity(userId, o);
  await matchActivity(workoutId, activityId);
  return activityId;
}

function metric(body: InsightsBody, id: string): InterpretedMetricBody {
  const found = body.interpreted.find((m) => m.id === id);
  expect(found, `interpreted metric "${id}" missing`).toBeDefined();
  return found!;
}

let userId: string;
let prefs: UserPreferences;
let cookie: string;
let today: string;

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db);
  userId = user.userId;
  prefs = user.prefs;
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

// ── (a) Sport scoping ────────────────────────────────────────────────────────

describe("sport scoping", () => {
  it("keeps a hard-HR yoga session out of the run-only execution metrics", async () => {
    // Five hour-long easy runs, all comfortably under the easy ceiling
    // (hrMax 180 → ceiling 144), plus one hour of yoga at 170 bpm. If the
    // yoga hour reached low-intensity share it would drag 100% down to 83%.
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(i * 3 + 2)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 130,
      });
    }
    const yogaId = await seedActivity(userId, {
      date: addDays(today, -3),
      sport: "yoga",
      durationSeconds: 3600,
      avgHeartRate: 170,
      maxHeartRate: 200,
      distanceMeters: 0,
      lapCount: 0,
      title: "Yoga",
      startLocalTime: "18:00:00",
    });

    const body = await client(cookie).get();

    const lowIntensity = metric(body, "lowIntensityShare");
    expect(lowIntensity.status).toBe("ok");
    expect(lowIntensity.value).toBe("100%");

    const easyDiscipline = metric(body, "easyDiscipline");
    expect(easyDiscipline.status).toBe("ok");
    expect(easyDiscipline.detail?.runs.map((r) => r.activityId)).not.toContain(yogaId);

    // Nothing anywhere in the payload references the yoga session.
    expect(JSON.stringify(body)).not.toContain(yogaId);
  });
});

// ── Low-intensity share: 4-week headline over a 12-week zone split ───────────

describe("low-intensity share windows", () => {
  it("reads the headline over the last 4 weeks, so an old easy block cannot hide a hard month", async () => {
    // Five weeks ago and older: 15 hours of genuinely easy running.
    for (let i = 0; i < 15; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(35 + i * 2)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 130,
      });
    }
    // The last four weeks: 5 hours, every minute of it above the easy ceiling
    // (hrMax 180 → ceiling 144).
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "quality", {
        date: addDays(today, -(2 + i * 3)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 165,
        lapHeartRate: 165,
      });
    }

    const body = await client(cookie).get();
    const lowIntensity = metric(body, "lowIntensityShare");

    // Over the whole 12 weeks this reads 15h/20h = 75% — a healthy-looking
    // number describing a month that did not happen.
    expect(lowIntensity.status).toBe("ok");
    expect(lowIntensity.value).toBe("0%");
    expect(lowIntensity.band).toBe("high");
    expect(lowIntensity.meaning).toContain("last 4 weeks");

    // …while the weekly stacked bars still get a zone split for the older
    // weeks, which is what the full-window computation is for.
    const easyWeeks = body.weekly.weeks.filter((w) => w.lowSeconds > 0);
    expect(easyWeeks.length).toBeGreaterThan(0);
  });

  it("keeps a heart-rate-less run in its week's stacked total instead of dropping it", async () => {
    // Four hours of HR-tracked running opens the zone-split computation…
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(3 + i * 2)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 130,
      });
    }
    // …and this run, recorded without a heart-rate strap, must still appear in
    // its week's bar via the category fallback rather than silently vanishing.
    const noHrDate = addDays(today, -4);
    await seedActivity(userId, {
      date: noHrDate,
      durationSeconds: 2400,
      avgHeartRate: null,
      lapCount: 0,
      title: "No strap",
      startLocalTime: "18:00:00",
    });

    const body = await client(cookie).get();
    expect(metric(body, "lowIntensityShare").status).toBe("ok");

    const week = body.weekly.weeks.find(
      (w) => w.weekStart <= noHrDate && addDays(w.weekStart, 6) >= noHrDate,
    );
    expect(week, "no weekly bucket covers the strapless run").toBeDefined();
    expect(week!.lowSeconds + week!.highSeconds).toBe(week!.durationSeconds);
  });
});

// ── Easy ceiling: 26-week basis and its honesty caveat ───────────────────────

describe("easy ceiling", () => {
  it("counts only usable max-HR readings, so average-only runs cannot suppress the caveat", async () => {
    // Five runs that actually evidence a maximum…
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(2 + i * 3)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 130,
      });
    }
    // …and six that carry an average but no max at all. Counting "runs with
    // heart rate" would reach 11 here and drop the caveat, while the ceiling
    // still rests on the five readings above — confidence overstated, in the
    // one direction that matters.
    for (let i = 0; i < 6; i++) {
      await seedActivity(userId, {
        date: addDays(today, -(20 + i * 3)),
        avgHeartRate: 132,
        maxHeartRate: null,
      });
    }

    const body = await client(cookie).get();

    const disclosure =
      "Ceiling estimated from only 5 runs with a usable max heart rate in the last 26 weeks.";
    expect(metric(body, "easyDiscipline").sampleNote).toContain(disclosure);
    expect(metric(body, "lowIntensityShare").sampleNote).toContain(disclosure);
  });

  it("drops the caveat once enough runs carry heart rate, and still measures against the 26-week estimate", async () => {
    // 12 runs with heart rate, half of them older than the 12-week display
    // window — the ceiling is a 26-week estimate, so they count.
    for (let i = 0; i < 6; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(2 + i * 3)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 130,
      });
    }
    for (let i = 0; i < 6; i++) {
      await seedActivity(userId, {
        date: addDays(today, -(120 + i * 5)),
        avgHeartRate: 140,
        maxHeartRate: 180,
      });
    }

    const body = await client(cookie).get();
    expect(metric(body, "easyDiscipline").sampleNote).not.toContain("Ceiling estimated from only");
    expect(metric(body, "lowIntensityShare").sampleNote).not.toContain(
      "Ceiling estimated from only",
    );
  });
});

// ── audit#2 (a): the watch's own zones outrank the estimator ─────────────────

describe("watch time-in-zone", () => {
  it("classifies zone-carrying runs by the watch's record and measures the rest against its Z2 boundary", async () => {
    // The audit's live failure shape: aerobic runs at 150 bpm under a watch
    // whose easy boundary is 155. The estimator builds ceiling 144 from the
    // 180 max readings and would call every one of them hard (a red "3%
    // low"). The most recent run carries the watch's own zone record, so 155
    // is the ceiling and the month reads truthfully easy.
    for (let i = 1; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(2 + i * 3)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 150,
        lapHeartRate: 150,
      });
    }
    await seedMatchedRun(userId, "easy", {
      date: addDays(today, -2),
      durationSeconds: 3600,
      distanceMeters: 12_000,
      avgHeartRate: 150,
      lapHeartRate: 150,
      hrZones: [
        { lo: 0, hi: 135, seconds: 0 },
        { lo: 136, hi: 155, seconds: 3600 }, // the watch filed all of it as Z2
        { lo: 156, hi: 168, seconds: 0 },
        { lo: 169, hi: 180, seconds: 0 },
        { lo: 181, hi: 220, seconds: 0 },
      ],
    });

    const body = await client(cookie).get();

    const lowIntensity = metric(body, "lowIntensityShare");
    expect(lowIntensity.status).toBe("ok");
    expect(lowIntensity.value).toBe("100%");
    expect(lowIntensity.band).toBe("healthy");
    // The ceiling quoted everywhere is the watch's own boundary…
    expect(lowIntensity.meaning).toContain("155 bpm");
    // …which needs no estimator caveat.
    expect(lowIntensity.sampleNote).not.toContain("Ceiling estimated");
    expect(lowIntensity.sampleNote).not.toContain("default max heart rate");

    const easyDiscipline = metric(body, "easyDiscipline");
    expect(easyDiscipline.status).toBe("ok");
    expect(easyDiscipline.value).toBe("100%");
    expect(easyDiscipline.detail?.explain).toContain("155 bpm");
    expect(easyDiscipline.detail?.explain).toContain("exactly as your watch draws it");
  });
});

// ── audit#2 (a4): honest band suppression ────────────────────────────────────

describe("honest band suppression", () => {
  it("withholds the band, gauge and advice when the verdict flips within ±5 bpm of the ceiling", async () => {
    // Five runs averaging 148 bpm against the default-190 ceiling of 152 (no
    // usable max readings, no zone records): probed at 147 every second reads
    // hard, at 152 every second reads easy — that verdict is a fact about the
    // ceiling, not the runner, so no verdict is published.
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(2 + i * 3)),
        durationSeconds: 3600,
        distanceMeters: 12_000,
        avgHeartRate: 148,
        lapHeartRate: 148,
        maxHeartRate: null,
      });
    }

    const lowIntensity = metric(await client(cookie).get(), "lowIntensityShare");
    expect(lowIntensity.status).toBe("ok");
    expect(lowIntensity.value).toBe("100%"); // the number still shows
    expect(lowIntensity.band).toBeUndefined(); // the verdict does not
    expect(lowIntensity.gauge).toBeUndefined();
    expect(lowIntensity.suggestion).toBeUndefined();
    expect(lowIntensity.bandNote).toContain("±5 bpm");
  });
});

// ── audit#2 (b): load-basis coverage over the window the metrics weight ──────

describe("load-basis coverage window", () => {
  it("judges coverage over the trailing 28 days, so pre-telemetry legacy runs cannot force the minutes basis", async () => {
    // Three legacy load-less runs outside the window the load metrics weight —
    // under the old 12-week test these alone dragged coverage below 0.9 and
    // flipped every load card onto minutes, where an hour of yoga counts like
    // an hour of tempo.
    for (let i = 0; i < 3; i++) {
      await seedActivity(userId, {
        date: addDays(today, -(35 + i * 10)),
        durationSeconds: 3600,
        lapCount: 0,
      });
    }
    // …and a fully covered recent month.
    for (let i = 0; i < 8; i++) {
      await seedActivity(userId, {
        date: addDays(today, -(1 + i * 3)),
        durationSeconds: 3600,
        trainingLoad: 50,
        lapCount: 0,
      });
    }

    const body = await client(cookie).get();
    const note = "Basis: COROS training load, all sports (coverage judged over the last 28 days).";
    expect(metric(body, "loadRatio").sampleNote).toContain(note);
    expect(metric(body, "monotony").sampleNote).toContain(note);
  });
});

describe("easy-discipline drill-down", () => {
  it("decides a run's verdict on the same raw average the tick used, not a rounded one", async () => {
    for (let i = 0; i < 4; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(2 + i * 3)),
        avgHeartRate: 130,
      });
    }
    // hrMax 180 → ceiling 144. This run is over it — but rounds down onto it,
    // so a drill-down that rounds first would call it easy while the metric
    // counted it against the percentage.
    const borderlineId = await seedMatchedRun(userId, "easy", {
      date: addDays(today, -15),
      avgHeartRate: 144.4,
      lapHeartRate: 144.4,
    });

    const body = await client(cookie).get();
    const easyDiscipline = metric(body, "easyDiscipline");

    expect(easyDiscipline.status).toBe("ok");
    expect(easyDiscipline.value).toBe("80%");
    const row = easyDiscipline.detail?.runs.find((r) => r.activityId === borderlineId);
    expect(row, "borderline run missing from the drill-down").toBeDefined();
    expect(row!.over).toBe(true);
    expect(row!.note).toContain("above your easy ceiling");
  });
});

describe("pacing drill-down", () => {
  it("ships a numeric delta whose sign always agrees with `over`", async () => {
    // Two runs that fade, two that finish faster — `computePacing` needs 4.
    const faded = [
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -3),
        lapDurationFactors: [0.9, 0.9, 1, 1.1, 1.1],
      }),
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -6),
        lapDurationFactors: [0.95, 0.95, 1, 1.05, 1.05],
      }),
    ];
    // Raw delta ≈ +0.03 s/km: it fades by an amount that rounds away entirely.
    // The published `delta` is 0, so the whole row — flag AND prose — has to
    // read as even. Deriving any of them from the raw number instead ships
    // over=true / "faded 0 s/km" beside a published delta of 0.
    const barelyFaded = await seedMatchedRun(userId, "easy", {
      date: addDays(today, -15),
      lapDurationFactors: [1, 1, 1, 1.0001, 1.0001],
    });
    // A real fade too small to survive rounding to a whole second (see the
    // assertion below for the exact figure).
    const smallFade = await seedMatchedRun(userId, "easy", {
      date: addDays(today, -18),
      lapDurationFactors: [1, 1, 1, 1.0013333333333334, 1.0013333333333334],
    });
    const negativeSplit = [
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -9),
        lapDurationFactors: [1.1, 1.1, 1, 0.9, 0.9],
      }),
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -12),
        lapDurationFactors: [1.05, 1.05, 1, 0.95, 0.95],
      }),
    ];

    const runs = metric(await client(cookie).get(), "pacing").detail?.runs;
    expect(runs, "pacing drill-down missing").toBeDefined();
    expect(runs!.length).toBeGreaterThanOrEqual(4);

    // The number a chart plots and the flag the prose uses must never
    // disagree — that is the whole reason `delta` exists instead of the
    // caller parsing the sign back out of "faded 12 s/km".
    for (const r of runs!) {
      expect(r.delta, `run ${r.activityId} has no delta`).toBeDefined();
      expect(r.delta! > 0).toBe(r.over === true);
    }
    for (const id of faded) {
      expect(runs!.find((r) => r.activityId === id)!.delta).toBeGreaterThan(0);
    }
    for (const id of negativeSplit) {
      expect(runs!.find((r) => r.activityId === id)!.delta).toBeLessThan(0);
    }
    const barely = runs!.find((r) => r.activityId === barelyFaded)!;
    expect(barely.delta).toBe(0);
    expect(barely.over).toBe(false);
    expect(barely.value).toBe("even split");
    expect(barely.note).toBe("First and second half effectively even.");

    // A real fade too small to survive rounding to a whole second: it must
    // keep its decimal rather than read "faded 0 s/km". (The exact figure
    // moved from 0.4 to 0.3 when halves started splitting by lap midpoint —
    // with 5 even laps the middle one now lands in the second half, where
    // decoupling.ts has always put it. The property under test is unchanged.)
    const small = runs!.find((r) => r.activityId === smallFade)!;
    expect(small.delta).toBe(0.3);
    expect(small.over).toBe(true);
    expect(small.value).toBe("faded 0.3 s/km");

    // No row may ever claim a direction in prose while publishing 0, nor
    // quote a magnitude of "0 s/km" for a delta it also calls nonzero.
    for (const r of runs!) {
      if (r.delta === 0) {
        expect(r.value, `run ${r.activityId}`).toBe("even split");
      } else {
        // \b so "50 s/km" doesn't read as a zero magnitude.
        expect(r.value, `run ${r.activityId}`).not.toMatch(/\b0 s\/km/);
      }
    }
    // Rounded to one decimal, never a raw float.
    for (const r of runs!) {
      expect(r.delta).toBe(Math.round(r.delta! * 10) / 10);
    }
  });

  it("keeps a run whose two laps are unequal — halves split by lap midpoint", async () => {
    // The old rule asked where a lap STARTED. Lap 1 starts at 0, so it always
    // went to the first half; a second lap starting before the halfway mark
    // went there too, leaving the second half EMPTY. `paceOf([])` returns 0,
    // the `> 0` guard then dropped the run, and a 4km/6km split — a warm-up
    // lap and the run — silently vanished from pacing.
    //
    // Under the midpoint rule (decoupling.ts's, now shared) lap 1's midpoint
    // is at 2km and lap 2's at 7km of a 10km run: one lap per half, as any
    // reader would expect from "two laps".
    for (let i = 0; i < 4; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(i * 3 + 2)),
        lapCount: 2,
        lapDistanceFactors: [0.8, 1.2], // 4km then 6km of a 10km run
      });
    }

    const pacing = metric(await client(cookie).get(), "pacing");
    expect(pacing.status, pacing.sampleNote).toBe("ok");
    expect(pacing.detail?.runs).toHaveLength(4);
  });
});

// ── (b) Category scoping ─────────────────────────────────────────────────────

describe("category scoping", () => {
  it('excludes an unmatched tempo run from aerobic efficiency (category "unknown", never a defaulted "easy")', async () => {
    const easyIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      easyIds.push(
        await seedMatchedRun(userId, "easy", { date: addDays(today, -(i * 4 + 2)) }),
      );
    }
    // Same shape, same eligibility on every axis except its category: it has
    // no completion match, so it must resolve to "unknown".
    const tempoId = await seedActivity(userId, {
      date: addDays(today, -3),
      title: "Tempo",
      avgHeartRate: 160,
    });

    const body = await client(cookie).get();

    expect(body.efficiency!.status).toBe("ok");
    const perRunIds = body.efficiency!.value!.perRun.map((p) => p.activityId);
    expect(perRunIds).not.toContain(tempoId);
    expect(perRunIds.sort()).toEqual([...easyIds].sort());
  });
});

// ── (c) User scoping ─────────────────────────────────────────────────────────

describe("user scoping", () => {
  it("never surfaces a second user's activities, laps or matches", async () => {
    // What this guards, stated honestly: with two users holding
    // identically-shaped data, nothing of the other user's reaches THIS
    // response. That is the property that breaks if one of the route's
    // chunked `inArray` fetches (laps, completion matches) loses its userId
    // predicate — which is the failure mode worth a test. It is not a claim
    // that this is the only place another account's rows could ever reach:
    // proving that is a job for scoping at the query layer, not one case here.
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) {
      mine.push(await seedMatchedRun(userId, "easy", { date: addDays(today, -(i * 4 + 2)) }));
    }

    const other = await makeTestUser(db);
    const theirs: string[] = [];
    for (let i = 0; i < 3; i++) {
      theirs.push(
        await seedMatchedRun(other.userId, "easy", { date: addDays(today, -(i * 4 + 2)) }),
      );
    }
    const theirLaps = await db.select().from(activityLaps);
    const theirLapIds = theirLaps
      .filter((l) => theirs.includes(l.activityId))
      .map((l) => l.id);
    expect(theirLapIds.length).toBeGreaterThan(0);

    const body = await client(cookie).get();
    const json = JSON.stringify(body);

    expect(body.efficiency!.status).toBe("ok");
    expect(body.efficiency!.value!.perRun.map((p) => p.activityId).sort()).toEqual(
      [...mine].sort(),
    );
    // Consistency saw only this user's three planned workouts.
    expect(body.consistency.planned).toBe(3);
    for (const id of [...theirs, ...theirLapIds]) expect(json).not.toContain(id);
  });
});

// ── (d) Evidence rotation ────────────────────────────────────────────────────

describe("evidence rotation", () => {
  it("surfaces the next card after the top one is dismissed, instead of null", async () => {
    // Comeback pattern: a 10-day break, then three runs 2 days apart.
    for (const date of [
      addDays(today, -70),
      addDays(today, -60),
      addDays(today, -58),
      addDays(today, -56),
    ]) {
      await seedActivity(userId, { date, lapCount: 0 });
    }
    // Morning-heavy plan history so the SECOND card in the chain also
    // qualifies: 12 morning workouts (10 completed) + 3 evening.
    for (let i = 0; i < 12; i++) {
      await seedWorkout(userId, {
        date: addDays(today, -(i + 2)),
        category: "quality",
        effectiveTime: "07:00",
        completionState: i < 10 ? "completed" : "missed",
      });
    }
    for (let i = 0; i < 3; i++) {
      await seedWorkout(userId, {
        date: addDays(today, -(i + 20)),
        category: "quality",
        effectiveTime: "18:00",
        completionState: "completed",
      });
    }

    const api = client(cookie);
    const first = await api.get();
    expect(first.evidence).not.toBeNull();
    expect(first.evidence!.text).toContain("After a break of 7 or more days");

    const res = await api.dismiss(first.evidence!.id);
    expect(res.status).toBe(200);

    const second = await api.get();
    expect(second.evidence).not.toBeNull();
    expect(second.evidence!.id).not.toBe(first.evidence!.id);
    expect(second.evidence!.text).toBe(
      "You complete 83% of morning runs (10 of 12 scheduled before noon).",
    );
  });
});

// ── (e) Records persistence ──────────────────────────────────────────────────

describe("records persistence", () => {
  it("keeps a stored record whose achieving run has left the 12-week window", async () => {
    const achievedOn = addDays(today, -400);
    await db.insert(computedMetrics).values({
      id: `records:v1:${userId}`,
      userId,
      metricKey: "records:v1",
      computedAt: nowInstant(),
      inputFingerprint: "seed",
      status: "ok",
      sampleSize: 1,
      value: {
        records: [
          {
            id: "best_aerobic_efficiency",
            title: "Best aerobic efficiency",
            value: "1.45 m/beat",
            achievedOn,
            rule: "Highest meters travelled per heart beat on any eligible easy or recovery run of 25+ minutes with heart rate.",
            numeric: 1.45,
          },
        ],
      },
    });

    // Five in-window easy runs, all measurably WORSE than the stored record
    // (10 km in 50 min at 150 bpm ≈ 1.33 m/beat).
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(i * 4 + 2)),
        avgHeartRate: 150,
        lapHeartRate: 150,
      });
    }

    const body = await client(cookie).get();

    // Namespaced on the way in: the legacy row's bare ids were all runs, and
    // seeding them into records:v2:run keeps one id space.
    const best = body.records.find((r) => r.id === "run:best_aerobic_efficiency");
    expect(best, "stored record dropped from the response").toBeDefined();
    expect(best!.value).toBe("1.45 m/beat");
    expect(best!.achievedOn).toBe(achievedOn);

    // …and it is still persisted after the read-merge-write, in ONE row (the
    // upsert must land on the existing (userId, metricKey) row, not beside it).
    // Two rows now: the inert legacy one, plus this discipline's own. The
    // upsert must still land ON the v2 row rather than beside it.
    const rows = await db
      .select()
      .from(computedMetrics)
      .where(eq(computedMetrics.userId, userId));
    const v2 = rows.filter((r) => r.metricKey === "records:v2:run");
    expect(v2).toHaveLength(1);
    const stored = (v2[0]!.value as { records: Array<{ id: string; numeric: number }> }).records;
    expect(stored.find((r) => r.id === "run:best_aerobic_efficiency")!.numeric).toBeCloseTo(1.45, 5);
  });
});

// ── (f) Payload shape ────────────────────────────────────────────────────────

describe("payload shape", () => {
  it("drops timeOfDay, renames drift to decoupling, and ships the new interpreted set", async () => {
    for (let i = 0; i < 5; i++) {
      await seedMatchedRun(userId, "easy", { date: addDays(today, -(i * 3 + 2)) });
    }

    const body = (await client(cookie).get()) as unknown as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        "availableDisciplines",
        "consistency",
        "decoupling",
        "discipline",
        "efficiency",
        "evidence",
        "interpreted",
        "records",
        "reviews",
        "weekly",
      ].sort(),
    );
    expect(body).not.toHaveProperty("timeOfDay");
    expect(body).not.toHaveProperty("drift");

    const typed = body as unknown as InsightsBody;
    expect(typed.decoupling!.status).toBeDefined();
    if (typed.decoupling!.status === "ok") {
      expect(typed.decoupling!.value!.excluded.reasons.length).toBeLessThanOrEqual(5);
    }

    expect(typed.interpreted.map((m) => m.id)).toEqual([
      "loadRatio",
      "ramp",
      "monotony",
      "restingHr",
      "hrv",
      "hardStack",
      "lowIntensityShare",
      "easyDiscipline",
      "pacing",
    ]);
    // The retired ids must be gone, not merely renamed in the title.
    for (const dead of ["acwr", "balance", "splits"]) {
      expect(typed.interpreted.map((m) => m.id)).not.toContain(dead);
    }

    // Banded cards carry the numeric gauge edges the dashboard draws — except
    // hardStack/easyDiscipline, which draw as strips (boxes), not gauges;
    // shipping both would leave the gauge>strip tile-visual priority hiding
    // the strip the dashboard actually wants for these two.
    const easyDiscipline = metric(typed, "easyDiscipline");
    expect(easyDiscipline.gauge).toBeUndefined();
    expect(easyDiscipline.strip).toHaveLength(5);
    expect(easyDiscipline.strip!.every((t) => t.on)).toBe(true);

    // hardStack is always computable (0 is a valid answer) and ships a strip,
    // not a gauge.
    const hardStack = metric(typed, "hardStack");
    expect(hardStack.gauge).toBeUndefined();
    expect(hardStack.strip).toHaveLength(7);
  });

  it("ships restingHr/hrv baseline bands in the SERIES' units, not the gauge's", async () => {
    // 40 consecutive days of flat readings: enough for both metrics' gates
    // (restingHr needs 7, hrv needs 17) and perfectly deterministic — zero
    // variability sends hrv's thresholdPct to its documented 10% default.
    for (let i = 0; i < 40; i++) {
      const date = addDays(today, -i);
      await db.insert(schema.dailyHealth).values({
        id: `${userId}:${date}`,
        userId,
        date,
        restingHeartRate: 48,
        hrv: 60,
        recoveryScore: null,
        fatigueScore: null,
        trainingLoad7d: null,
        provider: "coros",
        contentFingerprint: `seed-${date}`,
        updatedAt: nowInstant(),
      });
    }

    const typed = await client(cookie).get();

    const restingHr = metric(typed, "restingHr");
    expect(restingHr.status).toBe("ok");
    // bpm — the same unit as `series`, so the drilldown chart can shade the
    // band directly against the readings. ±5 bpm is the metric's own watch
    // threshold (deltaBpm >= 5).
    expect(restingHr.baseline).toEqual({ value: 48, lo: 43, hi: 53, unit: "bpm" });
    expect(restingHr.series![0]!.value).toBe(48);

    const hrv = metric(typed, "hrv");
    expect(hrv.status).toBe("ok");
    // ms — NOT the gauge's units. This is the whole reason the field exists:
    // hrv's gauge is drawn in percent-vs-baseline (a −25…25 scale), while its
    // series is raw milliseconds, so the gauge's healthy edges would shade
    // the wrong part of the chart entirely.
    expect(hrv.baseline).toEqual({ value: 60, lo: 54, hi: 66, unit: "ms" });
    expect(hrv.gauge!.min).toBe(-25);
    expect(hrv.gauge!.max).toBe(25);
    expect(hrv.series![0]!.value).toBe(60);

    // A metric with no daily series carries no baseline to draw one against.
    expect(metric(typed, "monotony").baseline).toBeUndefined();
  });

  it("ships loadRatio's baseline of 1 — the norm by construction — so the tile drills down", async () => {
    // Enough daily running for computeLoadRatio's own gates; the exact ratio
    // doesn't matter here, only that the band travels with it.
    for (let i = 0; i < 42; i++) {
      await seedMatchedRun(userId, "easy", { date: addDays(today, -i), lapCount: 0 });
    }

    const loadRatio = metric(await client(cookie).get(), "loadRatio");
    expect(loadRatio.status, loadRatio.sampleNote).toBe("ok");
    // 1.0 means "this week looks like your norm" by construction — the ratio
    // is this week over the month behind it — and 0.8–1.3 is the sweet spot
    // the gauge already draws. Emitting them as a baseline in the SERIES' unit
    // is what makes `hasDrilldown` open the band chart for this tile.
    expect(loadRatio.baseline).toEqual({ value: 1, lo: 0.8, hi: 1.3, unit: "× norm" });
    expect(loadRatio.series!.length).toBeGreaterThan(0);
    // The UI gate, restated here so a payload change can't silently un-drill it.
    expect(!!loadRatio.baseline && loadRatio.series!.length > 0).toBe(true);
  });

  it("suppresses restingHr when the only recent reading stands alone across a 45-day gap", async () => {
    // The recency failure, at the route: one fresh 47 and six readings from
    // 45-50 days ago clears the "7 valid readings in 60 days" count gate and
    // the "newest reading is recent" staleness gate, yet a median of the 3
    // newest would be 58 — a "watch" verdict describing seven weeks ago.
    const insert = async (date: string, bpm: number) => {
      await db.insert(schema.dailyHealth).values({
        id: `${userId}:${date}`,
        userId,
        date,
        restingHeartRate: bpm,
        hrv: null,
        recoveryScore: null,
        fatigueScore: null,
        trainingLoad7d: null,
        provider: "coros",
        contentFingerprint: `seed-${date}`,
        updatedAt: nowInstant(),
      });
    };
    await insert(today, 47);
    for (let i = 0; i < 6; i++) await insert(addDays(today, -(45 + i)), 58);

    const restingHr = metric(await client(cookie).get(), "restingHr");
    expect(restingHr.status).toBe("insufficient_data");
    // Never the stale number, and never the verdict built on it.
    expect(restingHr.value).toBeUndefined();
    expect(restingHr.band).toBeUndefined();
    expect(JSON.stringify(restingHr)).not.toContain("58 bpm");
    // The card explains the gap rather than going quiet (`interpret` puts the
    // metric's explanation in `meaning` for the insufficient branch).
    expect(restingHr.meaning).toContain("last 5 days");
    expect(restingHr.meaning).toContain("45 days old");
  });

  it("emits the partial current week and the silent weeks before it after a layoff", async () => {
    // Six weeks of running that stopped five weeks ago. The weekly bars used
    // to end at the last week trained, which reads as "up to date", and the
    // 4-week average was taken over the last four weeks TRAINED.
    for (let i = 0; i < 6; i++) {
      await seedMatchedRun(userId, "easy", {
        date: addDays(today, -(35 + i * 7)),
        durationSeconds: 3600,
        lapCount: 0,
      });
    }

    const body = await client(cookie).get();
    const weeks = body.weekly.weeks;
    expect(weeks.length).toBeGreaterThan(6);

    // The last row is the current, partial week — and it is the only partial one.
    const last = weeks[weeks.length - 1]!;
    expect(last.partial).toBe(true);
    expect(weeks.filter((w) => w.partial)).toHaveLength(1);
    expect(last.weekStart).toBe(startOfIsoWeek(today));

    // The silent weeks are present as zero rows, not missing.
    const trailingZeros = weeks.slice(-4).filter((w) => w.durationSeconds === 0);
    expect(trailingZeros.length).toBeGreaterThanOrEqual(3);

    // And the average now says so: zero weeks count.
    expect(body.weekly.fourWeekAvgDuration).toBe(0);
  });
});
