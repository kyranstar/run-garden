/**
 * The restore marker (audit 1 data findings 2 and 8, ruling B2): while a
 * restore is replacing an account, every writer skips it.
 *
 * Before this, anything that wrote to the account during a restore silently
 * won over the file: one `advanceGarden` between begin and the `garden_state`
 * page left a newborn garden; a calendar sync between the cursor page and the
 * links page duplicated every event; a COROS pull during the workout pages took
 * their addresses and orphaned their children. Each writer here is shown
 * writing when the account is NOT marked (the control), and writing nothing at
 * all — not one INSERT, UPDATE or DELETE — while it is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { connectTestCoros, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const fakes = vi.hoisted(() => ({
  coros: null as unknown,
  google: null as unknown,
}));
vi.mock("../src/services/coros-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/coros-connection.js")>()),
  corosClient: vi.fn(async () => fakes.coros),
}));
vi.mock("../src/services/google-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-calendar.js")>()),
  googleCalendarClient: vi.fn(async () => fakes.google),
}));

import { advanceGarden, buildGardenView, ensureGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { corosReadNow, corosReadSweep } from "../src/services/coros-read.js";
import { syncCalendar } from "../src/services/calendar-sync.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { processCoachReads } from "../src/services/coach-reads.js";
import { wake } from "../src/services/coach-wake.js";
import { enqueueBackfill, runBackfillChunkCloud } from "../src/services/backfill.js";
import { corosMcpSleepSweep, syncCorosMcpSleep } from "../src/services/coros-mcp.js";
import { halfHourly, hourly, weekly } from "../src/index.js";
import { planRoutes } from "../src/routes/plan.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

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
    AI_GATEWAY_API_KEY: "test-key",
  };
}

const failingFetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

/** A db whose writes are recorded; `writes()` returns and clears them. */
function recordingDb(): { db: Db; writes: () => string[] } {
  let log: string[] = [];
  const db = makeTestDb({ onStatement: (sql) => isWrite(sql) && log.push(sql) });
  return {
    db,
    writes: () => {
      const out = log;
      log = [];
      return out;
    },
  };
}

async function mark(db: Db, userId: string): Promise<void> {
  await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
}

async function unmark(db: Db, userId: string): Promise<void> {
  await db.delete(schema.accountState).where(eq(schema.accountState.userId, userId));
}

