/**
 * COROS strength-exercise catalog sync (plan-studio-design §4). The bridge
 * fetches `GET /training/exercise/query?sportType=4` and includes
 * `exerciseCatalog: [{id, name}]` in its snapshot payload when the worker's
 * last sync response said the stored catalog was stale. This is a global,
 * shared reference table (not per-user) — the same ~382 COROS strength
 * exercises apply to every account.
 */

import { asc } from "drizzle-orm";
import { corosExercises } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

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
  for (const item of items) {
    const raw: Record<string, unknown> = { id: item.id, name: item.name };
    await db
      .insert(corosExercises)
      .values({ id: item.id, name: item.name, raw, updatedAt: now })
      .onConflictDoUpdate({
        target: corosExercises.id,
        set: { name: item.name, raw, updatedAt: now },
      });
  }
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
