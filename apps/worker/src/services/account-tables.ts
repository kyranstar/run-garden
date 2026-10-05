/**
 * ONE registry of every table the schema declares, and how each one belongs to
 * an account (Phase 0 Task 8).
 *
 * Export, restore, delete-all, the staging copier and the parity harness all
 * need the same answer to "which rows are this person's?". Before this each
 * kept its own hand-written list, and they drifted: the old export covered 11
 * of ~50 tables, and delete-all had missed 13 before a coverage test caught
 * it. Now there is one list, and `account-tables.test.ts` fails the moment a
 * table exists in the schema barrel without an entry here.
 *
 * Scopes:
 *  - `user`     — the table has its own `user_id` column.
 *  - `child`    — no `user_id`; its rows are reached through a parent table's
 *                 ids (`column` on this table → `parentKey` on the parent, which
 *                 is itself a `user` table).
 *  - `identity` — the `users` row itself: exported, never restored over.
 *  - `excluded` — not account data at all (auth sessions, OAuth handshakes,
 *                 global catalogs, app versioning).
 *
 * Column names in scopes and `secretColumns` are SQL names (`activity_id`),
 * not drizzle property keys — they are the database-level identity and what a
 * raw statement needs; `columnKey` maps one to its row-object key.
 *
 * Also here: the shared row ORDER and HASH (Ruling R2). Every consumer that
 * compares tables — the parity harness, the copier's verify, the export's
 * paging — orders rows by primary key and hashes canonical JSON, so two
 * databases holding the same rows agree no matter how the rows got there.
 * `rowid` is deliberately not used: a table rebuild renumbers it.
 */
import { and, asc, eq, getTableColumns, getTableName, gt, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  accountState,
  activities,
  activityLaps,
  activitySourceLinks,
  activityStreamSummaries,
  athleteZones,
  auditEvents,
  backfillState,
  calendarEventLinks,
  calendarEventSuppressions,
  coachLocks,
  coachMemory,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  coachProposals,
  coachQuestions,
  coachReads,
  coachTriggers,
  computedMetrics,
  conditionChecks,
  corosExercises,
  corosScheduleSnapshots,
  corosWriteAttempts,
  corosWriteJobs,
  dailyHealth,
  dismissedInsights,
  exercisePrefs,
  exerciseProvenance,
  gardenDayInputs,
  gardenEvents,
  gardenPlants,
  gardenSceneLayouts,
  gardenSeen,
  gardenSnapshots,
  gardenSpecies,
  gardenState,
  gardenUnlocks,
  gardenVisitors,
  gardenWildlife,
  llmUsage,
  locations,
  motivationEvidence,
  oauthStates,
  performedSessions,
  performedSets,
  plannedWorkouts,
  plannedWorkoutStages,
  programBlocks,
  programs,
  programVersions,
  providerConnections,
  providerCursorState,
  scheduleOverrides,
  schemaVersions,
  sessionBuilds,
  sessions,
  sleepRecords,
  studioPlanPushes,
  studioPlans,
  syncErrors,
  syncIntents,
  syncNotes,
  syncRuns,
  trainingPlans,
  trainingPlanVersions,
  userConditions,
  userPreferences,
  users,
  weeklyReviews,
  workoutCompletionMatches,
} from "@rg/database";
import type { Db } from "./db.js";

export type TableScope =
  | { kind: "user" }
  | { kind: "child"; parent: string; column: string; parentKey?: string }
  | { kind: "identity" }
  | { kind: "excluded"; reason: string };

export interface AccountTable {
  name: string;
  table: SQLiteTable;
  scope: TableScope;
  /** Dependency order: parents before children. Restore inserts ascending;
   * a wipe deletes descending (children first, while the parent ids that
   * reach them still exist). */
  order: number;
}

const USER = { kind: "user" } as const;
const child = (parent: string, column: string): TableScope => ({ kind: "child", parent, column });
const excluded = (reason: string): TableScope => ({ kind: "excluded", reason });

/**
 * Listed in dependency order — the position IS `order`. Identity first, then
 * every `user` table, then the children (each after its parent), then the
 * tables that belong to no account.
 */
