/**
 * Ruling B9 (re-review of fix wave B, N5): the restore marker also stops
 *  - GET handlers that write — the insights records upsert, and the coach
 *    state read's proposal and question sweeps and trigger evaluation — which
 *    serve read-only while it is set;
 *  - long-running work that was already under way when begin fired, which
 *    re-checks the marker before it persists: the hourly per-user loop before
 *    each writer step, the weekly review insert, a coach wake, a backfill
 *    chunk and a coach read.
 * And a `computed_metrics` row from the file wins over a same-key row a
 * writer slipped in first (one row per account and metric key).
 *
 * "Begin fired meanwhile" is simulated by setting the marker from inside the
 * slow part — the model call, the COROS call, or the garden step.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const fakes = vi.hoisted(() => ({ coros: null as unknown }));
vi.mock("../src/services/coros-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/coros-connection.js")>()),
  corosClient: vi.fn(async () => fakes.coros),
}));

import { hourly } from "../src/index.js";
import { insightRoutes } from "../src/routes/misc.js";
import { coachRoutes } from "../src/routes/coach.js";
import { generateWeeklyReview } from "../src/services/llm.js";
import { wake } from "../src/services/coach-wake.js";
import { enqueueBackfill, runBackfillChunkCloud } from "../src/services/backfill.js";
import { ensureRead, processCoachReads } from "../src/services/coach-reads.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { beginRestore, finishRestore, restoreRows } from "../src/services/account-restore.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { checkFile, exportAll, pagesOf, restoreAll, TEST_SECRET } from "./restore-driver.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: TEST_SECRET,
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key",
    ...overrides,
  } as Env;
}

const chat = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * A database that records its writes, and can mark the account as restoring
 * from inside any statement or call — "begin fired while this was running".
 * `after()` is every write since the mark, minus the marker itself.
 */
function scene() {
  let log: string[] = [];
  let marked = false;
  let markOn: RegExp | null = null;
  let userId = "";
  let db!: Db;
  const markNow = () => {
    if (marked) return;
    marked = true;
    log = [];
    // Synchronous on better-sqlite3: lands before the statement that tripped it.
    (db.insert(schema.accountState).values({
      userId,
      restoreId: newId(),
      restoreStartedAt: nowInstant(),
      updatedAt: nowInstant(),
    }) as unknown as { run: () => void }).run();
  };
  db = makeTestDb({
    onStatement: (sql) => {
      if (markOn && !marked && markOn.test(sql)) markNow();
      else if (isWrite(sql) && !/"account_state"/.test(sql)) log.push(sql);
    },
  });
  return {
    db,
    setUser: (id: string) => void (userId = id),
    /** Mark the account the first time a statement matches. */
    markWhen: (re: RegExp) => void (markOn = re),
    markNow,
    clear: () => void (log = []),
    after: () => log,
  };
}

async function markedDirectly(db: Db, userId: string): Promise<void> {
  await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
}

async function seedRuns(db: Db, userId: string, tz: string, n = 12): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    const date = addDays(todayInZone(tz), -i * 3);
    await db.insert(schema.activities).values({
      id: newId(),
      userId,
      startTime: `${date}T14:00:00Z`,
      startTimeLocal: `${date}T07:00:00`,
      sport: "run",
      durationSeconds: 1500 + i * 60,
      distanceMeters: 5200 + i * 400,
      avgHeartRate: 150,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
  }
}

async function seedExpiredProposal(db: Db, userId: string, tz: string): Promise<string> {
  const id = newId();
  await db.insert(schema.coachProposals).values({
    id,
    userId,
    planId: null,
    title: "Swap Thursday",
    evidence: "e",
    rationale: "r",
    flags: [],
    ops: [],
    status: "pending",
    createdAt: nowInstant(),
    expiresAt: addDays(todayInZone(tz), -3),
  });
  return id;
}

async function get(db: Db, userId: string, path: string, base: string, routes: typeof insightRoutes) {
  const token = await createSession(db, userId, "t");
  return mountRoutes(db, base, routes).request(path, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, makeEnv());
}

beforeEach(() => {
  fakes.coros = null;
});

describe("GET handlers that write serve read-only while marked", () => {
  it("GET /api/insights computes records but does not upsert them", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId, prefs } = await makeTestUser(s.db);
      s.setUser(userId);
      await seedRuns(s.db, userId, prefs.timezone);
      if (restoring) await markedDirectly(s.db, userId);
      s.clear();
      const res = await get(s.db, userId, "/api/insights", "/api/insights", insightRoutes);
      expect(res.status).toBe(200);
      const metricWrites = s.after().filter((w) => /computed_metrics/.test(w));
      if (restoring) expect(metricWrites).toEqual([]);
      else expect(metricWrites.length).toBeGreaterThan(0);
    }
  });

  it("GET /api/coach/state sweeps nothing and evaluates no triggers", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId, prefs } = await makeTestUser(s.db);
      s.setUser(userId);
      const proposalId = await seedExpiredProposal(s.db, userId, prefs.timezone);
      if (restoring) await markedDirectly(s.db, userId);
      s.clear();
      const res = await get(s.db, userId, "/api/coach/state", "/api/coach", coachRoutes as never);
      expect(res.status).toBe(200);
      const writes = s.after().filter((w) => !/"sessions"/.test(w));
      const [p] = await s.db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, proposalId));
      if (restoring) {
        expect(writes).toEqual([]);
        expect(p!.status).toBe("pending");
      } else {
        expect(writes.length).toBeGreaterThan(0);
        expect(p!.status).toBe("expired");
      }
    }
  });
});

