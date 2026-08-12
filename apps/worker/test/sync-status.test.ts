import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyJobResult, applyMove } from "../src/services/jobs.js";
import { cloudPresence, computeSyncStatus } from "../src/services/sync-status.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";

/**
 * Phase C: `cloudPresence` is the single liveness computation — the COROS
 * cloud connection IS the executor — and `computeSyncStatus` derives the
 * Today/status sync state from it. The Mac/device era (`devicePresence`,
 * `waiting_for_mac`) is gone.
 */

// The minimal row shape applyMove needs (sync-intents.test.ts's literal).
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

/** Drive a move's job to terminal `failed` (jobs-reconcile's own pattern). */
async function failMoveJob(db: Db, userId: string, jobId: string, prefs: unknown): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await applyJobResult(
      db,
      userId,
      {
        jobId,
        deviceId: "cloud",
        outcome: "write_failed",
        errorCategory: "network",
        finishedAt: nowInstant(),
        signature: "s",
      } as never,
      prefs as never,
    );
  }
}

describe("computeSyncStatus", () => {
  it("writes off → not_synced", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: false });
    await connectTestCoros(db, userId);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("not_synced");
    expect(status.writesEnabled).toBe(false);
  });

  it("writes on + cloud connected + no jobs → in_sync", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("in_sync");
    expect(status.pendingCount).toBe(0);
    expect(status.issueCount).toBe(0);
  });

  it("queued job + no cloud connection → not_synced (never a Mac to wait for)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const workoutId = await insertWorkout(db, userId);
    await db.insert(schema.corosWriteJobs).values({
      id: newId(),
      userId,
      workoutId,
      kind: "move",
      expectedContentFingerprint: "fp",
      originalDate: "2026-08-08",
      destinationDate: "2026-08-10",
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("not_synced");
    expect(status.registered).toBe(false);
  });

  it("queued job + cloud connected → syncing", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId);
    await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("syncing");
    expect(status.pendingCount).toBe(1);
  });

  it("failed move job with open intent → sync_issue", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId);
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    await failMoveJob(db, userId, outcome.jobId!, prefs);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("sync_issue");
    expect(status.issueCount).toBe(1);
  });

  it("failed move job whose workout was later archived → issueCount 0, not sync_issue (nothing left to retry behind an archived row)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId);
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    await failMoveJob(db, userId, outcome.jobId!, prefs);

    await db
      .update(schema.plannedWorkouts)
      .set({ archivedAt: nowInstant() })
      .where(eq(schema.plannedWorkouts.id, workoutId));

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).not.toBe("sync_issue");
    expect(status.issueCount).toBe(0);
  });

  it("a queued read_now job alone doesn't count toward pendingCount — state stays in_sync", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const jobId = newId();
    await db.insert(schema.corosWriteJobs).values({
      id: jobId,
      userId,
      workoutId: jobId, // read_now self-references its own job row (no real workout)
      kind: "read_now",
      expectedContentFingerprint: "",
      originalDate: "2026-08-08",
      destinationDate: "2026-08-08",
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("in_sync");
    expect(status.pendingCount).toBe(0);
  });
});

describe("cloudPresence", () => {
  it("no coros row → offline, unregistered, not write-capable", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const presence = await cloudPresence(db, userId);
    expect(presence).toEqual({ registered: false, online: false, writeCapable: false });
  });

  it("connected row → online and write-capable", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await connectTestCoros(db, userId);
    const presence = await cloudPresence(db, userId);
    expect(presence).toEqual({ registered: true, online: true, writeCapable: true });
  });

  it("disconnected row → offline", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await connectTestCoros(db, userId);
    await db
      .update(schema.providerConnections)
      .set({ status: "disconnected" })
      .where(eq(schema.providerConnections.userId, userId));
    const presence = await cloudPresence(db, userId);
    expect(presence.online).toBe(false);
    expect(presence.registered).toBe(false);
  });
});
