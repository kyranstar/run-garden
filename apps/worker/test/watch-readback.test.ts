/**
 * THE READ-BACK FOR THE LIVE GATE (Phase 3 Task 11; spec §8; plan Task 12 Step 5).
 *
 * `programReadback` reads COROS directly — never the cached read-now, which single-flights on a 90 s window — and
 * answers only about the row's own stamped program: found on its recorded day or not, its steps (the names, overviews
 * and targets this app wrote), whether each step equals the preview the push was built from, and whether its text
 * fingerprint is the one the push observed. Nothing of any other workout leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch, takeOffWatch } from "../src/services/watch-push.js";
import { programReadback } from "../src/services/watch-readback.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, counting, DAY, makeEnv, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
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

const ctx = () => ({ today: DAY, now: NOON, prefs });

/** Today's session sent and pushed through the lane: on the (mock) watch. */
async function pushed(): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
  const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`));
  expect(job!.status).toBe("verified");
  return { workoutId, buildId };
}

describe("programReadback", () => {
  it("finds the stamped program on its day: every step equal to the preview, the text fingerprint the push observed", async () => {
    const { workoutId, buildId } = await pushed();
    const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const payload = programSessionPushJobSchema.parse(job!.payload);
    const r = await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: server.fetchImpl });
    expect(r.found).toBe(true);
    expect(r.date).toBe(DAY);
    expect(r.steps).toHaveLength(payload.session.steps.length);
    expect(r.matchesPreview).toHaveLength(payload.session.steps.length);
    expect(r.matchesPreview.every(Boolean)).toBe(true);
    expect(r.textFingerprintMatches).toBe(true);
    // Our own strings only: the step names are the ones the push wrote.
    expect(r.steps.map((s) => s.name)).toEqual(payload.session.steps.map((s) => s.name));
  });

  it("reads COROS itself every time — two calls, two schedule reads (never the read-now's cache)", async () => {
    const { workoutId } = await pushed();
    const fetches = counting(server);
    const before = server.counts.scheduleQuery;
    await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: fetches.fetchImpl });
    expect(server.counts.scheduleQuery).toBe(before + 1);
    await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: fetches.fetchImpl });
    expect(server.counts.scheduleQuery).toBe(before + 2);
    expect(fetches.writes()).toBe(0);
  });

  it("a step changed on COROS no longer matches its preview; the text fingerprint no longer matches", async () => {
    const { workoutId, buildId } = await pushed();
    const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const name = programSessionPushJobSchema.parse(job!.payload).name;
    const stored = server.state.schedule.programs!.find((p) => p.name === name)!;
    const step = stored.exercises!.find((e) => e.isGroup !== true && Number(e.exerciseType) !== 0)!;
    step.overview = "changed on the watch";
    const r = await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: server.fetchImpl });
    expect(r.found).toBe(true);
    expect(r.matchesPreview.filter((m) => !m)).toHaveLength(1);
    expect(r.textFingerprintMatches).toBe(false);
  });

  it("taken off (the unpush verified): found false", async () => {
    const { workoutId } = await pushed();
    await takeOffWatch(db, userId, workoutId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const r = await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: server.fetchImpl });
    expect(r).toMatchObject({ found: false, date: null, steps: [], matchesPreview: [] });
  });

  it("never another workout's data: a foreign program on the same day stays out of the answer", async () => {
    const { workoutId } = await pushed();
    const foreign = JSON.parse(JSON.stringify(server.state.schedule.programs![0]!));
    foreign.name = "Someone else's session";
    foreign.idInPlan = "9991";
    for (const e of foreign.exercises ?? []) if (e.isGroup !== true) e.name = "Foreign move";
    server.state.schedule.programs!.push(foreign);
    const r = await programReadback(db, switchOn(), userId, workoutId, { fetchImpl: server.fetchImpl });
    expect(JSON.stringify(r)).not.toContain("Someone else");
    expect(JSON.stringify(r)).not.toContain("Foreign move");
  });
});

describe("GET /api/coros/debug/program-readback/:workoutId", () => {
  const get = async (path: string, env = switchOn()) => {
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    return mountRoutes(db, "/api/coros", corosRoutes).request(`/api/coros/debug/program-readback/${path}`, { headers: { Cookie: cookie } }, env);
  };

  it("answers the read-back for a sent session; 404 for a slot never sent; 404 in fixture mode", async () => {
    const { workoutId } = await pushed();
    vi.stubGlobal("fetch", server.fetchImpl);
    try {
      const res = await get(workoutId);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ found: true, date: DAY });
      expect((await get("slot-never-sent")).status).toBe(404);
      expect((await get(workoutId, makeEnv({ FIXTURE_MODE: "1" }))).status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
