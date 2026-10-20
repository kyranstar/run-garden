/**
 * AFTER START, BEFORE THE PLAYER (ruling 2b-R1, 2b-R10; audit 2b-B I-2): the one place a started session is left on this
 * device — the session sheet's Start and the Studio's Start now both come through here.
 *
 * The player plays what Start leaves on the device, never the network: the locked build, its name and the profiles.
 * The review's basis comes in the same tap, so a network gone right after Start still leaves the review its records —
 * waited for only so long (`START_BASIS_WAIT_MS`), so Start stays quick; it lands later if slow, and the player asks
 * for it itself when it is not there. False when the device could not keep the session (no IndexedDB, storage full):
 * the caller says so before the player opens, and lets the athlete go on online. Its music (what resolved at Start, if
 * anything) goes with it, for the player to play as the session begins.
 */
import { api, type SessionDto } from "@rg/api-client";
import type { WorkoutTarget } from "../music/controller.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { rememberStart, saveBasis } from "../player/stored.js";

/** How long Start waits for the review's basis before the player opens (ruling 2b-R10: Start stays quick). */
export const START_BASIS_WAIT_MS = 1_500;

export async function keepStarted(session: SessionDto, title: string, userId: string | null, music: WorkoutTarget | null = null): Promise<boolean> {
  let db: OfflineDb;
  try {
    db = await offlineDb();
    await rememberStart(db, session, title, userId, Date.now(), music);
  } catch {
    return false;
  }
  const buildId = session.build?.buildId;
  const basis = api
    .reviewBasis(session.workoutId)
    .then((b) => (b.buildId === buildId ? saveBasis(db, session.workoutId, b) : undefined))
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([basis, new Promise<void>((resolve) => (timer = setTimeout(resolve, START_BASIS_WAIT_MS)))]);
  clearTimeout(timer);
  return true;
}
