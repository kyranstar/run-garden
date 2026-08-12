import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import {
  auditEvents,
  backfillState,
  corosWriteAttempts,
  corosWriteJobs,
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
import { cloudPresence } from "./sync-status.js";
import { applyStudioJobResult } from "./studio-push.js";
import { openIntentFor, openMoveIntents, recordIntent, resolveIntent } from "./sync-intents.js";
import { postSyncNote } from "./sync-notes.js";

/**
 * COROS write-job lifecycle. Jobs are the only path to COROS mutations:
 * idempotent, serialized per user, executed by the desktop bridge (or a future
 * official cloud provider), and always verified by a read after the write.
 */

export const CLAIM_TIMEOUT_MS = 10 * 60_000;

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
  return (await cloudPresence(db, userId)).online;
}

async function writeCapableDeviceExists(db: Db, userId: string): Promise<boolean> {
  return (await cloudPresence(db, userId)).writeCapable;
}

/**
 * Supersede any older in-flight job for this workout, then queue a new
 * `move_scheduled_workout` job. `attemptCount` defaults to 0 (a fresh move),
 * but callers re-deriving a job from a prior job's failed attempt pass its
 * count forward so the retry budget spans re-derivations.
 */
async function enqueueMoveJob(
  db: Db,
  v: {
    userId: string;
    workout: typeof plannedWorkouts.$inferSelect;
    toDate: string;
    now: string;
    attemptCount?: number;
  },
): Promise<string> {
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: v.now })
    .where(
      and(
        eq(corosWriteJobs.workoutId, v.workout.id),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const jobId = newId();
  await db.insert(corosWriteJobs).values({
    id: jobId,
    userId: v.userId,
    workoutId: v.workout.id,
    kind: "move_scheduled_workout",
    expectedSourceVersion: v.workout.sourceVersion ?? null,
    expectedContentFingerprint: v.workout.sourceContentFingerprint,
    originalDate: v.workout.lastVerifiedCorosDate,
    destinationDate: v.toDate,
    requestedAt: v.now,
    status: "queued",
    attemptCount: v.attemptCount ?? 0,
    updatedAt: v.now,
  });
  return jobId;
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

  const intentId = await recordIntent(db, {
    userId: req.userId,
    targetKind: "workout",
    targetId: workout.id,
    kind: "move",
    payload: { fromDate, toDate: req.toDate, toTime: req.toTime },
    source: req.source === "calendar_edit" ? "calendar_drag" : "user_move",
  });

  const dateChanged = req.toDate !== workout.lastVerifiedCorosDate;
  const writesPossible = req.corosWritesEnabled && (await writeCapableDeviceExists(db, req.userId));

  let corosSyncState: string;
  let jobId: string | undefined;

  if (!dateChanged) {
    // Same-COROS-date time change: COROS has no time-of-day, nothing to write.
    corosSyncState = workout.corosSyncState === "needs_attention" ? "needs_attention" : "synced";
    await resolveIntent(db, intentId, now);
    // Moving back to the COROS-verified date makes any in-flight move stale
    // — without this, a pending job would re-move COROS after the user
    // undid the change.
    await db
      .update(corosWriteJobs)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(corosWriteJobs.workoutId, workout.id),
          inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
        ),
      );
  } else if (!writesPossible) {
    corosSyncState = "calendar_only";
  } else {
    jobId = await enqueueMoveJob(db, { userId: req.userId, workout, toDate: req.toDate, now });
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
 * The reconciler's job-emission pass: every open move intent that still
 * disagrees with COROS and has no in-flight job gets one. Called after
 * applyMove, after every bridge snapshot import, and when writes are enabled
 * in Settings — so intents queued while writes were off (or no device was
 * paired) heal the moment writing becomes possible.
 */
export async function emitPendingWork(
  db: Db,
  userId: string,
  opts: { corosWritesEnabled: boolean },
): Promise<number> {
  if (!opts.corosWritesEnabled) return 0;
  if (!(await writeCapableDeviceExists(db, userId))) return 0;
  const now = nowInstant();
  const intents = await openMoveIntents(db, userId);
  if (intents.length === 0) return 0;
  const inflight = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const inflightByWorkout = new Map(inflight.map((j) => [j.workoutId, j]));
  let emitted = 0;
  for (const intent of intents) {
    const toDate = intent.payload?.["toDate"];
    if (typeof toDate !== "string") continue;
    const workout = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, intent.targetId)).limit(1)
    )[0];
    if (!workout || workout.archivedAt) {
      // An intent for a workout that no longer exists has nothing left to
      // sync — leaving it open would strand a permanent, uncloseable
      // sync_issue behind an archived (or deleted) workout.
      await resolveIntent(db, intent.id, now);
      continue;
    }
    if (workout.lastVerifiedCorosDate === toDate) {
      await resolveIntent(db, intent.id, now);
      continue;
    }
    const existing = inflightByWorkout.get(workout.id);
    if (existing?.destinationDate === toDate) continue;
    // A terminally failed job for exactly this destination means the retry
    // budget was already exhausted for this change — re-emitting would hand
    // it a fresh attempt count and retry an unsupported workout forever.
    // Leave the intent open; the per-workout retry-coros route supersedes
    // the failed job to clear this guard for a user-initiated retry.
    const lastJob = (
      await db
        .select()
        .from(corosWriteJobs)
        .where(eq(corosWriteJobs.workoutId, workout.id))
        .orderBy(desc(corosWriteJobs.requestedAt))
        .limit(1)
    )[0];
    if (lastJob?.status === "failed" && lastJob.destinationDate === toDate) continue;
    await enqueueMoveJob(db, { userId, workout, toDate, now });
    const online = await anyDeviceOnline(db, userId);
    await db
      .update(plannedWorkouts)
      .set({ corosSyncState: online ? "syncing" : "waiting_for_device", updatedAt: now })
      .where(eq(plannedWorkouts.id, workout.id));
    emitted += 1;
  }
  return emitted;
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
  opts: { excludeKinds?: readonly string[] } = {},
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

  // excludeKinds exists because a permanently-queued job of a foreign kind
  // (the 2026-08-12 stuck backfill) must never head-of-line-block executors
  // that don't handle it — the filter has to be claim-side, a caller-side
  // skip would just re-claim the same head forever.
  const queued = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "queued"),
        ...(opts.excludeKinds?.length ? [notInArray(corosWriteJobs.kind, [...opts.excludeKinds])] : []),
      ),
    )
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

  const workout =
    isStudioJobKind(job.kind) || job.kind === "read_now" || job.kind === "backfill"
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
  // `read_now` acts on no workout (its `workoutId` self-references the job
  // row to satisfy NOT NULL, per the studio kinds' same trick) — the
  // move-outcome state machine below does not apply.
  if (job.kind === "read_now") {
    await db
      .update(corosWriteJobs)
      .set({
        status: result.outcome === "verified" ? "verified" : "failed",
        attemptCount: job.attemptCount + 1,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(corosWriteJobs.id, job.id));
    return { jobStatus: result.outcome === "verified" ? "verified" : "failed", corosSyncState: "unchanged" };
  }
  // `backfill` acts on no workout either. The chunk itself was already ingested
  // via /bridge/backfill-chunk, which also queued the next chunk; this only
  // settles the job row.
  if (job.kind === "backfill") {
    const ok = result.outcome === "verified";
    await db
      .update(corosWriteJobs)
      .set({
        status: ok ? "verified" : "failed",
        attemptCount: job.attemptCount + 1,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(corosWriteJobs.id, job.id));
    // A failed chunk ends the walk — nothing else will enqueue the next one, so
    // without this the checkpoint sits at `running` forever and Settings says
    // "Reading your COROS history…" indefinitely. The commonest cause by far is
    // a desktop app older than the backfill job kind: it claims the job, does
    // not recognise it, and reports `unsupported`.
    //
    // Guard: if ANOTHER backfill job is already queued, the chunk actually
    // landed before this result failed (e.g. the result POST timed out after
    // recordChunk + advanceBackfill ran) — the walk is alive; erroring it
    // would flash "your desktop app is too old" over a working backfill.
    if (!ok) {
      const successor = await db
        .select({ id: corosWriteJobs.id })
        .from(corosWriteJobs)
        .where(
          and(
            eq(corosWriteJobs.userId, userId),
            eq(corosWriteJobs.kind, "backfill"),
            inArray(corosWriteJobs.status, ["queued", "claimed"]),
          ),
        )
        .limit(1);
      if (successor.length === 0) {
        await db
          .update(backfillState)
          .set({
            status: "error",
            lastErrorCategory: "bridge_cannot_run_backfill",
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(backfillState.userId, userId));
      }
    }
    return { jobStatus: ok ? "verified" : "failed", corosSyncState: "unchanged" };
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
      const intent = await openIntentFor(db, userId, job.workoutId, "move");
      if (intent) await resolveIntent(db, intent.id, now);
      break;
    }
    case "upstream_changed":
    case "verification_failed": {
      if (result.observedDate) workoutUpdates.lastVerifiedCorosDate = result.observedDate;
      const intent = await openIntentFor(db, userId, job.workoutId, "move");
      if (intent && attemptCount < job.maxAttempts) {
        // Last-edit-wins, tie to the app: the user's open intent stands. The
        // job is re-derived against the newly observed origin and the
        // displaced COROS value is surfaced as an undo note — never a stuck
        // "needs attention".
        jobStatus = "superseded";
        corosSyncState = "syncing";
        workoutUpdates.corosSyncState = "syncing";
        const workout = (
          await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, job.workoutId)).limit(1)
        )[0];
        if (workout) {
          await enqueueMoveJob(db, {
            userId,
            workout: {
              ...workout,
              lastVerifiedCorosDate: result.observedDate ?? workout.lastVerifiedCorosDate,
            },
            toDate: job.destinationDate,
            now,
            attemptCount,
          });
          // observedDate is optional on the wire (z.string().optional()) — a
          // note with an undefined displacedDate renders broken copy and
          // 400s forever on undo (invalid_note has no displacedDate string
          // to act on), so only post the note when there's an actual date.
          if (typeof result.observedDate === "string" && result.observedDate.length > 0) {
            await postSyncNote(db, {
              userId,
              workoutId: job.workoutId,
              kind: "kept_local_change",
              payload: { displacedDate: result.observedDate, keptDate: job.destinationDate },
            });
          }
        }
      } else {
        jobStatus = "failed";
        corosSyncState = "sync_issue";
        workoutUpdates.corosSyncState = "sync_issue";
      }
      break;
    }
    case "ambiguous":
    case "write_failed": {
      if (attemptCount >= job.maxAttempts) {
        jobStatus = "failed";
        corosSyncState = "sync_issue";
        workoutUpdates.corosSyncState = "sync_issue";
      } else {
        jobStatus = "queued"; // retry; the bridge re-reads before any rewrite
        corosSyncState = "syncing";
      }
      break;
    }
    case "rolled_back": {
      jobStatus = "failed";
      corosSyncState = "sync_issue";
      workoutUpdates.corosSyncState = "sync_issue";
      break;
    }
    case "unsupported": {
      jobStatus = "failed";
      corosSyncState = "sync_issue";
      workoutUpdates.corosSyncState = "sync_issue";
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
