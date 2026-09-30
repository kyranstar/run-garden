/**
 * Complete, paged export and a round-trip-tested restore (Phase 0 Task 9).
 *
 * The export used to cover 11 of ~50 tables and there was no restore at all.
 * Both are now driven by the one table registry (account-tables.ts), and the
 * property that matters is pinned directly: export → wipe → restore → export
 * is identical, table by table, on an account with a row in every table —
 * under D1's 100-bound-variable cap, with enough planned workouts to force
 * both export paging and restore chunking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, getTableColumns } from "drizzle-orm";
import { schema, SCHEMA_VERSION } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { ACCOUNT_TABLES, hashRows, wipeAccountData } from "../src/services/account-tables.js";
import { EXPORT_FORMAT, exportManifest, exportTablePage } from "../src/services/account-export.js";
import { beginRestore, finishRestore, restoreRows } from "../src/services/account-restore.js";
import { deleteAllUserData, settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { ensureGarden } from "../src/services/garden-sync.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedFullAccount, SEED_PLANNED_WORKOUTS } from "./account-fixture.js";

type Row = Record<string, unknown>;
interface ExportFile {
  format: string;
  schemaVersion: string;
  exportedAt: string;
  tables: Record<string, Row[]>;
}

/** What the client does: the manifest, then every table page by page. A
 * small page size forces the 250 planned workouts across several pages. */
async function exportAll(db: Db, userId: string, pageSize = 100): Promise<ExportFile> {
  const manifest = await exportManifest(db, userId);
  const tables: Record<string, Row[]> = {};
  for (const { name } of manifest.tables) {
    const rows: Row[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await exportTablePage(db, userId, name, cursor, pageSize);
      rows.push(...page.rows);
      cursor = page.nextCursor;
    }
    tables[name] = rows;
  }
  return { format: manifest.format, schemaVersion: manifest.schemaVersion, exportedAt: nowInstant(), tables };
}

/** What the client does on restore: begin(replace) → rows per table in the
 * server's order, 200 at a time → finish. */
async function restoreAll(db: Db, userId: string, file: ExportFile): Promise<Record<string, number>> {
  const begun = await beginRestore(db, userId, { schemaVersion: file.schemaVersion, replace: true });
  if (!begun.ok) throw new Error(`begin refused: ${begun.error}`);
  const sourceUserId = String(file.tables.users?.[0]?.id ?? "");
  for (const table of begun.tables) {
    const rows = file.tables[table] ?? [];
    for (let i = 0; i < rows.length; i += 200) {
      const res = await restoreRows(db, userId, { table, rows: rows.slice(i, i + 200), sourceUserId });
      if (!res.ok) throw new Error(`rows refused for ${table}: ${res.error}`);
    }
  }
  return (await finishRestore(db, userId)).counts;
}

const stripVolatile = (file: ExportFile) => {
  const { exportedAt: _drop, ...rest } = file;
  return rest;
};

