import { and, eq } from "drizzle-orm";
import { calendarEventSuppressions, corosWriteJobs, plannedWorkouts } from "@rg/database";
import { newId, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { recordedStampFor } from "./coros-stamp.js";
import { watchAddressOf } from "./coach-apply.js";
import { openIntentFor, recordIntent, resolveIntent, type IntentSource } from "./sync-intents.js";

/**
 * The athlete's own plan mutations, as services — so the coach's ops and the
 * manual routes cannot drift apart on side effects (suppression, intent
 * ledger, unpush). Routes add their own calendar sync / resimulation.
 */

export interface RemoveResult {
  removed: boolean;
  effectiveDate: string | null;
}

/**
 * Remove a workout from the plan: archived locally, calendar event suppressed.
 * Never touches the COROS calendar — for COROS-sourced workouts the archived
 * row keeps its sourceWorkoutId, so future imports update it in place without
 * resurrecting it into the visible plan. No-op (removed: false) for a missing,
 * foreign or already-archived row.
 */
export async function removeFromPlan(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { now: string; source: IntentSource },
): Promise<RemoveResult> {
  const [w] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!w || w.archivedAt) return { removed: false, effectiveDate: null };
  const { now } = opts;
  await db
    .update(plannedWorkouts)
    .set({ archivedAt: now, updatedAt: now, archiveReason: "user_removed" })
    .where(eq(plannedWorkouts.id, w.id));
  await db.insert(calendarEventSuppressions).values({
    id: newId(),
    workoutId: w.id,
    eventId: null,
    // "user_removed" (not the absence-detector's "workout_removed"): a hand
    // removal is a decision, and import's presence-healing must never undo it.
    reason: "user_removed",
    createdAt: now,
  });
  await recordIntent(db, {
    userId,
    targetKind: "workout",
    targetId: w.id,
    kind: "remove_local",
    source: opts.source,
  });
  // Close out any open move intent for this workout too — once it's removed
  // from the plan there's nothing left to sync, and leaving the move intent
  // open behind an archived workout would strand a permanent, uncloseable
  // sync_issue (emitPendingWork resolves it too, but this closes the gap
  // immediately rather than waiting for the next bridge sync).
  const openMove = await openIntentFor(db, userId, w.id, "move");
  if (openMove) await resolveIntent(db, openMove.id, now);
  return { removed: true, effectiveDate: w.effectiveDate };
}

/**
 * The unpush half of an archive: verified watch-pushed sessions get a delete
 * job so the watch stops scheduling the retired session.
 */
export async function enqueueUnpushIfOurs(
  db: Db,
  userId: string,
  w: typeof plannedWorkouts.$inferSelect,
  now: string,
  prefs: UserPreferences,
): Promise<void> {
  if (!prefs.corosWritesEnabled) return;
  // ADDRESS, NOT SYNC STATE. This gate used to read `corosSyncState !==
  // "synced"`, and that column is not a statement about whether COROS holds
  // the row — it is a statement about whether the two agree. An eased session
  // is `calendar_only` (correctly: COROS has the OLD body) while still sitting
  // on the athlete's watch, so archiving one skipped the unpush and left the
  // pre-ease intervals scheduled on the watch permanently, inside the very
  // code path that exists to stop exactly that (audit#3 D2). `content_stale`
  // and `sync_issue` had the same hole. The address is the durable fact.
  const address = watchAddressOf(w);
  if (!address) return;
  // The delete triple's stamp is the exact program name we last wrote, which
  // is never persisted on the row — read it back off this account's own
  // settled write jobs (a rewrite renames, so the newest one wins).
  const stamp = await recordedStampFor(db, userId, w.id);
  if (!stamp) return;
  const [createJob] = await db
    .select({ expectedContentFingerprint: corosWriteJobs.expectedContentFingerprint })
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.id, `${w.id}-push`))
    .limit(1);
  await db
    .insert(corosWriteJobs)
    .values({
      id: `${w.id}-unpush`,
      userId,
      workoutId: w.id,
      kind: "coach_delete_workout",
      expectedContentFingerprint: createJob?.expectedContentFingerprint ?? "",
      originalDate: w.effectiveDate,
      destinationDate: w.effectiveDate,
      payload: {
        workoutId: w.id,
        happenDay: address.happenDay,
        name: stamp,
        idInPlan: address.idInPlan,
        programId: address.programId,
        corosPlanId: address.corosPlanId,
      },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    })
    .onConflictDoNothing();
}
