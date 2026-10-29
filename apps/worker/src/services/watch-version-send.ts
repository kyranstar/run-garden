/**
 * SEND THIS VERSION TO THE WATCH, and whether it can be (watch-version.ts has the rule for what counts, the keep and
 * the leave). Apart from the account line's reads because it plans through the convergence backfill
 * (`convergeDivergedContent`), which writes to the watch.
 */
import { and, eq, inArray } from "drizzle-orm";
import { corosWriteJobs, type plannedWorkouts } from "@rg/database";
import { appAuthoredRow, type RunWire, type UserPreferences } from "@rg/domain";
import { convergeDivergedContent } from "./content-converge.js";
import { IN_FLIGHT_JOB_STATUSES, openClaimIds, stillToRun } from "./watch-version.js";
import type { Db } from "./db.js";

/**
 * Why the app's version can't be sent from here: watch updates off, COROS not connected (each then sendable once
 * changed: the plan for the row is a rewrite), no rewrite can reach it at all — or the session is the app's own, whose
 * copy the mirror replaces (`mirrored`: the watch mirrors the plan §3.6).
 */
export type WatchVersionWhy = "writes_off" | "not_connected" | "cant_rewrite" | "mirrored";

/** What the athlete can do about a session's earlier version on the watch, besides keeping the watch's. */
export interface WatchVersionChoice {
  send: boolean;
  why?: WatchVersionWhy;
}

type WorkoutRow = typeof plannedWorkouts.$inferSelect;

/** What a send is judged by: the athlete's settings, the COROS connection, their today, the run wire in force. */
export interface SendCtx {
  prefs: UserPreferences;
  online: boolean;
  today: string;
  runWire?: RunWire;
}

/** What only the athlete can change — watch updates, the connection — once a rewrite could reach the row. */
function blockedForNow(ctx: SendCtx): WatchVersionWhy | null {
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (!ctx.online) return "not_connected";
  return null;
}

/**
 * CAN THE APP'S VERSION BE SENT? Only when a content rewrite can reach the row: a session the app did not build (an
 * app-built one is the mirror's — its copy is replaced, never rewritten from here: `mirrored`, §3.6; ruling 3-R13), and
 * the convergence backfill's own plan for it a rewrite — read in dry run, so what is offered and what Send queues
 * cannot disagree; an unpush is not a send and is never offered. Then watch updates on and COROS connected — said after
 * the plan, so "then send it from here" is true.
 */
export async function watchVersionChoice(db: Db, userId: string, row: WorkoutRow, ctx: SendCtx): Promise<WatchVersionChoice> {
  if (appAuthoredRow(row)) return { send: false, why: "mirrored" };
  const plan = await convergeDivergedContent(db, userId, {
    dryRun: true,
    workoutIds: [row.id],
    today: ctx.today,
    rewritesOnly: true,
    ...(ctx.runWire ? { runWire: ctx.runWire } : {}),
  });
  if (!plan.rows.some((r) => r.workoutId === row.id && r.action === "rewrite")) return { send: false, why: "cant_rewrite" };
  const blocked = blockedForNow(ctx);
  return blocked ? { send: false, why: blocked } : { send: true };
}

export type SendWatchVersionOutcome = { ok: true; jobId: string } | { ok: false; error: "nothing_to_send" | WatchVersionWhy };

/**
 * SEND THIS VERSION TO THE WATCH: the content rewrite the convergence backfill queues (backup first), for this row
 * alone and never an unpush.
 *
 * IDEMPOTENT (review-S I1). A rewrite of the row already queued or running is the send: answered with its id, nothing
 * planned — a second press, a second device or a retried request must never supersede the athlete's own write in
 * flight. A rewrite of the same content that failed, was switched off by a restore, or was superseded is revived (the
 * athlete is asking again), so one live job is left whatever came before.
 *
 * Refused, with nothing written, when the row holds no open claim or is no longer still to run (`nothing_to_send`), or
 * when it can't be sent (`WatchVersionWhy`). Queues the write and runs none: the client drains it (`coachDrain`).
 */
export async function sendWatchVersion(db: Db, userId: string, row: WorkoutRow, ctx: SendCtx): Promise<SendWatchVersionOutcome> {
  const [live] = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, row.id),
        eq(corosWriteJobs.kind, "coach_update_workout"),
        inArray(corosWriteJobs.status, [...IN_FLIGHT_JOB_STATUSES]),
      ),
    )
    .limit(1);
  if (live) return { ok: true, jobId: live.id };
  if (!stillToRun(row, ctx.today) || (await openClaimIds(db, userId, row.id)).length === 0) {
    return { ok: false, error: "nothing_to_send" };
  }
  if (appAuthoredRow(row)) return { ok: false, error: "cant_rewrite" };
  const blocked = blockedForNow(ctx);
  if (blocked) return { ok: false, error: blocked };
  // The live plan is the dry run's (`watchVersionChoice`) with its writes: a row it would not rewrite queues nothing.
  const done = await convergeDivergedContent(db, userId, {
    dryRun: false,
    workoutIds: [row.id],
    today: ctx.today,
    rewritesOnly: true,
    reviveSuperseded: true,
    maxWrites: 1,
    ...(ctx.runWire ? { runWire: ctx.runWire } : {}),
  });
  const queued = done.rows.find((r) => r.workoutId === row.id && r.action === "rewrite" && r.jobId);
  return queued?.jobId ? { ok: true, jobId: queued.jobId } : { ok: false, error: "cant_rewrite" };
}