const userAndChildTables = () =>
  ACCOUNT_TABLES.filter((t) => t.scope.kind === "user" || t.scope.kind === "child").map((t) => t.name);

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

    const counts = await restoreAll(db, userId, before);
    const after = await exportAll(db, userId);

    for (const name of Object.keys(before.tables)) {
      expect(after.tables[name], name).toEqual(before.tables[name]);
    }
    expect(stripVolatile(after)).toEqual(stripVolatile(before));
    expect(counts.planned_workouts).toBe(SEED_PLANNED_WORKOUTS);
  });

  it("exports at least one row from every user and child table of a seeded account", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const manifest = await exportManifest(db, userId);
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    const listed = manifest.tables.map((t) => t.name);
    expect(listed).toEqual([
      "users",
      ...userAndChildTables(),
    ]);
    const empty = manifest.tables.filter((t) => t.rows === 0).map((t) => t.name);
    expect(empty).toEqual([]);
    for (const excluded of ["sessions", "oauth_states", "garden_species", "coros_exercises", "schema_versions"]) {
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
  it("refuses to restore over a non-empty account without replace", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const res = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: false });
    expect(res).toEqual({ ok: false, status: 409, error: "not_empty" });
    // Nothing was wiped.
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.find((t) => t.name === "planned_workouts")?.rows).toBe(SEED_PLANNED_WORKOUTS);
  });

  it("accepts an account with nothing in it yet without replace", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const res = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: false });
    expect(res.ok).toBe(true);
    // A fresh account's defaults (its preferences row) are cleared so the
    // file's rows land instead of losing to them on conflict.
    expect(await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId))).toHaveLength(0);
  });

  it("refuses a different schemaVersion", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const res = await beginRestore(db, userId, { schemaVersion: "0001", replace: true });
    expect(res).toEqual({ ok: false, status: 422, error: "schema_mismatch" });
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.find((t) => t.name === "planned_workouts")?.rows).toBe(SEED_PLANNED_WORKOUTS);
  });

  it("a replace never deletes the signed-in user, their session or their provider connections", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    await createSession(db, userId, "test");

    const res = await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: true });
    expect(res.ok).toBe(true);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, userId))).toHaveLength(1);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toHaveLength(1);
    expect(
      await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, userId)),
    ).toHaveLength(2);
    expect(await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, userId))).toHaveLength(0);
  });

  it("a resent rows page is a no-op", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);
    await beginRestore(db, userId, { schemaVersion: SCHEMA_VERSION, replace: true });

    const page = file.tables.planned_workouts!.slice(0, 120);
    const stagePage = file.tables.planned_workout_stages!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await restoreRows(db, userId, { table: "planned_workouts", rows: page })).ok).toBe(true);
      expect((await restoreRows(db, userId, { table: "planned_workout_stages", rows: stagePage })).ok).toBe(true);
    }
    const { counts } = await finishRestore(db, userId);
    expect(counts.planned_workouts).toBe(120);
    expect(counts.planned_workout_stages).toBe(stagePage.length);
  });

  it("refuses rows for the identity table, excluded tables and unknown tables", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const row = { id: "x", userId, createdAt: nowInstant(), expiresAt: nowInstant() };
    expect(await restoreRows(db, userId, { table: "users", rows: [row] })).toEqual({
      ok: false,
      status: 422,
      error: "not_restorable",
    });
    for (const table of ["sessions", "oauth_states", "garden_species", "coros_exercises", "schema_versions"]) {
      expect(await restoreRows(db, userId, { table, rows: [row] })).toMatchObject({ ok: false, error: "not_restorable" });
    }
    expect(await restoreRows(db, userId, { table: "nope", rows: [] })).toMatchObject({ ok: false, error: "unknown_table" });
    expect(await restoreRows(db, userId, { table: "activities", rows: "x" })).toMatchObject({ ok: false, error: "bad_rows" });
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

  it("drops child rows whose parent is not this account's", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, other);
    const theirActivity = (
      await db.select().from(schema.activities).where(eq(schema.activities.userId, other))
    )[0]!;

    const res = await restoreRows(db, me, {
      table: "activity_laps",
      rows: [{ id: newId(), activityId: theirActivity.id, lapIndex: 99, durationSeconds: 60 }],
    });
    expect(res).toEqual({ ok: true, received: 1, skipped: 1 });
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

  it("restores a provider connection's metadata without tokens, and only when the account has none for it", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const existingId = newId();
    await db.insert(schema.providerConnections).values({
      id: existingId,
      userId,
      provider: "coros",
      status: "connected",
      encryptedRefreshToken: "live-secret",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const base = {
      userId: "someone-else",
      status: "connected",
      encryptedAccessToken: "leaked-access",
      encryptedRefreshToken: "leaked-refresh",
      accessTokenExpiresAt: null,
      scope: "calendar",
      externalAccountId: "acct-1",
      meta: { region: "us" },
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
      lastSyncAt: null,
      lastErrorCategory: null,
    };
    const res = await restoreRows(db, userId, {
      table: "provider_connections",
      rows: [
        { ...base, id: newId(), provider: "coros" },
        { ...base, id: newId(), provider: "google_calendar" },
      ],
    });
    expect(res).toEqual({ ok: true, received: 2, skipped: 1 });

    const rows = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    const coros = rows.find((r) => r.provider === "coros")!;
    expect(coros.id).toBe(existingId);
    expect(coros.encryptedRefreshToken).toBe("live-secret");
    const google = rows.find((r) => r.provider === "google_calendar")!;
    expect(google.encryptedAccessToken).toBeNull();
    expect(google.encryptedRefreshToken).toBeNull();
    expect(google.status).toBe("disconnected");
    expect(google.meta).toEqual({ region: "us" });
    expect(google.externalAccountId).toBe("acct-1");
  });
});

describe("restore finish", () => {
  it("catches a restored garden that stopped before yesterday up to yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T18:00:00Z"));
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const prefs = await loadPreferences(db, userId);
    const today = todayInZone(prefs.timezone);
    await ensureGarden(db, userId, prefs, addDays(today, -6));

    const { counts } = await finishRestore(db, userId);

    const [garden] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
    expect(garden!.lastSimulatedDate).toBe(addDays(today, -1));
    expect(counts.garden_state).toBe(1);
    expect(counts.garden_day_inputs).toBeGreaterThan(0);
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
    SESSION_SECRET: "test-session-secret",
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

  it("maps restore refusals to 409 / 422 and runs begin → rows → finish", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);

    const notEmpty = await call(db, userId, "/api/settings/restore/begin", { schemaVersion: SCHEMA_VERSION, replace: false });
    expect(notEmpty.status).toBe(409);
    expect(await notEmpty.json()).toEqual({ error: "not_empty" });

    const mismatch = await call(db, userId, "/api/settings/restore/begin", { schemaVersion: "0001", replace: true });
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toEqual({ error: "schema_mismatch" });

    const identity = await call(db, userId, "/api/settings/restore/rows", { table: "users", rows: file.tables.users });
    expect(identity.status).toBe(422);

    const begin = await call(db, userId, "/api/settings/restore/begin", { schemaVersion: SCHEMA_VERSION, replace: true });
    expect(begin.status).toBe(200);
    const { tables } = (await begin.json()) as { tables: string[] };
    expect(tables).toEqual(userAndChildTables());

    const rows = await call(db, userId, "/api/settings/restore/rows", {
      table: "activities",
      rows: file.tables.activities,
      sourceUserId: userId,
    });
    expect(rows.status).toBe(200);
    const finish = await call(db, userId, "/api/settings/restore/finish", {});
    expect(finish.status).toBe(200);
    const { counts } = (await finish.json()) as { counts: Record<string, number> };
    expect(counts.activities).toBe(file.tables.activities!.length);
    expect(counts.planned_workouts).toBe(0);
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
