/**
 * PUT THE SESSIONS ON THE WATCH THAT NEVER GOT THERE.
 *
 * The gap this closes is not a bug in a write — it is a capability that shipped
 * after the sessions that needed it. `watchPushable` admitted RUNS ONLY until
 * commit `a8b1f04` (2026-08-17 15:39 PDT). The athlete's lift and mobility
 * sessions were approved at 01:19 PDT that morning, took the `false` branch,
 * queued nothing, and were never reconsidered: nothing in the system retries a
 * session that becomes pushable later. Nine sessions — two "Ski legs", seven
 * daily mobility — sat in the app reading "Not synced to COROS" with no job, no
 * error and no way for the athlete to ask again. Their complaint was exact: "my
 * exercises for today also do not show up in coros".
 *
 * So this is deliberately NOT a repair of damaged rows. Those rows are correct;
 * what is missing is a write nobody ever asked for, and the only honest way to
 * add one is to run the SAME enqueue the live add path runs
 * (`enqueueWatchCreate`) against the SAME predicate (`watchPushable`), so a
 * backfilled session and an approved one cannot be two different things.
 *
 * Same contract as the two repairs beside it: `dryRun` is REQUIRED and never
 * defaulted, a live run writes the pre-change rows to `audit_events` before
 * queueing anything, and the report is per-row — including `unpushable`, which
 * is the honest verdict on a session COROS's vocabulary genuinely cannot hold
 * (an off-catalog movement has no exercise id to send).
 */

import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { auditEvents, dailyHealth, plannedWorkouts, plannedWorkoutStages } from "@rg/database";
import { newId, nowInstant, todayInZone } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { loadPreferences } from "./calendar-sync.js";
import { enqueueWatchCreate, watchAddressOf, watchPushable } from "./coach-apply.js";
import { sessionFromRow } from "./content-converge.js";

/** `audit_events.kind` for the pre-change backup written by a live run. */
export const PUSH_ABSENT_BACKUP_KIND = "absent_sessions_pushed";

export interface PushAbsentRow {
  workoutId: string;
  effectiveDate: string;
  title: string;
  sport: string;
  action: "push" | "unpushable" | "skipped";
  /** Set when `unpushable` or `skipped` — what the athlete would have to change. */
  reason?: string;
  jobId?: string;
}

export interface PushAbsentReport {
  dryRun: boolean;
  rows: PushAbsentRow[];
  totals: { candidates: number; pushes: number; unpushable: number; skipped: number };
  backup?: { auditEventId: string; kind: string; table: string };
}

export interface PushAbsentOptions {
  dryRun: boolean;
  workoutIds?: string[];
}

/**
 * Plan the pushes, and — unless `dryRun` — commit them behind a backup.
 *
 * The candidate set is narrow on purpose. A row qualifies only when it is LIVE,
 * NOT already addressed on the watch, NOT already run, and dated today or later:
 *  - an addressed row is COROS's to hold and belongs to the content lane, not
 *    this one;
 *  - a completed row's watch copy would be a plan for a session already done;
 *  - a past row would put history on the athlete's watch.
 */
