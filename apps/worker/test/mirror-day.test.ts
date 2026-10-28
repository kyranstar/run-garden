/**
 * ON THE DAY (the watch mirrors the plan §3.3; owner §10.1; builder check A3, A9, M1).
 *
 * When the day's build is made and its pre-check answered, the copy on the watch follows it: the app compares the
 * watch steps the day's build would push with the steps the copy holds (never a digest, never COROS's fingerprints) —
 *  - the same → a D1 hand-over, no COROS write: the day's build locked, `push:<dayBuild>` verified under the provisional
 *    copy's stamp (its day, what the push observed, a rename), the provisional record's marker cleared, its push settled;
 *  - different → the copy's delete and the day build's push (two jobs), the day build locked;
 *  - blocked (the day's reading closes a move no alternate stands in for) → the copy stays, nothing queued.
 * Every later change on the day (a new reading, a revision) builds again past the watch's lock and replaces the copy
 * again. An engine slot has no provisional copy: its day build, once checked, is pushed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { programSessionPushJobSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
// First of the worker's modules: the mirror binds the mocked watch-push below (the import cycle session-build ↔ mirror ↔
// watch-push would otherwise hand it the original while the mock is still being made).
import { mirrorOnDayBuild, queueProvisionalPush } from "../src/services/mirror.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { buildSession, recordCheck, sentBuildIdOf, type BuildCtx, type CheckAnswer } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { connectMock, counting, DAY, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
/** A session whose copy's payload throws while the mirror makes it (as a failed read would): `pushPayloadFor`. */
const broken = vi.hoisted(() => ({ payload: null as string | null }));
vi.mock("../src/services/watch-push.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/watch-push.js")>();
  const pushPayloadFor: typeof real.pushPayloadFor = async (...args) => {
    if (broken.payload !== null && args[2].id === broken.payload) throw new Error("D1_ERROR: the catalog read failed");
    return real.pushPayloadFor(...args);
  };
  return { ...real, pushPayloadFor };
});

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let statements: string[] = [];
let seq = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  broken.payload = null;
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
});
afterEach(() => {
  vi.useRealTimers();
});

/** An instant `ms` after NOON. */
const after = (ms: number): string => new Date(Date.parse(NOON) + ms).toISOString();
/** The request's context — with the worker's env, as the build route passes it (the mirror runs only then). */
const ctx = (now = NOON): BuildCtx => ({ today: DAY, now, prefs, env: switchOn() });
const calm: Record<string, CheckAnswer> = { tmj: { pre: 2, feelingOff: false } };
/** A flare: the day's check closes the jump (since 2026-10-23, a flare or feeling off closes one). */
const flare: Record<string, CheckAnswer> = { tmj: { pre: 6, feelingOff: true } };

/** A Studio workout of today as the Studio stores one: its document at revision 1, an outline until it is built. */
async function seedDocRow(doc: WorkoutDoc = calmDoc()): Promise<string> {
  const id = `studio-${(seq += 1)}`;
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
    originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "studio",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
    createdAt: NOON, updatedAt: NOON,
  });
  return id;
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const jobsOf = (workoutId: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId)).orderBy(corosWriteJobs.requestedAt);
const buildOf = async (id: string) => (await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, id)))[0]!;
const recordOf = async (workoutId: string) =>
  (await db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, workoutId), lt(sessionBuilds.version, 0))).orderBy(sessionBuilds.version))[0]!;
const pushPayload = async (buildId: string) => programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
const ourPrograms = (title: string) => (server.state.schedule.programs ?? []).filter((p) => String(p.name).startsWith(title));
const movesOf = (steps: ReadonlyArray<{ kind: string; exerciseId: string | null }>) => [...new Set(steps.filter((s) => s.kind !== "rest").map((s) => s.exerciseId))];

