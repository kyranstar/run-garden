/**
 * WHAT THE ATHLETE CAN DO ABOUT AN EARLIER VERSION ON THE WATCH (the owner, 2026-10-19: "not actionable or
 * removable"). The session's sheet reads what is honestly possible for that row (`GET /api/plan/workouts/:id`'s
 * `watchVersion`): send the app's version — the content rewrite the convergence backfill queues, offered only when
 * one can reach the row — or keep the watch's, which closes the claim and writes nothing to the watch or the session.
 * Driven against the mock COROS account, end to end: an imported session, eased, its rewrite failed (as the owner's
 * did), then sent again or kept.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, todayInZone, type CoachSession, type UserPreferences } from "@rg/domain";
import { normalizeCorosSchedule } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { computeSyncStatus } from "../src/services/sync-status.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const THRESHOLD = 289;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const EASED: CoachSession = {
  category: "easy",
  title: "Easy, legs heavy",
  durationMinutes: 35,
  run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
} as unknown as CoachSession;

interface Account {
  db: Db;
  userId: string;
  prefs: UserPreferences;
  server: ReturnType<typeof mockCorosServer>;
  cookie: string;
  /** Statements the app ran while `count` was running. */
  count: <T>(f: () => Promise<T>) => Promise<{ value: T; statements: number; writes: string[] }>;
}

async function account(over: { corosWritesEnabled?: boolean } = {}): Promise<Account> {
  let counting = false;
  let statements = 0;
  let writes: string[] = [];
  const db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      if (!counting) return;
      statements += 1;
      if (isWrite(sql)) writes.push(sql);
    },
  });
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: over.corosWritesEnabled ?? true });
  const server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  const today = todayInZone(prefs.timezone);
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${today}`,
    userId,
    date: today,
    thresholdPaceSecPerKm: THRESHOLD,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  return {
    db,
    userId,
    prefs,
    server,
    cookie,
    count: async (f) => {
      statements = 0;
      writes = [];
      counting = true;
      try {
        const value = await f();
        return { value, statements, writes };
      } finally {
        counting = false;
      }
    },
  };
}

async function readAndImport(a: Account): Promise<void> {
  const today = todayInZone(a.prefs.timezone);
  const normalized = normalizeCorosSchedule(a.server.state.schedule);
  await importPlanSnapshot(
    a.db,
    {
      userId: a.userId,
      plan: {
        sourcePlanId: normalized.planId,
        name: normalized.planName,
        ...(normalized.planStart ? { startDate: normalized.planStart } : {}),
        ...(normalized.planEnd ? { endDate: normalized.planEnd } : {}),
      },
      workouts: normalized.workouts,
      rangeStart: addDays(today, -40),
      rangeEnd: addDays(today, 80),
      source: "fixture",
    },
    a.prefs,
  );
}

const rewrites = (a: Account, workoutId: string) =>
  a.db
    .select()
    .from(schema.corosWriteJobs)
    .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "coach_update_workout")));

/**
 * The owner's shape: a COROS-authored session, imported, eased — and its rewrite failed, so the watch keeps the
 * earlier version and nothing is on its way. The sheet's row reads `content_stale`.
 */
async function easedAndFailed(over: { corosWritesEnabled?: boolean } = {}): Promise<Account & { workoutId: string }> {
  const a = await account(over);
  await readAndImport(a);
  const [row] = await a.db
    .select()
    .from(schema.plannedWorkouts)
    .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
  expect(row).toBeDefined();
  const eased = await applyOps(a.db, a.userId, { ...a.prefs, corosWritesEnabled: true }, "p-ease", [
    coachOpSchema.parse({ kind: "ease", workoutId: row!.id, session: EASED }),
  ]);
  expect(eased.missed).toEqual([]);
  await a.db
    .update(schema.corosWriteJobs)
    .set({ status: "failed", lastErrorCategory: "verification_failed" })
    .where(eq(schema.corosWriteJobs.workoutId, row!.id));
  return { ...a, workoutId: row!.id };
}

const request = async (a: Account, path: string, method: "GET" | "POST" = "GET"): Promise<Response> =>
  mountRoutes(a.db, "/api/plan", planRoutes).request(path, { method, headers: { Cookie: a.cookie } }, makeEnv());

async function detail(a: Account, id: string) {
  const res = await request(a, `/api/plan/workouts/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { workout: { corosSyncView: string }; watchVersion?: { send: boolean; why?: string } };
}

