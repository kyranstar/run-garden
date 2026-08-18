import { ZodError } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { corosWriteJobs, dailyHealth, plannedWorkouts } from "@rg/database";
import {
  nowInstant,
  todayInZone,
  type CoachSession,
  type CorosWriteResult,
  type UserPreferences,
} from "@rg/domain";
import {
  createWorkout,
  deleteWorkout,
  executeMoveJob,
  executeStudioJob,
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
} from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { isRuntimeLimit } from "./runtime-limit.js";
import { corosReadNow } from "./coros-read.js";
import { applyJobResult, claimNextJob } from "./jobs.js";
import { bridgeJobPayload } from "./studio-push.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { exerciseNameMap } from "./exercise-catalog.js";
import { openIntentFor, resolveIntent } from "./sync-intents.js";

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
  /** Set when the invocation hits a runtime ceiling — see `isRuntimeLimit`. */
  let outOfBudget = false;
  try {
    for (let i = 0; i < cap && !outOfBudget; i++) {
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
          //
          // `lastVerifiedCorosDate` is cleared with it (2026-08-17). The column
          // means "COROS confirmed this session on this date" and after an unpush
          // it does not, so leaving it set made `deriveWorkoutSync` — which reads
          // `effectiveDate === lastVerifiedCorosDate` first — call an unpushed row
          // "synced". Harmless while the only unpushes were archive-time ones
          // (archived rows do not render), and not harmless now that a live row
          // can be unpushed because its new content cannot cross the wire.
          await db
            .update(plannedWorkouts)
            .set({ corosSyncState: "calendar_only", lastVerifiedCorosDate: "", updatedAt: done })
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
