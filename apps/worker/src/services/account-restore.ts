/**
 * Restore an account from its export — disaster recovery (Phase 0 Task 9,
 * reworked for audit 1 data findings 1-8 under rulings B1-B4, B9, B10).
 *
 *   check/start { schemaVersion, manifest, sourceUserId, exportedAt,
 *          exportedFrom } — open a CHECK SESSION (B10): a signed token that
 *          binds the restore id to come, the file's schema version, its
 *          MANIFEST (rows per restorable table — every one of them, zero
 *          included) and the id of the account it was exported from.
 *   check  { session, table, rows, offset } — validate one page with NO side
 *          effects: the table is one a restore accepts, every row has its
 *          required columns, every value has its column's type, and
 *          `user_preferences.prefs` passes the preferences schema. A clean page
 *          earns a page token bound to the session, the table, where the page
 *          starts, its row count and its exact rows; a dirty one gets per-row
 *          errors.
 *   begin  { session, tokens, replace: true } — requires page tokens that
 *          cover the manifest exactly (every row of every table, each page
 *          once), then sets the RESTORE MARKER (account_state.restore_id, so
 *          every writer stands down) and wipes ALL of the account's data,
 *          provider connections and cursors included. Only `users`,
 *          `sessions` and `oauth_states` survive. Refused while ANOTHER
 *          restore is running (its heartbeat is under two minutes old).
 *   rows   { restoreId, table, rows, token } — insert one checked page into the
 *          restore that is in progress, and beat its heartbeat. Unfinished
 *          work in the file is neutralised on the way in (B3). An insert error
 *          is a 422 naming the table and row; rows lost to a conflict are
 *          counted.
 *   finish { restoreId } — count what landed against the manifest, flag the
 *          garden to catch up from the file's last day and the calendar for
 *          its one-shot post-restore reconcile, clear the marker.
 *   start-fresh { restoreId? } — abandon an unfinished restore: wipe as begin
 *          does and clear the marker. Refused while the restore is running,
 *          unless the caller is the one running it.
 *
 * Invariants:
 *  - Nothing is deleted before the whole file has been checked: begin refuses
 *    without page tokens covering the whole manifest, and `rows` only accepts
 *    a page whose rows are exactly the rows a clean check of THIS restore
 *    signed.
 *  - Only `user` and `child` tables are accepted, minus the ones never
 *    restored: `provider_connections` (tokens cannot come from a file — the
 *    athlete reconnects), `provider_cursor_state` (a Google sync token from the
 *    file would hide every event created since) and `coach_locks` (a lock from
 *    the export is someone else's claim).
 *  - A child row is kept only when its parent row belongs to THIS account.
 *  - Ids derived from the exporting account's id are re-keyed to the signed-in
 *    account when the file came from a different one — that id is the one the
 *    check session signed, never one a later request names.
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
import { loadAccountState, patchAccountState, restoreRunning } from "./account-state.js";
import { chunkIds, type Db } from "./db.js";

/** User tables a restore never writes (see the module comment). */
export const NEVER_RESTORED = ["provider_connections", "provider_cursor_state", "coach_locks"] as const;

/** Most rows one `check` or `rows` request may carry. */
export const RESTORE_MAX_ROWS = 1000;

/** Errors reported per page — the first ones say what is wrong. */
const MAX_ERRORS_PER_PAGE = 20;

/** A check session and its page tokens are good for a day: a check and the
 * restore it clears are one sitting. */
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
  | "check_required"
  | "check_expired"
  | "bad_manifest"
  | "not_in_manifest"
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

// ── Check sessions and page tokens (B10) ────────────────────────────────────

interface SessionPayload {
  v: 2;
  k: "session";
  /** Account the check runs for. */
  u: string;
  /** The restore id this check clears — begin's marker. */
  rid: string;
  /** The file's schema version. */
  s: string;
  /** Rows per restorable table, as the file holds them. */
  m: Record<string, number>;
  /** The account the file was exported from (id re-keying), or null. */
  src: string | null;
  /** The file's exportedAt / exportedFrom, for the "didn't finish" notice. */
  ea: string | null;
  ef: string | null;
  /** Issued at, epoch ms. */
  iat: number;
}

