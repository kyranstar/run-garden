/**
 * What the client does, as plain service calls: export the account page by
 * page, and restore a file by opening a check session with the file's
 * manifest, checking every page, then begin → rows → finish.
 * Shared by the restore suites so each one drives the real sequence rather
 * than a shortcut that skips the check.
 */
import { nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { exportManifest, exportTablePage } from "../src/services/account-export.js";
import {
  beginRestore,
  checkRestorePage,
  finishRestore,
  openCheckSession,
  restorableTables,
  restoreRows,
  restoreSkips,
  type RowError,
} from "../src/services/account-restore.js";

export const TEST_SECRET = "test-session-secret";

type Row = Record<string, unknown>;
export interface ExportFile {
  format: string;
  schemaVersion: string;
  exportedAt: string;
  exportedFrom?: string;
  tables: Record<string, Row[]>;
}

/** The manifest, then every table page by page. A small page size forces
 * the seeded planned workouts across several pages. */
export async function exportAll(db: Db, userId: string, pageSize = 100): Promise<ExportFile> {
  const manifest = await exportManifest(db, userId);
  const tables: Record<string, Row[]> = {};
  for (const { name } of manifest.tables) {
    const rows: Row[] = [];
    let cursor: string | null = null;
    do {
      const page = await exportTablePage(db, userId, name, cursor, pageSize);
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
    tables[name] = rows;
  }
  return { format: manifest.format, schemaVersion: manifest.schemaVersion, exportedAt: nowInstant(), tables };
}

/** The pages a table is sent in — the SAME slices for check and rows. */
export function pagesOf(rows: Row[], pageSize: number): Row[][] {
  const out: Row[][] = [];
  for (let i = 0; i < rows.length; i += pageSize) out.push(rows.slice(i, i + pageSize));
  return out;
}

export interface CheckedFile {
  /** The check session's token and the restore id it will begin. */
  session: string;
  restoreId: string;
  /** `${table}#${page}` → the page's token. */
  tokens: Map<string, string>;
  errors: RowError[];
}

/** Rows per restorable table, as the file holds them — every table named. */
export function manifestOf(file: ExportFile): Record<string, number> {
  return Object.fromEntries(restorableTables().map((t) => [t.name, file.tables[t.name]?.length ?? 0]));
}

export async function checkFile(
  db: Db,
  userId: string,
  file: ExportFile,
  pageSize = 200,
  opts: { now?: Date } = {},
): Promise<CheckedFile> {
  void db;
  const ctx = { userId, secret: TEST_SECRET, now: opts.now };
  const opened = await openCheckSession(
    {
      schemaVersion: file.schemaVersion,
      manifest: manifestOf(file),
      sourceUserId: (file.tables.users?.[0]?.id as string | undefined) ?? null,
      exportedAt: file.exportedAt,
      exportedFrom: file.exportedFrom,
    },
    ctx,
  );
  if (!opened.ok) return { session: "", restoreId: "", tokens: new Map(), errors: opened.errors };
  const skip = new Set(restoreSkips());
  const tokens = new Map<string, string>();
  const errors: RowError[] = [];
  for (const [table, rows] of Object.entries(file.tables)) {
    if (skip.has(table)) continue;
    const pages = pagesOf(rows, pageSize);
    for (let p = 0; p < pages.length; p += 1) {
      const res = await checkRestorePage({ session: opened.session, table, rows: pages[p], offset: p * pageSize }, ctx);
      if (res.ok) tokens.set(`${table}#${p}`, res.token);
      else errors.push(...res.errors);
    }
  }
  return { session: opened.session, restoreId: opened.restoreId, tokens, errors };
}

export interface RestoreOutcome {
  restoreId: string;
  counts: Record<string, number>;
  expected: Record<string, number>;
  short: Array<{ table: string; expected: number; restored: number }>;
  lost: number;
}

/** Check → begin(replace) → rows per table in the server's order → finish. */
export async function restoreAll(
  db: Db,
  userId: string,
  file: ExportFile,
  opts: { pageSize?: number; beforeRows?: () => Promise<void>; beforeFinish?: () => Promise<void> } = {},
): Promise<RestoreOutcome> {
  const pageSize = opts.pageSize ?? 200;
  const checked = await checkFile(db, userId, file, pageSize);
  if (checked.errors.length > 0) throw new Error(`check failed: ${checked.errors[0]!.message}`);
  const begun = await beginRestore(
    db,
    userId,
    { session: checked.session, replace: true, tokens: [...checked.tokens.values()] },
    { secret: TEST_SECRET },
  );
  if (!begun.ok) throw new Error(`begin refused: ${begun.error}`);
  await opts.beforeRows?.();
  let lost = 0;
  for (const table of begun.tables) {
    const pages = pagesOf(file.tables[table] ?? [], pageSize);
    for (let p = 0; p < pages.length; p += 1) {
      const res = await restoreRows(
        db,
        userId,
        { restoreId: begun.restoreId, table, rows: pages[p], token: checked.tokens.get(`${table}#${p}`) },
        { secret: TEST_SECRET },
      );
      if (!res.ok) throw new Error(`rows refused for ${table}: ${res.error}`);
      lost += res.lost;
    }
  }
  await opts.beforeFinish?.();
  const done = await finishRestore(db, userId, { restoreId: begun.restoreId });
  if (!done.ok) throw new Error(`finish refused: ${done.error}`);
  return { restoreId: begun.restoreId, counts: done.counts, expected: done.expected, short: done.short, lost };
}
