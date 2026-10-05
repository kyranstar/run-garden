/**
 * The staging copier's work (Phase 0 Task 13; spec §13.2): copy production's
 * D1 (SRC) into staging's (DST) inside Cloudflare, table by table, in pages
 * small enough for D1's limits, resumable from any interruption, and checked
 * by per-table hashes computed on both sides. Nothing is ever written to
 * disk, and nothing this module returns carries a row.
 *
 * WHAT IS COPIED. Every table in the registry (account-tables.ts) except
 * `sessions` and `oauth_states` — whole tables, every account's rows (the
 * database holds one), the global catalogs and the restore bookkeeping
 * included, so staging is production as it stands. Credential columns
 * (`secretColumns`: provider tokens) are written as null: staging never holds
 * a production credential, even between the copy and the scrub. Staging also
 * runs with its own TOKEN_ENCRYPTION_KEY, so a token that somehow arrived
 * would still be unreadable there.
 *
 * ORDER AND PAGING. Rows go in primary-key order (Ruling R2) with the keyset
 * cursor the export uses (`orderedRows(..., { after })`), so a page boundary
 * never skips a row that exists throughout the copy. coach_locks — no
 * single-column key — is paged by offset; its unique index keeps a re-copied
 * row from doubling. Inserts are insert-or-ignore in `chunkedInsert` batches
 * (under D1's 100 bound variables): a step that died after writing and
 * before its state was saved simply runs again over rows already there.
 *
 * THE SENTINEL. D1 cannot say which database a binding points at, so the
 * copier proves it with a table: DST gets `staging_sentinel` on its first
 * run, and only while DST is completely empty; SRC must never have one. A
 * swapped pair, a production DST and the same database bound twice are all
 * refused before anything is written (see `guardBindings`). The sentinel
 * table also keeps the copy's progress, so the Worker holds no state.
 */
