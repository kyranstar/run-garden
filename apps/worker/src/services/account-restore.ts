/**
 * Restore an account from its export (Phase 0 Task 9), in three calls so no
 * request has to carry or insert the whole history:
 *
 *   begin  { schemaVersion, replace } — refuse a file from another schema;
 *          refuse to replace an account that already holds training data
 *          unless told to; then clear the account (never `users`, `sessions`
 *          or `provider_connections`) and name the tables to send, parents
 *          first.
 *   rows   { table, rows, sourceUserId? } — insert one page, re-owned by the
 *          signed-in account, chunked under D1's 100-variable cap,
 *          `onConflictDoNothing` so a resent page is a no-op.
 *   finish — bring a restored garden that stopped before yesterday up to date,
 *          and report per-table counts.
 *
 * Invariants:
 *  - Only `user` and `child` tables are accepted. The `users` row (identity)
 *    and every excluded table are refused: a restore never signs anyone in,
 *    never replaces who the account is, never writes a catalog.
 *  - A child row is kept only when its parent row belongs to THIS account, so
 *    a crafted file cannot hang rows off another account's workouts.
 *  - Secrets are never restored. A `provider_connections` row is restored
 *    only when the account has no connection for that provider, with its
 *    tokens null and its status `disconnected` (an export never carries
 *    tokens, so "connected" would be a lie); an existing connection is left
 *    exactly as it is.
 *  - Ids derived from the exporting account's id (`<userId>:<date>` on
 *    daily_health, sleep, garden inputs, cursors, …) are re-keyed to the
 *    signed-in account when the file came from a different one, so the
 *    importers' own upserts keep finding them.
 */
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm";
import {
  activities,
  gardenEvents,
  gardenState,
  plannedWorkouts,
  providerConnections,
  SCHEMA_VERSION,
} from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import {
  ACCOUNT_TABLES,
  accountTable,
  columnBySqlName,
  columnKey,
  scopeWhere,
  secretColumns,
  wipeAccountData,
  type AccountTable,
} from "./account-tables.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, type Db } from "./db.js";
import { resimulateFrom } from "./garden-sync.js";

/** What a restore's wipe never touches: who the account is, the session the
 * restore is running in, and the provider connections (their tokens cannot
 * be restored from a file, so clearing them would disconnect COROS). */
export const RESTORE_KEEPS = ["users", "sessions", "provider_connections"] as const;

/** Most rows one `rows` request may carry. */
export const RESTORE_MAX_ROWS = 1000;

type Row = Record<string, unknown>;

export type BeginRestoreResult =
  | { ok: true; tables: string[] }
  | { ok: false; status: 409; error: "not_empty" }
  | { ok: false; status: 422; error: "schema_mismatch" };

export type RestoreRowsResult =
  | { ok: true; received: number; skipped: number }
  | { ok: false; status: 422; error: "unknown_table" | "not_restorable" | "bad_rows" };

/** The tables a restore accepts, parents before children. */
export function restorableTables(): AccountTable[] {
  return ACCOUNT_TABLES.filter((t) => t.scope.kind === "user" || t.scope.kind === "child");
}

async function holdsTrainingData(db: Db, userId: string): Promise<boolean> {
  for (const table of [plannedWorkouts, activities, gardenEvents]) {
    const hit = await db
      .select({ userId: table.userId })
      .from(table)
      .where(eq(table.userId, userId))
      .limit(1);
    if (hit.length > 0) return true;
  }
  return false;
}

export async function beginRestore(
  db: Db,
  userId: string,
  input: { schemaVersion: unknown; replace: unknown },
): Promise<BeginRestoreResult> {
  if (input.schemaVersion !== SCHEMA_VERSION) return { ok: false, status: 422, error: "schema_mismatch" };
  if (input.replace !== true && (await holdsTrainingData(db, userId))) {
    return { ok: false, status: 409, error: "not_empty" };
  }
  // Also on an account with no training data yet: its leftover rows are
  // defaults (preferences, a genesis garden), and left in place they would
  // win every primary-key conflict against the file's own rows.
  await wipeAccountData(db, userId, { keep: RESTORE_KEEPS });
  return { ok: true, tables: restorableTables().map((t) => t.name) };
}

const isPlainObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