describe("GET /api/plan/workouts/:id — what can be done about the watch's earlier version", () => {
  it("offers Send when a rewrite can reach the row", async () => {
    const a = await easedAndFailed();
    const d = await detail(a, a.workoutId);
    expect(d.workout.corosSyncView).toBe("content_stale");
    expect(d.watchVersion).toEqual({ send: true });
  });

  it("says why not otherwise: watch updates off, COROS not connected, nothing a rewrite can send", async () => {
    const off = await easedAndFailed({ corosWritesEnabled: false });
    expect((await detail(off, off.workoutId)).watchVersion).toEqual({ send: false, why: "writes_off" });

    const gone = await easedAndFailed();
    await gone.db.update(schema.providerConnections).set({ status: "disconnected" });
    expect((await detail(gone, gone.workoutId)).watchVersion).toEqual({ send: false, why: "not_connected" });

    // The app's copy has no structure of its own to send: never a guess.
    const bare = await easedAndFailed();
    await bare.db.delete(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, bare.workoutId));
    expect((await detail(bare, bare.workoutId)).watchVersion).toEqual({ send: false, why: "cant_rewrite" });
  });

  it("an app-built session reaches the watch only by its own Send — never a rewrite from here", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await detail(a, a.workoutId)).watchVersion).toEqual({ send: false, why: "cant_rewrite" });
    // Whatever else is true: the reason is the app-built session's, never a setting that would not change it.
    await a.db.update(schema.providerConnections).set({ status: "disconnected" });
    expect((await detail(a, a.workoutId)).watchVersion).toEqual({ send: false, why: "cant_rewrite" });
  });

  it("says nothing on a row with no earlier version, and pays nothing for it", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ completionState: "skipped" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await detail(a, a.workoutId)).watchVersion).toBeUndefined();
  });

  it("reads it within the request budget", async () => {
    const a = await easedAndFailed();
    const { statements } = await a.count(() => detail(a, a.workoutId));
    expect(statements).toBeLessThanOrEqual(45);
  });
});

