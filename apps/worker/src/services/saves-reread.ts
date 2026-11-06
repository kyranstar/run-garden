/**
 * READ IT AGAIN (design 2026-11-05 §6.6; phase 5a): an old post read again under the current prompt, at the owner's tap.
 *
 * A post's links, their provenance, the corrections made to it and the coach's memory of its notes are all keyed by a
 * move's POSITION in the post's reading. So a re-read of a post that already has links is never stored as it came: it
 * is lined up with them first (`alignReading`) — each linked move found again goes back to its link's position, the
 * approved corrections to the reading are applied again on top, the notes Save put in the coach's memory are kept, and
 * moves the earlier reading never had come after the rest (matching then adds their links, as for any post). A linked
 * move the new reading doesn't hold keeps the earlier reading whole: two readings' moves are never mixed (an earlier
 * one's may not even parse under today's schema), and nothing the owner has is rewritten (ruling, phase 5a ledger).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { schema } from "@rg/database";
import { extractionSchema, normalizeMoveName, priceWords, type Extraction } from "@rg/saves";
import type { Db } from "./db.js";
import { runAtomicallyClaim } from "./db.js";
import { summaryLine } from "./import-trail.js";
import { notFittingSql, openBatchSql } from "./saves-batches.js";
import { EXTRACT_MODEL_DEFAULT, typicalReadingMicros } from "./saves-relay.js";

const { savedPosts, importEvents } = schema;

/**
 * A step that is a reading of the post's own, in SQL over an `import_events` alias: its screening, or a reading of its
 * moves that was stored (its detail counts the moves; one that kept the earlier reading says so). A failed reading, or
 * one waiting for the budget, is none — the post still has only what was kept from before.
 */
