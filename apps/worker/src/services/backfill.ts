/**
 * Deep activity backfill: walking the account's COROS history backwards in
 * chunks until it runs out.
 *
 * The sequencing lives in `nextBackfillAction` as a pure function so the
 * interesting decisions — when to stop, how to clamp at the floor, what counts
 * as "history has ended" — are testable without a database, a bridge, or COROS.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { activities, backfillState, corosWriteJobs } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type SourceActivity } from "@rg/domain";
import { loadPreferences } from "./calendar-sync.js";
import { ingestActivities, type IngestInput } from "./completion.js";
import { READ_WINDOW_DAYS, enqueueBackfillDigest, enqueueCoachReads } from "./coach-reads.js";
import { buildActivityBackfill } from "@rg/coros";
import { corosClient } from "./coros-connection.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import type { Env } from "../env.js";
import type { UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { resimulateFrom } from "./garden-sync.js";
import { CLAIM_TIMEOUT_MS } from "./jobs.js";

/** Days of history per backfill chunk. */
export const CHUNK_DAYS = 90;
/** Consecutive empty chunks that end the walk. One empty chunk is just a training gap. */
export const MAX_EMPTY_CHUNKS = 2;
/** How far back the walk may reach when nothing stops it sooner. */
export const DEFAULT_FLOOR_YEARS = 5;

export interface BackfillCheckpoint {
  /** Oldest chunk start already ingested; null before the first chunk lands. */
  earliestDateReached: string | null;
  consecutiveEmptyChunks: number;
}

export interface ChunkOutcome {
  activitiesFound: number;
}

export type BackfillAction =
  | { kind: "continue"; chunkStart: string; chunkEnd: string }
  | { kind: "done"; reason: "empty_run" | "floor_reached" };

/**
 * The first chunk starts where the rolling snapshot window ends — redoing the
 * last 14 days would be pure waste, and the snapshot keeps them fresh anyway.
 */
export function firstChunk(
  today: string,
  rollingWindowDays: number,
): { chunkStart: string; chunkEnd: string } {
  const chunkEnd = addDays(today, -rollingWindowDays);
  // -CHUNK_DAYS + 1 so the span is 90 days INCLUSIVE of chunkEnd — identical to
  // the span nextBackfillAction produces, or the first chunk would be a day
  // wider than every chunk after it.
  return { chunkStart: addDays(chunkEnd, -CHUNK_DAYS + 1), chunkEnd };
}

/** The floor date for a walk starting today. */
export function defaultFloor(today: string): string {
  return addDays(today, -DEFAULT_FLOOR_YEARS * 365);
}

/**
 * Given the checkpoint and what the just-completed chunk found, decide whether
 * to walk one chunk further back or stop. Pure — no database, no clock.
 */
