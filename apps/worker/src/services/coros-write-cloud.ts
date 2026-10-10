import { ZodError } from "zod";
import { and, desc, eq, exists, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { corosWriteJobs, dailyHealth, plannedWorkouts } from "@rg/database";
import {
  appAuthoredRow,
  nowInstant,
  COACH_JOB_KINDS,
  COACH_STAMPING_JOB_KINDS,
  STAMPING_JOB_KINDS,
  todayInZone,
  watchAddressOf,
  type CoachSession,
  type CorosWriteResult,
  type UserPreferences,
} from "@rg/domain";
import {
  buildProgramWatchProgram,
  createWorkout,
  deleteWorkout,
  executeMoveJob,
  executeStudioJob,
  RUN_PACE_WIRE,
  updateWorkoutContent,
  type StudioJob,
  type UpdateContentReason,
} from "@rg/coros";
import { localDateToCorosDay } from "@rg/providers";
import {
  coachCreateWorkoutJobSchema,
  coachDeleteWorkoutJobSchema,
  coachUpdateWorkoutJobSchema,
  createScheduledWorkoutJobSchema,
  deleteScheduledWorkoutJobSchema,
  programSessionPushJobSchema,
} from "@rg/domain";
import { watchPushEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { restoreInProgress } from "./account-state.js";
import { corosClient } from "./coros-connection.js";
import { isRuntimeLimit } from "./runtime-limit.js";
import { corosReadNow } from "./coros-read.js";
import { applyJobResult, claimNextJob } from "./jobs.js";
import { bridgeJobPayload } from "./studio-push.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { exerciseNameMap } from "./exercise-catalog.js";
import { openIntentFor, resolveIntent } from "./sync-intents.js";
import { enqueueUnpushIfOurs } from "./plan-mutations.js";
import { sentBuildIdOf } from "./session-build.js";
import { recordedStampFor, renamedCopyOfRow, SPENT_STAMP_STATUSES } from "./coros-stamp.js";
import { unlockSentBuild, unpushBuild } from "./watch-push.js";

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
/**
 * A verified RUN build's job records the pace encoding the wire now holds (`RUN_PACE_WIRE`). The program fingerprint
 * cannot tell the encodings apart, so this stamp is the only record of which one a copy on the watch carries: a
 * verified paced coach run without it went out before 2c1ee96 and reads as nonsense on the watch
 * (`pace_encoding_outdated`, content-converge.ts). The stored payload is kept whole — `attempts` included — and only
 * gains the field; a lift or mobility build carries no pace and claims no encoding.
 */
function paceWireStamp(payload: unknown, session: CoachSession): { payload?: Record<string, unknown> } {
  if (!session.run) return {};
  return { payload: { ...((payload ?? {}) as Record<string, unknown>), paceWire: RUN_PACE_WIRE } };
}

async function latestThresholdPace(db: Db, userId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  return row?.v ?? undefined;
}

/**
 * WHICH CONTENT-REWRITE OUTCOMES ARE WORTH A SECOND ATTEMPT.
 *
 * TRANSIENT — the same taxonomy the create path already retries on, because they
 * are the same conditions:
 *  · `error` / no category — a local or network failure.
 *  · `not_visible` — the write was accepted (or died) and the read-back found
 *    nothing carrying the stamp. Often a read that raced the server's own
 *    indexing; the retry re-proves ownership from a fresh sweep before it writes
 *    anything, so a rewrite that DID land is recognised rather than doubled.
 *  · `slot_occupied` — only reachable through the recreate fallback, and it means
 *    a genuine race for a derived id. The next attempt derives a new one.
 *
 * TERMINAL — a decision the wire already made, which it would make identically
 * three more times. `stamp_mismatch`, `moved` and `ambiguous` mean the athlete
 * edited this in COROS and the executor's contract says a human resolves that;
 * `rejected`, `verification_failed`, `wrong_date`, `not_found`, `no_target_plan`
 * and `out_of_span` are each a specific fact worth reporting NOW. Retrying a
 * refusal burns the budget and then reports the same reason three attempts later
 * than the athlete could have been told it.
 */
/**
 * THE SENTENCE BEHIND THE CATEGORY, bounded and safe to store.
 *
 * A write refuses with a `reason` (the bucket logic branches on) and an `error`
 * (the sentence that says which of several structurally different refusals it
 * actually was). Only the bucket was ever recorded, so a live `stamp_mismatch`
 * could mean nothing matched the proof, or several things did, or the one that
 * did was on another day — indistinguishable without re-running the write
 * against the athlete's real watch.
 *
 * A zod error contributes its issue paths rather than its default multi-line
 * dump, which is unreadable in a table cell. Length is capped because this is a
 * diagnosis for a person, not a log sink.
 */
function detailOf(error: unknown): string | null {
  if (error == null) return null;
  const text =
    typeof error === "string"
      ? error
      : error instanceof ZodError
        ? error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > 600 ? `${trimmed.slice(0, 599)}…` : trimmed;
}

function contentRewriteRetryable(reason: UpdateContentReason | undefined): boolean {
  return (
    reason === undefined ||
    reason === "error" ||
    reason === "not_visible" ||
    reason === "slot_occupied"
  );
}

/**
 * NEVER ADOPT ANOTHER SESSION'S COPY (Audit 3-A lane L-1, ruling 3-R12).
 *
 * `createWorkout` answers a same-day `already_present` from the stamp alone: "a workout carrying this name is already
 * on the day". For a retried create (a lost response, a late-visible write) that copy is this job's own, and adopting
 * it is the idempotence the stamp exists for. But when two sessions carried one stamp — a queue from before the one
 * chooser, two Sends racing — the copy is the OTHER session's, and adopting it made two rows claim one workout:
 * taking either off deleted both, and the import archived the survivor. So a found copy is adopted only when nobody
 * else holds it: no other row records that address as verified, and no other job that may hold a copy carries the
 * stamp on that day. The same row's own coach jobs (a rewrite keeping its stamp) are its own history; another
 * build's push of the same slot is another holder.
 *
 * "ANOTHER" MEANS A LIVE IDENTITY OF ITS OWN (re-review A-1 NEW). A holder row is a live (not archived) row of another
 * session: app-built (a program or on-demand slot) or one with a stamping job of its own (a coach session, an eased
 * import). Not a holder: an archived row — COROS recycles `idInPlan`s, and an absence-archived row keeps the address
 * it last held — nor the row the import made for THIS copy when a read ran between the lost response and the retry
 * (same address, no app identity of its own). Counting either refused a create's own copy: the job failed for good
 * and the copy was left on the watch with nothing to take it off.
 */
async function heldByAnother(
  db: Db,
  userId: string,
  job: { id: string; workoutId: string },
  stamp: { name: string; happenDay: string },
  result: { serverPlanId?: string; serverIdInPlan?: string },
): Promise<boolean> {
  if (result.serverPlanId != null && result.serverIdInPlan != null) {
    const [row] = await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.sourceWorkoutId, `${result.serverPlanId}:${result.serverIdInPlan}`),
          ne(plannedWorkouts.id, job.workoutId),
          ne(plannedWorkouts.lastVerifiedCorosDate, ""),
          isNull(plannedWorkouts.archivedAt),
          or(
            // `appAuthoredRow`, in SQL.
            inArray(plannedWorkouts.origin, ["program", "on_demand"]),
            exists(
              db
                .select({ one: sql`1` })
                .from(corosWriteJobs)
                .where(
                  and(
                    eq(corosWriteJobs.userId, userId),
                    eq(corosWriteJobs.workoutId, plannedWorkouts.id),
                    inArray(corosWriteJobs.kind, [...STAMPING_JOB_KINDS]),
                  ),
                ),
            ),
          ),
        ),
      )
      .limit(1);
    if (row) return true;
  }
  const [other] = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, [...STAMPING_JOB_KINDS]),
        ne(corosWriteJobs.id, job.id),
        or(ne(corosWriteJobs.workoutId, job.workoutId), eq(corosWriteJobs.kind, "program_session_push")),
        notInArray(corosWriteJobs.status, [...SPENT_STAMP_STATUSES]),
        sql`json_extract(${corosWriteJobs.payload}, '$.name') = ${stamp.name}`,
        sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') = ${stamp.happenDay}`,
      ),
    )
    .limit(1);
  return other !== undefined;
}