/** The provisional copy queued (the drain's, Task 3) — and, unless `run` is false, driven to the watch by the lane. */
async function provisionalCopy(id: string, run = true): Promise<{ recordId: string; name: string }> {
  expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), { today: DAY, now: NOON, prefs })).toBe("queued");
  const record = await recordOf(id);
  if (run) {
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${record.id}`))!.status).toBe("verified");
  }
  return { recordId: record.id, name: (await pushPayload(record.id)).name };
}

/** The day's build as the sheet makes it (the build route: the env passed, so the mirror follows it). */
const build = (id: string, checks?: Record<string, CheckAnswer>, now = NOON) =>
  buildSession(db, userId, id, checks ? { checks } : {}, ctx(now));

/** A session route as the app calls it (`env`: the switch on), counted as one invocation: its D1 and its fetches. */
async function route(method: "POST", path: string, body: unknown, now = NOON) {
  vi.setSystemTime(new Date(now));
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const lane = counting(server);
  vi.stubGlobal("fetch", lane.fetchImpl);
  statements = [];
  try {
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
      `/api/sessions/${path}`,
      { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      switchOn(),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any>, d1: statements.length, fetches: lane.calls() };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("the day's build of a document workout whose provisional copy is on the watch", () => {
  it("the same steps: handed over in D1 — the day build locked, a verified push:<day> under the copy's stamp, the provisional push settled — and no COROS write", async () => {
    const id = await seedDocRow();
    const { recordId, name } = await provisionalCopy(id);
    const provisional = await jobOf(`push:${recordId}`);
    const observed = programSessionPushJobSchema.parse(provisional!.payload).observed;
    expect(observed).toBeDefined();

    const day = (await build(id, calm)).build!;
    expect(day.version).toBeGreaterThan(0);
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    const handed = await jobOf(`push:${day.buildId}`);
    expect(handed).toMatchObject({ kind: "program_session_push", status: "verified", workoutId: id, originalDate: DAY, destinationDate: DAY });
    const payload = await pushPayload(day.buildId);
    expect(payload).toMatchObject({ buildId: day.buildId, happenDay: DAY, name, observed, fromDocRev: 1 });
    expect(payload.provisional).toBeUndefined();
    // The provisional record is no longer the copy on the watch: its marker cleared, its push settled.
    expect((await buildOf(recordId)).payload).not.toHaveProperty("kind");
    expect((await jobOf(`push:${recordId}`))!.status).toBe("superseded");
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
    // Nothing queued: a drain finds nothing to do and fetches nothing; the watch holds the one copy, under its stamp.
    expect((await jobsOf(id)).filter((j) => j.status === "queued")).toEqual([]);
    const lane = counting(server);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: lane.fetchImpl });
    expect(lane.calls()).toBe(0);
    expect(ourPrograms("Hips and back").map((p) => p.name)).toEqual([name]);
    // Built again with nothing changed: the copy is current.
    expect((await build(id)).build!.buildId).toBe(day.buildId);
    expect(await jobsOf(id)).toHaveLength(2);
  });

  it("the hand-over itself: at most 5 statements, none of them a COROS fetch", async () => {
    const id = await seedDocRow();
    const { recordId } = await provisionalCopy(id);
    // The day build made with no env: the mirror did not run.
    const made = (await buildSession(db, userId, id, { checks: calm }, { today: DAY, now: NOON, prefs })).build!;
    const dayBuild = await buildOf(made.buildId);
    expect(dayBuild.lockedAt).toBeNull();
    const row = await rowOf(db, id);
    // Any fetch at all (COROS's or another) is counted: the hand-over makes none.
    const lane = counting(server);
    vi.stubGlobal("fetch", lane.fetchImpl);
    statements = [];
    const answer = await mirrorOnDayBuild(db, switchOn(), userId, row, dayBuild, ctx(), {
      profiles: ["tmj"], inputsHash: dayBuild.inputsHash, version: dayBuild.engineVersion,
    }).finally(() => vi.unstubAllGlobals());
    console.info(`[budget] the day's hand-over: ${statements.length} D1 (${statements.filter(isWrite).length} writes)`);
    expect(answer).toBe("handed_over");
    expect(statements.length).toBeLessThanOrEqual(5);
    expect(lane.calls()).toBe(0);
    expect((await jobOf(`push:${recordId}`))!.status).toBe("superseded");
  });

  it("different steps (a gated swap): the copy's delete and the day build's push are queued, the day build locked", async () => {
    const id = await seedDocRow(landingsDoc());
    const { recordId, name } = await provisionalCopy(id);
    const day = (await build(id, flare)).build!;
    expect(day.fromDoc!.swaps).toHaveLength(1);
    expect(movesOf(day.steps)).toEqual(["tempoSquat", "bwSplitSquat"]);
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    expect((await jobsOf(id)).map((j) => [j.id, j.status])).toEqual([
      [`push:${recordId}`, "verified"],
      [`unpush:${recordId}`, "queued"],
      [`push:${day.buildId}`, "queued"],
    ]);
    expect((await jobOf(`unpush:${recordId}`))!.payload).toMatchObject({ workoutId: id, happenDay: DAY, name });
    const payload = await pushPayload(day.buildId);
    // The old copy still holds its stamp until its delete verifies: the new one takes the day's next.
    expect(payload).toMatchObject({ buildId: day.buildId, happenDay: DAY, name: `${name} (2)`, fromDocRev: 1 });
    expect(payload.provisional).toBeUndefined();
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
  });

  it("blocked (no alternate stands in): the copy stays, nothing is queued, nothing locked", async () => {
    const id = await seedDocRow(landingsDoc({ alternates: false }));
    const { recordId } = await provisionalCopy(id);
    const day = (await build(id, flare)).build!;
    expect(day.fromDoc!.blocked).not.toEqual([]);
    expect((await buildOf(day.buildId)).lockedAt).toBeNull();
    expect((await jobsOf(id)).map((j) => [j.id, j.status])).toEqual([[`push:${recordId}`, "verified"]]);
    expect(await sentBuildIdOf(db, id)).toBe(recordId);
  });

  it("the day build made before the provisional push ran (Review Focus 2): that push is superseded and the day build pushed — no delete", async () => {
    const id = await seedDocRow();
    const { recordId, name } = await provisionalCopy(id, false);
    expect(name).toBe(`Hips and back — ${DAY}`);
    const day = (await build(id, calm)).build!;
    expect((await jobOf(`push:${recordId}`))!.status).toBe("superseded");
    expect(await jobOf(`unpush:${recordId}`)).toBeUndefined();
    expect((await buildOf(recordId)).payload).not.toHaveProperty("kind");
    expect(await jobOf(`push:${day.buildId}`)).toMatchObject({ status: "queued" });
    // The push that never ran held its stamp for nothing: the day build takes it — no " (2)" beside a copy not there.
    expect((await pushPayload(day.buildId)).name).toBe(name);
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
    // Driven through the lane: the day's build is the one copy on the watch.
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${day.buildId}`))!.status).toBe("verified");
    expect(ourPrograms("Hips and back")).toHaveLength(1);
  });

  it("the check unanswered: skipped:precheck — nothing queued, nothing locked, the provisional copy stays", async () => {
    const id = await seedDocRow();
    const { recordId } = await provisionalCopy(id);
    const day = (await build(id)).build!;
    expect(day.version).toBeGreaterThan(0);
    expect((await buildOf(day.buildId)).lockedAt).toBeNull();
    expect((await jobsOf(id)).map((j) => [j.id, j.status])).toEqual([[`push:${recordId}`, "verified"]]);
    expect(await sentBuildIdOf(db, id)).toBe(recordId);
    expect(
      await mirrorOnDayBuild(db, switchOn(), userId, await rowOf(db, id), await buildOf(day.buildId), ctx(), {
        profiles: ["tmj"], inputsHash: (await buildOf(day.buildId)).inputsHash, version: (await buildOf(day.buildId)).engineVersion,
      }),
    ).toBe("skipped:precheck");
  });
});

describe("every later change on the day (owner §10.1)", () => {
  it("a new reading builds again past the watch's lock and replaces the copy — and again: two jobs each time, one copy at the end", async () => {
    const id = await seedDocRow(landingsDoc());
    const { recordId } = await provisionalCopy(id);
    // Calm: the same steps as the provisional copy — handed over.
    const first = (await build(id, calm)).build!;
    expect(movesOf(first.steps)).toEqual(["snapDown", "bwSplitSquat"]);
    expect((await jobOf(`push:${first.buildId}`))!.status).toBe("verified");
    expect((await jobOf(`push:${recordId}`))!.status).toBe("superseded");

    // The jaw flares: a new build of the day, though the first is locked for the watch — and it is replaced.
    const second = await build(id, flare, after(60_000));
    expect(second.build!.version).toBeGreaterThan(first.version);
    expect(movesOf(second.build!.steps)).toEqual(["tempoSquat", "bwSplitSquat"]);
    expect(second.locked).toBe(true);
    expect((await buildOf(second.build!.buildId)).lockedAt).toBe(after(60_000));
    expect(await jobOf(`unpush:${first.buildId}`)).toMatchObject({ status: "queued" });
    expect(await jobOf(`push:${second.build!.buildId}`)).toMatchObject({ status: "queued" });
    expect(await sentBuildIdOf(db, id)).toBe(second.build!.buildId);
    vi.setSystemTime(new Date(after(120_000)));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`unpush:${first.buildId}`))!.status).toBe("verified");
    expect((await jobOf(`push:${second.build!.buildId}`))!.status).toBe("verified");
    expect(ourPrograms("Legs and landings").map((p) => p.name)).toEqual([(await pushPayload(second.build!.buildId)).name]);

    // It eases again: replaced again — the delete and the push, two jobs.
    const third = await build(id, calm, after(180_000));
    expect(movesOf(third.build!.steps)).toEqual(["snapDown", "bwSplitSquat"]);
    const sinceSecond = (await jobsOf(id)).filter((j) => j.requestedAt === after(180_000));
    expect(sinceSecond.map((j) => j.id)).toEqual([`unpush:${second.build!.buildId}`, `push:${third.build!.buildId}`]);
    expect(await sentBuildIdOf(db, id)).toBe(third.build!.buildId);
    vi.setSystemTime(new Date(after(240_000)));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(ourPrograms("Legs and landings").map((p) => p.name)).toEqual([(await pushPayload(third.build!.buildId)).name]);
  });

  it("a later build whose steps are the same: the sent lock moves to it in D1 (A9) — the copy's stamp kept, nothing queued, no fetch", async () => {
    const id = await seedDocRow();
    const { name } = await provisionalCopy(id);
    const first = (await build(id, calm)).build!;
    const observed = (await pushPayload(first.buildId)).observed;
    expect(observed).toBeDefined();
    // Another reading that closes nothing of a calm workout: a new build, the same steps.
    const later = await route("POST", `${id}/build`, { checks: { tmj: { pre: 3, feelingOff: false } } }, after(60_000));
    expect(later.status).toBe(200);
    expect(later.fetches).toBe(0);
    const second = later.body.build as { buildId: string; version: number };
    expect(second.buildId).not.toBe(first.buildId);
    expect(second.version).toBeGreaterThan(first.version);
    // The sheet and Start now hold the newest build, which is the one on the watch.
    expect(later.body).toMatchObject({ locked: true, watch: { state: "on_watch" } });
    expect((await buildOf(second.buildId)).lockedAt).toBe(after(60_000));
    expect((await buildOf(first.buildId)).lockedAt).toBeNull();
    expect(await jobOf(`push:${second.buildId}`)).toMatchObject({ status: "verified" });
    expect(await pushPayload(second.buildId)).toMatchObject({ buildId: second.buildId, name, observed, fromDocRev: 1 });
    expect((await jobOf(`push:${first.buildId}`))!.status).toBe("superseded");
    expect((await jobsOf(id)).filter((j) => j.status === "queued")).toEqual([]);
    expect(await sentBuildIdOf(db, id)).toBe(second.buildId);
    expect(ourPrograms("Hips and back").map((p) => p.name)).toEqual([name]);
  });
});

describe("an engine slot on its day", () => {
  it("built and checked: its day build is pushed (nothing to delete) and locked; unchecked, nothing", async () => {
    const unchecked = await seedSlot(db, userId, programId, DAY, "slot-unchecked");
    const b0 = (await build(unchecked)).build!;
    expect(await jobsOf(unchecked)).toEqual([]);
    expect((await buildOf(b0.buildId)).lockedAt).toBeNull();

    const id = await seedSlot(db, userId, programId, DAY);
    const day = (await build(id, calm)).build!;
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    expect((await jobsOf(id)).map((j) => [j.id, j.status])).toEqual([[`push:${day.buildId}`, "queued"]]);
    const payload = await pushPayload(day.buildId);
    expect(payload).toMatchObject({ buildId: day.buildId, happenDay: DAY });
    expect(payload.provisional).toBeUndefined();
    expect(payload.fromDocRev).toBeUndefined();
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
  });
});

describe("the build request that moves the watch (Workers Free: ≤ 45 statements + fetches a request)", () => {
  /** POST …/build as the sheet sends it — the route, its env, its watch state — counted as one invocation. */
  async function buildRoute(id: string, checks: Record<string, CheckAnswer>, now = NOON) {
    const res = await route("POST", `${id}/build`, { checks }, now);
    expect(res.status).toBe(200);
    return res;
  }
  const report = (what: string, m: { d1: number; fetches: number }) => {
    console.info(`[budget] POST …/build, ${what}: ${m.d1} D1 + ${m.fetches} COROS`);
    expect(m.d1 + m.fetches).toBeLessThanOrEqual(45);
    expect(m.fetches).toBe(0);
  };

  it("a hand-over, a replacement, a later change replaced, an engine slot pushed: each within the budget, the watch state answered", async () => {
    const same = await seedDocRow();
    await provisionalCopy(same);
    // Both provisional copies before the day's first check: once it is answered, a session of today is sent none (M1).
    const swapped = await seedDocRow(landingsDoc());
    await provisionalCopy(swapped);
    const handed = await buildRoute(same, calm);
    report("the hand-over", handed);
    expect(handed.body.watch).toMatchObject({ state: "on_watch" });

    const replaced = await buildRoute(swapped, flare);
    report("a replacement", replaced);
    expect(replaced.body.watch).toMatchObject({ state: "sending" });

    // The replacement lands; then the jaw eases — the copy on the watch is replaced again: its delete and the push.
    vi.setSystemTime(new Date(after(30_000)));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${replaced.body.build.buildId}`))!.status).toBe("verified");
    const later = await buildRoute(swapped, calm, after(60_000));
    report("a later change on the day, replaced", later);
    expect(await jobOf(`unpush:${replaced.body.build.buildId}`)).toMatchObject({ status: "queued" });
    expect(await jobOf(`push:${later.body.build.buildId}`)).toMatchObject({ status: "queued" });
    expect(later.body.watch).toMatchObject({ state: "sending" });

    const slot = await seedSlot(db, userId, programId, DAY);
    const pushed = await buildRoute(slot, calm, after(120_000));
    report("an engine slot pushed", pushed);
    expect(pushed.body.watch).toMatchObject({ state: "sending" });
  });

  it("Start on a build the day's check has moved on from: the fresh build replaces the copy — 409 stale, within the budget", async () => {
    const id = await seedDocRow(landingsDoc());
    const { recordId } = await provisionalCopy(id);
    // Built before the check was answered: nothing moved on the watch.
    const unanswered = (await build(id)).build!;
    expect(await jobsOf(id)).toHaveLength(1);
    // The jaw flares (the Today chip), and Start is asked of the build the sheet showed.
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: after(1_000) });
    vi.setSystemTime(new Date(after(2_000)));
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    statements = [];
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
      `/api/sessions/${id}/start`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ buildId: unanswered.buildId }) },
      switchOn(),
    );
    console.info(`[budget] POST …/start, stale — the fresh build replaces the copy: ${statements.length} D1`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; session: { build: { buildId: string; steps: Array<{ kind: string; exerciseId: string | null }> }; locked: boolean; watch: { state: string } } };
    expect(body.error).toBe("stale");
    expect(movesOf(body.session.build.steps)).toEqual(["tempoSquat", "bwSplitSquat"]);
    expect(body.session).toMatchObject({ locked: true, watch: { state: "sending" } });
    expect(await jobOf(`unpush:${recordId}`)).toMatchObject({ status: "queued" });
    expect(await jobOf(`push:${body.session.build.buildId}`)).toMatchObject({ status: "queued" });
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("what the watch's lock still holds (the switch and the athlete's writes on)", () => {
  it("a STARTED session: a build is refused 409 locked, the started build kept", async () => {
    const id = await seedDocRow();
    await provisionalCopy(id);
    const day = (await build(id, calm)).build!;
    const started = await route("POST", `${id}/start`, { buildId: day.buildId }, after(1_000));
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ contentState: "started", locked: true });
    const again = await route("POST", `${id}/build`, { checks: flare }, after(2_000));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "locked", session: { build: { buildId: day.buildId } } });
    expect((await jobsOf(id)).filter((j) => j.status === "queued")).toEqual([]);
  });

  it("a sent session with the athlete's COROS writes OFF: a build is refused 409 locked — nothing could replace the copy", async () => {
    const id = await seedDocRow(landingsDoc());
    await provisionalCopy(id);
    const day = (await build(id, calm)).build!;
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: false });
    const again = await route("POST", `${id}/build`, { checks: flare }, after(1_000));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "locked", session: { build: { buildId: day.buildId } } });
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
  });
});

