/**
 * Deep activity backfill: walking the account's COROS history backwards in
 * chunks until it runs out.
 *
 * The sequencing lives in `nextBackfillAction` as a pure function so the
 * interesting decisions — when to stop, how to clamp at the floor, what counts
 * as "history has ended" — are testable without a database, a bridge, or COROS.
 */

import { addDays } from "@rg/domain";

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