export function nextBackfillAction(
  checkpoint: BackfillCheckpoint,
  outcome: ChunkOutcome,
  floorDate: string,
): BackfillAction {
  // A single empty 90-day window is an ordinary break from training, not the
  // end of history — only a run of them is evidence.
  const emptyRun = outcome.activitiesFound === 0 ? checkpoint.consecutiveEmptyChunks + 1 : 0;
  if (emptyRun >= MAX_EMPTY_CHUNKS) return { kind: "done", reason: "empty_run" };

  // The completed chunk covered [earliestDateReached, ...]; the next one ends
  // the day before it began.
  const previousStart = checkpoint.earliestDateReached;
  if (previousStart == null) return { kind: "done", reason: "floor_reached" };
  const chunkEnd = addDays(previousStart, -1);
  if (chunkEnd < floorDate) return { kind: "done", reason: "floor_reached" };

  const rawStart = addDays(chunkEnd, -CHUNK_DAYS + 1);
  const chunkStart = rawStart < floorDate ? floorDate : rawStart;
  return { kind: "continue", chunkStart, chunkEnd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration: jobs, ingest, checkpoint

/** Days the rolling snapshot already covers; backfill starts behind it. */
const ROLLING_WINDOW_DAYS = 14;
/** Job statuses that mean a backfill is already under way. */
const IN_FLIGHT = ["queued", "claimed"] as const;

/** Insert one backfill job for an explicit chunk. Mirrors read_now's workout-less shape. */
async function insertChunkJob(
  db: Db,
  userId: string,
  chunkStart: string,
  chunkEnd: string,
): Promise<string> {
  const id = newId();
  const now = nowInstant();
  await db.insert(corosWriteJobs).values({
    id,
    userId,
    // Self-referencing workoutId satisfies NOT NULL for a job that acts on no
    // workout — the same trick read_now and the studio kinds use.
    workoutId: id,
    kind: "backfill",
    expectedContentFingerprint: "",
    // The chunk range. `payload` is authoritative; these two columns are NOT
    // NULL and a date-ranged job is exactly what they describe.
    originalDate: chunkStart,
    destinationDate: chunkEnd,
    payload: { chunkStart, chunkEnd },
    requestedAt: now,
    status: "queued",
    updatedAt: now,
  });
  return id;
}

export async function enqueueBackfill(
  db: Db,
  userId: string,
  today: string,
): Promise<{ enqueued: boolean; reason?: string }> {
  const inFlight = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.kind, "backfill"),
        inArray(corosWriteJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inFlight.length > 0) {
    // A watchdog-errored walk whose job still sits queued: "Run again" must
    // work, not dead-end. Re-arm the state (keeping progress counters) so the
    // UI honestly says "queued" while the same job waits for the Mac.
    const state = (
      await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
    )[0];
    if (state?.status === "error") {
      const now = nowInstant();
      await db
        .update(backfillState)
        .set({ status: "queued", startedAt: now, finishedAt: null, lastErrorCategory: null, updatedAt: now })
        .where(eq(backfillState.userId, userId));
      return { enqueued: true, reason: "rearmed" };
    }
    return { enqueued: false, reason: "already_running" };
  }

  const now = nowInstant();
  // "queued", not "running": nothing is reading history until a bridge claims
  // the job. recordChunk flips to "running" when the first chunk actually
  // lands — the status must never claim work the Mac isn't doing.
  const fresh = {
    status: "queued",
    earliestDateReached: null,
    chunksCompleted: 0,
    activitiesIngested: 0,
    consecutiveEmptyChunks: 0,
    skippedSportTypes: {},
    startedAt: now,
    finishedAt: null,
    lastErrorCategory: null,
    updatedAt: now,
  } as const;
  await db
    .insert(backfillState)
    .values({ userId, ...fresh })
    .onConflictDoUpdate({ target: backfillState.userId, set: { ...fresh } });

  const { chunkStart, chunkEnd } = firstChunk(today, ROLLING_WINDOW_DAYS);
  await insertChunkJob(db, userId, chunkStart, chunkEnd);
  return { enqueued: true };
}

export interface ChunkReport {
  chunkStart: string;
  chunkEnd: string;
  activities: SourceActivity[];
  lapsByProviderId: IngestInput["lapsByProviderId"];
  skippedSportTypes: Record<string, number>;
}

/**
 * Ingest one chunk of history.
 *
 * ACTIVITIES ONLY — this must never call importPlan. See the file header on
 * services/coros-bridge/src/backfill.ts for what happens if it does.
 */
export async function recordChunk(db: Db, userId: string, chunk: ChunkReport): Promise<void> {
  const now = nowInstant();
  const stats = await ingestActivities(db, {
    userId,
    sources: chunk.activities,
    lapsByProviderId: chunk.lapsByProviderId,
  });

  const existing = (
    await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
  )[0];
  const mergedSkips: Record<string, number> = { ...(existing?.skippedSportTypes ?? {}) };
  for (const [code, count] of Object.entries(chunk.skippedSportTypes)) {
    mergedSkips[code] = (mergedSkips[code] ?? 0) + count;
  }

  await db
    .update(backfillState)
    .set({
      // Data is flowing, so the walk is genuinely running — this also revives
      // a state the watchdog marked never_started if a walker resumed
      // later and worked the still-queued job anyway.
      status: "running",
      lastErrorCategory: null,
      finishedAt: null,
      earliestDateReached: chunk.chunkStart,
      chunksCompleted: (existing?.chunksCompleted ?? 0) + 1,
      activitiesIngested: (existing?.activitiesIngested ?? 0) + chunk.activities.length,
      skippedSportTypes: mergedSkips,
      updatedAt: now,
    })
    .where(eq(backfillState.userId, userId));

  if (stats.affectedDates.length > 0) {
    const prefs = await loadPreferences(db, userId);
    await resimulateFrom(db, userId, stats.affectedDates[0]!, prefs).catch(() => undefined);
  }
}

/** Decide what happens after a reported chunk: queue the next one, or finish. */
export async function advanceBackfill(
  db: Db,
  userId: string,
  _jobId: string,
  outcome: ChunkOutcome,
  today: string,
): Promise<void> {
  const now = nowInstant();
  const state = (
    await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
  )[0];
  if (!state) return;

  const action = nextBackfillAction(
    {
      earliestDateReached: state.earliestDateReached,
      consecutiveEmptyChunks: state.consecutiveEmptyChunks,
    },
    outcome,
    defaultFloor(today),
  );

  if (action.kind === "done") {
    await db
      .update(backfillState)
      .set({ status: "done", finishedAt: now, updatedAt: now })
      .where(eq(backfillState.userId, userId));
    // Perception layer (rework spec §1): the finished walk enqueues reads for
    // anything inside the auto-read window, and ONE digest for the deeper
    // history — never a per-activity call over months of backfill. Keyed by
    // the walk's earliest date so a re-run of the same span stays idempotent.
    try {
      const prefs = await loadPreferences(db, userId);
      const localToday = todayInZone(prefs.timezone);
      await enqueueCoachReads(db, userId, localToday);
      const cutoff = addDays(localToday, -READ_WINDOW_DAYS);
      const acts = await db
        .select({ startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
        .from(activities)
        .where(eq(activities.userId, userId));
      const oldCount = acts.filter(
        (a) => (a.startTimeLocal ?? a.startTime).slice(0, 10) < cutoff,
      ).length;
      await enqueueBackfillDigest(db, userId, `backfill:${state.earliestDateReached ?? "history"}`, oldCount);
    } catch {
      // A finished backfill never fails over the perception layer.
    }
    return;
  }

  await db
    .update(backfillState)
    .set({
      consecutiveEmptyChunks: outcome.activitiesFound === 0 ? state.consecutiveEmptyChunks + 1 : 0,
      updatedAt: now,
    })
    .where(eq(backfillState.userId, userId));
  await insertChunkJob(db, userId, action.chunkStart, action.chunkEnd);
}

/**
 * Cloud-direct chunk walker (cloud-direct spec §3): with a connected COROS
 * account the worker serves the oldest queued chunk itself — pull, record,
 * advance — and completes the job row so no device ever needs to claim it.
 * One chunk per invocation keeps a cron tick bounded; the Backfill button
 * fires the first chunk via waitUntil so progress is visible in seconds.
 */
export async function runBackfillChunkCloud(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ran: boolean }> {
  const state = (
    await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
  )[0];
  // "error" is served too: a watchdog-errored walk whose job still sits
  // queued (the bridge-era stuck state, 2026-08-12) resumes by itself once a
  // cloud connection exists — recordChunk revives the state to "running".
  // With no live job the next SELECT returns nothing and we exit anyway.
  if (!state || (state.status !== "running" && state.status !== "queued" && state.status !== "error"))
    return { ran: false };

  const [job] = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.kind, "backfill"),
        eq(corosWriteJobs.status, "queued"),
      ),
    )
    .orderBy(asc(corosWriteJobs.requestedAt))
    .limit(1);
  if (!job) return { ran: false };

  const client = await corosClient(db, env, userId, fetchImpl);
  if (!client) return { ran: false }; // not cloud-connected — a device may still claim it

  const lock = await claimUserLock(db, userId, "coros_backfill", 15);
  if (!lock) return { ran: false };
  try {
    const payload = job.payload as { chunkStart: string; chunkEnd: string };
    // Workers pace on IO anyway — a light delay is still kind to COROS.
    const chunk = await buildActivityBackfill(client, payload.chunkStart, payload.chunkEnd, undefined, {
      delayMs: 25,
    });
    await recordChunk(db, userId, {
      chunkStart: payload.chunkStart,
      chunkEnd: payload.chunkEnd,
      activities: chunk.activities,
      lapsByProviderId: chunk.lapsByProviderId as never,
      skippedSportTypes: chunk.skippedSportTypes,
    });
    const now = nowInstant();
    await db
      .update(corosWriteJobs)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(eq(corosWriteJobs.id, job.id));
    await advanceBackfill(db, userId, job.id, { activitiesFound: chunk.activities.length }, todayInZone(prefs.timezone));
    return { ran: true };
  } catch {
    // Leave the job queued: the next tick (or a device) retries the chunk.
    return { ran: false };
  } finally {
    await releaseUserLock(db, userId, "coros_backfill", lock).catch(() => undefined);
  }
}

