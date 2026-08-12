import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { applyJobResult, applyMove, claimNextJob, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { deviceRoutes } from "../src/routes/devices.js";
import { makeTestDb, makeTestUser, mountRoutes, registerTestDevice, connectTestCoros } from "./helpers.js";

/**
 * Moves through the intent ledger: applyMove records a `move` intent and
 * (when possible) emits a job; emitPendingWork is the reconciler's catch-up
 * pass for intents that couldn't get a job yet; applyJobResult resolves the
 * intent on success or re-derives against it (last-edit-wins) on conflict.
 */

// Copied from Task 2's appRequestedDates test insert literal (sync-intents.test.ts).
async function insertWorkout(
  db: Db,
  userId: string,
  overrides: { lastVerifiedCorosDate?: string; effectiveDate?: string } = {},
): Promise<string> {
  const workoutId = newId();
  const date = overrides.effectiveDate ?? "2026-08-08";
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: overrides.lastVerifiedCorosDate ?? date,
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

describe("jobs + intent ledger", () => {
  it("applyMove with writes enabled + capable device records an open move intent and enqueues one queued job", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });

    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });

    expect(outcome.corosSyncState).toBe("syncing"); // device just registered → online
    expect(outcome.jobId).toBeTruthy();

    const intent = await openIntentFor(db, userId, workoutId, "move");
    expect(intent).not.toBeNull();
    expect(intent?.payload?.["toDate"]).toBe("2026-08-10");

    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("applyMove with writes disabled records the intent but no job; emitPendingWork later enqueues exactly one, then no more", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });

    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: false,
    });
    expect(outcome.corosSyncState).toBe("calendar_only");
    expect(outcome.jobId).toBeUndefined();

    const intent = await openIntentFor(db, userId, workoutId, "move");
    expect(intent).not.toBeNull();
    const jobsBefore = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(jobsBefore).toHaveLength(0);

    // Writes get enabled and a device gets registered afterward.
    await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const emitted = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(emitted).toBe(1);
    const jobsAfter = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(jobsAfter).toHaveLength(1);
    expect(jobsAfter[0]!.status).toBe("queued");

    // Already has an in-flight job matching the intent's toDate → no-op.
    const again = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(again).toBe(0);
  });

  it("applyJobResult verified resolves the intent and advances lastVerifiedCorosDate", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const jobId = outcome.jobId!;

    await applyJobResult(
      db,
      userId,
      {
        jobId,
        deviceId,
        outcome: "verified",
        observedDate: "2026-08-10",
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs,
    );

    const intent = await openIntentFor(db, userId, workoutId, "move");
    expect(intent).toBeNull();
    const workout = (
      await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.lastVerifiedCorosDate).toBe("2026-08-10");
  });

  it("applyJobResult upstream_changed re-derives a new job against the open intent and posts a kept_local_change note", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const oldJobId = outcome.jobId!;

    await applyJobResult(
      db,
      userId,
      {
        jobId: oldJobId,
        deviceId,
        outcome: "upstream_changed",
        observedDate: "2026-08-09",
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs,
    );

    const oldJob = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, oldJobId))
    )[0]!;
    expect(oldJob.status).toBe("superseded");

    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    const newJob = jobs.find((j) => j.id !== oldJobId);
    expect(newJob).toBeTruthy();
    expect(newJob!.status).toBe("queued");
    expect(newJob!.originalDate).toBe("2026-08-09");
    expect(newJob!.destinationDate).toBe("2026-08-10");

    const notes = await db
      .select()
      .from(schema.syncNotes)
      .where(eq(schema.syncNotes.workoutId, workoutId));
    const note = notes.find((n) => n.kind === "kept_local_change");
    expect(note).toBeTruthy();
    expect(note!.payload).toEqual({ displacedDate: "2026-08-09", keptDate: "2026-08-10" });

    const workout = (
      await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.corosSyncState).not.toBe("needs_attention");
  });

  it("applyJobResult verification_failed with no observedDate re-derives the job but skips posting a kept_local_change note (undefined displacedDate would be broken copy and 400-forever on undo)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const oldJobId = outcome.jobId!;

    await applyJobResult(
      db,
      userId,
      {
        jobId: oldJobId,
        deviceId,
        outcome: "verification_failed",
        // No observedDate — the bridge couldn't establish what COROS shows.
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs,
    );

    // The re-derivation itself still happens — last-edit-wins stands.
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    const newJob = jobs.find((j) => j.id !== oldJobId);
    expect(newJob).toBeTruthy();
    expect(newJob!.status).toBe("queued");

    const notes = await db
      .select()
      .from(schema.syncNotes)
      .where(eq(schema.syncNotes.workoutId, workoutId));
    expect(notes.find((n) => n.kind === "kept_local_change")).toBeUndefined();
  });

  it("emitPendingWork resolves the open intent for an archived workout instead of leaving it stranded open forever", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });

    // Writes off at move time: the intent is recorded but no job exists yet.
    await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: false,
    });
    expect(await openIntentFor(db, userId, workoutId, "move")).not.toBeNull();

    // The workout gets archived (e.g. removed from the plan) before writes
    // ever turn on — the open move intent behind it has nothing left to sync.
    await db
      .update(schema.plannedWorkouts)
      .set({ archivedAt: nowInstant() })
      .where(eq(schema.plannedWorkouts.id, workoutId));

    const emitted = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(emitted).toBe(0);
    expect(await openIntentFor(db, userId, workoutId, "move")).toBeNull();
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(jobs).toHaveLength(0);
  });

  it("emitPendingWork does not re-emit a terminally failed job for the same destination (would otherwise retry an unsupported workout forever)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const jobId = outcome.jobId!;

    for (let attempt = 0; attempt < 5; attempt++) {
      await applyJobResult(
        db,
        userId,
        {
          jobId,
          deviceId,
          outcome: "write_failed",
          errorCategory: "network",
          finishedAt: nowInstant(),
          signature: "s",
        } as never,
        prefs,
      );
    }
    expect(
      (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, jobId)))[0]!.status,
    ).toBe("failed");
    expect(await openIntentFor(db, userId, workoutId, "move")).not.toBeNull();

    const emitted = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(emitted).toBe(0);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(0);
    // The intent stays open — a user-initiated retry (retry-coros) is still
    // possible, just not an unattended re-emit.
    expect(await openIntentFor(db, userId, workoutId, "move")).not.toBeNull();
  });

  it("applyJobResult write_failed exhausts retries into sync_issue, leaving the intent open", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const jobId = outcome.jobId!;

    for (let attempt = 0; attempt < 5; attempt++) {
      await applyJobResult(
        db,
        userId,
        {
          jobId,
          deviceId,
          outcome: "write_failed",
          errorCategory: "network",
          finishedAt: nowInstant(),
          signature: "s",
        } as never,
        prefs,
      );
    }

    const job = (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, jobId)))[0]!;
    expect(job.status).toBe("failed");
    const workout = (
      await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.corosSyncState).toBe("sync_issue");
    const intent = await openIntentFor(db, userId, workoutId, "move");
    expect(intent).not.toBeNull();
  });
});

