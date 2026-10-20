/**
 * THE WATCH'S EARLIER VERSION — the owner, 2026-10-19: "can we please look into 'Your watch has an older version...'
 * It's always there and annoying and not actionable or removable."
 *
 * An open `content` intent says the app rewrote a session the watch already held, and the watch has not been given the
 * new version yet (sync-intents.ts). Three things follow from it, all here:
 *
 *  1. WHAT COUNTS. Only a session still to run (`stillToRun`): in the plan, not done, missed or skipped, its day today
 *     or later in the athlete's zone. A past or finished session's watch copy is a record, not a plan — the owner's
 *     line counted three sessions weeks past and missed, for ever. And not while a watch write for it is on its way:
 *     that is "sending", which the row already says. The account line's list (`watchEarlierVersions`) and the row's
 *     `content_stale` (`routes/plan.ts`) apply the same rule.
 *  2. THE HOUSEKEEPING. A claim on a session whose story is over is closed as moot by the hourly
 *     (`closeMootContentClaims`), with its reason, so they stop piling up. It writes no session and no watch or
 *     calendar job — only the intents — and a closed claim still holds the session's content (`contentClaimHeld`), so
 *     the import never hands the app's copy back to COROS's snapshot for it.
 *  3. WHAT THE ATHLETE CAN DO. Send the app's version (watch-version-send.ts: the content rewrite the operator's
 *     backfill and an approved ease queue, when one can reach the row), or keep the watch's (`keepWatchVersion`: the
 *     claim closed as kept, nothing written anywhere but the intent).
 *
 * The reads here import nothing that writes to the watch: `sync-status.ts` reads the list on every 30 s poll.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, notExists, notInArray, or } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, syncIntents } from "@rg/database";
import { humanizeWorkoutTitle } from "@rg/domain";
import { closeContentClaims, type ContentClaimClosedBecause } from "./sync-intents.js";
import { MOOT_CONTENT_CLAIMS_PER_PASS } from "./cron-limits.js";
import type { Db } from "./db.js";

/** A session the athlete has settled: its watch copy is history, not a job. */
export const SETTLED_COMPLETION_STATES = ["completed", "missed", "skipped"] as const;

/** A watch write on its way — the row's view says "sending" (the same four `routes/plan.ts` reads as pending). */
const IN_FLIGHT_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * STILL TO RUN: in the plan, not done, missed or skipped, and its day today or later in the athlete's zone (`today`).
 * The one rule for which divergences the athlete can still act on — the same one `openFailedCoachWrites` applies to a
 * failed watch write.
 */
export function stillToRun(
  w: { archivedAt: string | null; completionState: string; effectiveDate: string },
  today: string,
): boolean {
  return (
    w.archivedAt === null &&
    !(SETTLED_COMPLETION_STATES as readonly string[]).includes(w.completionState) &&
    w.effectiveDate >= today
  );
}

/** A session on the account line's list: its day and its title as the athlete reads it. */
export interface WatchEarlierVersion {
  workoutId: string;
  date: string;
  title: string;
}

/**
 * THE ACCOUNT LINE'S SESSIONS, soonest first: an open content claim on a session still to run, with no watch write for
 * it on its way. One statement.
 */
export async function watchEarlierVersions(db: Db, userId: string, today: string): Promise<WatchEarlierVersion[]> {
  const pw = plannedWorkouts;
  const rows = await db
    .select({
      id: pw.id,
      date: pw.effectiveDate,
      title: pw.title,
      category: pw.category,
      qualitySubtype: pw.qualitySubtype,
    })
    .from(syncIntents)
    .innerJoin(pw, eq(syncIntents.targetId, pw.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "content"),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
        eq(pw.userId, userId),
        isNull(pw.archivedAt),
        notInArray(pw.completionState, [...SETTLED_COMPLETION_STATES]),
        gte(pw.effectiveDate, today),
        notExists(
          db
            .select({ id: corosWriteJobs.id })
            .from(corosWriteJobs)
            .where(and(eq(corosWriteJobs.workoutId, pw.id), inArray(corosWriteJobs.status, [...IN_FLIGHT_JOB_STATUSES]))),
        ),
      ),
    )
    .orderBy(asc(pw.effectiveDate), asc(pw.effectiveTime), asc(pw.id));
  const seen = new Set<string>();
  const out: WatchEarlierVersion[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ workoutId: r.id, date: r.date, title: humanizeWorkoutTitle(r.title, r.category, r.qualitySubtype) });
  }
  return out;
}