/** How long a backfill may sit stalled before the status stops pretending. */
export const BACKFILL_UNCLAIMED_ERROR_MS = 12 * 60 * 60 * 1000;

export type BackfillUiStatus = "idle" | "queued" | "running" | "done" | "error";

/**
 * The status the UI should show, derived honestly at read time. Rows written
 * before the queued/running split (or mid-transition) can say "running"
 * while no bridge has ever claimed the job — those read as "queued", because
 * that is what they are.
 */
export function deriveBackfillStatus(
  stored: { status: string; chunksCompleted: number } | undefined,
  newestJobStatus: string | null,
): BackfillUiStatus {
  if (!stored) return "idle";
  if (stored.status === "running" && stored.chunksCompleted === 0 && newestJobStatus === "queued") {
    return "queued";
  }
  return stored.status as BackfillUiStatus;
}

/**
 * Cron sweep: a walk that has made no progress for BACKFILL_UNCLAIMED_ERROR_MS
 * stops pretending and says what happened — whether the Mac never picked it
 * up (zero chunks) or stopped partway through. Claims older than
 * CLAIM_TIMEOUT_MS are reverted to queued first, so a claim whose response
 * never arrived (the exact live incident) can't hide a stall. The job row
 * stays queued on purpose: a bridge that finally wakes still claims it, and
 * recordChunk revives the state to "running" when data lands.
 */