describe("work already running when begin fires re-checks before it persists", () => {
  it("the hourly per-user loop stops after the step during which the restore began", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId, prefs } = await makeTestUser(s.db);
      s.setUser(userId);
      const proposalId = await seedExpiredProposal(s.db, userId, prefs.timezone);
      // Begin fires while the garden step runs.
      if (restoring) s.markWhen(/from "garden_state"/);
      await hourly(s.db, makeEnv({ AI_GATEWAY_API_KEY: undefined }));
      const [p] = await s.db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, proposalId));
      if (restoring) {
        expect(s.after().filter((w) => !/"sync_runs"/.test(w))).toEqual([]);
        expect(p!.status).toBe("pending");
      } else {
        expect(p!.status).toBe("expired");
      }
    }
  });

  it("the weekly review is not written when the restore began during its model call", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId } = await makeTestUser(s.db);
      s.setUser(userId);
      const fetchImpl = (async () => {
        if (restoring) s.markNow();
        return chat({ narrative: "A steady week." });
      }) as typeof fetch;
      await generateWeeklyReview(
        s.db,
        makeEnv(),
        userId,
        { weekStart: "2026-09-21", facts: { runs: 3 }, units: "km" },
        true,
        fetchImpl,
      );
      const rows = await s.db.select().from(schema.weeklyReviews).where(eq(schema.weeklyReviews.userId, userId));
      expect(rows.length, String(restoring)).toBe(restoring ? 0 : 1);
    }
  });

  it("a coach wake persists nothing when the restore began during its model call", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId } = await makeTestUser(s.db);
      s.setUser(userId);
      const prefs = await loadPreferences(s.db, userId);
      const fetchImpl = (async () => {
        if (restoring) s.markNow();
        return chat({ briefing: "Easy week ahead.", proposals: [], question: null, memoryOps: [] });
      }) as typeof fetch;
      const result = await wake(s.db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
      const said = await s.db
        .select()
        .from(schema.coachMessages)
        .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
      if (restoring) {
        expect(result).toEqual({ status: "skipped" });
        expect(said).toEqual([]);
        // Only the lock's own bookkeeping and the spend record (a call that
        // did happen) are written after the mark.
        expect(s.after().filter((w) => !/"coach_locks"|"llm_usage"/.test(w))).toEqual([]);
      } else {
        expect(result).toMatchObject({ status: "ok" });
        expect(said).toHaveLength(1);
      }
    }
  }, 60_000);

  it("a backfill chunk records nothing when the restore began during the COROS call", async () => {
    for (const restoring of [false, true]) {
      const s = scene();
      const { userId, prefs } = await makeTestUser(s.db);
      s.setUser(userId);
      await enqueueBackfill(s.db, userId, todayInZone(prefs.timezone));
      fakes.coros = {
        getActivities: async () => {
          if (restoring) s.markNow();
          return [];
        },
        getActivityDetail: async () => {
          throw new Error("unused");
        },
      };
      s.clear();
      const res = await runBackfillChunkCloud(s.db, makeEnv(), userId, prefs);
      if (restoring) {
        expect(res).toEqual({ ran: false });
        expect(s.after().filter((w) => !/"coach_locks"/.test(w))).toEqual([]);
      } else {
        expect(res).toEqual({ ran: true });
      }
    }
  });

  it("a coach read is not completed when the restore began during its model call", async () => {
    for (const via of ["cron", "athlete"] as const) {
      for (const restoring of [false, true]) {
        const s = scene();
        const { userId, prefs } = await makeTestUser(s.db);
        s.setUser(userId);
        const activityId = newId();
        await s.db.insert(schema.activities).values({
          id: activityId,
          userId,
          startTime: new Date(Date.now() - 3600_000).toISOString(),
          sport: "run",
          durationSeconds: 1800,
          distanceMeters: 5000,
          createdAt: nowInstant(),
          updatedAt: nowInstant(),
        });
        await s.db.insert(schema.coachReads).values({
          id: newId(),
          userId,
          activityId,
          status: "queued",
          attempt: 0,
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
          flags: [],
          createdAt: nowInstant(),
        });
        const fetchImpl = (async () => {
          if (restoring) s.markNow();
          return chat({ glance: "Steady.", body: "A steady run.", flags: [] });
        }) as typeof fetch;
        if (via === "cron") await processCoachReads(s.db, makeEnv(), userId, prefs, { fetchImpl });
        else await ensureRead(s.db, makeEnv(), userId, prefs, activityId, { fetchImpl });
        const [row] = await s.db.select().from(schema.coachReads).where(eq(schema.coachReads.activityId, activityId));
        expect(row!.status === "done", `${via} ${restoring}`).toBe(!restoring);
        if (restoring) expect(s.after().filter((w) => !/"llm_usage"/.test(w))).toEqual([]);
      }
    }
  });
});

