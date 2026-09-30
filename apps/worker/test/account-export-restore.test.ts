/**
 * Complete, paged export and a round-trip-tested restore (Phase 0 Task 9,
 * reworked for audit 1 data findings 1-8).
 *
 * The property that matters is pinned directly: export → wipe → restore →
 * export is identical, table by table, on an account with a row in every
 * table — under D1's 100-bound-variable cap, with enough planned workouts to
 * force both export paging and restore chunking. The three tables a restore
 * never writes (provider connections, provider cursors, coach locks) come
 * back empty: the athlete reconnects COROS and Google after a restore.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, getTableColumns } from "drizzle-orm";
import { schema, SCHEMA_VERSION } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { ACCOUNT_TABLES, hashRows, wipeAccountData } from "../src/services/account-tables.js";
import { EXPORT_FORMAT, exportManifest, exportTablePage } from "../src/services/account-export.js";
import {
  beginRestore,
  finishRestore,
  NEVER_RESTORED,
  restorableTables,
  restoreRows,
} from "../src/services/account-restore.js";
import { deleteAllUserData, settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedFullAccount, SEED_PLANNED_WORKOUTS } from "./account-fixture.js";
import { checkFile, exportAll, pagesOf, restoreAll, TEST_SECRET, type ExportFile } from "./restore-driver.js";

type Row = Record<string, unknown>;

const stripVolatile = (file: ExportFile) => {
  const { exportedAt: _drop, ...rest } = file;
  return rest;
};

const userAndChildTables = () =>
  ACCOUNT_TABLES.filter((t) => t.scope.kind === "user" || t.scope.kind === "child").map((t) => t.name);

const never = new Set<string>(NEVER_RESTORED);

afterEach(() => {
  vi.useRealTimers();
});

describe("export → wipe → restore → export", () => {
  it("export → wipe → restore → export is identical, table by table", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const before = await exportAll(db, userId);
    expect(before.tables.planned_workouts).toHaveLength(SEED_PLANNED_WORKOUTS);

    await wipeAccountData(db, userId, { keep: ["users", "sessions", "provider_connections"] });
    const wiped = await exportManifest(db, userId);
    expect(wiped.tables.find((t) => t.name === "planned_workouts")?.rows).toBe(0);

    const outcome = await restoreAll(db, userId, before);
    const after = await exportAll(db, userId);

    for (const name of Object.keys(before.tables)) {
      if (never.has(name)) expect(after.tables[name], name).toEqual([]);
      else expect(after.tables[name], name).toEqual(before.tables[name]);
    }
    const restorable = (f: ExportFile) => ({
      ...stripVolatile(f),
      tables: Object.fromEntries(Object.entries(f.tables).filter(([n]) => !never.has(n))),
    });
    expect(restorable(after)).toEqual(restorable(before));
    expect(outcome.counts.planned_workouts).toBe(SEED_PLANNED_WORKOUTS);
    expect(outcome.short).toEqual([]);
    expect(outcome.lost).toBe(0);
  });

  it("exports at least one row from every user and child table of a seeded account", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const manifest = await exportManifest(db, userId);
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    const listed = manifest.tables.map((t) => t.name);
    expect(listed).toEqual(["users", ...userAndChildTables()]);
    const empty = manifest.tables.filter((t) => t.rows === 0).map((t) => t.name);
    expect(empty).toEqual([]);
    for (const excluded of ["sessions", "oauth_states", "garden_species", "coros_exercises", "schema_versions", "account_state"]) {
      expect(listed).not.toContain(excluded);
    }
  });

  it("pages a table in primary-key order with a cursor that ends in null", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const first = await exportTablePage(db, userId, "planned_workouts", 0);
    expect(first.rows).toHaveLength(SEED_PLANNED_WORKOUTS); // ≤ 500 per page
    expect(first.nextCursor).toBeNull();

    const p1 = await exportTablePage(db, userId, "planned_workouts", 0, 100);
    expect(p1.nextCursor).toBe(100);
    const p3 = await exportTablePage(db, userId, "planned_workouts", 200, 100);
    expect(p3.rows).toHaveLength(50);
    expect(p3.nextCursor).toBeNull();
    const ids = first.rows.map((r) => String(r.id));
    expect(ids).toEqual([...ids].sort());
    await expect(exportTablePage(db, userId, "sessions", 0)).rejects.toThrow(/sessions/);
  });
});

describe("restore — refusals and idempotency", () => {
  it("refuses to begin without replace: a restore always replaces the whole account", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);
    const { tokens } = await checkFile(db, userId, file);

    for (const replace of [false, undefined, "yes"]) {
      const res = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace, tokens: [...tokens.values()] }, { secret: TEST_SECRET });
      expect(res).toEqual({ ok: false, status: 400, error: "replace_required" });
    }
    // Nothing was wiped.
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.find((t) => t.name === "planned_workouts")?.rows).toBe(SEED_PLANNED_WORKOUTS);
  });

  it("refuses a newer schemaVersion before touching anything", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const newer = String(Number(SCHEMA_VERSION) + 1).padStart(4, "0");
    const res = await beginRestore(db, userId, { schemaVersion: newer, replace: true, tokens: ["x"] }, { secret: TEST_SECRET });
    expect(res).toEqual({ ok: false, status: 422, error: "newer_schema" });
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.find((t) => t.name === "planned_workouts")?.rows).toBe(SEED_PLANNED_WORKOUTS);
  });

  it("a replace wipes every account table — provider connections and cursors included — but never the user or their session", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    await createSession(db, userId, "test");
    const file = await exportAll(db, userId);
    const { tokens } = await checkFile(db, userId, file);

    const res = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: true, tokens: [...tokens.values()] }, { secret: TEST_SECRET });
    expect(res.ok).toBe(true);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, userId))).toHaveLength(1);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toHaveLength(1);
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.filter((t) => t.name !== "users" && t.rows > 0)).toEqual([]);
    expect(await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, userId))).toEqual([]);
    expect(await db.select().from(schema.providerCursorState).where(eq(schema.providerCursorState.userId, userId))).toEqual([]);
  });

  it("a resent rows page is a no-op", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);
    const { tokens } = await checkFile(db, userId, file);
    const begun = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: true, tokens: [...tokens.values()] }, { secret: TEST_SECRET });
    if (!begun.ok) throw new Error(begun.error);

    const page = pagesOf(file.tables.planned_workouts!, 200)[0]!;
    const stagePage = pagesOf(file.tables.planned_workout_stages!, 200)[0]!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const a = await restoreRows(db, userId, { restoreId: begun.restoreId, table: "planned_workouts", rows: page, token: tokens.get("planned_workouts#0") }, { secret: TEST_SECRET });
      expect(a).toMatchObject({ ok: true, lost: 0 });
      const b = await restoreRows(db, userId, { restoreId: begun.restoreId, table: "planned_workout_stages", rows: stagePage, token: tokens.get("planned_workout_stages#0") }, { secret: TEST_SECRET });
      expect(b).toMatchObject({ ok: true, lost: 0 });
    }
    const done = await finishRestore(db, userId, { restoreId: begun.restoreId });
    if (!done.ok) throw new Error(done.error);
    expect(done.counts.planned_workouts).toBe(200);
    expect(done.counts.planned_workout_stages).toBe(stagePage.length);
    // The second planned_workouts page never arrived — finish says so.
    expect(done.short).toContainEqual({ table: "planned_workouts", expected: SEED_PLANNED_WORKOUTS, restored: 200 });
  });

  it("refuses rows for the identity table, excluded, never-restored and unknown tables", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);
    const { tokens } = await checkFile(db, userId, file);
    const begun = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: true, tokens: [...tokens.values()] }, { secret: TEST_SECRET });
    if (!begun.ok) throw new Error(begun.error);
    const restoreId = begun.restoreId;
    const row = { id: "x", userId, createdAt: nowInstant(), expiresAt: nowInstant() };
    const rows = (table: string, r: unknown) => restoreRows(db, userId, { restoreId, table, rows: r }, { secret: TEST_SECRET });
    expect(await rows("users", [row])).toEqual({ ok: false, status: 422, error: "not_restorable" });
    for (const table of ["sessions", "oauth_states", "garden_species", "coros_exercises", "schema_versions", "account_state", ...NEVER_RESTORED]) {
      expect(await rows(table, [row]), table).toMatchObject({ ok: false, error: "not_restorable" });
    }
    expect(await rows("nope", [])).toMatchObject({ ok: false, error: "unknown_table" });
    expect(await rows("activities", "x")).toMatchObject({ ok: false, error: "bad_rows" });
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });
});

describe("export and restore stay inside one account", () => {
  it("never exports another user's rows or any secret column", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, me);
    await seedFullAccount(db, other);

    const file = await exportAll(db, me);
    const text = JSON.stringify(file);
    expect(text).not.toContain(other);
    expect(text).not.toContain(other.slice(0, 8)); // the fixture's per-account tag
    for (const [name, rows] of Object.entries(file.tables)) {
      for (const row of rows) {
        if ("userId" in row) expect(row.userId, name).toBe(me);
      }
    }
    expect(file.tables.users).toEqual([expect.objectContaining({ id: me })]);
    const conns = file.tables.provider_connections!;
    expect(conns.length).toBeGreaterThan(0);
    for (const c of conns) {
      expect(c.encryptedAccessToken).toBeNull();
      expect(c.encryptedRefreshToken).toBeNull();
    }
    // The tokens are still there in the database — only the export nulls them.
    const stored = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, me));
    expect(stored.every((c) => c.encryptedAccessToken !== null)).toBe(true);
  });

  it("wiping one account leaves every row of another account untouched, children included", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, me);
    await seedFullAccount(db, other);
    const theirsBefore = await exportAll(db, other);

    await wipeAccountData(db, me, { keep: [] });

    const theirsAfter = await exportAll(db, other);
    expect(stripVolatile(theirsAfter)).toEqual(stripVolatile(theirsBefore));
    const mine = await exportManifest(db, me);
    expect(mine.tables.filter((t) => t.name !== "users" && t.rows > 0)).toEqual([]);
  });

  it("a restore leaves every row of another account untouched", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, me);
    await seedFullAccount(db, other);
    const theirsBefore = await exportAll(db, other);
    await restoreAll(db, me, await exportAll(db, me));
    expect(stripVolatile(await exportAll(db, other))).toEqual(stripVolatile(theirsBefore));
  });

  it("drops child rows whose parent is not this account's", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, other);
    const theirActivity = (await db.select().from(schema.activities).where(eq(schema.activities.userId, other)))[0]!;

    const lap = { id: newId(), activityId: theirActivity.id, lapIndex: 99, durationSeconds: 60 };
    const file: ExportFile = {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowInstant(),
      tables: { activity_laps: [lap] },
    };
    const outcome = await restoreAll(db, me, file);
    expect(outcome.short).toEqual([{ table: "activity_laps", expected: 1, restored: 0 }]);
    expect(
      await db
        .select()
        .from(schema.activityLaps)
        .where(and(eq(schema.activityLaps.activityId, theirActivity.id), eq(schema.activityLaps.lapIndex, 99))),
    ).toHaveLength(0);
  });

  it("restoring into a new account moves ownership and re-keys ids derived from the old account id", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: old } = await makeTestUser(db);
    await seedFullAccount(db, old);
    await db.insert(schema.dailyHealth).values({
      id: `${old}:2026-01-05`,
      userId: old,
      date: "2026-01-05",
      contentFingerprint: "fp",
      updatedAt: nowInstant(),
    });
    const file = await exportAll(db, old);
    await deleteAllUserData(db, old);

    const { userId: fresh } = await makeTestUser(db);
    await restoreAll(db, fresh, file);

    const health = await db.select().from(schema.dailyHealth).where(eq(schema.dailyHealth.date, "2026-01-05"));
    expect(health.map((h) => [h.id, h.userId])).toEqual([[`${fresh}:2026-01-05`, fresh]]);
    const after = await exportAll(db, fresh);
    expect(after.tables.planned_workouts).toHaveLength(SEED_PLANNED_WORKOUTS);
    expect(after.tables.activity_laps!.length).toBe(file.tables.activity_laps!.length);
    expect(JSON.stringify(after.tables)).not.toContain(`"userId":"${old}"`);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: TEST_SECRET,
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

async function call(db: Db, userId: string, path: string, body?: unknown): Promise<Response> {
  const token = await createSession(db, userId, "test");
  const app = mountRoutes(db, "/api/settings", settingsRoutes);
  const init: RequestInit = { headers: { Cookie: `${SESSION_COOKIE}=${token}` } };
  if (body !== undefined) {
    init.method = "POST";
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, "Content-Type": "application/json" };
  }
  return app.request(path, init, makeEnv());
}

describe("settings export/restore routes", () => {
  it("serves the manifest (also at the old /export path) and table pages", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    for (const path of ["/api/settings/export", "/api/settings/export/manifest"]) {
      const res = await call(db, userId, path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { format: string; schemaVersion: string; tables: { name: string }[] };
      expect(body.format).toBe(EXPORT_FORMAT);
      expect(body.schemaVersion).toBe(SCHEMA_VERSION);
      expect(body.tables.map((t) => t.name)).toContain("activity_laps");
    }

    const page = await call(db, userId, "/api/settings/export/table/planned_workouts?cursor=200&limit=100");
    expect(page.status).toBe(200);
    const body = (await page.json()) as { rows: Row[]; nextCursor: number | null };
    expect(body.rows).toHaveLength(50);
    expect(body.nextCursor).toBeNull();

    expect((await call(db, userId, "/api/settings/export/table/sessions")).status).toBe(404);
    expect((await call(db, userId, "/api/settings/export/table/nope")).status).toBe(404);
    expect((await call(db, userId, "/api/settings/export/table/activities?cursor=-1")).status).toBe(400);
  });

  it("names the tables to send and the ones to skip", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await call(db, userId, "/api/settings/restore/tables");
    expect(await res.json()).toEqual({
      schemaVersion: SCHEMA_VERSION,
      tables: restorableTables().map((t) => t.name),
      skip: ["users", ...NEVER_RESTORED],
    });
  });

  it("maps refusals to 400 / 409 / 422 and runs check → begin → rows → finish", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);

    const check = await call(db, userId, "/api/settings/restore/check", {
      schemaVersion: SCHEMA_VERSION,
      table: "activities",
      rows: file.tables.activities,
    });
    const { token } = (await check.json()) as { token: string };

    const noReplace = await call(db, userId, "/api/settings/restore/begin", { schemaVersion: SCHEMA_VERSION, tokens: [token] });
    expect(noReplace.status).toBe(400);
    expect(await noReplace.json()).toEqual({ error: "replace_required" });

    const unchecked = await call(db, userId, "/api/settings/restore/begin", { schemaVersion: SCHEMA_VERSION, replace: true, tokens: [] });
    expect(unchecked.status).toBe(422);
    expect(await unchecked.json()).toEqual({ error: "check_required" });

    const noBegin = await call(db, userId, "/api/settings/restore/rows", { restoreId: "nope", table: "activities", rows: file.tables.activities, token });
    expect(noBegin.status).toBe(409);
    expect(await noBegin.json()).toEqual({ error: "no_active_restore" });

    const begin = await call(db, userId, "/api/settings/restore/begin", {
      schemaVersion: SCHEMA_VERSION,
      replace: true,
      tokens: [token],
      exportedAt: file.exportedAt,
      exportedFrom: "https://app.test",
    });
    expect(begin.status).toBe(200);
    const { restoreId, tables } = (await begin.json()) as { restoreId: string; tables: string[] };
    expect(tables).toEqual(restorableTables().map((t) => t.name));

    const status = await call(db, userId, "/api/settings/restore/status");
    expect(await status.json()).toMatchObject({ restore: { fileExportedAt: file.exportedAt, fileExportedFrom: "https://app.test" } });

    const rows = await call(db, userId, "/api/settings/restore/rows", {
      restoreId,
      table: "activities",
      rows: file.tables.activities,
      token,
      sourceUserId: userId,
    });
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual({ received: file.tables.activities!.length, skipped: 0, lost: 0 });
    const finish = await call(db, userId, "/api/settings/restore/finish", { restoreId });
    expect(finish.status).toBe(200);
    const done = (await finish.json()) as { counts: Record<string, number>; short: unknown[] };
    expect(done.counts.activities).toBe(file.tables.activities!.length);
    expect(done.counts.planned_workouts).toBe(0);
    expect(done.short).toEqual([]);

    const cleared = await call(db, userId, "/api/settings/restore/status");
    expect(await cleared.json()).toEqual({ restore: null });
    const again = await call(db, userId, "/api/settings/restore/finish", { restoreId });
    expect(again.status).toBe(409);
  });
});

// Keep the column-count helper honest: a restore chunk must fit the cap for
// the widest table the registry holds.
describe("restore chunking", () => {
  it("fits the widest restorable table under the 100-variable cap", async () => {
    const widest = Math.max(
      ...ACCOUNT_TABLES.filter((t) => t.scope.kind === "user" || t.scope.kind === "child").map(
        (t) => Object.keys(getTableColumns(t.table)).length,
      ),
    );
    expect(widest).toBeLessThanOrEqual(100);
    expect(await hashRows([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