describe("a mirror that throws", () => {
  it("leaves the build request 200 with the build stored — logged, nothing locked or queued — and the copy follows on the next build", async () => {
    const id = await seedDocRow(landingsDoc());
    const { recordId } = await provisionalCopy(id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    broken.payload = id;
    const res = await route("POST", `${id}/build`, { checks: flare });
    expect(res.status).toBe(200);
    const made = res.body.build as { buildId: string; version: number };
    expect(made.version).toBeGreaterThan(0);
    expect((await buildOf(made.buildId)).lockedAt).toBeNull();
    expect((await jobsOf(id)).map((j) => [j.id, j.status])).toEqual([[`push:${recordId}`, "verified"]]);
    expect(logged.mock.calls.some((c) => String(c[0]).includes(id) && String(c[0]).includes("the catalog read failed"))).toBe(true);
    // Opened again, the build found current: the mirror runs again, and this time replaces the copy.
    broken.payload = null;
    logged.mockRestore();
    const again = await route("POST", `${id}/build`, {}, after(1_000));
    expect(again.status).toBe(200);
    expect(again.body.build.buildId).toBe(made.buildId);
    expect(await jobOf(`unpush:${recordId}`)).toMatchObject({ status: "queued" });
    expect(await jobOf(`push:${made.buildId}`)).toMatchObject({ status: "queued" });
  });
});

describe("Send", () => {
  it("stamps the document revision on a day build's push (the current-copy test keys on it)", async () => {
    const id = await seedDocRow();
    const made = (await buildSession(db, userId, id, { checks: calm }, { today: DAY, now: NOON, prefs })).build!;
    await sendToWatch(db, switchOn(), userId, id, made.buildId, { today: DAY, now: NOON, prefs });
    expect(await pushPayload(made.buildId)).toMatchObject({ buildId: made.buildId, fromDocRev: 1 });
  });
});