export function ownReadingSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.stage = 'screen' or (${a}.stage = 'extract' and json_type(${a}.detail, '$.moves') = 'integer'
    and coalesce(json_extract(${a}.detail, '$.kept'), '') <> 'earlier'))`;
}

/** The same, for a step as the trail reads it. */
export const isOwnReading = (e: { stage: string; detail: unknown }): boolean => {
  if (e.stage === "screen") return true;
  if (e.stage !== "extract" || !e.detail || typeof e.detail !== "object") return false;
  const d = e.detail as { moves?: unknown; kept?: unknown };
  return typeof d.moves === "number" && Number.isInteger(d.moves) && d.kept !== "earlier";
};

/**
 * Whether a post may be read again, in SQL (every write of the ask carries it, so a race writes nothing): the owner's
 * post from before the trail (no reading of its own), matched or failed — a post the owner skipped or kept as a
 * reference keeps their word, and a filtered one has Import anyway — whose batch isn't being fitted in, with no move of
 * it waiting in a held or open batch (a re-read mid-review would change what the owner is reviewing). One clause.
 */
export function readAgainGateSql(userId: string, postId: string, now: string): SQL {
  return sql`exists (select 1 from saved_posts ra where ra.id = ${postId} and ra.user_id = ${userId}
    and ra.status in ('matched', 'failed')
    and not exists (select 1 from import_events re where re.user_id = ${userId} and re.post_id = ra.id and ${ownReadingSql("re")})
    and (ra.batch_id is null or not exists (select 1 from save_batches rb where rb.id = ra.batch_id and rb.user_id = ${userId} and not ${notFittingSql("rb", now)}))
    and not exists (select 1 from saved_post_moves rl join save_batches rlb on rlb.id = rl.batch_id and rlb.user_id = rl.user_id
      where rl.user_id = ${userId} and rl.post_id = ra.id and rl.status = 'pending' and (rlb.status = 'held' or ${openBatchSql("rlb")})))`;
}

/** What a post's reading is priced from: its source, media and length, and its words (a video page's description and transcript). */
export function readingCostOf(p: {
  source: string; mediaType: string | null; durationSec: number | null; caption: string | null;
  videoInfo: { captions: unknown; transcriptChars: number } | null;
}): number {
  const textChars = (p.caption?.length ?? 0) + (p.videoInfo?.captions ? (p.videoInfo.transcriptChars ?? 0) : 0);
  return typicalReadingMicros(EXTRACT_MODEL_DEFAULT, { source: p.source, mediaType: p.mediaType, durationSec: p.durationSec, textChars });
}

/**
 * The owner's Read it again: the post goes back to the queue — its attempts and last error cleared, its reading KEPT
 * when it has links (the new one is lined up with it before it replaces it), nothing else touched — and its trail says
 * so with the price. The computer's extension finds it on its work list (`/work`) and reads it as any `extract` work.
 * "conflict" when it can't be (`readAgainGateSql`). Two statements, the second a batch of two.
 */
export async function readAgain(db: Db, userId: string, postId: string, now: string): Promise<"ok" | "not_found" | "conflict"> {
  const [p] = await db
    .select({ source: savedPosts.source, mediaType: savedPosts.mediaType, durationSec: savedPosts.durationSec, caption: savedPosts.caption, videoInfo: savedPosts.videoInfo })
    .from(savedPosts)
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId)))
    .limit(1);
  if (!p) return "not_found";
  const cost = readingCostOf(p);
  const gate = readAgainGateSql(userId, postId, now);
  const summary = summaryLine(`You asked for it to be read again (${priceWords(cost)})`);
  const detail = JSON.stringify({ action: "reread", costMicros: cost });
  const claimed = await runAtomicallyClaim(db, [
    db.insert(importEvents).select(
      sql`SELECT lower(hex(randomblob(16))), ${userId}, ${postId}, NULL, NULL, 'choice', 'owner', 'info', ${summary}, ${detail},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ${now} WHERE ${gate}`,
    ),
    db
      .update(savedPosts)
      .set({
        status: "queued", extractAttempts: 0, lastErrorCode: null, lastError: null, watchVideo: null, updatedAt: now,
        extraction: sql`CASE WHEN EXISTS (SELECT 1 FROM saved_post_moves x WHERE x.user_id = ${userId} AND x.post_id = ${postId}) THEN ${savedPosts.extraction} ELSE NULL END`,
      })
      .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId), gate))
      .returning({ id: savedPosts.id }),
  ]);
  return claimed > 0 ? "ok" : "conflict";
}

/** One of the post's links as the re-read finds it: its place, its move and that move's name now. */
export interface KeptRow {
  position: number;
  moveId: string;
  moveKind: "library" | "personal";
  status: string;
  /** The move's name now (the library's, or the record's: the owner may have renamed it). */
  name: string | null;
}

/** An approved correction to the post's reading of the move at `position` (import_corrections, target `reading`). */
export interface ReadingFix {
  position: number;
  field: "useWhen" | "skipWhen" | "why";
  after: unknown;
}

export type Aligned =
  | { ok: true; extraction: Extraction; kept: number[]; added: number[] }
  | { ok: false; why: "missing"; missing: string[] }
  | { ok: false; why: "invalid" };

/** The least share of words two names hold in common for one to be found as the other (the matcher's own floor). */
export const CLOSE_NAME_MIN = 0.6;

const words = (name: string): Set<string> =>
  new Set(normalizeMoveName(name).split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean));
const overlap = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
};

/** The earlier reading's name and aliases at a place, as kept (any shape). */
function earlierNames(earlier: unknown, position: number): string[] {
  const moves = earlier && typeof earlier === "object" ? (earlier as { moves?: unknown }).moves : null;
  const m = Array.isArray(moves) ? moves[position] : null;
  if (!m || typeof m !== "object") return [];
  const o = m as { name?: unknown; aliases?: unknown };
  return [o.name, ...(Array.isArray(o.aliases) ? o.aliases : [])].filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * The new reading lined up with the post's links (`rows`, any status: a row the owner left out holds its place too).
 * Each row is found by the earlier reading's name or aliases there, or its move's name now — exactly (normalised), else
 * by the closest name sharing at least CLOSE_NAME_MIN of its words. `kept`: the positions lined up; `added`: the rest,
 * which matching links as new. `ok: false` keeps the earlier reading: a linked move not found (`missing`, by name), a
 * place below the last link with no move left to fill it, or a result that wouldn't parse.
 */
export function alignReading(
  fresh: Extraction,
  o: { earlier: unknown; rows: readonly KeptRow[]; fixes: readonly ReadingFix[]; keepInsights: boolean },
): Aligned {
  if (o.rows.length === 0) return { ok: true, extraction: fresh, kept: [], added: fresh.moves.map((_, i) => i) };
  const rows = [...o.rows].sort((a, b) => a.position - b.position);
  const freshKeys = fresh.moves.map((m) => new Set([m.name, ...m.aliases].map(normalizeMoveName).filter(Boolean)));
  const freshWords = fresh.moves.map((m) => [m.name, ...m.aliases].map(words));
  const rowNames = rows.map((r) => [...earlierNames(o.earlier, r.position), ...(r.name ? [r.name] : [])]);
  const at = new Map<number, number>(); // row position → fresh index
  const taken = new Set<number>();

  // Exact names first, for every row, so a close name never takes a move another row names exactly.
  rows.forEach((r, i) => {
    const keys = rowNames[i]!.map(normalizeMoveName).filter(Boolean);
    const j = freshKeys.findIndex((k, jj) => !taken.has(jj) && keys.some((x) => k.has(x)));
    if (j >= 0) {
      at.set(r.position, j);
      taken.add(j);
    }
  });
  rows.forEach((r, i) => {
    if (at.has(r.position)) return;
    const mine = rowNames[i]!.map(words).filter((w) => w.size > 0);
    let best = -1;
    let score = 0;
    freshWords.forEach((ws, j) => {
      if (taken.has(j)) return;
      for (const w of ws) {
        for (const m of mine) {
          const s = overlap(w, m);
          if (s >= CLOSE_NAME_MIN && s > score) {
            score = s;
            best = j;
          }
        }
      }
    });
    if (best >= 0) {
      at.set(r.position, best);
      taken.add(best);
    }
  });
  const missing = rows.flatMap((r, i) => (at.has(r.position) ? [] : [rowNames[i]![0] ?? r.name ?? "a move"]));
  if (missing.length) return { ok: false, why: "missing", missing };

  // The places: every row's, a gap below the last row filled by the next new move, then the rest after.
  const rest = fresh.moves.map((_, j) => j).filter((j) => !taken.has(j));
  const last = rows.at(-1)!.position;
  const order: number[] = []; // final position → fresh index
  for (let p = 0; p <= last; p++) {
    const j = at.get(p) ?? rest.shift();
    if (j === undefined) return { ok: false, why: "invalid" };
    order.push(j);
  }
  // Never more moves than the new reading itself: every place is one of its moves.
  order.push(...rest);
  const placeOf = new Map(order.map((j, p) => [j, p]));

  const moves = order.map((j) => ({ ...fresh.moves[j]! }));
  // The approved corrections to the reading, again on the new words — in the order made, so the latest of a field wins.
  for (const f of o.fixes) {
    if (!at.has(f.position) || !moves[f.position]) continue;
    (moves[f.position] as Record<string, unknown>)[f.field] = f.after;
  }
  const earlierInsights = o.earlier && typeof o.earlier === "object" ? (o.earlier as { insights?: unknown }).insights : undefined;
  const aligned = {
    ...fresh,
    moves,
    ...(fresh.routine ? { routine: { ...fresh.routine, order: fresh.routine.order.flatMap((j) => (placeOf.has(j) ? [placeOf.get(j)!] : [])) } } : {}),
    ...(fresh.dropped ? { dropped: fresh.dropped.flatMap((d) => (placeOf.has(d.move) ? [{ ...d, move: placeOf.get(d.move)! }] : [])) } : {}),
    insights: o.keepInsights && Array.isArray(earlierInsights) ? earlierInsights : fresh.insights,
  };
  const parsed = extractionSchema.safeParse(aligned);
  if (!parsed.success) return { ok: false, why: "invalid" };
  return { ok: true, extraction: parsed.data, kept: rows.map((r) => r.position), added: order.map((_, p) => p).filter((p) => !at.has(p)) };
}