async function seedWorkout(db: Db, userId: string, prefs: UserPreferences): Promise<string> {
  const id = newId();
  const date = addDays(todayInZone(prefs.timezone), 2);
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `src-${id}`,
    title: "Easy run",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    calendarSyncState: "pending",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** Runs `fn` unmarked (it must write) and then marked (it must not). */
async function controlThenMarked(
  setup: () => Promise<{ db: Db; userId: string; writes: () => string[] }>,
  fn: (db: Db, userId: string) => Promise<unknown>,
): Promise<{ control: string[]; marked: string[]; result: unknown }> {
  const a = await setup();
  a.writes();
  await fn(a.db, a.userId).catch(() => undefined);
  const control = a.writes();

  const b = await setup();
  await mark(b.db, b.userId);
  b.writes();
  const result = await fn(b.db, b.userId);
  return { control, marked: b.writes(), result };
}

beforeEach(() => {
  fakes.coros = null;
  fakes.google = null;
});

describe("every writer is a no-op while a restore is replacing the account", () => {
  const fresh = async () => {
    const { db, writes } = recordingDb();
    const { userId } = await makeTestUser(db);
    return { db, userId, writes };
  };

  it("ensureGarden and advanceGarden: no genesis garden is created", async () => {
    for (const fn of [
      (db: Db, userId: string) => ensureGarden(db, userId, { timezone: "UTC" } as UserPreferences),
      (db: Db, userId: string) => advanceGarden(db, userId, { timezone: "UTC" } as UserPreferences),
    ]) {
      const { control, marked, result } = await controlThenMarked(fresh, fn);
      expect(control.length).toBeGreaterThan(0);
      expect(marked).toEqual([]);
      expect(result).toBeTruthy();
    }
  });

  it("resimulateFrom, and a garden read (GET /api/garden still answers)", async () => {
    const setup = async () => {
      const f = await fresh();
      const { loadPreferences } = await import("../src/services/calendar-sync.js");
      const prefs = await loadPreferences(f.db, f.userId);
      await ensureGarden(f.db, f.userId, prefs, addDays(todayInZone(prefs.timezone), -10));
      return f;
    };
    const today = todayInZone("UTC");
    const { loadPreferences } = await import("../src/services/calendar-sync.js");
    const resim = await controlThenMarked(setup, async (db, userId) =>
      resimulateFrom(db, userId, addDays(today, -8), await loadPreferences(db, userId)),
    );
    expect(resim.control.length).toBeGreaterThan(0);
    expect(resim.marked).toEqual([]);

    const view = await controlThenMarked(setup, async (db, userId) =>
      buildGardenView(db, userId, await loadPreferences(db, userId)),
    );
    expect(view.control.length).toBeGreaterThan(0);
    expect(view.marked).toEqual([]);
    expect((view.result as { snapshot: unknown }).snapshot).toBeTruthy();
  });

  it("corosReadNow and the half-hourly read sweep", async () => {
    const setup = async () => {
      const f = await fresh();
      await connectTestCoros(f.db, f.userId);
      fakes.coros = {}; // a "client" whose every call fails — the read writes its error
      return f;
    };
    const one = await controlThenMarked(setup, async (db, userId) =>
      corosReadNow(db, makeEnv(), userId, { timezone: "UTC" } as UserPreferences, { force: true, fetchImpl: failingFetch }),
    );
    expect(one.control.length).toBeGreaterThan(0);
    expect(one.marked).toEqual([]);
    expect(one.result).toEqual({ status: "restoring" });

    const sweep = await controlThenMarked(setup, (db) => corosReadSweep(db, makeEnv()));
    expect(sweep.control.length).toBeGreaterThan(0);
    expect(sweep.marked).toEqual([]);
  });

  it("the COROS sleep sweep", async () => {
    const setup = async () => {
      const f = await fresh();
      await f.db.insert(schema.providerConnections).values({
        id: newId(),
        userId: f.userId,
        provider: "coros_mcp",
        status: "connected",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
      return f;
    };
    const direct = await controlThenMarked(setup, (db, userId) => syncCorosMcpSleep(db, makeEnv(), userId, "UTC", failingFetch));
    expect(direct.marked).toEqual([]);
    const sweep = await controlThenMarked(setup, (db) => corosMcpSleepSweep(db, makeEnv(), async () => "UTC", failingFetch));
    expect(sweep.marked).toEqual([]);
  });

  it("syncCalendar: Google is never called and nothing is written", async () => {
    const calls: string[] = [];
    const setup = async () => {
      const f = await fresh();
      const { loadPreferences, savePreferences } = await import("../src/services/calendar-sync.js");
      const prefs = await loadPreferences(f.db, f.userId);
      await savePreferences(f.db, f.userId, { ...prefs, calendarId: "cal" });
      await seedWorkout(f.db, f.userId, prefs);
      fakes.google = {
        listEvents: async () => {
          calls.push("list");
          return { items: [], nextSyncToken: "t" };
        },
        insertEvent: async () => {
          calls.push("insert");
          return { id: newId() };
        },
        patchEvent: async () => void calls.push("patch"),
        deleteEvent: async () => void calls.push("delete"),
      };
      return f;
    };
    const { control, marked, result } = await controlThenMarked(setup, (db, userId) => syncCalendar(db, makeEnv(), userId));
    expect(control.length).toBeGreaterThan(0);
    expect(calls).toEqual(["list", "insert"]); // the control only
    expect(marked).toEqual([]);
    expect(result).toMatchObject({ skipped: true, created: 0 });
  });

  it("executeCloudJobs: no job is claimed, nothing reaches the watch", async () => {
    const setup = async () => {
      const f = await fresh();
      fakes.coros = {};
      return f;
    };
    const { control, marked, result } = await controlThenMarked(setup, (db, userId) =>
      executeCloudJobs(db, makeEnv(), userId, { timezone: "UTC" } as UserPreferences, { fetchImpl: failingFetch }),
    );
    expect(control.length).toBeGreaterThan(0);
    expect(marked).toEqual([]);
    expect(result).toEqual({ executed: 0 });
  });

  it("processCoachReads: nothing is claimed or spent", async () => {
    const setup = async () => {
      const f = await fresh();
      const activityId = newId();
      await f.db.insert(schema.activities).values({
        id: activityId,
        userId: f.userId,
        startTime: new Date(Date.now() - 3600_000).toISOString(),
        sport: "run",
        durationSeconds: 1800,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
      await f.db.insert(schema.coachReads).values({
        id: newId(),
        userId: f.userId,
        activityId,
        status: "queued",
        attempt: 0,
        nextAttemptAt: "2026-01-01T00:00:00.000Z",
        flags: [],
        createdAt: nowInstant(),
      });
      return f;
    };
    const { loadPreferences } = await import("../src/services/calendar-sync.js");
    const { control, marked, result } = await controlThenMarked(setup, async (db, userId) =>
      processCoachReads(db, makeEnv(), userId, await loadPreferences(db, userId), { fetchImpl: failingFetch }),
    );
    expect(control.length).toBeGreaterThan(0);
    expect(marked).toEqual([]);
    expect(result).toEqual({ processed: 0, attempted: 0, skipped: "restoring" });
  });

  it("coach wakes — a message and an automatic one — do not think, spend or write", async () => {
    const { loadPreferences } = await import("../src/services/calendar-sync.js");
    // The control runs once: a wake that fails at the gateway still writes
    // (its lock, its failure receipt) — and takes seconds to back off.
    const { control } = await controlThenMarked(fresh, async (db, userId) =>
      wake(db, makeEnv(), userId, await loadPreferences(db, userId), { kind: "manual" }, failingFetch),
    );
    expect(control.length).toBeGreaterThan(0);
    for (const cause of [
      { kind: "manual" as const },
      { kind: "open" as const },
      { kind: "message" as const, body: "how's my week?", recorded: false },
    ]) {
      const { db, userId, writes } = await fresh();
      await mark(db, userId);
      writes();
      const result = await wake(db, makeEnv(), userId, await loadPreferences(db, userId), cause, failingFetch);
      expect(writes(), cause.kind).toEqual([]);
      expect(result).toEqual({ status: "skipped" });
    }
  }, 30_000);

  it("backfill: no walk is queued and no chunk runs", async () => {
    const today = todayInZone("UTC");
    const enq = await controlThenMarked(fresh, (db, userId) => enqueueBackfill(db, userId, today));
    expect(enq.control.length).toBeGreaterThan(0);
    expect(enq.marked).toEqual([]);
    expect(enq.result).toEqual({ enqueued: false, reason: "restoring" });

    const setup = async () => {
      const f = await fresh();
      await enqueueBackfill(f.db, f.userId, today);
      fakes.coros = {};
      return f;
    };
    const run = await controlThenMarked(setup, (db, userId) =>
      runBackfillChunkCloud(db, makeEnv(), userId, { timezone: "UTC" } as UserPreferences, failingFetch),
    );
    expect(run.control.length).toBeGreaterThan(0);
    expect(run.marked).toEqual([]);
    expect(run.result).toEqual({ ran: false });
  });
});

describe("the crons skip a marked account, per user", () => {
  it("hourly, half-hourly and weekly work on the other account and leave the marked one alone", async () => {
    const db = makeTestDb();
    const { userId: restoring } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await mark(db, restoring);
    const env = { ...makeEnv(), AI_GATEWAY_API_KEY: undefined };

    await hourly(db, env);
    await halfHourly(db, env);
    await weekly(db, env);

    const runsFor = async (userId: string) =>
      (await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.userId, userId))).map((r) => r.kind).sort();
    expect(await runsFor(restoring)).toEqual([]);
    expect(await runsFor(other)).toEqual(["calendar_sync", "reconcile", "weekly_review"]);
    expect(await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, restoring))).toEqual([]);
    expect(await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, other))).toHaveLength(1);

    // Once the restore finishes, the account is worked on again.
    await unmark(db, restoring);
    await hourly(db, env);
    expect(await runsFor(restoring)).toEqual(["reconcile"]);
  });
});

