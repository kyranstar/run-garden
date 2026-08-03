import { and, eq, gt, inArray, lt } from "drizzle-orm";
import {
  auditEvents,
  corosWriteAttempts,
  corosWriteJobs,
  desktopDevices,
  plannedWorkouts,
  scheduleOverrides,
} from "@rg/database";
import {
  isStudioJobKind,
  newId,
  nowInstant,
  todayInZone,
  type CorosWriteResult,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "./db.js";
import { applyStudioJobResult } from "./studio-push.js";

/**
 * COROS write-job lifecycle. Jobs are the only path to COROS mutations:
 * idempotent, serialized per user, executed by the desktop bridge (or a future
 * official cloud provider), and always verified by a read after the write.
 */

const CLAIM_TIMEOUT_MS = 10 * 60_000;
const DEVICE_ONLINE_WINDOW_MS = 3 * 60_000;

export interface MoveRequest {
  userId: string;
  workoutId: string;
  toDate: string;
  toTime: string;
  source: "app" | "calendar_edit" | "reschedule";
  corosWritesEnabled: boolean;
}

export interface MoveOutcome {
  workoutId: string;
  corosSyncState: string;
  jobId?: string;
}

async function anyDeviceOnline(db: Db, userId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS).toISOString();
  const rows = await db
    .select({ id: desktopDevices.id })
    .from(desktopDevices)
    .where(
      and(
        eq(desktopDevices.userId, userId),
        gt(desktopDevices.lastSeenAt, cutoff),
        eq(desktopDevices.bridgePaused, false),
      ),
    );
  return rows.some(() => true);
}

async function writeCapableDeviceExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select().from(desktopDevices).where(eq(desktopDevices.userId, userId));
  return rows.some(
    (d) =>
      !d.revokedAt &&
      (d.capabilities?.["updateExistingScheduledWorkout"] === true ||
        (d.capabilities?.["addScheduledWorkout"] === true &&
          d.capabilities?.["removeScheduledWorkout"] === true)),
  );
}

/**
 * Apply a user-approved move: update Run Garden's intended schedule, queue the
 * COROS write, and report the resulting sync state. Calendar sync is the
 * caller's follow-up step.
 */
export async function applyMove(db: Db, req: MoveRequest): Promise<MoveOutcome> {
  const now = nowInstant();
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, req.workoutId), eq(plannedWorkouts.userId, req.userId)))
    .limit(1);
  const workout = rows[0];
  if (!workout) throw new Error("workout_not_found");
  if (workout.category === "race") throw new Error("races_cannot_move");

  const fromDate = workout.effectiveDate;

  await db.insert(scheduleOverrides).values({
    id: newId(),
    workoutId: workout.id,
    kind: fromDate === req.toDate ? "time_change" : "user_move",
    fromDate,
    toDate: req.toDate,
    toTime: req.toTime,
    source: req.source,
    createdAt: now,
  });

  const dateChanged = req.toDate !== workout.lastVerifiedCorosDate;
  const writesPossible = req.corosWritesEnabled && (await writeCapableDeviceExists(db, req.userId));

  let corosSyncState: string;
  let jobId: string | undefined;

  if (!dateChanged) {
    // Same-COROS-date time change: COROS has no time-of-day, nothing to write.
    corosSyncState = workout.corosSyncState === "needs_attention" ? "needs_attention" : "synced";
  } else if (!writesPossible) {
    corosSyncState = "calendar_only";
  } else {
    // Supersede any older pending jobs for this workout, then queue the new one.
    await db
      .update(corosWriteJobs)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(corosWriteJobs.workoutId, workout.id),
          inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
        ),
      );
    jobId = newId();
    await db.insert(corosWriteJobs).values({
      id: jobId,
      userId: req.userId,
      workoutId: workout.id,
      kind: "move_scheduled_workout",
      expectedSourceVersion: workout.sourceVersion ?? null,
      expectedContentFingerprint: workout.sourceContentFingerprint,
      originalDate: workout.lastVerifiedCorosDate,
      destinationDate: req.toDate,
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    });
    corosSyncState = (await anyDeviceOnline(db, req.userId)) ? "syncing" : "waiting_for_device";
  }

  await db
    .update(plannedWorkouts)
    .set({
      effectiveDate: req.toDate,
      effectiveTime: req.toTime,
      corosSyncState,
      calendarSyncState:
        workout.calendarSyncState === "user_deleted" ? "user_deleted" : "pending",
      // Rescheduling an unresolved workout answers "did this run happen?"
      // with "not yet — it's moving". Without this reset the prompt follows
      // the workout to its new (possibly future) date, which reads as the app
      // asking whether a run in the future already happened.
      ...(workout.completionState === "unresolved" ? { completionState: "scheduled" } : {}),
      updatedAt: now,
    })
    .where(eq(plannedWorkouts.id, workout.id));

  await db.insert(auditEvents).values({
    id: newId(),
    userId: req.userId,
    kind: "workout_moved",
    detail: { workoutId: workout.id, fromDate, toDate: req.toDate, toTime: req.toTime, source: req.source, jobId },
    createdAt: now,
  });

  return { workoutId: workout.id, corosSyncState, jobId };
}

/**
 * Revert stale claims, then hand the oldest queued job to the device.
 *
 * `workout` is null for the Plan Studio kinds: they act on a `studio_plan_pushes`
 * row and a job payload, not on a planned workout (COROS only grows one for
 * them once the create has synced back).
 */
export async function claimNextJob(
  db: Db,
  userId: string,
  deviceId: string,
): Promise<
  | (typeof corosWriteJobs.$inferSelect & {
      workout: typeof plannedWorkouts.$inferSelect | null;
    })
  | null
