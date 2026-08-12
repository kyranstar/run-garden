import { and, eq } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts } from "@rg/database";
import { nowInstant, type CorosWriteResult, type UserPreferences } from "@rg/domain";
import { createWorkout, executeMoveJob, executeStudioJob, type StudioJob } from "@rg/coros";
import { localDateToCorosDay } from "@rg/providers";
import {
  coachCreateWorkoutJobSchema,
  createScheduledWorkoutJobSchema,
  deleteScheduledWorkoutJobSchema,
} from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { corosReadNow } from "./coros-read.js";
import { applyJobResult, claimNextJob } from "./jobs.js";
import { bridgeJobPayload } from "./studio-push.js";
import { claimUserLock, releaseUserLock } from "./locks.js";

/**
 * Cloud write consumer (cloud-direct spec §4): the same job queue with all
 * its idempotency, minus the Mac. Jobs are claimed under the synthetic
 * device id, executed against the cloud client with the SAME executors the
 * bridge runs (stamp verify, read-after-write, delete triples — untouched),
 * and their results flow through applyJobResult exactly as a signed bridge
 * report would. Verify, undo, and drift detection never notice the change.
 */

export const CLOUD_DEVICE_ID = "cloud";

/** Mirror of the bridge's toStudioJob: re-validate before touching the
 * user's real calendar, even though this process built the payload. */
function toStudioJob(job: { id: string; kind: string; payload: unknown }): StudioJob | undefined {
  const studio = bridgeJobPayload({ kind: job.kind, payload: job.payload });
  if (!studio) return undefined;
  if (job.kind === "create_scheduled_workout") {
    const parsed = createScheduledWorkoutJobSchema.safeParse(studio);
    return parsed.success ? { id: job.id, kind: job.kind, studio: parsed.data } : undefined;
  }
  if (job.kind === "delete_scheduled_workout") {
    const parsed = deleteScheduledWorkoutJobSchema.safeParse(studio);
    return parsed.success ? { id: job.id, kind: job.kind, studio: parsed.data } : undefined;
  }
  return undefined;
}

export async function executeCloudJobs(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  opts: { cap?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ executed: number }> {
  const cap = opts.cap ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const client = await corosClient(db, env, userId, fetchImpl);
  if (!client) return { executed: 0 }; // not cloud-connected — devices may still claim

  const lock = await claimUserLock(db, userId, "coros_write", 10);
  if (!lock) return { executed: 0 };

  let executed = 0;
  try {
    for (let i = 0; i < cap; i++) {
      // Backfill chunks have their own worker-side walker with pacing —
      // excluded at claim time so a queued backfill can never head-of-line-
      // block moves and studio pushes (2026-08-12 incident).
      const job = await claimNextJob(db, userId, CLOUD_DEVICE_ID, { excludeKinds: ["backfill"] });
      if (!job) break;

      let outcome: Omit<CorosWriteResult, "deviceId" | "finishedAt" | "signature">;
      if (job.kind === "read_now") {
        // The cloud pull IS the read — run it and complete the job.
        const read = await corosReadNow(db, env, userId, prefs, { force: true, fetchImpl });
        outcome = {
          jobId: job.id,
          outcome: read.status === "ok" || read.status === "fresh" ? "verified" : "write_failed",
          ...(read.status === "ok" || read.status === "fresh"
            ? {}
            : { errorCategory: "network" }),
        };
      } else if (job.kind === "coach_create_workout") {
        // A coach-authored session headed for the watch (2026-08-12): the
        // SAME create+verify core as studio pushes, reporting straight onto
        // the planned_workouts row instead of the studio push ledger.
        const parsed = coachCreateWorkoutJobSchema.safeParse(job.payload);
        const now = nowInstant();
        if (!parsed.success) {
          await db
            .update(corosWriteJobs)
            .set({ status: "failed", lastErrorCategory: "malformed_payload", updatedAt: now })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const spec = parsed.data;
        const result = await createWorkout(
          client,
          {
            happenDay: String(localDateToCorosDay(spec.happenDay)),
            name: spec.name,
            session: spec.session,
          },
          { catalog: new Map(), log: () => undefined },
        );
        const done = nowInstant();
        if (result.ok) {
          await db
            .update(plannedWorkouts)
            .set({
              corosSyncState: "synced",
              lastVerifiedCorosDate: spec.happenDay,
              // The COROS address the create landed at — this is what makes
              // the session MOVABLE on the watch later (the move executor
              // needs sourcePlanId:idInPlan).
              ...(result.serverPlanId != null && result.serverIdInPlan != null
                ? {
                    sourceWorkoutId: `${result.serverPlanId}:${result.serverIdInPlan}`,
                    sourceIdInPlan: String(result.serverIdInPlan),
                    ...(result.serverProgramId != null
                      ? { sourceProgramId: String(result.serverProgramId) }
                      : {}),
                  }
                : {}),
              updatedAt: done,
            })
            .where(eq(plannedWorkouts.id, spec.workoutId));
          await db
            .update(corosWriteJobs)
            .set({ status: "verified", completedAt: done, updatedAt: done })
            .where(eq(corosWriteJobs.id, job.id));
        } else {
          console.error(`coach create failed (${spec.name}): ${result.reason ?? ""} ${result.error ?? ""}`);
          await db
            .update(corosWriteJobs)
            .set({ status: "failed", lastErrorCategory: result.reason ?? "error", updatedAt: done })
            .where(eq(corosWriteJobs.id, job.id));
        }
        executed += 1;
        continue;
      } else {
        const studioJob = toStudioJob(job);
        if (studioJob) {
          outcome = await executeStudioJob(client, studioJob, {});
        } else if (job.kind === "create_scheduled_workout" || job.kind === "delete_scheduled_workout") {
          outcome = { jobId: job.id, outcome: "unsupported", errorCategory: "malformed_studio_payload" };
        } else if (!job.workout?.sourceIdInPlan) {
          outcome = { jobId: job.id, outcome: "unsupported", errorCategory: "missing_source_id_in_plan" };
        } else {
          outcome = await executeMoveJob(client, {
            id: job.id,
            originalDate: job.originalDate,
            destinationDate: job.destinationDate,
            expectedContentFingerprint: job.expectedContentFingerprint,
            workout: {
              // sourceWorkoutId is `${corosPlanId}:${idInPlan}` — the COROS
              // plan id on the wire, never the internal row uuid.
              sourcePlanId: job.workout.sourceWorkoutId.split(":")[0]!,
              sourceWorkoutId: job.workout.sourceWorkoutId,
              sourceIdInPlan: job.workout.sourceIdInPlan!,
              sourceProgramId: job.workout.sourceProgramId ?? undefined,
            },
          });
        }
      }

      await applyJobResult(
        db,
        userId,
        {
          ...outcome,
          jobId: job.id,
          deviceId: CLOUD_DEVICE_ID,
          finishedAt: nowInstant(),
          signature: "cloud-direct",
        } as CorosWriteResult,
        prefs,
      );
      executed += 1;
    }
  } finally {
    await releaseUserLock(db, userId, "coros_write", lock).catch(() => undefined);
  }
  return { executed };
}

/** True when the user has a live cloud connection — the emit path uses this
 * to execute inline instead of waiting for a device. */
export async function cloudWritesAvailable(db: Db, env: Env, userId: string): Promise<boolean> {
  const client = await corosClient(db, env, userId);
  return client !== null;
}
