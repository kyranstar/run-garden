/**
 * Restore an account from its export — disaster recovery (Phase 0 Task 9,
 * reworked for audit 1 data findings 1-8 under rulings B1-B4).
 *
 *   check  { schemaVersion, table, rows } — validate one page with NO side
 *          effects: the table is one a restore accepts, every row has its
 *          required columns, every value has its column's type, and
 *          `user_preferences.prefs` passes the preferences schema. A clean page
 *          earns a signed page token; a dirty one gets per-row errors.
 *   begin  { schemaVersion, replace: true, tokens, exportedAt, exportedFrom }
 *          — requires the clean check's page tokens, then sets the RESTORE
 *          MARKER (account_state.restore_id, so every writer stands down) and
 *          wipes ALL of the account's data, provider connections and cursors
 *          included. Only `users`, `sessions` and `oauth_states` survive.
 *   rows   { restoreId, table, rows, token } — insert one checked page into the
 *          restore that is in progress. Unfinished work in the file is
 *          neutralised on the way in (B3). An insert error is a 422 naming the
 *          table and row; rows lost to a conflict are counted.
 *   finish { restoreId } — count what landed against what the checked pages
 *          promised, flag the garden for a full capped rebuild and the
 *          calendar for its one-shot post-restore reconcile, clear the marker.
 *   start-fresh — abandon an unfinished restore: wipe as begin does and clear
 *          the marker.
 *
 * Invariants:
 *  - Nothing is deleted before the whole file has been checked: begin refuses
 *    without valid page tokens, and `rows` only accepts a page whose rows are
 *    exactly the rows a clean check signed.
 *  - Only `user` and `child` tables are accepted, minus the ones never
 *    restored: `provider_connections` (tokens cannot come from a file — the
 *    athlete reconnects), `provider_cursor_state` (a Google sync token from the
 *    file would hide every event created since) and `coach_locks` (a lock from
 *    the export is someone else's claim).
 *  - A child row is kept only when its parent row belongs to THIS account.
 *  - Ids derived from the exporting account's id are re-keyed to the signed-in
 *    account when the file came from a different one.
 */
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { gardenState, SCHEMA_VERSION } from "@rg/database";
import { isLocalDate, newId, nowInstant, userPreferencesSchema } from "@rg/domain";
import { b64urlDecode, b64urlEncode, sha256Hex } from "../auth/crypto.js";
import {
  ACCOUNT_TABLES,
  accountTable,
  canonicalJson,
  columnBySqlName,
  columnKey,
  orderColumns,
  scopeWhere,
  secretColumns,
  wipeAccountData,
  type AccountTable,
} from "./account-tables.js";
import { loadAccountState, patchAccountState } from "./account-state.js";
import { chunkIds, type Db } from "./db.js";

/** User tables a restore never writes (see the module comment). */
export const NEVER_RESTORED = ["provider_connections", "provider_cursor_state", "coach_locks"] as const;

/** Most rows one `check` or `rows` request may carry. */
export const RESTORE_MAX_ROWS = 1000;

/** Errors reported per page — the first ones say what is wrong. */
const MAX_ERRORS_PER_PAGE = 20;

/** A page token is good for a day: a check and the restore it clears are one sitting. */
const TOKEN_TTL_MS = 24 * 3600 * 1000;

type Row = Record<string, unknown>;

/** The tables a restore writes, parents before children. */
export function restorableTables(): AccountTable[] {
  const never = new Set<string>(NEVER_RESTORED);
  return ACCOUNT_TABLES.filter(
    (t) => (t.scope.kind === "user" || t.scope.kind === "child") && !never.has(t.name),
  );
}

/** Tables an export carries that a restore deliberately leaves out: the
 * identity row and the never-restored tables. The client skips these. */
export function restoreSkips(): string[] {
  return ["users", ...NEVER_RESTORED];
}

// ── Schema version (finding 9) ──────────────────────────────────────────────

/**
 * An export from this schema or an older one is accepted — every migration so
 * far only adds, and the column check below refuses a file carrying a table
 * or column that no longer exists. A file from a NEWER schema is refused: it
 * may hold columns this worker would silently drop.
 */
