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
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, todayInZone, type CoachSession, type UserPreferences } from "@rg/domain";
import { normalizeCorosSchedule } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { computeSyncStatus } from "../src/services/sync-status.js";
import { convergeDivergedContent } from "../src/services/content-converge.js";
import { answerBodyCheck, undoBodyCheck } from "../src/services/body-check.js";
import { recordIntent } from "../src/services/sync-intents.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** The mock account's "Threshold 5x5" as the import blocks it out on the calendar: the watch's own length. */
const AFTER_READ_BLOCK_SECONDS = 4740; // 79 min
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

const request = async (a: Account, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Response> =>
  mountRoutes(a.db, "/api/plan", planRoutes).request(
    path,
    {
      method,
      headers: { Cookie: a.cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    makeEnv(),
  );

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

  it("an app-built session is mirrored — the mirror replaces its copy — never a rewrite from here", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await detail(a, a.workoutId)).watchVersion).toEqual({ send: false, why: "mirrored" });
    // Whatever else is true: the reason is the app-built session's, never a setting that would not change it.
    await a.db.update(schema.providerConnections).set({ status: "disconnected" });
    expect((await detail(a, a.workoutId)).watchVersion).toEqual({ send: false, why: "mirrored" });
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
    // The failed rewrite is stopped with the claim it served: nothing is sent, and no Retry can send it (A1).
    expect((await rewrites(a, a.workoutId))[0]!.status).toBe("superseded");
    // Nothing of the app's copy goes before the read brings the watch's in: a structure the app held is still there.
    const exercises = { exercises: [{ name: "Calf raise", sets: 2, reps: 12 }] };
    await a.db.update(schema.plannedWorkouts).set({ structuredJson: exercises }).where(eq(schema.plannedWorkouts.id, a.workoutId));

    await readAndImport(a);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row!.title, "the watch's session").toBe("Threshold 5x5");
    expect(row!.structuredJson, "dropped as the watch's copy is taken").toBeNull();
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

  it("a new claim before the read lands is a new earlier version, said as one", async () => {
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
    // Until the read, the app's own movements are still there to read (review-S2: nothing lost if no read comes).
    const [kept] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(kept!.structuredJson).not.toBeNull();
    expect(((await detail(ws, row!.id)).workout as { exercises?: unknown[] }).exercises?.length).toBeGreaterThan(0);
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

  it("K3b: a move made before the read goes through — on what the watch holds, no note — and the read still takes the watch's copy", async () => {
    const a = await easedAndFailed();
    const [before] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const toDate = addDays(before!.effectiveDate, 1);
    // The route drains what it queued in the request's background, against COROS: the mock account here.
    vi.stubGlobal("fetch", a.server.fetchImpl);
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/move`, "POST", { toDate, toTime: "07:00" })).status).toBe(200);
    const [move] = await a.db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.workoutId, a.workoutId), eq(schema.corosWriteJobs.kind, "move_scheduled_workout")));
    expect(move!.expectedContentFingerprint, "what the watch holds, never the mark").toBe(before!.sourceContentFingerprint);

    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    const moves = await a.db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.workoutId, a.workoutId), eq(schema.corosWriteJobs.kind, "move_scheduled_workout")));
    expect(moves.map((j) => j.status)).toEqual(["verified"]);
    expect(await a.db.select().from(schema.syncNotes).where(eq(schema.syncNotes.workoutId, a.workoutId)), "no 'COROS had moved it'").toEqual([]);
    const [moved] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(moved!.lastVerifiedCorosDate).toBe(toDate);
    expect(moved!.sourceContentFingerprint.startsWith("take-watch-copy:"), "the verified move keeps the mark").toBe(true);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("taking_watch_copy");

    await readAndImport(a);
    const [taken] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(taken!.title, "the watch's session, on its new day").toBe("Threshold 5x5");
    expect(taken!.effectiveDate).toBe(toDate);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
  });

  it("the import drops a structure only for a row that chose the watch's version: any other keeps what it had, as always", async () => {
    const a = await account();
    await readAndImport(a);
    const [row] = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
    const exercises = { exercises: [{ name: "Calf raise", sets: 2, reps: 12 }] };
    await a.db.update(schema.plannedWorkouts).set({ structuredJson: exercises }).where(eq(schema.plannedWorkouts.id, row!.id));
    // Edited on COROS: rule 7 takes the new content, and leaves the row's structure as the import always has.
    const program = a.server.programByIdInPlan(row!.sourceIdInPlan!)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: 5113 }];
    await readAndImport(a);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(after!.sourceContentFingerprint).not.toBe(row!.sourceContentFingerprint);
    expect(after!.structuredJson).toEqual(exercises);
  });

  it("the row says it is taking the watch's version only while it is still to run: done, or its day gone, it says what it is", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("taking_watch_copy");
    await a.db.update(schema.plannedWorkouts).set({ completionState: "completed" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
    const past = addDays(todayInZone(a.prefs.timezone), -3);
    await a.db
      .update(schema.plannedWorkouts)
      .set({ completionState: "scheduled", effectiveDate: past, lastVerifiedCorosDate: past })
      .where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
  });

  it("a new change after Keep is the app's claim again: the mark lifted, its rewrite queued on what the watch holds, and Send offered if it fails (K4)", async () => {
    const a = await easedAndFailed();
    const [before] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const again = { category: "easy", title: "Easy 25", durationMinutes: 25, run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] } };
    const out = await applyOps(a.db, a.userId, a.prefs, "p-ease-again", [coachOpSchema.parse({ kind: "ease", workoutId: a.workoutId, session: again })]);
    expect(out.missed).toEqual([]);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row!.sourceContentFingerprint, "the mark lifted: what the watch holds").toBe(before!.sourceContentFingerprint);
    const queued = (await rewrites(a, a.workoutId)).find((j) => j.status === "queued");
    expect(queued, "the ease's own rewrite, proven on what the watch holds").toBeDefined();
    expect((queued!.payload as { importedFingerprint?: string }).importedFingerprint).toBe(before!.sourceContentFingerprint);
    await a.db.update(schema.corosWriteJobs).set({ status: "failed" }).where(eq(schema.corosWriteJobs.id, queued!.id));
    const d = await detail(a, a.workoutId);
    expect(d.workout.corosSyncView).toBe("content_stale");
    expect(d.watchVersion).toEqual({ send: true });
  });

  it("U1: Keep, a body check's ease, then Undo before its rewrite runs — the mark comes back, and the next read still takes the watch's copy", async () => {
    const a = await easedAndFailed();
    const [before] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    // The read-now after Keep never landed (COROS away): today's check eases the run, then the athlete undoes it.
    const ctx = { today: before!.effectiveDate, now: nowInstant(), prefs: a.prefs };
    await answerBodyCheck(a.db, a.userId, a.workoutId, { feel: "heavy" }, ctx);
    const [eased] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(eased!.sourceContentFingerprint, "the ease lifted the mark").toBe(before!.sourceContentFingerprint);
    expect((await rewrites(a, a.workoutId)).some((j) => j.status === "queued")).toBe(true);

    await undoBodyCheck(a.db, a.userId, a.workoutId, ctx);
    const [back] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(back!.title).toBe(EASED.title);
    expect(back!.sourceContentFingerprint, "the mark is back, on what the watch holds").toBe(`take-watch-copy:${before!.sourceContentFingerprint}`);
    const open = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content"), isNull(schema.syncIntents.resolvedAt)));
    expect(open).toEqual([]);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("taking_watch_copy");

    await readAndImport(a);
    const [taken] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(taken!.title, "the watch's session").toBe("Threshold 5x5");
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
  });

  it("A4/L1: a length alone after Keep is refused in plain words — nothing written, no claim, no rewrite — and the read brings the watch's copy in at its own length", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const [kept] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    const jobsBefore = (await rewrites(a, a.workoutId)).map((j) => [j.id, j.status]);
    // Review L1: the next read takes the watch's copy whole, so a length written now would be undone without a word
    // while its card said "only the plan's length changes". Refused until then — a change proposed before the Keep too.
    const out = await applyOps(a.db, a.userId, a.prefs, "p-adjust", [coachOpSchema.parse({ kind: "adjust", workoutId: a.workoutId, durationMinutes: 25 })]);
    expect(out.missed).toEqual(["this session follows the watch's version until the next sync — change it after that"]);
    expect(out.updated).toEqual([]);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row, "nothing written: its length, its mark").toEqual(kept);
    const open = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content"), isNull(schema.syncIntents.resolvedAt)));
    expect(open, "no claim of the app's").toEqual([]);
    expect((await rewrites(a, a.workoutId)).map((j) => [j.id, j.status]), "nothing queued for the watch").toEqual(jobsBefore);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("taking_watch_copy");

    // The read takes the watch's copy, as the athlete chose: the eased session never reaches the watch, and the length
    // is the watch's own — never the 25 min a length alone would have set and the read silently undone.
    const writes = a.server.counts.scheduleWrites;
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect(a.server.counts.scheduleWrites).toBe(writes);
    await readAndImport(a);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(after!.title).toBe("Threshold 5x5");
    const wire = normalizeCorosSchedule(a.server.state.schedule).workouts.find((w) => w.title === "Threshold 5x5")!;
    expect(after!.sourceEstimatedDurationSeconds, "the watch's own length").toBe(wire.estimatedDurationSeconds);
    expect(after!.calendarBlockDurationSeconds).toBe(AFTER_READ_BLOCK_SECONDS);
    expect(normalizeCorosSchedule(a.server.state.schedule).workouts.map((w) => w.title)).not.toContain(EASED.title);
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");

    // After the read the session is the watch's own copy, unmarked: a length is the plan's again.
    const again = await applyOps(a.db, a.userId, a.prefs, "p-adjust-after", [coachOpSchema.parse({ kind: "adjust", workoutId: a.workoutId, durationMinutes: 25 })]);
    expect(again.missed).toEqual([]);
    const [retimed] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(retimed!.calendarBlockDurationSeconds).toBe(1500);
  });

  it("a re-time of a session that never chose the watch's version is what it always was: no claim, no rewrite", async () => {
    const a = await account();
    await readAndImport(a);
    const [row] = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
    const out = await applyOps(a.db, a.userId, a.prefs, "p-adjust-plain", [coachOpSchema.parse({ kind: "adjust", workoutId: row!.id, durationMinutes: 25 })]);
    expect(out.missed).toEqual([]);
    expect(await a.db.select().from(schema.syncIntents).where(eq(schema.syncIntents.targetId, row!.id))).toEqual([]);
    expect(await rewrites(a, row!.id)).toEqual([]);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(after!.sourceContentFingerprint).toBe(row!.sourceContentFingerprint);
    expect(after!.calendarBlockDurationSeconds, "the plan's length, as before (review L1 refuses only a row taking the watch's version)").toBe(1500);
  });

  it("A1: Keep after a failed rewrite clears the sync line, and Retry can't put the app's version back over the watch's", async () => {
    const a = await easedAndFailed();
    const issues = (await computeSyncStatus(a.db, a.userId, a.prefs)).issueCount;
    expect(issues, "the failed rewrite is the line's issue before Keep").toBe(1);
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const kept = await computeSyncStatus(a.db, a.userId, a.prefs);
    expect(kept.issueCount, "the rewrite the athlete chose against is no issue").toBe(0);
    expect(kept.state).not.toBe("sync_issue");

    await readAndImport(a);
    const retry = await mountRoutes(a.db, "/api/sync", syncRoutes).request("/api/sync/retry", { method: "POST", headers: { Cookie: a.cookie } }, makeEnv());
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { coachRetried: number }).coachRetried).toBe(0);
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect((await rewrites(a, a.workoutId)).map((j) => j.status)).toEqual(["superseded"]);
    const titles = normalizeCorosSchedule(a.server.state.schedule).workouts.map((w) => w.title);
    expect(titles, "the watch keeps its own version").not.toContain(EASED.title);

    await readAndImport(a);
    const [row] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(row!.title).toBe("Threshold 5x5");
    expect((await detail(a, a.workoutId)).workout.corosSyncView).toBe("synced");
  });

  it("A1 backstop: a rewrite that reaches the lane for a row taking the watch's version is stopped there, before any wire call", async () => {
    const a = await easedAndFailed();
    expect((await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/keep`, "POST")).status).toBe(200);
    const [marked] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    // Revived behind Keep's back (a Retry of a rewrite a Keep before this fix left failed): queued again.
    await a.db
      .update(schema.corosWriteJobs)
      .set({ status: "queued", lastErrorCategory: null })
      .where(and(eq(schema.corosWriteJobs.workoutId, a.workoutId), eq(schema.corosWriteJobs.kind, "coach_update_workout")));
    const writesBefore = a.server.counts.scheduleWrites;
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
    expect((await rewrites(a, a.workoutId)).map((j) => j.status)).toEqual(["superseded"]);
    expect(a.server.counts.scheduleWrites, "nothing written to COROS").toBe(writesBefore);
    const [after] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(after!.sourceContentFingerprint, "the mark stays: the read still takes the watch's copy").toBe(marked!.sourceContentFingerprint);
    await readAndImport(a);
    const [taken] = await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect(taken!.title).toBe("Threshold 5x5");
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

describe("POST /api/plan/workouts/:id/watch-version/leave — retired: the mirror replaces an app-built session's copy", () => {
  it("an app-built session: 409 gone, nothing written; its claim stays as it was, and the account line never counts it", async () => {
    const a = await easedAndFailed();
    await a.db.update(schema.plannedWorkouts).set({ origin: "program" }).where(eq(schema.plannedWorkouts.id, a.workoutId));
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount, "an app row's claim is not the account line's").toBe(0);
    const { value: res, statements, writes } = await a.count(() => request(a, `/api/plan/workouts/${a.workoutId}/watch-version/leave`, "POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "gone" });
    expect(writes).toEqual([]);
    expect(statements).toBeLessThanOrEqual(45);
    const [intent] = await a.db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, a.workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intent!.resolvedAt).toBeNull();
    expect(intent!.payload, "never marked left").not.toHaveProperty("left");
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(0);
  });

  it("any other session's is refused as before (not_app_built): its Keep takes the watch's version, and the line still counts it", async () => {
    const a = await easedAndFailed();
    const res = await request(a, `/api/plan/workouts/${a.workoutId}/watch-version/leave`, "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_app_built" });
    expect((await computeSyncStatus(a.db, a.userId, a.prefs)).contentStaleCount).toBe(1);
  });
});