/**
 * Task 11: the `read_now` job kind (enqueued by POST /api/sync/read-now,
 * Task 10) rides the SAME claim/result lifecycle as a move job, but it acts
 * on no workout at all — its `workoutId` is its own job id (a self-reference
 * to satisfy the NOT NULL column, per studio-push's same trick for
 * `studioPushId`). `claimNextJob` must not attempt a workout lookup for it,
 * and `applyJobResult` must not run the move-outcome state machine against
 * it (that machine's "verified" case would incorrectly report
 * `corosSyncState: "synced"` and try to update a `plannedWorkouts` row that
 * doesn't exist for this id).
 */
async function insertReadNowJob(db: Db, userId: string, today = "2026-08-08"): Promise<string> {
  const id = newId();
  await db.insert(schema.corosWriteJobs).values({
    id,
    userId,
    workoutId: id,
    kind: "read_now",
    expectedContentFingerprint: "",
    originalDate: today,
    destinationDate: today,
    requestedAt: nowInstant(),
    status: "queued",
    updatedAt: nowInstant(),
  });
  return id;
}

async function insertQueuedMoveJob(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.insert(schema.corosWriteJobs).values({
    id,
    userId,
    workoutId: newId(),
    kind: "move_scheduled_workout",
    expectedContentFingerprint: "fp",
    originalDate: "2026-08-08",
    destinationDate: "2026-08-09",
    requestedAt: nowInstant(),
    status: "queued",
    updatedAt: nowInstant(),
  });
  return id;
}

