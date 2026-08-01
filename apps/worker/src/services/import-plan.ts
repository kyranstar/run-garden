import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import {
  calendarEventSuppressions,
  corosWriteJobs,
  plannedWorkoutStages,
  plannedWorkouts,
  trainingPlanVersions,
  trainingPlans,
} from "@rg/database";
import {
  isWeekend,
  newId,
  nowInstant,
  type SchedulingPreferences,
  type UserPreferences,
} from "@rg/domain";
import { classifyWorkout, estimateDuration, summarizeStages } from "@rg/scheduling";
import type { SourcePlannedWorkout, TrainingPlanInfo } from "@rg/providers";
import { chunkedInsert, type Db } from "./db.js";

/**
 * Plan import + COROS reconciliation (rules 1–11 of the sync spec, see
 * docs/SYNC_AND_RECONCILIATION.md). Idempotent: re-importing the same snapshot
 * is a no-op.
 */

export interface ImportInput {
  userId: string;
  plan: TrainingPlanInfo;
  workouts: SourcePlannedWorkout[];
  /** The date range this snapshot covers (for absence detection). */
  rangeStart: string;
  rangeEnd: string;
  source: "bridge" | "fixture" | "official";
  corosWriteAvailable: boolean;
}

export interface ImportStats {
  planId: string;
  created: number;
  updatedDates: number;
  updatedContent: number;
  archivedMissing: number;
  verifiedJobs: number;
  conflicts: number;
  unchanged: number;
}