const ENTRIES: ReadonlyArray<readonly [SQLiteTable, TableScope]> = [
  [users, { kind: "identity" }],

  // identity & preferences
  [userPreferences, USER],
  [providerConnections, USER],
  // schedule
  [trainingPlans, USER],
  [plannedWorkouts, USER],
  [corosScheduleSnapshots, USER],
  [corosWriteJobs, USER],
  [syncIntents, USER],
  [syncNotes, USER],
  // activities & health
  [activities, USER],
  [dailyHealth, USER],
  [athleteZones, USER],
  [sleepRecords, USER],
  // garden
  [gardenState, USER],
  [gardenPlants, USER],
  [gardenEvents, USER],
  [gardenUnlocks, USER],
  [gardenWildlife, USER],
  [gardenSceneLayouts, USER],
  [gardenSnapshots, USER],
  [gardenVisitors, USER],
  [gardenDayInputs, USER],
  [gardenSeen, USER],
  // product
  [computedMetrics, USER],
  [motivationEvidence, USER],
  [weeklyReviews, USER],
  [dismissedInsights, USER],
  [llmUsage, USER],
  // ops
  [syncRuns, USER],
  [syncErrors, USER],
  [providerCursorState, USER],
  [auditEvents, USER],
  [backfillState, USER],
  // studio
  [studioPlans, USER],
  // coach
  [coachMemory, USER],
  [coachQuestions, USER],
  [coachMessages, USER],
  [coachProposals, USER],
  [coachTriggers, USER],
  [coachPlans, USER],
  [coachReads, USER],
  [coachLocks, USER],
  // programs, builds, performed sessions and exercise settings (0024–0027)
  [programs, USER],
  [sessionBuilds, USER],
  [performedSessions, USER],
  [conditionChecks, USER],
  [userConditions, USER],
  [locations, USER],
  [exercisePrefs, USER],
  [exerciseProvenance, USER],

  // children — reached only through a parent's ids
  [trainingPlanVersions, child("training_plans", "plan_id")],
  [plannedWorkoutStages, child("planned_workouts", "workout_id")],
  [scheduleOverrides, child("planned_workouts", "workout_id")],
  [workoutCompletionMatches, child("planned_workouts", "workout_id")],
  [calendarEventLinks, child("planned_workouts", "workout_id")],
  [calendarEventSuppressions, child("planned_workouts", "workout_id")],
  [corosWriteAttempts, child("coros_write_jobs", "job_id")],
  [activityLaps, child("activities", "activity_id")],
  [activitySourceLinks, child("activities", "activity_id")],
  [activityStreamSummaries, child("activities", "activity_id")],
  [studioPlanPushes, child("studio_plans", "plan_id")],
  [coachPlanWeeks, child("coach_plans", "plan_id")],
  [programVersions, child("programs", "program_id")],
  [programBlocks, child("programs", "program_id")],
  [performedSets, child("performed_sessions", "performed_session_id")],

  // no account owns these
  [sessions, excluded("auth: a session is a sign-in on one device, never data to carry")],
  [oauthStates, excluded("auth: short-lived OAuth handshakes with no owner")],
  [gardenSpecies, excluded("global catalog shared by every account")],
  [corosExercises, excluded("global COROS exercise catalog shared by every account")],
  [schemaVersions, excluded("app component versions, not account data")],
  [
    accountState,
    excluded("this environment's restore marker and post-restore flags — bookkeeping, never data to carry; delete-all removes it"),
  ],
];

export const ACCOUNT_TABLES: readonly AccountTable[] = ENTRIES.map(([table, scope], order) => ({
  name: getTableName(table),
  table,
  scope,
  order,
}));

const BY_NAME = new Map(ACCOUNT_TABLES.map((t) => [t.name, t]));

/** The registry entry for a table's SQL name; throws on an unknown table. */
export function accountTable(name: string): AccountTable {
  const entry = BY_NAME.get(name);
  if (!entry) throw new Error(`account-tables: unknown table "${name}"`);
  return entry;
}

/** Columns that hold credentials: exported as null, never restored, scrubbed
 * on any copy. SQL names. */
const SECRETS: Readonly<Record<string, readonly string[]>> = {
  provider_connections: ["encrypted_access_token", "encrypted_refresh_token"],
};

export function secretColumns(name: string): readonly string[] {
  accountTable(name); // throws on an unknown table
  return SECRETS[name] ?? [];
}

/**
 * Columns whose values can be large enough that a page of the table must be sized in BYTES, not rows (Ruling
 * 2a-R9): a stored session build is 107–142 KB of JSON, so the row-count pages every other table uses would hold
 * tens of megabytes. SQL names. Every reader that pages a table — the export, the copier, a table hash — measures
 * these columns before it reads (`budgetedRows`).
 */
