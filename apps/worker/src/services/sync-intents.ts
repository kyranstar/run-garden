import { and, eq, isNull } from "drizzle-orm";
import { plannedWorkouts, syncIntents } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

export type IntentSource =
  | "user_move" | "calendar_drag" | "studio_push" | "studio_retire"
  | "remove_from_plan" | "auto_resolve" | "undo" | "coach_ease";

export interface RecordIntentInput {
  userId: string;
  targetKind: "workout" | "studio_session";
  targetId: string;
  /** "content" is the app's permanent claim on a session's CONTENT: an
   * approved coach ease must survive every future COROS snapshot, so import
   * rule 7 skips restoring rows with an open content intent (audit#3 D1).
   * It deliberately never resolves — nothing on COROS can confirm it. */
  kind: "move" | "create" | "delete" | "remove_local" | "restore" | "content";
  payload?: Record<string, unknown>;
  source: IntentSource;
}

/** Append an intent; any open intent of the same (target, kind) is superseded. */
export async function recordIntent(db: Db, input: RecordIntentInput): Promise<string> {
  const now = nowInstant();
  const id = newId();
  await db
    .update(syncIntents)
    .set({ supersededBy: id })
    .where(
      and(
        eq(syncIntents.userId, input.userId),
        eq(syncIntents.targetId, input.targetId),
        eq(syncIntents.kind, input.kind),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
  await db.insert(syncIntents).values({
    id,
    userId: input.userId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    kind: input.kind,
    payload: input.payload ?? null,
    source: input.source,
    createdAt: now,
  });
  return id;
}

export async function openIntentFor(
  db: Db,
  userId: string,
  targetId: string,
  kind?: string,
): Promise<typeof syncIntents.$inferSelect | null> {
  const rows = await db
    .select()
    .from(syncIntents)
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetId, targetId),
        ...(kind ? [eq(syncIntents.kind, kind)] : []),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows[0] ?? null;
}

export async function resolveIntent(db: Db, intentId: string, now: string): Promise<void> {
  await db.update(syncIntents).set({ resolvedAt: now }).where(eq(syncIntents.id, intentId));
}

export async function openMoveIntents(
  db: Db,
  userId: string,
): Promise<Array<typeof syncIntents.$inferSelect>> {
  return db
    .select()
    .from(syncIntents)
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "move"),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
}

/**
 * Workout ids whose CONTENT Run Garden has rewritten since COROS was last
 * given them — the ids of open, un-superseded `content` intents on workouts
 * that are still in the plan.
 *
 * This is the whole signal behind `deriveWorkoutSync`'s `content_stale` and
 * the account line's `contentStaleCount`. A content intent never resolves (see
 * `RecordIntentInput.kind`), so a session stays divergent until something
 * rewrites COROS — which today nothing does, because there is no content-write
 * job kind. That is a real, permanent fact about the athlete's watch and the
 * reason it must be said out loud rather than counted as an "issue" with a
 * Retry button that cannot help.
 *
 * Archived workouts are excluded on the same principle `issueCount` already
 * uses: a divergence behind a session that has been removed from the plan is
 * not divergence the athlete can see or care about.
 */
export async function openContentIntentTargets(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ targetId: syncIntents.targetId })
    .from(syncIntents)
    .innerJoin(plannedWorkouts, eq(syncIntents.targetId, plannedWorkouts.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "content"),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}

/**
 * Every date the APP itself asked a workout to move to (open or resolved),
 * keyed by the workout's COROS wire id. The studio drift check uses this to
 * recognize its own account's moves instead of calling them user edits.
 */
export async function appRequestedDates(db: Db, userId: string): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({
      sourceWorkoutId: plannedWorkouts.sourceWorkoutId,
      payload: syncIntents.payload,
    })
    .from(syncIntents)
    .innerJoin(plannedWorkouts, eq(syncIntents.targetId, plannedWorkouts.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "move"),
      ),
    );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const toDate = r.payload?.["toDate"];
    if (typeof toDate !== "string") continue;
    const set = map.get(r.sourceWorkoutId) ?? new Set<string>();
    set.add(toDate);
    map.set(r.sourceWorkoutId, set);
  }
  return map;
}
