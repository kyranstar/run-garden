/**
 * THE COACH NEVER REWRITES OR DELETES AN APP-BUILT SESSION'S COROS COPY (Audit 3-A lane L-4; ruling 3-R13).
 *
 * A program or on-demand row is built from its program: its watch copy changes only by the athlete's Send and Take
 * off (spec §4.5). The coach may move, skip or remove it (each takes a sent copy off, the cleanup of that send), but
 * never ease or adjust it. Three layers, each tested here:
 *  - the op layer: the dossier marks the slot move/skip/remove-only, `validateOps` refuses ease and adjust with the
 *    fatal `app_built_session`, and `applyOps` re-checks at the tap (a proposal stored before the rule);
 *  - the enqueue boundary: `enqueueContentConvergence` refuses the row in both directions (`app_authored`);
 *  - the lane: a coach create or rewrite naming the row (what a pre-fix queue holds) is superseded with no fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, programSessionPushJobSchema, validateOps, type CoachSession, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch, takeOffWatch } from "../src/services/watch-push.js";
import { buildDossier } from "../src/services/coach-context.js";
import { guardrailCtx } from "../src/services/coach-wake.js";
import { applyOps, enqueueContentConvergence } from "../src/services/coach-apply.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, counting, DAY, makeEnv, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, sessionBuilds } = schema;
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
  // The approve route runs the lane in its own waitUntil, through the global fetch.
  vi.stubGlobal("fetch", server.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const programsNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const coachWrites = async () =>
  (await db.select().from(corosWriteJobs)).filter((j) => j.kind === "coach_update_workout" || j.kind === "coach_create_workout" || j.id.includes("-unpush-"));

const EASE_SESSION = { category: "easy", title: "Easy 20", durationMinutes: 20, run: { blocks: [{ kind: "duration", value: 20, intensity: "easy" }] } } as CoachSession;
const DISTANCE_RUN = { category: "easy", title: "Easy 3k", durationMinutes: 20, run: { blocks: [{ kind: "distance", value: 3000, intensity: "easy" }] } } as CoachSession;

/** Today's slot sent and verified on the mock (the switch on). */
async function sentAndVerified() {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
  const push = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`)))[0]!;
  expect(push.status).toBe("verified");
  return { workoutId, buildId, stamp: programSessionPushJobSchema.parse(push.payload).name };
}

async function approve(proposalId: string, ops: unknown[], env = makeEnv()) {
  await db.insert(schema.coachProposals).values({
    id: proposalId, userId, title: "Ease today", evidence: "e", rationale: "r", flags: [], ops: ops as never,
    status: "pending", createdAt: nowInstant(), expiresAt: addDays(DAY, 1),
  });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  const res = await mountRoutes(db, "/api/coach", coachRoutes).request(
    `/api/coach/proposals/${proposalId}/approve`,
    { method: "POST", headers: { Cookie: cookie } },
    env,
    executionCtx as never,
  );
  await Promise.all(pending);
  return res;
}

describe("the op layer: ease and adjust refuse an app-built session", () => {
  it("validateOps raises the fatal app_built_session for an ease and an adjust of a sent program slot", async () => {
    const { workoutId } = await sentAndVerified();
    const gctx = await guardrailCtx(db, userId, prefs, DAY);
    const v = validateOps(
      [
        { kind: "ease", workoutId, session: EASE_SESSION },
        { kind: "adjust", workoutId, durationMinutes: 45 },
      ],
      gctx,
    );
    expect(v.fatal.map((f) => [f.rule, f.opIndex])).toEqual([
      ["app_built_session", 0],
      ["app_built_session", 1],
    ]);
    // Move, skip and remove stay legal: each takes a sent copy off, the cleanup of that send.
    const ok = validateOps(
      [
        { kind: "skip", workoutId, reason: "rest" },
        { kind: "remove", workoutId },
      ],
      gctx,
    );
    expect(ok.fatal.filter((f) => f.rule === "app_built_session")).toEqual([]);
  });

  it("the dossier keeps the handle and marks the slot move, skip or remove only", async () => {
    const { workoutId } = await sentAndVerified();
    const dossier = await buildDossier(db, userId, prefs, DAY);
    const text = dossier.text;
    expect(text).toMatch(new RegExp(`\\[wo:${workoutId}\\][^\\n]*programme session — move, skip or remove only; never ease or adjust`));
  });

  it("a stored ease is re-checked at the tap (switch OFF): nothing changes on the row, nothing is queued, the copy stays", async () => {
    const { workoutId, stamp } = await sentAndVerified();
    const before = await rowOf(db, workoutId);
    const writes = server.counts.scheduleWrites;
    const res = await approve("p-ease", [{ kind: "ease", workoutId, session: EASE_SESSION }], makeEnv());
    expect(res.status).toBe(200);
    const after = await rowOf(db, workoutId);
    expect([after.title, after.sport, after.category]).toEqual([before.title, before.sport, before.category]);
    expect(await coachWrites()).toEqual([]);
    expect(server.counts.scheduleWrites).toBe(writes);
    expect(programsNamed(stamp)).toHaveLength(1);
    // The athlete's own Take off still removes the copy.
    await takeOffWatch(db, userId, workoutId, ctx());
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(programsNamed(stamp)).toHaveLength(0);
  });

  it("applyOps reports a stored ease (into a distance run) and an adjust as missed; the build stays as it was", async () => {
    const { workoutId, buildId } = await sentAndVerified();
    const before = await rowOf(db, workoutId);
    const out = await applyOps(db, userId, prefs, "p-old", [
      { kind: "ease", workoutId, session: DISTANCE_RUN },
      { kind: "adjust", workoutId, durationMinutes: 45 },
    ]);
    expect(out.missed).toHaveLength(2);
    expect(out.updated).toEqual([]);
    const after = await rowOf(db, workoutId);
    expect([after.title, after.calendarBlockDurationSeconds]).toEqual([before.title, before.calendarBlockDurationSeconds]);
    expect(await coachWrites()).toEqual([]);
    const [build] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId));
    expect(build!.lockedAt).not.toBeNull();
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`)))[0]!.status).toBe("verified");
  });
});

