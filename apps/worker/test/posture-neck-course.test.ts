/**
 * THE POSTURE AND NECK COURSE THROUGH THE APP'S REAL ROUTES, on its real definition: a second course needs its definition
 * and nothing else. It starts by `POST /api/plans/courses`, places its outlines, writes today's on opening, kept off the watch
 * (its one flag), and reads that way everywhere: the sheet's watch line, its row in the plan, the account's sync line. The
 * mirror owes it nothing and nothing is queued, unless the athlete puts one session on the watch. Mark done counts it once and
 * the garden credits it once, as mobility. It stops as any course does. TRE's sessions still go to the watch as before, and no
 * worker or UI source names either course. Fixed dates under a faked `Date`, so nothing here goes stale. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, type UserPreferences } from "@rg/domain";
import { COURSES, courseDefinition, postureNeckSessionDoc, treSessionDoc } from "@rg/workout";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { hourly } from "../src/index.js";
import { planRoutes } from "../src/routes/plan.js";
import { planRoutes as plansRoutes } from "../src/routes/plans.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { syncRoutes } from "../src/routes/sync.js";
import type { Db } from "../src/services/db.js";
import { buildDayInput } from "../src/services/garden-sync.js";
import { mirrorSweep, queueProvisionalPush } from "../src/services/mirror.js";
import { mirrorIntentId } from "../src/services/mirror-owed.js";
import { bookedSeconds } from "../src/services/session-build.js";
import { courseSessionsDone, slotId } from "../src/services/program-slots.js";
import { activateTmj } from "./doc-workout-fixture.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedCatalog, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, programs, syncIntents } = schema;

vi.setConfig({ testTimeout: 30_000 });

const COURSE = courseDefinition("posture-neck")!;
/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
/** Monday, Wednesday and Friday at 19:30. */
const BODY = { course: COURSE.id, weekdays: [0, 2, 4], time: "19:30" };
const ENV: Env = switchOn();

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  // Nothing here reaches the network: a call that tried would get nothing.
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await activateTmj(db, userId);
  await seedCatalog(db);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const APPS = [
  ["/api/plans", () => mountRoutes(db, "/api/plans", plansRoutes)],
  ["/api/plan/", () => mountRoutes(db, "/api/plan", planRoutes)],
  ["/api/sessions", () => mountRoutes(db, "/api/sessions", sessionRoutes)],
  ["/api/sync", () => mountRoutes(db, "/api/sync", syncRoutes)],
] as const;

/** One request as the signed-in athlete, its waitUntil work included. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const app = APPS.find(([prefix]) => path.startsWith(prefix))![1]();
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
  const res = await app.request(path, { method, headers: { Cookie: cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV, executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Sent until nothing is left: the last answer. */
async function until(method: string, path: string, body?: unknown) {
  for (let i = 0; i < 40; i++) {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (!res.body.more) return res.body;
  }
  throw new Error(`still "more" after 40 requests to ${path}`);
}

/** Started to the end: the plan's id. */
const started = async (body: unknown = BODY): Promise<string> => (await until("POST", "/api/plans/courses", body)).plan.id as string;

const ctx = () => ({ today: MON, now: NOW, prefs });
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const liveOf = (planId: string) => db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)));
const mirrorMark = async (id: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id))))[0];
const jobsOf = (id: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));

/** Today's session, opened as the session sheet opens it. */
async function openToday(planId: string) {
  const id = slotId(planId, MON);
  const opened = await call("GET", `/api/sessions/${id}`);
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { id, opened: opened.body };
}

