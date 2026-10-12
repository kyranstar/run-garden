/**
 * RETIRING THE OLD GENERATOR'S PLAN ANSWERS WITHIN ONE FREE-PLAN INVOCATION (Stage 2 Task 9, fix round 1; ruling 3-R11).
 *
 * `POST /api/studio/plans/:id/retire`: every session still ahead becomes a queued removal through the push path — a
 * few to a statement — and the removals drain later (the hourly lane, or any drain), as a coach plan's Retire's do. So
 * the request costs the same handful of reads and writes whatever the plan, plus one statement for every few sessions
 * ahead. Measured the way watch-push-budget.test.ts measures Send — every D1 statement and every COROS fetch, waitUntil
 * work included — against a cloud-connected mock COROS, up to the longest plan the generator could make (16 weeks, six
 * sessions a week) retired before its first day. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, makeEnv } from "./watch-push-fixture.js";

const { corosExercises, corosWriteJobs, studioPlanPushes, studioPlans } = schema;

vi.setConfig({ testTimeout: 30_000 });

/** The ceiling: D1 statements + COROS fetches in one invocation (ruling 3-R11). */
const BUDGET = 45;
const SQUAT = "425898928110747648";
/** A Wednesday, mid-afternoon on the West Coast. */
const NOW = "2026-10-14T21:00:00.000Z";

let db: Db;
let userId: string;
let server: MockCorosServer;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db, { corosWritesEnabled: true }));
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

/** The generator's plan from `start` (a Monday), pushed: every session on the watch at its own address. */
async function pushedPlan(start: string, weeks: number, weekdays: number[]): Promise<string> {
  await db.insert(corosExercises).values({ id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() });
  const brief: PlanBrief = {
    goal: "strength",
    durationWeeks: weeks,
    sessionsPerWeek: weekdays.length,
    preferredDays: weekdays,
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate: start,
  };
  const exercise = { originId: SQUAT, name: "Back Squat", sets: 3, reps: 10, weight: { type: "bodyweight" as const }, restSeconds: 60 };
  const plan: LiftingPlan = {
    name: "Autumn Strength",
    brief,
    weeks: Array.from({ length: weeks }, () => ({
      sessions: weekdays.map((weekday) => ({ title: `Full Body ${weekday}`, weekday, exercises: [exercise] })),
    })),
  };
  const planId = newId();
  await db.insert(studioPlans).values({
    id: planId,
    userId,
    brief: brief as unknown as Record<string, unknown>,
    plan: plan as unknown as Record<string, unknown>,
    version: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  let slot = 100;
  for (let week = 0; week < weeks; week++) {
    for (const weekday of weekdays) {
      slot += 1;
      await db.insert(studioPlanPushes).values({
        id: newId(),
        planId,
        planVersion: 1,
        happenDay: addDays(start, week * 7 + weekday - 1),
        sessionTitle: `Full Body ${weekday} — wk ${week + 1}`,
        corosIdInPlan: String(slot),
        corosProgramId: String(slot),
        corosPlanId: "coros-plan",
        sessionFingerprint: "fp",
        status: "verified",
        error: null,
        updatedAt: nowInstant(),
      });
    }
  }
  return planId;
}

/** One invocation: the route and everything it handed to waitUntil, counted together. */
async function retire(planId: string) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await mountRoutes(db, "/api/studio", studioRoutes).request(
    `/api/studio/plans/${planId}/retire`,
    { method: "POST", headers: { Cookie: cookie } },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  return { res, d1: statements, fetches, total: statements + fetches, waitUntil: pending.length };
}

const queuedRemovals = async () =>
  (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).filter((j) => j.kind === "delete_scheduled_workout");

describe("Retire within the budget", () => {
  it("half-way through an eight-week plan (17 sessions ahead)", async () => {
    // Started Mon Sep 28, Mon/Wed/Fri: 24 sessions; Wed Oct 14 and on are ahead.
    const planId = await pushedPlan("2026-09-28", 8, [1, 3, 5]);
    const m = await retire(planId);
    console.info(`[budget] studio retire (17 ahead): ${m.d1} D1 + ${m.fetches} COROS = ${m.total}`);
    expect(m.res.status).toBe(200);
    expect(await m.res.json()).toMatchObject({ ok: true, summary: { deletes: 17 } });
    expect(await queuedRemovals()).toHaveLength(17);
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("the longest plan the generator could make, retired before its first day (96 sessions ahead)", async () => {
    const planId = await pushedPlan("2026-10-19", 16, [1, 2, 3, 4, 5, 6]);
    const m = await retire(planId);
    console.info(`[budget] studio retire (96 ahead): ${m.d1} D1 + ${m.fetches} COROS = ${m.total}`);
    expect(m.res.status).toBe(200);
    expect(await m.res.json()).toMatchObject({ ok: true, summary: { deletes: 96 } });
    expect(await queuedRemovals()).toHaveLength(96);
    expect(m.waitUntil).toBe(0);
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });
});
