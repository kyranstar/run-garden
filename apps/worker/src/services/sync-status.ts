import { and, desc, eq, gte, inArray, isNull, ne, notInArray } from "drizzle-orm";
import {
  corosWriteJobs,
  plannedWorkouts,
  providerConnections,
  studioPlanPushes,
  studioPlans,
} from "@rg/database";
import { todayInZone, type LocalDate, type UserPreferences, type WorkoutSyncView } from "@rg/domain";
import { openContentIntentTargets, openMoveIntents } from "./sync-intents.js";
import type { Db } from "./db.js";

/** Legacy constant — last consumers (device routes) die in Phase C Task 4. */
export const DEVICE_ONLINE_WINDOW_MS = 3 * 60_000;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;

export interface CloudPresence {
  registered: boolean;
  online: boolean;
  writeCapable: boolean;
}

/** THE liveness computation — the only copy in the codebase. The COROS
 * cloud connection IS the executor: connected means the worker itself can
 * read and write, so online and write-capable are the same fact. */
export async function cloudPresence(db: Db, userId: string): Promise<CloudPresence> {
  const [row] = await db
    .select({ status: providerConnections.status })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  const online = row?.status === "connected";
  return { registered: online, online, writeCapable: online };
}

/** A session the athlete has settled: its watch copy is history, not a job. */
const RESOLVED_COMPLETION_STATES = ["completed", "missed", "skipped"] as const;

export interface OpenFailedCoachWrite {
  id: string;
  workoutId: string;
  requestedAt: string;
}

/**
 * THE FAILED COACH WRITES THAT ARE STILL AN ISSUE — what the banner's
 * `issueCount` counts and exactly what POST /api/sync/retry revives. One
 * function, so the number on the screen and the thing Retry does cannot drift.
 *
 * A terminally failed `coach_create_workout` / `coach_update_workout` counts
 * only while ALL of these hold:
 *
 *  · its session is live (not archived);
 *  · nothing newer for the same session verified since — job ids are
 *    content-derived, so converging a session mints a new id and the old
 *    attempt's row stays `failed` for ever (2026-08-18: "1 change couldn't
 *    sync" about a watch already correct, the misleading no-op C15 removed);
 *  · its session can still be WRITTEN: dated the athlete's today or later, in
 *    their timezone, and not completed, missed or skipped.
 *
 * The last is the 2026-10-09 owner report. Four coach writes failed
 * `verification_failed` on 2026-09-19..21 for sessions on 09-22, 09-23, 09-23
 * and 09-30; weeks later all four were past and missed, none archived, nothing
 * newer verified — and "4 changes couldn't sync" stood for ever. A past
 * session's watch copy can never be rewritten and Retry has nothing to do for
 * it, so it is not an issue; the same reasoning `openContentIntentTargets(…,
 * { excludeCompleted: true })` applies to a finished session's stale copy.
 */
export async function openFailedCoachWrites(
  db: Db,
  userId: string,
  today: LocalDate,
): Promise<OpenFailedCoachWrite[]> {
  const kinds = ["coach_create_workout", "coach_update_workout"];
  const [failed, verified] = await Promise.all([
    db
      .select({ id: corosWriteJobs.id, workoutId: corosWriteJobs.workoutId, requestedAt: corosWriteJobs.requestedAt })
      .from(corosWriteJobs)
      .innerJoin(plannedWorkouts, eq(corosWriteJobs.workoutId, plannedWorkouts.id))
      .where(
        and(
          eq(corosWriteJobs.userId, userId),
          inArray(corosWriteJobs.kind, kinds),
          eq(corosWriteJobs.status, "failed"),
          isNull(plannedWorkouts.archivedAt),
          gte(plannedWorkouts.effectiveDate, today),
          notInArray(plannedWorkouts.completionState, [...RESOLVED_COMPLETION_STATES]),
        ),
      ),
    db
      .select({ workoutId: corosWriteJobs.workoutId, requestedAt: corosWriteJobs.requestedAt })
      .from(corosWriteJobs)
      .where(
        and(
          eq(corosWriteJobs.userId, userId),
          inArray(corosWriteJobs.kind, kinds),
          eq(corosWriteJobs.status, "verified"),
        ),
      ),
  ]);
  const settledAfter = new Map<string, string>();
  for (const j of verified) {
    const prev = settledAfter.get(j.workoutId);
    if (prev === undefined || j.requestedAt > prev) settledAfter.set(j.workoutId, j.requestedAt);
  }
  return failed.filter((j) => {
    const newerSuccess = settledAfter.get(j.workoutId);
    return newerSuccess === undefined || newerSuccess < j.requestedAt;
  });
}