/** Why a claim on a session that is over is moot: removed, then how it ended, else its day has gone (the read's rule). */
function mootBecause(w: { archivedAt: string | null; completionState: string }): ContentClaimClosedBecause {
  if (w.archivedAt !== null) return "archived";
  if (w.completionState === "completed" || w.completionState === "missed" || w.completionState === "skipped") {
    return w.completionState;
  }
  return "past";
}

/**
 * THE HOURLY'S HOUSEKEEPING: close, as moot and with the reason, the open content claims on sessions whose story is
 * over — archived, completed, missed or skipped, or their day gone (the athlete's `today`). At most
 * MOOT_CONTENT_CLAIMS_PER_PASS a pass, oldest day first; the rest wait for the next. One read and at most one write per
 * reason (five): statement-bounded whatever the account holds. Writes nothing but the intents — no session, no watch
 * job, no calendar job. Answers how many it closed.
 */
export async function closeMootContentClaims(db: Db, userId: string, today: string, now: string): Promise<number> {
  const pw = plannedWorkouts;
  const rows = await db
    .select({ id: syncIntents.id, archivedAt: pw.archivedAt, completionState: pw.completionState })
    .from(syncIntents)
    .innerJoin(pw, eq(syncIntents.targetId, pw.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "content"),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
        eq(pw.userId, userId),
        or(isNotNull(pw.archivedAt), inArray(pw.completionState, [...SETTLED_COMPLETION_STATES]), lt(pw.effectiveDate, today)),
      ),
    )
    .orderBy(asc(pw.effectiveDate), asc(syncIntents.id))
    .limit(MOOT_CONTENT_CLAIMS_PER_PASS);
  const byReason = new Map<ContentClaimClosedBecause, string[]>();
  for (const r of rows) {
    const because = mootBecause(r);
    byReason.set(because, [...(byReason.get(because) ?? []), r.id]);
  }
  let closed = 0;
  for (const [because, ids] of byReason) {
    await closeContentClaims(db, userId, ids, because, now);
    closed += ids.length;
  }
  return closed;
}

/** An open content claim on this row, still to run: the divergence the sheet's choice is about. */
export async function openClaimIds(db: Db, userId: string, workoutId: string): Promise<string[]> {
  return (
    await db
      .select({ id: syncIntents.id })
      .from(syncIntents)
      .where(
        and(
          eq(syncIntents.userId, userId),
          eq(syncIntents.targetId, workoutId),
          eq(syncIntents.kind, "content"),
          isNull(syncIntents.resolvedAt),
          isNull(syncIntents.supersededBy),
        ),
      )
  ).map((r) => r.id);
}

/**
 * KEEP THE WATCH'S VERSION: the app stops calling it a divergence. The row's open content claims close as kept (the
 * claim still holds the content — the app's copy stays the app's, `contentClaimHeld`), and a rewrite of it still only
 * queued is superseded, so nothing more reaches the watch for it; one already running finishes. Nothing else is
 * written: no session, no watch job, no calendar job. Idempotent: with no open claim, one read and nothing written.
 */
export async function keepWatchVersion(db: Db, userId: string, workoutId: string, now: string): Promise<{ kept: number }> {
  const ids = await openClaimIds(db, userId, workoutId);
  if (ids.length === 0) return { kept: 0 };
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, workoutId),
        eq(corosWriteJobs.kind, "coach_update_workout"),
        eq(corosWriteJobs.status, "queued"),
      ),
    );
  await closeContentClaims(db, userId, ids, "kept_watch_version", now);
  return { kept: ids.length };
}
