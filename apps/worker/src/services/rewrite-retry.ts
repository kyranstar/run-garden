import { and, eq, inArray, isNull } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts } from "@rg/database";
import { appAuthoredRow } from "@rg/domain";
import type { Db } from "./db.js";

/**
 * THE BANNER'S RETRY RE-RUNS A FAILED CONTENT REWRITE (2026-10-10).
 *
 * A failed `coach_update_workout` counts in the "N changes couldn't sync" banner (`computeSyncStatus`), and the
 * banner's Retry (`POST /api/sync/retry`) re-armed failed MOVES and studio pushes only — so a rewrite that failed was
 * a badge no tap could clear. Live, that was the owner's Oct 14 strength session: the rewrite landed and the
 * read-after-write misjudged COROS's own ids and figures as a difference (normalize.ts `describeProgramDelta`). A
 * re-run re-proves ownership, rewrites in place and verifies against what COROS stores.
 *
 * Revived — back to `queued`, its attempts and error cleared — only when it is the session's STANDING word:
 *  · the newest coach watch write for the session (create, rewrite or unpush). An older rewrite a later one
 *    replaced would put superseded content back on the watch, and one behind an unpush would rewrite a copy the app
 *    took off it;
 *  · a session still ahead: not archived, scheduled, today or later. A past session's watch copy is history (the
 *    convergence backfill's rule), and the app never writes to it;
 *  · not an app-built row (ruling 3-R13: only Send and Take off write those; the lane would supersede it anyway).
 *
 * Only queues: the lane (the client's drain, or the hourly run) executes it. Answers how many were revived.
 */
export async function reviveFailedRewrites(db: Db, userId: string, opts: { today: string; now: string }): Promise<number> {
  const rows = await db
    .select({
      id: corosWriteJobs.id,
      kind: corosWriteJobs.kind,
      status: corosWriteJobs.status,
      requestedAt: corosWriteJobs.requestedAt,
      payload: corosWriteJobs.payload,
      workout: {
        id: plannedWorkouts.id,
        origin: plannedWorkouts.origin,
        effectiveDate: plannedWorkouts.effectiveDate,
        completionState: plannedWorkouts.completionState,
      },
    })
    .from(corosWriteJobs)
    .innerJoin(plannedWorkouts, eq(corosWriteJobs.workoutId, plannedWorkouts.id))
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, ["coach_create_workout", "coach_update_workout", "coach_delete_workout"]),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = newest.get(r.workout.id);
    if (!prev || r.requestedAt > prev.requestedAt) newest.set(r.workout.id, r);
  }
  let revived = 0;
  for (const r of newest.values()) {
    if (r.kind !== "coach_update_workout" || r.status !== "failed") continue;
    const w = r.workout;
    if (w.completionState !== "scheduled" || w.effectiveDate < opts.today || appAuthoredRow(w)) continue;
    const { attempts: _attempts, ...payload } = (r.payload ?? {}) as Record<string, unknown>;
    await db
      .update(corosWriteJobs)
      .set({
        status: "queued",
        claimedByDeviceId: null,
        claimedAt: null,
        lastErrorCategory: null,
        lastErrorDetail: null,
        completedAt: null,
        payload,
        requestedAt: opts.now,
        updatedAt: opts.now,
      })
      .where(and(eq(corosWriteJobs.id, r.id), eq(corosWriteJobs.status, "failed")));
    revived += 1;
  }
  return revived;
}
