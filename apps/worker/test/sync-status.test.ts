import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyJobResult, applyMove } from "../src/services/jobs.js";
import { computeSyncStatus, devicePresence, DEVICE_ONLINE_WINDOW_MS } from "../src/services/sync-status.js";
import { makeTestDb, makeTestUser, registerTestDevice } from "./helpers.js";

/**
 * Task 9: `devicePresence` is the single liveness computation and
 * `computeSyncStatus` derives the Today/status sync state from it — replacing
 * every inline "is a device online" calc previously duplicated across
 * jobs.ts, devices.ts, plan.ts, and studio.ts.
 */

// Copied from Task 2's appRequestedDates test insert literal (sync-intents.test.ts,
// jobs-reconcile.test.ts) — the minimal row shape applyMove needs.
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

async function registerDeviceAt(db: Db, userId: string, lastSeenAt: string): Promise<string> {
  const deviceId = await registerTestDevice(db, userId);
  await db
    .update(schema.desktopDevices)
    .set({ lastSeenAt })
    .where(eq(schema.desktopDevices.id, deviceId));
  return deviceId;
}

describe("computeSyncStatus", () => {
  it("writes off → not_synced", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: false });
    await registerTestDevice(db, userId);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("not_synced");
    expect(status.writesEnabled).toBe(false);
  });

  it("writes on + capable device online + no jobs → in_sync", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await registerTestDevice(db, userId); // fresh lastSeenAt, write-capable

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("in_sync");
    expect(status.pendingCount).toBe(0);
    expect(status.issueCount).toBe(0);
  });

  it("queued job + stale lastSeenAt → waiting_for_mac", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const staleAt = new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS - 60_000).toISOString();
    await registerDeviceAt(db, userId, staleAt);
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
    expect(status.state).toBe("waiting_for_mac");
    expect(status.pendingCount).toBe(1);
  });

  it("queued job + fresh lastSeenAt → syncing", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await registerTestDevice(db, userId); // fresh lastSeenAt
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
    const deviceId = await registerTestDevice(db, userId);
    const workoutId = await insertWorkout(db, userId);
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const jobId = outcome.jobId!;

    // Exhaust retries (maxAttempts default 5) so the job lands `failed` while
    // the move intent it came from stays open — the exact "issue" shape
    // `computeSyncStatus` counts (jobs-reconcile.test.ts's own pattern for
    // driving a job to `failed`).
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

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.state).toBe("sync_issue");
    expect(status.issueCount).toBe(1);
  });

  it("failed move job whose workout was later archived → issueCount 0, not sync_issue (nothing left to retry behind an archived row)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const deviceId = await registerTestDevice(db, userId);
    const workoutId = await insertWorkout(db, userId);
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
    await registerTestDevice(db, userId);
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

describe("devicePresence", () => {
  it("a paused device reads online: false and paused: true, even with a fresh lastSeenAt", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId); // fresh lastSeenAt
    await db
      .update(schema.desktopDevices)
      .set({ bridgePaused: true })
      .where(eq(schema.desktopDevices.id, deviceId));

    const presence = await devicePresence(db, userId);
    expect(presence.paused).toBe(true);
    expect(presence.online).toBe(false);
  });
});
