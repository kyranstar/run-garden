import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { plannedWorkouts, syncIntents } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

export type IntentSource =
  | "user_move" | "calendar_drag" | "studio_push" | "studio_retire"
  | "remove_from_plan" | "auto_resolve" | "undo" | "coach_ease" | "coach_remove"
  /** A structured run re-timed by the rule (coach-apply.ts `writeRetimed`): the app's claim on the re-timed session. A
   * length alone claims nothing — on a row taking the watch's version neither (review A4). */
  | "coach_adjust"
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
 * Where a content intent says the athlete chose to LEAVE THE WATCH AS IT IS (`$.left`, an instant): an app-built
 * session — a programme's, an on-demand one, a Studio or template workout — whose earlier copy on the watch no
 * rewrite from here can replace, and whose content the import never takes from the wire. The intent stays OPEN (the
 * two still differ, and the row still says "Older on watch"); the account line just stops counting it. A new claim (a
 * new change to the session) supersedes it, so a new divergence counts again.
 */
export const LEFT_PATH = "$.left";

/** An open content intent the athlete left as it is (`LEFT_PATH`). `json_valid` first and in a CASE, so a payload
 * that is not JSON — none is written so — can never throw: it is simply not left. */
export function leftAsItIs(): SQL {
  return sql`(case when json_valid(${syncIntents.payload}) then json_extract(${syncIntents.payload}, ${LEFT_PATH}) end) is not null`;
}

/**
 * THE APP'S OPEN CONTENT CLAIMS on workouts still in the plan, in one read: `open`, every workout with an open,
 * un-superseded `content` intent — the whole signal behind `deriveWorkoutSync`'s `content_stale` (which the route
 * narrows to sessions still to run) and the Plan's choice of which copy of the stages is the app's — and `left`, those
 * of them the athlete left as they are (`LEFT_PATH`).
 *
 * A content intent stays open until something rewrites COROS — `coach_update_workout`, enqueued by `coach-apply.ts`'s
 * `enqueueContentConvergence` and resolved by the write consumer when the wire confirms the new content — or until the
 * athlete keeps the watch's version (`watch-version.ts`), which releases it so the next read takes the wire's copy.
 *
 * Archived workouts are excluded on the same principle `issueCount` already uses: a divergence behind a session that
 * has been removed from the plan is not divergence the athlete can see or care about.
 */
export async function contentClaims(db: Db, userId: string): Promise<{ open: Set<string>; left: Set<string> }> {
  const rows = await db
    .select({ targetId: syncIntents.targetId, left: sql<number>`${leftAsItIs()}` })
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
  const open = new Set<string>();
  const left = new Set<string>();
  for (const r of rows) {
    open.add(r.targetId);
    if (Boolean(r.left)) left.add(r.targetId);
  }
  return { open, left };
}

/** This workout's open, un-superseded content intents: one statement, one bound id. */
function openClaimsOf(userId: string, workoutId: string): SQL {
  return and(
    eq(syncIntents.userId, userId),
    eq(syncIntents.targetId, workoutId),
    eq(syncIntents.kind, "content"),
    isNull(syncIntents.resolvedAt),
    isNull(syncIntents.supersededBy),
  )!;
}

/** Release this workout's open content claims, the ordinary way a converged rewrite does: resolved. One statement. */
export async function releaseContentClaims(db: Db, userId: string, workoutId: string, now: string): Promise<void> {
  await db.update(syncIntents).set({ resolvedAt: now }).where(openClaimsOf(userId, workoutId));
}

/** Mark this workout's open content claims as left as they are (`LEFT_PATH`), keeping them open. One statement. */
export async function leaveContentClaims(db: Db, userId: string, workoutId: string, now: string): Promise<void> {
  await db
    .update(syncIntents)
    .set({ payload: sql`json_set(case when json_valid(${syncIntents.payload}) then ${syncIntents.payload} else '{}' end, ${LEFT_PATH}, ${now})` })
    .where(openClaimsOf(userId, workoutId));
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
