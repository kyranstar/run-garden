/**
 * NATIVE DEVICE SIGN-IN, ITS TWO TABLES (SLICE-CONTRACT revision 2 §10.6): `native_devices` (one row per paired phone,
 * keyed by the SHA-256 of its token) and `native_pairings` (the account's one pairing code, as an HMAC).
 *
 * What is pinned: migration 0038 adds exactly these two tables and their indexes and touches nothing else; the registry
 * holds both as `excluded` (so export, restore and the staging copier never carry them, as `sessions`); delete-all
 * removes both by name, this account's rows only; and the half-hourly cron purges expired rows beside the expired
 * sessions. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { accountTable } from "../src/services/account-tables.js";
import { deleteAllUserData } from "../src/routes/misc.js";
import { exportManifest } from "../src/services/account-export.js";
import { restoreRows, beginRestore } from "../src/services/account-restore.js";
import { halfHourly } from "../src/index.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { checkFile, exportAll, restoreAll, TEST_SECRET } from "./restore-driver.js";
import { seedFullAccount } from "./account-fixture.js";

const { nativeDevices, nativePairings } = schema;

const MIGRATION = join(__dirname, "../../../packages/database/migrations/0038_native_devices.sql");
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

afterEach(() => vi.useRealTimers());

/** A device row, `active` and live unless `over` says otherwise. */
async function seedDevice(db: Db, userId: string, id: string, over: Partial<typeof nativeDevices.$inferInsert> = {}) {
  await db.insert(nativeDevices).values({
    id,
    userId,
    scope: "training-slice-v1",
    label: "Synthetic phone",
    state: "active",
    checkNumber: "0420",
    createdAt: nowInstant(),
    expiresAt: at(30 * 24 * HOUR),
    ...over,
  });
}

async function seedPairing(db: Db, userId: string, over: Partial<typeof nativePairings.$inferInsert> = {}) {
  await db.insert(nativePairings).values({
    userId,
    codeHmac: "a".repeat(64),
    createdAt: nowInstant(),
    expiresAt: at(5 * 60_000),
    ...over,
  });
}

const raw = (db: Db) => (db as unknown as { $client: { prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>> } } }).$client;

