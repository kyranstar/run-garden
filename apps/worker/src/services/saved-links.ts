/**
 * PASTED LINKS (design 2026-11-05 §3.1, §5.1, §6.3, §15.2): a YouTube video or an Instagram post pasted in the
 * extension's popup or the app's field. The link waits here (`saved_links`) until the computer's extension reads it —
 * the work list hands it out as `read` (saves-ledger.ts `workList`, `?v=2`); once read, its post is the truth, and the
 * two meet by id (a link's id is its post's id-to-be, `savedPostId`).
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { linkState, normalizeLink, type LinkDto } from "@rg/saves";
import type { Db } from "./db.js";
import { savedPostId } from "./saves-ledger.js";

const { savedLinks, savedPosts } = schema;

export const LINKS_LISTED = 20;

export type AddLinkResult =
  | { ok: false; error: "not_a_link" }
  | { ok: true; state: "known"; postId: string; firstSeenAt: string }
  | { ok: true; state: "added"; link: LinkDto };

/**
 * Take a pasted link. One already imported answers `known` (with when); a new one waits (`waiting`); one that failed
 * waits again (pasting it again is the retry); one waiting stays as it is. At most 3 statements.
 */
export async function addLink(db: Db, userId: string, input: string, from: "extension" | "app", now: string): Promise<AddLinkResult> {
  const link = normalizeLink(input);
  if (!link) return { ok: false, error: "not_a_link" };
  const id = await savedPostId(userId, link.source, link.key);
  const [post] = await db
    .select({ id: savedPosts.id, firstSeenAt: savedPosts.firstSeenAt })
    .from(savedPosts)
    .where(and(eq(savedPosts.id, id), eq(savedPosts.userId, userId)))
    .limit(1);
  if (post) return { ok: true, state: "known", postId: post.id, firstSeenAt: post.firstSeenAt };
  let [row] = await db
    .insert(savedLinks)
    .values({ id, userId, source: link.source, sourceKey: link.key, url: link.url, addedFrom: from, status: "waiting", addedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: savedLinks.id,
      set: { status: "waiting", errorCode: null, error: null, updatedAt: now },
      setWhere: and(eq(savedLinks.userId, userId), eq(savedLinks.status, "failed")),
    })
    .returning();
  row ??= (await db.select().from(savedLinks).where(and(eq(savedLinks.id, id), eq(savedLinks.userId, userId))).limit(1))[0];
  if (!row) throw new Error("saved link vanished after upsert");
  return { ok: true, state: "added", link: toDto({ ...row, postStatus: null, title: null, lastErrorCode: null, lastError: null, watchVideo: null, moves: null, batchId: null }) };
}

interface LinkRow {
  id: string;
  source: string;
  sourceKey: string;
  url: string;
  addedFrom: "extension" | "app";
  status: string;
  errorCode: string | null;
  error: string | null;
  addedAt: string;
  postStatus: string | null;
  title: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  watchVideo: unknown;
  moves: number | null;
  batchId: string | null;
}

function toDto(r: LinkRow): LinkDto {
  const post = r.postStatus
    ? { status: r.postStatus, lastErrorCode: r.lastErrorCode, lastError: r.lastError, moves: Number(r.moves ?? 0), watchVideo: r.watchVideo === 1 || r.watchVideo === true }
    : null;
  const { state, words, action } = linkState({ status: r.status, addedFrom: r.addedFrom, errorCode: r.errorCode, error: r.error }, post);
  return {
    id: r.id, source: r.source, key: r.sourceKey, url: r.url, title: r.title, addedAt: r.addedAt, addedFrom: r.addedFrom,
    postId: post ? r.id : null, state, words, moves: post && r.postStatus === "matched" ? Number(r.moves ?? 0) : null, action,
    batchId: post ? (r.batchId ?? null) : null,
  };
}

/**
 * The account's recent links, newest first, each with where it stands (its post's status once read) and the batch its
 * moves are in (none yet: waiting for the next; audit 2026-11-06, I6). ONE statement.
 */
export async function listLinks(db: Db, userId: string, limit: number = LINKS_LISTED): Promise<LinkDto[]> {
  const rows = (await db.all(sql`SELECT l.id AS id, l.source AS source, l.source_key AS sourceKey, l.url AS url, l.added_from AS addedFrom,
      l.status AS status, l.error_code AS errorCode, l.error AS error, l.added_at AS addedAt,
      p.status AS postStatus, p.title AS title, p.last_error_code AS lastErrorCode, p.last_error AS lastError, p.watch_video AS watchVideo,
      (SELECT count(DISTINCT m.move_id) FROM saved_post_moves m WHERE m.user_id = l.user_id AND m.post_id = l.id AND m.status <> 'removed') AS moves,
      (SELECT max(m.batch_id) FROM saved_post_moves m WHERE m.user_id = l.user_id AND m.post_id = l.id AND m.status <> 'removed') AS batchId
    FROM saved_links l LEFT JOIN saved_posts p ON p.id = l.id AND p.user_id = l.user_id
    WHERE l.user_id = ${userId}
    ORDER BY l.added_at DESC, l.id LIMIT ${limit}`)) as LinkRow[];
  return rows.map(toDto);
}
