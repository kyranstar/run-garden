/**
 * STORED BUILDS (Phase 2 spec §2b "Client storage"): `builds` holds, per slot, the build and view the session sheet
 * or the player last loaded. Once a session has started the player reads its build from here, never the network
 * (ruling 2b-R1: Start needs the network, everything after it works offline).
 */
import type { SessionBuildDto, SessionDto, SessionViewDto } from "@rg/api-client";
import type { OfflineDb } from "./idb.js";

export interface StoredSessionBuild {
  workoutId: string;
  build: SessionBuildDto;
  view: SessionViewDto;
  /** Epoch ms. */
  savedAt: number;
}

/** Keep the session's build and view; a session with none (an outline) leaves what is stored alone. */
export async function saveBuild(
  db: OfflineDb,
  session: Pick<SessionDto, "workoutId" | "build" | "view">,
  now: number = Date.now(),
): Promise<void> {
  if (!session.build || !session.view) return;
  const stored: StoredSessionBuild = { workoutId: session.workoutId, build: session.build, view: session.view, savedAt: now };
  await db.put("builds", session.workoutId, stored);
}

export function loadBuild(db: OfflineDb, workoutId: string): Promise<StoredSessionBuild | undefined> {
  return db.get<StoredSessionBuild>("builds", workoutId);
}

export function forgetBuild(db: OfflineDb, workoutId: string): Promise<void> {
  return db.delete("builds", workoutId);
}
