/**
 * THE IMPORT TRAIL'S COLLECTOR (design 2026-11-05 §6.1–6.2). A stage of a saved or pasted post describes what it took
 * in, decided and gave out as events (and the large pieces as blobs); `trailStatements` turns them into statements the
 * stage runs in its OWN batch, beside the state change they describe — so the trail can never disagree with the state.
 *
 * Bounds never fail a stage: a summary is one line of at most SUMMARY_MAX; a detail past EVENT_DETAIL_MAX keeps a head
 * and moves whole into a `detail` blob; a blob past BLOB_MAX is cut there and marked `cut`.
 */
import { sql, type SQL } from "drizzle-orm";
import { newId } from "@rg/domain";
import { schema } from "@rg/database";
import type { BlobKind, ImportStage, TrailSource, TrailStatus } from "@rg/saves";
import { insertBatches, type AtomicStatement, type Db } from "./db.js";

const { importEvents, importBlobs, promptVersions, savedPosts, savedPostMoves, importCorrections } = schema;

export const SUMMARY_MAX = 300;
export const EVENT_DETAIL_MAX = 64_000;
export const BLOB_MAX = 1_000_000;
/** What a cut detail keeps in its event: enough to read the start without opening the blob. */
const DETAIL_HEAD = 2_000;

export interface TrailEventInput {
  stage: ImportStage;
  source: TrailSource;
  status: TrailStatus;
  /** One plain line, written by the stage, for the account and the section's result. */
  summary: string;
  detail?: unknown;
  moveId?: string;
  batchId?: string;
  usageId?: string;
  model?: string;
  promptVersion?: string;
  costMicros?: number;
  latencyMs?: number;
  attempt?: number;
  runId?: string;
  proposalId?: string;
  /** Built from stored columns for a post from before the trail (§6.6). */
  rebuilt?: boolean;
  blobs?: { kind: BlobKind; text: string }[];
}