const LARGE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_builds: ["payload"],
};

export function largeColumns(name: string): readonly string[] {
  accountTable(name); // throws on an unknown table
  return LARGE_COLUMNS[name] ?? [];
}

/**
 * The most row data one page carries, on every path that pages a table: an export page, a copier step, a table
 * hash's read (and, client side, a restore request — `RESTORE_PAGE_BYTES` in @rg/api-client, kept below this).
 * Sized so a page of build payloads stays a few milliseconds of parsing and serialising, well inside the Worker's
 * 10 ms CPU limit. A single row larger than this still travels, alone.
 */
export const PAGE_BYTE_BUDGET = 256 * 1024;
/** What a measured row's other (small) columns are counted as. */
const ROW_OVERHEAD_BYTES = 512;

/** The drizzle column whose SQL name is `sqlName`. */
export function columnBySqlName(table: SQLiteTable, sqlName: string): SQLiteColumn {
  const col = Object.values(getTableColumns(table)).find((c) => c.name === sqlName);
  if (!col) throw new Error(`account-tables: ${getTableName(table)} has no column "${sqlName}"`);
  return col;
}

/** The row-object key (drizzle property name) for a SQL column name. */
export function columnKey(table: SQLiteTable, sqlName: string): string {
  const entry = Object.entries(getTableColumns(table)).find(([, c]) => c.name === sqlName);
  if (!entry) throw new Error(`account-tables: ${getTableName(table)} has no column "${sqlName}"`);
  return entry[0];
}

/**
 * The WHERE condition selecting one account's rows of a table. A child is
 * reached with a subquery on its parent's ids — ONE bound variable whatever
 * the parent count, so it never meets D1's 100-variable ceiling and needs no
 * chunking. Excluded tables have no account rows and throw.
 */
export function scopeWhere(entry: AccountTable, userId: string): SQL {
  const scope = entry.scope;
  switch (scope.kind) {
    case "identity":
      return eq(columnBySqlName(entry.table, "id"), userId);
    case "user":
      return eq(columnBySqlName(entry.table, "user_id"), userId);
    case "child": {
      const parent = accountTable(scope.parent);
      const parentKey = columnBySqlName(parent.table, scope.parentKey ?? "id");
      return sql`${columnBySqlName(entry.table, scope.column)} in (select ${parentKey} from ${parent.table} where ${scopeWhere(parent, userId)})`;
    }
    case "excluded":
      throw new Error(`account-tables: "${entry.name}" belongs to no account (${scope.reason})`);
  }
}

/** Primary-key columns in declaration order (composite keys included); every
 * column when the table declares no primary key. */
export function orderColumns(table: SQLiteTable): SQLiteColumn[] {
  const config = getTableConfig(table);
  const composite = config.primaryKeys.flatMap((pk) => pk.columns);
  if (composite.length > 0) return composite;
  const single = config.columns.filter((c) => c.primary);
  if (single.length > 0) return single;
  return config.columns;
}

/**
 * Delete every `user` and `child` row belonging to this account, except the
 * tables named in `keep`. Children go first (descending `order`), while the
 * parent ids their scope subquery reads still exist. Identity (`users`) and
 * excluded tables (`sessions`, `oauth_states`, catalogs) are never touched
 * here — delete-all removes the session and the user row itself, and a
 * restore must keep both.
 *
 * Every child delete is scoped to THIS account's parent ids. The old
 * delete-all cleared child tables with no WHERE at all (a single-user
 * shortcut); a restore's wipe runs on a live account and must never reach
 * another account's rows.
 */
export async function wipeAccountData(
  db: Db,
  userId: string,
  opts: { keep: readonly string[] },
): Promise<void> {
  const keep = new Set(opts.keep);
  const targets = ACCOUNT_TABLES.filter(
    (t) => (t.scope.kind === "user" || t.scope.kind === "child") && !keep.has(t.name),
  ).sort((a, b) => b.order - a.order);
  for (const t of targets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.delete(t.table as any).where(scopeWhere(t, userId));
  }
}

/**
 * Delete child rows whose parent row no longer exists, in EVERY account.
 * Such a row belongs to no account (its only link to one is gone), so this is
 * safe with any number of users — unlike the WHERE-less child delete the old
 * delete-all used, which removed other accounts' live rows too. Delete-all
 * runs it after the scoped wipe (audit 1 data finding 10).
 */
