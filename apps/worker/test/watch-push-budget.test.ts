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
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
// The mirror before the rest (the watch-push mock below: session-build ↔ mirror ↔ watch-push is a cycle).
import { markMirrorOwed, queueProvisionalPush } from "../src/services/mirror.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, DAY, makeEnv, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
/** A session whose copy's push throws as it is written (as a failed D1 write would): the sweep's write phase propagates. */
const broken = vi.hoisted(() => ({ write: null as string | null }));
vi.mock("../src/services/watch-push.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/watch-push.js")>();
  const queuePushJob: typeof real.queuePushJob = async (...args) => {
    if (broken.write !== null && args[2].id === broken.write) throw new Error("D1_ERROR: the write failed");
    return real.queuePushJob(...args);
  };
  return { ...real, queuePushJob };
});

/** The ceiling: D1 statements + COROS fetches in one invocation (ruling 3-R11). */
const BUDGET = 45;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let statements = 0;
let fetches = 0;
/** COROS's schedule writes failing at the network (a short outage): the lane re-queues the job for another try. */
let outage = false;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  broken.write = null;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  outage = false;
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (outage && url.pathname === "/training/schedule/update") throw new TypeError("fetch failed");
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

  it("of a copy left on the watch (its unpush neutralised by a restore): requeues it within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    await invoke("POST", `${workoutId}/take-off-watch`, {});
    await db.update(corosWriteJobs).set({ status: "restored" }).where(eq(corosWriteJobs.id, `unpush:${buildId}`));
    const m = await invoke("POST", `${workoutId}/take-off-watch`, {});
    report("Take off (a copy left on the watch)", m);
    expect(m.res.status).toBe(200);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });
});

describe("Keep off / Put on (the watch mirrors the plan §3.6)", () => {
  it("Keep off a verified copy, then Put on: each within the budget, and neither runs a lane of its own", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    const off = await invoke("POST", `${workoutId}/keep-off-watch`, {});
    report("Keep off (a verified copy)", off);
    expect(off.res.status).toBe(200);
    expect(off.waitUntil).toBe(0);
    expect(off.fetches).toBe(0);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(off.total).toBeLessThanOrEqual(BUDGET);
    const on = await invoke("POST", `${workoutId}/put-on-watch`, {});
    report("Put on", on);
    expect(on.res.status).toBe(200);
    expect(on.waitUntil).toBe(0);
    expect(on.fetches).toBe(0);
    expect(on.total).toBeLessThanOrEqual(BUDGET);
  });

  it("Send after Keep off (the push never ran): watch_off cleared before the push is queued — one statement more, within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    expect((await invoke("POST", `${workoutId}/keep-off-watch`, {})).res.status).toBe(200);
    const m = await invoke("POST", `${workoutId}/send-to-watch`, { buildId, digest: await digestOf(workoutId) });
    report("Send (a session kept off)", m);
    expect(m.res.status).toBe(200);
    expect(m.fetches).toBe(0);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
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
    expect(await m.res.json()).toEqual({ ran: true, pending: 0 });
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
    // One ran; the other push is what is left — the coach job is no watch job, so it is not counted.
    expect(await m.res.json()).toEqual({ ran: true, pending: 1 });
    expect((await jobOf("coach-1-push"))!.status).toBe("queued");
    expect([(await jobOf(`push:${a.buildId}`))!.status, (await jobOf(`push:${b.buildId}`))!.status]).toEqual(["verified", "queued"]);
  });

  it("a job re-queued after a COROS blip answers retried: true (the client's chain stops on it) — a push and a delete alike, within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    outage = true;
    const push = await invoke("POST", "watch/drain", {});
    report("drain, one push re-queued after a blip", push);
    expect(push.res.status).toBe(200);
    expect(await push.res.json()).toEqual({ ran: true, pending: 1, retried: true });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(push.total).toBeLessThanOrEqual(BUDGET);
    outage = false;
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 0 });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");

    await invoke("POST", `${workoutId}/keep-off-watch`, {});
    outage = true;
    const del = await invoke("POST", "watch/drain", {});
    report("drain, one delete re-queued after a blip", del);
    expect(await del.res.json()).toEqual({ ran: true, pending: 1, retried: true });
    expect(del.total).toBeLessThanOrEqual(BUDGET);
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 1, retried: true });
    // The executor's third try fails it for good: nothing re-queued, so no `retried` (the sweep's ladder takes it from here).
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 0 });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
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
    expect(await res.json()).toEqual({ ran: false, pending: 0 });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
  });
});

