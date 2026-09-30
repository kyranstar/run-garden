/**
 * The restore CHECK pass (audit 1 data finding 5, ruling B1).
 *
 * Before this, begin wiped the account and only then did the rows arrive: a
 * row missing `activities.duration_seconds` became a 500 after the wipe, and
 * "Try again" wiped again and failed on the same row; a `user_preferences` row
 * with `prefs: {timezone: 42}` was accepted and then every route that loads
 * preferences threw a ZodError. Now every page is checked first — with no side
 * effects — and a clean page earns the token begin and rows require.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, SCHEMA_VERSION } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { checkRestorePage, openCheckSession, restorableTables, RESTORE_MAX_ROWS } from "../src/services/account-restore.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedFullAccount } from "./account-fixture.js";
import { exportAll, TEST_SECRET } from "./restore-driver.js";

const ctx = (userId: string) => ({ userId, secret: TEST_SECRET });

/** Check one page the way the client does: open a check session whose
 * manifest holds exactly this page, then check it. A refusal of the session
 * itself (a newer schema) comes back in the same shape as a page's. */
async function checkOne(
  input: { schemaVersion: unknown; table: unknown; rows: unknown },
  userId: string,
): ReturnType<typeof checkRestorePage> {
  const manifest: Record<string, number> = Object.fromEntries(restorableTables().map((t) => [t.name, 0]));
  if (typeof input.table === "string" && input.table in manifest && Array.isArray(input.rows)) {
    manifest[input.table] = input.rows.length;
  }
  const opened = await openCheckSession({ schemaVersion: input.schemaVersion, manifest, sourceUserId: null }, ctx(userId));
  if (!opened.ok) return { ok: false, errors: opened.errors };
  return checkRestorePage({ session: opened.session, table: input.table, rows: input.rows }, ctx(userId));
}

function activityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "act-1",
    userId: "someone",
    startTime: "2026-09-01T14:00:00Z",
    sport: "run",
    durationSeconds: 1800,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...over,
  };
}

describe("restore check — a clean page", () => {
  it("earns a token, for every page of a real export", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const file = await exportAll(db, userId);
    for (const table of ["planned_workouts", "activities", "user_preferences", "garden_state", "activity_laps"]) {
      const res = await checkOne({ schemaVersion: file.schemaVersion, table, rows: file.tables[table] }, userId);
      expect(res, table).toMatchObject({ ok: true, rows: file.tables[table]!.length });
      if (res.ok) expect(res.token).toMatch(/^[\w-]+\.[\w-]+$/);
    }
  });

  it("accepts a file from an older schema whose rows lack a column added since with a default", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    // activities.source arrived in 0022 with DEFAULT 'coros'.
    const res = await checkOne({ schemaVersion: "0021", table: "activities", rows: [activityRow()] }, userId);
    expect(res.ok).toBe(true);
  });

  it("has no side effects at all", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const before = await exportAll(db, userId);
    await checkOne({ schemaVersion: SCHEMA_VERSION, table: "planned_workouts", rows: before.tables.planned_workouts }, userId);
    await checkOne({ schemaVersion: SCHEMA_VERSION, table: "activities", rows: [activityRow({ durationSeconds: null })] }, userId);
    const after = await exportAll(db, userId);
    expect(after.tables).toEqual(before.tables);
    expect(await db.select().from(schema.accountState)).toEqual([]);
  });
});

