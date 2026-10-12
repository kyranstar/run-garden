/**
 * A COROS READ WHOSE IMPORT CANNOT WRITE (Stage 1 Task 11, fix round 3).
 *
 * One bad row — a key it collides with — blocks only itself: the read writes the rest, records `partial_import` on the
 * connection (the sync status shows it; never a clean success), and the next read writes the row. An error every row
 * hits is no bad row: the read fails as any failed read does — `api_error` on the connection, `coros_unreachable`
 * answered — and writes nothing. Driven through the real read (`corosReadNow`) against a renormalizing COROS.
 *
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { renormalizingCoros, type RenormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", TOKEN_ENCRYPTION_KEY: TEST_KEY } as unknown as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: RenormalizingCoros;
/** A value whose binding makes the planned-workout write fail: as a key collision would, or with another error. */
let poisonTitle: string | null = null;
let poisonKind: "constraint" | "other" = "constraint";
/** A failure every stage insert hits (no constraint: the schema drifted). */
let stagesBroken = false;

/** The test database, with the two failures wired into its statements (by bound value, as a constraint would be). */
function failingDb(): Db {
  const made = makeTestDb();
  const sqlite = (made as unknown as { $client: { prepare: (sql: string) => Record<string, unknown> } }).$client;
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (sql: string) => {
    const stmt = prepare(sql);
    const run = (stmt.run as (...p: unknown[]) => unknown).bind(stmt);
    if (/^insert into "planned_workouts"/.test(sql)) {
      stmt.run = (...params: unknown[]) => {
        if (poisonTitle !== null && params.includes(poisonTitle)) {
          if (poisonKind === "other") throw new Error("D1_ERROR: Network connection lost.");
          throw Object.assign(new Error("UNIQUE constraint failed: planned_workouts.user_id, planned_workouts.plan_id, planned_workouts.source_workout_id"), {
            name: "SqliteError",
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
        }
        return run(...params);
      };
    }
    if (/^insert into "planned_workout_stages"/.test(sql)) {
      stmt.run = (...params: unknown[]) => {
        if (stagesBroken) throw new Error("D1_ERROR: table planned_workout_stages has no column named note: SQLITE_ERROR");
        return run(...params);
      };
    }
    return stmt;
  };
  return made;
}

beforeEach(async () => {
  poisonTitle = null;
  poisonKind = "constraint";
  stagesBroken = false;
  db = failingDb();
  ({ userId, prefs } = await makeTestUser(db));
  server = renormalizingCoros({ baseMonday: startOfIsoWeek(todayInZone(prefs.timezone)) });
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, env, userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === COROS_LOCALE_URL) return new Response("window.en_US={};", { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connection = async () =>
  (await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.provider, "coros")))[0]!;
const planned = async () => db.select({ title: schema.plannedWorkouts.title }).from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, userId));
const read = () => corosReadNow(db, env, userId, prefs, { force: true });

async function syncStatusError(): Promise<string | null> {
  const app = mountRoutes(db, "/api/sync", syncRoutes);
  const res = await app.request("/api/sync/status", { headers: { Cookie: `${SESSION_COOKIE}=${await createSession(db, userId)}` } }, env);
  return ((await res.json()) as { cloud: { error: string | null } | null }).cloud?.error ?? null;
}

describe("a read whose import cannot write", () => {
  it("one bad row: the others land, the read reports partial (the sync status shows it), the next read writes the row", async () => {
    poisonTitle = "Easy + Strides";
    const first = await read();
    expect(first).toMatchObject({ status: "ok", failedWrites: 1 });
    const rows = await planned();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.map((r) => r.title)).not.toContain("Easy + Strides");
    expect((await connection()).lastErrorCategory).toBe("partial_import");
    expect(await syncStatusError()).toBe("partial_import");

    poisonTitle = null;
    const second = await read();
    expect(second.status).toBe("ok");
    expect(second.failedWrites).toBeUndefined();
    expect((await planned()).map((r) => r.title)).toContain("Easy + Strides");
    expect((await connection()).lastErrorCategory).toBeNull();
    expect(await syncStatusError()).toBeNull();
  });

  it("an error that is no constraint fails the read even when only one row meets it: no isolation for it", async () => {
    poisonTitle = "Easy + Strides";
    poisonKind = "other";
    const result = await read();
    expect(result.status).toBe("coros_unreachable");
    expect((await connection()).lastErrorCategory).toBe("api_error");
    // Its batch rolled back whole; the read stopped there.
    expect((await planned()).map((r) => r.title)).not.toContain("Easy + Strides");
  });

  it("an error every row hits fails the read: api_error recorded, COROS answered unreachable as before, nothing written", async () => {
    stagesBroken = true;
    const result = await read();
    expect(result.status).toBe("coros_unreachable");
    expect(result.failedWrites).toBeUndefined();
    const conn = await connection();
    expect(conn.lastErrorCategory).toBe("api_error");
    expect((conn.meta as { lastErrorDetail?: string }).lastErrorDetail).toContain("no column named note");
    expect(await planned()).toEqual([]);
    expect(await syncStatusError()).toBe("api_error");
  });
});
