/**
 * COROS strength-exercise catalog sync (plan-studio-design §4). The bridge
 * fetches `GET /training/exercise/query?sportType=4` and includes
 * `exerciseCatalog: [{id, name}]` in its snapshot payload when the worker's
 * last sync response said the stored catalog was stale. This is a global,
 * shared reference table (not per-user) — the same ~382 COROS strength
 * exercises apply to every account.
 */

import { asc, sql } from "drizzle-orm";
import { corosExercises } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { chunkedInsert, type Db } from "./db.js";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExerciseCatalogItem {
  id: string;
  name: string;
}

/** Upserts each catalog entry by originId (id). */
export async function upsertExerciseCatalog(
  db: Db,
  items: ExerciseCatalogItem[],
): Promise<{ upserted: number }> {
  const now = nowInstant();
  // Batched multi-row upserts (~382 catalog entries): one statement per row
  // was ~382 D1 subrequests inside the bridge-sync request, enough to blow
  // the Worker's budget and fail the whole sync — which re-marked the
  // catalog stale and repeated the failure every 30 minutes.
  const rows = items.map((item) => ({
    id: item.id,
    name: item.name,
    raw: { id: item.id, name: item.name } as Record<string, unknown>,
    updatedAt: now,
  }));
  await chunkedInsert(rows, 4, (batch) =>
    db
      .insert(corosExercises)
      .values(batch)
      .onConflictDoUpdate({
        target: corosExercises.id,
        set: {
          name: sql`excluded.name`,
          raw: sql`excluded.raw`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
  return { upserted: items.length };
}

/**
 * Stale when there are no rows yet, or the oldest row hasn't been refreshed
 * in 7+ days (worker-side rule, spec §4).
 */
export async function isExerciseCatalogStale(db: Db): Promise<boolean> {
  const rows = await db
    .select({ updatedAt: corosExercises.updatedAt })
    .from(corosExercises)
    .orderBy(asc(corosExercises.updatedAt))
    .limit(1);
  const oldest = rows[0]?.updatedAt;
  if (!oldest) return true;
  return Date.now() - Date.parse(oldest) > STALE_AFTER_MS;
}

/** id → human name, for resolving code-named exercises at display time. */
export async function exerciseNameMap(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: corosExercises.id, name: corosExercises.name })
    .from(corosExercises);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The actual exercise name, always (user requirement, round 3): a stored
 * name that is itself an opaque COROS code ("T1004") resolves through the
 * catalog — by the exercise's originId first, then by the code itself (the
 * code usually IS a catalog id). Only a code with no catalog entry survives.
 */
export function resolveExerciseName(
  name: string,
  originId: string | undefined,
  catalog: Map<string, string>,
): string {
  const isCode = /^[A-Za-z]{0,3}[\d\-_.]{2,}$/.test(name.replace(/\s/g, "")) || name.trim().length === 0;
  if (!isCode) return name;
  return (originId && catalog.get(originId)) || catalog.get(name.trim()) || name;
}

/**
 * Resolve catalog codes EMBEDDED in composed display text ("15 min T1120 ·
 * 5× T3001") — stage summaries were stored with raw labels at import time,
 * so the read boundary swaps each token that exactly matches a catalog id.
 */
export function resolveCodesInText(text: string, catalog: Map<string, string>): string {
  return text.replace(/[A-Za-z]{0,3}\d[\w.-]*/g, (token) => catalog.get(token) ?? token);
}