describe("POST /api/sessions/watch/drain — one watch job a request, and what is left (the watch mirrors the plan §3.7, A5)", () => {
  let seq = 0;
  /** A Studio workout as the Studio stores one: its document at revision 1, an outline until its day. */
  async function seedDocRow(date: string, doc: WorkoutDoc = calmDoc()): Promise<string> {
    const id = `studio-${date}-${(seq += 1)}`;
    await db.insert(schema.plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "studio",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
      createdAt: NOON, updatedAt: NOON,
    });
    return id;
  }
  /** Far more work steps than the watch holds: remembered too long for its revision and day. */
  const longDoc = (): WorkoutDoc =>
    workoutDocSchema.parse({
      ...calmDoc(),
      title: "Very long",
      parts: [{ purpose: "main", format: "straight", items: Array.from({ length: 11 }, (_, i) => ({ kind: "exercise", libraryId: ["bridge", "deadBug"][i % 2], dose: { sets: 20, reps: 5, restSec: 10 } })) }],
    });
  const queueCopy = async (id: string) => expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
  const pushesOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).filter((j) => j.kind === "program_session_push");
  const recordsOf = (id: string) => db.select().from(schema.sessionBuilds).where(and(eq(schema.sessionBuilds.workoutId, id), lt(schema.sessionBuilds.version, 0)));
  const queuedCount = async () => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).filter((j) => j.status === "queued").length;

  it("drain answers pending=N and runs one: provisional pushes and an adopted copy's delete are watch jobs; a coach job and an address-path delete are not", async () => {
    const a = await seedDocRow(addDays(DAY, 2));
    const b = await seedDocRow(addDays(DAY, 3));
    await queueCopy(a);
    await queueCopy(b);
    // b's push queued after a's (the claim takes the oldest first).
    await db.update(corosWriteJobs).set({ requestedAt: "2026-10-09T19:30:00.000Z" }).where(eq(corosWriteJobs.id, (await pushesOf(b))[0]!.id));
    const later = "2026-10-09T20:00:00.000Z";
    const del = (id: string, workoutId: string) => ({
      id, userId, workoutId, kind: "coach_delete_workout", expectedContentFingerprint: "", originalDate: addDays(DAY, 4), destinationDate: addDays(DAY, 4),
      payload: { workoutId, happenDay: addDays(DAY, 4), name: "Old copy", idInPlan: "7", programId: "7", corosPlanId: "900" }, requestedAt: later, status: "queued", updatedAt: later,
    });
    await db.insert(corosWriteJobs).values([del(`${a}-unpush-copy`, a), del(`${b}-unpush`, b)]);
    await db.insert(corosWriteJobs).values({
      id: "coach-2-push", userId, workoutId: b, kind: "coach_create_workout", expectedContentFingerprint: "fp", originalDate: DAY, destinationDate: DAY,
      requestedAt: later, status: "queued", updatedAt: later, payload: { workoutId: b, happenDay: DAY, name: "Easy", session: { category: "easy", title: "Easy", durationMinutes: 30 } },
    });
    expect(await queuedCount()).toBe(5);

    const m = await invoke("POST", "watch/drain", {});
    report("drain, one provisional push (pending counted)", m);
    expect(m.res.status).toBe(200);
    // Ran one (the oldest: a's push); left: b's push and a's held copy's delete — the coach job and `-unpush` are not the drain's.
    expect(await m.res.json()).toEqual({ ran: true, pending: 2 });
    expect([...(await pushesOf(a)), ...(await pushesOf(b))].map((j) => j.status)).toEqual(["verified", "queued"]);
    expect(await queuedCount()).toBe(4);
    expect(m.total).toBeLessThanOrEqual(BUDGET);

    // The next runs b's push, then the held copy's delete (`<id>-unpush-copy`, a watch job the drain claims): then none.
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 1 });
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 0 });
    expect((await jobOf(`${a}-unpush-copy`))!.status).not.toBe("queued");
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: false, pending: 0 });
    expect((await jobOf(`${b}-unpush`))!.status).toBe("queued");
    expect((await jobOf("coach-2-push"))!.status).toBe("queued");
  });

  it("two mirror jobs never run in one request: an owed session's record (the sweep's one step) is the request's job — the queued push waits for the next", async () => {
    const queuedFirst = await seedDocRow(addDays(DAY, 3));
    await queueCopy(queuedFirst);
    const owed = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, owed, NOON);

    const swept = await invoke("POST", "watch/drain", {});
    report("drain, the sweep's one record (an owed session)", swept);
    expect(swept.res.status).toBe(200);
    expect(await swept.res.json()).toEqual({ ran: true, pending: 2 });
    expect(swept.fetches).toBe(0);
    expect(await recordsOf(owed)).toHaveLength(1);
    expect((await pushesOf(queuedFirst)).map((j) => j.status)).toEqual(["queued"]);
    expect(swept.total).toBeLessThanOrEqual(BUDGET);

    const ran = await invoke("POST", "watch/drain", {});
    report("drain, one push (nothing owed: the mirror's one read first)", ran);
    expect(await ran.res.json()).toEqual({ ran: true, pending: 1 });
    expect(ran.total).toBeLessThanOrEqual(BUDGET);
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 0 });
    expect([...(await pushesOf(owed)), ...(await pushesOf(queuedFirst))].map((j) => j.status)).toEqual(["verified", "verified"]);
  });

  it("a sweep with nothing to make never holds the drain up: a push waiting out its backoff — the queued push still runs, within the budget", async () => {
    const failing = await seedDocRow(addDays(DAY, 1));
    await queueCopy(failing);
    const [failed] = await pushesOf(failing);
    await db.update(corosWriteJobs).set({ status: "failed", updatedAt: NOON }).where(eq(corosWriteJobs.id, failed!.id));
    const next = await seedDocRow(addDays(DAY, 2));
    await queueCopy(next);

    const m = await invoke("POST", "watch/drain", {});
    report("drain, one push after a sweep with nothing to make (the worst path)", m);
    expect(await m.res.json()).toEqual({ ran: true, pending: 0 });
    expect((await pushesOf(next)).map((j) => j.status)).toEqual(["verified"]);
    expect((await pushesOf(failing)).map((j) => j.status)).toEqual(["failed"]);
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("a sweep that throws while writing: 200 {ran: false} — nothing drained in that request (its room may be spent)", async () => {
    const waiting = await seedDocRow(addDays(DAY, 3));
    await queueCopy(waiting);
    const owed = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, owed, NOON);
    broken.write = owed;

    const m = await invoke("POST", "watch/drain", {});
    report("drain, the sweep throwing at its last write (nothing drained)", m);
    expect(m.res.status).toBe(200);
    expect(await m.res.json()).toEqual({ ran: false, pending: 1 });
    expect(m.fetches).toBe(0);
    expect((await pushesOf(waiting)).map((j) => j.status)).toEqual(["queued"]);
    expect(await pushesOf(owed)).toEqual([]);
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("a session too long for the watch is judged once (the request's job), then the drain runs", async () => {
    await seedDocRow(addDays(DAY, 1), longDoc());
    const next = await seedDocRow(addDays(DAY, 2));
    await queueCopy(next);
    const judged = await invoke("POST", "watch/drain", {});
    report("drain, the sweep judging a session too long", judged);
    expect(await judged.res.json()).toEqual({ ran: true, pending: 1 });
    expect(judged.total).toBeLessThanOrEqual(BUDGET);
    expect(await (await invoke("POST", "watch/drain", {})).res.json()).toEqual({ ran: true, pending: 0 });
    expect((await pushesOf(next)).map((j) => j.status)).toEqual(["verified"]);
  });
});

/**
 * THE WATCH LINE AND RETRY (the watch mirrors the plan §3.9, M6). The watch state every session response carries reads
 * the row's watch jobs on their way in ONE statement before anything else (kept off reads none); Retry of a failed
 * provisional push re-queues that push in one UPDATE and runs no lane; Retry of a day build's push is Send's Retry.
 */
describe("the watch line and Retry (the watch mirrors the plan §3.9)", () => {
  async function docRowAhead(id: string, date = addDays(DAY, 2)): Promise<string> {
    const doc = calmDoc();
    await db.insert(schema.plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "studio",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
      createdAt: NOON, updatedAt: NOON,
    });
    return id;
  }
  const pushOfRow = async (workoutId: string) =>
    (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, "program_session_push"))))[0]!;

  it("watchStateOf, statement by statement: kept off 0; a job on its way 1; a copy on the watch 4; owed ahead 4 (the sweep's memory: has it given up?)", async () => {
    const { watchStateOf } = await import("../src/services/watch-push.js");
    const { loadSession } = await import("../src/services/session-build.js");
    const stateOf = async (id: string) => {
      const row = await rowOf(db, id);
      const session = await loadSession(db, userId, id, DAY);
      statements = 0;
      const state = await watchStateOf(db, switchOn(), userId, row, session, prefs);
      return { state, statements };
    };
    const owed = await docRowAhead("studio-owed");
    const owedState = await stateOf(owed);
    console.info(`[budget] watchStateOf, owed ahead (nothing on the watch): ${owedState.statements} D1`);
    expect(owedState).toEqual({ state: { state: "updating" }, statements: 4 });

    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, owed), ctx())).toBe("queued");
    expect(await stateOf(owed)).toEqual({ state: { state: "sending" }, statements: 1 });

    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await pushOfRow(owed)).status).toBe("verified");
    const on = await stateOf(owed);
    console.info(`[budget] watchStateOf, a copy on the watch: ${on.statements} D1`);
    expect(on).toEqual({ state: { state: "on_watch" }, statements: 4 });

    await db.update(schema.plannedWorkouts).set({ watchOff: true }).where(eq(schema.plannedWorkouts.id, owed));
    expect(await stateOf(owed)).toEqual({ state: { state: "kept_off" }, statements: 0 });
  });

  it("Retry of a failed provisional push: within the budget, one UPDATE re-queues it, no lane of its own", async () => {
    const id = await docRowAhead("studio-retry");
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    const push = await pushOfRow(id);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, push.id));
    const m = await invoke("POST", `${id}/retry-watch`, {});
    report("Retry (a failed provisional push)", m);
    expect(m.res.status).toBe(200);
    expect(m.fetches).toBe(0);
    expect(m.waitUntil).toBe(0);
    expect((await jobOf(push.id))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("Retry of today's failed provisional push — today's reading checked (the profiles, the checks, the snapshot): within the budget", async () => {
    const id = await docRowAhead("studio-retry-today", DAY);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    const push = await pushOfRow(id);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, push.id));
    const m = await invoke("POST", `${id}/retry-watch`, {});
    report("Retry (today's failed provisional push, the reading checked)", m);
    expect(m.res.status).toBe(200);
    expect(m.fetches).toBe(0);
    expect((await jobOf(push.id))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });

  it("Retry of a failed day build's push (Send's Retry): within the budget", async () => {
    const { workoutId, buildId } = await builtSlot();
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const m = await invoke("POST", `${workoutId}/retry-watch`, {});
    report("Retry (a failed day build's push)", m);
    expect(m.res.status).toBe(200);
    expect(m.fetches).toBe(0);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(m.total).toBeLessThanOrEqual(BUDGET);
  });
});
