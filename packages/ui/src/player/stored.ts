/**
 * WHAT START LEAVES ON THE DEVICE BESIDE THE BUILD (Phase 2b Task 4; ruling 2b-R1). The `builds` store holds the locked
 * build and its view under the slot's id (`offline/builds.ts`); the player also needs what the build does not carry —
 * the session's name and the switched-on condition profiles (their words, scales and rules) — and, for the review,
 * the records and graduation basis the server works out at Start (`basis`). They sit in the same store under
 * `player:<workoutId>` and `review:<workoutId>`, written at Start (online), read by the player and the review offline,
 * dropped on Save — and on Discard, which un-starts the slot (ruling 2b-R9): the device never replays a discarded
 * session's build.
 */
import type { ConditionViewDto, ReviewBasisDto, SessionDto } from "@rg/api-client";
import { forgetBuild, saveBuild } from "../offline/builds.js";
import type { OfflineDb } from "../offline/idb.js";

export interface PlayerExtras {
  workoutId: string;
  /** The program's name, as the sheet titles the session. */
  title: string;
  profiles: ConditionViewDto[];
  /** The signed-in account at Start: the save goes to its outbox, offline too (ruling 2b-R6). */
  userId?: string | null;
  /** Epoch ms. */
  savedAt: number;
}

const key = (workoutId: string) => `player:${workoutId}`;
const basisKey = (workoutId: string) => `review:${workoutId}`;

export function saveExtras(db: OfflineDb, extras: PlayerExtras): Promise<void> {
  return db.put("builds", key(extras.workoutId), extras);
}

export function loadExtras(db: OfflineDb, workoutId: string): Promise<PlayerExtras | undefined> {
  return db.get<PlayerExtras>("builds", key(workoutId));
}

/** Start succeeded: keep the locked build, its view and what the player needs beside them. */
export async function rememberStart(
  db: OfflineDb,
  session: SessionDto,
  title: string,
  userId: string | null,
  now: number = Date.now(),
): Promise<void> {
  await saveBuild(db, session, now);
  await saveExtras(db, { workoutId: session.workoutId, title, profiles: session.profiles, userId, savedAt: now });
}

/** What the review reads of the history (`GET /api/sessions/:id/review-basis`), fetched once while online. */
export function saveBasis(db: OfflineDb, workoutId: string, basis: ReviewBasisDto): Promise<void> {
  return db.put("builds", basisKey(workoutId), basis);
}

export function loadBasis(db: OfflineDb, workoutId: string): Promise<ReviewBasisDto | undefined> {
  return db.get<ReviewBasisDto>("builds", basisKey(workoutId));
}

/** Saved or discarded: nothing of the session stays on the device but what the outbox holds. */
export async function forgetStart(db: OfflineDb, workoutId: string): Promise<void> {
  await forgetBuild(db, workoutId);
  await db.delete("builds", key(workoutId));
  await db.delete("builds", basisKey(workoutId));
}
