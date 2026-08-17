/**
 * Cloud write consumer (cloud-direct spec §4): queued jobs execute against
 * the mock COROS server through the SAME executors the bridge uses, and
 * results land via applyJobResult under the synthetic cloud device id —
 * verify/attempt machinery indistinguishable from a bridge report. One
 * executor per user (lock), backfill left to its own walker.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { corosProgramFingerprint } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { CLOUD_DEVICE_ID, executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyMove } from "../src/services/jobs.js";
import { enqueueBackfill } from "../src/services/backfill.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { createHash } from "node:crypto";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

/** A workout mirroring the mock server's own scheduled entity so the move
 * executor's read-after-write verification can succeed for real. */
async function seedServerWorkout(db: Db, userId: string, server: ReturnType<typeof mockCorosServer>) {
  // Pick a PROGRAM-BACKED entity — rest-day entities carry no program and a
  // date move refuses without one (write-executor step 4½).
  const entity = server.state.schedule.entities!.find((e) =>
    server.state.schedule.programs!.some((pr) => String(pr.idInPlan) === String(e.idInPlan)),
  )!;
  const program = server.state.schedule.programs!.find(
    (pr) => String(pr.idInPlan) === String(entity.idInPlan),
  );
  const planId = server.state.schedule.id;
  const date = String(entity.happenDay);
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const id = "wo-cloud-move";
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `${planId}:${entity.idInPlan}`,
    sourceIdInPlan: String(entity.idInPlan),
    sourceProgramId: String(entity.planProgramId ?? entity.idInPlan),
    title: (program?.name as string | undefined) ?? "Session",
    category: "easy",
    sport: "run",
    originalPlanDate: iso,
    lastVerifiedCorosDate: iso,
    effectiveDate: iso,
    effectiveTime: "07:00",
    sourceContentFingerprint: program ? corosProgramFingerprint(program) : "fp",
    calendarBlockDurationSeconds: 3600,
    completionState: "scheduled",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return { id, iso };
}

async function connect(db: Db, userId: string, server: ReturnType<typeof mockCorosServer>) {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(
    db,
    makeEnv(),
    userId,
    { email: server.email, pwdMd5, region: "us" },
    server.fetchImpl,
  );
  expect(res.status).toBe("connected");
}