describe("the enqueue boundary", () => {
  it("enqueueContentConvergence refuses an app-authored row in both directions", async () => {
    const { workoutId } = await sentAndVerified();
    const row = await rowOf(db, workoutId);
    for (const session of [EASE_SESSION, DISTANCE_RUN]) {
      expect(await enqueueContentConvergence(db, { userId, workout: row, session, now: NOON, corosWritesEnabled: true })).toEqual({
        refused: "app_authored",
      });
    }
    expect(await coachWrites()).toEqual([]);
  });
});

describe("the lane", () => {
  it("supersedes a coach_update_workout or coach_create_workout naming an app-built row, with zero fetches", async () => {
    const { workoutId, stamp } = await sentAndVerified();
    const row = await rowOf(db, workoutId);
    const [corosPlanId, idInPlan] = row.sourceWorkoutId.split(":");
    await db.insert(corosWriteJobs).values([
      {
        id: `${workoutId}-content-x-y`, userId, workoutId, kind: "coach_update_workout", expectedContentFingerprint: "x",
        originalDate: DAY, destinationDate: DAY, requestedAt: NOON, status: "queued", updatedAt: NOON,
        payload: {
          workoutId, happenDay: DAY, name: `Easy 20 — ${DAY}`, recordedName: stamp, idInPlan, programId: row.sourceProgramId, corosPlanId,
          session: EASE_SESSION,
        },
      },
      {
        id: `${workoutId}-push`, userId, workoutId, kind: "coach_create_workout", expectedContentFingerprint: "x",
        originalDate: DAY, destinationDate: DAY, requestedAt: `${DAY}T19:00:01.000Z`, status: "queued", updatedAt: NOON,
        payload: { workoutId, happenDay: DAY, name: `Easy 20 — ${DAY}`, session: EASE_SESSION },
      },
    ]);
    const fetches = counting(server);
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    const jobs = await db.select().from(corosWriteJobs);
    expect(jobs.filter((j) => j.kind !== "program_session_push").map((j) => [j.kind, j.status])).toEqual([
      ["coach_update_workout", "superseded"],
      ["coach_create_workout", "superseded"],
    ]);
    expect(fetches.calls()).toBe(0);
    expect(programsNamed(stamp)).toHaveLength(1);
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(row.sourceWorkoutId);
  });
});
