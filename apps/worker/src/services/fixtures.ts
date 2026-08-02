import { eq } from "drizzle-orm";
import { desktopDevices, users } from "@rg/database";
import { addDays, fingerprint, newId, nowInstant, todayInZone, type SourceActivity } from "@rg/domain";
import {
  FixtureTrainingProvider,
  fixtureCorosCompletedStrength,
  fixtureCorosCompletedThreshold,
  fixtureCorosCompletedYoga,
  fixtureStravaCompletedThreshold,
  normalizeCorosActivity,
  normalizeCorosLaps,
  normalizeStravaActivity,
} from "@rg/providers";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { importPlanSnapshot } from "./import-plan.js";
import { ingestActivities } from "./completion.js";
import { loadPreferences, savePreferences } from "./calendar-sync.js";
import { advanceGarden, ensureGarden } from "./garden-sync.js";
import { reconcileCompletionStates } from "./reconcile-daily.js";
import { dailyHealth, sleepRecords } from "@rg/database";

/**
 * Development fixture seeding. NEVER active silently: requires FIXTURE_MODE=1
 * and an explicit authenticated request; the UI shows a persistent banner.
 *
 * Builds a realistic history: a 12-week plan in progress (~9 weeks in),
 * completed runs with COROS+Strava duplicates, a missed week (drought),
 * a comeback, sleep/health variation, and a registered virtual device.
 */

const WEEK: Array<{ offset: number; kind: "rest" | "quality" | "easy" | "strides" | "long" | "recovery" }> = [
  { offset: 0, kind: "rest" },
  { offset: 1, kind: "quality" },
  { offset: 2, kind: "easy" },
  { offset: 3, kind: "strides" },
  { offset: 4, kind: "rest" },
  { offset: 5, kind: "long" },
  { offset: 6, kind: "recovery" },
];