describe("restore check — what it refuses", () => {
  it("names the row and column of a missing required value, and of a null one", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { durationSeconds: _drop, ...noDuration } = activityRow();
    const res = await checkOne(
      { schemaVersion: SCHEMA_VERSION, table: "activities", rows: [activityRow({ id: "ok" }), noDuration, activityRow({ id: "n", sport: null })] },
      userId,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      expect.objectContaining({ row: 1, column: "duration_seconds", code: "missing_column", message: "activities row 2: duration_seconds is missing" }),
      expect.objectContaining({ row: 2, column: "sport", code: "missing_column" }),
    ]);
  });

  it("refuses a value of the wrong type for its column", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await checkOne(
      {
        schemaVersion: SCHEMA_VERSION,
        table: "activities",
        rows: [
          activityRow({ durationSeconds: "1800" }), // text in an integer column
          activityRow({ durationSeconds: 1800.5 }), // fraction in an integer column
          activityRow({ distanceMeters: "far" }), // text in a real column
          activityRow({ sport: 7 }), // number in a text column
        ],
      },
      userId,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.row, e.column, e.code])).toEqual([
      [0, "duration_seconds", "wrong_type"],
      [1, "duration_seconds", "wrong_type"],
      [2, "distance_meters", "wrong_type"],
      [3, "sport", "wrong_type"],
    ]);
    expect(res.errors[0]!.message).toBe("activities row 1: duration_seconds should be a whole number");
  });

  it("refuses a boolean column holding anything but true or false", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await checkOne(
      {
        schemaVersion: SCHEMA_VERSION,
        table: "garden_wildlife",
        rows: [{ id: "w", userId, kind: "bees", present: "yes", since: null }],
      },
      userId,
    );
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ column: "present", code: "wrong_type" })] });
  });

  it("refuses preferences that fail the preferences schema", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await checkOne(
      { schemaVersion: SCHEMA_VERSION, table: "user_preferences", rows: [{ userId, prefs: { timezone: 42 }, updatedAt: nowInstant() }] },
      userId,
    );
    expect(res).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ row: 0, column: "prefs", code: "bad_prefs", message: 'user_preferences row 1: preference "timezone" is not valid' })],
    });
  });

  it("refuses a garden snapshot the rebuild could not start from", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await checkOne(
      {
        schemaVersion: SCHEMA_VERSION,
        table: "garden_state",
        rows: [{ userId, snapshot: { plants: [] }, simulationVersion: 3, lastSimulatedDate: "2026-09-01", updatedAt: nowInstant() }],
      },
      userId,
    );
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "bad_garden" })] });
  });

  it("refuses a column this app does not have", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const res = await checkOne(
      { schemaVersion: "0020", table: "activities", rows: [activityRow({ retiredColumn: 1 })] },
      userId,
    );
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ column: "retiredColumn", code: "unknown_column" })] });
  });

  it("refuses unknown, identity, excluded and never-restored tables", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const code = async (table: unknown) => {
      const res = await checkOne({ schemaVersion: SCHEMA_VERSION, table, rows: [] }, userId);
      return res.ok ? "ok" : res.errors[0]!.code;
    };
    expect(await code("nope")).toBe("unknown_table");
    expect(await code(42)).toBe("unknown_table");
    for (const t of [
      "users",
      "sessions",
      "oauth_states",
      "garden_species",
      "coros_exercises",
      "schema_versions",
      "account_state",
      "provider_connections",
      "provider_cursor_state",
      "coach_locks",
    ]) {
      expect(await code(t), t).toBe("not_restorable");
    }
  });

  it("refuses a newer schema, an unreadable version, a non-list and an oversized page", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const first = async (input: { schemaVersion: unknown; table: unknown; rows: unknown }) => {
      const res = await checkOne(input, userId);
      return res.ok ? "ok" : res.errors[0]!.code;
    };
    const newer = String(Number(SCHEMA_VERSION) + 1).padStart(4, "0");
    expect(await first({ schemaVersion: newer, table: "activities", rows: [] })).toBe("newer_schema");
    expect(await first({ schemaVersion: "v22", table: "activities", rows: [] })).toBe("bad_schema_version");
    expect(await first({ schemaVersion: SCHEMA_VERSION, table: "activities", rows: "x" })).toBe("bad_rows");
    const many = Array.from({ length: RESTORE_MAX_ROWS + 1 }, (_, i) => activityRow({ id: `a${i}` }));
    expect(await first({ schemaVersion: SCHEMA_VERSION, table: "activities", rows: many })).toBe("too_many_rows");
    expect(await first({ schemaVersion: SCHEMA_VERSION, table: "activities", rows: ["x"] })).toBe("not_an_object");
  });

  it("stops at the first twenty errors", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const rows = Array.from({ length: 50 }, (_, i) => activityRow({ id: `a${i}`, durationSeconds: null }));
    const res = await checkOne({ schemaVersion: SCHEMA_VERSION, table: "activities", rows }, userId);
    expect(res.ok ? 0 : res.errors.length).toBe(20);
  });
});

// ── Route ───────────────────────────────────────────────────────────────────

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

async function post(db: Db, userId: string, path: string, body: unknown): Promise<Response> {
  const token = await createSession(db, userId, "test");
  const app = mountRoutes(db, "/api/settings", settingsRoutes);
  return app.request(
    path,
    { method: "POST", body: JSON.stringify(body), headers: { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" } },
    makeEnv(),
  );
}

describe("POST /api/settings/restore/check", () => {
  it("answers 200 with per-row errors or a token, and never touches the account", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const manifest = Object.fromEntries(restorableTables().map((t) => [t.name, t.name === "activities" ? 1 : 0]));
    const started = await post(db, userId, "/api/settings/restore/check/start", { schemaVersion: SCHEMA_VERSION, manifest });
    const { session } = (await started.json()) as { session: string };
    const bad = await post(db, userId, "/api/settings/restore/check", {
      session,
      table: "activities",
      rows: [activityRow({ durationSeconds: null })],
    });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ ok: false, errors: [{ row: 0, column: "duration_seconds", code: "missing_column" }] });

    const good = await post(db, userId, "/api/settings/restore/check", {
      session,
      table: "activities",
      rows: [activityRow()],
    });
    expect(await good.json()).toMatchObject({ ok: true, rows: 1 });
    expect(await db.select().from(schema.activities).where(eq(schema.activities.userId, userId))).toEqual([]);
    expect(await db.select().from(schema.accountState)).toEqual([]);
  });
});