describe("a start through POST /api/plans/courses, with nothing but the definition", () => {
  it("makes its plan from the definition and places its outlines, named by the plan, booked as the session runs", async () => {
    const p = await started();
    const [plan] = await db.select().from(programs).where(eq(programs.id, p));
    expect(plan).toMatchObject({ kind: "course", status: "active", name: "Posture & neck", purpose: COURSE.purpose, brief: COURSE.brief, disciplines: ["yoga"] });

    // Seven minutes by hand (posture-neck-course.test.ts): the calendar books ten.
    const live = (await liveOf(p)).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    expect(live.map((r) => r.effectiveDate).slice(0, 3)).toEqual([MON, addDays(MON, 2), addDays(MON, 4)]);
    for (const r of live) {
      expect(r).toMatchObject({ origin: "program", title: "Posture & neck", workoutDoc: null, effectiveTime: "19:30", category: "yoga", sport: "yoga", watchOff: false });
      expect([r.fallbackEstimatedDurationSeconds, r.calendarBlockDurationSeconds]).toEqual([420, bookedSeconds(420)]);
    }
    expect(bookedSeconds(420)).toBe(600);
  });

  it("its row in the plan list says the course's own words: no count, since it never ends", async () => {
    const p = await started();
    const { body } = await call("GET", "/api/plans");
    expect(body.plans.find((x: { id: string }) => x.id === p)).toMatchObject({ kind: "course", name: "Posture & neck", course: { after: "A few minutes, off the watch" } });
  });
});