export async function restoreRows(
  db: Db,
  userId: string,
  input: { table: unknown; rows: unknown; sourceUserId?: unknown },
): Promise<RestoreRowsResult> {
  if (typeof input.table !== "string") return { ok: false, status: 422, error: "unknown_table" };
  let entry: AccountTable;
  try {
    entry = accountTable(input.table);
  } catch {
    return { ok: false, status: 422, error: "unknown_table" };
  }
  if (entry.scope.kind !== "user" && entry.scope.kind !== "child") {
    return { ok: false, status: 422, error: "not_restorable" };
  }
  const raw = input.rows;
  if (!Array.isArray(raw) || raw.length > RESTORE_MAX_ROWS || !raw.every(isPlainObject)) {
    return { ok: false, status: 422, error: "bad_rows" };
  }

  const source =
    typeof input.sourceUserId === "string" && input.sourceUserId !== "" && input.sourceUserId !== userId
      ? input.sourceUserId
      : null;
  const columns = Object.entries(getTableColumns(entry.table));
  const secretKeys = new Set(secretColumns(entry.name).map((c) => columnKey(entry.table, c)));

  let rows: Row[] = raw.map((src) => {
    const row: Row = {};
    for (const [key, col] of columns) {
      let value = src[key];
      if (source !== null && typeof value === "string" && value.startsWith(`${source}:`)) {
        value = `${userId}:${value.slice(source.length + 1)}`;
      }
      if (col.name === "user_id") value = userId;
      if (secretKeys.has(key)) value = null;
      row[key] = value;
    }
    return row;
  });

  if (entry.scope.kind === "child") rows = await keepOwnedChildren(db, userId, entry, rows);
  if (entry.name === "provider_connections") rows = await newConnectionsOnly(db, userId, rows);

  const perInsert = Math.max(1, Math.floor(100 / columns.length));
  for (let i = 0; i < rows.length; i += perInsert) {
    await db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(entry.table as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values(rows.slice(i, i + perInsert) as any)
      .onConflictDoNothing();
  }
  return { ok: true, received: raw.length, skipped: raw.length - rows.length };
}

/** Drop child rows whose parent row is not this account's. */
async function keepOwnedChildren(db: Db, userId: string, entry: AccountTable, rows: Row[]): Promise<Row[]> {
  if (entry.scope.kind !== "child") return rows;
  const parent = accountTable(entry.scope.parent);
  const parentKey = columnBySqlName(parent.table, entry.scope.parentKey ?? "id");
  const childKey = columnKey(entry.table, entry.scope.column);
  const wanted = [...new Set(rows.map((r) => r[childKey]).filter((v): v is string => typeof v === "string"))];
  const owned = new Set<string>();
  for (const ids of chunkIds(wanted)) {
    const found = await db
      .select({ id: parentKey })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(parent.table as any)
      .where(and(inArray(parentKey, ids), scopeWhere(parent, userId)));
    for (const f of found) owned.add(String(f.id));
  }
  return rows.filter((r) => typeof r[childKey] === "string" && owned.has(r[childKey] as string));
}

/** A connection is restored only for a provider this account has none for —
 * metadata only, disconnected (the tokens were never exported). */
async function newConnectionsOnly(db: Db, userId: string, rows: Row[]): Promise<Row[]> {
  const existing = await db
    .select({ provider: providerConnections.provider })
    .from(providerConnections)
    .where(eq(providerConnections.userId, userId));
  const have = new Set(existing.map((e) => e.provider));
  return rows
    .filter((r) => typeof r.provider === "string" && !have.has(r.provider))
    .map((r) => ({ ...r, status: "disconnected" }));
}

/**
 * Finish: catch the restored garden up, then count what landed.
 *
 * The garden's own tables are restored verbatim with the inputs they were
 * folded from, so the restored garden is already exactly right for every day
 * it had simulated. Only the days since — an export taken last week — can be
 * stale, so the resimulation starts the day after the garden's
 * `lastSimulatedDate`, and only when that is before yesterday. Replaying from
 * the earliest input instead would rewrite every event's timestamp for
 * nothing and, on an old garden, run past D1's per-invocation query budget
 * mid-walk — leaving the event log truncated from that day on.
 */
export async function finishRestore(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<{ counts: Record<string, number> }> {
  const prefs = await loadPreferences(db, userId);
  const [garden] = await db
    .select({ last: gardenState.lastSimulatedDate })
    .from(gardenState)
    .where(eq(gardenState.userId, userId))
    .limit(1);
  if (garden) {
    const yesterday = addDays(todayInZone(prefs.timezone, now), -1);
    if (garden.last < yesterday) {
      await resimulateFrom(db, userId, addDays(garden.last, 1), prefs, now).catch(() => undefined);
    }
  }

  const counts: Record<string, number> = {};
  for (const t of restorableTables()) {
    const [row] = await db
      .select({ n: count() })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(t.table as any)
      .where(scopeWhere(t, userId));
    counts[t.name] = Number(row?.n ?? 0);
  }
  return { counts };
}
