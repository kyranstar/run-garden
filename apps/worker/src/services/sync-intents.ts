import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { plannedWorkouts, syncIntents } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

export type IntentSource =
  | "user_move" | "calendar_drag" | "studio_push" | "studio_retire"
  | "remove_from_plan" | "auto_resolve" | "undo" | "coach_ease" | "coach_remove"
  /** An adaptive program's re-placement retracting a slot it no longer wants. */
  | "program_replace";

export interface RecordIntentInput {
  userId: string;
  targetKind: "workout" | "studio_session";
  targetId: string;
  /** "content" is the app's claim on a session's CONTENT: an approved coach ease
   * must survive every future COROS snapshot, so import rule 7 skips restoring
   * rows with an open content intent (audit#3 D1). It used to be documented as
   * never resolving, because nothing on COROS could confirm content — a verified
   * `coach_update_workout` is that confirmation, and closes it. */
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
 * Why a content claim was closed with NOTHING WRITTEN TO THE WATCH — kept on the intent itself, in its payload
 * (`$.closedBecause`), because a close of this kind is not the close a verified rewrite makes:
 *
 *  · `past`, `completed`, `missed`, `skipped`, `archived` — the session's story is over, so its watch copy is a record
 *    and the divergence can never be acted on (`closeMootContentClaims`, the hourly's housekeeping);
 *  · `kept_watch_version` — the athlete chose to leave the watch as it is (`keepWatchVersion`).
 *
 * Either way the app's copy is still the app's: the watch never caught up with it. So a claim closed like this still
 * HOLDS the content for everything that asks "whose content is this" (`contentClaimHeld`) — the import's rule 7 and
 * its sport-flip check, the Plan's choice of which stages to read — and stops counting only as a divergence: the
 * account line, the row's "Older on watch", the operator's convergence evidence and the imported-row ownership proof
 * read OPEN intents alone, as before.
 */
export type ContentClaimClosedBecause = "past" | "completed" | "missed" | "skipped" | "archived" | "kept_watch_version";

/** Where `ContentClaimClosedBecause` lives on the intent. */
export const CLOSED_BECAUSE_PATH = "$.closedBecause";

/**
 * A content intent that still CLAIMS its session's content for the app: open, or closed with nothing written
 * (`closedBecause`). Not superseded. `json_valid` first and in a CASE, so a payload that is not JSON — none is written
 * so, but the import reads this — can never throw: it is simply not a closed claim.
 */
export function contentClaimHeld(): SQL {
  return and(
    isNull(syncIntents.supersededBy),
    or(
      isNull(syncIntents.resolvedAt),
      sql`(case when json_valid(${syncIntents.payload}) then json_extract(${syncIntents.payload}, ${CLOSED_BECAUSE_PATH}) end) is not null`,
    ),
  )!;
}

/**
 * Close these open content intents with NOTHING WRITTEN, saying why (`ContentClaimClosedBecause`): one statement. Only
 * an intent still open and not superseded is touched, so a close that lost a race to a verified rewrite (which closes
 * it as a convergence) changes nothing. The reason merges into the payload; what was there stays.
 */
export async function closeContentClaims(
  db: Db,
  userId: string,
  intentIds: readonly string[],
  because: ContentClaimClosedBecause,
  now: string,
): Promise<void> {
  if (intentIds.length === 0) return;
  await db
    .update(syncIntents)
    .set({
      resolvedAt: now,
      payload: sql`json_set(case when json_valid(${syncIntents.payload}) then ${syncIntents.payload} else '{}' end, ${CLOSED_BECAUSE_PATH}, ${because})`,
    })
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.kind, "content"),
        inArray(syncIntents.id, [...intentIds]),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
}

/**
 * THE APP'S CONTENT CLAIMS on workouts still in the plan, in one read — two sets, because they answer two questions:
 *
 *  · `held` — whose content is this? Every content intent that still claims it (`contentClaimHeld`): open, or closed
 *    with nothing written. `routes/plan.ts` reads its stored stages as the app's rather than the wire's for these, and
 *    that stays true after the session is done — a past session keeps being rendered from the copy it was.
 *  · `open` — is there a divergence the athlete can still do something about? Open intents only: the whole signal
 *    behind `deriveWorkoutSync`'s `content_stale` (which the route narrows further to sessions still to run).
 *
 * A content intent stays open until something rewrites COROS — `coach_update_workout`, enqueued by `coach-apply.ts`'s
 * `enqueueContentConvergence` and resolved by the write consumer when the wire confirms the new content — or until
 * the divergence stops mattering (`closeContentClaims`).
 *
 * Archived workouts are excluded on the same principle `issueCount` already uses: a divergence behind a session that
 * has been removed from the plan is not divergence the athlete can see or care about.
 */
export async function contentClaims(db: Db, userId: string): Promise<{ held: Set<string>; open: Set<string> }> {
  const rows = await db
    .select({ targetId: syncIntents.targetId, resolvedAt: syncIntents.resolvedAt })
    .from(syncIntents)
    .innerJoin(plannedWorkouts, eq(syncIntents.targetId, plannedWorkouts.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "content"),
        contentClaimHeld(),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  const held = new Set<string>();
  const open = new Set<string>();
  for (const r of rows) {
    held.add(r.targetId);
    if (r.resolvedAt === null) open.add(r.targetId);
  }
  return { held, open };
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
