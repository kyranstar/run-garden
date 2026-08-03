/**
 * The safe schedule-move protocol (docs/COROS_INTEGRATION_FINDINGS.md D4–D6):
 * fresh read → precondition checks → status:2 direct update → read-after-write
 * verification, with an insert-before-delete remove-and-add fallback when the
 * server rejects the update. All writes are serialized by the single job loop
 * that calls this executor.
 */

import {
  addDays,
  daysBetween,
  maxLocalDate,
  minLocalDate,
  type CorosWriteResult,
  type CreateScheduledWorkoutJob,
  type DeleteScheduledWorkoutJob,
  type StudioJobResult,
} from "@rg/domain";
import {
  corosDayToLocalDate,
  corosProgramFingerprint,
  localDateToCorosDay,
  type RawCorosEntity,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";
import type { CorosClient } from "./coros-client.js";
import { createWorkout, deleteWorkout } from "./create-executor.js";

export interface MoveJob {
  id: string;
  originalDate: string; // yyyy-mm-dd
  destinationDate: string; // yyyy-mm-dd
  expectedContentFingerprint?: string;
  workout: {
    sourceIdInPlan: string;
    sourcePlanId: string;
    sourceProgramId?: string;
    /** `${corosPlanId}:${idInPlan}` — the authoritative plan scope for this
     * workout in a merged multi-plan schedule read. */
    sourceWorkoutId?: string;
  };
}

/** The COROS plan this job's workout belongs to. The sourceWorkoutId prefix is
 * authoritative; older payloads without it fall back to the response's
 * top-level plan (correct for single-plan accounts, the pre-studio world). */
function jobPlanId(job: MoveJob, raw: RawCorosSchedule): string {
  const prefix = job.workout.sourceWorkoutId?.split(":")[0];
  if (prefix) return prefix;
  return String(raw.id ?? job.workout.sourcePlanId);
}

/** CorosWriteResult minus the transport fields the caller adds. */
export type MoveJobResult = Omit<CorosWriteResult, "deviceId" | "finishedAt" | "signature">;

/** One claimed Plan Studio job, as the cloud hands it to the bridge. */
export type StudioJob =
  | { id: string; kind: "create_scheduled_workout"; studio: CreateScheduledWorkoutJob }
  | { id: string; kind: "delete_scheduled_workout"; studio: DeleteScheduledWorkoutJob };

/**
 * Seam for tests, mirroring `createBridgeState`'s `makeClient`. Production
 * never passes this: dispatch calls the real create-executor.
 */
export interface StudioExecutors {
  createWorkout: typeof createWorkout;
  deleteWorkout: typeof deleteWorkout;
}

export interface StudioJobOptions {
  /** yyyy-mm-dd anchor for the executor's plan-span sweep. */
  today?: string;
  /**
   * The bridge's LOCAL diagnostic sink (stderr). Nothing written here crosses
   * the device→cloud boundary; the reported result is structured codes only.
   */
  log?: (line: string) => void;
  executors?: StudioExecutors;
}

interface Located {
  entity: RawCorosEntity;
  program: RawCorosProgram | undefined;
  date: string;
}

/**
 * Find one plan's entity/program in a (possibly merged multi-plan) schedule
 * read. idInPlan is only unique within its own plan — schedule/query merges
 * every plan on the account (research §3), so an unscoped match can locate a
 * DIFFERENT plan's workout that happens to share the number, and a move would
 * then rewrite the wrong plan. `planId` scopes the match; rows without their
 * own planId belong to the response's top-level plan.
 */
function locate(raw: RawCorosSchedule, planId: string, idInPlan: string): Located | undefined {
  const topId = String(raw.id ?? "");
  const inPlan = (rowPlanId: unknown) => String(rowPlanId ?? topId) === planId;
  const entity = (raw.entities ?? []).find(
    (e) => inPlan(e.planId) && String(e.idInPlan) === String(idInPlan),
  );
  if (!entity) return undefined;
  const program = (raw.programs ?? []).find(
    (p) => inPlan(p.planId) && String(p.idInPlan) === String(idInPlan),
  );
  return { entity, program, date: corosDayToLocalDate(entity.happenDay) };
}

function versionOf(program: RawCorosProgram | undefined): string | undefined {
  return program?.version != null ? String(program.version) : undefined;
}

export async function executeMoveJob(client: CorosClient, job: MoveJob): Promise<MoveJobResult> {
  const windowStart = addDays(minLocalDate(job.originalDate, job.destinationDate), -3);
  const windowEnd = addDays(maxLocalDate(job.originalDate, job.destinationDate), 3);
  const idInPlan = job.workout.sourceIdInPlan;
  const readWindow = (): Promise<RawCorosSchedule> => client.getRawSchedule(windowStart, windowEnd);
  const result = (partial: Omit<MoveJobResult, "jobId">): MoveJobResult => ({
    jobId: job.id,
    ...partial,
  });

  // 1. Fresh read covering both dates.
  const raw = await readWindow();
  const planScope = jobPlanId(job, raw);
  const found = locate(raw, planScope, idInPlan);

  // 2. Workout no longer exists upstream.
  if (!found) {
    return result({ outcome: "upstream_changed", errorCategory: "workout_not_found" });
  }

  // 3. Idempotent exit: already at the destination — no write.
  if (found.date === job.destinationDate) {
    return result({
      outcome: "already_in_desired_state",
      observedDate: found.date,
      observedFingerprint: found.program ? corosProgramFingerprint(found.program) : undefined,
      observedVersion: versionOf(found.program),
    });
  }

  // 4. Refuse to overwrite a workout that moved upstream.
  if (found.date !== job.originalDate) {
    return result({ outcome: "upstream_changed", observedDate: found.date });
  }

  if (!found.program) {
    // A date move resends the raw program; without it we cannot write safely.
    return result({ outcome: "upstream_changed", errorCategory: "program_not_found" });
  }

  // 5. Content guard: the workout definition must be what the user approved.
  const preFingerprint = corosProgramFingerprint(found.program);
  if (job.expectedContentFingerprint && preFingerprint !== job.expectedContentFingerprint) {
    return result({
      outcome: "upstream_changed",
      errorCategory: "content_changed",
      observedDate: found.date,
      observedFingerprint: preFingerprint,
    });
  }

  const planId = planScope;
  const planStartDay = raw.startDay != null ? Number(raw.startDay) : undefined;
  const destDay = localDateToCorosDay(job.destinationDate);

  // 6. Direct path: full raw entity/program, happenDay changed.
  let update;
  try {
    update = await client.updateScheduleEntity(
      found.entity,
      found.program,
      planId,
      destDay,
      planStartDay,
    );
  } catch {
    // Network failure mid-write — state unknown. Re-read once before giving up.
    try {
      const reread = locate(await readWindow(), planScope, idInPlan);
      const rereadFp = reread?.program ? corosProgramFingerprint(reread.program) : undefined;
      // Same bar as the happy path (step 7): the move only counts as verified
      // when BOTH the date landed AND the content is still what the user
      // approved. A matching date with a changed fingerprint is not "verified".
      if (reread?.date === job.destinationDate && rereadFp === preFingerprint) {
        return result({
          outcome: "verified",
          pathUsed: "direct_update",
          observedDate: reread.date,
          observedFingerprint: rereadFp,
          observedVersion: versionOf(reread.program),
        });
      }
      if (reread?.date === job.originalDate) {
        return result({
          outcome: "write_failed",
          errorCategory: "network",
          observedDate: reread.date,
        });
      }
      return result({
        outcome: "ambiguous",
        errorCategory: "network",
        observedDate: reread?.date,
        observedFingerprint: rereadFp,
      });
    } catch {
      return result({ outcome: "ambiguous", errorCategory: "network" });
    }
  }

  if (update.ok) {
    // 7. Read-after-write: destination date AND unchanged program fingerprint.
    try {
      const after = locate(await readWindow(), planScope, idInPlan);
      const afterFingerprint = after?.program
        ? corosProgramFingerprint(after.program)
        : undefined;
      if (after?.date === job.destinationDate && afterFingerprint === preFingerprint) {
        return result({
          outcome: "verified",
          pathUsed: "direct_update",
          observedDate: after.date,
          observedFingerprint: afterFingerprint,
          observedVersion: versionOf(after.program),
        });
      }
      return result({
        outcome: "verification_failed",
        pathUsed: "direct_update",
        observedDate: after?.date,
        observedFingerprint: afterFingerprint,
      });
    } catch {
      return result({ outcome: "ambiguous", pathUsed: "direct_update", errorCategory: "network" });
    }
  }

  // 8. Server rejected the update cleanly → remove-and-add fallback.
  return removeAndAdd(client, job, readWindow, planId, destDay, planStartDay, result);
}

/**
 * Insert-before-delete fallback (decision D5): a mid-operation failure leaves
 * a visible, recoverable duplicate rather than a lost workout.
 */
async function removeAndAdd(
  client: CorosClient,
  job: MoveJob,
  readWindow: () => Promise<RawCorosSchedule>,
  planId: string,
  destDay: number,
  planStartDay: number | undefined,
  result: (partial: Omit<MoveJobResult, "jobId">) => MoveJobResult,
): Promise<MoveJobResult> {
  const idInPlan = job.workout.sourceIdInPlan;

  // (a) Re-read: fresh maxIdInPlan + raw objects to clone. Nothing written yet,
  // so a failure here is a clean write_failed.
  let fresh: RawCorosSchedule;
  try {
    fresh = await readWindow();
  } catch {
    return result({ outcome: "write_failed", errorCategory: "network" });
  }
  const original = locate(fresh, planId, idInPlan);
  if (!original || !original.program) {
    return result({ outcome: "upstream_changed", errorCategory: "workout_not_found" });
  }
  if (original.date !== job.originalDate) {
    return result({ outcome: "upstream_changed", observedDate: original.date });
  }
  const newIdInPlan = Number(fresh.maxIdInPlan ?? 0) + 1;
  const entityClone: RawCorosEntity = { ...original.entity, happenDay: destDay };
  if (planStartDay != null && planStartDay > 0) {
    entityClone.dayNo =
      daysBetween(corosDayToLocalDate(planStartDay), job.destinationDate) + 1;
  }

  // (b) Insert the clone at the destination.
  let addThrew = false;
  try {
    const add = await client.addScheduleEntity(entityClone, original.program, newIdInPlan, planId);
    if (!add.ok) {
      return result({ outcome: "write_failed", errorCategory: "add_rejected" });
    }
  } catch {
    addThrew = true; // clone may or may not exist — the verification read decides
  }

  // (c) Verify the clone exists at the destination.
  let afterAdd: RawCorosSchedule;
  try {
    afterAdd = await readWindow();
  } catch {
    return result({ outcome: "ambiguous", errorCategory: "network" });
  }
  const clone = locate(afterAdd, planId, String(newIdInPlan));
  if (!clone || clone.date !== job.destinationDate) {
    if (clone) {
      // Visible but wrong — roll the clone back before reporting failure.
      try {
        await client.removeScheduleEntity(
          newIdInPlan,
          String(clone.entity.planProgramId ?? newIdInPlan),
          planId,
        );
      } catch {
        return result({ outcome: "verification_failed", errorCategory: "duplicate_left" });
      }
      return result({ outcome: "rolled_back", errorCategory: "insert_verification_failed" });
    }
    if (addThrew) {
      return result({ outcome: "ambiguous", errorCategory: "network" });
    }
    // Original untouched, no clone visible: a clean failure.
    return result({
      outcome: "write_failed",
      errorCategory: "insert_verification_failed",
      observedDate: original.date,
    });
  }

  // (d) Delete the original. A failure here leaves a duplicate — visible and
  // recoverable, never silently ignored.
  try {
    const del = await client.removeScheduleEntity(
      idInPlan,
      String(original.entity.planProgramId ?? idInPlan),
      planId,
    );
    if (!del.ok) {
      return result({ outcome: "verification_failed", errorCategory: "duplicate_left" });
    }
  } catch {
    return result({ outcome: "verification_failed", errorCategory: "duplicate_left" });
  }

  // (e) Verify the original is gone and the clone remains.
  let final: RawCorosSchedule;
  try {
    final = await readWindow();
  } catch {
    return result({ outcome: "ambiguous", errorCategory: "network" });
  }
  const originalStill = locate(final, planId, idInPlan);
  const cloneStill = locate(final, planId, String(newIdInPlan));
  if (originalStill) {
    return result({
      outcome: "verification_failed",
      errorCategory: "duplicate_left",
      observedDate: originalStill.date,
    });
  }
  if (!cloneStill || cloneStill.date !== job.destinationDate) {
    return result({ outcome: "verification_failed", errorCategory: "clone_missing" });
  }
  return result({
    outcome: "verified",
    pathUsed: "remove_and_add",
    observedDate: cloneStill.date,
    observedFingerprint: cloneStill.program
      ? corosProgramFingerprint(cloneStill.program)
      : undefined,
    observedVersion:
      cloneStill.program?.version != null ? String(cloneStill.program.version) : undefined,
  });
}

// ── Plan Studio dispatch (plan-studio-design §5) ────────────────────────────

/**
 * Coarse `outcome` for the attempt log. The studio state machine in the worker
 * reads `result.studio`, NOT this field — the move vocabulary cannot express a
 * create's `wrong_date` or a delete's `stamp_mismatch`, and collapsing them
 * here would lose exactly the distinctions the push UI has to show.
 */
function createOutcome(studio: StudioJobResult): CorosWriteResult["outcome"] {
  if (studio.ok) return studio.reason === "already_present" ? "already_in_desired_state" : "verified";
  switch (studio.reason) {
    case "error":
    case "slot_occupied":
    case "rejected":
      return "write_failed"; // nothing verified landed
    case "no_target_plan":
    case "out_of_span":
      return "unsupported"; // refused before any write; the bridge could not act
    default:
      return "verification_failed"; // wrote (or may have), cannot prove the desired state
  }
}

function deleteOutcome(studio: StudioJobResult): CorosWriteResult["outcome"] {
  if (studio.ok) return "verified";
  switch (studio.refused) {
    case "not_found":
      return "already_in_desired_state"; // already gone; nothing was sent
    case "stamp_mismatch":
      return "upstream_changed";
    case "ambiguous":
      return "verification_failed";
    default:
      return "write_failed";
  }
}

/**
 * Run one studio job against the shared create-executor and report it.
 *
 * Two rules this function exists to hold:
 *
 *  - `verbose: false`, always. The executor's log lines can name workouts the
 *    user authored; the bridge's sink is local stderr, and NOTHING from it —
 *    nor any executor message — is put in the reported result. The result
 *    carries structured codes and the server's own ids, nothing else.
 *  - NO `planId` on creates. The executor resolves the account's active
 *    container plan from its own fresh read and refuses if that identity moves
 *    mid-create; asserting a plan here would put a stale worker-side id ahead
 *    of the server's answer, defeating that guard.
 *
 * Never throws: the executors don't, and everything else is mapped.
 */
export async function executeStudioJob(
  client: CorosClient,
  job: StudioJob,
  opts: StudioJobOptions = {},
): Promise<MoveJobResult> {
  const log = opts.log ?? ((): void => undefined);
  const exec = opts.executors ?? { createWorkout, deleteWorkout };
  const happenDay = String(localDateToCorosDay(job.studio.happenDay));

  if (job.kind === "create_scheduled_workout") {
    const result = await exec.createWorkout(
      client,
      { happenDay, name: job.studio.name, session: job.studio.session },
      {
        catalog: new Map(job.studio.catalog.map((e) => [e.id, e.name])),
        today: opts.today,
        log,
        verbose: false,
      },
    );
    // Ids are copied through exactly as the executor returned them — including
    // its deliberate omission of them on a cross-day `already_present`, where
    // reconstructing an address would invite a delete aimed at the wrong day.
    const studio: StudioJobResult = {
      pushId: job.studio.pushId,
      kind: job.kind,
      ok: result.ok,
      ...(result.code !== undefined ? { code: result.code } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.serverIdInPlan !== undefined ? { serverIdInPlan: result.serverIdInPlan } : {}),
      ...(result.serverProgramId !== undefined ? { serverProgramId: result.serverProgramId } : {}),
      ...(result.serverEntityId !== undefined ? { serverEntityId: result.serverEntityId } : {}),
      ...(result.serverPlanId !== undefined ? { serverPlanId: result.serverPlanId } : {}),
      // Reported even when the ids were withheld (cross-day already_present):
      // knowing WHERE the stamp is, is what makes that refusal actionable.
      ...(result.serverHappenDay !== undefined
        ? { serverHappenDay: result.serverHappenDay }
        : {}),
    };
    if (result.error) log(`[coros-bridge] create ${job.id}: ${result.error}`);
    return { jobId: job.id, outcome: createOutcome(studio), studio };
  }

  const result = await exec.deleteWorkout(
    client,
    {
      happenDay,
      name: job.studio.name,
      idInPlan: job.studio.idInPlan,
      programId: job.studio.programId,
      planId: job.studio.corosPlanId,
    },
    { today: opts.today, log, verbose: false },
  );
  const studio: StudioJobResult = {
    pushId: job.studio.pushId,
    kind: job.kind,
    ok: result.ok,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.refused !== undefined ? { refused: result.refused } : {}),
  };
  if (result.error) log(`[coros-bridge] delete ${job.id}: ${result.error}`);
  return { jobId: job.id, outcome: deleteOutcome(studio), studio };
}