describe("executeCloudJobs", () => {
  it("executes a queued move against COROS and applies the result under the cloud device id", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const { id, iso } = await seedServerWorkout(db, userId, server);

    const moved = await applyMove(db, {
      userId,
      workoutId: id,
      toDate: addDays(iso, 2),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(moved.jobId).toBeTruthy();

    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, moved.jobId!));
    expect(res.executed).toBe(1);
    expect(["verified", "completed"]).toContain(job!.status);
    expect(job!.claimedByDeviceId).toBe(CLOUD_DEVICE_ID);
    const attempts = await db
      .select()
      .from(schema.corosWriteAttempts)
      .where(eq(schema.corosWriteAttempts.jobId, moved.jobId!));
    expect(attempts.some((a) => a.deviceId === CLOUD_DEVICE_ID)).toBe(true);
  });

  it("no cloud connection → executes nothing, jobs stay for devices", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    const { id, iso } = await seedServerWorkout(db, userId, server);
    await applyMove(db, {
      userId,
      workoutId: id,
      toDate: addDays(iso, 2),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(res.executed).toBe(0);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.userId, userId));
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
  });

  it("leaves backfill chunks to the walker (released, not executed)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    await enqueueBackfill(db, userId, today);

    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(res.executed).toBe(0);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "backfill")));
    expect(jobs[0]!.status).toBe("queued");
    expect(jobs[0]!.claimedByDeviceId).toBeNull();
  });

  it("EXACTLY-ONCE: concurrent executors share the lock — one runs", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const { id, iso } = await seedServerWorkout(db, userId, server);
    await applyMove(db, {
      userId,
      workoutId: id,
      toDate: addDays(iso, 2),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const [a, b] = await Promise.all([
      executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl }),
      executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl }),
    ]);
    expect(a.executed + b.executed).toBe(1);
  });

  it("a permanently-queued backfill job never blocks other writes (2026-08-12 incident)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    // The stuck head: a backfill job queued BEFORE the move (older requestedAt).
    const today = todayInZone(prefs.timezone);
    await enqueueBackfill(db, userId, today);
    await db
      .update(schema.corosWriteJobs)
      .set({ requestedAt: "2026-08-12T03:24:00.000Z" })
      .where(eq(schema.corosWriteJobs.kind, "backfill"));
    const { id, iso } = await seedServerWorkout(db, userId, server);
    const moved = await applyMove(db, {
      userId,
      workoutId: id,
      toDate: addDays(iso, 2),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });

    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(res.executed).toBe(1); // the MOVE ran despite the older queued backfill
    const [moveJob] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, moved.jobId!));
    expect(["verified", "completed"]).toContain(moveJob!.status);
    const backfillJobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "backfill")));
    expect(backfillJobs[0]!.status).toBe("queued"); // untouched, still the walker's
  });

  it("executes a coach_create_workout on COROS and stamps the row with its watch address", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 3);
    // The planned workout the coach's add op created…
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-coach-add",
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: "wo-coach-add",
      title: "Race-week shakeout",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1500,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    // …and its watch-push job.
    await db.insert(schema.corosWriteJobs).values({
      id: "wo-coach-add-push",
      userId,
      workoutId: "wo-coach-add",
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: date,
      destinationDate: date,
      payload: {
        workoutId: "wo-coach-add",
        happenDay: date,
        name: "Race-week shakeout",
        session: {
          category: "easy",
          title: "Race-week shakeout",
          durationMinutes: 25,
          run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] },
        },
      },
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });

    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(res.executed).toBe(1);
    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, "wo-coach-add-push"));
    expect(job!.status).toBe("verified");
    const [wo] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "wo-coach-add"));
    expect(wo!.corosSyncState).toBe("synced");
    expect(wo!.lastVerifiedCorosDate).toBe(date);
    // The COROS address makes the session movable on the watch later.
    expect(wo!.sourceWorkoutId).toContain(":");
    expect(wo!.sourceIdInPlan).toBeTruthy();
    // A "verified" job means verified: applyJobResult stamps `verifiedAt` on
    // every other kind and this branch used to leave it NULL (3 live rows).
    expect(job!.verifiedAt).toBeTruthy();
  });

  it("resolves the threshold pace at EXECUTION time, so a session is not a bare timer forever", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 5);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-threshold",
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: "wo-threshold",
      title: "Easy aerobic",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 2400,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    // THE LIVE SHAPE (prod, 2026-08-13): the payload was built before the
    // day's threshold landed, so it carries none…
    await db.insert(schema.corosWriteJobs).values({
      id: "wo-threshold-push",
      userId,
      workoutId: "wo-threshold",
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: date,
      destinationDate: date,
      payload: {
        workoutId: "wo-threshold",
        happenDay: date,
        name: `Easy aerobic — ${date}`,
        session: {
          category: "easy",
          title: "Easy aerobic",
          durationMinutes: 40,
          run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
        },
      },
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });
    // …while the athlete's COROS threshold (289 s/km, the real value) is in
    // the database by the time the write loop actually runs.
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${today}`,
      userId,
      date: today,
      thresholdPaceSecPerKm: 289,
      contentFingerprint: "h",
      updatedAt: nowInstant(),
    });

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [wo] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "wo-threshold"));
    expect(wo!.corosSyncState).toBe("synced");
    // What the WATCH received: an easy band of 349–409 s/km in ms/km, not the
    // bare `intensityType: 5` timer all three live sessions carry.
    const idInPlan = wo!.sourceIdInPlan!;
    const program = server.programByIdInPlan(idInPlan)!;
    const block = program.exercises![0]! as unknown as Record<string, unknown>;
    expect(block).toMatchObject({
      intensityType: 3,
      intensityValue: 349_000,
      intensityValueExtend: 409_000,
    });
    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, "wo-threshold-push"));
    expect(job!.status).toBe("verified");
    expect(job!.lastErrorCategory).toBeNull(); // nothing owed
  });

  it("records the debt when no threshold exists anywhere, rather than pushing silently", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const date = addDays(todayInZone(prefs.timezone), 6);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-owed",
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: "wo-owed",
      title: "Easy aerobic",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 2400,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.corosWriteJobs).values({
      id: "wo-owed-push",
      userId,
      workoutId: "wo-owed",
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: date,
      destinationDate: date,
      payload: {
        workoutId: "wo-owed",
        happenDay: date,
        name: `Easy aerobic owed — ${date}`,
        session: {
          category: "easy",
          title: "Easy aerobic",
          durationMinutes: 40,
          run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
        },
      },
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    // The session still reaches the watch — a timer beats nothing — but the
    // job row now says what it owes instead of the debt being invisible.
    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, "wo-owed-push"));
    expect(job!.status).toBe("verified");
    expect(job!.verifiedAt).toBeTruthy();
    expect(job!.lastErrorCategory).toBe("pace_targets_owed");
  });

  it("pushes a coach LIFT session — holds, per-side work and a circuit — with the real catalog", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const date = addDays(todayInZone(prefs.timezone), 7);
    // The account's own COROS catalog, as `exercise-catalog.ts` syncs it. The
    // executor validates every step against this before any wire call, and
    // the cloud consumer used to hand it an EMPTY map.
    await db.insert(schema.corosExercises).values([
      { id: "425898928110747648", name: "Wall Sit", raw: {}, updatedAt: nowInstant() },
      { id: "426109589008859137", name: "Plank", raw: {}, updatedAt: nowInstant() },
    ]);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-lift",
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: "wo-lift",
      title: "Ski legs",
      category: "strength",
      sport: "strength",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: "18:00",
      sourceContentFingerprint: "app-side-fp",
      calendarBlockDurationSeconds: 1200,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.corosWriteJobs).values({
      id: "wo-lift-push",
      userId,
      workoutId: "wo-lift",
      kind: "coach_create_workout",
      expectedContentFingerprint: "app-side-fp",
      originalDate: date,
      destinationDate: date,
      payload: {
        workoutId: "wo-lift",
        happenDay: date,
        name: `Ski legs — ${date}`,
        session: {
          category: "strength",
          title: "Ski legs",
          durationMinutes: 20,
          lift: {
            rounds: 3,
            exercises: [
              {
                name: "Wall sit",
                originId: "425898928110747648",
                sets: 1,
                holdSeconds: 45,
                weight: { type: "bodyweight" },
                restSeconds: 15,
              },
              {
                name: "Side plank",
                originId: "426109589008859137",
                sets: 1,
                holdSeconds: 30,
                perSide: true,
                weight: { type: "bodyweight" },
                restSeconds: 15,
              },
            ],
          },
        },
      },
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [wo] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "wo-lift"));
    expect(wo!.corosSyncState).toBe("synced");
    // WHAT THE WATCH GOT: one repeat group of 3, three timed holds under it.
    const program = server.programByIdInPlan(wo!.sourceIdInPlan!)!;
    expect(program.sportType).toBe(4);
    const groups = program.exercises!.filter((e) => e.isGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sets).toBe(3);
    const children = program.exercises!.filter((e) => !e.isGroup);
    expect(children.map((c) => [c.targetType, c.targetValue])).toEqual([
      [2, 45],
      [2, 30],
      [2, 30],
    ]);
    // The fingerprint is now built by the builder that actually wrote it, so a
    // follow-up move compares like with like instead of the app-side stamp.
    expect(wo!.sourceContentFingerprint).not.toBe("app-side-fp");
    expect(wo!.sourceContentFingerprint).toBe(corosProgramFingerprint(program));
  });
});