describe("every other write request is refused while marked (423)", () => {
  async function request(db: Db, userId: string, method: string, path: string, routes: typeof planRoutes, base: string) {
    const token = await createSession(db, userId, "test");
    const app = mountRoutes(db, base, routes);
    return app.request(
      path,
      { method, headers: { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" },
      makeEnv(),
    );
  }

  it("refuses a plan write and a settings save, still answers reads and the restore's own calls", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = newId();
    await mark(db, userId);

    const move = await request(db, userId, "POST", `/api/plan/workouts/${workoutId}/move`, planRoutes, "/api/plan");
    expect(move.status).toBe(423);
    expect(await move.json()).toEqual({ error: "restore_in_progress" });
    const save = await request(db, userId, "PUT", "/api/settings", settingsRoutes, "/api/settings");
    expect(save.status).toBe(423);

    const read = await request(db, userId, "GET", "/api/settings", settingsRoutes, "/api/settings");
    expect(read.status).toBe(200);
    const fresh = await request(db, userId, "POST", "/api/settings/restore/start-fresh", settingsRoutes, "/api/settings");
    expect(fresh.status).toBe(200);
    // Start fresh cleared the marker: writes go through again.
    const again = await request(db, userId, "PUT", "/api/settings", settingsRoutes, "/api/settings");
    expect(again.status).not.toBe(423);
  });
});
