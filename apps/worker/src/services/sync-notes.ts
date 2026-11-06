import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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
  | "watch_copy_removed"
  /**
   * A sent program session's copy was moved in COROS; the slot followed it (`{ previousDate, newDate }`). Dismiss only
   * (ruling 3-R15): moving a sent session back takes its copy off the watch (3-R3), which no Undo may do.
   */
  | "watch_copy_moved"
  /** Today's course session couldn't be written: the day refused its document, so it stays an outline (`{ sessionTitle, date }`). Dismiss only. */
  | "course_session_refused";

/** Note kinds that only inform: there is nothing to undo (the undo route answers 422 `not_undoable`). */
export const DISMISS_ONLY_NOTE_KINDS: readonly SyncNoteKind[] = ["watch_copy_changed", "watch_copy_removed", "watch_copy_moved", "course_session_refused"];

/**
 * Post a note. `id`: the note's own, when something repeats and should say so once (a second post of it writes nothing).
 * `expiresAt`: when what it says stops being true, if that's sooner than a note's week.
 */
export async function postSyncNote(
  db: Db,
  input: { id?: string; userId: string; workoutId?: string; kind: SyncNoteKind; payload: Record<string, unknown>; expiresAt?: string },
): Promise<string> {
  const now = nowInstant();
  const id = input.id ?? newId();
  await db
    .insert(syncNotes)
    .values({
      id,
      userId: input.userId,
      workoutId: input.workoutId ?? null,
      kind: input.kind,
      payload: input.payload,
      createdAt: now,
      expiresAt: input.expiresAt ?? new Date(Date.parse(now) + NOTE_TTL_MS).toISOString(),
    })
    .onConflictDoNothing();
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

/**
 * Dismiss a studio plan's open notes of sessions edited or removed on COROS: the plan is retired, so there is nothing
 * to undo (its undo answers `plan_retired`). One statement.
 */
export async function dismissStudioPlanNotes(db: Db, userId: string, studioPlanId: string): Promise<void> {
  await db
    .update(syncNotes)
    .set({ dismissedAt: nowInstant() })
    .where(
      and(
        eq(syncNotes.userId, userId),
        isNull(syncNotes.dismissedAt),
        inArray(syncNotes.kind, ["adopted_coros_edit", "adopted_coros_removal"]),
        sql`json_extract(${syncNotes.payload}, '$.studioPlanId') = ${studioPlanId}`,
      ),
    );
}

/** Dismiss a workout's open notes of one kind — what they said is no longer true. */
export async function dismissSyncNotesOf(db: Db, userId: string, workoutId: string, kind: SyncNoteKind): Promise<void> {
  await db
    .update(syncNotes)
    .set({ dismissedAt: nowInstant() })
    .where(and(eq(syncNotes.userId, userId), eq(syncNotes.workoutId, workoutId), eq(syncNotes.kind, kind), isNull(syncNotes.dismissedAt)));
}

export async function dismissSyncNote(db: Db, userId: string, noteId: string): Promise<void> {
  await db
    .update(syncNotes)
    .set({ dismissedAt: nowInstant() })
    .where(and(eq(syncNotes.id, noteId), eq(syncNotes.userId, userId)));
}
