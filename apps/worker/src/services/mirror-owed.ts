/**
 * THE MIRROR'S OWED MARK (the watch mirrors the plan §3.2, M2), apart from the mirror itself: what every change to a
 * session writes — the Studio's add and revise, a move, an un-skip — so the drain or the sweep (mirror.ts) makes its
 * copy. A leaf: the hooks in the shared services (doc-workouts, jobs, plan-mutations) take it without the mirror's own
 * imports (session-build, watch-push), which would close an import cycle through them.
 */
import { syncIntents } from "@rg/database";
import type { Db } from "./db.js";

/** The one owed mark a workout has: `sync_intents.id`. */
export const mirrorIntentId = (workoutId: string): string => `mirror-${workoutId}`;

/**
 * Mark the workout's copy owed (M2): one INSERT into `sync_intents` (`mirror-<workoutId>`, kind `mirror`). Idempotent:
 * marked again while open, it stays one open mark (its time refreshed, so a sweep that read the row before it does not
 * resolve it); marked again after the mirror resolved it, it is open again (and what the mirror remembered of it is
 * forgotten). `coros_sync_state` is not touched.
 */
export async function markMirrorOwed(db: Db, userId: string, workoutId: string, now: string): Promise<void> {
  await db
    .insert(syncIntents)
    .values({ id: mirrorIntentId(workoutId), userId, targetKind: "workout", targetId: workoutId, kind: "mirror", payload: {}, source: "mirror", createdAt: now })
    .onConflictDoUpdate({ target: syncIntents.id, set: { resolvedAt: null, createdAt: now, payload: {} } });
}
