/**
 * WHAT THE ATHLETE CAN DO ABOUT AN EARLIER VERSION ON THE WATCH (the owner, 2026-10-19: "not actionable or
 * removable"). The session's sheet reads what is honestly possible for that row (`GET /api/plan/workouts/:id`'s
 * `watchVersion`): send the app's version — the content rewrite the convergence backfill queues, offered only when
 * one can reach the row, and idempotent — or keep the watch's, which the app then takes at the next COROS read; an
 * app-built session's earlier copy is left as it is instead.
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
import { convergeDivergedContent } from "../src/services/content-converge.js";
import { recordIntent } from "../src/services/sync-intents.js";
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
    // …and with COROS disconnected too, it says so, never "reconnect, then send it from here", which would not be true.
    await bare.db.update(schema.providerConnections).set({ status: "disconnected" });
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

describe("POST /api/plan/workouts/:id/watch-version/send is idempotent (review-S I1)", () => {
  const send = (a: Account & { workoutId: string }) => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/send`, "POST");
  const live = async (a: Account & { workoutId: string }) =>
    (await rewrites(a, a.workoutId)).filter((j) => ["queued", "claimed", "in_progress", "verifying"].includes(j.status));

  it("P1: a second Send is the first — one live job, and the drain runs it", async () => {
    const a = await easedAndFailed();
    expect((await send(a)).status).toBe(200);
    const first = await live(a);
    expect(first).toHaveLength(1);
    const { value: again, writes } = await a.count(() => send(a));
    expect(again.status).toBe(200);
    expect(writes, "nothing planned, nothing superseded").toEqual([]);
    expect((await live(a)).map((j) => [j.id, j.status])).toEqual([[first[0]!.id, "queued"]]);
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    const ran = await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect(ran.executed).toBe(1);
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("verified");
  });

  it("P2: a Send while the rewrite is running leaves it running", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.corosWriteJobs).set({ status: "in_progress" }).where(eq(schema.corosWriteJobs.workoutId, a.workoutId));
    const res = await send(a);
    expect(res.status).toBe(200);
    const jobs = await rewrites(a, a.workoutId);
    expect(jobs.map((j) => j.status)).toEqual(["in_progress"]);
  });

  it("a Send after whatever superseded the rewrite revives it — one live job, and the drain runs it", async () => {
    const a = await easedAndFailed();
    expect((await send(a)).status).toBe(200);
    await a.db.update(schema.corosWriteJobs).set({ status: "superseded" }).where(eq(schema.corosWriteJobs.workoutId, a.workoutId));
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);
    expect((await send(a)).status).toBe(200);
    expect((await live(a)).map((j) => j.status)).toEqual(["queued"]);
    expect(await rewrites(a, a.workoutId)).toHaveLength(1);
    const ran = await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect(ran.executed).toBe(1);
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("verified");
  });
});

describe("POST /api/plan/workouts/:id/watch-version/keep", () => {
  it("the app takes the watch's version: the claim released, the row says so until the next read, which brings it in (P7)", async () => {
    const a = await easedAndFailed();
    const { value: res, statements, writes } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST"));
    expect(res.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(45);
    for (const sql of writes) expect(sql).toMatch(/^\s*update "(sync_intents|coros_write_jobs|planned_workouts)"/i);
    const intents = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.resolvedAt, "released the ordinary way").toBeTruthy();
    expect(intents[0]!.payload).toEqual({ fingerprint: expect.any(String) });
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    // Until the read: never "Synced", never "Older on watch" — the app is taking the watch's version.
    const waiting = (await detail(a, a.workoutId)) as Awaited<ReturnType<typeof detail>> & { workout: { syncAction?: unknown; title: string } };
    expect(waiting.workout.corosSyncView).toBe("taking_watch_copy");
    expect(waiting.workout.syncAction).toEqual({ agent: "app", code: "taking_watch_copy" });
    expect(waiting.watchVersion).toBeUndefined();
    // The failed rewrite stays as it was: nothing is sent.
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("failed");

    await readAndImport(a);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row!.title, "the watch's session").toBe("Threshold 5x5");
    expect(row!.sourceContentFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const after = (await detail(a, a.workoutId)) as Awaited<ReturnType<typeof detail>> & { workout: { title: string } };
    expect(after.workout.corosSyncView).toBe("synced");
    const stages = await a.db.select().from(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, a.workoutId));
    expect(stages.length, "the watch's own steps, not the eased one block").toBeGreaterThan(1);
    // One row, the same row.
    const sameDay = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.effectiveDate, row!.effectiveDate)));
    expect(sameDay.filter((w) => w.archivedAt === null).map((w) => w.id)).toEqual([a.workoutId]);

    // Idempotent: nothing left to keep, nothing written.
    const again = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST"));
    expect(again.value.status).toBe(200);
    expect(again.writes).toEqual([]);
  });

  it("a new change before the read lands is a new earlier version, said as one", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("taking_watch_copy");
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: a.workoutId, kind: "content", source: "coach_ease" });
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("content_stale");
  });

  it("a change of sport is taken cleanly too: the watch's title, steps and sport, in the same row, no copy beside it", async () => {
    const a = await account();
    await readAndImport(a);
    const [row] = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
    const mobility = {
      category: "mobility",
      title: "Hips and calves",
      durationMinutes: 20,
      mobility: { exercises: [{ name: "Calf stretch", sets: 2, holdSeconds: 45 }] },
    };
    const eased = await applyOps(a.db, a.userId, a.prefs, "p-ease-sport", [coachOpSchema.parse({ kind: "ease", workoutId: row!.id, session: mobility })]);
    expect(eased.missed).toEqual([]);
    await a.db.delete(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, row!.id));
    const [easedRow] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(easedRow!.sport).toBe("yoga");
    const ws = { ...a, workoutId: row!.id };
    expect((await detail(ws, row!.id)).workout.corosSyncView).toBe("content_stale");

    expect((await request(ws, `/api/plan/workouts/${row!.id}/watch-version/keep`, "POST")).status).toBe(200);
    await readAndImport(a);
    await readAndImport(a);
    const [taken] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(taken!.title).toBe("Threshold 5x5");
    expect(taken!.sport).toBe("run");
    expect(taken!.structuredJson).toBeNull();
    expect(taken!.archivedAt).toBeNull();
    const sameDay = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.effectiveDate, taken!.effectiveDate)));
    expect(sameDay.filter((w) => w.archivedAt === null).map((w) => w.id)).toEqual([row!.id]);
    expect((await detail(ws, row!.id)).workout.corosSyncView).toBe("synced");
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

  it("nothing of the app's goes over the watch's version it chose — not even the hourly pace heal", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const plan = await convergeDivergedContent(a.db, a.userId, { dryRun: true, workoutIds: [a.workoutId] });
    expect(plan.rows.find((r) => r.workoutId === a.workoutId)?.action ?? "skipped").toBe("skipped");
    // A pace-encoding heal would reach it by a verified write's evidence; the row is skipped all the same.
    await a.db.insert(schema.corosWriteJobs).values({
      id: `${a.workoutId}-old-create`, userId: a.userId, workoutId: a.workoutId, kind: "coach_create_workout", status: "verified",
      expectedContentFingerprint: "x", originalDate: "2026-01-01", destinationDate: "2026-01-01", requestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z",
      payload: { thresholdPaceSecPerKm: THRESHOLD, session: { run: { blocks: [{ kind: "duration", value: 10, intensity: "threshold" }] } } },
    });
    const heal = await convergeDivergedContent(a.db, a.userId, { dryRun: true, only: "pace_encoding_outdated", today: todayInZone(a.prefs.timezone) });
    const healed = heal.rows.find((r) => r.workoutId === a.workoutId);
    expect(healed, "the heal sees it").toBeDefined();
    expect(healed!.action).toBe("skipped");
  });

  it("an app-built session is not kept — no read takes its content from the wire — and nothing is written", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    const { value: res, writes } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "app_built" });
    expect(writes).toEqual([]);
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
    expect((await request(a, `/api/plan/workouts/${theirs}/watch-version/leave`, "POST")).status).toBe(404);
  });
});

describe("POST /api/plan/workouts/:id/watch-version/leave — an app-built session's earlier copy, left as it is", () => {
  it("stops counting it; the row still says the watch has an earlier version, and says it was left", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);
    const [before] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    const { value: res, statements, writes } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/leave`, "POST"));
    expect(res.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(45);
    for (const sql of writes) expect(sql).toMatch(/^\s*update "sync_intents"/i);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(after).toEqual(before);
    const [intent] = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intent!.resolvedAt, "still open: the two still differ").toBeNull();
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    const d = (await detail(a, a.workoutId)) as Awaited<ReturnType<typeof detail>> & { workout: { watchVersionLeft?: boolean } };
    expect(d.workout.corosSyncView, "the pill stays true").toBe("content_stale");
    expect(d.workout.watchVersionLeft).toBe(true);
  });

  it("is for an app-built session only: any other's Keep takes the watch's version", async () => {
    const a = await easedAndFailed();
    const res = await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/leave`, "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_app_built" });
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);
  });

  it("a new change to the session counts again", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/leave`, "POST")).status).toBe(200);
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: a.workoutId, kind: "content", source: "coach_ease" });
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);
  });
});
