import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  corosWriteJobs,
  desktopDevices,
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
    .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.status, [...IN_FLIGHT])));

  // Issues = terminal move failures the user can still retry (their intent is
  // open) + terminally failed studio rows.
  const failedJobs = await db
    .select({ workoutId: corosWriteJobs.workoutId })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.status, "failed")));
  const openIntentTargets = new Set((await openMoveIntents(db, userId)).map((i) => i.targetId));
  const failedMoveCount = new Set(
    failedJobs.map((j) => j.workoutId).filter((id) => openIntentTargets.has(id)),
  ).size;
  const failedStudio = await db
    .select({ id: studioPlanPushes.id })
    .from(studioPlanPushes)
    .innerJoin(studioPlans, eq(studioPlanPushes.planId, studioPlans.id))
    .where(and(eq(studioPlans.userId, userId), eq(studioPlanPushes.status, "failed")));
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
