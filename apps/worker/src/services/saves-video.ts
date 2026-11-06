/**
 * WATCH IT TOO (design 2026-11-05 §5.4, §14.4): a video over 20 minutes is read from its words only; the owner can ask
 * for it to be read again with the video watched, at the cost the trail shows. The ask puts the post back in the queue
 * (`watch_video` set) and the computer's extension picks it up from its work list within about 15 minutes; until then
 * the trail and the link say so.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "./db.js";
import { runAtomicallyClaim } from "./db.js";
import { summaryLine } from "./import-trail.js";
import { messagesCostMicros } from "./llm-messages.js";
import { notFittingSql } from "./saves-batches.js";
import { EXTRACT_MODEL_DEFAULT, VIDEO_TOKENS_PER_SEC, WATCH_MAX_SEC } from "./saves-relay.js";

const { savedPosts, savedPostMoves, personalMoves, importEvents } = schema;

/** What watching a video of this length typically costs: 100 prompt tokens a second and a typical reading's reply. */
export function watchCostMicros(model: string, durationSec: number): number {
  return messagesCostMicros(model, { inputTokens: VIDEO_TOKENS_PER_SEC * durationSec, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_500 });
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * Whether a post may be watched too, in SQL (every write of the ask carries it, so a race writes nothing): a YouTube
 * post, read (`matched`) or failed, not yet asked, not seen, none of its moves saved, and its batch not being fitted in.
 */
function watchable(userId: string, postId: string, now: string): SQL {
  return sql`exists (select 1 from saved_posts w where w.id = ${postId} and w.user_id = ${userId} and w.source = 'youtube'
    and w.status in ('matched', 'failed') and coalesce(w.watch_video, 0) = 0 and coalesce(w.video_seen, 0) = 0
    and not exists (select 1 from saved_post_moves ws where ws.user_id = ${userId} and ws.post_id = w.id and ws.status = 'saved')
    and (w.batch_id is null or not exists (select 1 from save_batches wb where wb.id = w.batch_id and wb.user_id = ${userId}
      and not ${notFittingSql("wb", now)})))`;
}

/**
 * The owner's Watch it too: the post's pending links go (and its pending moves no other post names), its reading and
 * batch are cleared, and it waits `queued` with `watch_video` for the extension. "conflict" when it can't be (not a
 * YouTube post, a move of it saved, already asked or seen, being fitted in). Two statements, the second a batch of four.
 */
export async function watchVideo(db: Db, userId: string, postId: string, now: string): Promise<"ok" | "not_found" | "conflict"> {
  const [p] = await db
    .select({ durationSec: savedPosts.durationSec })
    .from(savedPosts)
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId)))
    .limit(1);
  if (!p) return "not_found";
  const gate = watchable(userId, postId, now);
  const cost = p.durationSec ? ` (about ${dollars(watchCostMicros(EXTRACT_MODEL_DEFAULT, p.durationSec))})` : "";
  const summary = summaryLine(`You asked for the video to be watched too${cost}`);
  const detail = JSON.stringify({ action: "watch", durationSec: p.durationSec ?? null });
  const claimed = await runAtomicallyClaim(db, [
    db.insert(importEvents).select(
      sql`SELECT lower(hex(randomblob(16))), ${userId}, ${postId}, NULL, NULL, 'choice', 'owner', 'info', ${summary}, ${detail},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ${now} WHERE ${gate}`,
    ),
    db.delete(personalMoves).where(
      and(
        eq(personalMoves.userId, userId),
        eq(personalMoves.status, "pending"),
        sql`${personalMoves.id} in (select move_id from saved_post_moves where user_id = ${userId} and post_id = ${postId} and status = 'pending' and move_kind = 'personal')`,
        sql`not exists (select 1 from saved_post_moves o where o.user_id = ${userId} and o.move_id = ${personalMoves.id} and o.post_id <> ${postId} and o.status <> 'removed')`,
        gate,
      ),
    ),
    db
      .update(savedPostMoves)
      .set({ status: "removed" })
      .where(and(eq(savedPostMoves.userId, userId), eq(savedPostMoves.postId, postId), eq(savedPostMoves.status, "pending"), gate)),
    db
      .update(savedPosts)
      .set({ status: "queued", watchVideo: true, extraction: null, batchId: null, extractAttempts: 0, lastErrorCode: null, lastError: null, updatedAt: now })
      .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId), gate))
      .returning({ id: savedPosts.id }),
  ]);
  return claimed > 0 ? "ok" : "conflict";
}

/** A video's line on its trail: whether it was (or will be) watched, the owner's ask, and whether to offer it. */
export function videoOfTrail(
  p: { source: string; status: string; durationSec: number | null; videoSeen: boolean | null; watchVideo: boolean | null },
  anySaved: boolean,
  model: string,
): { watched: boolean | null; watchAsked: boolean; offerWatch: boolean; watchCostMicros: number | null } | null {
  if (p.source !== "youtube") return null;
  const asked = p.watchVideo === true;
  const long = p.durationSec !== null && p.durationSec > WATCH_MAX_SEC;
  return {
    watched: p.durationSec === null ? null : asked || !long,
    watchAsked: asked,
    offerWatch: long && !asked && p.videoSeen !== true && (p.status === "matched" || p.status === "failed") && !anySaved,
    watchCostMicros: p.durationSec ? watchCostMicros(model, p.durationSec) : null,
  };
}