> {
  const now = nowInstant();
  const staleCutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
  await db
    .update(corosWriteJobs)
    .set({ status: "queued", claimedByDeviceId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "claimed"),
        lt(corosWriteJobs.claimedAt, staleCutoff),
      ),
    );

  const queued = await db
    .select()
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.status, "queued")))
    .orderBy(corosWriteJobs.requestedAt)
    .limit(1);
  const job = queued[0];
  if (!job) return null;

  await db
    .update(corosWriteJobs)
    .set({ status: "claimed", claimedByDeviceId: deviceId, claimedAt: now, updatedAt: now })
    .where(eq(corosWriteJobs.id, job.id));
  await db.insert(corosWriteAttempts).values({
    id: newId(),
    jobId: job.id,
    deviceId,
    startedAt: now,
  });

  const workout = isStudioJobKind(job.kind)
    ? null
    : ((
        await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, job.workoutId)).limit(1)
      )[0] ?? null);
  return { ...job, status: "claimed", workout };
}

/** Map a signed device result onto job + workout state. */
export async function applyJobResult(
  db: Db,
  userId: string,
  result: CorosWriteResult,
  prefs: UserPreferences,
): Promise<{ jobStatus: string; corosSyncState: string }> {
  const now = nowInstant();
  const rows = await db
    .select()
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.id, result.jobId), eq(corosWriteJobs.userId, userId)))
    .limit(1);
  const job = rows[0];
  if (!job) throw new Error("job_not_found");
  // The Plan Studio kinds have their own state machine: the move-outcome
  // vocabulary cannot express a create's `wrong_date` or a delete's
  // `stamp_mismatch`, and they own a push row rather than a planned workout.
  if (isStudioJobKind(job.kind)) {
    const studio = await applyStudioJobResult(db, userId, result);
    return { jobStatus: studio.jobStatus, corosSyncState: "unchanged" };
  }
  if (["verified", "failed", "superseded", "cancelled"].includes(job.status)) {
    return { jobStatus: job.status, corosSyncState: "unchanged" };
  }

  await db
    .update(corosWriteAttempts)
    .set({
      finishedAt: now,
      outcome: result.outcome,
      pathUsed: result.pathUsed ?? null,
      errorCategory: result.errorCategory ?? null,
      observedDate: result.observedDate ?? null,
      signatureValid: true,
    })
    .where(and(eq(corosWriteAttempts.jobId, job.id), eq(corosWriteAttempts.deviceId, result.deviceId)));

  const attemptCount = job.attemptCount + 1;
  let jobStatus: string;
  let corosSyncState: string;
  const workoutUpdates: Record<string, unknown> = { updatedAt: now };

  switch (result.outcome) {
    case "verified":
    case "already_in_desired_state": {
      jobStatus = "verified";
      corosSyncState = "synced";
      workoutUpdates.lastVerifiedCorosDate = result.observedDate ?? job.destinationDate;
      workoutUpdates.corosSyncState = "synced";
      if (result.observedVersion) workoutUpdates.sourceVersion = result.observedVersion;
      if (result.observedFingerprint) workoutUpdates.sourceContentFingerprint = result.observedFingerprint;
      break;
    }
    case "upstream_changed":
    case "verification_failed": {
      jobStatus = "needs_attention";
      corosSyncState = "needs_attention";
      workoutUpdates.corosSyncState = "needs_attention";
      if (result.observedDate) workoutUpdates.lastVerifiedCorosDate = result.observedDate;
      break;
    }
    case "ambiguous":
    case "write_failed": {
      if (attemptCount >= job.maxAttempts) {
        jobStatus = "failed";
        corosSyncState = "calendar_only";
        workoutUpdates.corosSyncState = "calendar_only";
      } else {
        jobStatus = "queued"; // retry; the bridge re-reads before any rewrite
        corosSyncState = "syncing";
      }
      break;
    }
    case "rolled_back": {
      jobStatus = "failed";
      corosSyncState = "calendar_only";
      workoutUpdates.corosSyncState = "calendar_only";
      break;
    }
    case "unsupported": {
      jobStatus = "failed";
      corosSyncState = "calendar_only";
      workoutUpdates.corosSyncState = "calendar_only";
      break;
    }
  }

  await db
    .update(corosWriteJobs)
    .set({
      status: jobStatus,
      attemptCount,
      pathUsed: result.pathUsed ?? job.pathUsed,
      degraded: result.pathUsed === "remove_and_add" ? true : job.degraded,
      verifiedAt: jobStatus === "verified" ? now : job.verifiedAt,
      lastErrorCategory: result.errorCategory ?? job.lastErrorCategory,
      completedAt: ["verified", "failed", "needs_attention"].includes(jobStatus) ? now : null,
      claimedByDeviceId: jobStatus === "queued" ? null : job.claimedByDeviceId,
      claimedAt: jobStatus === "queued" ? null : job.claimedAt,
      updatedAt: now,
    })
    .where(eq(corosWriteJobs.id, job.id));

  await db.update(plannedWorkouts).set(workoutUpdates).where(eq(plannedWorkouts.id, job.workoutId));

  await db.insert(auditEvents).values({
    id: newId(),
    userId,
    kind: "coros_write_result",
    detail: {
      jobId: job.id,
      outcome: result.outcome,
      pathUsed: result.pathUsed,
      jobStatus,
      timezoneToday: todayInZone(prefs.timezone),
    },
    createdAt: now,
  });

  return { jobStatus, corosSyncState };
}