/** One line, at most SUMMARY_MAX, cut at a word with an ellipsis. */
export function summaryLine(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= SUMMARY_MAX) return one;
  const room = one.slice(0, SUMMARY_MAX - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > SUMMARY_MAX / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** Cut at BLOB_MAX without splitting a surrogate pair. */
function cutText(text: string): { text: string; cut: boolean } {
  if (text.length <= BLOB_MAX) return { text, cut: false };
  const end = /[\uD800-\uDBFF]/.test(text[BLOB_MAX - 1] ?? "") ? BLOB_MAX - 1 : BLOB_MAX;
  return { text: text.slice(0, end), cut: true };
}

/** The statements that write `events` (and their blobs) for one post. None when there is nothing to write. */
export function trailStatements(db: Db, userId: string, postId: string, events: readonly TrailEventInput[], at: string): AtomicStatement[] {
  const eventRows: (typeof importEvents.$inferInsert)[] = [];
  const blobRows: (typeof importBlobs.$inferInsert)[] = [];
  for (const e of events) {
    const id = newId();
    let detail: unknown = e.detail ?? null;
    if (detail !== null) {
      const text = JSON.stringify(detail) ?? "null";
      if (text.length > EVENT_DETAIL_MAX) {
        detail = { cut: true, head: text.slice(0, DETAIL_HEAD) };
        blobRows.push({ id: newId(), userId, postId, eventId: id, kind: "detail", ...cutText(text), at });
      }
    }
    for (const b of e.blobs ?? []) blobRows.push({ id: newId(), userId, postId, eventId: id, kind: b.kind, ...cutText(b.text), at });
    eventRows.push({
      id,
      userId,
      postId,
      batchId: e.batchId ?? null,
      moveId: e.moveId ?? null,
      stage: e.stage,
      source: e.source,
      status: e.status,
      summary: summaryLine(e.summary),
      detail,
      usageId: e.usageId ?? null,
      model: e.model ?? null,
      promptVersion: e.promptVersion ?? null,
      costMicros: e.costMicros ?? null,
      latencyMs: e.latencyMs ?? null,
      attempt: e.attempt ?? null,
      runId: e.runId ?? null,
      proposalId: e.proposalId ?? null,
      rebuilt: e.rebuilt ?? false,
      at,
    });
  }
  return [
    ...insertBatches(eventRows).map((rows) => db.insert(importEvents).values(rows)),
    // One blob a statement: a blob may be a megabyte, and one statement holding several would pass D1's limits.
    ...blobRows.map((row) => db.insert(importBlobs).values(row)),
  ];
}

/** A prompt version's system text, written on its first use and never again (insert-or-ignore). */
export function promptVersionStatement(db: Db, version: string, kind: string, systemText: string, at: string): AtomicStatement {
  return db.insert(promptVersions).values({ version, kind, systemText, firstUsedAt: at }).onConflictDoNothing();
}

/**
 * One event for EVERY post of a batch, in one set-based statement (a batch may hold dozens of posts, and its routes
 * have a statement budget): the batch-level stages — cut into a batch, saved, the owner's choices, put aside.
 */
export function batchTrailStatement(
  db: Db,
  userId: string,
  batchId: string,
  e: Pick<TrailEventInput, "stage" | "status" | "summary" | "detail"> & { source?: TrailEventInput["source"] },
  at: string,
  /**
   * `gate`: the transaction's claim (`fitClaimSql`) — a lost claim writes no step, as it writes nothing else.
   * `savedLinks`: only posts with a saved link of this batch — a post whose links were all removed, or one skipped,
   * was not saved (final review I2, 2026-11-05).
   */
  only: { gate?: SQL; savedLinks?: boolean } = {},
): AtomicStatement {
  const detail = e.detail === undefined ? null : JSON.stringify(e.detail);
  const gate = only.gate ? sql` AND ${only.gate}` : sql``;
  const saved = only.savedLinks
    ? sql` AND EXISTS (SELECT 1 FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.postId} = ${savedPosts.id}
        AND ${savedPostMoves.batchId} = ${batchId} AND ${savedPostMoves.status} = 'saved')`
    : sql``;
  return db
    .insert(importEvents)
    .select(
      sql`SELECT lower(hex(randomblob(16))), ${userId}, ${savedPosts.id}, ${batchId}, NULL, ${e.stage}, ${e.source ?? "worker"},
        ${e.status}, ${summaryLine(e.summary)}, ${detail}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ${at}
        FROM ${savedPosts} WHERE ${savedPosts.userId} = ${userId} AND ${savedPosts.batchId} = ${batchId}${gate}${saved}`,
    );
}

/** One event on EVERY post a move came from (its links), in one set-based statement: the owner's edit of a move. */
export function moveTrailStatement(
  db: Db,
  userId: string,
  moveId: string,
  e: Pick<TrailEventInput, "stage" | "status" | "summary" | "detail"> & { source?: TrailEventInput["source"] },
  at: string,
): AtomicStatement {
  const detail = e.detail === undefined ? null : JSON.stringify(e.detail);
  return db
    .insert(importEvents)
    .select(
      sql`SELECT lower(hex(randomblob(16))), ${userId}, post_id, NULL, ${moveId}, ${e.stage}, ${e.source ?? "owner"},
        ${e.status}, ${summaryLine(e.summary)}, ${detail}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ${at}
        FROM (SELECT DISTINCT ${savedPostMoves.postId} AS post_id FROM ${savedPostMoves}
          WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.moveId} = ${moveId})`,
    );
}

export interface CorrectionInput {
  target: "move" | "link" | "insight" | "reading";
  targetId: string;
  field: string;
  before: unknown;
  after: unknown;
  why: string;
  basis: "evidence" | "owner";
  by: "coach" | "owner";
  evidence?: unknown;
  proposalId?: string;
}

/** Correction rows (design 2026-11-05 §6.1): every change to imported data, with before, after, why and basis. */
export function correctionStatements(db: Db, userId: string, rows: readonly CorrectionInput[], at: string): AtomicStatement[] {
  const values = rows.map((r) => ({
    id: newId(), userId, target: r.target, targetId: r.targetId, field: r.field, before: r.before ?? null, after: r.after ?? null,
    why: r.why, basis: r.basis, evidence: r.evidence ?? null, by: r.by, proposalId: r.proposalId ?? null, at,
  }));
  return insertBatches(values).map((chunk) => db.insert(importCorrections).values(chunk));
}