export async function sweepStaleBackfills(db: Db, now: Date): Promise<number> {
  const stale = new Date(now.getTime() - BACKFILL_UNCLAIMED_ERROR_MS).toISOString();
  const claimStale = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
  const candidates = await db
    .select()
    .from(backfillState)
    .where(inArray(backfillState.status, ["queued", "running"]));
  let flipped = 0;
  for (const row of candidates) {
    // The staleness clock is last progress (updatedAt), falling back to start.
    const lastProgress = row.updatedAt ?? row.startedAt;
    if (!lastProgress || lastProgress > stale) continue;
    const newest = (
      await db
        .select({ id: corosWriteJobs.id, status: corosWriteJobs.status, claimedAt: corosWriteJobs.claimedAt })
        .from(corosWriteJobs)
        .where(and(eq(corosWriteJobs.userId, row.userId), eq(corosWriteJobs.kind, "backfill")))
        .orderBy(desc(corosWriteJobs.requestedAt))
        .limit(1)
    )[0];
    if (!newest) continue;
    if (newest.status === "claimed") {
      // A claim whose result never arrived — same revert claimNextJob does,
      // so the next polling bridge can pick the job up again.
      if (!newest.claimedAt || newest.claimedAt > claimStale) continue;
      await db
        .update(corosWriteJobs)
        .set({ status: "queued", claimedByDeviceId: null, claimedAt: null, updatedAt: nowInstant(now) })
        .where(eq(corosWriteJobs.id, newest.id));
    } else if (newest.status !== "queued") {
      continue;
    }
    await db
      .update(backfillState)
      .set({
        status: "error",
        lastErrorCategory: row.chunksCompleted > 0 ? "stalled" : "never_started",
        finishedAt: nowInstant(now),
        updatedAt: nowInstant(now),
      })
      .where(eq(backfillState.userId, row.userId));
    flipped += 1;
  }
  return flipped;
}