interface PagePayload {
  v: 2;
  k: "page";
  u: string;
  rid: string;
  t: string;
  /** Where the page starts in its table. */
  o: number;
  n: number;
  /** sha-256 of the page's canonical JSON. */
  d: string;
  src: string | null;
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

async function sign(payload: SessionPayload | PagePayload, secret: string): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

type Verified<T> = { ok: true; payload: T } | { ok: false; error: "check_required" | "check_expired" };

/** A token this worker signed, of this kind, for this account — and whether
 * it is still in date (M10: an expired check says so, it is not "changed"). */
async function verifyToken<K extends "session" | "page">(
  token: unknown,
  kind: K,
  userId: string,
  secret: string,
  now: Date,
): Promise<Verified<K extends "session" ? SessionPayload : PagePayload>> {
  const invalid = { ok: false as const, error: "check_required" as const };
  if (typeof token !== "string") return invalid;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return invalid;
  if (!timingSafeEqual(sig, await hmac(secret, body))) return invalid;
  let payload: SessionPayload | PagePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload | PagePayload;
  } catch {
    return invalid;
  }
  if (payload.v !== 2 || payload.k !== kind || payload.u !== userId) return invalid;
  if (!(now.getTime() - payload.iat < TOKEN_TTL_MS)) return { ok: false, error: "check_expired" };
  return { ok: true, payload: payload as K extends "session" ? SessionPayload : PagePayload };
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

export type CheckSessionResult =
  | { ok: true; session: string; restoreId: string }
  | { ok: false; errors: RowError[] };

const MAX_TABLE_ROWS = 10_000_000;

/**
 * Open a check session (B10). The manifest must name EVERY table a restore
 * writes — a table the file lacks (an older schema) is named with 0 — so the
 * session says, and signs, how much the file holds; begin then accepts only
 * page tokens of this session that cover every one of those rows exactly once.
 * No side effects.
 */
export async function openCheckSession(
  input: { schemaVersion: unknown; manifest: unknown; sourceUserId?: unknown; exportedAt?: unknown; exportedFrom?: unknown },
  ctx: { userId: string; secret: string; now?: Date },
): Promise<CheckSessionResult> {
  const fail = (code: RowErrorCode, message: string): CheckSessionResult => ({
    ok: false,
    errors: [{ row: -1, code, message }],
  });
  const verdict = schemaVersionVerdict(input.schemaVersion);
  if (verdict === "newer_schema") {
    return fail("newer_schema", "This file is from a newer version of the app. Update the app, then restore.");
  }
  if (verdict === "bad_schema_version") return fail("bad_schema_version", "This file has no readable version.");
  if (!isPlainObject(input.manifest)) return fail("bad_manifest", "The file's table counts are missing.");
  const restorable = restorableTables().map((t) => t.name);
  const manifest: Record<string, number> = {};
  for (const name of Object.keys(input.manifest)) {
    if (!restorable.includes(name)) return fail("bad_manifest", `${name}: not a table a restore writes`);
  }
  for (const name of restorable) {
    const n = input.manifest[name];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_TABLE_ROWS) {
      return fail("bad_manifest", `${name}: the file's row count is missing`);
    }
    manifest[name] = n;
  }
  const src = input.sourceUserId === null || input.sourceUserId === undefined ? null : shortString(input.sourceUserId);
  if (input.sourceUserId !== null && input.sourceUserId !== undefined && src === null) {
    return fail("bad_manifest", "The file's account id is not readable.");
  }
  const restoreId = newId();
  const session = await sign(
    {
      v: 2,
      k: "session",
      u: ctx.userId,
      rid: restoreId,
      s: input.schemaVersion as string,
      m: manifest,
      src,
      ea: shortString(input.exportedAt),
      ef: shortString(input.exportedFrom),
      iat: (ctx.now ?? new Date()).getTime(),
    },
    ctx.secret,
  );
  return { ok: true, session, restoreId };
}

/**
 * Check one page of the file. No side effects: nothing is read from or
 * written to the account. A clean page returns a token that begin and `rows`
 * require; it binds the check session (and so the restore id), the table,
 * where the page starts, its row count and its exact rows.
 */
export async function checkRestorePage(
  input: { session: unknown; table: unknown; rows: unknown; offset?: unknown },
  ctx: { userId: string; secret: string; now?: Date },
): Promise<CheckResult> {
  const now = ctx.now ?? new Date();
  const session = await verifyToken(input.session, "session", ctx.userId, ctx.secret, now);
  if (!session.ok) {
    return session.error === "check_expired"
      ? pageError("check_expired", "The check expired. Choose the file again.")
      : pageError("check_required", "The check did not start. Choose the file again.");
  }
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
  if (offset + input.rows.length > (session.payload.m[entry.name] ?? 0)) {
    return pageError("not_in_manifest", `${entry.name}: more rows than the file says it holds`);
  }
  const errors = checkRows(entry, input.rows, offset);
  if (errors.length > 0) return { ok: false, errors };
  const token = await sign(
    {
      v: 2,
      k: "page",
      u: ctx.userId,
      rid: session.payload.rid,
      t: entry.name,
      o: offset,
      n: input.rows.length,
      d: await pageDigest(input.rows),
      src: session.payload.src,
      iat: now.getTime(),
    },
    ctx.secret,
  );
  return { ok: true, token, rows: input.rows.length };
}

// ── Begin ───────────────────────────────────────────────────────────────────

