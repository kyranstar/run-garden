import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { SavedPostRow } from "@rg/database";
import type { CheckReport, PostSubmit, SaveErrorCode, SavesStatusDto } from "@rg/saves";
import { sha256Hex } from "../auth/crypto.js";
import type { Db } from "./db.js";

const { savedPosts, saveChecks } = schema;

/** A post is extracted this many times at most. */
export const MAX_EXTRACT_ATTEMPTS = 3;
/** The most posts `/work` hands out at once. */
export const WORK_LIMIT = 20;
/** The most keys one `/known` call carries. */
export const KNOWN_MAX_KEYS = 200;
/** Failures that are worth another try; the rest (gone, too_large, login_needed, feed_changed) wait for the owner. */
export const RETRYABLE_ERROR_CODES: readonly SaveErrorCode[] = ["media_failed", "model_failed", "app_unreachable", "budget_paused", "unknown"];

/** The import's rolling 30-day cap; Task 5 owns the spend ledger and replaces `spendOf`. */
export const IMPORT_BUDGET_MICROS = 5_000_000;

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

/** Posts the extension should fetch media for: queued with no extraction, or failed in a way worth retrying. Oldest first. */
export async function workList(
  db: Db,
  userId: string,
  limit: number = WORK_LIMIT,
): Promise<{ source: string; key: string; url: string }[]> {
  const rows = await db
    .select({ source: savedPosts.source, key: savedPosts.sourceKey, url: savedPosts.url })
    .from(savedPosts)
    .where(
      and(
        eq(savedPosts.userId, userId),
        isNotNull(savedPosts.url),
        or(
          and(eq(savedPosts.status, "queued"), isNull(savedPosts.extraction)),
          and(
            eq(savedPosts.status, "failed"),
            lt(savedPosts.extractAttempts, MAX_EXTRACT_ATTEMPTS),
            inArray(savedPosts.lastErrorCode, [...RETRYABLE_ERROR_CODES]),
          ),
        ),
      ),
    )
    .orderBy(asc(savedPosts.updatedAt), asc(savedPosts.id))
    .limit(limit);
  return rows.flatMap((r) => (r.url ? [{ source: r.source, key: r.key, url: r.url }] : []));
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

/** The import's spend in the last 30 days. A stub until Task 5's ledger; zero. */
async function spendOf(_db: Db, _userId: string, _now: string): Promise<{ spentMicros: number; capMicros: number }> {
  return { spentMicros: 0, capMicros: IMPORT_BUDGET_MICROS };
}

const STATUS_CHECKS = 10;
const STATUS_POSTS = 30;

/** What the app and the extension popup show: the latest checks and posts, the spend, and one word for how it is going. */
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
  const spend = await spendOf(db, userId, now);
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