describe("migration 0038", () => {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);

  it("only creates its two tables and their indexes: nothing existing is altered, dropped or rewritten", () => {
    for (const s of statements) {
      expect(s, s.slice(0, 60)).toMatch(/^(CREATE TABLE `native_(devices|pairings)`|CREATE (UNIQUE )?INDEX `\w+` ON `native_(devices|pairings)`)/);
      expect(s).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|INSERT|ALTER)\b/i);
    }
    expect(statements.filter((s) => s.startsWith("CREATE TABLE"))).toHaveLength(2);
  });

  it("gives native_devices the columns of §10.6, and native_pairings one row per account", () => {
    const db = makeTestDb();
    const cols = (t: string) => raw(db).prepare(`pragma table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.pk]);
    expect(cols("native_devices")).toEqual([
      ["id", "TEXT", 1, 1],
      ["user_id", "TEXT", 1, 0],
      ["scope", "TEXT", 1, 0],
      ["label", "TEXT", 1, 0],
      ["state", "TEXT", 1, 0],
      ["check_number", "TEXT", 1, 0],
      ["created_at", "TEXT", 1, 0],
      ["expires_at", "TEXT", 1, 0],
      ["confirmed_at", "TEXT", 0, 0],
      ["last_used_at", "TEXT", 0, 0],
      ["revoked_at", "TEXT", 0, 0],
      ["revoked_reason", "TEXT", 0, 0],
    ]);
    expect(cols("native_pairings")).toEqual([
      ["user_id", "TEXT", 1, 1],
      ["code_hmac", "TEXT", 1, 0],
      ["created_at", "TEXT", 1, 0],
      ["expires_at", "TEXT", 1, 0],
      ["tries", "INTEGER", 1, 0],
      ["used_at", "TEXT", 0, 0],
    ]);
    const indexes = raw(db).prepare(`select name, tbl_name from sqlite_master where type = 'index' and tbl_name like 'native_%' and name not like 'sqlite_%' order by name`).all();
    expect(indexes).toEqual([{ name: "native_devices_user_idx", tbl_name: "native_devices" }]);
  });
});

describe("the registry, delete-all and the purge", () => {
  it("holds both tables as excluded, with a reason, as it holds sessions", () => {
    for (const name of ["native_devices", "native_pairings"]) {
      const entry = accountTable(name);
      expect(entry.scope.kind, name).toBe("excluded");
      if (entry.scope.kind === "excluded") expect(entry.scope.reason).toMatch(/auth/);
    }
  });

  it("delete-all removes this account's devices and pairing code, and nobody else's", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedDevice(db, me, "d-me-1");
    await seedDevice(db, me, "d-me-2", { state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" });
    await seedPairing(db, me);
    await seedDevice(db, other, "d-other");
    await seedPairing(db, other);

    await deleteAllUserData(db, me);

    expect(await db.select().from(nativeDevices).where(eq(nativeDevices.userId, me))).toEqual([]);
    expect(await db.select().from(nativePairings).where(eq(nativePairings.userId, me))).toEqual([]);
    expect((await db.select().from(nativeDevices)).map((d) => d.id)).toEqual(["d-other"]);
    expect((await db.select().from(nativePairings)).map((p) => p.userId)).toEqual([other]);
  });

  it("the half-hourly cron purges expired devices (any state) and expired codes, and keeps the live ones", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedDevice(db, userId, "d-live");
    await seedDevice(db, userId, "d-expired", { expiresAt: at(-HOUR) });
    await seedDevice(db, userId, "d-pending-expired", { state: "pending", expiresAt: at(-60_000) });
    await seedDevice(db, userId, "d-revoked-expired", { state: "revoked", revokedAt: at(-2 * HOUR), revokedReason: "owner", expiresAt: at(-HOUR) });
    await seedDevice(db, userId, "d-revoked-live", { state: "revoked", revokedAt: at(-HOUR), revokedReason: "owner" });
    await seedPairing(db, userId, { expiresAt: at(-60_000) });
    await seedPairing(db, other);

    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    try {
      await halfHourly(db, { APP_URL: "https://app.test", ALLOWED_GOOGLE_EMAIL: "runner@example.com" } as Env);
    } finally {
      vi.unstubAllGlobals();
    }

    expect((await db.select().from(nativeDevices)).map((d) => d.id).sort()).toEqual(["d-live", "d-revoked-live"]);
    expect((await db.select().from(nativePairings)).map((p) => p.userId)).toEqual([other]);
  });
});

describe("export and restore leave them out", () => {
  it("the export lists neither table, and a seeded account's export carries no device row", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    await seedDevice(db, userId, "d-export");
    await seedPairing(db, userId);
    const listed = (await exportManifest(db, userId)).tables.map((t) => t.name);
    expect(listed).not.toContain("native_devices");
    expect(listed).not.toContain("native_pairings");
    const file = await exportAll(db, userId);
    expect(JSON.stringify(file)).not.toContain("d-export");
  });

  it("a restore refuses either table's rows, and leaves the account's devices as they were", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    await seedDevice(db, userId, "d-kept");
    await seedPairing(db, userId);
    const before = { devices: await db.select().from(nativeDevices), pairings: await db.select().from(nativePairings) };
    const file = await exportAll(db, userId);

    const { session, tokens } = await checkFile(db, userId, file);
    const begun = await beginRestore(db, userId, { session, replace: true, tokens: [...tokens.values()] }, { secret: TEST_SECRET });
    if (!begun.ok) throw new Error(begun.error);
    const row = { id: "d-smuggled", userId, scope: "training-slice-v1", label: "x", state: "active", checkNumber: "0000", createdAt: nowInstant(), expiresAt: at(HOUR) };
    for (const table of ["native_devices", "native_pairings"]) {
      expect(await restoreRows(db, userId, { restoreId: begun.restoreId, table, rows: [row] }, { secret: TEST_SECRET }), table).toMatchObject({ ok: false, error: "not_restorable" });
    }

    // A whole restore of the account's own file: the devices and the code are not account data, so it never touches them.
    const fresh = makeTestDb({ boundVariableCap: 100 });
    const { userId: target } = await makeTestUser(fresh);
    await seedDevice(fresh, target, "d-target");
    await restoreAll(fresh, target, file);
    expect((await fresh.select().from(nativeDevices)).map((d) => d.id)).toEqual(["d-target"]);
    expect(await fresh.select().from(nativePairings)).toEqual([]);
    expect({ devices: await db.select().from(nativeDevices), pairings: await db.select().from(nativePairings) }).toEqual(before);
  });
});