export type BeginRestoreResult =
  | { ok: true; restoreId: string; tables: string[] }
  | { ok: false; status: 400; error: "replace_required" }
  | { ok: false; status: 409; error: "restore_running" }
  | {
      ok: false;
      status: 422;
      error: "bad_schema_version" | "newer_schema" | "check_required" | "check_expired" | "check_incomplete";
    };

const shortString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 300 ? v : null;

/**
 * Begin a restore. Requires `replace: true` — a restore always replaces the
 * whole account, and saying so is the caller's acknowledgement — the check
 * session, and page tokens of that session covering its manifest exactly: every
 * row of every table, each page once (M1, M2). Sets the marker FIRST, so
 * writers stand down before the wipe, then wipes everything the account owns.
 *
 * The restore id is the session's, so "Try again" with the same checked file
 * begins the same restore over. A DIFFERENT restore still running — its
 * heartbeat under two minutes old, another tab or device mid-way — is not
 * replaced (409); one that stopped beating may be.
 */
export async function beginRestore(
  db: Db,
  userId: string,
  input: { session?: unknown; replace: unknown; tokens?: unknown },
  ctx: { secret: string; now?: Date },
): Promise<BeginRestoreResult> {
  if (input.replace !== true) return { ok: false, status: 400, error: "replace_required" };
  const now = ctx.now ?? new Date();
  const verified = await verifyToken(input.session, "session", userId, ctx.secret, now);
  if (!verified.ok) return { ok: false, status: 422, error: verified.error };
  const session = verified.payload;
  const verdict = schemaVersionVerdict(session.s);
  if (verdict !== "ok") return { ok: false, status: 422, error: verdict };

  const tokens = input.tokens;
  if (!Array.isArray(tokens)) return { ok: false, status: 422, error: "check_required" };
  const pages = new Map<string, Array<{ o: number; n: number }>>();
  const seen = new Set<string>();
  for (const token of tokens) {
    const page = await verifyToken(token, "page", userId, ctx.secret, now);
    if (!page.ok) return { ok: false, status: 422, error: page.error };
    if (page.payload.rid !== session.rid) return { ok: false, status: 422, error: "check_required" };
    const key = `${page.payload.t}#${page.payload.o}`;
    if (seen.has(key)) return { ok: false, status: 422, error: "check_incomplete" };
    seen.add(key);
    const list = pages.get(page.payload.t) ?? [];
    list.push({ o: page.payload.o, n: page.payload.n });
    pages.set(page.payload.t, list);
  }
  // Every row of the manifest, each once, in pages that tile its table.
  for (const [table, list] of pages) {
    if (!(table in session.m)) return { ok: false, status: 422, error: "check_incomplete" };
    list.sort((a, b) => a.o - b.o);
  }
  for (const [table, want] of Object.entries(session.m)) {
    let at = 0;
    for (const { o, n } of pages.get(table) ?? []) {
      if (o !== at || n === 0) return { ok: false, status: 422, error: "check_incomplete" };
      at += n;
    }
    if (at !== want) return { ok: false, status: 422, error: "check_incomplete" };
  }

  const state = await loadAccountState(db, userId);
  if (state?.restoreId && state.restoreId !== session.rid && restoreRunning(state, now)) {
    return { ok: false, status: 409, error: "restore_running" };
  }

  const at = nowInstant(now);
  await patchAccountState(db, userId, {
    restoreId: session.rid,
    restoreStartedAt: at,
    restoreHeartbeatAt: at,
    restoreFileExportedAt: session.ea,
    restoreFileExportedFrom: session.ef,
    restoreExpected: session.m,
    restoreFinishedAt: null,
    calendarReconcile: null,
    gardenCatchUpPending: false,
  });
  await wipeAccountData(db, userId, { keep: [] });
  return { ok: true, restoreId: session.rid, tables: restorableTables().map((t) => t.name) };
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
  | { ok: false; status: 422; error: "unknown_table" | "not_restorable" | "bad_rows" | "check_required" | "check_expired" }
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

/**
 * Tables that hold one row per account AND key, under a unique index other
 * than the primary key: the FILE's row must win a key some writer took first
 * (ruling B9). `computed_metrics` is one row per (account, metric) — a
 * records row upserted mid-restore by an insights read would otherwise keep
 * the file's row out with the same id, and nothing would count it lost.
 */
const ONE_ROW_PER_KEY: Record<string, string[]> = {
  computed_metrics: ["userId", "metricKey"],
};

/** The single primary-key column (every restorable table has exactly one). */
function pkColumn(entry: AccountTable): SQLiteColumn {
  const [pk, ...rest] = orderColumns(entry.table);
  if (!pk || rest.length > 0) throw new Error(`account-restore: ${entry.name} has no single primary key`);
  return pk;
}

export async function restoreRows(
  db: Db,
  userId: string,
  input: { restoreId?: unknown; table: unknown; rows: unknown; token?: unknown },
  ctx: { secret: string; now?: Date },
): Promise<RestoreRowsResult> {
  if (!(await activeRestore(db, userId, input.restoreId))) return { ok: false, status: 409, error: "no_active_restore" };
  const result = await restoreRowsInto(db, userId, input as { restoreId: string; table: unknown; rows: unknown; token?: unknown }, ctx);
  // The heartbeat says "this restore is still running" (B10): every page
  // that lands beats it; a page this run cannot send stops it, so the
  // notice says the restore didn't finish right away rather than in two
  // minutes.
  await patchAccountState(db, userId, {
    restoreHeartbeatAt: result.ok ? nowInstant(ctx.now ?? new Date()) : null,
  });
  return result;
}

async function restoreRowsInto(
  db: Db,
  userId: string,
  input: { restoreId: string; table: unknown; rows: unknown; token?: unknown },
  ctx: { secret: string; now?: Date },
): Promise<RestoreRowsResult> {
  const found = restorableEntry(input.table);
  if ("error" in found) return { ok: false, status: 422, error: found.error };
  const { entry } = found;
  const raw = input.rows;
  if (!Array.isArray(raw) || raw.length > RESTORE_MAX_ROWS || !raw.every(isPlainObject)) {
    return { ok: false, status: 422, error: "bad_rows" };
  }
  const now = ctx.now ?? new Date();
  const verified = await verifyToken(input.token, "page", userId, ctx.secret, now);
  if (!verified.ok) return { ok: false, status: 422, error: verified.error };
  const payload = verified.payload;
  if (
    payload.rid !== input.restoreId ||
    payload.t !== entry.name ||
    payload.n !== raw.length ||
    payload.d !== (await pageDigest(raw))
  ) {
    return { ok: false, status: 422, error: "check_required" };
  }

  // The exporting account's id comes from the check session's signature,
  // never from this request (M3).
  const source = payload.src !== null && payload.src !== userId ? payload.src : null;
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
  const keyedBy = ONE_ROW_PER_KEY[entry.name];
  const perInsert = singleton || keyedBy ? 1 : Math.max(1, Math.floor(100 / columns.length));
  const tableColumns = getTableColumns(entry.table) as Record<string, SQLiteColumn>;
  const insert = (batch: Row[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = db.insert(entry.table as any).values(batch as any);
    if (singleton) {
      const { [pkKey]: _pk, ...set } = batch[0]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.onConflictDoUpdate({ target: pk as any, set: set as any });
    }
    if (keyedBy) {
      const set: Row = { ...batch[0]! };
      for (const k of keyedBy) delete set[k];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.onConflictDoUpdate({ target: keyedBy.map((k) => tableColumns[k]!) as any, set: set as any });
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
 *  - the garden is TRUSTED as the file holds it (B4 amended): state, events,
 *    day inputs, checkpoints, unlocks — nothing is rebuilt or deleted. It is
 *    only flagged to catch up from the file's last simulated day, forward
 *    only and capped per step, on the next garden reads;
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
    .select({ userId: gardenState.userId })
    .from(gardenState)
    .where(eq(gardenState.userId, userId))
    .limit(1);

  await patchAccountState(db, userId, {
    restoreId: null,
    restoreHeartbeatAt: null,
    restoreFinishedAt: nowInstant(now),
    calendarReconcile: { phase: "pending", sweep: short.length === 0 },
    gardenCatchUpPending: garden !== undefined,
  });
  return { ok: true, counts, expected, short };
}

// ── Start fresh ─────────────────────────────────────────────────────────────

/**
 * Abandon an unfinished restore: wipe everything begin would, clear the
 * marker. A restore that is still RUNNING — another tab or device sent a page
 * under two minutes ago — is not abandoned (M6): the caller must be the one
 * running it (it names its restore id), or wait for it to stop.
 */
export async function startFresh(
  db: Db,
  userId: string,
  input: { restoreId?: unknown } = {},
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; status: 409; error: "no_active_restore" | "restore_running" }> {
  const state = await loadAccountState(db, userId);
  if (!state?.restoreId) return { ok: false, status: 409, error: "no_active_restore" };
  if (input.restoreId !== state.restoreId && restoreRunning(state, now)) {
    return { ok: false, status: 409, error: "restore_running" };
  }
  await wipeAccountData(db, userId, { keep: [] });
  await patchAccountState(db, userId, {
    restoreId: null,
    restoreStartedAt: null,
    restoreHeartbeatAt: null,
    restoreFileExportedAt: null,
    restoreFileExportedFrom: null,
    restoreExpected: null,
    restoreFinishedAt: null,
    calendarReconcile: null,
    gardenCatchUpPending: false,
  });
  return { ok: true };
}
