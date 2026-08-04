/**
 * Deep activity backfill: walking the account's COROS history backwards in
 * chunks until it runs out.
 *
 * The sequencing lives in `nextBackfillAction` as a pure function so the
 * interesting decisions — when to stop, how to clamp at the floor, what counts
 * as "history has ended" — are testable without a database, a bridge, or COROS.
 */

import { and, eq, inArray } from "drizzle-orm";
import { backfillState, corosWriteJobs } from "@rg/database";
import { addDays, newId, nowInstant, type SourceActivity } from "@rg/domain";
import { loadPreferences } from "./calendar-sync.js";
import { ingestActivities, type IngestInput } from "./completion.js";
import type { Db } from "./db.js";
import { resimulateFrom } from "./garden-sync.js";

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
  if (inFlight.length > 0) return { enqueued: false, reason: "already_running" };

  const now = nowInstant();
  const fresh = {
    status: "running",
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
