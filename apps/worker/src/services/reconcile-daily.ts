import { and, asc, eq, inArray, isNull, lt, lte, ne, notExists, or, type SQL } from "drizzle-orm";
import { calendarEventSuppressions, performedSessions, plannedWorkouts, syncErrors, syncRuns } from "@rg/database";
import { addDays, DOC_ORIGINS, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { PLAYED_OFFLINE_CALENDAR_STATE, PLAYED_OFFLINE_DAYS_BACK, START_NOW_CALENDAR_STATE, STARTED_AT_ONCE_STATES } from "./doc-workouts.js";
import { plannedRowColumns } from "./planned-columns.js";
import { removeFromPlan } from "./plan-mutations.js";

/**
 * Daily reconciliation of completion states:
 *  - A workout becomes `unresolved` ("Did this run happen?") only after its
 *    effective window passed AND a sync grace period elapsed — a slow COROS or
 *    COROS sync must never be misread as a missed run.
 *  - Long-unresolved workouts eventually become `missed` (affecting the
 *    garden), still reversible by a later match.
 *  - A workout started at once (Start now) and closed without Discard, its
 *    day ended with nothing logged, was never planned: it is removed as the
 *    player's Discard removes it, never asked about and never missed. One
 *    played offline and recorded on reconnect (R11) is made after its day:
 *    it is removed only once the outbox has had its reach (a week) to deliver its session.
 */

const SYNC_GRACE_DAYS = 1; // window passes → wait one full day before asking
/**
 * A workout played offline, left with no session, is kept this long after it was recorded: the outbox's reach (a save
 * may follow its create by days — the network gone again — and must still find its row; fix round 1).
 */
export const PLAYED_OFFLINE_GRACE_MS = PLAYED_OFFLINE_DAYS_BACK * 24 * 60 * 60 * 1000;
/** Unresolved this long → counts as missed. The garden reads it too: a slot completed only by an activity the garden
 * does not see is, to the garden, still open, and misses this many days after its day (garden-sync, Audit 2d I-2). */
export const AUTO_MISS_DAYS = 7;

export interface ReconcileStats {
  markedUnresolved: number;
  autoMissed: number;
  /** Start-now workouts left with nothing logged, removed once their day ended. */
  abandonedRemoved: number;
}

/**
 * Start-now workouts removed per account per pass: a removal is a handful of statements (`removeFromPlan`), and there
 * is rarely more than one. The rest wait for the next pass; none is asked about meanwhile (the question skips them).
 */
const ABANDONED_START_NOW_MAX = 2;

/**
 * A workout started at once and left with nothing logged, as the player's Discard judges it (`removeAbandonedStartNow`):
 * booked on no calendar (Start now's state, which a move to a day of the plan's ends), not done, not answered
 * (completed, skipped, missed), no session saved for it. One played offline only once it was recorded before
 * `recordedBefore` (the outbox's reach to deliver).
 */
function abandonedStartNow(db: Db, recordedBefore: string): SQL {
  const pw = plannedWorkouts;
  return and(
    or(
      eq(pw.calendarSyncState, START_NOW_CALENDAR_STATE),
      and(eq(pw.calendarSyncState, PLAYED_OFFLINE_CALENDAR_STATE), lt(pw.createdAt, recordedBefore)),
    ),
    inArray(pw.origin, [...DOC_ORIGINS]),
    inArray(pw.completionState, ["scheduled", "unresolved"]),
    or(isNull(pw.contentState), ne(pw.contentState, "done")),
    notExists(db.select({ id: performedSessions.id }).from(performedSessions).where(eq(performedSessions.workoutId, pw.id))),
  )!;
}

export async function reconcileCompletionStates(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date = new Date(),
): Promise<ReconcileStats> {
  const nowIso = nowInstant(now);
  const today = todayInZone(prefs.timezone, now);
  const stats: ReconcileStats = { markedUnresolved: 0, autoMissed: 0, abandonedRemoved: 0 };
  const recordedBefore = new Date(now.getTime() - PLAYED_OFFLINE_GRACE_MS).toISOString();

  // Start now, left with nothing logged, its day ended: removed as Discard removes it (calendar, watch work), only
  // while it is still so as it is archived. Not the missed pipeline: rest mode does not pause it.
  const abandoned = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId), lt(plannedWorkouts.effectiveDate, today), isNull(plannedWorkouts.archivedAt), abandonedStartNow(db, recordedBefore)))
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.id))
    .limit(ABANDONED_START_NOW_MAX);
  for (const w of abandoned) {
    const removed = await removeFromPlan(db, userId, w.id, { now: nowIso, source: "auto_resolve", prefs, onlyIf: abandonedStartNow(db, recordedBefore) });
    if (removed.removed) stats.abandonedRemoved += 1;
  }

  // Rest-mode pauses the entire missed-workout pipeline.
  if (prefs.gardenRestMode && (!prefs.gardenRestModeUntil || prefs.gardenRestModeUntil >= today)) {
    return stats;
  }

  // scheduled → unresolved once effectiveDate < today - grace.
  const unresolvedCutoff = addDays(today, -SYNC_GRACE_DAYS);
  const toAsk = await db
    .select(plannedRowColumns())
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
    // Started at once, never planned: never asked about (removed above, or by the next pass).
    if (STARTED_AT_ONCE_STATES.includes(w.calendarSyncState)) continue;
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
    .select(plannedRowColumns())
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
