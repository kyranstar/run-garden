import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyJobResult, applyMove, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser, registerTestDevice } from "./helpers.js";

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

  it("applyJobResult write_failed exhausts retries into sync_issue, leaving the intent open", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const deviceId = await registerTestDevice(db, userId);
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