/** The job fails for good — retrying cannot change who holds the copy. No session name in the log line. */
async function refuseAdoption(db: Db, job: { id: string }, lane: string): Promise<void> {
  console.error(`${lane} FAILED (${job.id}): the copy already on the day under its stamp is held by another session — not adopted`);
  await db
    .update(corosWriteJobs)
    .set({
      status: "failed",
      lastErrorCategory: "error",
      lastErrorDetail: "already_present: the copy under this stamp is held by another session; it was not adopted",
      updatedAt: nowInstant(),
    })
    .where(eq(corosWriteJobs.id, job.id));
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

/**
 * WHAT THE COACH DRAIN RUNS (ruling 3-R11, 2026-10-10): the watch writes a coach approve — or the banner's Retry —
 * queues: a session's create, rewrite or unpush, and the COROS date move a coach `move` makes. One a request: the
 * approve used to run the whole lane (cap 3) in its own invocation, and one strength rewrite on top of the approve
 * measured 65 (D1 statements + fetches) against the free plan's 50.
 */
export const COACH_DRAIN_KINDS = ["move_scheduled_workout", ...COACH_JOB_KINDS] as const;

/** Is any of this user's coach-drain work queued? One statement: the approve's answer says whether to drain. */
export async function coachDrainQueued(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "queued"),
        inArray(corosWriteJobs.kind, [...COACH_DRAIN_KINDS]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function executeCloudJobs(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  opts: {
    cap?: number;
    fetchImpl?: typeof fetch;
    /** Claim only a program push or its unpush — the session sheet's targeted drain (ruling 3-R11). */
    watchOnly?: boolean;
    /** Claim only these kinds — the coach drain (`COACH_DRAIN_KINDS`, ruling 3-R11). */
    onlyKinds?: readonly string[];
  } = {},
): Promise<{ executed: number }> {
  const cap = opts.cap ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // A restore is replacing the account (B2): no queued change reaches the
  // watch until it has finished.
  if (await restoreInProgress(db, userId)) return { executed: 0 };

  const client = await corosClient(db, env, userId, fetchImpl);
  if (!client) return { executed: 0 }; // not cloud-connected — devices may still claim

  const lock = await claimUserLock(db, userId, "coros_write", 10);
  if (!lock) return { executed: 0 };

  let executed = 0;
  /** Set when the invocation hits a runtime ceiling — see `isRuntimeLimit`. */
  let outOfBudget = false;
  try {
    for (let i = 0; i < cap && !outOfBudget; i++) {
      if (i > 0 && (await restoreInProgress(db, userId))) break;
      // Backfill chunks have their own worker-side walker with pacing —
      // excluded at claim time so a queued backfill can never head-of-line-
      // block moves and studio pushes (2026-08-12 incident).
      //
      // A program push is excluded the same way while the watch switch is off
      // (Phase 3, spec §6): it waits, queued, and nothing behind it waits for it.
      // Its unpush is a `coach_delete_workout` and runs either way (ruling 3-R10).
      const job = await claimNextJob(db, userId, CLOUD_DEVICE_ID, {
        excludeKinds: ["backfill", ...(watchPushEnabled(env) ? [] : ["program_session_push"])],
        ...(opts.watchOnly ? { watchOnly: true } : {}),
        ...(opts.onlyKinds ? { onlyKinds: opts.onlyKinds } : {}),
      });
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
        //
        // THE ROW IS READ AGAIN BEFORE ANYTHING IS WRITTEN (audit 1, coach
        // finding 1). `claimNextJob` loads it fresh, and a session that has left
        // the plan since the job was queued must not be created on the watch: a
        // create that never ran is simply cancelled, which is not a removal the
        // athlete has to be told about. (Every archive path supersedes the queued
        // create itself; this catches the rows that reached here anyway — a
        // legacy archive, or one that raced the claim.)
        //
        // NOR FOR AN APP-BUILT ROW (ruling 3-R13): a program or on-demand
        // session reaches the watch only through the athlete's own Send.
        if (!job.workout || job.workout.archivedAt || appAuthoredRow(job.workout)) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: nowInstant() })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const parsed = coachCreateWorkoutJobSchema.safeParse(job.payload);
        const now = nowInstant();
        if (!parsed.success) {
          await db
            .update(corosWriteJobs)
            .set({
              status: "failed",
              lastErrorCategory: "malformed_payload",
              lastErrorDetail: detailOf(parsed.error),
              updatedAt: now,
            })
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
        if (result.ok && result.reason === "already_present" && (await heldByAnother(db, userId, job, spec, result))) {
          await refuseAdoption(db, job, "coach create");
        } else if (result.ok) {
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
              ...paceWireStamp(job.payload, spec.session),
            })
            .where(eq(corosWriteJobs.id, job.id));
          // REMOVED WHILE THE CREATE WAS IN FLIGHT. The remove found a claimed
          // job it could not cancel and no stamp to unpush by, so it queued
          // nothing — and the session has just landed on the watch. Now the
          // stamp is recorded (the job above is verified), so the unpush the
          // remove could not write can be written here.
          const [landed] = await db
            .select()
            .from(plannedWorkouts)
            .where(eq(plannedWorkouts.id, spec.workoutId))
            .limit(1);
          if (landed?.archivedAt) await enqueueUnpushIfOurs(db, userId, landed, done, prefs);
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
              isRuntimeLimit(result.error)
                ? {
                    // Requeued WITHOUT touching `attempts`: the runtime ran out,
                    // the job never got its turn.
                    status: "queued",
                    claimedByDeviceId: null,
                    claimedAt: null,
                    updatedAt: done,
                  }
                : retryable && attempts < 3
                  ? {
                      status: "queued",
                      claimedByDeviceId: null,
                      claimedAt: null,
                      payload: { ...spec, attempts },
                      updatedAt: done,
                    }
                  : {
                      status: "failed",
                      lastErrorCategory: result.reason ?? "error",
                      lastErrorDetail: detailOf(result.error),
                      updatedAt: done,
                    },
            )
            .where(eq(corosWriteJobs.id, job.id));
          if (isRuntimeLimit(result.error)) outOfBudget = true;
        }
        executed += 1;
        continue;
      } else if (job.kind === "program_session_push") {
        // TODAY'S PROGRAM SESSION, SENT (Phase 3, spec §4.3). The same create+verify
        // core as a coach create, reporting onto the slot's row; the payload
        // carries the resolved steps, so what was previewed is what is written.
        const parsed = programSessionPushJobSchema.safeParse(job.payload);
        if (!parsed.success) {
          await db
            .update(corosWriteJobs)
            .set({
              status: "failed",
              lastErrorCategory: "malformed_payload",
              lastErrorDetail: detailOf(parsed.error),
              updatedAt: nowInstant(),
            })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const spec = parsed.data;
        // THE ROW IS READ AGAIN BEFORE ANYTHING IS WRITTEN. A slot archived,
        // moved off the push's day, or holding another locked build since the
        // send is not what was previewed for that day: superseded, no wire call.
        const row = job.workout;
        const sent = row ? await sentBuildIdOf(db, row.id) : null;
        if (!row || row.archivedAt || row.effectiveDate !== spec.happenDay || sent !== spec.buildId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: nowInstant() })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        // NOR WHAT SEND WOULD REFUSE NOW (audit 3-A lane L-2 / L-5). The lane may
        // claim a push long after the tap: after midnight (Send at 23:50 while
        // the hourly lane held the lock), after the session was done or skipped,
        // after the athlete turned COROS writes off. Such a push is superseded
        // with no wire call — it would land on a day gone, or write what the
        // athlete has resolved, or write at all — and its build is unlocked so
        // the slot builds and starts as any other, unless the slot is started or
        // done (Start owns that lock). A started slot of today still pushes.
        const resolved =
          row.contentState === "done" ||
          row.completionState === "completed" ||
          row.completionState === "skipped" ||
          row.completionState === "missed";
        if (spec.happenDay !== todayInZone(prefs.timezone) || resolved || !prefs.corosWritesEnabled) {
          const now = nowInstant();
          await db.update(corosWriteJobs).set({ status: "superseded", updatedAt: now }).where(eq(corosWriteJobs.id, job.id));
          await unlockSentBuild(db, row, spec.buildId, now);
          executed += 1;
          continue;
        }
        const catalog = await exerciseNameMap(db);
        const createSpec = {
          happenDay: String(localDateToCorosDay(spec.happenDay)),
          name: spec.name,
          session: spec.session,
        };
        // EVERY CATALOG ID IS RE-CHECKED BEFORE ANY WIRE CALL (spec §4.2): a
        // move whose catalog row left (or now names another exercise) fails the
        // job outright — retrying cannot bring it back, and the athlete sends
        // again from a fresh preview.
        try {
          buildProgramWatchProgram(createSpec, catalog);
        } catch (e) {
          await db
            .update(corosWriteJobs)
            .set({ status: "failed", lastErrorCategory: "error", lastErrorDetail: detailOf(e), updatedAt: nowInstant() })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const result = await createWorkout(client, createSpec, {
          catalog,
          // Explicit, never the executor's own clock default (the observation
          // span is anchored on it).
          today: todayInZone(prefs.timezone),
          log: () => undefined,
        });
        const done = nowInstant();
        if (result.ok && result.reason === "already_present" && (await heldByAnother(db, userId, job, spec, result))) {
          await refuseAdoption(db, job, "program push");
        } else if (result.ok) {
          await db
            .update(plannedWorkouts)
            .set({
              corosSyncState: "synced",
              lastVerifiedCorosDate: spec.happenDay,
              ...(result.wireFingerprint ? { sourceContentFingerprint: result.wireFingerprint } : {}),
              ...(result.serverPlanId != null && result.serverIdInPlan != null
                ? {
                    sourceWorkoutId: `${result.serverPlanId}:${result.serverIdInPlan}`,
                    sourceIdInPlan: String(result.serverIdInPlan),
                    ...(result.serverProgramId != null ? { sourceProgramId: String(result.serverProgramId) } : {}),
                  }
                : {}),
              updatedAt: done,
            })
            .where(eq(plannedWorkouts.id, spec.workoutId));
          // What the read-back OBSERVED — COROS's own encoding, never ours: the
          // import compares the next read with exactly these (Review Focus 5).
          const observed =
            result.wireFingerprint && result.wireTextFingerprint
              ? {
                  observed: {
                    wire: result.wireFingerprint,
                    text: result.wireTextFingerprint,
                    ...(result.wireStructureFingerprint ? { structure: result.wireStructureFingerprint } : {}),
                  },
                }
              : {};
          const { attempts: _attempts, observed: _old, ...kept } = spec;
          await db
            .update(corosWriteJobs)
            .set({
              status: "verified",
              verifiedAt: done,
              completedAt: done,
              updatedAt: done,
              lastErrorCategory: null,
              payload: { ...kept, ...observed },
            })
            .where(eq(corosWriteJobs.id, job.id));
          // MOVED OR REMOVED WHILE THE PUSH RAN (Review Focus 3). The move or the
          // archive could not cancel a claimed push and had no address to unpush
          // by; now the copy is recorded, so its unpush is queued at once.
          const [landed] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, spec.workoutId)).limit(1);
          if (
            landed &&
            (landed.archivedAt || landed.effectiveDate !== spec.happenDay || (await sentBuildIdOf(db, landed.id)) !== spec.buildId)
          ) {
            await unpushBuild(db, userId, landed, spec.buildId, done, prefs);
          }
        } else {
          // The coach create's retry taxonomy: transient outcomes requeue (cap 3),
          // a runtime ceiling requeues without counting.
          const attempts = (spec.attempts ?? 0) + 1;
          const retryable =
            result.reason === "slot_occupied" ||
            result.reason === "not_visible" ||
            result.reason === "error" ||
            result.reason === undefined;
          console.error(
            `program push ${retryable && attempts < 3 ? "retrying" : "FAILED"} (attempt ${attempts}): ${result.reason ?? ""}`,
          );
          await db
            .update(corosWriteJobs)
            .set(
              isRuntimeLimit(result.error)
                ? { status: "queued", claimedByDeviceId: null, claimedAt: null, updatedAt: done }
                : retryable && attempts < 3
                  ? {
                      status: "queued",
                      claimedByDeviceId: null,
                      claimedAt: null,
                      payload: { ...spec, attempts },
                      updatedAt: done,
                    }
                  : {
                      status: "failed",
                      lastErrorCategory: result.reason ?? "error",
                      lastErrorDetail: detailOf(result.error),
                      updatedAt: done,
                    },
            )
            .where(eq(corosWriteJobs.id, job.id));
          if (isRuntimeLimit(result.error)) outOfBudget = true;
        }
        executed += 1;
        continue;
      } else if (job.kind === "coach_update_workout") {
        // MAKE THE WATCH SAY WHAT THE APP SAYS. The athlete's complaint — "my
        // plan for today on the app and in coros completely don't match" — was
        // structural: no job kind could write CONTENT, so an approved ease left
        // COROS holding the original forever. `coach-apply.ts`'s
        // `enqueueContentConvergence` queues this; here it lands.
        const parsed = coachUpdateWorkoutJobSchema.safeParse(job.payload);
        if (!parsed.success) {
          await db
            .update(corosWriteJobs)
            .set({
              status: "failed",
              lastErrorCategory: "malformed_payload",
              lastErrorDetail: detailOf(parsed.error),
              updatedAt: nowInstant(),
            })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const spec = parsed.data;
        // NEVER OVER AN APP-BUILT ROW'S COPY (ruling 3-R13). A program or
        // on-demand session's copy is the build the athlete sent; only Send and
        // Take off write it. A rewrite queued before that rule (or by any path
        // that missed it) is superseded here, before any wire call.
        if (job.workout && appAuthoredRow(job.workout)) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: nowInstant() })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        // Freshest threshold wins over the one frozen in at enqueue time, for the
        // same reason a create prefers it — see `latestThresholdPace`. A rewrite
        // is often the SECOND chance to get pace bands onto a session that went
        // out before the athlete's threshold reading landed.
        const threshold = (await latestThresholdPace(db, userId)) ?? spec.thresholdPaceSecPerKm;
        // Lift/mobility needs the catalog to resolve its steps; a run never
        // touches it, so the ~382-row read is paid only when there is something
        // to resolve. Same rule the create branch uses.
        const catalog = spec.session.run ? new Map<string, string>() : await exerciseNameMap(db);
        // WHICH PROOF THIS JOB CARRIES — see `jobs.ts` and `content-executor.ts`
        // THE SECOND PROOF. The schema union guarantees exactly one is present;
        // this reads whichever it is and hands the executor the matching target.
        const importedProof = "importedFingerprint" in spec;
        const result = await updateWorkoutContent(
          client,
          {
            target: {
              happenDay: String(localDateToCorosDay(spec.happenDay)),
              // The proof is the ONLY thing that authorizes this write: for a
              // coach-created session the stamp recorded at push time, for an
              // imported one the content fingerprint the import recorded. The
              // address rides along and is re-proven either way.
              ...(importedProof
                ? {
                    importedProgramId: spec.importedProgramId,
                    importedFingerprint: spec.importedFingerprint,
                  }
                : { name: spec.recordedName }),
              idInPlan: spec.idInPlan,
              programId: spec.programId,
              planId: spec.corosPlanId,
            },
            session: spec.session,
            // What the rewrite leaves. A STAMP for a coach-created session,
            // equal to `recordedName` unless the ease renamed it (which the
            // executor treats as a rename and refuses if the new stamp is
            // taken); the PLAIN TITLE for an imported one, which claims no
            // authorship and needs no uniqueness.
            name: spec.name,
            ...(threshold ? { thresholdPaceSecPerKm: threshold } : {}),
          },
          {
            catalog,
            today: todayInZone(prefs.timezone),
            // RECREATE, and the trade is deliberate. The knob covers two cases:
            // a cleanly-rejected in-place write (where delete-then-create is the
            // proven path and healing is unambiguously right) and a workout
            // provably absent from COROS (where re-creating overrules an athlete
            // who may have deleted it there).
            //
            // Taking it accepts the second to get the first, because the first is
            // the bug this whole kind exists for: the in-place `status: 2`
            // content write is new, and if a real account rejects it, `refuse`
            // would leave every rewrite reporting `rejected` and every watch
            // holding the session the athlete was told had been replaced. The
            // residual is bounded and visible — a converge job that races a COROS
            // deletion puts the session back with its CURRENT content, which is
            // what the app says the day holds — and the row it was enqueued for
            // is `scheduled` and unarchived, i.e. a session the app is actively
            // prescribing.
            //
            // NEVER FOR AN IMPORTED SESSION. This app did not create those and
            // must not re-create one inside a COROS-authored plan at a brand-new
            // idInPlan after the athlete removed it. The executor refuses the
            // combination outright; asking for it here would be the request it
            // refuses, so it is not asked for.
            ...(importedProof ? {} : { fallback: "recreate" as const }),
            log: () => undefined,
          },
        );
        const done = nowInstant();
        if (result.ok) {
          if (result.paceTargetsOwed) {
            console.error(
              `coach rewrite pushed ${result.paceTargetsOwed} block(s) with no pace target` +
                ` (${spec.name}); no usable threshold pace`,
            );
          }
          // The wire's OWN fingerprint, straight from the executor — the program
          // the SERVER stored, after `/program/calculate` spliced duration and
          // load in and after COROS re-encoded whatever it chose to. That is the
          // version the next read returns, so it is the only value that keeps
          // rule 7 quiet; stamping what we SENT re-introduces the phantom drift
          // this whole evening was spent chasing (`"871.00"` sent, `871`
          // stored). Rebuilding it here would describe a program that was never
          // written (audit 2026-08-17).
          await db
            .update(plannedWorkouts)
            .set({
              corosSyncState: "synced",
              lastVerifiedCorosDate: result.serverHappenDay ?? spec.happenDay,
              ...(result.wireFingerprint ? { sourceContentFingerprint: result.wireFingerprint } : {}),
              // A remove-and-create lands at a NEW idInPlan, so the address has to
              // be re-stamped or every later move and delete is aimed at a slot
              // this session no longer occupies. An in-place executor returns the
              // same ids and this rewrites them to themselves.
              //
              // EXCEPT `sourceProgramId` ON AN IMPORTED ROW, which must be left
              // alone. That column carries two different things: COROS's own
              // `program.id` when an import wrote it, and `planProgramId` when a
              // create did (`create-executor.ts`'s `planProgramId ?? idInPlan`,
              // which is why the athlete's coach-created rows hold the literal
              // "42"/"43"/"44"). `serverProgramId` is the second kind, so writing
              // it over an imported row would replace the program identity the
              // second ownership proof re-reads with a two-digit slot number —
              // and the NEXT ease of that session could never prove ownership
              // again. An in-place rewrite changes no address at all, so there is
              // nothing to re-stamp; only `delete_and_create` moves a session,
              // and that path is refused outright for imported rows.
              ...(result.serverPlanId != null && result.serverIdInPlan != null
                ? {
                    sourceWorkoutId: `${result.serverPlanId}:${result.serverIdInPlan}`,
                    sourceIdInPlan: String(result.serverIdInPlan),
                    ...(result.serverProgramId != null && !importedProof
                      ? { sourceProgramId: String(result.serverProgramId) }
                      : {}),
                  }
                : {}),
              updatedAt: done,
            })
            .where(eq(plannedWorkouts.id, spec.workoutId));
          // THE CONTENT INTENT CAN FINALLY CLOSE. It was designed never to
          // resolve because nothing on COROS could confirm content; a verified
          // rewrite is that confirmation, so `content_stale` becomes a state a
          // session passes through instead of one it lives in.
          const intent = await openIntentFor(db, userId, spec.workoutId, "content");
          if (intent) await resolveIntent(db, intent.id, done);
          await db
            .update(corosWriteJobs)
            .set({
              status: "verified",
              verifiedAt: done,
              completedAt: done,
              updatedAt: done,
              ...(result.paceTargetsOwed
                ? { lastErrorCategory: "pace_targets_owed" }
                : { lastErrorCategory: null }),
              ...paceWireStamp(job.payload, spec.session),
            })
            .where(eq(corosWriteJobs.id, job.id));
        } else {
          const attempts = ((job.payload as { attempts?: number } | null)?.attempts ?? 0) + 1;
          const retryable = contentRewriteRetryable(result.reason);
          console.error(
            `coach rewrite ${retryable && attempts < 3 ? "retrying" : "FAILED"} (${spec.name},` +
              ` attempt ${attempts}): ${result.reason ?? ""} ${result.error ?? ""}`,
          );
          if (retryable && attempts < 3) {
            await db
              .update(corosWriteJobs)
              .set({
                status: "queued",
                claimedByDeviceId: null,
                claimedAt: null,
                payload: { ...spec, attempts },
                updatedAt: done,
              })
              .where(eq(corosWriteJobs.id, job.id));
          } else {
            // THE ROW MUST NOT CLAIM SUCCESS. `sync_issue` is the retryable,
            // visible state, and the content intent stays OPEN so the sheet keeps
            // saying the two copies differ.
            //
            // `lastVerifiedCorosDate` is cleared only when the old copy is
            // provably GONE: that column means "COROS confirmed this session on
            // this date", and after a delete-then-create whose create failed, it
            // no longer does. An in-place rewrite that failed changed nothing, so
            // COROS still holds the old copy on that date and the column is still
            // true — clearing it would trade one false statement for another.
            const oldCopyGone = result.pathUsed === "delete_and_create";
            await db
              .update(plannedWorkouts)
              .set({
                corosSyncState: "sync_issue",
                ...(oldCopyGone ? { lastVerifiedCorosDate: "" } : {}),
                updatedAt: done,
              })
              .where(eq(plannedWorkouts.id, spec.workoutId));
            await db
              .update(corosWriteJobs)
              .set({
                status: "failed",
                lastErrorCategory: result.reason ?? "error",
                lastErrorDetail: detailOf(result.error),
                completedAt: done,
                updatedAt: done,
              })
              .where(eq(corosWriteJobs.id, job.id));
          }
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
            .set({
              status: "failed",
              lastErrorCategory: "malformed_payload",
              lastErrorDetail: detailOf(parsed.error),
              updatedAt: nowInstant(),
            })
            .where(eq(corosWriteJobs.id, job.id));
          executed += 1;
          continue;
        }
        const spec = parsed.data;
        // A PROGRAM ROW'S ADDRESS IS ITS NEWEST SENT COPY'S (Phase 3): only when
        // the row's recorded stamp is the one this job deletes is that address
        // this copy's. Otherwise (a copy the row never recorded, or an older one
        // a later send replaced) the payload's address is the copy's, and the
        // row is left exactly as it is.
        const program = job.workout !== null && appAuthoredRow(job.workout);
        const rowsCopy =
          !program ||
          (await recordedStampFor(db, userId, spec.workoutId)) === spec.name ||
          // …or that copy under the name the athlete gave it in the COROS app (audit 3-A life L-5).
          (await renamedCopyOfRow(db, userId, spec.workoutId)) === spec.name;
        // WHERE COROS HOLDS IT NOW, not where it stood when the unpush was
        // queued (audit 1, coach finding 1). A move that was already in flight
        // when the session was removed lands first — the lock serialises them —
        // and re-dates the session; a delete aimed at the pre-move day then
        // found the address occupied on another date, refused `stamp_mismatch`,
        // and left the session on the watch. The row's verified address is
        // re-read at claim; the payload's is the fallback for a row that no
        // longer proves one. The stamp still authorizes the delete either way.
        const heldAt = job.workout && rowsCopy ? watchAddressOf(job.workout) : null;
        const target = heldAt ?? {
          happenDay: spec.happenDay,
          idInPlan: spec.idInPlan,
          programId: spec.programId,
          corosPlanId: spec.corosPlanId,
        };
        const result = await deleteWorkout(
          client,
          {
            happenDay: String(localDateToCorosDay(target.happenDay)),
            name: spec.name,
            idInPlan: target.idInPlan,
            programId: target.programId,
            planId: target.corosPlanId,
          },
          { today: todayInZone(prefs.timezone) },
        );
        const done = nowInstant();
        if (result.ok || result.refused === "not_found") {
          // Deleted — or provably already gone, which is the same outcome
          // for an unpush. The archived row no longer lives on the watch.
          //
          // `lastVerifiedCorosDate` is cleared with it (2026-08-17). The column
          // means "COROS confirmed this session on this date" and after an unpush
          // it does not, so leaving it set made `deriveWorkoutSync` — which reads
          // `effectiveDate === lastVerifiedCorosDate` first — call an unpushed row
          // "synced". Harmless while the only unpushes were archive-time ones
          // (archived rows do not render), and not harmless now that a live row
          // can be unpushed because its new content cannot cross the wire.
          //
          // A PROGRAM ROW'S COPY, GONE (Phase 3, spec §4.4): the address is reset
          // to the row's own id, and the push that put that copy there is
          // superseded — so Send queues it afresh. Only now, never at enqueue:
          // until the delete verifies the copy is still on the watch, and the
          // import must keep recognising its stamp.
          if (rowsCopy) {
            await db
              .update(plannedWorkouts)
              .set({
                corosSyncState: "calendar_only",
                lastVerifiedCorosDate: "",
                ...(program ? { sourceWorkoutId: spec.workoutId, sourceIdInPlan: null, sourceProgramId: null } : {}),
                updatedAt: done,
              })
              .where(eq(plannedWorkouts.id, spec.workoutId));
          }
          if (program) {
            await db
              .update(corosWriteJobs)
              .set({ status: "superseded", updatedAt: done })
              .where(
                and(
                  eq(corosWriteJobs.userId, userId),
                  eq(corosWriteJobs.workoutId, spec.workoutId),
                  eq(corosWriteJobs.kind, "program_session_push"),
                  eq(corosWriteJobs.status, "verified"),
                  or(
                    sql`json_extract(${corosWriteJobs.payload}, '$.name') = ${spec.name}`,
                    sql`json_extract(${corosWriteJobs.payload}, '$.renamed') = ${spec.name}`,
                  ),
                ),
              );
          } else if (job.workout?.archivedAt) {
            // A REMOVED COACH SESSION'S STAMP IS FREE ONCE ITS COPY IS GONE (re-review C-4a). Its verified create (or
            // rewrite) under this stamp kept holding the stamp for the one chooser, so every remove + re-add of the
            // same session on its day — a reshape, a wind-down — put " (2)", " (3)" … on the watch. Only now, when the
            // delete has verified, never at enqueue: until then the copy is on the watch and its stamp must stay taken.
            // A live row keeps its jobs: its own re-create reuses its own stamp anyway.
            await db
              .update(corosWriteJobs)
              .set({ status: "superseded", updatedAt: done })
              .where(
                and(
                  eq(corosWriteJobs.userId, userId),
                  eq(corosWriteJobs.workoutId, spec.workoutId),
                  inArray(corosWriteJobs.kind, [...COACH_STAMPING_JOB_KINDS]),
                  eq(corosWriteJobs.status, "verified"),
                  sql`json_extract(${corosWriteJobs.payload}, '$.name') = ${spec.name}`,
                ),
              );
          }
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
                    lastErrorDetail: detailOf(result.error),
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
