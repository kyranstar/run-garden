/**
 * Moving or removing a SENT programme session stays within the free plan's per-request budget (re-review 3-B NEW-1,
 * ruling 3-R11). The routes ran the whole cloud lane in their own invocation — 46 for a move, 62 for a remove, 81 for
 * a move with two coach jobs queued ahead (D1 statements + COROS fetches) — so a programme row's watch copy now comes
 * off in a request of its own: the route queues the take-off and answers `watchDrain`, and the client's targeted drain
 * runs it. A run or coach row keeps its in-request lane, unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { slotId } from "../src/services/program-slots.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { buildToday, connectMock, DAY, NOON, seedCatalog, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, programs } = schema;

const BUDGET = 45;
const PROGRAM = "prog-move-budget-0001";
const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training" };

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: MockCorosServer;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  await db.insert(programs).values({
    id: PROGRAM, userId, kind: "adaptive", name: "Strength program", status: "active", disciplines: ["strength", "yoga"],
    startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: NOON, updatedAt: NOON, archivedAt: null,
  });
  server = mockCorosServer();
  await connectMock(db, userId, server);
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const apps = () => ({ sessions: mountRoutes(db, "/api/sessions", sessionRoutes), plan: mountRoutes(db, "/api/plan", planRoutes) });

/** One request, its waitUntil work included: status, JSON and the D1 statements + COROS fetches it cost. */
async function invoke(app: "sessions" | "plan", method: string, path: string, body?: unknown, env: Env = switchOn()) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await apps()[app].request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    env,
    executionCtx as never,
  );
  await Promise.all(pending);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null, total: statements + fetches };
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];

/** Today's programme slot, built, sent and on the watch; its build id and the copy's stamp. */
async function sentSlot(): Promise<{ workoutId: string; buildId: string; stamp: string }> {
  const workoutId = slotId(PROGRAM, DAY);
  await db.insert(plannedWorkouts).values({
    id: workoutId, userId, planId: PROGRAM, sourceWorkoutId: workoutId, title: "Strength program", category: "strength", sport: "strength",
    originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
  });
  const buildId = (await buildToday(db, userId, prefs, workoutId)).build!.buildId;
  const { digest } = (await invoke("sessions", "GET", `/api/sessions/${workoutId}/watch-preview`)).json as { digest: string };
  expect((await invoke("sessions", "POST", `/api/sessions/${workoutId}/send-to-watch`, { buildId, digest })).status).toBe(200);
  await invoke("sessions", "POST", "/api/sessions/watch/drain", {});
  expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  const stamp = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name;
  return { workoutId, buildId, stamp };
}

const copiesNamed = (stamp: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === stamp).length;

describe("moving or removing a sent programme session (3-R11, re-review 3-B NEW-1)", () => {
  it("a move queues the take-off and answers watchDrain within 45; the drain takes the copy off within 45", async () => {
    const { workoutId, buildId, stamp } = await sentSlot();
    expect(copiesNamed(stamp)).toBe(1);

    const mv = await invoke("plan", "POST", `/api/plan/workouts/${workoutId}/move`, { toDate: TOMORROW, toTime: "18:00" });
    expect(mv.status).toBe(200);
    expect(mv.json?.watchDrain).toBe(true);
    expect(mv.total).toBeLessThanOrEqual(BUDGET);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(copiesNamed(stamp)).toBe(1);

    const drain = await invoke("sessions", "POST", "/api/sessions/watch/drain", {});
    expect(drain.total).toBeLessThanOrEqual(BUDGET);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(stamp)).toBe(0);
  });

  it("a remove queues the take-off and answers watchDrain within 45; the drain takes the copy off within 45", async () => {
    const { workoutId, buildId, stamp } = await sentSlot();

    const rm = await invoke("plan", "POST", `/api/plan/workouts/${workoutId}/remove`, {});
    expect(rm.status).toBe(200);
    expect(rm.json?.watchDrain).toBe(true);
    expect(rm.total).toBeLessThanOrEqual(BUDGET);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");

    const drain = await invoke("sessions", "POST", "/api/sessions/watch/drain", {});
    expect(drain.total).toBeLessThanOrEqual(BUDGET);
    expect(copiesNamed(stamp)).toBe(0);
  });

  it("with the switch off, a move answers no watchDrain (the in-request lane runs, as before Phase 3)", async () => {
    const { workoutId } = await sentSlot();
    const mv = await invoke("plan", "POST", `/api/plan/workouts/${workoutId}/move`, { toDate: TOMORROW, toTime: "18:00" }, switchOn({ WATCH_PUSH_ENABLED: undefined }));
    expect(mv.status).toBe(200);
    expect(mv.json?.watchDrain).toBeUndefined();
  });

  it("a run's move keeps its in-request lane and answers no watchDrain", async () => {
    const runId = "run-move-budget-1";
    await db.insert(plannedWorkouts).values({
      id: runId, userId, planId: "tp-1", sourceWorkoutId: runId, title: "Easy run", category: "easy", sport: "run",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "07:00", sourceContentFingerprint: "x",
      calendarBlockDurationSeconds: 1800, corosSyncState: "calendar_only", completionState: "scheduled", createdAt: NOON, updatedAt: NOON,
    });
    const mv = await invoke("plan", "POST", `/api/plan/workouts/${runId}/move`, { toDate: TOMORROW, toTime: "07:00" });
    expect(mv.status).toBe(200);
    expect(mv.json?.watchDrain).toBeUndefined();
  });
});