function syntheticActivity(
  date: string,
  kind: string,
  index: number,
  provider: "coros" | "strava",
): SourceActivity {
  const localHour = kind === "recovery" ? 19 : 7;
  const minute = index % 6;
  const base: Record<string, { dur: number; dist: number; hr: number; load: number }> = {
    quality: { dur: 3255, dist: 9860, hr: 158, load: 82 },
    easy: { dur: 2760, dist: 7300, hr: 138, load: 38 },
    strides: { dur: 2400, dist: 6800, hr: 141, load: 35 },
    long: { dur: 6720, dist: 18100, hr: 145, load: 96 },
    recovery: { dur: 1810, dist: 4500, hr: 124, load: 16 },
  };
  const spec = base[kind] ?? base.easy!;
  const jitter = (index * 37) % 120;
  const hh = String(localHour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const startTimeLocal = `${date}T${hh}:${mm}:00`;
  // Local PDT (UTC-7): 07:00 local → 14:00Z same day; 19:00 local → 02:00Z next day.
  const utcHour = localHour + 7;
  const nextDay = utcHour >= 24;
  const utcIso = nextDay
    ? `${addDays(date, 1)}T${String(utcHour - 24).padStart(2, "0")}:${mm}:00Z`
    : `${date}T${String(utcHour).padStart(2, "0")}:${mm}:00Z`;
  return {
    provider,
    providerActivityId: `${provider}-fx-${date}-${kind}`,
    startTime: utcIso,
    startTimeLocal,
    timezone: "America/Los_Angeles",
    sport: "run",
    durationSeconds: spec.dur + jitter,
    elapsedSeconds: spec.dur + jitter + 45,
    distanceMeters: spec.dist + jitter * 2,
    avgHeartRate: spec.hr + (index % 4),
    maxHeartRate: spec.hr + 18,
    elevationGainMeters: 40 + (index % 5) * 12,
    trainingLoad: spec.load,
    deviceName: "COROS PACE 3",
    title:
      provider === "strava"
        ? `${kind === "quality" ? "Morning Threshold" : kind === "long" ? "Long Run Sunday" : "Morning Run"}`
        : undefined,
    summaryPolyline: provider === "strava" ? `poly-${date}` : undefined,
    contentFingerprint: fingerprint({ date, kind, provider }),
  };
}

export interface SeedResult {
  planImported: boolean;
  activitiesIngested: number;
  gardenDays: number;
}

export async function seedFixtures(db: Db, env: Env, userId: string): Promise<SeedResult> {
  // The fixture user simulates someone who already passed the write spike and
  // opted into COROS writes, so the demo shows the full synced flow.
  const loaded = await loadPreferences(db, userId);
  const prefs = { ...loaded, corosWritesEnabled: true };
  await savePreferences(db, userId, prefs);
  const today = todayInZone(prefs.timezone);

  // Reset garden state so re-seeding rebuilds history from the plan start.
  const { gardenState, gardenEvents, gardenSnapshots, gardenDayInputs, gardenPlants } = await import("@rg/database");
  await db.delete(gardenState).where(eq(gardenState.userId, userId));
  await db.delete(gardenEvents).where(eq(gardenEvents.userId, userId));
  await db.delete(gardenSnapshots).where(eq(gardenSnapshots.userId, userId));
  await db.delete(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
  await db.delete(gardenPlants).where(eq(gardenPlants.userId, userId));
  // Plan started ~9 weeks ago (Monday), runs 12 weeks.
  const monday = addDays(today, -((9 * 7) + ((Number(new Date(today).getUTCDay()) + 6) % 7)));

  const provider = new FixtureTrainingProvider({ baseMonday: monday });
  const plan = await provider.getCurrentPlan();
  // Two-week template window repeated: import per two-week block for coverage.
  const allWorkouts = [] as Awaited<ReturnType<typeof provider.getPlannedWorkouts>>;
  for (let block = 0; block < 6; block++) {
    const blockProvider = new FixtureTrainingProvider({ baseMonday: addDays(monday, block * 14) });
    const w = await blockProvider.getPlannedWorkouts({
      start: addDays(monday, block * 14),
      end: addDays(monday, block * 14 + 13),
    });
    // Re-key ids so blocks don't collide.
    allWorkouts.push(
      ...w.map((x) => ({
        ...x,
        sourceWorkoutId: `${x.sourceWorkoutId}-b${block}`,
        sourceIdInPlan: `${x.sourceIdInPlan}-b${block}`,
        sourceProgramId: x.sourceProgramId ? `${x.sourceProgramId}-b${block}` : undefined,
      })),
    );
  }

  await importPlanSnapshot(
    db,
    {
      userId,
      plan: { ...plan!, startDate: monday, endDate: addDays(monday, 83) },
      workouts: allWorkouts,
      rangeStart: monday,
      rangeEnd: addDays(monday, 83),
      source: "fixture",
      corosWriteAvailable: true,
    },
    prefs,
  );

  // Register a virtual desktop device so sync states render realistically.
  const existingDevice = await db
    .select()
    .from(desktopDevices)
    .where(eq(desktopDevices.userId, userId));
  if (existingDevice.length === 0) {
    await db.insert(desktopDevices).values({
      id: newId(),
      userId,
      name: "Fixture MacBook",
      publicKey: "fixture-not-a-real-key",
      platform: "macos",
      appVersion: "0.1.0",
      bridgeVersion: "0.1.0",
      capabilities: {
        readPlan: true,
        readSchedule: true,
        readActivities: true,
        readHealth: true,
        readNativeDurationEstimate: true,
        calculateWorkout: true,
        updateExistingScheduledWorkout: true,
        addScheduledWorkout: true,
        removeScheduledWorkout: true,
        verifyWatchSync: false,
      },
      createdAt: nowInstant(),
      lastSeenAt: nowInstant(),
    });
  }

  // History: weeks 0-5 consistent; week 6 fully missed (drought seed);
  // week 7 comeback; week 8 consistent. COROS + Strava duplicates for most.
  const sources: SourceActivity[] = [];
  const lapsByProviderId: Record<string, never[]> = {};
  let index = 0;
  for (let week = 0; week < 9; week++) {
    for (const day of WEEK) {
      const date = addDays(monday, week * 7 + day.offset);
      if (date >= today) continue;
      if (day.kind === "rest") continue;
      if (week === 6) continue; // the missed week
      if (week === 7 && day.offset < 3) continue; // comeback starts mid-week
      if (week === 2 && day.offset === 3) continue; // one skipped strides day

      const coros = syntheticActivity(date, day.kind, index, "coros");
      sources.push(coros);
      // Most runs also have the Strava copy (auto-synced by COROS).
      if (index % 5 !== 4) sources.push(syntheticActivity(date, day.kind, index, "strava"));
      index++;
    }
  }
  // One rich structured threshold with laps (uses the shared fixture).
  const lastQualityDate = addDays(monday, 8 * 7 + 1);
  if (lastQualityDate < today) {
    const { item, detail } = fixtureCorosCompletedThreshold(
      `${lastQualityDate}T14:02:05Z`,
      `coros-fx-rich-${lastQualityDate}`,
    );
    sources.push(normalizeCorosActivity(item, detail));
    sources.push(
      normalizeStravaActivity(fixtureStravaCompletedThreshold(`${lastQualityDate}T14:02:05Z`, 99_000_001)),
    );
    lapsByProviderId[`coros-fx-rich-${lastQualityDate}`] = normalizeCorosLaps(detail) as never[];
  }

  // A strength session and a yoga session — unplanned bonus activities that
  // exercise the tri-discipline garden's strength/yoga clocks and the balance
  // axis. Both land on the Friday of week 7 (the plan's second-to-last full
  // week — recent enough that the balance bars show live health instead of
  // having fully decayed, and inside the Activity screen's most-recent
  // window): that Friday falls on the second Friday of its two-week fixture
  // schedule block, which the template leaves entirely unscheduled, so there
  // is no planned run to spuriously match against.
  const strengthYogaDate = addDays(monday, 7 * 7 + 4);
  if (strengthYogaDate < today) {
    const yogaItem = fixtureCorosCompletedYoga(
      `${strengthYogaDate}T14:15:00Z`,
      `coros-fx-yoga-${strengthYogaDate}`,
    );
    sources.push(normalizeCorosActivity(yogaItem));
    const strengthItem = fixtureCorosCompletedStrength(
      `${strengthYogaDate}T19:00:00Z`,
      `coros-fx-strength-${strengthYogaDate}`,
    );
    sources.push(normalizeCorosActivity(strengthItem));
  }

  const ingest = await ingestActivities(db, { userId, sources, lapsByProviderId });

  // Health + sleep history with variation.
  const now = nowInstant();
  for (let i = 0; i < 60; i++) {
    const date = addDays(today, -i);
    if (date < monday) break;
    await db
      .insert(dailyHealth)
      .values({
        id: `${userId}:${date}`,
        userId,
        date,
        restingHeartRate: 44 + (i % 5),
        hrv: 58 + ((i * 7) % 18),
        recoveryScore: 60 + ((i * 11) % 35),
        trainingLoad7d: 280 + ((i * 13) % 120),
        provider: "coros",
        contentFingerprint: fingerprint({ date, i }),
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db
      .insert(sleepRecords)
      .values({
        id: `${userId}:${date}`,
        userId,
        date,
        durationSeconds: (6.4 + ((i * 17) % 100) / 60) * 3600,
        deepSeconds: 4800 + (i % 4) * 300,
        remSeconds: 5400 + (i % 3) * 400,
        qualityScore: 62 + ((i * 5) % 30),
        provider: "coros",
        contentFingerprint: fingerprint({ date, sleep: i }),
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  // Resolve old unresolved workouts, then simulate the whole garden history
  // from the plan start so months of history replay into the garden.
  await reconcileCompletionStates(db, userId, prefs);
  await ensureGarden(db, userId, prefs, monday);
  const garden = await advanceGarden(db, userId, prefs);

  return {
    planImported: true,
    activitiesIngested: ingest.newActivities + ingest.mergedPairs,
    gardenDays: garden.simulatedDays,
  };
}

/** Fixture-mode sign-in bypass user (dev only). */
export async function ensureFixtureUser(db: Db, email: string): Promise<string> {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return existing[0].id;
  const id = newId();
  await db.insert(users).values({ id, email, name: "Fixture Runner", googleSub: null, createdAt: nowInstant() });
  return id;
}