export async function deleteOrphanedChildren(db: Db): Promise<void> {
  for (const t of ACCOUNT_TABLES) {
    if (t.scope.kind !== "child") continue;
    const parent = accountTable(t.scope.parent);
    const parentKey = columnBySqlName(parent.table, t.scope.parentKey ?? "id");
    const col = columnBySqlName(t.table, t.scope.column);
    await db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .delete(t.table as any)
      .where(sql`${col} not in (select ${parentKey} from ${parent.table})`);
  }
}

/** SQLite needs a LIMIT before an OFFSET; this is "no limit". */
const NO_LIMIT = 2_147_483_647;

/**
 * Every row of `table` in primary-key order (Ruling R2). With `userId`, only
 * that account's rows (via the registry's scope). `offset`/`limit` page over
 * the same total order, so a page boundary is deterministic.
 *
 * `after` is a KEYSET cursor: only rows whose primary key sorts after it
 * (single-column keys only). Unlike an offset it cannot skip a row when an
 * earlier one is deleted between pages (audit 1 data finding 4).
 */
export async function orderedRows(
  db: Db,
  table: SQLiteTable,
  opts: PageOpts = {},
): Promise<Record<string, unknown>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await pageQuery((db.select().from(table as any) as any).$dynamic(), table, opts)) as Record<string, unknown>[];
}

interface PageOpts {
  userId?: string;
  offset?: number;
  limit?: number;
  after?: string | number;
}

/** `orderedRows`' WHERE, ORDER BY and LIMIT/OFFSET on any select from `table`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageQuery(q: any, table: SQLiteTable, opts: PageOpts): any {
  const conditions: SQL[] = [];
  if (opts.userId !== undefined) conditions.push(scopeWhere(accountTable(getTableName(table)), opts.userId));
  if (opts.after !== undefined) {
    const pk = getTableConfig(table).columns.filter((c) => c.primary);
    if (pk.length !== 1) throw new Error(`account-tables: ${getTableName(table)} has no single primary key to page after`);
    conditions.push(gt(pk[0]!, opts.after));
  }
  if (conditions.length > 0) q = q.where(and(...conditions));
  q = q.orderBy(...orderColumns(table).map((c) => asc(c)));
  if (opts.limit !== undefined || opts.offset !== undefined) {
    q = q.limit(opts.limit ?? NO_LIMIT).offset(opts.offset ?? 0);
  }
  return q;
}

export interface BudgetedPage {
  /** The page, in `orderedRows` order. */
  rows: Record<string, unknown>[];
  /** Whether rows follow this page. */
  more: boolean;
  /** The page's measured bytes (its large columns plus a per-row allowance); null for a table with none. */
  bytes: number | null;
}

/**
 * The next page of `table` in `orderedRows` order: at most `limit` rows and — for a table with large columns —
 * at most `budget` bytes of them, measured in SQL before anything is read (Ruling 2a-R9). A page holds at least
 * one row, however large, unless `orEmpty` (a caller already holding rows of its own budget): then a first row
 * over the budget leaves the page empty, with `more` set. `more` says whether rows follow (as of the read).
 */
