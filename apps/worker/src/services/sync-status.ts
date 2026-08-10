import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  corosWriteJobs,
  desktopDevices,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
  syncRuns,
} from "@rg/database";
import type { UserPreferences } from "@rg/domain";
import { openMoveIntents } from "./sync-intents.js";
import type { Db } from "./db.js";

export const DEVICE_ONLINE_WINDOW_MS = 3 * 60_000;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;

export interface DevicePresence {
  registered: boolean;
  online: boolean;
  paused: boolean;
  writeCapable: boolean;
}

/** THE liveness computation — the only copy in the codebase. */
export async function devicePresence(db: Db, userId: string): Promise<DevicePresence> {
  const devices = await db
    .select()
    .from(desktopDevices)
    .where(and(eq(desktopDevices.userId, userId), isNull(desktopDevices.revokedAt)));
  const cutoff = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  return {
    registered: devices.length > 0,
    online: devices.some((d) => !d.bridgePaused && Date.parse(d.lastSeenAt) > cutoff),
    paused: devices.some((d) => d.bridgePaused),
    writeCapable: devices.some(
      (d) =>
        d.capabilities?.["updateExistingScheduledWorkout"] === true ||
        (d.capabilities?.["addScheduledWorkout"] === true &&
          d.capabilities?.["removeScheduledWorkout"] === true),
    ),
  };
}

export type SyncStatusState = "in_sync" | "syncing" | "waiting_for_mac" | "not_synced" | "sync_issue";

export interface SyncStatus {
  state: SyncStatusState;
  pendingCount: number;
  issueCount: number;
  lastCorosReadAt: string | null;
  paused: boolean;
  writesEnabled: boolean;
  registered: boolean;
}

export async function computeSyncStatus(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<SyncStatus> {
  const presence = await devicePresence(db, userId);

  const pending = await db
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
    );

  // Issues = terminal move failures the user can still retry (their intent is
  // open) + terminally failed studio rows. Archived workouts are excluded: a
  // failed job behind a workout that's been removed from the plan has
  // nothing left to retry, so it must never count toward issueCount.
  const failedJobs = await db
    .select({ workoutId: corosWriteJobs.workoutId })
    .from(corosWriteJobs)
    .innerJoin(plannedWorkouts, eq(corosWriteJobs.workoutId, plannedWorkouts.id))
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "failed"),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  const openIntentTargets = new Set((await openMoveIntents(db, userId)).map((i) => i.targetId));
  const failedMoveCount = new Set(
    failedJobs.map((j) => j.workoutId).filter((id) => openIntentTargets.has(id)),
  ).size;
  // Scoped to the NEWEST studio plan — the same predicate POST /api/sync/retry
  // acts on. Counting retired plans' failed rows (usually failed deletes)
  // inflates a badge the Retry button can never clear, the exact misleading
  // no-op C15 was fixed to remove.
  const currentStudioPlan = (
    await db
      .select({ id: studioPlans.id })
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
      .orderBy(desc(studioPlans.createdAt))
      .limit(1)
  )[0];
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
  const issueCount = failedMoveCount + failedStudio.length;

  const lastRead = (
    await db
      .select({ finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, "coros_read"), eq(syncRuns.status, "ok"), eq(syncRuns.userId, userId)))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1)
  )[0];

  const state: SyncStatusState =
    !prefs.corosWritesEnabled || !presence.writeCapable
      ? "not_synced"
      : issueCount > 0
        ? "sync_issue"
        : pending.length > 0
          ? presence.online
            ? "syncing"
            : "waiting_for_mac"
          : "in_sync";

  return {
    state,
    pendingCount: pending.length,
    issueCount,
    lastCorosReadAt: lastRead?.finishedAt ?? null,
    paused: presence.paused,
    writesEnabled: prefs.corosWritesEnabled,
    registered: presence.registered,
  };
}

/**
 * Per-workout view, in the LEGACY CorosSyncState vocabulary so CorosPill and
 * COROS_SYNC_LABELS keep working unchanged (the line-level SyncStatusState is
 * a separate type with its own five values).
 */
export function deriveWorkoutSync(v: {
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  hasOpenIntent: boolean;
  hasPendingJob: boolean;
  hasFailedJob: boolean;
  presence: DevicePresence;
  writesEnabled: boolean;
}): "synced" | "syncing" | "waiting_for_device" | "calendar_only" | "sync_issue" {
  if (v.effectiveDate === v.lastVerifiedCorosDate && !v.hasPendingJob) return "synced";
  if (v.hasPendingJob) return v.presence.online ? "syncing" : "waiting_for_device";
  if (v.hasFailedJob) return "sync_issue";
  return "calendar_only";
}