export function schemaVersionVerdict(v: unknown): "ok" | "newer_schema" | "bad_schema_version" {
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) return "bad_schema_version";
  return v > SCHEMA_VERSION ? "newer_schema" : "ok";
}

// ── Check (B1) ──────────────────────────────────────────────────────────────

export type RowErrorCode =
  | "bad_schema_version"
  | "newer_schema"
  | "unknown_table"
  | "not_restorable"
  | "bad_rows"
  | "too_many_rows"
  | "not_an_object"
  | "unknown_column"
  | "missing_column"
  | "wrong_type"
  | "bad_prefs"
  | "bad_garden";

export interface RowError {
  /** Index of the row in the page; -1 for the page as a whole. */
  row: number;
  column?: string;
  code: RowErrorCode;
  message: string;
}

export type CheckResult = { ok: true; token: string; rows: number } | { ok: false; errors: RowError[] };

const isPlainObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

function pageError(code: RowErrorCode, message: string): CheckResult {
  return { ok: false, errors: [{ row: -1, code, message }] };
}

function typeOk(col: SQLiteColumn, v: unknown): boolean {
  switch (col.dataType) {
    case "string": {
      if (typeof v !== "string") return false;
      const allowed = (col as { enumValues?: readonly string[] }).enumValues;
      return !allowed || allowed.length === 0 || allowed.includes(v);
    }
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      return col.columnType === "SQLiteInteger" ? Number.isInteger(v) : true;
    case "boolean":
      return typeof v === "boolean";
    case "json":
      return true;
    default:
      return true;
  }
}

const typeName = (col: SQLiteColumn): string =>
  col.dataType === "number" && col.columnType === "SQLiteInteger" ? "whole number" : col.dataType === "json" ? "JSON" : col.dataType;

/** Every problem with these rows for this table, first ones first. Pure.
 * `offset` is where this page starts in its table, so row numbers read as
 * the table's own. */
export function checkRows(entry: AccountTable, rows: unknown[], offset = 0): RowError[] {
  const errors: RowError[] = [];
  const push = (e: RowError): boolean => {
    errors.push(e);
    return errors.length >= MAX_ERRORS_PER_PAGE;
  };
  const columns = Object.entries(getTableColumns(entry.table)) as Array<[string, SQLiteColumn]>;
  const known = new Map(columns);
  const secretKeys = new Set(secretColumns(entry.name).map((c) => columnKey(entry.table, c)));
  const where = (i: number) => `${entry.name} row ${i + 1}`;

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const i = r + offset;
    if (!isPlainObject(row)) {
      if (push({ row: i, code: "not_an_object", message: `${where(i)} is not an object` })) return errors;
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        if (push({ row: i, column: key, code: "unknown_column", message: `${where(i)}: unknown column "${key}"` })) {
          return errors;
        }
      }
    }
    for (const [key, col] of columns) {
      // The restore sets these itself: ownership is the signed-in account,
      // and a secret is never taken from a file.
      if (col.name === "user_id" || secretKeys.has(key)) continue;
      const v = row[key];
      if (v === undefined || v === null) {
        const required = col.notNull && (v === null || !col.hasDefault);
        if (required && push({ row: i, column: col.name, code: "missing_column", message: `${where(i)}: ${col.name} is missing` })) {
          return errors;
        }
        continue;
      }
      if (!typeOk(col, v)) {
        const message = `${where(i)}: ${col.name} should be a ${typeName(col)}`;
        if (push({ row: i, column: col.name, code: "wrong_type", message })) return errors;
      }
    }
    if (entry.name === "user_preferences" && row.prefs !== undefined && row.prefs !== null) {
      const parsed = userPreferencesSchema.safeParse(row.prefs);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.join(".") || "prefs";
        if (push({ row: i, column: "prefs", code: "bad_prefs", message: `${where(i)}: preference "${path}" is not valid` })) {
          return errors;
        }
      }
    }
    if (entry.name === "garden_state" && row.snapshot !== undefined && row.snapshot !== null) {
      const state = isPlainObject(row.snapshot) && isPlainObject(row.snapshot.state) ? row.snapshot.state : null;
      if (!state || !isLocalDate(String(state.createdDate)) || !isLocalDate(String(state.lastSimulatedDate))) {
        if (push({ row: i, column: "snapshot", code: "bad_garden", message: `${where(i)}: the garden snapshot is not readable` })) {
          return errors;
        }
      }
    }
  }
  return errors;
}

