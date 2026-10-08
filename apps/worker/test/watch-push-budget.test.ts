/**
 * THE WORKERS FREE BUDGET OF EVERY PHASE 3 REQUEST (Audit 3-A lane L-3; ruling 3-R11).
 *
 * The account is on the Workers Free plan: an invocation gets 50 subrequests, and D1 queries may count against it.
 * So every request on the Phase 3 paths stays at or under 45 combined D1 statements + COROS fetches, everything it
 * hands to `waitUntil` included (one invocation). Send and Take off run no lane of their own: they validate, lock and
 * enqueue, and the client then calls the targeted drain — a new request, its own invocation — which runs at most one
 * of this user's queued pushes or unpushes. The cron lane keeps its own caps (watch-push-lane.test.ts).
 *
 * Each figure is printed (`[budget]`) for the audit report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, DAY, makeEnv, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** The ceiling: D1 statements + COROS fetches in one invocation (ruling 3-R11). */
const BUDGET = 45;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    return server.fetchImpl(input, init);
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];

/** One invocation: the route and everything it handed to waitUntil, counted together. */
async function invoke(method: "GET" | "POST", path: string, body?: unknown, env: Env = switchOn()) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    env,
    executionCtx as never,
  );
  await Promise.all(pending);
  return { res, d1: statements, fetches, total: statements + fetches, waitUntil: pending.length };
}

async function builtSlot(id?: string) {
  const workoutId = await seedSlot(db, userId, programId, DAY, id);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  return { workoutId, buildId: built.build!.buildId };
}

const report = (what: string, m: { d1: number; fetches: number; total: number }) =>
  console.info(`[budget] ${what}: ${m.d1} D1 + ${m.fetches} COROS = ${m.total}`);

const digestOf = async (workoutId: string) => ((await (await invoke("GET", `${workoutId}/watch-preview`)).res.json()) as { digest: string }).digest;

describe("Send", () => {
  it("validates, locks and enqueues within the budget, and runs no lane of its own", async () => {
    const { workoutId, buildId } = await builtSlot();
    const m = await invoke("POST", `${workoutId}/send-to-watch`, { buildId, digest: await digestOf(workoutId) });
    report("Send", m);
    expect(m.res.status).toBe(200);
    expect(await m.res.json()).toMatchObject({ locked: true, watch: { state: "sending" } });
    expect(m.waitUntil).toBe(0);
    expect(m.fetches).toBe(0);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });
});

describe("the preview", () => {
  it("before Send, and of a sent build: each within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    const fresh = await invoke("GET", `${workoutId}/watch-preview`);
    report("preview (not sent)", fresh);
    expect(fresh.res.status).toBe(200);
    expect(fresh.total).toBeLessThanOrEqual(BUDGET);
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    const sent = await invoke("GET", `${workoutId}/watch-preview`);
    report("preview (sent)", sent);
    expect(sent.res.status).toBe(200);
    expect(sent.total).toBeLessThanOrEqual(BUDGET);
  });

  it("the digest path: a failed push's preview (what Retry sends), Retry with its digest, and a stale_preview refusal", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const failed = await invoke("GET", `${workoutId}/watch-preview`);
    report("preview (failed push: what Retry sends)", failed);
    expect(failed.res.status).toBe(200);
    expect(failed.total).toBeLessThanOrEqual(BUDGET);
    const stale = await invoke("POST", `${workoutId}/send-to-watch`, { buildId, digest: "0".repeat(64) });
    report("Send refused stale_preview (with the fresh preview)", stale);
    expect(stale.res.status).toBe(409);
    expect(stale.total).toBeLessThanOrEqual(BUDGET);
    const { digest } = (await failed.res.json()) as { digest: string };
    const retry = await invoke("POST", `${workoutId}/send-to-watch`, { buildId, digest });
    report("Retry (with the failed push's preview digest)", retry);
    expect(retry.res.status).toBe(200);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(retry.total).toBeLessThanOrEqual(BUDGET);
  });
});

describe("Take off", () => {
  it("of a verified push: queues the unpush within the budget, and runs no lane of its own", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    const m = await invoke("POST", `${workoutId}/take-off-watch`, {});
    report("Take off", m);
    expect(m.res.status).toBe(200);
    expect(m.waitUntil).toBe(0);
    expect(m.fetches).toBe(0);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });
});

describe("POST /api/sessions/watch/drain", () => {
  it("404 while the switch is off", async () => {
    const m = await invoke("POST", "watch/drain", {}, makeEnv());
    expect(m.res.status).toBe(404);
  });

  it("runs this user's one queued push — typical path — within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    const m = await invoke("POST", "watch/drain", {});
    report("drain, one push (typical)", m);
    expect(m.res.status).toBe(200);
    expect(await m.res.json()).toEqual({ executed: 1 });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("one push whose read-backs all miss (the worst path), with the token expired, stays within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    server.addSilentlyFails = true;
    await db
      .update(schema.providerConnections)
      .set({ accessTokenExpiresAt: "2026-10-01T00:00:00.000Z" })
      .where(eq(schema.providerConnections.userId, userId));
    const m = await invoke("POST", "watch/drain", {});
    report("drain, one push (worst: token expired, read-backs miss)", m);
    expect(m.res.status).toBe(200);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("runs this user's one queued unpush within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    await invoke("POST", `${workoutId}/take-off-watch`, {});
    const m = await invoke("POST", "watch/drain", {});
    report("drain, one unpush", m);
    expect(m.res.status).toBe(200);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("runs at most one job, and never a coach job queued before it", async () => {
    // A coach create queued first (the oldest): the drain leaves it to the lanes that run coach work.
    await db.insert(schema.plannedWorkouts).values({
      id: "coach-1", userId, planId: "coach-adhoc", sourceWorkoutId: "coach-1", title: "Easy 30", category: "easy", sport: "run",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "07:00", completionState: "scheduled",
      corosSyncState: "calendar_only", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, createdAt: NOON, updatedAt: NOON,
    });
    await db.insert(corosWriteJobs).values({
      id: "coach-1-push", userId, workoutId: "coach-1", kind: "coach_create_workout", expectedContentFingerprint: "fp",
      originalDate: DAY, destinationDate: DAY, requestedAt: "2026-10-09T00:00:00.000Z", status: "queued", updatedAt: NOON,
      payload: { workoutId: "coach-1", happenDay: DAY, name: `Easy 30 — ${DAY}`, session: { category: "easy", title: "Easy 30", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } } },
    });
    const a = await builtSlot();
    const b = await builtSlot(`slot-${programId}-${DAY}-b`);
    await sendToWatch(db, switchOn(), userId, a.workoutId, a.buildId, ctx());
    await sendToWatch(db, switchOn(), userId, b.workoutId, b.buildId, ctx());
    const m = await invoke("POST", "watch/drain", {});
    expect(await m.res.json()).toEqual({ executed: 1 });
    expect((await jobOf("coach-1-push"))!.status).toBe("queued");
    expect([(await jobOf(`push:${a.buildId}`))!.status, (await jobOf(`push:${b.buildId}`))!.status]).toEqual(["verified", "queued"]);
  });

  it("never runs another user's job", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    const other = await makeTestUser(db, { corosWritesEnabled: true });
    const cookie = `${SESSION_COOKIE}=${await createSession(db, other.userId, "test")}`;
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
      "/api/sessions/watch/drain",
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" },
      switchOn(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ executed: 0 });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
  });
});
