import { and, eq, gt, isNull } from "drizzle-orm";
import { syncNotes } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

const NOTE_TTL_MS = 7 * 24 * 60 * 60_000;

export type SyncNoteKind =
  | "kept_local_change" | "adopted_coros_change" | "adopted_coros_edit" | "adopted_coros_removal"
  | "race_move_rejected"
  /** A sent program session changed in COROS; the app kept its version (Phase 3, spec §4.5). Dismiss only. */
  | "watch_copy_changed"
  /** A sent program session's copy was deleted in COROS; its address is cleared, the slot stays (§4.5). Dismiss only. */
  | "watch_copy_removed";

/** Note kinds that only inform: there is nothing to undo (the undo route answers 422 `not_undoable`). */
export const DISMISS_ONLY_NOTE_KINDS: readonly SyncNoteKind[] = ["watch_copy_changed", "watch_copy_removed"];

export async function postSyncNote(
  db: Db,
  input: { userId: string; workoutId?: string; kind: SyncNoteKind; payload: Record<string, unknown> },
): Promise<string> {
  const now = nowInstant();
  const id = newId();
  await db.insert(syncNotes).values({
    id,
    userId: input.userId,
    workoutId: input.workoutId ?? null,
    kind: input.kind,
    payload: input.payload,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + NOTE_TTL_MS).toISOString(),
  });
  return id;
}

export async function activeSyncNotes(
  db: Db,
  userId: string,
): Promise<Array<typeof syncNotes.$inferSelect>> {
  return db
    .select()
    .from(syncNotes)
    .where(
      and(
        eq(syncNotes.userId, userId),
        isNull(syncNotes.dismissedAt),
        gt(syncNotes.expiresAt, nowInstant()),
      ),
    );
}

export async function dismissSyncNote(db: Db, userId: string, noteId: string): Promise<void> {
  await db
    .update(syncNotes)
    .set({ dismissedAt: nowInstant() })
    .where(and(eq(syncNotes.id, noteId), eq(syncNotes.userId, userId)));
}