import { count, isNotNull, or, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { oauthStates, sessions } from "@rg/database";
import {
  ACCOUNT_TABLES,
  accountTable,
  budgetedRows,
  columnBySqlName,
  columnKey,
  hashTable,
  PAGE_BYTE_BUDGET,
  secretColumns,
  type AccountTable,
} from "../services/account-tables.js";
import { chunkedInsert, type Db } from "../services/db.js";

/** The only database the copier writes into. */
export const STAGING_DB_NAME = "run-garden-db-staging";

/** Present in staging once the copier has prepared it; never in production. */
export const SENTINEL_TABLE = "staging_sentinel";

/** Not copied: a sign-in on one device, and short-lived OAuth handshakes. */
export const COPY_EXCLUDED: readonly string[] = ["sessions", "oauth_states"];

/** Every other registry table, in registry (dependency) order. */
export const COPY_TABLES: readonly AccountTable[] = ACCOUNT_TABLES.filter((t) => !COPY_EXCLUDED.includes(t.name));

export interface CopyState {
  /** The table being copied; null between tables (and when finished). */
  table: string | null;
  /** Where `table` resumes: the last copied primary key (keyset), or — for a
   * table with no single-column key — how many rows were copied (offset).
   * Null at a table's start. */
  cursor: string | number | null;
  /** Tables copied to the end. */
  done: string[];
  /** Rows written by every step so far (a re-run step counts again). */
  rows: number;
}

export function initialCopyState(): CopyState {
  return { table: null, cursor: null, done: [], rows: 0 };
}

export function copyFinished(state: CopyState): boolean {
  return state.table === null && COPY_TABLES.every((t) => state.done.includes(t.name));
}

function copyTable(name: string): AccountTable {
  const entry = accountTable(name);
  if (!COPY_TABLES.includes(entry)) throw new Error(`copier: ${name} is not copied`);
  return entry;
}

/** True for a table name the copier copies. */
export function isCopyTable(name: string): boolean {
  return COPY_TABLES.some((t) => t.name === name);
}

/** The row key of a table's single-column primary key, or null. */
function keysetKey(entry: AccountTable): string | null {
  const pk = getTableConfig(entry.table).columns.filter((c) => c.primary);
  return pk.length === 1 ? columnKey(entry.table, pk[0]!.name) : null;
}

/**
 * Copy at most `budget.maxRows` rows — and, of a table with large columns (a
 * session build's payload), at most `budget.maxBytes` (default
 * `PAGE_BYTE_BUDGET`, one row at the least) — continuing from `state`, and
 * return the state to continue from. Pure in its inputs: the same state
 * against the same SRC copies the same rows, so any returned state can be
 * resumed.
 */
export async function copyStep(
  src: Db,
  dst: Db,
  state: CopyState,
  budget: { maxRows: number; maxBytes?: number },
): Promise<CopyState> {
  const done = [...state.done];
  let table = state.table;
  let cursor = state.cursor;
  let rows = state.rows;
  let remaining = Math.max(1, Math.floor(budget.maxRows));
  let remainingBytes = budget.maxBytes ?? PAGE_BYTE_BUDGET;

  while (remaining > 0 && remainingBytes > 0) {
    if (table === null) {
      const next = COPY_TABLES.find((t) => !done.includes(t.name));
      if (!next) break;
      table = next.name;
      cursor = null;
    }
    const entry = copyTable(table);
    const key = keysetKey(entry);
    const limit = remaining;
    const offset = typeof cursor === "number" && key === null ? cursor : 0;
    // Once this step holds rows, a heavy row that would take it past the byte budget waits for the next step.
    const orEmpty = rows > state.rows;
    const read = key
      ? await budgetedRows(src, entry.table, { after: cursor ?? undefined, limit, budget: remainingBytes, orEmpty })
      : await budgetedRows(src, entry.table, { offset, limit, budget: remainingBytes, orEmpty });
    const page = read.rows;
    if (read.bytes !== null) remainingBytes -= read.bytes;
    if (page.length === 0 && read.more) break; // the budget is spent; this table resumes here

    if (page.length > 0) {
      const secrets = secretColumns(entry.name).map((col) => columnKey(entry.table, col));
      for (const row of page) for (const k of secrets) row[k] = null;
      await chunkedInsert(page, (batch) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dst.insert(entry.table as any).values(batch as any).onConflictDoNothing(),
      );
      rows += page.length;
      remaining -= page.length;
    }

    if (!read.more) {
      done.push(table);
      table = null;
      cursor = null;
    } else {
      cursor = key ? (page[page.length - 1]![key] as string | number) : offset + page.length;
    }
  }
  return { table, cursor, done, rows };
}

export interface TableCheck {
  table: string;
  src: string;
  dst: string;
  srcRows: number;
  dstRows: number;
  ok: boolean;
}

/**
 * Per-table sha-256 on both sides (primary-key order, canonical JSON, read in
 * pages), credential columns hashed as null on both — they are never copied.
 */
export async function verifyCopy(src: Db, dst: Db, opts: { tables?: readonly string[] } = {}): Promise<TableCheck[]> {
  const targets = opts.tables ? opts.tables.map(copyTable) : COPY_TABLES;
  const out: TableCheck[] = [];
  for (const t of targets) {
    const mask = secretColumns(t.name);
    const a = await hashTable(src, t.table, { mask });
    const b = await hashTable(dst, t.table, { mask });
    out.push({
      table: t.name,
      src: a.sha256,
      dst: b.sha256,
      srcRows: a.rows,
      dstRows: b.rows,
      ok: a.sha256 === b.sha256 && a.rows === b.rows,
    });
  }
  return out;
}

function anySecret(entry: AccountTable) {
  return or(...secretColumns(entry.name).map((col) => isNotNull(columnBySqlName(entry.table, col))));
}

const withSecrets = (): AccountTable[] => ACCOUNT_TABLES.filter((t) => secretColumns(t.name).length > 0);

/**
 * Staging's restore-safety posture: no provider connection usable (every
 * credential column null — the connection rows themselves stay, so parity
 * can compare them), no sign-in session and no OAuth handshake left.
 */
export async function scrubSecrets(dst: Db): Promise<void> {
  for (const t of withSecrets()) {
    const nulls = Object.fromEntries(secretColumns(t.name).map((col) => [columnKey(t.table, col), null]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dst.update(t.table as any).set(nulls).where(anySecret(t));
  }
  await dst.delete(sessions);
  await dst.delete(oauthStates);
}

/** What a scrub must leave at zero. */
export async function secretsRemaining(dst: Db): Promise<{ secrets: number; sessions: number; oauthStates: number }> {
  let secrets = 0;
  for (const t of withSecrets()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [row] = await dst.select({ n: count() }).from(t.table as any).where(anySecret(t));
    secrets += Number(row?.n ?? 0);
  }
  const [s] = await dst.select({ n: count() }).from(sessions);
  const [o] = await dst.select({ n: count() }).from(oauthStates);
  return { secrets, sessions: Number(s?.n ?? 0), oauthStates: Number(o?.n ?? 0) };
}

// ── the sentinel ─────────────────────────────────────────────────────────────

async function hasTable(db: Db, name: string): Promise<boolean> {
  const rows = (await db.all(
    sql`select name from sqlite_master where type = 'table' and name = ${name}`,
  )) as Array<{ name: string }>;
  return rows.length > 0;
}

async function holdsAnyRow(db: Db): Promise<boolean> {
  for (const t of COPY_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await db.select({ one: sql<number>`1` }).from(t.table as any).limit(1);
    if (rows.length > 0) return true;
  }
  return false;
}

export type GuardRefusal = "src_is_staging" | "src_empty" | "dst_not_prepared" | "dst_not_empty" | "same_database";

/**
 * Null when SRC is not a staging database and DST is one; otherwise why not.
 *
 * - SRC has the sentinel → `src_is_staging` (bindings swapped, or both staging).
 * - DST has it → fine: a prepared staging database — as long as SRC holds
 *   rows. An empty SRC is `src_empty` (Audit 2 M2): production is never
 *   empty, and a DST that carries the sentinel with nothing to copy into it
 *   is a misbinding that `restart=1` would otherwise empty.
 * - DST lacks it and `prepare` is false → `dst_not_prepared` (verify and scrub
 *   never prepare).
 * - DST lacks it and holds ANY row → `dst_not_empty`, before writing anything:
 *   production always holds rows, so production never gets a sentinel. A
 *   staging database someone signed in to must be wiped first.
 * - Otherwise the sentinel is created in DST — and if SRC can now see it, the
 *   two bindings are one database: dropped again, `same_database`.
 */
export async function guardBindings(src: Db, dst: Db, opts: { prepare: boolean }): Promise<GuardRefusal | null> {
  if (await hasTable(src, SENTINEL_TABLE)) return "src_is_staging";
  if (await hasTable(dst, SENTINEL_TABLE)) return (await holdsAnyRow(src)) ? null : "src_empty";
  if (!opts.prepare) return "dst_not_prepared";
  if (await holdsAnyRow(dst)) return "dst_not_empty";
  await dst.run(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS ${SENTINEL_TABLE} (id TEXT PRIMARY KEY NOT NULL, state TEXT, updated_at TEXT NOT NULL)`,
    ),
  );
  if (await hasTable(src, SENTINEL_TABLE)) {
    await dst.run(sql.raw(`DROP TABLE IF EXISTS ${SENTINEL_TABLE}`));
    return "same_database";
  }
  return null;
}

// ── progress, kept in the sentinel table ─────────────────────────────────────

const STATE_ID = "copy";

function parseState(text: string | null | undefined): CopyState | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<CopyState>;
    const cursorOk = value.cursor === null || typeof value.cursor === "string" || typeof value.cursor === "number";
    if (
      (value.table === null || typeof value.table === "string") &&
      cursorOk &&
      Array.isArray(value.done) &&
      value.done.every((d) => typeof d === "string") &&
      typeof value.rows === "number"
    ) {
      return { table: value.table, cursor: value.cursor ?? null, done: value.done, rows: value.rows };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** The saved progress (null before the first step, or after a restart). */
export async function loadCopyState(dst: Db): Promise<CopyState | null> {
  const rows = (await dst.all(sql`select state from staging_sentinel where id = ${STATE_ID}`)) as Array<{
    state: string | null;
  }>;
  return parseState(rows[0]?.state);
}

export async function saveCopyState(dst: Db, state: CopyState): Promise<void> {
  const now = new Date().toISOString();
  await dst.run(
    sql`insert into staging_sentinel (id, state, updated_at) values (${STATE_ID}, ${JSON.stringify(state)}, ${now})
        on conflict(id) do update set state = excluded.state, updated_at = excluded.updated_at`,
  );
}

/** A fresh copy: every copied table in DST emptied, progress forgotten. The
 * sentinel table stays — DST is still staging. Only ever called after
 * `guardBindings` passed. */
export async function clearCopy(dst: Db): Promise<void> {
  for (const t of [...COPY_TABLES].reverse()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dst.delete(t.table as any);
  }
  await dst.run(sql`delete from staging_sentinel where id = ${STATE_ID}`);
}
