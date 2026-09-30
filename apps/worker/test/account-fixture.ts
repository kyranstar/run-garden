/**
 * `seedFullAccount` — at least one row in EVERY user and child table the
 * registry knows, built generically from the table's own columns, so a new
 * table is covered by the export/restore round trip the day it is added
 * rather than the day someone remembers to extend a fixture.
 *
 * Every column is filled, nullable ones included — a column that only ever
 * round-trips as NULL proves nothing about its type. Values are synthetic and
 * tagged with the account (`<key>-<tag>-<i>`), so two seeded accounts never
 * collide on a unique index (activity_source_links' is global, not per user).
 */
import { getTableColumns } from "drizzle-orm";
import { addDays, todayInZone } from "@rg/domain";
import {
  ACCOUNT_TABLES,
  columnKey,
  orderColumns,
  orderedRows,
  type AccountTable,
} from "../src/services/account-tables.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import type { Db } from "../src/services/db.js";

/** Enough planned workouts to span several export pages' worth of restore
 * chunks (floor(100 / 35 columns) = 2 rows per insert statement). */
export const SEED_PLANNED_WORKOUTS = 250;

type Row = Record<string, unknown>;

function fillRow(entry: AccountTable, i: number, userId: string, tag: string, parents: string[]): Row {
  const row: Row = {};
  const scope = entry.scope;
  for (const [key, col] of Object.entries(getTableColumns(entry.table))) {
    if (col.name === "user_id") row[key] = userId;
    else if (scope.kind === "child" && col.name === scope.column) row[key] = parents[i % parents.length];
    else if (col.primary) row[key] = `${entry.name}-${tag}-${i}`;
    else if (col.dataType === "boolean") row[key] = i % 2 === 0;
    else if (col.dataType === "number") row[key] = col.columnType === "SQLiteReal" ? i + 0.5 : i + 1;
    else if (col.dataType === "json") row[key] = { key, tag, i, nested: { list: [i, `${key}-${i}`] } };
    else row[key] = `${key}-${tag}-${i}`;
  }
  return row;
}

/** One row per account where the primary key IS user_id (preferences,
 * garden_state, …); otherwise two, and SEED_PLANNED_WORKOUTS workouts. */
function rowCount(entry: AccountTable): number {
  if (entry.name === "planned_workouts") return SEED_PLANNED_WORKOUTS;
  const pk = orderColumns(entry.table);
  return pk.length === 1 && pk[0]!.name === "user_id" ? 1 : 2;
}

export async function seedFullAccount(db: Db, userId: string): Promise<void> {
  const tag = userId.slice(0, 8);
  const prefs = await loadPreferences(db, userId);
  const yesterday = addDays(todayInZone(prefs.timezone), -1);
  /** Parent table → this account's ids in it, for the children to point at. */
  const ids = new Map<string, string[]>();

  for (const entry of ACCOUNT_TABLES) {
    if (entry.scope.kind !== "user" && entry.scope.kind !== "child") continue;
    const existing = await orderedRows(db, entry.table, { userId });
    if (existing.length > 0) {
      if ("id" in existing[0]!) ids.set(entry.name, existing.map((r) => String(r.id)));
      continue;
    }
    const parents = entry.scope.kind === "child" ? (ids.get(entry.scope.parent) ?? []) : [];
    if (entry.scope.kind === "child" && parents.length === 0) {
      throw new Error(`seedFullAccount: ${entry.name} needs ${entry.scope.parent} rows first`);
    }
    const rows = Array.from({ length: rowCount(entry) }, (_, i) => fillRow(entry, i, userId, tag, parents));
    if (entry.name === "garden_state") {
      // A garden already simulated through yesterday — current, exactly as a
      // same-day export restores it — so restore's catch-up has nothing to do.
      rows[0]![columnKey(entry.table, "last_simulated_date")] = yesterday;
    }
    const perInsert = Math.max(1, Math.floor(100 / Object.keys(getTableColumns(entry.table)).length));
    for (let i = 0; i < rows.length; i += perInsert) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.insert(entry.table as any).values(rows.slice(i, i + perInsert) as any);
    }
    if ("id" in rows[0]!) ids.set(entry.name, rows.map((r) => String(r.id)));
  }
}