describe("read_now job kind", () => {
  it("claimNextJob skips the workout-load for a read_now job (workout: null, no throw)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const jobId = await insertReadNowJob(db, userId);

    const claimed = await claimNextJob(db, userId, deviceId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.kind).toBe("read_now");
    expect(claimed!.workout).toBeNull();
  });

  it("applyJobResult verified short-circuits a read_now job: marks it verified without running the move state machine", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const jobId = await insertReadNowJob(db, userId);
    await claimNextJob(db, userId, deviceId);

    const applied = await applyJobResult(
      db,
      userId,
      {
        jobId,
        deviceId,
        outcome: "verified",
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs,
    );

    expect(applied.jobStatus).toBe("verified");
    // The move state machine's "verified" case reports "synced" — the
    // read_now short-circuit must report "unchanged" instead, since it never
    // touched a workout.
    expect(applied.corosSyncState).toBe("unchanged");

    const job = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, jobId))
    )[0]!;
    expect(job.status).toBe("verified");
    expect(job.attemptCount).toBe(1);
    expect(job.completedAt).not.toBeNull();
  });

  it("applyJobResult with a non-verified outcome marks a read_now job failed", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
    await connectTestCoros(db, userId);
    const jobId = await insertReadNowJob(db, userId);
    await claimNextJob(db, userId, deviceId);

    const applied = await applyJobResult(
      db,
      userId,
      {
        jobId,
        deviceId,
        outcome: "write_failed",
        errorCategory: "network",
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs,
    );

    expect(applied.jobStatus).toBe("failed");
    const job = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, jobId))
    )[0]!;
    expect(job.status).toBe("failed");
  });
});

describe("POST /api/devices/bridge/jobs/claim — pendingCount", () => {
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

  /** Minimal Ed25519 device identity + request signer, mirroring the desktop
   * bridge's own signRequest (services/coros-bridge/src/cloud-sync.ts) —
   * duplicated rather than imported since apps/worker has no dependency on
   * that service package. */
  function makeDeviceIdentity(): { publicKeyRaw: string; privateKeyPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    return {
      publicKeyRaw: jwk.x,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  function signedHeaders(
    privateKeyPem: string,
    deviceId: string,
    method: string,
    path: string,
    body: string,
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
    const message = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodySha256}`;
    const signature = ed25519Sign(null, Buffer.from(message, "utf8"), createPrivateKey(privateKeyPem));
    return {
      "x-device-id": deviceId,
      "x-device-timestamp": timestamp,
      "x-device-signature": signature.toString("base64url"),
    };
  }

  async function registerSignedDevice(db: Db, userId: string): Promise<{ deviceId: string; privateKeyPem: string }> {
    const { publicKeyRaw, privateKeyPem } = makeDeviceIdentity();
    const deviceId = newId();
    await db.insert(schema.desktopDevices).values({
      id: deviceId,
      userId,
      name: "Test Mac",
      publicKey: publicKeyRaw,
      platform: "macos",
      appVersion: "0.0.0-test",
      createdAt: nowInstant(),
      lastSeenAt: nowInstant(),
    });
    return { deviceId, privateKeyPem };
  }

  async function claim(db: Db, deviceId: string, privateKeyPem: string): Promise<Response> {
    const app = mountRoutes(db, "/api/devices", deviceRoutes);
    const path = "/api/devices/bridge/jobs/claim";
    const body = "{}";
    return app.request(
      path,
      {
        method: "POST",
        headers: {
          ...signedHeaders(privateKeyPem, deviceId, "POST", path, body),
          "content-type": "application/json",
        },
        body,
      },
      makeEnv(),
    );
  }

  it("includes pendingCount (jobs still queued after this claim) alongside a claimed job", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { deviceId, privateKeyPem } = await registerSignedDevice(db, userId);
    await insertQueuedMoveJob(db, userId);
    await insertQueuedMoveJob(db, userId);
    await insertQueuedMoveJob(db, userId);

    const res = await claim(db, deviceId, privateKeyPem);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string } | null; pendingCount: number };
    expect(body.job).not.toBeNull();
    // 3 were queued; this claim took one → 2 remain queued.
    expect(body.pendingCount).toBe(2);
  });

  it("includes pendingCount: 0 alongside a null job when the queue is empty", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { deviceId, privateKeyPem } = await registerSignedDevice(db, userId);

    const res = await claim(db, deviceId, privateKeyPem);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: unknown; pendingCount: number };
    expect(body.job).toBeNull();
    expect(body.pendingCount).toBe(0);
  });
});
