import { and, desc, eq, isNotNull } from "drizzle-orm";
import { corosWriteJobs, dailyHealth, plannedWorkouts } from "@rg/database";
import { nowInstant, todayInZone, type CorosWriteResult, type UserPreferences } from "@rg/domain";
import {
  createWorkout,
  deleteWorkout,
  executeMoveJob,
  executeStudioJob,
  type StudioJob,
} from "@rg/coros";
import { localDateToCorosDay } from "@rg/providers";
import {
  coachCreateWorkoutJobSchema,
  coachDeleteWorkoutJobSchema,
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
import { exerciseNameMap } from "./exercise-catalog.js";

/**
 * Cloud write consumer (cloud-direct spec §4): the same job queue with all
 * its idempotency, minus the Mac. Jobs are claimed under the synthetic
 * device id, executed against the cloud client with the SAME executors the
 * bridge runs (stamp verify, read-after-write, delete triples — untouched),
 * and their results flow through applyJobResult exactly as a signed bridge
 * report would. Verify, undo, and drift detection never notice the change.
 */

export const CLOUD_DEVICE_ID = "cloud";

/**
 * The athlete's most recent COROS threshold pace, read at EXECUTION time.
 *
 * The job payload carries the threshold that was known when the coach's
 * proposal was applied, and that is routinely too early: all three sessions
 * the coach has pushed live went out on 2026-08-13 at 05:27 UTC with a null
 * threshold, while the day's own reading of 289 s/km — the one every pace
 * band in the app is derived from — landed later the same day. The result was
 * three workouts on the watch with `intensityType: 5` (no target) on every
 * block, permanently: nothing re-pushes when a threshold arrives.
 *
 * Resolving here instead closes that window. The push is asynchronous by
 * design (queued at apply, executed by the write loop), so "as late as
 * possible" is strictly more informed than "as early as possible", and it
 * costs one bounded single-row read per create.
 */
async function latestThresholdPace(db: Db, userId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  return row?.v ?? undefined;
}

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
        // The freshest threshold wins over the one frozen into the payload at
        // apply time — see `latestThresholdPace`. A payload value is only
        // used when there is nothing newer to have.
        const threshold = (await latestThresholdPace(db, userId)) ?? spec.thresholdPaceSecPerKm;
        // A lift/mobility session needs the COROS catalog to resolve its
        // steps; a run session never touches it, so the ~382-row read is
        // paid only when there is something to resolve.
        const catalog = spec.session.run ? new Map<string, string>() : await exerciseNameMap(db);
        const result = await createWorkout(
          client,
          {
            happenDay: String(localDateToCorosDay(spec.happenDay)),
            name: spec.name,
            session: spec.session,
            thresholdPaceSecPerKm: threshold,
          },
          { catalog, log: () => undefined },
        );
        if (result.paceTargetsOwed) {
          // Recorded, not swallowed: the athlete's session went to the watch
          // as a timer for these blocks and the row says so.
          console.error(
            `coach create pushed ${result.paceTargetsOwed} block(s) with no pace target` +
              ` (${spec.name}); no usable threshold pace`,
          );
        }
        const done = nowInstant();
        if (result.ok) {
          // Stamp the WIRE fingerprint so a follow-up move compares like with
          // like (audit#2 #12) — the app-side FNV stamp guaranteed a
          // content_changed mismatch until the next snapshot healed it.
          //
          // It comes STRAIGHT FROM THE EXECUTOR now (2026-08-17). Rebuilding
          // it here re-ran the builder, which emits `duration: 0`, while the
          // program on the wire had been through `/program/calculate` — so the
          // "healed" stamp never matched what the next read returns, and for a
          // lift session `buildRunProgram` simply threw and healed nothing.
          const wireFp = result.wireFingerprint;
          await db
            .update(plannedWorkouts)
            .set({
              corosSyncState: "synced",
              lastVerifiedCorosDate: spec.happenDay,
              ...(wireFp ? { sourceContentFingerprint: wireFp } : {}),
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
            // `verifiedAt` is what a "verified" row MEANS — applyJobResult
            // stamps it on every other kind, and 3 live coach creates sat
            // verified with it NULL because this branch writes the status by
            // hand (audit 2026-08-17). `lastErrorCategory` doubles as the pace
            // debt ledger: a create can be verified AND still owe targets.
            .set({
              status: "verified",
              verifiedAt: done,
              completedAt: done,
              updatedAt: done,
              ...(result.paceTargetsOwed
                ? { lastErrorCategory: "pace_targets_owed" }
                : { lastErrorCategory: null }),
            })
            .where(eq(corosWriteJobs.id, job.id));
        } else {
          // Transient outcomes retry (same taxonomy the studio retries via
          // mapCreateResult); one blip must not strand a session app-only
          // forever (audit#2 #6). Cap at 3 attempts, tracked in the payload.
          const attempts = ((job.payload as { attempts?: number } | null)?.attempts ?? 0) + 1;
          const retryable =
            result.reason === "slot_occupied" ||
            result.reason === "not_visible" ||
            result.reason === "error" ||
            result.reason === undefined;
          console.error(
            `coach create ${retryable && attempts < 3 ? "retrying" : "FAILED"} (${spec.name}, attempt ${attempts}): ${result.reason ?? ""} ${result.error ?? ""}`,
          );
          await db
            .update(corosWriteJobs)
            .set(
              retryable && attempts < 3
                ? {
                    status: "queued",
                    claimedByDeviceId: null,
                    claimedAt: null,
                    payload: { ...spec, attempts },
                    updatedAt: done,
                  }
                : { status: "failed", lastErrorCategory: result.reason ?? "error", updatedAt: done },
            )
            .where(eq(corosWriteJobs.id, job.id));
        }
        executed += 1;
        continue;
      } else if (job.kind === "coach_delete_workout") {
        // Reshaped/retired coach sessions come back OFF the watch (audit#3
        // D2) via the same stamp-verified triple-addressed delete the studio
        // undo uses — nothing is ever deleted on a maybe.
        const parsed = coachDeleteWorkoutJobSchema.safeParse(job.payload);
        if (!parsed.success) {
          await db
            .update(corosWriteJobs)
            .set({ status: "failed", lastErrorCategory: "malformed_payload", updatedAt: nowInstant() })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const spec = parsed.data;
        const result = await deleteWorkout(
          client,
          {
            happenDay: String(localDateToCorosDay(spec.happenDay)),
            name: spec.name,
            idInPlan: spec.idInPlan,
            programId: spec.programId,
            planId: spec.corosPlanId,
          },
          { today: todayInZone(prefs.timezone) },
        );
        const done = nowInstant();
        if (result.ok || result.refused === "not_found") {
          // Deleted — or provably already gone, which is the same outcome
          // for an unpush. The archived row no longer lives on the watch.
          await db
            .update(plannedWorkouts)
            .set({ corosSyncState: "calendar_only", updatedAt: done })
            .where(eq(plannedWorkouts.id, spec.workoutId));
          await db
            .update(corosWriteJobs)
            .set({ status: "verified", verifiedAt: done, completedAt: done, updatedAt: done })
            .where(eq(corosWriteJobs.id, job.id));
        } else {
          // Refusals (ambiguous stamp, drifted address) are terminal — the
          // executor's contract says remove those by hand. Bare errors are
          // transient and retry like coach creates, cap 3.
          const attempts = ((job.payload as { attempts?: number } | null)?.attempts ?? 0) + 1;
          const retryable = result.refused === undefined;
          console.error(
            `coach unpush ${retryable && attempts < 3 ? "retrying" : "FAILED"} (${spec.name}, attempt ${attempts}): ${result.refused ?? ""} ${result.error ?? ""}`,
          );
          await db
            .update(corosWriteJobs)
            .set(
              retryable && attempts < 3
                ? {
                    status: "queued",
                    claimedByDeviceId: null,
                    claimedAt: null,
                    payload: { ...spec, attempts },
                    updatedAt: done,
                  }
                : {
                    status: "failed",
                    lastErrorCategory: result.refused ?? "error",
                    updatedAt: done,
                  },
            )
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