// ── Page tokens ─────────────────────────────────────────────────────────────

interface PagePayload {
  v: 1;
  /** Account the check ran for. */
  u: string;
  /** The file's schema version. */
  s: string;
  t: string;
  n: number;
  /** sha-256 of the page's canonical JSON. */
  d: string;
  /** Issued at, epoch ms. */
  iat: number;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function pageDigest(rows: unknown[]): Promise<string> {
  return sha256Hex(canonicalJson(rows));
}

async function signPage(payload: PagePayload, secret: string): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

async function verifyPage(token: unknown, userId: string, secret: string, now: Date): Promise<PagePayload | null> {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(secret, body))) return null;
  let payload: PagePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as PagePayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || payload.u !== userId) return null;
  if (!(now.getTime() - payload.iat < TOKEN_TTL_MS)) return null;
  return payload;
}

function restorableEntry(name: unknown): { entry: AccountTable } | { error: "unknown_table" | "not_restorable" } {
  if (typeof name !== "string") return { error: "unknown_table" };
  let entry: AccountTable;
  try {
    entry = accountTable(name);
  } catch {
    return { error: "unknown_table" };
  }
  if (!restorableTables().some((t) => t.name === entry.name)) return { error: "not_restorable" };
  return { entry };
}

/**
 * Check one page of the file. No side effects: nothing is read from or
 * written to the account. A clean page returns a token that `begin` and
 * `rows` require; the token binds the account, the schema version, the
 * table, the row count and the exact rows.
 */
export async function checkRestorePage(
  input: { schemaVersion: unknown; table: unknown; rows: unknown; offset?: unknown },
  ctx: { userId: string; secret: string; now?: Date },
): Promise<CheckResult> {
  const verdict = schemaVersionVerdict(input.schemaVersion);
  if (verdict === "newer_schema") {
    return pageError("newer_schema", "This file is from a newer version of the app. Update the app, then restore.");
  }
  if (verdict === "bad_schema_version") return pageError("bad_schema_version", "This file has no readable version.");
  const found = restorableEntry(input.table);
  if ("error" in found) {
    const name = typeof input.table === "string" ? input.table : "?";
    return found.error === "unknown_table"
      ? pageError("unknown_table", `${name}: this app has no such table`)
      : pageError("not_restorable", `${name}: this table can't be restored`);
  }
  const { entry } = found;
  if (!Array.isArray(input.rows)) return pageError("bad_rows", `${entry.name}: rows are not a list`);
  if (input.rows.length > RESTORE_MAX_ROWS) {
    return pageError("too_many_rows", `${entry.name}: more than ${RESTORE_MAX_ROWS} rows in one page`);
  }
  const offset = typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const errors = checkRows(entry, input.rows, offset);
  if (errors.length > 0) return { ok: false, errors };
  const token = await signPage(
    {
      v: 1,
      u: ctx.userId,
      s: input.schemaVersion as string,
      t: entry.name,
      n: input.rows.length,
      d: await pageDigest(input.rows),
      iat: (ctx.now ?? new Date()).getTime(),
    },
    ctx.secret,
  );
  return { ok: true, token, rows: input.rows.length };
}

// ── Begin ───────────────────────────────────────────────────────────────────

export type BeginRestoreResult =
  | { ok: true; restoreId: string; tables: string[] }
  | { ok: false; status: 400; error: "replace_required" }
  | { ok: false; status: 422; error: "bad_schema_version" | "newer_schema" | "check_required" };

const shortString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 300 ? v : null;

