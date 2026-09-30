/**
 * The account export (Phase 0 Task 9, reworked for audit 1 data finding 4
 * under ruling B5): EVERY table that belongs to an account, read page by page
 * so no single request has to hold the whole history. The client assembles
 * the pages into one file:
 *
 *   { format: "run-garden-export", schemaVersion, exportedAt, exportedFrom,
 *     tables: { [name]: rows[] } }
 *
 * Which tables, and which of their rows, comes from the one registry
 * (account-tables.ts) — the same one restore, delete-all, the copier and the
 * parity harness use — so a new table is exported the day it is registered,
 * and the registry test fails the day it is not.
 *
 * Paging is KEYSET on the primary key: a page is "the next `limit` rows whose
 * key sorts after the cursor". The old OFFSET cursor skipped a row whenever an
 * earlier row was deleted between two pages (a COROS content edit replacing a
 * workout's stages mid-export dropped a stage from the file for good). A row
 * that exists for the whole export is now always in it; the client checks each
 * table's count against the manifest and reads a short table once more.
 *
 * The garden tables go LAST: a resimulation deletes and rebuilds date ranges,
 * so reading them after everything else keeps the moment they are read as
 * close together as the export allows. (A restore rebuilds the garden from the
 * restored rows anyway — ruling B4 — which heals any disagreement between
 * them.) `coach_locks` is not exported: it holds live claims with no primary
 * key, and a restore never writes it.
 */
import { count } from "drizzle-orm";
import { SCHEMA_VERSION } from "@rg/database";
import { b64urlDecode, b64urlEncode } from "../auth/crypto.js";
import {
  ACCOUNT_TABLES,
  accountTable,
  columnKey,
  orderColumns,
  orderedRows,
  scopeWhere,
  secretColumns,
  type AccountTable,
} from "./account-tables.js";
import type { Db } from "./db.js";

export const EXPORT_FORMAT = "run-garden-export";
/** Largest page one request returns. */
export const EXPORT_PAGE_SIZE = 500;
/** Account tables an export leaves out (see the module comment). */
export const NOT_EXPORTED = ["coach_locks"] as const;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  schemaVersion: string;
  /** The app the export is taken from (its origin), written into the file. */
  exportedFrom: string | null;
  tables: Array<{ name: string; rows: number }>;
}

export interface ExportTablePage {
  rows: Array<Record<string, unknown>>;
  /** Opaque keyset cursor for the next page; null on the last one. */
  nextCursor: string | null;
}

/** Thrown for a table that is not exported: unknown, or belonging to no
 * account (sessions, OAuth handshakes, catalogs, versioning). */
export class NotExportable extends Error {}

/** Thrown for a cursor this worker did not issue. */
export class BadCursor extends Error {}

const isGarden = (t: AccountTable) => t.name.startsWith("garden_");

/** The account's own `users` row, then every `user` and `child` table in
 * registry (dependency) order — garden tables last. */
export function exportableTables(): AccountTable[] {
  const skip = new Set<string>(NOT_EXPORTED);
  const all = ACCOUNT_TABLES.filter((t) => t.scope.kind !== "excluded" && !skip.has(t.name));
  return [...all.filter((t) => !isGarden(t)), ...all.filter(isGarden)];
}

function exportable(name: string): AccountTable {
  let entry: AccountTable;
  try {
    entry = accountTable(name);
  } catch {
    throw new NotExportable(`not exported: ${name}`);
  }
  if (!exportableTables().includes(entry)) throw new NotExportable(`not exported: ${name}`);
  return entry;
}

function originOf(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

export async function exportManifest(db: Db, userId: string, opts: { appUrl?: string } = {}): Promise<ExportManifest> {
  const tables: ExportManifest["tables"] = [];
  for (const t of exportableTables()) {
    const [row] = await db
      .select({ n: count() })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(t.table as any)
      .where(scopeWhere(t, userId));
    tables.push({ name: t.name, rows: Number(row?.n ?? 0) });
  }
  return { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, exportedFrom: originOf(opts.appUrl), tables };
}

function encodeCursor(value: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify([value])));
}

function decodeCursor(cursor: string): string | number {
  try {
    const [value] = JSON.parse(new TextDecoder().decode(b64urlDecode(cursor))) as unknown[];
    if (typeof value === "string" || typeof value === "number") return value;
  } catch {
    /* fall through */
  }
  throw new BadCursor("bad cursor");
}

/**
 * One page of one table: at most `limit` (≤ EXPORT_PAGE_SIZE) of this
 * account's rows whose primary key sorts after `cursor` (null = from the
 * start), secret columns nulled. `nextCursor` is null on the last page.
 */
export async function exportTablePage(
  db: Db,
  userId: string,
  name: string,
  cursor: string | null = null,
  limit = EXPORT_PAGE_SIZE,
): Promise<ExportTablePage> {
  const entry = exportable(name);
  const size = Math.max(1, Math.min(EXPORT_PAGE_SIZE, Math.floor(limit)));
  const after = cursor === null ? undefined : decodeCursor(cursor);
  // One extra row says whether another page exists without a second query.
  const fetched = await orderedRows(db, entry.table, { userId, after, limit: size + 1 });
  const rows = fetched.slice(0, size);
  const secretKeys = secretColumns(name).map((col) => columnKey(entry.table, col));
  if (secretKeys.length > 0) {
    for (const row of rows) for (const key of secretKeys) row[key] = null;
  }
  const [pk] = orderColumns(entry.table);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > size && last && pk ? encodeCursor(last[columnKey(entry.table, pk.name)]) : null;
  return { rows, nextCursor };
}
