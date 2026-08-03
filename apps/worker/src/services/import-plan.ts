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
}

export interface ImportStats {
  planId: string;
  created: number;
  updatedDates: number;
  updatedContent: number;
  archivedMissing: number;
  /** Rows resurrected because COROS demonstrably still schedules them. */
  unarchived: number;
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
    unarchived: 0,
    verifiedJobs: 0,
    conflicts: 0,
    unchanged: 0,
  };

  // ── Plan rows — one per COROS plan present in this (merged) snapshot ──────
  // schedule/query merges every plan on the account (research §3): the run
  // plan, COROS template plans, and the account's own container plan that
  // studio-pushed lifting sessions live in. Each workout arrives tagged with
  // its own sourcePlanId; a plan row is upserted per distinct id. A plan that
  // stops appearing is left active — its workouts age out via absence
  // detection (rule 8), which is evidence-based, unlike the old "archive
  // every other active plan" rule that mass-archived good workouts whenever
  // the merged response's top-level plan flipped.
  const activePlans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, input.userId), eq(trainingPlans.status, "active")));
  const planRowsBySourceId = new Map(activePlans.map((p) => [p.sourcePlanId, p]));

  const sourcePlanIds = new Set<string>(input.workouts.map((w) => w.sourcePlanId));
  sourcePlanIds.add(input.plan.sourcePlanId);
  for (const sourcePlanId of sourcePlanIds) {
    const isPrimary = sourcePlanId === input.plan.sourcePlanId;
    const existing = planRowsBySourceId.get(sourcePlanId);
    if (!existing) {
      const group = input.workouts.filter((w) => w.sourcePlanId === sourcePlanId);
      const allStrength = group.length > 0 && group.every((w) => w.sport === "strength");
      const id = newId();
      await db.insert(trainingPlans).values({
        id,
        userId: input.userId,
        provider: "coros",
        sourcePlanId,
        // Only the top-level plan's metadata is present in the response; other
        // plans get an honest generic name rather than a leaked i18n code.
        name: isPrimary ? input.plan.name : allStrength ? "Lifting plan" : "COROS plan",
        startDate: isPrimary ? (input.plan.startDate ?? null) : null,
        endDate: isPrimary ? (input.plan.endDate ?? null) : null,
        status: "active",
        pbVersion: isPrimary ? (input.plan.pbVersion ?? null) : null,
        sourceVersion: isPrimary ? (input.plan.sourceVersion ?? null) : null,
        createdAt: now,
        updatedAt: now,
      });
      planRowsBySourceId.set(
        sourcePlanId,
        (await db.select().from(trainingPlans).where(eq(trainingPlans.id, id)))[0]!,
      );
    } else if (
      isPrimary &&
      (existing.name !== input.plan.name || existing.pbVersion !== (input.plan.pbVersion ?? null))
    ) {
      await db
        .update(trainingPlans)
        .set({
          name: input.plan.name,
          pbVersion: input.plan.pbVersion ?? null,
          endDate: input.plan.endDate ?? existing.endDate,
          updatedAt: now,
        })
        .where(eq(trainingPlans.id, existing.id));
    }
  }
  stats.planId = planRowsBySourceId.get(input.plan.sourcePlanId)!.id;

  // sourceWorkoutIds are globally unique (`${corosPlanId}:${idInPlan}`), so
  // one user-wide map covers every plan in the snapshot.
  const existing = await db
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, input.userId));
  const existingBySourceId = new Map(existing.map((w) => [w.sourceWorkoutId, w]));

  // A workout the user explicitly removed stays removed even though COROS
  // still reports it — that's the one archived state presence must not heal.
  const userRemovedIds = new Set(
    (
      await db
        .select({ workoutId: calendarEventSuppressions.workoutId })
        .from(calendarEventSuppressions)
        .where(eq(calendarEventSuppressions.reason, "user_removed"))
    ).map((s) => s.workoutId),
  );

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
        planId: planRowsBySourceId.get(src.sourcePlanId)!.id,
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
        // We just read this workout's date FROM COROS, so by construction the
        // two sides agree. `calendar_only` is reserved for a local date change
        // that couldn't be written back — never for freshly imported rows.
        corosSyncState: "synced",
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

    // Presence heals absence: a row archived by absence detection (or by the
    // old plan-switch rule) that COROS demonstrably still schedules comes
    // back, along with its calendar event. Rows the user removed by hand stay
    // removed — that's a decision, not an absence.
    if (current.archivedAt && current.completionState === "scheduled" && !userRemovedIds.has(current.id)) {
      updates.archivedAt = null;
      updates.calendarSyncState = current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
      await db
        .delete(calendarEventSuppressions)
        .where(
          and(
            eq(calendarEventSuppressions.workoutId, current.id),
            eq(calendarEventSuppressions.reason, "workout_removed"),
          ),
        );
      stats.unarchived += 1;
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
        // Both sides agree on the new date now.
        updates.corosSyncState = "synced";
        // A workout we were about to ask "did this run happen?" about has been
        // rescheduled upstream — the question no longer applies to the new
        // date. Reconcile will re-ask if the new date also passes unanswered.
        if (current.completionState === "unresolved") updates.completionState = "scheduled";
        stats.updatedDates += 1;
        touched = true;
      }
    } else if (pendingJob && corosDate === pendingJob.originalDate) {
      // Still waiting for the move to land; nothing to change.
    } else if (
      !pendingJob &&
      current.effectiveDate === corosDate &&
      (current.corosSyncState === "calendar_only" || current.corosSyncState === "needs_attention")
    ) {
      // Healing: COROS and Run Garden agree on the date (verified by this very
      // read), so whatever left the row flagged — an import made while writes
      // were unavailable, a resolved conflict — is provably over.
      updates.corosSyncState = "synced";
      touched = true;
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
  // Versions track the PRIMARY (top-level) plan — the one whose metadata the
  // merged response actually describes.
  const primaryPlanId = stats.planId;
  const versionCount = await db
    .select({ id: trainingPlanVersions.id })
    .from(trainingPlanVersions)
    .where(eq(trainingPlanVersions.planId, primaryPlanId));
  if (stats.created + stats.updatedContent + stats.archivedMissing > 0 || versionCount.length === 0) {
    await db.insert(trainingPlanVersions).values({
      id: newId(),
      planId: primaryPlanId,
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