/**
 * Begin a restore. Requires `replace: true` — a restore always replaces the
 * whole account, and saying so is the caller's acknowledgement — and the
 * page tokens of a clean check. Sets the marker FIRST, so writers stand down
 * before the wipe, then wipes everything the account owns. May be called
 * while a restore is already marked ("Restore again"): the new id replaces
 * the old one, and the old tab's later pages are refused.
 */
export async function beginRestore(
  db: Db,
  userId: string,
  input: { schemaVersion: unknown; replace: unknown; tokens?: unknown; exportedAt?: unknown; exportedFrom?: unknown },
  ctx: { secret: string; now?: Date },
): Promise<BeginRestoreResult> {
  if (input.replace !== true) return { ok: false, status: 400, error: "replace_required" };
  const verdict = schemaVersionVerdict(input.schemaVersion);
  if (verdict !== "ok") return { ok: false, status: 422, error: verdict };
  const now = ctx.now ?? new Date();
  const tokens = input.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return { ok: false, status: 422, error: "check_required" };
  const restorable = new Set(restorableTables().map((t) => t.name));
  const expected: Record<string, number> = {};
  for (const token of tokens) {
    const payload = await verifyPage(token, userId, ctx.secret, now);
    if (!payload || payload.s !== input.schemaVersion || !restorable.has(payload.t)) {
      return { ok: false, status: 422, error: "check_required" };
    }
    expected[payload.t] = (expected[payload.t] ?? 0) + payload.n;
  }

  const restoreId = newId();
  await patchAccountState(db, userId, {
    restoreId,
    restoreStartedAt: nowInstant(now),
    restoreFileExportedAt: shortString(input.exportedAt),
    restoreFileExportedFrom: shortString(input.exportedFrom),
    restoreExpected: expected,
    restoreFinishedAt: null,
    calendarReconcile: null,
    gardenRebuildPending: false,
    gardenRebuildFrom: null,
  });
  await wipeAccountData(db, userId, { keep: [] });
  return { ok: true, restoreId, tables: restorableTables().map((t) => t.name) };
}

