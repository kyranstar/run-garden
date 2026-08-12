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
});
