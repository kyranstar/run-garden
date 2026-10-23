/**
 * THE WATCH'S EARLIER VERSION — the owner, 2026-10-19: "can we please look into 'Your watch has an older version...'
 * It's always there and annoying and not actionable or removable."
 *
 * An open `content` intent says the app rewrote a session the watch already held, and the watch has not been given the
 * new version yet (sync-intents.ts). Two things follow from it, here:
 *
 *  1. WHAT COUNTS — one rule for the account line's list (`watchEarlierVersions`) and the row's `content_stale`
 *     (`routes/plan.ts`, `deriveWorkoutSync`): an open claim on a session still to run (`stillToRun`: in the plan, not
 *     done, missed or skipped, its day today or later in the athlete's zone), on the watch on the app's day (the date
 *     the watch was last confirmed on is the session's own), and no watch write for it on its way (that is "sending").
 *     A past or finished session's watch copy is a record: its claim is left open and simply not counted, so a session
 *     that comes back (unskipped, moved on, healed back into the plan) says "Older on watch" again. The list also
 *     leaves out a claim the athlete left as it is (an app-built session, `LEFT_PATH`) — its row still says so.
 *  2. WHAT THE ATHLETE CAN DO. Send the app's version (watch-version-send.ts: the content rewrite the convergence
 *     backfill and an approved ease queue, when one can reach the row); keep the watch's (`keepWatchVersion`: the app
 *     takes the watch's copy — the claim released as a converged rewrite releases it, and the next COROS read rewrites
 *     the row from the wire); or, for a session the app built — whose content no read ever takes from the wire, and
 *     whose earlier copy no rewrite from here replaces — leave the watch as it is (`leaveWatchVersion`).
 *
 * The reads here import nothing that writes to the watch: `sync-status.ts` reads the list on every 30 s poll.
 */
import { and, asc, eq, gte, inArray, isNull, not, notExists, notInArray } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, syncIntents } from "@rg/database";
import { appAuthoredRow, humanizeWorkoutTitle } from "@rg/domain";
import { leaveContentClaims, leftAsItIs, releaseContentClaims } from "./sync-intents.js";
import { markedFingerprint } from "./watch-copy-marker.js";
import type { Db } from "./db.js";

/** A session the athlete has settled: its watch copy is history, not a job. */
export const SETTLED_COMPLETION_STATES = ["completed", "missed", "skipped"] as const;

/** A watch write on its way — the row's view says "sending" (the same four `routes/plan.ts` reads as pending). */
export const IN_FLIGHT_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * STILL TO RUN: in the plan, not done, missed or skipped, and its day today or later in the athlete's zone (`today`).
 * The rule for which divergences the athlete can still act on — the same one `openFailedCoachWrites` applies to a
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
 * THE ACCOUNT LINE'S SESSIONS, soonest first — every row whose view is `content_stale` (`deriveWorkoutSync`: on the
 * watch on its day, nothing on its way, an open claim on a session still to run), less those the athlete left as they
 * are. One statement.
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
        not(leftAsItIs()),
        eq(pw.userId, userId),
        isNull(pw.archivedAt),
        notInArray(pw.completionState, [...SETTLED_COMPLETION_STATES]),
        gte(pw.effectiveDate, today),
        // On the watch on the app's day: `deriveWorkoutSync` says the date story first otherwise.
        eq(pw.effectiveDate, pw.lastVerifiedCorosDate),
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

/** This row's open content claims: the divergence the sheet's choice is about. */
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

type WorkoutRow = Pick<typeof plannedWorkouts.$inferSelect, "id" | "origin">;

/** The rewrites Keep stops: every one not running — queued, failed (Retry's), switched off by a restore (Send's). */
const KEEP_SUPERSEDES = ["queued", "failed", "restored"] as const;

export type KeepOutcome = { kept: number } | { error: "app_built" };

/**
 * KEEP THE WATCH'S VERSION: the app takes the watch's copy. The row's open content claims are released the ordinary
 * way (as a converged rewrite releases them), and every rewrite of it not running is superseded so nothing more reaches
 * the watch for it — one queued, one failed (whose Retry would put the version the athlete chose against back on the
 * watch, and which the account line would go on counting as an issue: review A1), one a restore switched off (whose
 * Send would) — while one already running finishes, and the read then takes what it wrote; and the row is marked
 * (watch-copy-marker.ts: the fingerprint it had is kept inside the mark) so the next COROS read rewrites it from the
 * wire: title, stages, sport, and its lift or mobility structure dropped then, not before — until the read, nothing of
 * the app's copy is lost. Until then a row still to run says so (`taking_watch_copy`). Nothing is
 * written to the watch. An app-built session is refused (`app_built`): no read ever takes its content from the wire,
 * so its Keep could not be true — it is left as it is instead (`leaveWatchVersion`). Idempotent: with no open claim,
 * one read and nothing written.
 */
export async function keepWatchVersion(db: Db, userId: string, row: WorkoutRow, now: string): Promise<KeepOutcome> {
  if (appAuthoredRow(row)) return { error: "app_built" };
  const ids = await openClaimIds(db, userId, row.id);
  if (ids.length === 0) return { kept: 0 };
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, row.id),
        eq(corosWriteJobs.kind, "coach_update_workout"),
        inArray(corosWriteJobs.status, [...KEEP_SUPERSEDES]),
      ),
    );
  await releaseContentClaims(db, userId, row.id, now);
  await db
    .update(plannedWorkouts)
    .set({ sourceContentFingerprint: markedFingerprint(plannedWorkouts.sourceContentFingerprint), updatedAt: now })
    .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
  return { kept: ids.length };
}

export type LeaveOutcome = { left: number } | { error: "not_app_built" };

/**
 * LEAVE THE WATCH AS IT IS — an app-built session only (a programme's, an on-demand one, a Studio or template
 * workout), whose earlier copy no rewrite from here replaces and whose content no read takes from the wire. The claim
 * stays open, so the row keeps saying the watch has an earlier version ("Older on watch" is true); it is marked left
 * (`LEFT_PATH`) and the account line stops counting it. Nothing else is written. Any other session is refused
 * (`not_app_built`): its Keep takes the watch's version. Idempotent.
 */
export async function leaveWatchVersion(db: Db, userId: string, row: WorkoutRow, now: string): Promise<LeaveOutcome> {
  if (!appAuthoredRow(row)) return { error: "not_app_built" };
  const ids = await openClaimIds(db, userId, row.id);
  if (ids.length > 0) await leaveContentClaims(db, userId, row.id, now);
  return { left: ids.length };
}
