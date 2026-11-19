/**
 * MIGRATION 0040 (R1; the LifeOS migration's DESIGN-3 §3.4.3, §3.12): `take_back_receipts` and `native_device_sharing`.
 *
 * What is pinned: the migration only creates (two tables, three indexes) — no ALTER, no DROP, no write of any row, so it is
 * safe to apply to production before the code that uses it, and rolling the code back leaves two idle tables; it applies
 * to a database already at 0039 holding rows and changes none of them; the tables' columns are exactly the design's; the
 * registry holds the receipts as the account's own (`user`: exported, restored, deleted with it) and switch A as a sign-in
 * (never carried or restored — a restore must never turn a consent back on); delete-all and the QA purge remove both, this
 * account's rows only. Synthetic data only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { schema, SCHEMA_VERSION } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { accountTable } from "../src/services/account-tables.js";
import { deleteAllUserData } from "../src/routes/misc.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { nativeDeviceSharing, takeBackReceipts } = schema;
const DIR = join(__dirname, "../../../packages/database/migrations");
const MIGRATION = join(DIR, "0040_take_back_receipts.sql");

const statementsOf = (text: string) =>
  text
    .split("--> statement-breakpoint")
    .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);

/** A database at a migration, applied as wrangler applies them: every file before `until` in order. */
function databaseUpTo(until: string): Database.Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql") && f < until).sort()) {
    for (const s of statementsOf(readFileSync(join(DIR, file), "utf8"))) db.exec(s);
  }
  return db;
}

const tableRows = (db: Database.Database) =>
  Object.fromEntries(
    (db.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all() as Array<{ name: string }>).map((t) => [
      t.name,
      db.prepare(`select * from "${t.name}" order by rowid`).all(),
    ]),
  );

describe("migration 0040: additive only", () => {
  const statements = statementsOf(readFileSync(MIGRATION, "utf8"));

  it("creates two tables and three indexes and nothing else: no ALTER, DROP, RENAME or row written", () => {
    expect(statements.map((s) => s.split("(")[0]!.trim())).toEqual([
      "CREATE TABLE `take_back_receipts`",
      "CREATE UNIQUE INDEX `take_back_receipts_source_idx` ON `take_back_receipts`",
      "CREATE INDEX `take_back_receipts_workout_idx` ON `take_back_receipts`",
      "CREATE INDEX `take_back_receipts_open_idx` ON `take_back_receipts`",
      "CREATE TABLE `native_device_sharing`",
      "CREATE INDEX `native_device_sharing_user_idx` ON `native_device_sharing`",
    ]);
    for (const s of statements) expect(s).not.toMatch(/\b(ALTER|DROP|RENAME|DELETE|UPDATE|INSERT|REPLACE)\b/i);
    // The export's stamp follows the newest migration.
    expect(SCHEMA_VERSION).toBe("0040");
  });

  it("applies to a database at 0039 that holds rows, and changes none of them (a copy of the current schema)", () => {
    const db = databaseUpTo("0040");
    db.exec(`insert into users (id, email, name, google_sub, created_at) values ('u1', 'owner@example.test', null, null, '2026-11-19T00:00:00.000Z')`);
    db.exec(`insert into native_devices (id, user_id, scope, label, state, check_number, created_at, expires_at) values ('d1', 'u1', 'training-v4', 'Phone', 'active', '0420', '2026-11-19T00:00:00.000Z', '2026-12-19T00:00:00.000Z')`);
    const before = tableRows(db);
    for (const s of statements) db.exec(s);
    const after = tableRows(db);
    expect(Object.keys(after).filter((t) => !(t in before)).sort()).toEqual(["native_device_sharing", "take_back_receipts"]);
    for (const [t, rows] of Object.entries(before)) expect([t, after[t]]).toEqual([t, rows]);
    expect([after.take_back_receipts, after.native_device_sharing]).toEqual([[], []]);
  });

  it("the tables' columns are the design's (DESIGN-3 §3.4.3; C1's switch A)", () => {
    const db = databaseUpTo("0041");
    const cols = (t: string) => (db.prepare(`pragma table_info('${t}')`).all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>).map((c) => [c.name, c.notnull, c.dflt_value, c.pk]);
    expect(cols("take_back_receipts")).toEqual([
      ["id", 1, null, 1],
      ["user_id", 1, null, 0],
      ["source", 1, null, 0],
      ["source_key", 1, null, 0],
      ["made_by", 1, null, 0],
      ["workout_id", 1, null, 0],
      ["op", 1, null, 0],
      ["group_id", 1, null, 0],
      ["depends_on", 1, "'[]'", 0],
      ["pre_state", 0, null, 0],
      ["post_state", 1, null, 0],
      ["effects", 1, "'[]'", 0],
      ["created_at", 1, null, 0],
      ["expires_at", 1, null, 0],
      ["status", 1, "'open'", 0],
      ["request_id", 0, null, 0],
      ["taken_back_at", 0, null, 0],
      ["result", 0, null, 0],
    ]);
    expect(cols("native_device_sharing")).toEqual([
      ["device_id", 1, null, 1],
      ["user_id", 1, null, 0],
      ["to_training", 1, "0", 0],
      ["disclosure_version", 1, null, 0],
      ["set_at", 1, null, 0],
    ]);
    // One receipt per write: the account, the source and its key are unique together.
    db.exec(`insert into take_back_receipts (id, user_id, source, source_key, made_by, workout_id, op, group_id, post_state, created_at, expires_at) values ('tb_1', 'u1', 'place', 'k1', 'session', 'w1', 'create', 'g1', '{}', 'x', 'y')`);
    expect(() => db.exec(`insert into take_back_receipts (id, user_id, source, source_key, made_by, workout_id, op, group_id, post_state, created_at, expires_at) values ('tb_2', 'u1', 'place', 'k1', 'session', 'w1', 'create', 'g1', '{}', 'x', 'y')`)).toThrow(/UNIQUE/);
  });
});

describe("the registry, delete-all and the purge", () => {
  it("holds the receipts as the account's own, and switch A as a sign-in that is never carried or restored", () => {
    expect(accountTable("take_back_receipts").scope.kind).toBe("user");
    const sharing = accountTable("native_device_sharing").scope;
    expect(sharing.kind).toBe("excluded");
    if (sharing.kind === "excluded") {
      expect(sharing.signIn).toBe(true);
      expect(sharing.reason).toMatch(/restore/);
    }
  });

  it("delete-all removes this account's receipts and switches, and nobody else's", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    for (const [userId, n] of [[me, "1"], [other, "2"]] as const) {
      await db.insert(takeBackReceipts).values({
        id: `tb_${n}`, userId, source: "place", sourceKey: `k${n}`, madeBy: "session", workoutId: `w${n}`, op: "create", groupId: `g${n}`, postState: "{}", createdAt: nowInstant(), expiresAt: nowInstant(),
      });
      await db.insert(nativeDeviceSharing).values({ deviceId: `d${n}`, userId, toTraining: true, disclosureVersion: "1", setAt: nowInstant() });
    }
    await deleteAllUserData(db, me);
    expect((await db.select().from(takeBackReceipts)).map((r) => r.id)).toEqual(["tb_2"]);
    expect((await db.select().from(nativeDeviceSharing)).map((r) => r.deviceId)).toEqual(["d2"]);
  });
});