export type SyncStatusState = "in_sync" | "syncing" | "not_synced" | "sync_issue";

export interface SyncStatus {
  state: SyncStatusState;
  pendingCount: number;
  issueCount: number;
  /**
   * Sessions whose content Run Garden has rewritten and COROS has not been given
   * yet (open `content` intents). NOT folded into `issueCount`, still: an issue
   * is something the Retry button acts on, and the rows left in this state are
   * the ones no rewrite can reach — a session that was never on the watch, or one
   * whose new content cannot cross the wire. A rewrite that CAN happen closes its
   * intent on verify (`coach_update_workout`), so this count no longer includes
   * divergences that are merely in flight; those are `pendingCount`.
   */
  contentStaleCount: number;
  lastCorosReadAt: string | null;
  writesEnabled: boolean;
  registered: boolean;
}

export async function computeSyncStatus(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<SyncStatus> {
  // Polled every 30s from a worker that can sit cross-region from D1: every
  // sequential await here is a full round trip. All seven reads below are
  // independent of one another (only failedStudio, in the second wave,
  // depends on a result), so they go out as one Promise.all wave.
  const [
    presence,
    pending,
    failedJobs,
    openIntents,
    contentStaleTargets,
    failedCoachWrites,
    studioPlanRows,
    corosConnRows,
  ] =
    await Promise.all([
      cloudPresence(db, userId),
      db
        .select({ id: corosWriteJobs.id })
        .from(corosWriteJobs)
        .where(
          and(
            eq(corosWriteJobs.userId, userId),
            inArray(corosWriteJobs.status, [...IN_FLIGHT]),
            // A queued read_now job is the bridge's own catch-up read, not a
            // user-visible "change" — the bridge-side claim pendingCount
            // (devices.ts) keeps counting it since it drives adaptive polling.
            ne(corosWriteJobs.kind, "read_now"),
          ),
        ),
      // Issues = terminal move failures the user can still retry (their intent
      // is open) + terminally failed studio rows. Archived workouts are
      // excluded: a failed job behind a workout that's been removed from the
      // plan has nothing left to retry, so it must never count toward
      // issueCount.
      db
        .select({ workoutId: corosWriteJobs.workoutId })
        .from(corosWriteJobs)
        .innerJoin(plannedWorkouts, eq(corosWriteJobs.workoutId, plannedWorkouts.id))
        .where(
          and(
            eq(corosWriteJobs.userId, userId),
            eq(corosWriteJobs.status, "failed"),
            isNull(plannedWorkouts.archivedAt),
          ),
        ),
      openMoveIntents(db, userId),
      // The one divergence this line CAN detect that isn't a job: an approved
      // ease rewrote a session COROS still holds in its old form.
      // Completed sessions excluded: their watch copy is history, and counting
      // one made the status line hand the athlete a job about a run they had
      // already finished.
      openContentIntentTargets(db, userId, { excludeCompleted: true }),
      // A terminally-failed coach watch-push is an issue the user can see and
      // act on (audit#2 #6) — it has no move intent, so count it directly.
      // A failed CONTENT REWRITE counts the same way and for the same reason:
      // the athlete's watch is holding a session the app has replaced, the
      // failure is terminal, and it is exactly the divergence they complained
      // about. Leaving it out would have made the one kind that closes that gap
      // the one kind whose failure was silent. Only while the session can still
      // be written, and not once a later write superseded it — see
      // `openFailedCoachWrites`, which POST /api/sync/retry acts on too.
      openFailedCoachWrites(db, userId, todayInZone(prefs.timezone)),
      // Scoped to the NEWEST studio plan — the same predicate POST
      // /api/sync/retry acts on. Counting retired plans' failed rows (usually
      // failed deletes) inflates a badge the Retry button can never clear,
      // the exact misleading no-op C15 was fixed to remove.
      db
        .select({ id: studioPlans.id })
        .from(studioPlans)
        .where(eq(studioPlans.userId, userId))
        .orderBy(desc(studioPlans.createdAt))
        .limit(1),
      // The honest freshness is the connection's own lastSyncAt, stamped by
      // every successful pull (audit finding 11). sync_runs kind='coros_read'
      // (the half-hourly sweep's run row, cron reliability part 3) records
      // that the sweep ran and what it did, not that a pull succeeded.
      db
        .select({ lastSyncAt: providerConnections.lastSyncAt })
        .from(providerConnections)
        .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
        .limit(1),
    ]);

  const openIntentTargets = new Set(openIntents.map((i) => i.targetId));
  const failedMoveCount = new Set(
    failedJobs.map((j) => j.workoutId).filter((id) => openIntentTargets.has(id)),
  ).size;
  const failedCoachCreates = failedCoachWrites.length;
  const currentStudioPlan = studioPlanRows[0];
  const [corosConn] = corosConnRows;

  const failedStudio = currentStudioPlan
    ? await db
        .select({ id: studioPlanPushes.id })
        .from(studioPlanPushes)
        .where(
          and(
            eq(studioPlanPushes.planId, currentStudioPlan.id),
            eq(studioPlanPushes.status, "failed"),
          ),
        )
    : [];
  const issueCount = failedMoveCount + failedStudio.length + failedCoachCreates;

  const state: SyncStatusState =
    !prefs.corosWritesEnabled || !presence.writeCapable
      ? "not_synced"
      : issueCount > 0
        ? "sync_issue"
        : pending.length > 0
          ? "syncing"
          : "in_sync";

  return {
    state,
    pendingCount: pending.length,
    issueCount,
    contentStaleCount: contentStaleTargets.size,
    lastCorosReadAt: corosConn?.lastSyncAt ?? null,
    writesEnabled: prefs.corosWritesEnabled,
    registered: presence.registered,
  };
}

/**
 * Per-workout view, in the CorosSyncState vocabulary CorosPill already speaks
 * plus the one value only a derivation can produce (`WorkoutSyncView`). The
 * line-level `SyncStatusState` is a separate type with its own four values.
 *
 * THIS USED TO BE A DATE COMPARISON AND NOTHING ELSE. `effectiveDate ===
 * lastVerifiedCorosDate && !pending` returned "synced", which meant it had no
 * opinion whatsoever about the session's CONTENT — and it took a
 * `hasOpenIntent` argument it never read, so the shape of the fix was already
 * in the signature.
 *
 * That mattered because easing a pushed session changes content and nothing
 * else: the date does not move, there is no COROS job kind that writes
 * content, so no job is enqueued, nothing is pending and nothing has failed.
 * The pill read "synced", `hideWhenHealthy` then hid it, and the session
 * sheet's banner was gated on the same date comparison so it did not render
 * either. Zero indicators, and an athlete who had been told their calf-sparing
 * 30 minutes was on their watch arrived at 5×3min at threshold.
 *
 * The signal was already recorded: `ease` writes an open `content` intent
 * (sync-intents.ts), designed never to resolve, because nothing on COROS can
 * ever confirm it. So the states now mean, in words:
 *
 *   · `synced`             — COROS has this session, on this day, as written.
 *   · `content_stale`      — COROS has it on the right day, but the version
 *                            there is the one Run Garden replaced.
 *   · `calendar_only`      — Run Garden and Calendar have a change COROS
 *                            does not; nothing is on its way.
 *   · `syncing` / `waiting_for_device` — a write is queued, running or
 *                            waiting on the COROS connection.
 *   · `sync_issue`         — the last write failed and can be retried.
 *
 * The date comparison keeps its precedence over content: a session that is on
 * the WRONG DAY on the watch is told about as a wrong day, because that is the
 * fact the athlete acts on. (A session that is both moved and eased therefore
 * reads `calendar_only` — the loudest true thing — and the sheet's banner
 * names the date. See the report: this is a deliberate single-valued pill, not
 * an oversight.)
 */
export function deriveWorkoutSync(v: {
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  /** An open `content` intent: an approved ease rewrote this session after
   * COROS was last given it. Never resolves — COROS cannot confirm content. */
  hasOpenContentIntent: boolean;
  hasPendingJob: boolean;
  hasFailedJob: boolean;
  presence: CloudPresence;
  writesEnabled: boolean;
}): WorkoutSyncView {
  if (v.effectiveDate === v.lastVerifiedCorosDate && !v.hasPendingJob) {
    return v.hasOpenContentIntent ? "content_stale" : "synced";
  }
  // "waiting_for_device" survives in the legacy per-workout vocabulary (the
  // CorosPill labels key on it) but now means "no cloud connection to run it".
  if (v.hasPendingJob) return v.presence.online ? "syncing" : "waiting_for_device";
  if (v.hasFailedJob) return "sync_issue";
  return "calendar_only";
}
