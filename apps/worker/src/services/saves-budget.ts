import { and, eq, gte, sql } from "drizzle-orm";
import { llmUsage } from "@rg/database";
import { newId } from "@rg/domain";
import type { Db } from "./db.js";
import { IMPORT_USAGE_PREFIX, importUsageSql, RESERVATION_MARK, weekCostSql } from "./llm.js";

/**
 * THE IMPORT'S BUDGET, kept apart from the coach's. The saved-posts import's model calls (filter, extract, match) are
 * rows in `llm_usage` under `import_*` kinds; llm.ts leaves that prefix out of the athlete's week (`ownerUsageSql`), and
 * this file counts only it, over 30 days, against a $5 cap. A call is reserved at its worst case before it is made and
 * settled to what it cost after (a reservation left unsettled for 15 minutes counts at its estimate: `weekCostSql`).
 */
export const IMPORT_KINDS = {
  filter: `${IMPORT_USAGE_PREFIX}filter`,
  extract: `${IMPORT_USAGE_PREFIX}extract`,
  match: `${IMPORT_USAGE_PREFIX}match`,
} as const;
export type ImportKind = (typeof IMPORT_KINDS)[keyof typeof IMPORT_KINDS];

export const IMPORT_BUDGET_MICROS = 5_000_000;
export const IMPORT_WINDOW_DAYS = 30;

/** The import's spend in the rolling window. ONE statement. */
export async function importSpend(db: Db, userId: string, now: Date): Promise<{ spentMicros: number; capMicros: number }> {
  const since = new Date(now.getTime() - IMPORT_WINDOW_DAYS * 86_400_000).toISOString();
  const [row] = await db
    .select({ spent: sql<number | null>`sum(${weekCostSql(now)})` })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since), importUsageSql()));
  return { spentMicros: Math.round(Number(row?.spent ?? 0)), capMicros: IMPORT_BUDGET_MICROS };
}

/**
 * Put a call on the record at its worst case before it is made; refuse when that would pass the cap. `worstMicros` is
 * what the row holds (and what the cap check counts) while the call runs; `estimateMicros` is what a typical call costs,
 * written in the fingerprint: a reservation orphaned by a crash counts at that once stale (`weekCostSql`), not at the
 * worst case.
 */
export async function reserveImport(
  db: Db,
  userId: string,
  kind: ImportKind,
  model: string,
  worstMicros: number,
  estimateMicros: number,
  now: Date,
): Promise<{ ok: true; usageId: string } | { ok: false; reason: "budget_paused" }> {
  const { spentMicros, capMicros } = await importSpend(db, userId, now);
  if (spentMicros + worstMicros > capMicros) return { ok: false, reason: "budget_paused" };
  const usageId = newId();
  await db.insert(llmUsage).values({
    id: usageId,
    userId,
    kind,
    model,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: worstMicros,
    cacheHit: false,
    requestFingerprint: `${kind}${RESERVATION_MARK}${Math.min(estimateMicros, worstMicros)}`,
    createdAt: now.toISOString(),
  });
  return { ok: true, usageId };
}

/** Replace a reservation with what the call cost (its fingerprint mark goes); `null` — the call never happened — zeroes it. */
export async function settleImport(
  db: Db,
  usageId: string,
  actual: { model: string; inputTokens: number; outputTokens: number; costMicros: number } | null,
): Promise<void> {
  await db
    .update(llmUsage)
    .set({
      ...(actual
        ? { model: actual.model, inputTokens: actual.inputTokens, outputTokens: actual.outputTokens, costMicros: actual.costMicros }
        : { inputTokens: 0, outputTokens: 0, costMicros: 0 }),
      requestFingerprint: null,
    })
    .where(eq(llmUsage.id, usageId));
}
