import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  auditEvents,
  calendarEventSuppressions,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
} from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { recordIntent } from "./sync-intents.js";
import type { Db } from "./db.js";

/**
 * One-shot migration of pre-ledger sync state (spec §1 "Migration & healing").
 * Idempotent: guarded by an audit marker. Runs from the hourly cron so prod
 * heals itself without a wrangler-side write (prod D1 writes via wrangler are
 * classifier-blocked).
 */
export async function healLegacySyncState(db: Db, userId: string): Promise<{ healed: boolean }> {
  const marker = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, "sync_ledger_migrated")))
    .limit(1);
  if (marker.length > 0) return { healed: false };
  const now = nowInstant();

  // 1. Falsely-drifted studio rows rejoin management as adoptions (their undo
  //    path then works like any other adopted row).
  const planIds = (
    await db.select({ id: studioPlans.id }).from(studioPlans).where(eq(studioPlans.userId, userId))
  ).map((p) => p.id);
  if (planIds.length > 0) {
    await db
      .update(studioPlanPushes)
      .set({ status: "adopted", error: null, updatedAt: now })
      .where(
        and(inArray(studioPlanPushes.planId, planIds), eq(studioPlanPushes.error, "changed_on_coros")),
      );
  }

  // 2. needs_attention rows whose dates already agree are provably fine.
  const flagged = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        inArray(plannedWorkouts.corosSyncState, ["needs_attention", "calendar_only"]),
      ),
    );
  for (const w of flagged) {
    if (w.effectiveDate === w.lastVerifiedCorosDate) {
      await db
        .update(plannedWorkouts)
        .set({ corosSyncState: "synced", updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
    } else if (!w.archivedAt) {
      // 3. A real local-vs-COROS date gap becomes an open intent the
      //    reconciler will emit for when writing is possible.
      await recordIntent(db, {
        userId,
        targetKind: "workout",
        targetId: w.id,
        kind: "move",
        payload: { toDate: w.effectiveDate, toTime: w.effectiveTime, fromDate: w.lastVerifiedCorosDate },
        source: "auto_resolve",
      });
    }
  }

  // 4. archiveReason backfill.
  const archived = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        isNotNull(plannedWorkouts.archivedAt),
        isNull(plannedWorkouts.archiveReason),
      ),
    );
  const suppressions = await db.select().from(calendarEventSuppressions);
  const reasonByWorkout = new Map<string, string>();
  for (const s of suppressions) {
    if (s.reason === "user_removed" || s.reason === "duplicate_mirror") {
      reasonByWorkout.set(s.workoutId, s.reason);
    }
  }
  for (const w of archived) {
    // With no suppression evidence, absence is the only safe default.
    const reason = reasonByWorkout.get(w.id) ?? "absence_confirmed";
    await db
      .update(plannedWorkouts)
      .set({ archiveReason: reason, updatedAt: now })
      .where(eq(plannedWorkouts.id, w.id));
  }

  await db.insert(auditEvents).values({
    id: newId(),
    userId,
    kind: "sync_ledger_migrated",
    detail: { flagged: flagged.length, archivedBackfilled: archived.length },
    createdAt: now,
  });
  return { healed: true };
}