function defaultTimeFor(
  workout: { category: string; date: string },
  prefs: SchedulingPreferences,
): string {
  // Long runs and races default to the morning; everything else follows the
  // user's default window. All of it is user-adjustable afterwards.
  if (workout.category === "long" || workout.category === "race") {
    return isWeekend(workout.date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
  }
  if (prefs.defaultWindow === "evening") return prefs.weekdayEveningTime;
  return isWeekend(workout.date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
}

export async function importPlanSnapshot(
  db: Db,
  input: ImportInput,
  prefs: UserPreferences,
): Promise<ImportStats> {
  const now = nowInstant();
  const stats: ImportStats = {
    planId: "",
    created: 0,
    updatedDates: 0,
    updatedContent: 0,
    archivedMissing: 0,
    verifiedJobs: 0,
    conflicts: 0,
    unchanged: 0,
  };

  // ── Plan row (archive a previously-active different plan: rule 9) ─────────
  const activePlans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, input.userId), eq(trainingPlans.status, "active")));

  let planRow = activePlans.find((p) => p.sourcePlanId === input.plan.sourcePlanId);
  for (const stale of activePlans) {
    if (stale.sourcePlanId === input.plan.sourcePlanId) continue;
    await db
      .update(trainingPlans)
      .set({ status: "archived", archivedAt: now, updatedAt: now })
      .where(eq(trainingPlans.id, stale.id));
    // Archive its future workouts; completed history is preserved untouched.
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(plannedWorkouts.planId, stale.id),
          eq(plannedWorkouts.completionState, "scheduled"),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
  }
  if (!planRow) {
    const id = newId();
    await db.insert(trainingPlans).values({
      id,
      userId: input.userId,
      provider: "coros",
      sourcePlanId: input.plan.sourcePlanId,
      name: input.plan.name,
      startDate: input.plan.startDate ?? null,
      endDate: input.plan.endDate ?? null,
      status: "active",
      pbVersion: input.plan.pbVersion ?? null,
      sourceVersion: input.plan.sourceVersion ?? null,
      createdAt: now,
      updatedAt: now,
    });
    planRow = (await db.select().from(trainingPlans).where(eq(trainingPlans.id, id)))[0]!;
  } else if (planRow.name !== input.plan.name || planRow.pbVersion !== (input.plan.pbVersion ?? null)) {
    await db
      .update(trainingPlans)
      .set({
        name: input.plan.name,
        pbVersion: input.plan.pbVersion ?? null,
        endDate: input.plan.endDate ?? planRow.endDate,
        updatedAt: now,
      })
      .where(eq(trainingPlans.id, planRow.id));
  }
  stats.planId = planRow.id;

  const existing = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, input.userId), eq(plannedWorkouts.planId, planRow.id)));
  const existingBySourceId = new Map(existing.map((w) => [w.sourceWorkoutId, w]));

  const pendingJobs = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, input.userId),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const pendingJobByWorkout = new Map(pendingJobs.map((j) => [j.workoutId, j]));

  const seenSourceIds = new Set<string>();

  for (const src of input.workouts) {
    seenSourceIds.add(src.sourceWorkoutId);
    const classification = classifyWorkout({
      title: src.title,
      sport: src.sport,
      stages: src.stages,
      plannedDurationSeconds: src.estimatedDurationSeconds,
      plannedDistanceMeters: src.estimatedDistanceMeters,
    });
    const category = src.isRestDay ? "rest" : classification.category;
    const estimate = estimateDuration({
      sourceEstimatedDurationSeconds: src.estimatedDurationSeconds,
      stages: src.stages,
      category,
      paceContext: { defaultPaceSecPerKm: 390 },
      bufferBeforeMinutes: prefs.bufferBeforeMinutes,
      bufferAfterMinutes: prefs.bufferAfterMinutes,
    });
    const stageSummary = src.stages.length > 0 ? summarizeStages(src.stages) : undefined;

    const current = existingBySourceId.get(src.sourceWorkoutId);
    if (!current) {
      // New workout from COROS.
      const id = newId();
      const effectiveTime = defaultTimeFor({ category, date: src.date }, prefs);
      await db.insert(plannedWorkouts).values({
        id,
        userId: input.userId,
        planId: planRow.id,
        sourceWorkoutId: src.sourceWorkoutId,
        sourceProgramId: src.sourceProgramId ?? null,
        sourceIdInPlan: src.sourceIdInPlan ?? null,
        title: src.title,
        category,
        qualitySubtype: classification.qualitySubtype ?? null,
        sport: src.sport,
        originalPlanDate: src.date,
        lastVerifiedCorosDate: src.date,
        effectiveDate: src.date,
        effectiveTime,
        sourceContentFingerprint: src.contentFingerprint,
        sourceVersion: src.sourceVersion ?? null,
        sourceEstimatedDurationSeconds: src.estimatedDurationSeconds ?? null,
        fallbackEstimatedDurationSeconds:
          estimate.source === "coros_native" ? null : estimate.workoutSeconds,
        calendarBlockDurationSeconds: estimate.calendarSeconds,
        durationEstimate: estimate as unknown as Record<string, unknown>,
        expectedDistanceMeters: src.estimatedDistanceMeters ?? null,
        stageSummary: stageSummary ?? null,
        calendarSyncState: category === "rest" ? "not_created" : "pending",
        corosSyncState: input.corosWriteAvailable ? "synced" : "calendar_only",
        completionState: "scheduled",
        createdAt: now,
        updatedAt: now,
      });
      await replaceStages(db, id, src);
      stats.created += 1;
      continue;
    }

    const updates: Record<string, unknown> = {};
    let touched = false;

    // Reset absence counter — it's present in this read.
    if (current.missingReads > 0) {
      updates.missingReads = 0;
      touched = true;
    }

    const pendingJob = pendingJobByWorkout.get(current.id);
    const corosDate = src.date;

    if (corosDate !== current.lastVerifiedCorosDate) {
      if (pendingJob && corosDate === pendingJob.destinationDate) {
        // Rule 4: COROS now reports our requested destination → job verified.
        await db
          .update(corosWriteJobs)
          .set({ status: "verified", verifiedAt: now, completedAt: now, updatedAt: now })
          .where(eq(corosWriteJobs.id, pendingJob.id));
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "synced";
        stats.verifiedJobs += 1;
        touched = true;
      } else if (pendingJob) {
        // Rule 6: upstream changed while a local move is pending → conflict.
        updates.corosSyncState = "needs_attention";
        updates.lastVerifiedCorosDate = corosDate;
        await db
          .update(corosWriteJobs)
          .set({ status: "needs_attention", updatedAt: now })
          .where(eq(corosWriteJobs.id, pendingJob.id));
        stats.conflicts += 1;
        touched = true;
      } else {
        // Rule 5: accept the upstream change; keep the time of day.
        updates.lastVerifiedCorosDate = corosDate;
        updates.effectiveDate = corosDate;
        updates.originalPlanDate = current.originalPlanDate; // history preserved
        updates.calendarSyncState =
          current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
        stats.updatedDates += 1;
        touched = true;
      }
    } else if (pendingJob && corosDate === pendingJob.originalDate) {
      // Still waiting for the move to land; nothing to change.
    }

    if (src.contentFingerprint !== current.sourceContentFingerprint) {
      // Rule 7: content changed upstream — update, preserve time of day.
      updates.title = src.title;
      updates.category = category;
      updates.qualitySubtype = classification.qualitySubtype ?? null;
      updates.sourceContentFingerprint = src.contentFingerprint;
      updates.sourceVersion = src.sourceVersion ?? null;
      updates.sourceEstimatedDurationSeconds = src.estimatedDurationSeconds ?? null;
      updates.fallbackEstimatedDurationSeconds =
        estimate.source === "coros_native" ? null : estimate.workoutSeconds;
      updates.calendarBlockDurationSeconds = estimate.calendarSeconds;
      updates.durationEstimate = estimate as unknown as Record<string, unknown>;
      updates.expectedDistanceMeters = src.estimatedDistanceMeters ?? null;
      updates.stageSummary = stageSummary ?? null;
      if (current.calendarSyncState === "synced") updates.calendarSyncState = "pending";
      await replaceStages(db, current.id, src);
      stats.updatedContent += 1;
      touched = true;
    }

    if (touched) {
      updates.updatedAt = now;
      await db.update(plannedWorkouts).set(updates).where(eq(plannedWorkouts.id, current.id));
    } else {
      stats.unchanged += 1;
    }
  }

  // ── Rule 8: workouts that disappeared upstream (double-read confirmation) ──
  for (const w of existing) {
    if (seenSourceIds.has(w.sourceWorkoutId)) continue;
    if (w.archivedAt) continue;
    if (w.completionState !== "scheduled") continue;
    if (w.lastVerifiedCorosDate < input.rangeStart || w.lastVerifiedCorosDate > input.rangeEnd) {
      continue; // outside this snapshot's window; absence proves nothing
    }
    const reads = w.missingReads + 1;
    if (reads >= 2) {
      await db
        .update(plannedWorkouts)
        .set({ archivedAt: now, missingReads: reads, updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
      await db.insert(calendarEventSuppressions).values({
        id: newId(),
        workoutId: w.id,
        eventId: null,
        reason: "workout_removed",
        createdAt: now,
      });
      stats.archivedMissing += 1;
    } else {
      await db
        .update(plannedWorkouts)
        .set({ missingReads: reads, updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
    }
  }

  // Plan version capture when the content fingerprint of the set changed.
  const versionCount = await db
    .select({ id: trainingPlanVersions.id })
    .from(trainingPlanVersions)
    .where(eq(trainingPlanVersions.planId, planRow.id));
  if (stats.created + stats.updatedContent + stats.archivedMissing > 0 || versionCount.length === 0) {
    await db.insert(trainingPlanVersions).values({
      id: newId(),
      planId: planRow.id,
      versionNum: versionCount.length + 1,
      capturedAt: now,
      contentFingerprint: `${input.plan.sourceVersion ?? ""}:${input.workouts.length}`,
      summary: {
        workouts: input.workouts.length,
        created: stats.created,
        updatedContent: stats.updatedContent,
        archived: stats.archivedMissing,
      },
    });
  }

  return stats;
}

async function replaceStages(db: Db, workoutId: string, src: SourcePlannedWorkout): Promise<void> {
  await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, workoutId));
  if (src.stages.length === 0) return;
  const stageRows = src.stages.map((s) => ({
    id: `${workoutId}:${s.id}`,
    workoutId,
    parentStageId: s.parentStageId ? `${workoutId}:${s.parentStageId}` : null,
    ord: s.order,
    kind: s.kind,
    repeatCount: s.repeatCount ?? null,
    durationType: s.durationType,
    durationSeconds: s.durationSeconds ?? null,
    distanceMeters: s.distanceMeters ?? null,
    targetType: s.targetType ?? null,
    targetLow: s.targetLow ?? null,
    targetHigh: s.targetHigh ?? null,
    paceZone: s.paceZone ?? null,
    hrZone: s.hrZone ?? null,
    label: s.label ?? null,
  }));
  await chunkedInsert(stageRows, 15, (batch) => db.insert(plannedWorkoutStages).values(batch));
}