describe("today's session, kept off the watch", () => {
  it("is written on opening as the course's first, kept off by its flag: the sheet says so, and the mirror is owed nothing", async () => {
    const p = await started();
    const { id, opened } = await openToday(p);
    expect(opened).toMatchObject({ origin: "studio", title: "Posture & neck · door openers", watch: { state: "kept_off" } });
    expect(await row(id)).toMatchObject({
      origin: "studio",
      courseSession: 1,
      watchOff: true,
      category: "yoga",
      sport: "yoga",
      fallbackEstimatedDurationSeconds: 420,
      calendarBlockDurationSeconds: 600,
    });
    expect(JSON.parse((await row(id)).workoutDoc!)).toEqual(postureNeckSessionDoc(1));
    expect(await mirrorMark(id)).toBeUndefined();
    expect(await jobsOf(id)).toEqual([]);
  });

  it("its day's build, the sweep and the hourly queue nothing for the watch", async () => {
    const p = await started();
    const { id } = await openToday(p);
    const built = await call("POST", `/api/sessions/${id}/build`, { checks: { tmj: { pre: 1, feelingOff: false } } });
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect(built.body.watch).toEqual({ state: "kept_off" });
    expect(await jobsOf(id)).toEqual([]);

    expect(await mirrorSweep(db, ENV, userId, prefs, ctx(), { cap: 1 })).toMatchObject({ queued: 0, attempted: 0 });
    await hourly(db, ENV);
    expect(await jobsOf(id)).toEqual([]);
    expect(await mirrorMark(id)).toBeUndefined();
    expect((await call("GET", `/api/sessions/${id}`)).body.watch).toEqual({ state: "kept_off" });
  });

  it("reads as off the watch, never as failing to sync: its row's words, and the account's line", async () => {
    const p = await started();
    const { id } = await openToday(p);
    const view = await call("GET", `/api/plan/workouts/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.workout.syncAction).toEqual({ agent: "nobody", code: "kept_off_watch" });
    const line = await call("GET", "/api/sync/status");
    expect(line.status).toBe(200);
    expect(line.body).toMatchObject({ state: "in_sync", issueCount: 0, pendingCount: 0, watchUpdatingCount: 0 });
  });

  it("the athlete can still put this one on the watch: the mirror owes it a copy, and the next is kept off as ever", async () => {
    const p = await started();
    const { id } = await openToday(p);
    const put = await call("POST", `/api/sessions/${id}/put-on-watch`);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.watch.state).not.toBe("kept_off");
    expect((await row(id)).watchOff).toBe(false);
    expect(await mirrorMark(id)).toMatchObject({ resolvedAt: null });
    expect(await queueProvisionalPush(db, ENV, userId, await row(id), ctx())).toBe("queued");
    expect((await jobsOf(id)).map((j) => [j.kind, j.status])).toEqual([["program_session_push", "queued"]]);

    // Wednesday's is written as the course's second, kept off again: the athlete's choice was that one session's.
    vi.setSystemTime(new Date("2026-10-07T19:00:00.000Z"));
    const wed = slotId(p, addDays(MON, 2));
    const opened = await call("GET", `/api/sessions/${wed}`);
    expect(opened.body).toMatchObject({ title: "Posture & neck · door openers", watch: { state: "kept_off" } });
    expect(await row(wed)).toMatchObject({ courseSession: 1, watchOff: true });
  });
});

describe("marked done", () => {
  it("counts once, and the garden credits it once, as mobility; the next is the wall's turn, kept off too", async () => {
    const p = await started();
    const { id } = await openToday(p);
    for (let i = 0; i < 2; i++) {
      const res = await call("POST", `/api/plan/workouts/${id}/mark-done`, { done: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(await row(id)).toMatchObject({ completionState: "completed", sanctionedBy: "athlete_said_done", courseSession: 1, watchOff: true });
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
    const day = await buildDayInput(db, userId, MON, prefs);
    expect(day.completedRuns).toEqual([expect.objectContaining({ workoutId: id, category: "yoga", discipline: "yoga" })]);
    expect(await mirrorMark(id)).toBeUndefined();
    expect(await jobsOf(id)).toEqual([]);

    vi.setSystemTime(new Date("2026-10-07T19:00:00.000Z"));
    const wed = slotId(p, addDays(MON, 2));
    const opened = await call("GET", `/api/sessions/${wed}`);
    expect(opened.body).toMatchObject({ title: "Posture & neck · wall angels", watch: { state: "kept_off" } });
    expect(await row(wed)).toMatchObject({ courseSession: 2, watchOff: true });
    expect(JSON.parse((await row(wed)).workoutDoc!)).toEqual(postureNeckSessionDoc(2));
    expect(await mirrorMark(wed)).toBeUndefined();
  });
});

describe("a stop", () => {
  it("takes its sessions ahead off, the one written today among them, and the plan reads stopped", async () => {
    const p = await started();
    await openToday(p);
    await until("POST", `/api/plans/${p}/stop`);
    expect(await liveOf(p)).toEqual([]);
    expect((await db.select().from(programs).where(eq(programs.id, p)))[0]!.status).toBe("retired");
  });
});

describe("TRE, unchanged", () => {
  it("its session written today goes to the watch as before: kept on, owed a copy, and the copy queued", async () => {
    const p = await started({ ...BODY, course: "tre" });
    const { id, opened } = await openToday(p);
    expect(opened.title).toBe(treSessionDoc(1).title);
    expect(opened.watch.state).not.toBe("kept_off");
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 1, watchOff: false });
    expect(await mirrorMark(id)).toMatchObject({ kind: "mirror", resolvedAt: null });
    expect(await queueProvisionalPush(db, ENV, userId, await row(id), ctx())).toBe("queued");
    expect((await jobsOf(id)).map((j) => [j.kind, j.status])).toEqual([["program_session_push", "queued"]]);
  });
});

describe("no worker or UI source names a course", () => {
  const SOURCES = [fileURLToPath(new URL("../src", import.meta.url)), fileURLToPath(new URL("../../../packages/ui/src", import.meta.url))];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("by its id, its documents' source or its name: the definition's words are the only ones", () => {
    const files = SOURCES.flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${dir}/${f}`),
    );
    expect(files.length).toBeGreaterThan(100);
    const courses = Object.values(COURSES);
    expect(courses.map((c) => c.id)).toEqual(expect.arrayContaining(["tre", "posture-neck"]));
    const named = new RegExp(courses.flatMap((c) => [`\\b${escape(c.id)}\\b`, `${escape(c.id)}-course`, `\\b${escape(c.name)}\\b`]).join("|"), "i");
    expect(files.filter((f) => named.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
