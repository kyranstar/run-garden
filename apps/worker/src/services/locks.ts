import { and, eq, lt, ne } from "drizzle-orm";
import { coachLocks } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

/**
 * Single-flight claims per (user, kind) — the same token pattern the wake
 * lock proved (rework spec R2): stamp a fresh token (insert wins, or a
 * conditional update takes a stale claim), read back, check the token is
 * yours. Atomic on SQLite/D1's single writer with no driver-specific
 * changes() reliance. Kinds in use: "wake" (coach), "coros_read",
 * "coros_write".
 */
export async function claimUserLock(
  db: Db,
  userId: string,
  kind: string,
  staleMinutes = 10,
): Promise<string | null> {
  const now = nowInstant();
  const staleBefore = new Date(Date.parse(now) - staleMinutes * 60_000).toISOString();
  const token = newId();
  await db.insert(coachLocks).values({ userId, kind, token, claimedAt: now }).onConflictDoNothing();
  await db
    .update(coachLocks)
    .set({ token, claimedAt: now })
    .where(
      and(
        eq(coachLocks.userId, userId),
        eq(coachLocks.kind, kind),
        lt(coachLocks.claimedAt, staleBefore),
        ne(coachLocks.token, token),
      ),
    );
  const [row] = await db
    .select()
    .from(coachLocks)
    .where(and(eq(coachLocks.userId, userId), eq(coachLocks.kind, kind)))
    .limit(1);
  return row?.token === token ? token : null;
}

export async function releaseUserLock(db: Db, userId: string, kind: string, token: string): Promise<void> {
  await db
    .delete(coachLocks)
    .where(and(eq(coachLocks.userId, userId), eq(coachLocks.kind, kind), eq(coachLocks.token, token)));
}