describe("POST /api/plan/workouts/:id/watch-version/send", () => {
  it("queues the rewrite again, the line counts down at once, and the drain puts the app's version on the watch", async () => {
    const a = await easedAndFailed();
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);

    const { value: res, statements } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/send`, "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, coachDrain: true });
    expect(statements).toBeLessThanOrEqual(45);
    const [job] = await rewrites(a, a.workoutId);
    expect(job!.status, "the failed rewrite, revived: the athlete is asking again").toBe("queued");
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("syncing");

    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("verified");
    const onWire = normalizeCorosSchedule(a.server.state.schedule).workouts.find((w) => w.title === EASED.title);
    expect(onWire, "the watch holds the app's version").toBeDefined();
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
  });

  it("refuses with the reason and writes nothing when it can't be sent", async () => {
    const bare = await easedAndFailed();
    await bare.db.delete(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, bare.workoutId));
    const { value: res, writes } = await bare.count(() => request(bare, `/api/plan/workouts/${bare.workoutId}/watch-version/send`, "POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cant_rewrite" });
    expect(writes, "no backup, no job").toEqual([]);

    const off = await easedAndFailed({ corosWritesEnabled: false });
    const r2 = await request(off, `/api/plan/workouts/${off.workoutId}/watch-version/send`, "POST");
    expect(r2.status).toBe(409);
    expect(await r2.json()).toEqual({ error: "writes_off" });

    // A session whose story is over has nothing to send.
    const done = await easedAndFailed();
    await done.db.update(schema.plannedWorkouts).set({ completionState: "missed" }).where(eq(schema.plannedWorkouts.id, done.workoutId));
    const r3 = await request(done, `/api/plan/workouts/${done.workoutId}/watch-version/send`, "POST");
    expect(r3.status).toBe(409);
    expect(await r3.json()).toEqual({ error: "nothing_to_send" });
    expect((await rewrites(done, done.workoutId))[0]!.status).toBe("failed");
  });

  it("never takes a session off the watch: an app copy the wire can't carry is not sent, and no removal is queued", async () => {
    // A session this app created and pushed (its stamp proves it), then changed into a distance run the watch
    // can't be given: the backfill would REMOVE the watch's copy. A send must not.
    const a = await account();
    const date = addDays(todayInZone(a.prefs.timezone), 6);
    const added = await applyOps(a.db, a.userId, a.prefs, "p-push", [
      coachOpSchema.parse({
        kind: "add",
        date,
        session: { category: "quality", title: "Threshold 4x4", durationMinutes: 40, run: { blocks: [{ kind: "duration", value: 40, intensity: "threshold" }] } },
      }),
    ]);
    const workoutId = added.created[0]!;
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    const eased = await applyOps(a.db, a.userId, a.prefs, "p-ease-distance", [
      coachOpSchema.parse({
        kind: "ease",
        workoutId,
        session: { category: "easy", title: "Easy 5k", durationMinutes: 30, run: { blocks: [{ kind: "distance", value: 5000, intensity: "easy" }] } },
      }),
    ]);
    expect(eased.missed).toEqual([]);
    // The ease's own removal never happened (as if refused): the row holds the earlier version, nothing on its way.
    await a.db
      .delete(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "coach_delete_workout")));
    expect((await detail(a, workoutId)).workout.corosSyncView).toBe("content_stale");
    expect((await detail(a, workoutId)).watchVersion).toEqual({ send: false, why: "cant_rewrite" });

    const res = await request(a, `/api/plan/workouts/${workoutId}/watch-version/send`, "POST");
    expect(res.status).toBe(409);
    const removals = await a.db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "coach_delete_workout")));
    expect(removals).toEqual([]);
  });
});

describe("POST /api/plan/workouts/:id/watch-version/keep", () => {
  it("closes the claim as kept — the line counts down, the row reads synced — and writes nothing to the watch or the session", async () => {
    const a = await easedAndFailed();
    const [before] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    const { value: res, statements, writes } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST"));
    expect(res.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(45);
    for (const sql of writes) expect(sql).toMatch(/^\s*update "(sync_intents|coros_write_jobs)"/i);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(after).toEqual(before);
    const intents = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.resolvedAt).toBeTruthy();
    expect(intents[0]!.payload?.["closedBecause"]).toBe("kept_watch_version");
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
    expect((await detail(a, a.workoutId)).watchVersion).toBeUndefined();
    // The failed rewrite stays as it was: nothing is sent.
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("failed");

    // Idempotent.
    const again = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST"));
    expect(again.value.status).toBe(200);
    expect(again.writes).toEqual([]);
  });

  it("a rewrite still only queued is stopped: nothing more reaches the watch for it", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.corosWriteJobs).set({ status: "queued" }).where(eq(schema.corosWriteJobs.workoutId, a.workoutId));
    const res = await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST");
    expect(res.status).toBe(200);
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("superseded");
    const ran = await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect(ran.executed).toBe(0);
  });

  it("the app's copy stays the app's: an edit made on COROS afterwards does not replace it", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const job = (await rewrites(a, a.workoutId))[0]!;
    const program = a.server.programByIdInPlan((job.payload as { idInPlan: string }).idInPlan)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: 7351 }];
    await readAndImport(a);
    await readAndImport(a);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row!.title).toBe(EASED.title);
    expect(row!.archivedAt).toBeNull();
  });

  it("is the athlete's own: another account's session is not found", async () => {
    const a = await easedAndFailed();
    const other = await makeTestUser(a.db, {});
    const theirs = newId();
    await a.db.insert(schema.plannedWorkouts).values({
      id: theirs,
      userId: other.userId,
      planId: "p",
      sourceWorkoutId: `9:${theirs.slice(0, 4)}`,
      title: "Theirs",
      category: "easy",
      sport: "run",
      originalPlanDate: "2026-11-01",
      lastVerifiedCorosDate: "2026-11-01",
      effectiveDate: "2026-11-01",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1800,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    expect((await request(a, `/api/plan/workouts/${theirs}/watch-version/keep`, "POST")).status).toBe(404);
    expect((await request(a, `/api/plan/workouts/${theirs}/watch-version/send`, "POST")).status).toBe(404);
  });
});
