import { and, eq, gt, isNull } from "drizzle-orm";
import { syncNotes } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

const NOTE_TTL_MS = 7 * 24 * 60 * 60_000;

export type SyncNoteKind =
  | "kept_local_change" | "adopted_coros_change" | "adopted_coros_edit" | "adopted_coros_removal";

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