export async function pushAbsentSessions(
  db: Db,
  userId: string,
  opts: PushAbsentOptions,
): Promise<PushAbsentReport> {
  const now = nowInstant();
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const report: PushAbsentReport = {
    dryRun: opts.dryRun,
    rows: [],
    totals: { candidates: 0, pushes: 0, unpushable: 0, skipped: 0 },
  };

  if (!prefs.corosWritesEnabled) {
    // Not a failure and not something to route around: writes are off, so the
    // athlete has said no. Reported rather than silently queued.
    return report;
  }

  const rows = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          isNull(plannedWorkouts.archivedAt),
          gte(plannedWorkouts.effectiveDate, today),
        ),
      )
  ).filter(
    (row) =>
      watchAddressOf(row) === null &&
      row.completionState !== "completed" &&
      (opts.workoutIds === undefined || opts.workoutIds.includes(row.id)),
  );
  if (rows.length === 0) return report;

  const stagesByWorkout = new Map<string, Array<typeof plannedWorkoutStages.$inferSelect>>();
  for (const ids of chunkIds(rows.map((r) => r.id))) {
    for (const stage of await db
      .select()
      .from(plannedWorkoutStages)
      .where(inArray(plannedWorkoutStages.workoutId, ids))) {
      const list = stagesByWorkout.get(stage.workoutId) ?? [];
      list.push(stage);
      stagesByWorkout.set(stage.workoutId, list);
    }
  }

  const toPush: Array<{ row: (typeof rows)[number]; session: NonNullable<ReturnType<typeof sessionFromRow>> }> = [];
  for (const row of rows) {
    const base = {
      workoutId: row.id,
      effectiveDate: row.effectiveDate,
      title: row.title,
      sport: row.sport,
    };
    const session = sessionFromRow(row, stagesByWorkout.get(row.id) ?? []);
    if (!session) {
      report.rows.push({
        ...base,
        action: "unpushable",
        reason: "the row's own copy is a bare summary — there is no session to send",
      });
      continue;
    }
    if (!watchPushable(session)) {
      report.rows.push({
        ...base,
        action: "unpushable",
        // The one thing the athlete can act on, and the same distinction
        // `watch-coverage.ts` draws for the plan page.
        reason: session.run
          ? "this run is prescribed by distance, and COROS structured workouts take duration blocks"
          : "at least one movement is not in your COROS exercise library, so the session has no id to send",
      });
      continue;
    }
    toPush.push({ row, session });
  }

  report.totals = {
    candidates: rows.length,
    pushes: toPush.length,
    unpushable: report.rows.filter((r) => r.action === "unpushable").length,
    skipped: 0,
  };
  if (opts.dryRun || toPush.length === 0) {
    for (const { row, session } of toPush) {
      report.rows.push({
        workoutId: row.id,
        effectiveDate: row.effectiveDate,
        title: row.title,
        sport: row.sport,
        action: "push",
        jobId: `${row.id}-push`,
        ...(session.title !== row.title ? { reason: `sent as "${session.title}"` } : {}),
      });
    }
    return report;
  }

  const auditEventId = newId();
  await db.insert(auditEvents).values({
    id: auditEventId,
    userId,
    kind: PUSH_ABSENT_BACKUP_KIND,
    detail: { previousWorkouts: toPush.map((w) => w.row) },
    createdAt: now,
  });
  report.backup = { auditEventId, kind: PUSH_ABSENT_BACKUP_KIND, table: "audit_events" };

  // The athlete's own threshold, from the same place the ease path reads it —
  // a run pushed without it loses its pace bands and lands as bare timers.
  const [threshold] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  const thresholdPaceSecPerKm = threshold?.v ?? undefined;
  for (const { row, session } of toPush) {
    // THE SAME enqueue the live add path uses, so a backfilled push and an
    // approved one cannot be two different things.
    const jobId = await enqueueWatchCreate(
      db,
      userId,
      row.id,
      row.effectiveDate,
      session,
      now,
      thresholdPaceSecPerKm,
    );
    const base = {
      workoutId: row.id,
      effectiveDate: row.effectiveDate,
      title: row.title,
      sport: row.sport,
    };
    if (jobId) report.rows.push({ ...base, action: "push", jobId });
    else {
      report.rows.push({ ...base, action: "skipped", reason: "the enqueue refused" });
      report.totals.pushes -= 1;
      report.totals.skipped += 1;
    }
  }
  return report;
}

/** Read-only "is there anything to send" — this backfill's own dry run. */
export async function countAbsentPushable(
  db: Db,
  userId: string,
): Promise<PushAbsentReport["totals"] & { unpushableIds: string[] }> {
  const report = await pushAbsentSessions(db, userId, { dryRun: true });
  return {
    ...report.totals,
    unpushableIds: report.rows.filter((r) => r.action === "unpushable").map((r) => r.workoutId),
  };
}
