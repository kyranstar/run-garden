import { and, eq, inArray } from "drizzle-orm";
import {
  auditEvents,
  corosWriteJobs,
  providerConnections,
  llmUsage,
  studioPlanPushes,
  studioPlans,
  users,
} from "@rg/database";
import {
  addDays,
  fingerprint,
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  type LiftingPlan,
  type LocalDate,
  type SourceActivity,
  type StudioExercise,
  type StudioSession,
} from "@rg/domain";
import {
  FixtureTrainingProvider,
  fixtureCorosCompletedStrength,
  fixtureCorosCompletedThreshold,
  fixtureCorosCompletedYoga,
  normalizeCorosActivity,
  normalizeCorosLaps,
} from "@rg/providers";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { importPlanSnapshot } from "./import-plan.js";
import { ingestActivities } from "./completion.js";
import { loadPreferences, savePreferences } from "./calendar-sync.js";
import { advanceGarden, ensureGarden } from "./garden-sync.js";
import { reconcileCompletionStates } from "./reconcile-daily.js";
import { upsertExerciseCatalog } from "./exercise-catalog.js";
import { dailyHealth, sleepRecords } from "@rg/database";

/**
 * A small curated Plan Studio exercise catalog (plan-studio-design §4/§8).
 * Production syncs ~382 real COROS ids via the bridge; fixture mode has no
 * bridge device, so nothing ever populates `coros_exercises` unless seeded
 * here — without it, `generatePlan`'s FIXTURE_MODE path has no ids to build
 * a canned plan from (studio-llm.ts's fixture builder returns `null` on an
 * empty catalog). The first two ids match the ones already used as fixtures
 * in the Task 3 push-orchestration tests, for a consistent fixture world.
 */
