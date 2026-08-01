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

export interface MoveJob {
  id: string;
  originalDate: string; // yyyy-mm-dd
  destinationDate: string; // yyyy-mm-dd
  expectedContentFingerprint?: string;
  workout: {
    sourceIdInPlan: string;
    sourcePlanId: string;
    sourceProgramId?: string;
  };
}

/** CorosWriteResult minus the transport fields the caller adds. */
export type MoveJobResult = Omit<CorosWriteResult, "deviceId" | "finishedAt" | "signature">;

interface Located {
  entity: RawCorosEntity;
  program: RawCorosProgram | undefined;
  date: string;
}

function locate(raw: RawCorosSchedule, idInPlan: string): Located | undefined {
  const entity = (raw.entities ?? []).find((e) => String(e.idInPlan) === String(idInPlan));
  if (!entity) return undefined;
  const program = (raw.programs ?? []).find((p) => String(p.idInPlan) === String(idInPlan));
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
  const found = locate(raw, idInPlan);

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

  const planId = String(raw.id ?? job.workout.sourcePlanId);
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
      const reread = locate(await readWindow(), idInPlan);
      if (reread?.date === job.destinationDate) {
        const fp = reread.program ? corosProgramFingerprint(reread.program) : undefined;
        return result({
          outcome: "verified",
          pathUsed: "direct_update",
          observedDate: reread.date,
          observedFingerprint: fp,
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
      });
    } catch {
      return result({ outcome: "ambiguous", errorCategory: "network" });
    }
  }

  if (update.ok) {
    // 7. Read-after-write: destination date AND unchanged program fingerprint.
    try {
      const after = locate(await readWindow(), idInPlan);
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
  const original = locate(fresh, idInPlan);
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
  const clone = locate(afterAdd, String(newIdInPlan));
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
  const originalStill = locate(final, idInPlan);
  const cloneStill = locate(final, String(newIdInPlan));
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
