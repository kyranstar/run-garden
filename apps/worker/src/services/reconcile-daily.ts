import { and, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { calendarEventSuppressions, plannedWorkouts, syncErrors, syncRuns } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";

/**
 * Daily reconciliation of completion states:
 *  - A workout becomes `unresolved` ("Did this run happen?") only after its
 *    effective window passed AND a sync grace period elapsed — a slow COROS or
 *    COROS sync must never be misread as a missed run.
 *  - Long-unresolved workouts eventually become `missed` (affecting the
 *    garden), still reversible by a later match.
 */

const SYNC_GRACE_DAYS = 1; // window passes → wait one full day before asking
const AUTO_MISS_DAYS = 7; // unresolved this long → counts as missed

export interface ReconcileStats {
  markedUnresolved: number;
  autoMissed: number;
}

export async function reconcileCompletionStates(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date = new Date(),
): Promise<ReconcileStats> {
  const nowIso = nowInstant(now);
  const today = todayInZone(prefs.timezone, now);
  const stats: ReconcileStats = { markedUnresolved: 0, autoMissed: 0 };

  // Rest-mode pauses the entire missed-workout pipeline.
  if (prefs.gardenRestMode && (!prefs.gardenRestModeUntil || prefs.gardenRestModeUntil >= today)) {
    return stats;
  }

  // scheduled → unresolved once effectiveDate < today - grace.
  const unresolvedCutoff = addDays(today, -SYNC_GRACE_DAYS);
  const toAsk = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "scheduled"),
        lt(plannedWorkouts.effectiveDate, unresolvedCutoff),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  for (const w of toAsk) {
    if (w.category === "rest") continue;
    // The user said "not yet" — honor it until the snooze lapses.
    if (w.snoozedUntil && w.snoozedUntil > today) continue;
    await db
      .update(plannedWorkouts)
      .set({ completionState: "unresolved", updatedAt: nowIso })
      .where(eq(plannedWorkouts.id, w.id));
    stats.markedUnresolved += 1;
  }

  // unresolved → missed after a week without an answer or a match.
  const missCutoff = addDays(today, -AUTO_MISS_DAYS);
  const toMiss = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "unresolved"),
        lte(plannedWorkouts.effectiveDate, missCutoff),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  for (const w of toMiss) {
    await db
      .update(plannedWorkouts)
      .set({ completionState: "missed", resolutionDate: today, updatedAt: nowIso })
      .where(eq(plannedWorkouts.id, w.id));
    stats.autoMissed += 1;
  }

  return stats;
}

// ── Observability helpers ────────────────────────────────────────────────────

export async function startSyncRun(
  db: Db,
  kind: string,
  userId?: string,
  deviceId?: string,
): Promise<string> {
  const id = newId();
  await db.insert(syncRuns).values({
    id,
    userId: userId ?? null,
    kind,
    deviceId: deviceId ?? null,
    startedAt: nowInstant(),
    status: "running",
  });
  return id;
}

/** Delete workout_removed calendar suppressions whose workout is alive and
 * scheduled (audit#2 #4): the workout's presence proves the removal wrong,
 * and an immortal suppression silently bars it from Google Calendar forever. */
export async function sweepStaleSuppressions(db: Db): Promise<number> {
  const stale = await db
    .select({ id: calendarEventSuppressions.id })
    .from(calendarEventSuppressions)
    .innerJoin(plannedWorkouts, eq(calendarEventSuppressions.workoutId, plannedWorkouts.id))
    .where(
      and(
        eq(calendarEventSuppressions.reason, "workout_removed"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
      ),
    );
  for (const r of stale) {
    await db.delete(calendarEventSuppressions).where(eq(calendarEventSuppressions.id, r.id));
  }
  return stale.length;
}

/** Close out sync_runs stranded in 'running' by a deploy or isolate death
 * (audit finding 16): 16 such rows sat forever with no sweeper. Two hours is
 * far beyond any legitimate run. */
export async function closeStrandedSyncRuns(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const stranded = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "running"), lt(syncRuns.startedAt, cutoff)));
  for (const r of stranded) {
    await db
      .update(syncRuns)
      .set({ status: "error", finishedAt: nowInstant(), stats: { interrupted: true } })
      .where(eq(syncRuns.id, r.id));
  }
  return stranded.length;
}

export async function finishSyncRun(
  db: Db,
  id: string,
  status: "ok" | "error" | "partial",
  stats?: Record<string, unknown>,
): Promise<void> {
  await db
    .update(syncRuns)
    .set({ finishedAt: nowInstant(), status, stats: stats ?? null })
    .where(eq(syncRuns.id, id));
}

export async function recordSyncError(
  db: Db,
  input: {
    syncRunId?: string;
    userId?: string;
    provider?: string;
    operation?: string;
    category: string;
    message?: string;
  },
): Promise<void> {
  await db.insert(syncErrors).values({
    id: newId(),
    syncRunId: input.syncRunId ?? null,
    userId: input.userId ?? null,
    provider: input.provider ?? null,
    operation: input.operation ?? null,
    category: input.category,
    // Sanitized: never raw payloads, tokens, or credentials.
    message: input.message?.slice(0, 300) ?? null,
    createdAt: nowInstant(),
  });
  console.log(
    JSON.stringify({
      level: "error",
      syncRunId: input.syncRunId,
      provider: input.provider,
      operation: input.operation,
      category: input.category,
    }),
  );
}