const FIXTURE_EXERCISE_CATALOG = [
  { id: "425898928110747648", name: "Back Squat" },
  { id: "426109589008859137", name: "Bench Press" },
  { id: "425898928110747650", name: "Deadlift" },
  { id: "425898928110747651", name: "Overhead Press" },
  { id: "425898928110747652", name: "Pull Up" },
  { id: "425898928110747653", name: "Bent-Over Row" },
  { id: "425898928110747654", name: "Romanian Deadlift" },
  { id: "425898928110747655", name: "Plank" },
  // Real ids and real i18n KEYS, copied from the production catalog
  // (2026-08-16). The eight rows above are human-named, which the live
  // catalog never is — all 382 synced names are T-codes — so without these
  // nothing in fixture mode exercised the key→English path that the coach's
  // name→originId resolution depends on. These are the movements a
  // lower-body / ski-prep session actually asks for.
  { id: "469646870080307200", name: "T1231" }, // Wall Sit
  { id: "425827856334110721", name: "T1010" }, // Planks
  { id: "428453358030995457", name: "T1185" }, // Side Plank
  { id: "469664891494645760", name: "T1368" }, // Copenhagen Plank
  { id: "469654960724951040", name: "T1275" }, // Single-Leg Calf Raise
  { id: "425832417320943617", name: "T1070" }, // Standing Calf Raises
  { id: "425832054396207105", name: "T1061" }, // Squats
  { id: "426801851300757504", name: "T1167" }, // Single Leg Squats
  { id: "425845051235680257", name: "T1086" }, // TRX Suspended Split Squat
  { id: "425832124457861121", name: "T1064" }, // Dumbbell Lunges
  { id: "426618429085237248", name: "T1150" }, // Bird Dog
  { id: "426801473612070912", name: "T1160" }, // Single Leg Bridge
  { id: "425828538697039872", name: "T1014" }, // Box Jumps
  { id: "425830845094477824", name: "T1033" }, // Bridge
  { id: "426801647558246401", name: "T1164" }, // Split Bench Squat
  { id: "469664598899998720", name: "T1365" }, // Nordic Hamstring Curl
  { id: "469664622790754304", name: "T1367" }, // Reverse Step-Down
  { id: "426939619892969472", name: "T1174" }, // Ski Step
  { id: "469646614529753088", name: "T1217" }, // Lateral Squats
];
const [SQUAT, BENCH, DEADLIFT, OHP, PULLUP, ROW, RDL, PLANK] = FIXTURE_EXERCISE_CATALOG.map((e) => e.id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

function kg(originId: string, name: string, sets: number, reps: number, value: number, restSeconds = 90): StudioExercise {
  return { originId, name, sets, reps, weight: { type: "kg", value }, restSeconds };
}

function bodyweight(
  originId: string,
  name: string,
  sets: number,
  reps: number,
  restSeconds = 75,
  note?: string,
): StudioExercise {
  return { originId, name, sets, reps, weight: { type: "bodyweight" }, restSeconds, ...(note ? { note } : {}) };
}

/**
 * Plan Studio fixture world (plan-studio-design §8): a small 2-week, 3-day
 * lifting plan built from `FIXTURE_EXERCISE_CATALOG`, exercising every
 * `studio_plan_pushes` status the Studio UI renders differently:
 *
 *  - week 1 (the past week) is fully resolved — one `verified` session, one
 *    `failed` session that IS still retryable and carries a `corosHappenDay`
 *    (so `PushRowStatus`'s "Failed — still on calendar" branch renders), and
 *    one `changed_on_coros` session (drifted after an earlier verify — the
 *    disabled "Forget / re-adopt" affordance and "changed outside the
 *    studio" copy).
 *  - week 2 (the current week) is still a draft: its Monday session is
 *    `pending` with a `queued` bridge job (so the studio's "waiting for your
 *    Mac" banner and the pill-progress chip both render), and its remaining
 *    two sessions have never been pushed at all — the diff strip's honest
 *    "+2 new" count.
 *
 * `today` is the account's own local today (`todayInZone`, same as the rest
 * of `seedFixtures`) — never a UTC default, for the same reason every other
 * date-sensitive call in this module takes it as a parameter rather than
 * recomputing its own.
 */
function buildFixtureStudioPlan(today: LocalDate): { plan: LiftingPlan; monday: LocalDate } {
  // The plan's own grid is anchored to the ISO week containing its
  // `startDate` (studio-push.ts's `sessionHappenDay`) — last week's Monday,
  // so week 1 (index 0) has already happened and week 2 (index 1) is this
  // week, still open to push.
  const monday = addDays(startOfIsoWeek(today), -7);

  const week1Sessions: StudioSession[] = [
    {
      title: "Upper A",
      weekday: 1,
      exercises: [kg(BENCH, "Bench Press", 4, 6, 60), kg(ROW, "Bent-Over Row", 4, 8, 50), kg(OHP, "Overhead Press", 3, 8, 35)],
    },
    {
      title: "Lower A",
      weekday: 3,
      exercises: [
        kg(SQUAT, "Back Squat", 4, 6, 70),
        kg(DEADLIFT, "Deadlift", 3, 5, 90),
        kg(RDL, "Romanian Deadlift", 3, 8, 60),
        bodyweight(PLANK, "Plank", 3, 1, 60, "30s hold"),
      ],
    },
    {
      title: "Upper B",
      weekday: 5,
      exercises: [
        bodyweight(PULLUP, "Pull Up", 4, 6, 90),
        kg(BENCH, "Bench Press", 3, 10, 55),
        kg(ROW, "Bent-Over Row", 3, 10, 45),
      ],
    },
  ];
  // Week 2 mirrors week 1's split with a small progressive-overload bump.
  const week2Sessions: StudioSession[] = [
    {
      title: "Upper A",
      weekday: 1,
      exercises: [kg(BENCH, "Bench Press", 4, 6, 62.5), kg(ROW, "Bent-Over Row", 4, 8, 52.5), kg(OHP, "Overhead Press", 3, 8, 37.5)],
    },
    {
      title: "Lower A",
      weekday: 3,
      exercises: [
        kg(SQUAT, "Back Squat", 4, 6, 72.5),
        kg(DEADLIFT, "Deadlift", 3, 5, 92.5),
        kg(RDL, "Romanian Deadlift", 3, 8, 62.5),
        bodyweight(PLANK, "Plank", 3, 1, 60, "35s hold"),
      ],
    },
    {
      title: "Upper B",
      weekday: 5,
      exercises: [
        bodyweight(PULLUP, "Pull Up", 4, 7, 90),
        kg(BENCH, "Bench Press", 3, 10, 57.5),
        kg(ROW, "Bent-Over Row", 3, 10, 47.5),
      ],
    },
  ];

  const plan: LiftingPlan = {
    name: "Full Body Strength — Fixture",
    brief: {
      goal: "strength",
      durationWeeks: 2,
      sessionsPerWeek: 3,
      preferredDays: [1, 3, 5],
      sessionMinutes: 55,
      equipment: "full gym",
      constraints: "",
      notes: "Seeded by the fixture world (apps/worker/src/services/fixtures.ts).",
      startDate: monday,
    },
    weeks: [{ sessions: week1Sessions }, { sessions: week2Sessions }],
  };
  return { plan, monday };
}

async function seedStudioFixtures(db: Db, userId: string, today: LocalDate): Promise<void> {
  const { plan, monday } = buildFixtureStudioPlan(today);
  const now = nowInstant();

  // Wipe any prior fixture studio world for this user so re-seeding is
  // idempotent — a fresh plan id every run means no unique-index collisions,
  // so a clean delete-then-recreate is simpler than upserting in place.
  const oldPlans = await db.select({ id: studioPlans.id }).from(studioPlans).where(eq(studioPlans.userId, userId));
  const oldPlanIds = oldPlans.map((p) => p.id);
  if (oldPlanIds.length > 0) {
    await db.delete(studioPlanPushes).where(inArray(studioPlanPushes.planId, oldPlanIds));
  }
  await db.delete(studioPlans).where(eq(studioPlans.userId, userId));
  await db
    .delete(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, ["create_scheduled_workout", "delete_scheduled_workout"]),
      ),
    );
  await db
    .delete(auditEvents)
    .where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, "studio_plan_pushed")));
  await db
    .delete(llmUsage)
    .where(and(eq(llmUsage.userId, userId), inArray(llmUsage.kind, ["studio_generate", "studio_edit"])));

  const planId = newId();
  await db.insert(studioPlans).values({
    id: planId,
    userId,
    brief: plan.brief as unknown as Record<string, unknown>,
    plan: plan as unknown as Record<string, unknown>,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  const week1 = plan.weeks[0]!.sessions;
  const week2 = plan.weeks[1]!.sessions;
  const upperA1 = week1[0]!;
  const lowerA1 = week1[1]!;
  const upperB1 = week1[2]!;
  const upperA2 = week2[0]!;

  const stamp = (title: string, weekIndex: number): string => `${title} — wk ${weekIndex + 1}`;
  const happenDay = (weekIndex: number, weekday: number): LocalDate =>
    addDays(monday, weekIndex * 7 + (weekday - 1));

  // 1. verified — the plain-good state.
  const verifiedDay = happenDay(0, upperA1.weekday);
  await db.insert(studioPlanPushes).values({
    id: newId(),
    planId,
    planVersion: 1,
    happenDay: verifiedDay,
    sessionTitle: stamp(upperA1.title, 0),
    corosIdInPlan: "8001",
    corosProgramId: "8001",
    corosEntityId: "90001",
    corosPlanId: "fixture-container-plan-1",
    corosHappenDay: verifiedDay,
    sessionFingerprint: fingerprint(upperA1),
    status: "verified",
    error: null,
    updatedAt: now,
  });

  // 2. failed, retryable, still on the calendar (mapCreateResult's
  //    `wrong_date`: ids persisted, COROS filed it a day off from what was
  //    asked). Exercises PushRowStatus's "Failed — still on calendar" copy.
  const lowerA1Day = happenDay(0, lowerA1.weekday);
  await db.insert(studioPlanPushes).values({
    id: newId(),
    planId,
    planVersion: 1,
    happenDay: lowerA1Day,
    sessionTitle: stamp(lowerA1.title, 0),
    corosIdInPlan: "8002",
    corosProgramId: "8002",
    corosEntityId: "90002",
    corosPlanId: "fixture-container-plan-1",
    corosHappenDay: addDays(lowerA1Day, 1),
    sessionFingerprint: fingerprint(lowerA1),
    status: "failed",
    error: "wrong_date",
    updatedAt: now,
  });

  // 3. changed_on_coros — previously verified, then found renamed/moved on a
  //    later drift check. The forget/re-adopt button stays disabled for this
  //    one; retry is intentionally not offered (see studio.tsx PushRowStatus).
  const upperB1Day = happenDay(0, upperB1.weekday);
  await db.insert(studioPlanPushes).values({
    id: newId(),
    planId,
    planVersion: 1,
    happenDay: upperB1Day,
    sessionTitle: stamp(upperB1.title, 0),
    corosIdInPlan: "8003",
    corosProgramId: "8003",
    corosEntityId: "90003",
    corosPlanId: "fixture-container-plan-1",
    corosHappenDay: upperB1Day,
    sessionFingerprint: fingerprint(upperB1),
    status: "failed",
    error: "changed_on_coros",
    updatedAt: now,
  });

  // 4. pending — a create job queued but not yet claimed by any bridge
  //    device, so `GET /api/studio`'s `bridge.pendingJobs.queued` is
  //    non-zero and the "Waiting for your Mac" banner renders.
  const upperA2Day = happenDay(1, upperA2.weekday);
  const pendingPushId = newId();
  await db.insert(studioPlanPushes).values({
    id: pendingPushId,
    planId,
    planVersion: 1,
    happenDay: upperA2Day,
    sessionTitle: stamp(upperA2.title, 1),
    corosIdInPlan: null,
    corosProgramId: null,
    corosEntityId: null,
    corosPlanId: null,
    corosHappenDay: null,
    sessionFingerprint: fingerprint(upperA2),
    status: "pending",
    error: null,
    updatedAt: now,
  });
  await db.insert(corosWriteJobs).values({
    id: newId(),
    userId,
    workoutId: pendingPushId, // studio kinds mirror studioPushId here (schedule.ts's own doc comment)
    kind: "create_scheduled_workout",
    expectedContentFingerprint: "",
    originalDate: upperA2Day,
    destinationDate: upperA2Day,
    payload: {
      pushId: pendingPushId,
      happenDay: upperA2Day,
      name: stamp(upperA2.title, 1),
      session: upperA2,
      catalog: upperA2.exercises.map((e) => ({ id: e.originId, name: e.name })),
    },
    requestedAt: now,
    status: "queued",
    studioPushId: pendingPushId,
    updatedAt: now,
  });

  // The remaining two week-2 sessions are left entirely unpushed (no row at
  // all) — the draft grid's honest "+2 new" in the diff strip.

  // lastPushSummary: one `studio_plan_pushed` audit row matching the state
  // above — 1 create (the pending row), 1 failure (wrong_date), 1 unchanged
  // (verified), 1 drifted THIS pass with blocked=1 to match (blocked
  // includes drifted — see studio-push.ts's own `blocked` doc comment).
  await db.insert(auditEvents).values({
    id: newId(),
    userId,
    kind: "studio_plan_pushed",
    detail: {
      studioPlanId: planId,
      planVersion: 1,
      creates: 1,
      deletes: 0,
      failures: 1,
      unchanged: 1,
      drifted: 1,
      blocked: 1,
    },
    createdAt: now,
  });

  // A little LLM usage history so the Studio's usage meter isn't empty —
  // well under both the $2 warn and $8 cutoff thresholds (llm.ts's
  // LLM_BUDGET), spread across the rolling 7-day window `llmBudgetStatus`
  // reads.
  const nowMs = Date.parse(now);
  await db.insert(llmUsage).values([
    {
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "anthropic/claude-opus-5",
      inputTokens: 9500,
      outputTokens: 4100,
      costMicros: 650_000,
      cacheHit: false,
      requestFingerprint: fingerprint({ fixture: "studio_generate", planId }),
      createdAt: new Date(nowMs - 4 * 86_400_000).toISOString(),
    },
    {
      id: newId(),
      userId,
      kind: "studio_edit",
      model: "anthropic/claude-haiku-4.5",
      inputTokens: 1400,
      outputTokens: 380,
      costMicros: 45_000,
      cacheHit: false,
      requestFingerprint: fingerprint({ fixture: "studio_edit_minor", planId }),
      createdAt: new Date(nowMs - 2 * 86_400_000).toISOString(),
    },
    {
      id: newId(),
      userId,
      kind: "studio_edit",
      model: "anthropic/claude-opus-5", // a `major: true` edit routes to the strong model
      inputTokens: 6800,
      outputTokens: 2900,
      costMicros: 405_000,
      cacheHit: false,
      requestFingerprint: fingerprint({ fixture: "studio_edit_major", planId }),
      createdAt: new Date(nowMs - 1 * 86_400_000).toISOString(),
    },
  ]);
}

/**
 * Development fixture seeding. NEVER active silently: requires FIXTURE_MODE=1
 * and an explicit authenticated request; the UI shows a persistent banner.
 *
 * Builds a realistic history: a 12-week plan in progress (~9 weeks in),
 * completed runs, a missed week (drought),
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
  provider: "coros",
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
      kind === "quality" ? "Morning Threshold" : kind === "long" ? "Long Run Sunday" : "Morning Run",
    contentFingerprint: fingerprint({ date, kind, provider }),
  };
}

export interface SeedResult {
  planImported: boolean;
  activitiesIngested: number;
  gardenDays: number;
}

export async function seedFixtures(db: Db, env: Env, userId: string): Promise<SeedResult> {
  // Global, not per-user (coros_exercises has no userId) — upserted every
  // seed so it's always present regardless of which fixture user ran first.
  await upsertExerciseCatalog(db, FIXTURE_EXERCISE_CATALOG);

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
    },
    prefs,
  );

  // Phase C: presence is the cloud COROS connection — the fixture user gets
  // a connected row so sync states render realistically.
  const existingConn = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")));
  if (existingConn.length === 0) {
    await db.insert(providerConnections).values({
      id: newId(),
      userId,
      provider: "coros",
      status: "connected",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
      lastSyncAt: nowInstant(),
      meta: { email: "fixture@example.com", region: "us" },
      externalAccountId: "fixture-coros",
    });
  }

  // History: weeks 0-5 consistent; week 6 fully missed (drought seed);
  // week 7 comeback; week 8 consistent.
  const sources: SourceActivity[] = [];
  const lapsByProviderId: Record<string, never[]> = {};
  let index = 0;

  // Adventure fixtures, dated up front so the WEEK loop below can reserve
  // their days: a big Saturday hike anchored to week 8 (the most recent full
  // week — the same "recent enough" spot lastQualityDate/strengthYogaDate use
  // below). Its own day is reserved so the loop's usual "long" run doesn't
  // clutter the showcase, and the Sunday right after is reserved as the
  // shielded, low-recovery grace day so nothing else already "explains" the
  // day and blocks adventureGraceDay's hasSession check. A sub-threshold
  // Wednesday walk is the neutral counterpart — present in history as an
  // adventure sport but never big enough
  // (ADVENTURE_TUNING.minLoad/minDurationMin) to touch the garden's clocks.
  const adventureWalkDate = addDays(monday, 8 * 7 + 2);
  const adventureHikeDate = addDays(monday, 8 * 7 + 5);
  const adventureGraceDate = addDays(monday, 8 * 7 + 6);

  for (let week = 0; week < 9; week++) {
    for (const day of WEEK) {
      const date = addDays(monday, week * 7 + day.offset);
      if (date >= today) continue;
      if (day.kind === "rest") continue;
      if (week === 6) continue; // the missed week
      if (week === 7 && day.offset < 3) continue; // comeback starts mid-week
      if (week === 2 && day.offset === 3) continue; // one skipped strides day
      if (date === adventureHikeDate) continue; // reserved for the fixture adventure's big hike, below
      if (date === adventureGraceDate) continue; // reserved for the fixture adventure's grace day, below

      sources.push(syntheticActivity(date, day.kind, index, "coros"));
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
    const rich = normalizeCorosActivity(item, detail);
    // Exercise the feel branch: the act card's "felt n/5" suffix was once
    // invisible to every screenshot because no fixture carried a feel.
    rich.telemetry = { ...(rich.telemetry ?? {}), feelRating: 4 };
    sources.push(rich);
    lapsByProviderId[`coros-fx-rich-${lastQualityDate}`] = normalizeCorosLaps(detail) as never[];
  }
  // Flat km-lap profile for the most recent long run, so the activity list's
  // pace-shape chart shows a plateau next to the threshold's comb.
  const lastLongDate = addDays(monday, 8 * 7 + 5 - 7); // previous week's Saturday
  if (lastLongDate < today) {
    lapsByProviderId[`coros-fx-${lastLongDate}-long`] = Array.from({ length: 18 }, (_, i) => ({
      lapIndex: i,
      durationSeconds: 370 + Math.round(i * 0.6),
      distanceMeters: 1000,
      avgPaceSecPerKm: 370 + Math.round(i * 0.6),
      splitType: "km",
    })) as never[];
  }

  // The sub-threshold walk (garden-neutral: below both minLoad and
  // minDurationMin, so qualifiesAsAdventure is false — it shows up tagged
  // "walk" in history but never freezes a clock or banks grace).
  if (adventureWalkDate < today) {
    sources.push({
      provider: "coros",
      providerActivityId: `coros-fx-adventure-walk-${adventureWalkDate}`,
      startTime: `${addDays(adventureWalkDate, 1)}T01:30:00Z`,
      startTimeLocal: `${adventureWalkDate}T18:30:00`,
      timezone: "America/Los_Angeles",
      sport: "walk",
      durationSeconds: 20 * 60,
      elapsedSeconds: 20 * 60 + 60,
      distanceMeters: 1500,
      avgHeartRate: 96,
      maxHeartRate: 108,
      deviceName: "COROS PACE 3",
      title: "Evening Walk",
      contentFingerprint: fingerprint({ date: adventureWalkDate, kind: "adventure-walk" }),
    });
  }

  // The big Saturday hike — well past both thresholds (durationMin 240 ≥ 45,
  // trainingLoad 120 ≥ 40) and past bigLoad (≥80), so it also banks a grace
  // day for adventureGraceDate below.
  if (adventureHikeDate < today) {
    sources.push({
      provider: "coros",
      providerActivityId: `coros-fx-adventure-hike-${adventureHikeDate}`,
      startTime: `${adventureHikeDate}T14:15:00Z`,
      startTimeLocal: `${adventureHikeDate}T07:15:00`,
      timezone: "America/Los_Angeles",
      sport: "hike",
      durationSeconds: 4 * 3600,
      elapsedSeconds: 4 * 3600 + 1200,
      distanceMeters: 15_800,
      avgHeartRate: 122,
      maxHeartRate: 148,
      elevationGainMeters: 850,
      trainingLoad: 120,
      deviceName: "COROS PACE 3",
      title: "Ridgeline Loop",
      contentFingerprint: fingerprint({ date: adventureHikeDate, kind: "adventure-hike" }),
    });
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

  // Low recovery (<60) for the day right after the fixture hike, so the
  // engine's Coros-recovery signal — not just the banked-day heuristic —
  // drives adventureGraceDay's shield (adventure.ts). Inserted before the
  // general 60-day loop below so its onConflictDoNothing() leaves this value
  // in place rather than overwriting it with the generic 60-94 range.
  await db
    .insert(dailyHealth)
    .values({
      id: `${userId}:${adventureGraceDate}`,
      userId,
      date: adventureGraceDate,
      restingHeartRate: 47,
      hrv: 41,
      recoveryScore: 42,
      trainingLoad7d: 340,
      provider: "coros",
      contentFingerprint: fingerprint({ date: adventureGraceDate, kind: "adventure-grace" }),
      updatedAt: now,
    })
    .onConflictDoNothing();

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

  // Plan Studio fixture world (plan-studio-design §8) — independent of the
  // running-plan/garden simulation above, so it runs last and keyed off the
  // same account-local `today` already computed for it.
  await seedStudioFixtures(db, userId, today);

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
