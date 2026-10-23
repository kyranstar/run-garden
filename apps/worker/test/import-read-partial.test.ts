/**
 * A COROS READ WHOSE IMPORT CANNOT WRITE (Stage 1 Task 11, fix round 3).
 *
 * One bad row — a key it collides with — blocks only itself: the read writes the rest, records `partial_import` on the
 * connection (the sync status shows it; never a clean success), and the next read writes the row. A row that stays bad
 * stays its own (fix round 4): every later read, which queues only that row, is still a read — activities and health
 * run — and a partial full-schedule read keeps its `lastFullScheduleAt`. An error that is no constraint, or more bad
 * rows than the retry cap, is no bad row: the read fails as any failed read does — `api_error` on the connection,
 * `coros_unreachable` answered — unless it is the database itself failing (audit C3: "D1_ERROR: Network connection
 * lost"), which is ours, not COROS's: `storage_error`, the connection left healthy. Driven through the real read
 * (`corosReadNow`) against a renormalizing COROS.
 *
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
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
/** Every planned-workout insert collides (more bad rows than a read may retry one by one). */
let poisonAll = false;
/** A failure every stage insert hits (no constraint: the schema drifted). */
let stagesBroken = false;
/** The next write of a partial read's detail to the connection fails (once): the read fails after its schedule landed. */
let partialNoteFailsOnce = false;
/** What that write fails with. */
let partialNoteError = "D1_ERROR: Network connection lost.";

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
        if (poisonAll || (poisonTitle !== null && params.includes(poisonTitle))) {
          if (poisonKind === "other") throw new Error("D1_ERROR: Network connection lost.");
          throw Object.assign(new Error("UNIQUE constraint failed: planned_workouts.user_id, planned_workouts.plan_id, planned_workouts.source_workout_id"), {
            name: "SqliteError",
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
        }
        return run(...params);
      };
    }
    if (/^update "provider_connections"/.test(sql)) {
      stmt.run = (...params: unknown[]) => {
        if (partialNoteFailsOnce && params.some((p) => typeof p === "string" && p.includes("could not be saved"))) {
          partialNoteFailsOnce = false;
          throw new Error(partialNoteError);
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
  poisonAll = false;
  stagesBroken = false;
  partialNoteFailsOnce = false;
  partialNoteError = "D1_ERROR: Network connection lost.";
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
const healthDays = async () => (await db.select({ date: schema.dailyHealth.date }).from(schema.dailyHealth).where(eq(schema.dailyHealth.userId, userId))).length;
const activityCount = async () => (await db.select({ id: schema.activities.id }).from(schema.activities).where(eq(schema.activities.userId, userId))).length;

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

  it("a row that stays bad stays its own: two reads, both ok and partial, activities and health run on each", async () => {
    poisonTitle = "Easy + Strides";
    const first = await read();
    expect(first).toMatchObject({ status: "ok", failedWrites: 1 });
    expect((await connection()).lastErrorCategory).toBe("partial_import");
    expect(await activityCount()).toBeGreaterThan(0);
    expect(await healthDays()).toBeGreaterThan(0);
    const landed = (await planned()).length;

    // Between the reads: a new activity upstream, and the health days gone (the second read must put them back).
    const yesterday = addDays(todayInZone(prefs.timezone), -1);
    server.state.activities.push({
      labelId: "act-yoga-2",
      date: Number(yesterday.replaceAll("-", "")),
      name: "Second Flow",
      sportType: 904,
      startTime: Math.floor(Date.parse(`${yesterday}T19:00:00Z`) / 1000),
      totalTime: 1200,
      workoutTime: 1200,
    });
    const activitiesBefore = await activityCount();
    await db.delete(schema.dailyHealth).where(eq(schema.dailyHealth.userId, userId));

    // The second read queues only the bad row: every row it tries fails, and that is still the row's own failure.
    const second = await read();
    expect(second).toMatchObject({ status: "ok", failedWrites: 1 });
    expect(second.ingested).toBeGreaterThanOrEqual(1);
    expect(await activityCount()).toBe(activitiesBefore + 1);
    expect(await healthDays()).toBeGreaterThan(0);
    expect((await planned()).length).toBe(landed);
    const conn = await connection();
    expect(conn.lastErrorCategory).toBe("partial_import");
    expect((conn.meta as { lastErrorDetail?: string }).lastErrorDetail).toBe("1 planned workout(s) could not be saved");
    expect(await syncStatusError()).toBe("partial_import");
  });

  it("a partial full-schedule read keeps its lastFullScheduleAt: the next read is no full-schedule read", async () => {
    poisonTitle = "Easy + Strides";
    expect((await connection()).meta).not.toHaveProperty("lastFullScheduleAt");
    const first = await read();
    expect(first).toMatchObject({ status: "ok", fullSchedule: true, failedWrites: 1 });
    const meta = (await connection()).meta as { lastFullScheduleAt?: string; lastErrorDetail?: string };
    expect(typeof meta.lastFullScheduleAt).toBe("string");
    expect(meta.lastErrorDetail).toBe("1 planned workout(s) could not be saved");

    const second = await read();
    expect(second.status).toBe("ok");
    expect(second.fullSchedule).toBeUndefined();
    expect(((await connection()).meta as { lastFullScheduleAt?: string }).lastFullScheduleAt).toBe(meta.lastFullScheduleAt);
  });

  it("a read that fails after its full schedule landed keeps lastFullScheduleAt: the failure is recorded beside it", async () => {
    poisonTitle = "Easy + Strides";
    partialNoteFailsOnce = true;
    partialNoteError = "Cannot read properties of undefined (reading 'title')";
    const first = await read();
    expect(first.status).toBe("coros_unreachable");
    const conn = await connection();
    expect(conn.lastErrorCategory).toBe("api_error");
    const meta = conn.meta as { lastFullScheduleAt?: string; lastErrorDetail?: string };
    expect(meta.lastErrorDetail).toContain("Cannot read properties");
    expect(typeof meta.lastFullScheduleAt).toBe("string");
    poisonTitle = null;
    const second = await read();
    expect(second.status).toBe("ok");
    expect(second.fullSchedule).toBeUndefined();
  });

  it("the database failing there is ours, not COROS's (audit C3): storage_error, the connection untouched, lastFullScheduleAt kept", async () => {
    poisonTitle = "Easy + Strides";
    partialNoteFailsOnce = true;
    const first = await read();
    expect(first.status).toBe("storage_error");
    const conn = await connection();
    expect(conn.status).toBe("connected");
    expect(conn.lastErrorCategory).toBeNull();
    expect(typeof (conn.meta as { lastFullScheduleAt?: string }).lastFullScheduleAt).toBe("string");
    expect(await syncStatusError()).toBeNull();
    poisonTitle = null;
    const second = await read();
    expect(second.status).toBe("ok");
    expect(second.fullSchedule).toBeUndefined();
  });

  it("a read that fails before its full schedule lands claims none: the next read is the full-schedule read", async () => {
    poisonAll = true;
    expect((await read()).status).toBe("coros_unreachable");
    expect((await connection()).meta).not.toHaveProperty("lastFullScheduleAt");
    poisonAll = false;
    expect(await read()).toMatchObject({ status: "ok", fullSchedule: true });
  });

  it("more bad rows than the retry cap fail the read: api_error recorded, COROS answered unreachable", async () => {
    poisonAll = true;
    const result = await read();
    expect(result.status).toBe("coros_unreachable");
    expect(result.failedWrites).toBeUndefined();
    const conn = await connection();
    expect(conn.lastErrorCategory).toBe("api_error");
    expect((conn.meta as { lastErrorDetail?: string }).lastErrorDetail).toContain("UNIQUE constraint failed");
    expect(await planned()).toEqual([]);
  });

  it("an error that is no constraint fails the read even when only one row meets it: no isolation for it", async () => {
    poisonTitle = "Easy + Strides";
    poisonKind = "other";
    const result = await read();
    // The database itself failing (audit C3): the read fails, as ours — never a COROS outage on the connection.
    expect(result.status).toBe("storage_error");
    expect((await connection()).lastErrorCategory).toBeNull();
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
