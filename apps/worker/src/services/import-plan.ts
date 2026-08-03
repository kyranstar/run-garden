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
import { openMoveIntents, resolveIntent } from "./sync-intents.js";
import { postSyncNote } from "./sync-notes.js";
import { reconcileWorkout } from "./reconcile.js";

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
  /** Workouts skipped because their plan is a COROS template/sample plan. */
  skippedForeignWorkouts: number;
  /** Rows rewritten in place because COROS recycled their idInPlan slot. */
  replacedRecycled: number;
  /** Mirror copies archived so each real session shows exactly once. */
  dedupedMirrors: number;
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
    skippedForeignWorkouts: 0,
    replacedRecycled: 0,
    dedupedMirrors: 0,
    verifiedJobs: 0,
    conflicts: 0,
    unchanged: 0,
  };

  // ── Foreign-plan filter ────────────────────────────────────────────────────
  // The merged read also carries COROS's own demo plans, and those are the
  // ONLY junk observed on the wire — every entity in them is literally
  // titled "… - Sample Workout". Everything else is the user's: the
  // top-level plan, studio-stamped sessions, and the second plan COROS
  // materializes the applied schedule into. An earlier heuristic ("admit
  // non-primary plans only if they overlap the primary") backfired
  // live when COROS moved ALL the runs into that second plan and left the
  // top-level holding only lifting — the real run schedule scored zero
  // overlap and got archived. Admission is therefore permissive: skip a
  // non-primary plan only when it is majority sample-titled; skipped plans'
  // stale rows age out through absence detection, and a wrongly skipped
  // plan self-heals via presence-based un-archiving the moment it's
  // admitted again.
  const SAMPLE_TITLE_RE = /sample workout/i;
  const admittedPlanIds = new Set<string>([input.plan.sourcePlanId]);
  for (const sourcePlanId of new Set(input.workouts.map((w) => w.sourcePlanId))) {
    if (admittedPlanIds.has(sourcePlanId)) continue;
    const group = input.workouts.filter((w) => w.sourcePlanId === sourcePlanId);
    const sampleShare =
      group.length > 0 ? group.filter((w) => SAMPLE_TITLE_RE.test(w.title)).length / group.length : 0;
    if (sampleShare > 0.5) stats.skippedForeignWorkouts += group.length;
    else admittedPlanIds.add(sourcePlanId);
  }
  const admitted = input.workouts.filter((w) => admittedPlanIds.has(w.sourcePlanId));

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

  for (const sourcePlanId of admittedPlanIds) {
    const isPrimary = sourcePlanId === input.plan.sourcePlanId;
    const existing = planRowsBySourceId.get(sourcePlanId);
    if (!existing) {
      const group = admitted.filter((w) => w.sourcePlanId === sourcePlanId);
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

  // Two archived states presence must not heal: a workout the user removed
  // by hand (a decision, not an absence), and a mirror copy deduped while its
  // keeper row is still alive (rule 8 releases the suppression when the
  // keeper dies, letting the mirror take over on the following snapshot).
  const userRemovedIds = new Set(
    (
      await db
        .select({ workoutId: calendarEventSuppressions.workoutId })
        .from(calendarEventSuppressions)
        .where(
          inArray(calendarEventSuppressions.reason, ["user_removed", "duplicate_mirror"]),
        )
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

  // Bulk-loaded once — never queried per row inside the loop below.
  const intentByWorkout = new Map(
    (await openMoveIntents(db, input.userId)).flatMap((i) => {
      const toDate = i.payload?.["toDate"];
      return typeof toDate === "string" ? [[i.targetId, { id: i.id, toDate }] as const] : [];
    }),
  );

  const seenSourceIds = new Set<string>();

  for (const src of admitted) {
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

    // Recycled wire id: COROS reuses a plan's idInPlan slots after deletes,
    // so the same `${planId}:${idInPlan}` can suddenly mean a different
    // workout (live-observed: lifting creates landing in slots freed by
    // removed runs, which content-updated run rows into lifting titles while
    // keeping sport "run"). A sport flip is the tell — this is replacement,
    // not an edit. The row is rewritten in place as the new workout (the
    // unique index owns the slot); completed history is the one thing never
    // rewritten — those rows keep their story and the slot's new occupant
    // stays out of the app until the row ages out.
    if (
      current &&
      current.sport !== src.sport &&
      (current.completionState === "completed" || current.completionState === "provisionally_completed")
    ) {
      stats.skippedForeignWorkouts += 1;
      continue;
    }
    if (current && current.sport !== src.sport) {
      const effectiveTime = defaultTimeFor({ category, date: src.date }, prefs);
      await db
        .update(plannedWorkouts)
        .set({
          title: src.title,
          category,
          qualitySubtype: classification.qualitySubtype ?? null,
          sport: src.sport,
          originalPlanDate: src.date,
          lastVerifiedCorosDate: src.date,
          effectiveDate: src.date,
          effectiveTime,
          sourceProgramId: src.sourceProgramId ?? null,
          sourceContentFingerprint: src.contentFingerprint,
          sourceVersion: src.sourceVersion ?? null,
          sourceEstimatedDurationSeconds: src.estimatedDurationSeconds ?? null,
          fallbackEstimatedDurationSeconds:
            estimate.source === "coros_native" ? null : estimate.workoutSeconds,
          calendarBlockDurationSeconds: estimate.calendarSeconds,
          durationEstimate: estimate as unknown as Record<string, unknown>,
          expectedDistanceMeters: src.estimatedDistanceMeters ?? null,
          stageSummary: stageSummary ?? null,
          calendarSyncState:
            current.calendarSyncState === "user_deleted"
              ? "user_deleted"
              : category === "rest"
                ? "not_created"
                : "pending",
          corosSyncState: "synced",
          completionState: "scheduled",
          archivedAt: null,
          archiveReason: null,
          missingReads: 0,
          updatedAt: now,
        })
        .where(eq(plannedWorkouts.id, current.id));
      await replaceStages(db, current.id, src);
      stats.replacedRecycled += 1;
      continue;
    }

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

    // Completed history is immutable: when COROS reuses a slot for a NEW
    // same-sport workout (different date AND different content), rewriting a
    // completed row would silently turn last week's finished run into next
    // week's scheduled one while keeping its completion. Leave the history
    // alone; the recycled entity stays out of the app until the row ages out.
    if (
      (current.completionState === "completed" || current.completionState === "provisionally_completed") &&
      src.date !== current.lastVerifiedCorosDate &&
      src.contentFingerprint !== current.sourceContentFingerprint
    ) {
      stats.skippedForeignWorkouts += 1;
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
      updates.archiveReason = null;
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

    const action = reconcileWorkout({
      workoutId: current.id,
      effectiveDate: current.effectiveDate,
      lastVerifiedCorosDate: current.lastVerifiedCorosDate,
      observedDate: corosDate,
      openIntent: intentByWorkout.get(current.id) ?? null,
      pendingJob: pendingJob
        ? { id: pendingJob.id, destinationDate: pendingJob.destinationDate }
        : null,
    });

    switch (action.act) {
      case "verify_job": {
        if (action.jobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "verified", verifiedAt: now, completedAt: now, updatedAt: now })
            .where(eq(corosWriteJobs.id, action.jobId));
        }
        if (action.intentId) await resolveIntent(db, action.intentId, now);
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "synced";
        stats.verifiedJobs += 1;
        touched = true;
        break;
      }
      case "app_wins": {
        // Last-edit-wins, tie to the app (spec §2): the open intent is the
        // most recent thing the user did; COROS's displaced value becomes an
        // undo note, and emitPendingWork (run by the bridge/sync route right
        // after this import) re-derives the write against the new origin.
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "calendar_only"; // until the re-emit lands
        if (action.supersedeJobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: now })
            .where(eq(corosWriteJobs.id, action.supersedeJobId));
        }
        await postSyncNote(db, {
          userId: input.userId,
          workoutId: current.id,
          kind: "kept_local_change",
          payload: { displacedDate: action.note.displacedDate, keptDate: action.keepDate },
        });
        stats.conflicts += 1;
        touched = true;
        break;
      }
      case "adopt_coros": {
        updates.lastVerifiedCorosDate = corosDate;
        updates.effectiveDate = corosDate;
        updates.originalPlanDate = current.originalPlanDate;
        updates.calendarSyncState =
          current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
        updates.corosSyncState = "synced";
        if (current.completionState === "unresolved") updates.completionState = "scheduled";
        if (action.note) {
          await postSyncNote(db, {
            userId: input.userId,
            workoutId: current.id,
            kind: "adopted_coros_change",
            payload: { previousDate: action.note.previousDate, newDate: corosDate },
          });
        }
        stats.updatedDates += 1;
        touched = true;
        break;
      }
      case "none": {
        if (
          !pendingJob &&
          current.effectiveDate === corosDate &&
          (current.corosSyncState === "calendar_only" ||
            current.corosSyncState === "needs_attention" ||
            current.corosSyncState === "sync_issue")
        ) {
          // Healing: both sides provably agree; whatever flagged the row is over.
          updates.corosSyncState = "synced";
          const open = intentByWorkout.get(current.id);
          if (open && open.toDate === corosDate) await resolveIntent(db, open.id, now);
          touched = true;
        }
        break;
      }
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
        .set({ archivedAt: now, missingReads: reads, updatedAt: now, archiveReason: "absence_confirmed" })
        .where(eq(plannedWorkouts.id, w.id));
      await db.insert(calendarEventSuppressions).values({
        id: newId(),
        workoutId: w.id,
        eventId: null,
        reason: "workout_removed",
        createdAt: now,
      });
      stats.archivedMissing += 1;
      // If this row had shadowed a mirror copy, release the mirror so the
      // next snapshot's presence-healing can take over seamlessly.
      const partnerIds = existing
        .filter(
          (p) =>
            p.id !== w.id &&
            p.effectiveDate === w.effectiveDate &&
            p.title === w.title &&
            p.sport === w.sport,
        )
        .map((p) => p.id);
      if (partnerIds.length > 0) {
        await db
          .delete(calendarEventSuppressions)
          .where(
            and(
              inArray(calendarEventSuppressions.workoutId, partnerIds),
              eq(calendarEventSuppressions.reason, "duplicate_mirror"),
            ),
          );
      }
    } else {
      await db
        .update(plannedWorkouts)
        .set({ missingReads: reads, updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
    }
  }

  // ── Mirror de-duplication ──────────────────────────────────────────────────
  // COROS surfaces the applied plan twice: the plan definition AND its
  // materialized instances in a second plan (live-verified — the exact same
  // titles and dates under two plan ids). Whatever the wire says, the user
  // must see each session exactly once. Among active scheduled duplicates of
  // the same (date, title, sport), the oldest row keeps its history, links
  // and calendar event; newer copies are archived with a `duplicate_mirror`
  // suppression, which presence-healing respects until the keeper dies.
  const activeNow = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, input.userId), isNull(plannedWorkouts.archivedAt)));
  const byMirrorKey = new Map<string, typeof activeNow>();
  for (const w of activeNow) {
    const key = `${w.effectiveDate}|${w.title}|${w.sport}`;
    const list = byMirrorKey.get(key) ?? [];
    list.push(w);
    byMirrorKey.set(key, list);
  }
  // Resolution outranks scheduling: a completed/skipped/missed row is the
  // day's truth, and a scheduled mirror twin beside it is pure noise (it
  // would even re-ask "did this run happen?"). Among equals, oldest wins.
  const RESOLUTION_RANK: Record<string, number> = {
    completed: 0,
    provisionally_completed: 1,
    skipped: 2,
    missed: 3,
    unresolved: 4,
    scheduled: 5,
  };
  for (const copies of byMirrorKey.values()) {
    if (copies.length < 2) continue;
    // Only ever archive scheduled/unresolved copies — resolved rows carry
    // history and are never dedupe casualties.
    if (!copies.some((c) => c.completionState === "scheduled" || c.completionState === "unresolved")) {
      continue;
    }
    const sorted = [...copies].sort((a, b) => {
      const rank = (RESOLUTION_RANK[a.completionState] ?? 9) - (RESOLUTION_RANK[b.completionState] ?? 9);
      if (rank !== 0) return rank;
      return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
    });
    for (const dup of sorted.slice(1)) {
      if (dup.completionState !== "scheduled" && dup.completionState !== "unresolved") continue;
      await db
        .update(plannedWorkouts)
        .set({ archivedAt: now, updatedAt: now, archiveReason: "duplicate_mirror" })
        .where(eq(plannedWorkouts.id, dup.id));
      await db.insert(calendarEventSuppressions).values({
        id: newId(),
        workoutId: dup.id,
        eventId: null,
        reason: "duplicate_mirror",
        createdAt: now,
      });
      stats.dedupedMirrors += 1;
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
