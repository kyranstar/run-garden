import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyJobResult, applyMove } from "../src/services/jobs.js";
import { recordIntent } from "../src/services/sync-intents.js";
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

  it("a COMPLETED session's stale watch copy is not counted — it is history, not a job", async () => {
    // Live (2026-08-18): the athlete ran their session, and the status line then
    // told them "Your watch keeps an older version of 1 session — Run Garden has
    // the one to run" about a run finished hours earlier. The divergence is real
    // and permanently unactionable; there is nothing left to run.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId);
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: workoutId,
      kind: "content",
      source: "coach_ease",
    });
    expect((await computeSyncStatus(db, userId, prefs)).contentStaleCount).toBe(1);

    await db
      .update(schema.plannedWorkouts)
      .set({ completionState: "completed" })
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect((await computeSyncStatus(db, userId, prefs)).contentStaleCount).toBe(0);
  });

  it("a failed coach write a LATER write superseded → issueCount 0 (history, not an issue)", async () => {
    // Live (2026-08-18): the athlete read "1 change couldn't sync" about a
    // session that had synced minutes earlier. Job ids are content-derived, so
    // converging a session mints a NEW id and the old attempt's row stays
    // `failed` for ever — a badge no Retry could clear, describing a watch that
    // was already correct.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    // A session still ahead: a past one is not an issue for a different reason (below).
    const workoutId = await insertWorkout(db, userId, { effectiveDate: addDays(todayInZone(prefs.timezone), 3) });
    const base = {
      userId,
      workoutId,
      kind: "coach_update_workout" as const,
      expectedContentFingerprint: "fp",
      originalDate: "2026-08-10",
      destinationDate: "2026-08-10",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    await db.insert(schema.corosWriteJobs).values([
      { ...base, id: `${workoutId}-content-old`, status: "failed", requestedAt: "2026-08-10T00:00:00.000Z" },
      { ...base, id: `${workoutId}-content-new`, status: "verified", requestedAt: "2026-08-10T00:05:00.000Z" },
    ]);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.issueCount, "the superseded failure is history").toBe(0);
    expect(status.state).not.toBe("sync_issue");
  });

  it("…but a failure NEWER than the last success still counts", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, userId);
    const workoutId = await insertWorkout(db, userId, { effectiveDate: addDays(todayInZone(prefs.timezone), 3) });
    const base = {
      userId,
      workoutId,
      kind: "coach_update_workout" as const,
      expectedContentFingerprint: "fp",
      originalDate: "2026-08-10",
      destinationDate: "2026-08-10",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    await db.insert(schema.corosWriteJobs).values([
      { ...base, id: `${workoutId}-content-old`, status: "verified", requestedAt: "2026-08-10T00:00:00.000Z" },
      { ...base, id: `${workoutId}-content-new`, status: "failed", requestedAt: "2026-08-10T00:05:00.000Z" },
    ]);

    const status = await computeSyncStatus(db, userId, prefs);
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

/**
 * "4 CHANGES COULDN'T SYNC" NEVER CLEARED (owner report, 2026-10-09).
 *
 * Live: four coach writes failed `verification_failed` on 2026-09-19..21 for sessions on 09-22, 09-23, 09-23 and
 * 09-30. Weeks later all four were past and missed, none archived, nothing newer verified — so the banner counted them
 * for ever. A past session's watch copy can never be rewritten and Retry cannot act on it: a failed coach write is an
 * issue only while its session can still be written — dated the athlete's today or later, and not completed, missed
 * or skipped.
 */
describe("a failed coach write is an issue only while its session can still be written", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function failedCoachWrite(
    db: Db,
    userId: string,
    workoutId: string,
    kind: "coach_create_workout" | "coach_update_workout" = "coach_update_workout",
  ): Promise<string> {
    const id = `${workoutId}-${kind}`;
    await db.insert(schema.corosWriteJobs).values({
      id,
      userId,
      workoutId,
      kind,
      expectedContentFingerprint: "fp",
      originalDate: "2026-09-20",
      destinationDate: "2026-09-20",
      requestedAt: "2026-09-20T00:00:00.000Z",
      status: "failed",
      lastErrorCategory: "verification_failed",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    return id;
  }

  async function setup(timezone = "America/New_York") {
    const db = makeTestDb();
    const user = await makeTestUser(db, { corosWritesEnabled: true, timezone });
    await connectTestCoros(db, user.userId);
    return { db, ...user };
  }

  it("the live shape: four failures for sessions now past and missed → no issue; the same four before → four", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
    const { db, userId, prefs } = await setup();
    for (const date of ["2026-09-22", "2026-09-23", "2026-09-23", "2026-09-30"]) {
      const w = await insertWorkout(db, userId, { effectiveDate: date });
      await failedCoachWrite(db, userId, w);
    }
    expect((await computeSyncStatus(db, userId, prefs)).issueCount, "all four still ahead").toBe(4);

    vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
    await db.update(schema.plannedWorkouts).set({ completionState: "missed" }).where(eq(schema.plannedWorkouts.userId, userId));
    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.issueCount).toBe(0);
    expect(status.state).toBe("in_sync");
  });

  it("past by date alone is enough — a session still `scheduled` yesterday does not count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
    const { db, userId, prefs } = await setup();
    await failedCoachWrite(db, userId, await insertWorkout(db, userId, { effectiveDate: "2026-09-20" }));
    await failedCoachWrite(db, userId, await insertWorkout(db, userId, { effectiveDate: "2026-09-21" }), "coach_create_workout");
    await failedCoachWrite(db, userId, await insertWorkout(db, userId, { effectiveDate: "2026-09-24" }));
    expect((await computeSyncStatus(db, userId, prefs)).issueCount, "today and later, not yesterday").toBe(2);
  });

  it("a resolved session does not count however far ahead it is dated — completed, missed or skipped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
    const { db, userId, prefs } = await setup();
    for (const state of ["completed", "missed", "skipped"]) {
      const w = await insertWorkout(db, userId, { effectiveDate: "2026-09-21" });
      await db.update(schema.plannedWorkouts).set({ completionState: state }).where(eq(schema.plannedWorkouts.id, w));
      await failedCoachWrite(db, userId, w);
    }
    expect((await computeSyncStatus(db, userId, prefs)).issueCount).toBe(0);
    await failedCoachWrite(db, userId, await insertWorkout(db, userId, { effectiveDate: "2026-09-21" }));
    expect((await computeSyncStatus(db, userId, prefs)).issueCount, "the scheduled one still counts").toBe(1);
  });

  it("becomes past at midnight in the ATHLETE'S timezone, not UTC's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { db, userId, prefs: tzPrefs } = await setup("America/Los_Angeles");
    expect(tzPrefs.timezone).toBe("America/Los_Angeles");
    await failedCoachWrite(db, userId, await insertWorkout(db, userId, { effectiveDate: "2026-10-09" }));

    // 23:59 on the 9th in Los Angeles — already the 10th in UTC.
    vi.setSystemTime(new Date("2026-10-10T06:59:00Z"));
    expect((await computeSyncStatus(db, userId, tzPrefs)).issueCount, "still the athlete's today").toBe(1);
    // 00:01 on the 10th in Los Angeles.
    vi.setSystemTime(new Date("2026-10-10T07:01:00Z"));
    expect((await computeSyncStatus(db, userId, tzPrefs)).issueCount, "past at the athlete's midnight").toBe(0);
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
