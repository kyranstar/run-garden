/**
 * A PHONE'S WATCH WORK, ONE STEP A REQUEST (R1.2 item 7; the owner's real-phone check). The laptop's watch work for an
 * app-built session goes one step a request, the app's own drain sending each (ruling 3-R11): the free plan's budget (45
 * of its 50, D1 statements + COROS fetches) holds no route and its watch job together. A phone has no such drain for its
 * library, so its watch work waited for the hourly's one heavy step: a take-back's `coach_delete_workout` sat queued for
 * half an hour. It goes on the requests a phone already makes instead, bound to the one session the request is about:
 *  - a place makes its session's copy (`deviceWatchRecord`: the mirror's record, its push queued) BEFORE it answers, so
 *    the phone's read that follows finds the push queued (the R1.2 re-check's MAJOR-B) — measured 19–21 + 14, its lock
 *    included;
 *  - the phone's read of a receipt, which its delivery sends straight after each place and each take-back (LifeOS
 *    `receiptsToRead`), runs that session's next step (`deviceWatchStep`): its queued push or delete (one job, measured
 *    ≈31 or ≈26 beside the read's 8), else its owed record.
 * Never another session's work, never two steps. Nothing with COROS writes off (checked here), the watch switch off
 * (the mirror's own check; a program push isn't claimed then, a delete still is: ruling 3-R10), or a restore running (the
 * mirror's and the lane's own checks; the read itself is 503 then).
 */
import { nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { watchPushEnabled, type Env } from "../env.js";
import { loadPreferences } from "./calendar-sync.js";
import { executeCloudJobs } from "./coros-write-cloud.js";
import type { Db } from "./db.js";
import { queuedWatchJobs } from "./jobs.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { mirrorSweep } from "./mirror.js";

/** A phone's record of a session's copy is single-flight per account (the R1.2 re-check's MAJOR-B): `claimUserLock`'s kind. */
export const DEVICE_RECORD_LOCK = "watch_record";

/**
 * What a phone's record of one session declares (an upper bound, for its request's room): the mirror's record (≤ 15,
 * `mirrorSweep`) and its lock (claim 3, release 1).
 */
export const DEVICE_RECORD_COST = 15 + 4;

/**
 * One session's copy made — the mirror's record, its push queued — and only that session's. True when it made one. Held to
 * one at a time per account (`DEVICE_RECORD_LOCK`): a record under way elsewhere — the place's, a second read's — makes
 * this one nothing, never a second record and push (`mirrorSweep` takes no lock, and a record's id is new each time).
 */
export async function deviceWatchRecord(db: Db, env: Env, userId: string, workoutId: string, prefs?: UserPreferences): Promise<boolean> {
  if (!watchPushEnabled(env)) return false;
  const p = prefs ?? (await loadPreferences(db, userId));
  if (!p.corosWritesEnabled) return false;
  const lock = await claimUserLock(db, userId, DEVICE_RECORD_LOCK, 2);
  if (!lock) return false;
  try {
    const ctx = { today: todayInZone(p.timezone), now: nowInstant(), prefs: p };
    return (await mirrorSweep(db, env, userId, p, ctx, { cap: 1, workoutId })).attempted > 0;
  } finally {
    await releaseUserLock(db, userId, DEVICE_RECORD_LOCK, lock);
  }
}

/**
 * One session's next watch step: its oldest queued watch job (a push — a provisional copy's too — or a delete), run;
 * else, with none queued, its copy made when the mirror owes one. `ran`, `record` or `none`.
 */
export async function deviceWatchStep(db: Db, env: Env, userId: string, workoutId: string): Promise<"ran" | "record" | "none"> {
  const prefs = await loadPreferences(db, userId);
  if (!prefs.corosWritesEnabled) return "none";
  if ((await queuedWatchJobs(db, userId, workoutId)) > 0) {
    const drained = await executeCloudJobs(db, env, userId, prefs, { cap: 1, watchOnly: true, workoutId });
    return drained.executed > 0 ? "ran" : "none";
  }
  return (await deviceWatchRecord(db, env, userId, workoutId, prefs)) ? "record" : "none";
}
