import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { SavedPostRow } from "@rg/database";
import type { CheckReport, PostSubmit, SaveErrorCode, SavesStatusDto, WorkItem } from "@rg/saves";
import { nowInstant } from "@rg/domain";
import { sha256Hex } from "../auth/crypto.js";
import type { Db } from "./db.js";
import { importSpend } from "./saves-budget.js";
import { CLAIM_STALE_MS } from "./saves-filter.js";

const { savedPosts, saveChecks, savedPostMoves, saveBatches } = schema;

/** A post is extracted this many times at most. */
export const MAX_EXTRACT_ATTEMPTS = 3;
/** The most posts `/work` hands out at once. */
export const WORK_LIMIT = 20;
/** A post another relay claimed (`extracting`) this long ago is a request that died; `/work` hands it out again and the relay may reclaim it. */
export const RELAY_CLAIM_STALE_MS = 10 * 60_000;
/** The most keys one `/known` call carries. */
export const KNOWN_MAX_KEYS = 200;
/**
 * Failures `/work` hands out again; the rest (gone, too_large, login_needed, feed_changed) wait for the owner. (The relay
 * also claims a `too_large` post, for the extension's immediate smaller retry — never through `/work`.)
 */
export const RETRYABLE_ERROR_CODES: readonly SaveErrorCode[] = ["media_failed", "model_failed", "app_unreachable", "budget_paused", "unknown"];


/**
 * A post's row id: a hash of the account, the source and the source's own key, formatted as a uuid. Another account's
 * key never meets this one's, and the table's primary key holds two racing submits to one row.
 */
