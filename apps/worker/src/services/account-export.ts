/**
 * The account export (Phase 0 Task 9): EVERY table that belongs to an
 * account, read page by page so no single request has to hold the whole
 * history. The client assembles the pages into one file:
 *
 *   { format: "run-garden-export", schemaVersion, exportedAt, tables: { [name]: rows[] } }
 *
 * Which tables, and which of their rows, comes from the one registry
 * (account-tables.ts) — the same one restore, delete-all, the copier and the
 * parity harness use — so a new table is exported the day it is registered,
 * and the registry test fails the day it is not.
 *
 * Paging: rows are in primary-key order and the cursor is an OFFSET into that
 * order for this account. The order is total (primary keys are unique), so
 * the page boundaries of an account nobody is writing to are fixed; a row
 * written mid-export can shift a later page by one, exactly as any
 * multi-request read of a live D1 database can (there is no cross-request
 * snapshot to read from). The client exports in a few seconds while the
 * athlete is looking at the Settings page.
 */
import { count } from "drizzle-orm";
import { SCHEMA_VERSION } from "@rg/database";
import {
  ACCOUNT_TABLES,
  accountTable,
  columnKey,
  orderedRows,
  scopeWhere,
  secretColumns,
  type AccountTable,
} from "./account-tables.js";
import type { Db } from "./db.js";

export const EXPORT_FORMAT = "run-garden-export";
/** Largest page one request returns. */
export const EXPORT_PAGE_SIZE = 500;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  schemaVersion: string;
  tables: Array<{ name: string; rows: number }>;
}

export interface ExportTablePage {
  rows: Array<Record<string, unknown>>;
  nextCursor: number | null;
}

/** Thrown for a table that is not exported: unknown, or belonging to no
 * account (sessions, OAuth handshakes, catalogs, versioning). */
export class NotExportable extends Error {}

/** The account's own `users` row, then every `user` and `child` table, in
 * registry (dependency) order. */
export function exportableTables(): AccountTable[] {
  return ACCOUNT_TABLES.filter((t) => t.scope.kind !== "excluded");
}

function exportable(name: string): AccountTable {
  let entry: AccountTable;
  try {
    entry = accountTable(name);
  } catch {
    throw new NotExportable(`not exported: ${name}`);
  }
  if (entry.scope.kind === "excluded") throw new NotExportable(`not exported: ${name}`);
  return entry;
}

export async function exportManifest(db: Db, userId: string): Promise<ExportManifest> {
  const tables: ExportManifest["tables"] = [];
  for (const t of exportableTables()) {
    const [row] = await db
      .select({ n: count() })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(t.table as any)
      .where(scopeWhere(t, userId));
    tables.push({ name: t.name, rows: Number(row?.n ?? 0) });
  }
  return { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, tables };
}

/**
 * One page of one table: at most `limit` (≤ EXPORT_PAGE_SIZE) of this
 * account's rows from offset `cursor`, secret columns nulled. `nextCursor` is
 * null on the last page.
 */
export async function exportTablePage(
  db: Db,
  userId: string,
  name: string,
  cursor = 0,
  limit = EXPORT_PAGE_SIZE,
): Promise<ExportTablePage> {
  const entry = exportable(name);
  const size = Math.max(1, Math.min(EXPORT_PAGE_SIZE, Math.floor(limit)));
  const offset = Math.max(0, Math.floor(cursor));
  // One extra row says whether another page exists without a second query.
  const fetched = await orderedRows(db, entry.table, { userId, offset, limit: size + 1 });
  const rows = fetched.slice(0, size);
  const secretKeys = secretColumns(name).map((col) => columnKey(entry.table, col));
  if (secretKeys.length > 0) {
    for (const row of rows) for (const key of secretKeys) row[key] = null;
  }
  return { rows, nextCursor: fetched.length > size ? offset + size : null };
}