describe("a garden walk already running when begin fires", () => {
  it("stops within a week of days, and moves nothing durable", async () => {
    const s = scene();
    const { userId, prefs } = await makeTestUser(s.db);
    s.setUser(userId);
    const today = todayInZone(prefs.timezone);
    await ensureGarden(s.db, userId, prefs, addDays(today, -120));
    // Begin fires as the walk writes its first day.
    s.markWhen(/insert into "garden_day_inputs"/);
    await advanceGarden(s.db, userId, prefs);
    const days = s.after().filter((w) => /"garden_day_inputs"/.test(w)).length;
    expect(days).toBeLessThanOrEqual(7);
    expect(s.after().filter((w) => /"garden_state"|"garden_plants"|"garden_wildlife"/.test(w))).toEqual([]);
  });

  it("the file's garden rows win over rows such a walk landed after the wipe", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedRuns(db, userId, prefs.timezone, 8);
    await ensureGarden(db, userId, prefs, addDays(today, -30));
    await advanceGarden(db, userId, prefs);
    await db.insert(schema.gardenUnlocks).values({ id: newId(), userId, speciesId: "clover", unlockedOn: addDays(today, -20) });
    const file = await exportAll(db, userId);
    const fileEvent = file.tables.garden_events![0]!;
    const fileInput = file.tables.garden_day_inputs![0]!;
    const fileSnapshot = file.tables.garden_snapshots![0]!;
    const fileUnlock = file.tables.garden_unlocks![0]!;
    await restoreAll(db, userId, file, {
      // A walk that started before begin writes into the wiped account: the
      // same ids (they derive from the date), different content.
      beforeRows: async () => {
        await db.insert(schema.gardenEvents).values({ ...(fileEvent as object), detail: "stale" } as never);
        await db.insert(schema.gardenDayInputs).values({ ...(fileInput as object), input: { stale: true } } as never);
        await db.insert(schema.gardenSnapshots).values({ ...(fileSnapshot as object), snapshot: { stale: true } } as never);
        await db
          .insert(schema.gardenUnlocks)
          .values({ id: newId(), userId, speciesId: fileUnlock.speciesId as string, unlockedOn: "2020-01-01" });
      },
    });
    const [event] = await db.select().from(schema.gardenEvents).where(eq(schema.gardenEvents.id, fileEvent.id as string));
    expect(event).toEqual(fileEvent);
    const [input] = await db.select().from(schema.gardenDayInputs).where(eq(schema.gardenDayInputs.id, fileInput.id as string));
    expect(input).toEqual(fileInput);
    const [snap] = await db.select().from(schema.gardenSnapshots).where(eq(schema.gardenSnapshots.id, fileSnapshot.id as string));
    expect(snap).toEqual(fileSnapshot);
    const unlocks = await db
      .select()
      .from(schema.gardenUnlocks)
      .where(and(eq(schema.gardenUnlocks.userId, userId), eq(schema.gardenUnlocks.speciesId, fileUnlock.speciesId as string)));
    expect(unlocks).toEqual([fileUnlock]);
  });
});

describe("computed_metrics: the file's row wins over a same-key row", () => {
  it("a records row a writer upserted mid-restore is replaced by the file's", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const metricKey = "records:v2:run";
    const fileValue = { records: [{ id: "run:5k", seconds: 1500 }] };
    await db.insert(schema.computedMetrics).values({
      id: `${metricKey}:${userId}`,
      userId,
      metricKey,
      computedAt: nowInstant(),
      inputFingerprint: "file",
      status: "ok",
      sampleSize: 1,
      value: fileValue,
    });
    const file = await exportAll(db, userId);
    const checked = await checkFile(db, userId, file);
    const begun = await beginRestore(
      db,
      userId,
      { session: checked.session, replace: true, tokens: [...checked.tokens.values()] },
      { secret: TEST_SECRET },
    );
    if (!begun.ok) throw new Error(begun.error);
    // A writer that did not see the marker lands a partial row first.
    await db.insert(schema.computedMetrics).values({
      id: `${metricKey}:${userId}`,
      userId,
      metricKey,
      computedAt: nowInstant(),
      inputFingerprint: "partial",
      status: "ok",
      sampleSize: 0,
      value: { records: [] },
    });
    for (const table of begun.tables) {
      const pages = pagesOf(file.tables[table] ?? [], 200);
      for (let p = 0; p < pages.length; p += 1) {
        const res = await restoreRows(
          db,
          userId,
          { restoreId: begun.restoreId, table, rows: pages[p], token: checked.tokens.get(`${table}#${p}`) },
          { secret: TEST_SECRET },
        );
        if (!res.ok) throw new Error(`${table}: ${res.error}`);
      }
    }
    expect((await finishRestore(db, userId, { restoreId: begun.restoreId })).ok).toBe(true);
    const rows = await db.select().from(schema.computedMetrics).where(eq(schema.computedMetrics.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputFingerprint: "file", value: fileValue, sampleSize: 1 });
  });
});