export async function savedPostId(userId: string, source: string, key: string): Promise<string> {
  const h = await sha256Hex(`${userId}:${source}:${key}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Record a post the extension found. Idempotent by (source, key): a known post is returned as it stands, nothing is
 * rewritten. A fresh post is `seen` (the filter then moves it), or what its seed says. Two statements.
 */
export async function upsertPost(db: Db, userId: string, p: PostSubmit, now: string): Promise<SavedPostRow> {
  const id = await savedPostId(userId, p.source, p.key);
  await db
    .insert(savedPosts)
    .values({
      id,
      userId,
      source: p.source,
      sourceKey: p.key,
      url: p.url,
      creatorHandle: p.creator.handle,
      creatorName: p.creator.name ?? null,
      caption: p.caption,
      hashtags: p.hashtags,
      mediaType: p.mediaType,
      postedAt: p.postedAt ?? null,
      firstSeenAt: now,
      status: p.seed?.status ?? "seen",
      filterVerdict: p.seed ? (p.seed.status === "queued" ? "training" : "not") : null,
      filterReason: p.seed?.reason ?? null,
      filterStage: p.seed ? "seed" : null,
      seeded: !!p.seed,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [savedPosts.userId, savedPosts.source, savedPosts.sourceKey] });
  const [row] = await db.select().from(savedPosts).where(eq(savedPosts.id, id)).limit(1);
  if (!row) throw new Error("saved post vanished after upsert");
  return row;
}

/** Of `keys`, the ones this account has no row for, in input order. One statement (the keys travel as one JSON bind). */
export async function freshKeys(db: Db, userId: string, source: string, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: savedPosts.sourceKey })
    .from(savedPosts)
    .where(
      and(
        eq(savedPosts.userId, userId),
        eq(savedPosts.source, source),
        sql`${savedPosts.sourceKey} IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`,
      ),
    );
  const known = new Set(rows.map((r) => r.key));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (known.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * What the extension should pick up. `filter`: a `seen` post the filter left behind (a model failure, a budget pause
 * while the import budget has room again, or a claim older than `CLAIM_STALE_MS`): the extension re-reads it and
 * resubmits `/posts`, which runs the filter again. `extract`: queued with no extraction, or failed in a way worth
 * retrying: fetch its media. Filter work first, then oldest first; `limit` across both. Three statements (the first gives up on an exhausted stale claim).
 */
export async function workList(
  db: Db,
  userId: string,
  now: string = nowInstant(),
  limit: number = WORK_LIMIT,
): Promise<WorkItem[]> {
  const stale = new Date(new Date(now).getTime() - CLAIM_STALE_MS).toISOString();
  const { spentMicros, capMicros } = await importSpend(db, userId, new Date(now));
  const relayStale = new Date(new Date(now).getTime() - RELAY_CLAIM_STALE_MS).toISOString();
  // A claim whose request died on its last attempt is neither listed nor reclaimable (attempts are spent): give it up as
  // `failed`/`unknown`, so the owner's retry can requeue it instead of it reading "extracting" forever.
  await db
    .update(savedPosts)
    .set({ status: "failed", lastErrorCode: "unknown", updatedAt: now })
    .where(
      and(
        eq(savedPosts.userId, userId),
        eq(savedPosts.status, "extracting"),
        lt(savedPosts.updatedAt, relayStale),
        gte(savedPosts.extractAttempts, MAX_EXTRACT_ATTEMPTS),
      ),
    );
  const isFilter = and(
    eq(savedPosts.status, "seen"),
    or(
      eq(savedPosts.lastErrorCode, "model_failed"),
      spentMicros < capMicros ? eq(savedPosts.lastErrorCode, "budget_paused") : undefined,
      and(eq(savedPosts.lastErrorCode, "filtering"), lt(savedPosts.updatedAt, stale)),
    ),
  );
  const rows = await db
    .select({ source: savedPosts.source, key: savedPosts.sourceKey, url: savedPosts.url, status: savedPosts.status })
    .from(savedPosts)
    .where(
      and(
        eq(savedPosts.userId, userId),
        isNotNull(savedPosts.url),
        or(
          isFilter,
          and(eq(savedPosts.status, "queued"), isNull(savedPosts.extraction)),
          and(eq(savedPosts.status, "extracting"), lt(savedPosts.updatedAt, relayStale), lt(savedPosts.extractAttempts, MAX_EXTRACT_ATTEMPTS)),
          and(
            eq(savedPosts.status, "failed"),
            lt(savedPosts.extractAttempts, MAX_EXTRACT_ATTEMPTS),
            inArray(savedPosts.lastErrorCode, [...RETRYABLE_ERROR_CODES]),
          ),
        ),
      ),
    )
    .orderBy(sql`CASE WHEN ${savedPosts.status} = 'seen' THEN 0 ELSE 1 END`, asc(savedPosts.updatedAt), asc(savedPosts.id))
    .limit(limit);
  return rows.flatMap((r) =>
    r.url ? [{ source: r.source, key: r.key, url: r.url, action: r.status === "seen" ? ("filter" as const) : ("extract" as const) }] : [],
  );
}

/** Why the extension could not send a post, before any relay call. */
export type FetchFailure = "gone" | "media_failed" | "too_large";

/**
 * A post the extension could not send. `gone`: the site no longer has it, so it is `failed`/`gone` for good (from any
 * waiting state: seen, queued, failed, or a stale relay claim). `media_failed`: its media would not download; an attempt
 * is counted and `updatedAt` moves it behind the rest of `/work`, which stops handing it out once the attempts run out.
 * `too_large`: even its smallest size is over the body limit, so it is marked as the relay's own cap marks it (an
 * attempt counted; `/work` never hands it out again). Both from queued, a retryable failure or a stale claim (a seen
 * post is filter work, which needs no media). Anything else (finished, skipped, a live claim) is left as it is. One
 * statement, and one more to tell an unknown post from that.
 */
export async function markFetchFailed(
  db: Db,
  userId: string,
  id: string,
  code: FetchFailure,
  now: string,
): Promise<OverrideResult> {
  const relayStale = new Date(new Date(now).getTime() - RELAY_CLAIM_STALE_MS).toISOString();
  const staleClaim = and(eq(savedPosts.status, "extracting"), lt(savedPosts.updatedAt, relayStale));
  const waiting =
    code === "gone"
      ? or(inArray(savedPosts.status, ["seen", "queued", "failed"]), staleClaim)
      : or(
          eq(savedPosts.status, "queued"),
          and(eq(savedPosts.status, "failed"), inArray(savedPosts.lastErrorCode, [...RETRYABLE_ERROR_CODES, "too_large"])),
          staleClaim,
        );
  const updated = await db
    .update(savedPosts)
    .set(
      code === "gone"
        ? { status: "failed", lastErrorCode: "gone", updatedAt: now }
        : { status: "failed", lastErrorCode: code, extractAttempts: sql`${savedPosts.extractAttempts} + 1`, updatedAt: now },
    )
    .where(and(eq(savedPosts.id, id), eq(savedPosts.userId, userId), waiting))
    .returning({ id: savedPosts.id });
  if (updated.length > 0) return "ok";
  const [row] = await db
    .select({ id: savedPosts.id })
    .from(savedPosts)
    .where(and(eq(savedPosts.id, id), eq(savedPosts.userId, userId)));
  return row ? "conflict" : "not_found";
}

/**
 * Record one check the extension ran. `start` opens the row (a repeat changes nothing); `finish` sets the counts and the
 * error (and opens the row too if the start was lost). One statement either way.
 */
export async function recordCheck(db: Db, userId: string, r: CheckReport, now: string): Promise<void> {
  if (r.phase === "start") {
    await db.insert(saveChecks).values({ id: r.checkId, userId, startedAt: now }).onConflictDoNothing();
    return;
  }
  const counts = {
    finishedAt: now,
    found: r.found ?? 0,
    fresh: r.fresh ?? 0,
    filtered: r.filtered ?? 0,
    extracted: r.extracted ?? 0,
    failed: r.failed ?? 0,
    errorCode: r.error?.code ?? null,
    errorMessage: r.error?.message ?? null,
  };
  await db
    .insert(saveChecks)
    .values({ id: r.checkId, userId, startedAt: now, ...counts })
    .onConflictDoUpdate({ target: saveChecks.id, set: counts, setWhere: eq(saveChecks.userId, userId) });
}

const STATUS_CHECKS = 10;
const STATUS_POSTS = 30;

/**
 * What the app and the extension popup show: the latest checks and posts, the spend, what the import brought (`totals`,
 * `lastImportAt`), and one word for how it is going. Four statements.
 */
export async function savesStatus(db: Db, userId: string, now: string): Promise<SavesStatusDto> {
  const checks = await db
    .select()
    .from(saveChecks)
    .where(eq(saveChecks.userId, userId))
    .orderBy(desc(saveChecks.startedAt))
    .limit(STATUS_CHECKS);
  const posts = await db
    .select()
    .from(savedPosts)
    .where(and(eq(savedPosts.userId, userId), isNotNull(savedPosts.url)))
    .orderBy(desc(savedPosts.updatedAt))
    .limit(STATUS_POSTS);
  const spend = await importSpend(db, userId, new Date(now));
  // What the import brought, in one statement: the moves and posts behind the links the owner saved, and when the newest
  // batch arrived (saved, else released) — not when the extension last looked.
  const [imported] = (await db.all(sql`SELECT
    (SELECT count(DISTINCT ${savedPostMoves.moveId}) FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.status} = 'saved') AS moves,
    (SELECT count(DISTINCT ${savedPostMoves.postId}) FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.status} = 'saved') AS posts,
    (SELECT max(coalesce(${saveBatches.savedAt}, ${saveBatches.releasedAt})) FROM ${saveBatches} WHERE ${saveBatches.userId} = ${userId}) AS last`)) as Array<{
    moves: number | null;
    posts: number | null;
    last: string | null;
  }>;
  const last = checks[0];
  const code = last?.errorCode ?? null;
  const state: SavesStatusDto["state"] = !last
    ? "idle"
    : code === "login_needed" || code === "feed_changed"
      ? code
      : code === "budget_paused"
        ? "paused_budget"
        : code
          ? "error"
          : "ok";
  return {
    state,
    lastCheckAt: last?.startedAt ?? null,
    lastImportAt: imported?.last ?? null,
    totals: { moves: Number(imported?.moves ?? 0), posts: Number(imported?.posts ?? 0) },
    checks: checks.map((c) => ({
      id: c.id,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      found: c.found,
      fresh: c.fresh,
      filtered: c.filtered,
      extracted: c.extracted,
      failed: c.failed,
      errorCode: (c.errorCode as SaveErrorCode | null) ?? null,
    })),
    posts: posts.map((p) => ({
      id: p.id,
      key: p.sourceKey,
      url: p.url ?? "",
      creator: { handle: p.creatorHandle ?? "", ...(p.creatorName ? { name: p.creatorName } : {}) },
      status: p.status as SavesStatusDto["posts"][number]["status"],
      reason: p.filterReason ?? p.lastError,
      updatedAt: p.updatedAt,
    })),
    spend,
  };
}

export type OverrideAction = "process" | "skip" | "reference";
export type OverrideResult = "ok" | "not_found" | "conflict";

/** The statuses the owner's `process` sends back to the queue. */
const PROCESSABLE = ["filtered_out", "failed"] as const;

/**
 * The owner's word on one post. `process` sends a filtered-out or failed post back to the queue (stage "owner", attempts,
 * the last error and any stored extraction cleared — `/work` hands out only a queued post with no extraction, so one kept
 * from a failed match would strand it); `skip` and `reference` set their status (a reference keeps the post's links; its
 * routine is never offered whole). The post is named by row id or by (source, key). Another account's post is
 * "not_found"; a `process` on a post that is neither filtered out nor failed — also one that moved on between the read and
 * the write (a relay's claim) — is a "conflict". Two statements.
 */
export async function overridePost(
  db: Db,
  userId: string,
  by: { id: string } | { source: string; key: string },
  action: OverrideAction,
  now: string,
): Promise<OverrideResult> {
  const mine = and(
    eq(savedPosts.userId, userId),
    "id" in by ? eq(savedPosts.id, by.id) : and(eq(savedPosts.source, by.source), eq(savedPosts.sourceKey, by.key)),
  );
  const [row] = await db.select({ id: savedPosts.id, status: savedPosts.status }).from(savedPosts).where(mine).limit(1);
  if (!row) return "not_found";
  const where = and(eq(savedPosts.id, row.id), eq(savedPosts.userId, userId));
  if (action === "process") {
    if (!(PROCESSABLE as readonly string[]).includes(row.status)) return "conflict";
    const requeued = await db
      .update(savedPosts)
      .set({
        status: "queued",
        filterStage: "owner",
        extraction: null,
        extractAttempts: 0,
        lastErrorCode: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(where, inArray(savedPosts.status, [...PROCESSABLE])))
      .returning({ id: savedPosts.id });
    return requeued.length > 0 ? "ok" : "conflict";
  }
  await db
    .update(savedPosts)
    .set({ status: action === "skip" ? "skipped_by_owner" : "reference_only", updatedAt: now })
    .where(where);
  return "ok";
}
