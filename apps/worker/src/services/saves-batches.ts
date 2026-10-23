/**
 * BATCHES (saved-posts import, Task 8; spec §4 calls 8–9, §6). Matched posts wait, unbatched, until a check finishes;
 * then `assembleBatch` gathers them into one batch — at most one released per `BATCH_GAP_MS`, so the coach brings the
 * saves up at most once a day and a week's saves after a gap arrive as one batch with one notice. While
 * `SAVES_HOLD_BATCHES` is "1" a batch is created `held` (the bootstrap's batches wait for the lead's curation).
 *
 * Nothing in a batch is usable until the owner saves it: its new moves stay `pending` and its links `pending`, and
 * `exercise_provenance` (what the Studio's "from your saves", the engine's bonus and the coach's "saved" read) is
 * written only by `saveBatch`. Both run in a constant number of set-based statements, however big the batch.
 */
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { batchNotice } from "@rg/saves";
import type { Env } from "../env.js";
import { forgetAccountLibrary } from "./account-library.js";
import { runAtomically, type Db } from "./db.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, exerciseProvenance } = schema;

/** The least time between two released batches. */
export const BATCH_GAP_MS = 20 * 3_600_000;

const parseList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The batch's notice from its moves, as `batchNotice` words it: a move is new when it is a personal move still pending,
 * and one the owner already had otherwise (the library's, or a personal move saved before). Each move counts once.
 */
function noticeOf(
  rows: readonly { moveId: string | null; moveKind: string | null; moveStatus: string | null; regions: unknown; contraction: unknown }[],
): string {
  const fresh = new Map<string, Pick<ExerciseRecord, "regions" | "contraction">>();
  const had = new Set<string>();
  for (const r of rows) {
    if (!r.moveId) continue;
    if (r.moveKind === "personal" && r.moveStatus === "pending") {
      if (!fresh.has(r.moveId)) {
        fresh.set(r.moveId, {
          regions: parseList(r.regions) as ExerciseRecord["regions"][number][],
          contraction: parseList(r.contraction) as ExerciseRecord["contraction"][number][],
        });
      }
    } else had.add(r.moveId);
  }
  return batchNotice([...fresh.values()], had.size);
}

/**
 * Gather the account's matched, unbatched posts into a new batch. Null — and nothing written — when a batch was
 * released less than `BATCH_GAP_MS` ago, or no waiting post brought a move. A released batch carries its notice; a held
 * one gets it on release. The batch is stamped on its posts, their pending links and the pending personal moves those
 * links made; the batch row itself is written only if a post took it (two finishes at once make one batch).
 * D1 statements: the gate 1, the waiting moves 1, then one transaction of 4. ≤ 6.
 */
export async function assembleBatch(db: Db, env: Env, userId: string, now: string): Promise<string | null> {
  const [last] = await db
    .select({ at: sql<string | null>`max(${saveBatches.releasedAt})` })
    .from(saveBatches)
    .where(eq(saveBatches.userId, userId));
  if (last?.at && Date.parse(now) - Date.parse(last.at) < BATCH_GAP_MS) return null;

  const waiting = await db
    .select({
      postId: savedPosts.id,
      moveId: savedPostMoves.moveId,
      moveKind: savedPostMoves.moveKind,
      moveStatus: personalMoves.status,
      regions: sql<unknown>`json_extract(${personalMoves.record}, '$.regions')`,
      contraction: sql<unknown>`json_extract(${personalMoves.record}, '$.contraction')`,
    })
    .from(savedPosts)
    .leftJoin(
      savedPostMoves,
      and(eq(savedPostMoves.postId, savedPosts.id), eq(savedPostMoves.userId, userId), eq(savedPostMoves.status, "pending")),
    )
    .leftJoin(personalMoves, and(eq(personalMoves.id, savedPostMoves.moveId), eq(personalMoves.userId, userId)))
    .where(and(eq(savedPosts.userId, userId), eq(savedPosts.status, "matched"), isNull(savedPosts.batchId)));
  if (!waiting.some((r) => r.moveId)) return null;

  const id = newId();
  const held = env.SAVES_HOLD_BATCHES === "1";
  const postIds = JSON.stringify([...new Set(waiting.map((r) => r.postId))]);
  const batch: typeof saveBatches.$inferInsert = {
    id,
    userId,
    status: held ? "held" : "released",
    theme: null,
    createdAt: now,
    releasedAt: held ? null : now,
    savedAt: null,
    fittedAt: null,
    notice: held ? null : noticeOf(waiting),
  };
  // `INSERT … SELECT <row> WHERE <a post took the batch>`: every column in the table's order (none is generated),
  // through its own mapping.
  const values = Object.entries(getTableColumns(saveBatches)).map(([key, col]) =>
    sql.param((batch as Record<string, unknown>)[key] ?? null, col),
  );
  await runAtomically(db, [
    db
      .update(savedPosts)
      .set({ batchId: id })
      .where(
        and(
          eq(savedPosts.userId, userId),
          eq(savedPosts.status, "matched"),
          isNull(savedPosts.batchId),
          sql`${savedPosts.id} IN (SELECT value FROM json_each(${postIds}))`,
        ),
      ),
    db
      .update(savedPostMoves)
      .set({ batchId: id })
      .where(
        and(
          eq(savedPostMoves.userId, userId),
          eq(savedPostMoves.status, "pending"),
          isNull(savedPostMoves.batchId),
          sql`${savedPostMoves.postId} IN (SELECT ${savedPosts.id} FROM ${savedPosts} WHERE ${savedPosts.userId} = ${userId} AND ${savedPosts.batchId} = ${id})`,
        ),
      ),
    db
      .update(personalMoves)
      .set({ batchId: id })
      .where(
        and(
          eq(personalMoves.userId, userId),
          eq(personalMoves.status, "pending"),
          isNull(personalMoves.batchId),
          sql`${personalMoves.id} IN (SELECT ${savedPostMoves.moveId} FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.batchId} = ${id} AND ${savedPostMoves.moveKind} = 'personal')`,
        ),
      ),
    db
      .insert(saveBatches)
      .select(
        sql`SELECT ${sql.join(values, sql`, `)} WHERE EXISTS (SELECT 1 FROM ${savedPosts} WHERE ${savedPosts.userId} = ${userId} AND ${savedPosts.batchId} = ${id})`,
      ),
  ]);
  return id;
}

/** The import's own key space in `exercise_provenance`: never a curated link's `<code>#<index>`. */
export const IMPORT_KEY_PREFIX = "imp:";

/**
 * The owner's "Save these":
 *  - the pending personal moves a kept (pending) link of the batch names become `active` — one the owner removed or
 *    re-matched away (no kept link names it) stays pending and is never offered; a pending move an earlier, unsaved
 *    batch brought is activated when this batch keeps a link to it;
 *  - each kept link is written to `exercise_provenance` (`exercise_id` = the move, `source_type` = the post's source,
 *    `source_key` = "imp:" + the post's key + "#" + position, url, creator) unless the account already links that move
 *    to that post (a curated link stays exactly as it is, and a move never lists one post twice). Insert-only: an
 *    import never rewrites a provenance row;
 *  - the links become `saved`, the batch `saved`.
 * A removed link is left out. Null for a batch that isn't this account's; a batch already saved (or dismissed) changes
 * nothing. D1 statements: the batch and its counts 1, then one transaction of 4 — set-based, so the same 5 for 6 links
 * or 600.
 */
export async function saveBatch(
  db: Db,
  userId: string,
  batchId: string,
  now: string,
): Promise<{ moves: number; links: number } | null> {
  const pendingLinks = and(
    eq(savedPostMoves.userId, userId),
    eq(savedPostMoves.batchId, batchId),
    eq(savedPostMoves.status, "pending"),
  );
  const movesToKeep = and(
    eq(personalMoves.userId, userId),
    eq(personalMoves.status, "pending"),
    sql`${personalMoves.id} IN (SELECT ${savedPostMoves.moveId} FROM ${savedPostMoves} WHERE ${pendingLinks} AND ${savedPostMoves.moveKind} = 'personal')`,
  );
  const [batch] = await db
    .select({
      status: saveBatches.status,
      moves: sql<number>`(SELECT count(*) FROM ${personalMoves} WHERE ${movesToKeep})`,
      links: sql<number>`(SELECT count(*) FROM ${savedPostMoves} WHERE ${pendingLinks})`,
    })
    .from(saveBatches)
    .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId)))
    .limit(1);
  if (!batch) return null;
  if (batch.status === "saved" || batch.status === "dismissed") return { moves: 0, links: 0 };

  // In order: the moves and the links are read while the links are still pending; the links are marked last.
  await runAtomically(db, [
    db.update(personalMoves).set({ status: "active", updatedAt: now }).where(movesToKeep),
    // One row per kept link, except where the account already links the move to the post (`existing`) or an earlier
    // position of the same post shows the same move (`twin`). The aliased tables are named by their alias inside their
    // subquery, so the unaliased names there are the outer row's.
    db
      .insert(exerciseProvenance)
      .select(
        sql`SELECT ${savedPostMoves.id}, ${savedPostMoves.userId}, ${savedPostMoves.moveId}, ${savedPosts.source}, ${savedPosts.url},
          coalesce(nullif(${savedPosts.creatorHandle}, ''), ${savedPosts.creatorName}),
          ${IMPORT_KEY_PREFIX} || ${savedPosts.sourceKey} || '#' || ${savedPostMoves.position}, ${now}
          FROM ${savedPostMoves} JOIN ${savedPosts} ON ${savedPosts.id} = ${savedPostMoves.postId}
          WHERE ${pendingLinks} AND ${savedPosts.userId} = ${userId}
            AND NOT EXISTS (SELECT 1 FROM ${exerciseProvenance} AS existing
              WHERE existing.user_id = ${userId} AND existing.exercise_id = ${savedPostMoves.moveId} AND existing.url = ${savedPosts.url})
            AND NOT EXISTS (SELECT 1 FROM ${savedPostMoves} AS twin
              WHERE twin.user_id = ${userId} AND twin.batch_id = ${batchId} AND twin.status = 'pending'
                AND twin.post_id = ${savedPostMoves.postId} AND twin.move_id = ${savedPostMoves.moveId}
                AND twin.position < ${savedPostMoves.position})`,
      )
      .onConflictDoNothing(),
    db.update(savedPostMoves).set({ status: "saved" }).where(pendingLinks),
    db
      .update(saveBatches)
      .set({ status: "saved", savedAt: now })
      .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId))),
  ]);
  // Its moves are the library's now: a later read in this request reads them.
  forgetAccountLibrary(db, userId);
  return { moves: Number(batch.moves), links: Number(batch.links) };
}
