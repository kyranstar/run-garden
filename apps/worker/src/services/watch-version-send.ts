/**
 * SEND THIS VERSION TO THE WATCH, and whether it can be (watch-version.ts has the rule for what counts and the keep).
 * Apart from the account line's reads because it plans through the operator's convergence backfill
 * (`convergeDivergedContent`), which writes to the watch.
 */
import type { plannedWorkouts } from "@rg/database";
import { appAuthoredRow, type RunWire, type UserPreferences } from "@rg/domain";
import { convergeDivergedContent } from "./content-converge.js";
import { openClaimIds, stillToRun } from "./watch-version.js";
import type { Db } from "./db.js";

/** Why the app's version can't be sent from here: watch updates off, COROS not connected, or no rewrite can reach it. */
export type WatchVersionWhy = "writes_off" | "not_connected" | "cant_rewrite";

/** What the athlete can do about a session's earlier version on the watch. Keeping the watch's is always possible. */
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

/** The reasons known from the row and the account alone, before any plan is read. */
function sendBlocked(row: WorkoutRow, ctx: SendCtx): WatchVersionWhy | null {
  if (appAuthoredRow(row)) return "cant_rewrite";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (!ctx.online) return "not_connected";
  return null;
}

/**
 * CAN THE APP'S VERSION BE SENT? Only when a content rewrite can reach the row: watch updates on, COROS connected, a
 * session the app did not build (an app-built one reaches the watch only by its own Send, ruling 3-R13), and the
 * operator backfill's own plan for it a rewrite — read in dry run (`convergeDivergedContent`), so what is offered and
 * what Send queues cannot disagree. An unpush is not a send, and is never offered.
 */
export async function watchVersionChoice(db: Db, userId: string, row: WorkoutRow, ctx: SendCtx): Promise<WatchVersionChoice> {
  const blocked = sendBlocked(row, ctx);
  if (blocked) return { send: false, why: blocked };
  const plan = await convergeDivergedContent(db, userId, {
    dryRun: true,
    workoutIds: [row.id],
    today: ctx.today,
    rewritesOnly: true,
    ...(ctx.runWire ? { runWire: ctx.runWire } : {}),
  });
  return plan.rows.some((r) => r.workoutId === row.id && r.action === "rewrite")
    ? { send: true }
    : { send: false, why: "cant_rewrite" };
}

export type SendWatchVersionOutcome = { ok: true; jobId: string } | { ok: false; error: "nothing_to_send" | WatchVersionWhy };

/**
 * SEND THIS VERSION TO THE WATCH: the content rewrite the operator's backfill queues (backup first, a failed rewrite of
 * the same content revived — the athlete is asking again), for this row alone and never an unpush. Refused, with
 * nothing written, when the row holds no open claim or is no longer still to run (`nothing_to_send`), or when it can't
 * be sent (`WatchVersionWhy`, as the choice says). Queues the write and runs none: the client drains it (`coachDrain`).
 */
export async function sendWatchVersion(db: Db, userId: string, row: WorkoutRow, ctx: SendCtx): Promise<SendWatchVersionOutcome> {
  if (!stillToRun(row, ctx.today) || (await openClaimIds(db, userId, row.id)).length === 0) {
    return { ok: false, error: "nothing_to_send" };
  }
  const blocked = sendBlocked(row, ctx);
  if (blocked) return { ok: false, error: blocked };
  // The live plan is the dry run's (`watchVersionChoice`) with its writes: a row it would not rewrite queues nothing.
  const done = await convergeDivergedContent(db, userId, {
    dryRun: false,
    workoutIds: [row.id],
    today: ctx.today,
    rewritesOnly: true,
    maxWrites: 1,
    ...(ctx.runWire ? { runWire: ctx.runWire } : {}),
  });
  const queued = done.rows.find((r) => r.workoutId === row.id && r.action === "rewrite" && r.jobId);
  return queued?.jobId ? { ok: true, jobId: queued.jobId } : { ok: false, error: "cant_rewrite" };
}

