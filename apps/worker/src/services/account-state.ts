/**
 * Per-account bookkeeping (`account_state`, migration 0023): the restore
 * marker, the post-restore calendar reconcile flag and the post-restore garden
 * catch-up flag. None of it is account data — it is never exported or restored, and
 * delete-all removes it.
 *
 * THE RESTORE MARKER (ruling B2). Restore begin sets `restoreId`; finish or
 * "Start fresh" clears it. While it is set the account is half-wiped and the
 * file is still arriving, so every writer skips the account: the crons, the
 * garden (advance, ensure, resimulate, persist), COROS reads and sweeps, the
 * calendar sync, cloud job execution, coach reads and wakes, and backfill.
 * GET routes still read. Each writer checks at its own entry — not only the
 * cron loop — because a request (another tab, the phone) reaches the writer
 * without passing through any loop.
 */
import { eq, isNotNull } from "drizzle-orm";
import { accountState } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

export type AccountStateRow = typeof accountState.$inferSelect;
type AccountStatePatch = Partial<Omit<AccountStateRow, "userId" | "updatedAt">>;

export async function loadAccountState(db: Db, userId: string): Promise<AccountStateRow | null> {
  const [row] = await db.select().from(accountState).where(eq(accountState.userId, userId)).limit(1);
  return row ?? null;
}

/** True while a restore has begun and not finished (or been abandoned by
 * "Start fresh"). */
export function isRestoring(state: AccountStateRow | null | undefined): boolean {
  return typeof state?.restoreId === "string" && state.restoreId.length > 0;
}

export async function restoreInProgress(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ restoreId: accountState.restoreId })
    .from(accountState)
    .where(eq(accountState.userId, userId))
    .limit(1);
  return typeof row?.restoreId === "string" && row.restoreId.length > 0;
}

/** What the app says about an unfinished restore — null when none is. */
export interface RestoreStatus {
  startedAt: string | null;
  fileExportedAt: string | null;
  fileExportedFrom: string | null;
}

export function restoreStatusOf(state: AccountStateRow | null | undefined): RestoreStatus | null {
  if (!isRestoring(state)) return null;
  return {
    startedAt: state!.restoreStartedAt,
    fileExportedAt: state!.restoreFileExportedAt,
    fileExportedFrom: state!.restoreFileExportedFrom,
  };
}

/** Every account with a restore in progress — the crons skip them. */
export async function accountsRestoring(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ userId: accountState.userId })
    .from(accountState)
    .where(isNotNull(accountState.restoreId));
  return new Set(rows.map((r) => r.userId));
}

/** Insert-or-merge the given fields. */
export async function patchAccountState(db: Db, userId: string, patch: AccountStatePatch): Promise<void> {
  const now = nowInstant();
  await db
    .insert(accountState)
    .values({ userId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: accountState.userId, set: { ...patch, updatedAt: now } });
}