export async function budgetedRows(
  db: Db,
  table: SQLiteTable,
  opts: Omit<PageOpts, "limit"> & { limit: number; budget?: number; orEmpty?: boolean },
): Promise<BudgetedPage> {
  const limit = Math.max(1, Math.floor(opts.limit));
  const large = LARGE_COLUMNS[getTableName(table)] ?? [];
  if (large.length === 0) {
    const fetched = await orderedRows(db, table, { ...opts, limit: limit + 1 });
    return { rows: fetched.slice(0, limit), more: fetched.length > limit, bytes: null };
  }
  const budget = opts.budget ?? PAGE_BYTE_BUDGET;
  const size = sql.join(
    large.map((col) => sql`coalesce(length(cast(${columnBySqlName(table, col)} as blob)), 0)`),
    sql` + `,
  );
  const sizes = (await pageQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.select({ bytes: sql<number>`${size}` }).from(table as any) as any).$dynamic(),
    table,
    { ...opts, limit: limit + 1 },
  )) as Array<{ bytes: number }>;
  let take = 0;
  let bytes = 0;
  for (const s of sizes) {
    const rowBytes = Number(s.bytes) + ROW_OVERHEAD_BYTES;
    if (take >= limit || ((take > 0 || opts.orEmpty) && bytes + rowBytes > budget)) break;
    take += 1;
    bytes += rowBytes;
  }
  if (take === 0) return { rows: [], more: sizes.length > 0, bytes: 0 };
  const { budget: _budget, orEmpty: _orEmpty, ...page } = opts;
  const rows = await orderedRows(db, table, { ...page, limit: take });
  return { rows, more: sizes.length > take, bytes };
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` (and
 * non-finite numbers) as `null`, `-0` as `0`. Two equal row sets serialize to
 * the same string whatever order their keys were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null";
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      return value.toString();
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

async function sha256OfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha-256 (hex) of the canonical JSON of `rows`, in the order given — order
 * them with `orderedRows` first. */
export async function hashRows(rows: readonly unknown[]): Promise<string> {
  return sha256OfText(canonicalJson(rows));
}

/** Rows one `hashTable` read asks for at a time (fewer for a table with large columns: `budgetedRows`). */
export const HASH_PAGE_SIZE = 500;

/**
 * Canonical JSON text a table hash holds before it digests it. A table whose whole text fits hashes exactly as
 * `hashRows` would; a longer one is digested in pieces as it is read (below).
 */
export const HASH_CHUNK_CHARS = 256 * 1024;

/**
 * A table's digest, taken incrementally (Ruling 2a-R9). The text is the one `hashRows` digests — "[" + each row's
 * canonical JSON joined by "," + "]" — fed row by row:
 *  - while it is at most `HASH_CHUNK_CHARS` long it is held, and its digest is plain sha-256 of it — identical to
 *    `hashRows` over the same rows, so a small table's hash is what it always was;
 *  - once it is longer, it is cut into pieces at ROW boundaries (a piece closes after the row that takes it past
 *    `HASH_CHUNK_CHARS`), each piece is digested as it closes, and the table's digest is sha-256 of
 *    "chunks:" + the pieces' hex digests in order.
 * The pieces depend only on the rows, never on how they were paged in, so two databases holding the same rows
 * agree (the copier's verify, the parity harness); holding one piece at a time keeps a table of build payloads
 * out of memory.
 */
class TableDigest {
  private text = "[";
  private pieces: string[] = [];
  private count = 0;

  async add(rowJson: string): Promise<void> {
    this.text += this.count === 0 ? rowJson : `,${rowJson}`;
    this.count += 1;
    if (this.text.length > HASH_CHUNK_CHARS) {
      this.pieces.push(await sha256OfText(this.text));
      this.text = "";
    }
  }

  async finish(): Promise<{ rows: number; sha256: string }> {
    this.text += "]";
    if (this.pieces.length === 0) return { rows: this.count, sha256: await sha256OfText(this.text) };
    this.pieces.push(await sha256OfText(this.text));
    return { rows: this.count, sha256: await sha256OfText(`chunks:${this.pieces.join("")}`) };
  }
}

/**
 * The table's digest (`TableDigest`), read in keyset pages — byte-budgeted for a table with large columns — so
 * neither the rows nor their text ever sit in memory whole (the parity harness and the copier's verify hash
 * whole tables inside one Worker invocation). `mask` names SQL columns hashed as null — secrets, which a copy
 * never carries, and volatile stamps. A table with no single-column key (coach_locks) is read in one query.
 */
export async function hashTable(
  db: Db,
  table: SQLiteTable,
  opts: { userId?: string; mask?: readonly string[]; pageSize?: number } = {},
): Promise<{ rows: number; sha256: string }> {
  const maskKeys = (opts.mask ?? []).map((col) => columnKey(table, col));
  const digest = new TableDigest();
  const add = async (rows: Record<string, unknown>[]): Promise<void> => {
    for (const row of rows) {
      for (const key of maskKeys) row[key] = null;
      await digest.add(canonicalJson(row));
    }
  };
  const pk = getTableConfig(table).columns.filter((c) => c.primary);
  if (pk.length !== 1) {
    await add(await orderedRows(db, table, { userId: opts.userId }));
  } else {
    const size = Math.max(1, Math.floor(opts.pageSize ?? HASH_PAGE_SIZE));
    const key = columnKey(table, pk[0]!.name);
    let after: string | number | undefined;
    for (;;) {
      const page = await budgetedRows(db, table, { userId: opts.userId, after, limit: size });
      await add(page.rows);
      if (!page.more || page.rows.length === 0) break;
      after = page.rows[page.rows.length - 1]![key] as string | number;
    }
  }
  return digest.finish();
}