async function activeRestore(db: Db, userId: string, restoreId: unknown): Promise<boolean> {
  if (typeof restoreId !== "string" || restoreId === "") return false;
  const state = await loadAccountState(db, userId);
  return state?.restoreId === restoreId;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export type RestoreRowsResult =
  | { ok: true; received: number; skipped: number; lost: number }
  | { ok: false; status: 409; error: "no_active_restore" }
  | { ok: false; status: 422; error: "unknown_table" | "not_restorable" | "bad_rows" | "check_required" }
  | { ok: false; status: 422; error: "insert_failed"; table: string; row: number; detail: string };

/** Write-job statuses that would still run (B3). */
const LIVE_JOB_STATUSES = new Set(["queued", "claimed", "in_progress", "verifying"]);

/**
 * Unfinished work in the file is switched off as it lands (ruling B3):
 * nothing a restore brings back writes to COROS or spends on the LLM until
 * the athlete does something new. `llm_usage` is restored as it is.
 */
export function neutralise(table: string, row: Row, now: string): Row {
  switch (table) {
    case "coros_write_jobs":
      if (typeof row.status === "string" && LIVE_JOB_STATUSES.has(row.status)) {
        return {
          ...row,
          status: "restored",
          claimedByDeviceId: null,
          claimedAt: null,
          completedAt: row.completedAt ?? now,
          updatedAt: now,
        };
      }
      return row;
    case "coach_reads":
      if (row.status === "queued" || row.status === "running") {
        return { ...row, status: "skipped", claimToken: null, claimedAt: null, completedAt: row.completedAt ?? now };
      }
      return row;
    case "coach_triggers":
      return row.consumedAt === null || row.consumedAt === undefined ? { ...row, consumedAt: now } : row;
    case "backfill_state":
      if (row.status === "queued" || row.status === "running" || row.status === "error") {
        return { ...row, status: "idle", updatedAt: now };
      }
      return row;
    case "sync_intents":
      if ((row.resolvedAt ?? null) === null && (row.supersededBy ?? null) === null) {
        return { ...row, supersededBy: "restored" };
      }
      return row;
    default:
      return row;
  }
}

/** The single primary-key column (every restorable table has exactly one). */
function pkColumn(entry: AccountTable): SQLiteColumn {
  const [pk, ...rest] = orderColumns(entry.table);
  if (!pk || rest.length > 0) throw new Error(`account-restore: ${entry.name} has no single primary key`);
  return pk;
}

export async function restoreRows(
  db: Db,
  userId: string,
  input: { restoreId?: unknown; table: unknown; rows: unknown; token?: unknown; sourceUserId?: unknown },
  ctx: { secret: string; now?: Date },
): Promise<RestoreRowsResult> {
  if (!(await activeRestore(db, userId, input.restoreId))) return { ok: false, status: 409, error: "no_active_restore" };
  const found = restorableEntry(input.table);
  if ("error" in found) return { ok: false, status: 422, error: found.error };
  const { entry } = found;
  const raw = input.rows;
  if (!Array.isArray(raw) || raw.length > RESTORE_MAX_ROWS || !raw.every(isPlainObject)) {
    return { ok: false, status: 422, error: "bad_rows" };
  }
  const now = ctx.now ?? new Date();
  const payload = await verifyPage(input.token, userId, ctx.secret, now);
  if (!payload || payload.t !== entry.name || payload.n !== raw.length || payload.d !== (await pageDigest(raw))) {
    return { ok: false, status: 422, error: "check_required" };
  }

  const source =
    typeof input.sourceUserId === "string" && input.sourceUserId !== "" && input.sourceUserId !== userId
      ? input.sourceUserId
      : null;
  const columns = Object.entries(getTableColumns(entry.table));
  const secretKeys = new Set(secretColumns(entry.name).map((c) => columnKey(entry.table, c)));
  const nowIso = nowInstant(now);

  let rows: Array<{ index: number; row: Row }> = (raw as Row[]).map((src, index) => {
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
    return { index, row: neutralise(entry.name, row, nowIso) };
  });

  if (entry.scope.kind === "child") rows = await keepOwnedChildren(db, userId, entry, rows);

  const pk = pkColumn(entry);
  const pkKey = columnKey(entry.table, pk.name);
  // A table keyed by user_id holds one row per account (preferences, the
  // garden, the backfill checkpoint): the FILE must win it, even over a row
  // some writer slipped in before the marker was seen.
  const singleton = pk.name === "user_id";
  const perInsert = singleton ? 1 : Math.max(1, Math.floor(100 / columns.length));
  const insert = (batch: Row[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = db.insert(entry.table as any).values(batch as any);
    if (singleton) {
      const { [pkKey]: _pk, ...set } = batch[0]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.onConflictDoUpdate({ target: pk as any, set: set as any });
    }
    return q.onConflictDoNothing();
  };
  for (let i = 0; i < rows.length; i += perInsert) {
    const batch = rows.slice(i, i + perInsert);
    try {
      await insert(batch.map((b) => b.row));
    } catch {
      // Find the row: one at a time through this batch, so the athlete is
      // told which row of which table the database refused.
      for (const b of batch) {
        try {
          await insert([b.row]);
        } catch (e) {
          const detail = e instanceof Error ? e.message.slice(0, 200) : "insert failed";
          return { ok: false, status: 422, error: "insert_failed", table: entry.name, row: b.index, detail };
        }
      }
    }
  }

  // Rows lost to a conflict (another row already holds the key, or a unique
  // index): the page said "ok" before and the loss was silent (finding 2).
  const wanted = rows
    .map((r) => r.row[pkKey])
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String);
  const present = new Set<string>();
  for (const ids of chunkIds([...new Set(wanted)])) {
    const found2 = await db
      .select({ id: pk })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(entry.table as any)
      .where(and(inArray(pk, ids), scopeWhere(entry, userId)));
    for (const f of found2) present.add(String(f.id));
  }
  const lost = rows.filter((r) => !present.has(String(r.row[pkKey]))).length;
  return { ok: true, received: raw.length, skipped: raw.length - rows.length, lost };
}

/** Drop child rows whose parent row is not this account's. */
async function keepOwnedChildren(
  db: Db,
  userId: string,
  entry: AccountTable,
  rows: Array<{ index: number; row: Row }>,
): Promise<Array<{ index: number; row: Row }>> {
  if (entry.scope.kind !== "child") return rows;
  const parent = accountTable(entry.scope.parent);
  const parentKey = columnBySqlName(parent.table, entry.scope.parentKey ?? "id");
  const childKey = columnKey(entry.table, entry.scope.column);
  const wanted = [
    ...new Set(rows.map((r) => r.row[childKey]).filter((v): v is string => typeof v === "string")),
  ];
  const owned = new Set<string>();
  for (const ids of chunkIds(wanted)) {
    const found = await db
      .select({ id: parentKey })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(parent.table as any)
      .where(and(inArray(parentKey, ids), scopeWhere(parent, userId)));
    for (const f of found) owned.add(String(f.id));
  }
  return rows.filter((r) => typeof r.row[childKey] === "string" && owned.has(r.row[childKey] as string));
}

// ── Finish ──────────────────────────────────────────────────────────────────

export interface ShortTable {
  table: string;
  expected: number;
  restored: number;
}

export type FinishRestoreResult =
  | { ok: true; counts: Record<string, number>; expected: Record<string, number>; short: ShortTable[] }
  | { ok: false; status: 409; error: "no_active_restore" };

/**
 * Finish: count what landed, compare it with what the checked pages
 * promised, and hand the slow work to the paths built for it — never do it
 * here (ruling B4):
 *  - the garden is flagged for a FULL rebuild from its genesis through the
 *    resumable, day-capped rebuild; the next garden reads walk it forward;
 *  - the calendar gets a one-shot reconcile on its first successful full
 *    read once Google is reconnected (B6) — allowed to delete orphaned
 *    events only when no table came back short.
 * Then the marker is cleared.
 */
export async function finishRestore(
  db: Db,
  userId: string,
  input: { restoreId?: unknown },
  now: Date = new Date(),
): Promise<FinishRestoreResult> {
  const state = await loadAccountState(db, userId);
  if (typeof input.restoreId !== "string" || !state || state.restoreId !== input.restoreId) {
    return { ok: false, status: 409, error: "no_active_restore" };
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
  const expected = state.restoreExpected ?? {};
  const short: ShortTable[] = [];
  for (const t of restorableTables()) {
    const want = expected[t.name] ?? 0;
    if (counts[t.name]! < want) short.push({ table: t.name, expected: want, restored: counts[t.name]! });
  }

  const [garden] = await db
    .select({ snapshot: gardenState.snapshot })
    .from(gardenState)
    .where(eq(gardenState.userId, userId))
    .limit(1);
  const createdDate = (garden?.snapshot as { state?: { createdDate?: unknown } } | undefined)?.state?.createdDate;

  await patchAccountState(db, userId, {
    restoreId: null,
    restoreFinishedAt: nowInstant(now),
    calendarReconcile: { phase: "pending", sweep: short.length === 0 },
    gardenRebuildPending: garden !== undefined,
    gardenRebuildFrom: garden !== undefined && typeof createdDate === "string" ? createdDate : null,
  });
  return { ok: true, counts, expected, short };
}

// ── Start fresh ─────────────────────────────────────────────────────────────

/** Abandon an unfinished restore: wipe everything begin would, clear the marker. */
export async function startFresh(
  db: Db,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: 409; error: "no_active_restore" }> {
  const state = await loadAccountState(db, userId);
  if (!state?.restoreId) return { ok: false, status: 409, error: "no_active_restore" };
  await wipeAccountData(db, userId, { keep: [] });
  await patchAccountState(db, userId, {
    restoreId: null,
    restoreStartedAt: null,
    restoreFileExportedAt: null,
    restoreFileExportedFrom: null,
    restoreExpected: null,
    restoreFinishedAt: null,
    calendarReconcile: null,
    gardenRebuildPending: false,
    gardenRebuildFrom: null,
  });
  return { ok: true };
}
