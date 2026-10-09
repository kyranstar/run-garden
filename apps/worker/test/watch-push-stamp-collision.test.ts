/**
 * ONE STAMP PER COPY, WHATEVER THE ORDER (Audit 3-A lane L-1; ruling 3-R12; Review Focus 1).
 *
 * The program lane and the coach lane choose stamps with one chooser: a stamp is unique per day across every
 * stamping job of both kinds that may still hold a copy, with the " (n)" suffix. So a coach session titled like the
 * program on a day the program session was sent (or is still queued) gets its own stamp and its own copy, and two
 * coach sessions of one title on one day do too. Whatever the stamps, the lane never adopts (`already_present`) a
 * copy another row or another job holds: it fails the job instead, and records nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch, takeOffWatch } from "../src/services/watch-push.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, counting, DAY, makeEnv, NOON, PROGRAM_NAME, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts } = schema;
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
const BASE = `${PROGRAM_NAME} — ${DAY}`;
const programsNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0]!;
const nameOf = (job: { payload: unknown }) => (job.payload as { name: string }).name;

async function approve(proposalId: string, ops: unknown[], env = makeEnv()) {
  await db.insert(schema.coachProposals).values({
    id: proposalId, userId, title: "t", evidence: "e", rationale: "r", flags: [], ops: ops as never,
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
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: { created: string[] } };
}

const run30 = (title: string) => ({ category: "easy", title, durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } });

/** Today's slot built and sent: its push queued. */
async function sendSlot(id?: string) {
  const workoutId = await seedSlot(db, userId, programId, DAY, id);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  await sendToWatch(db, switchOn(), userId, workoutId, built.build!.buildId, ctx());
  return { workoutId, buildId: built.build!.buildId };
}

describe("program first, then the coach (Review Focus 1, the reverse order)", () => {
  it("a coach session of the program's title on a sent day gets its own stamp and its own copy; removing it leaves the program's", async () => {
    const { workoutId, buildId } = await sendSlot();
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(nameOf(await jobOf(`push:${buildId}`))).toBe(BASE);

    const add = await approve("p-add", [{ kind: "add", date: DAY, session: run30(PROGRAM_NAME) }]);
    const coachId = add.applied.created[0]!;
    const coachJob = await jobOf(`${coachId}-push`);
    expect(nameOf(coachJob)).toBe(`${BASE} (2)`);
    expect(coachJob.status).toBe("verified");
    const coachRow = await rowOf(db, coachId);
    const programRow = await rowOf(db, workoutId);
    expect(coachRow.sourceWorkoutId).not.toBe(programRow.sourceWorkoutId);

    await approve("p-rm", [{ kind: "remove", workoutId: coachId }]);
    expect(programsNamed(BASE)).toHaveLength(1);
    expect(programsNamed(`${BASE} (2)`)).toHaveLength(0);
    // And the other direction: taking the program session off leaves nothing of the coach's behind it.
    await takeOffWatch(db, userId, workoutId, ctx());
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(programsNamed(BASE)).toHaveLength(0);
  });

  it("the program push still queued when the coach create is enqueued: still two stamps, two copies", async () => {
    const { workoutId, buildId } = await sendSlot();
    // The approve's own lane runs with the switch off: the coach create runs, the push waits.
    const add = await approve("p-add", [{ kind: "add", date: DAY, session: run30(PROGRAM_NAME) }]);
    const coachId = add.applied.created[0]!;
    expect((await jobOf(`push:${buildId}`)).status).toBe("queued");
    expect(nameOf(await jobOf(`${coachId}-push`))).toBe(`${BASE} (2)`);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`)).status).toBe("verified");
    expect(programsNamed(BASE)).toHaveLength(1);
    expect(programsNamed(`${BASE} (2)`)).toHaveLength(1);
    expect((await rowOf(db, coachId)).sourceWorkoutId).not.toBe((await rowOf(db, workoutId)).sourceWorkoutId);
  });
});

describe("the coach first, then the program", () => {
  it("a program session sent on a day a coach session holds the base stamp gets (2)", async () => {
    const add = await approve("p-add", [{ kind: "add", date: DAY, session: run30(PROGRAM_NAME) }]);
    const coachId = add.applied.created[0]!;
    expect(nameOf(await jobOf(`${coachId}-push`))).toBe(BASE);
    const { workoutId, buildId } = await sendSlot();
    expect(nameOf(await jobOf(`push:${buildId}`))).toBe(`${BASE} (2)`);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`)).status).toBe("verified");
    expect((await rowOf(db, coachId)).sourceWorkoutId).not.toBe((await rowOf(db, workoutId)).sourceWorkoutId);
  });
});

describe("two coach sessions of one title on one day (the pre-existing twin)", () => {
  it("each gets its own stamp and copy; neither job is left claimed", async () => {
    const a = (await approve("p-2", [{ kind: "add", date: DAY, session: run30("Easy run") }])).applied.created[0]!;
    const b = (await approve("p-3", [{ kind: "add", date: DAY, session: run30("Easy run") }])).applied.created[0]!;
    const ja = await jobOf(`${a}-push`);
    const jb = await jobOf(`${b}-push`);
    expect([nameOf(ja), nameOf(jb)]).toEqual([`Easy run — ${DAY}`, `Easy run — ${DAY} (2)`]);
    expect([ja.status, jb.status]).toEqual(["verified", "verified"]);
    expect((await rowOf(db, a)).sourceWorkoutId).not.toBe((await rowOf(db, b)).sourceWorkoutId);
  });
});

/*
 * A SESSION RE-CREATED ON ITS DAY DOES NOT PILE UP SUFFIXES (re-review C-4a). A coach create stayed `verified` after
 * its copy's unpush verified, so the chooser counted its stamp as taken for ever: every remove + re-add (a reshape, a
 * wind-down) put " (2)", then " (3)" … on the watch. Once the copy is provably gone, its stamp is free again.
 */
describe("a coach session removed, then the same session added again on its day", () => {
  it("the old copy's unpush verified: the new session gets the plain stamp, and only its copy is on the watch", async () => {
    const old = (await approve("p-1", [{ kind: "add", date: DAY, session: run30("Easy run") }])).applied.created[0]!;
    expect(nameOf(await jobOf(`${old}-push`))).toBe(`Easy run — ${DAY}`);
    await approve("p-2", [{ kind: "remove", workoutId: old }]);
    expect((await jobOf(`${old}-unpush`)).status).toBe("verified");
    expect(programsNamed(`Easy run — ${DAY}`)).toHaveLength(0);
    for (const p of ["p-3", "p-5"]) {
      const again = (await approve(p, [{ kind: "add", date: DAY, session: run30("Easy run") }])).applied.created[0]!;
      expect(nameOf(await jobOf(`${again}-push`))).toBe(`Easy run — ${DAY}`);
      expect((await jobOf(`${again}-push`)).status).toBe("verified");
      expect(programsNamed(`Easy run — ${DAY}`)).toHaveLength(1);
      await approve(`${p}-rm`, [{ kind: "remove", workoutId: again }]);
      expect((await jobOf(`${again}-unpush`)).status).toBe("verified");
    }
  });

  it("…while the old copy's unpush has not run yet, the new one still takes (2): its stamp is not free until then", async () => {
    const old = (await approve("p-1", [{ kind: "add", date: DAY, session: run30("Easy run") }])).applied.created[0]!;
    // The remove's lane runs later (no waitUntil lane here): the unpush is only queued.
    await db.update(plannedWorkouts).set({ archivedAt: NOON }).where(eq(plannedWorkouts.id, old));
    await db.insert(corosWriteJobs).values({
      id: `${old}-unpush`, userId, workoutId: old, kind: "coach_delete_workout", expectedContentFingerprint: "", originalDate: DAY,
      destinationDate: DAY, requestedAt: NOON, status: "queued", updatedAt: NOON,
      payload: { workoutId: old, happenDay: DAY, name: `Easy run — ${DAY}`, idInPlan: "3", programId: "3", corosPlanId: String(server.state.schedule.id) },
    });
    const { applyOps } = await import("../src/services/coach-apply.js");
    const again = (await applyOps(db, userId, prefs, "p-3", [{ kind: "add", date: DAY, session: run30("Easy run") } as never])).created[0]!;
    expect(nameOf(await jobOf(`${again}-push`))).toBe(`Easy run — ${DAY} (2)`);
  });
});

describe("the lane never adopts a copy another row or job holds", () => {
  it("a coach create carrying the sent program's stamp (a pre-fix queue): failed, nothing recorded, the copy stays the program's", async () => {
    const { workoutId, buildId } = await sendSlot();
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`)).status).toBe("verified");
    await db.insert(plannedWorkouts).values({
      id: "coach-1", userId, planId: "coach-adhoc", sourceWorkoutId: "coach-1", title: PROGRAM_NAME, category: "easy", sport: "run",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "07:00", completionState: "scheduled",
      corosSyncState: "calendar_only", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, createdAt: NOON, updatedAt: NOON,
    });
    await db.insert(corosWriteJobs).values({
      id: "coach-1-push", userId, workoutId: "coach-1", kind: "coach_create_workout", expectedContentFingerprint: "fp",
      originalDate: DAY, destinationDate: DAY, requestedAt: NOON, status: "queued", updatedAt: NOON,
      payload: { workoutId: "coach-1", happenDay: DAY, name: BASE, session: run30(PROGRAM_NAME) },
    });
    const fetches = counting(server);
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    expect(await jobOf("coach-1-push")).toMatchObject({ status: "failed", lastErrorCategory: "error" });
    expect(fetches.writes()).toBe(0);
    expect((await rowOf(db, "coach-1")).sourceWorkoutId).toBe("coach-1");
    expect((await rowOf(db, workoutId)).corosSyncState).toBe("synced");
    expect(programsNamed(BASE)).toHaveLength(1);
  });

  it.each([
    ["only another job holds it (a failed create that landed unrecorded)", "job"],
    ["only another row holds it (verified at that address)", "row"],
  ])("a push finding the coach's copy when %s: failed, nothing recorded", async (_, holder) => {
    const add = await approve("p-add", [{ kind: "add", date: DAY, session: run30(PROGRAM_NAME) }]);
    const coachId = add.applied.created[0]!;
    if (holder === "job") {
      // The create's write landed but was never recorded: the row holds no address, the job failed.
      await db.update(plannedWorkouts).set({ sourceWorkoutId: coachId, sourceIdInPlan: null, sourceProgramId: null, lastVerifiedCorosDate: "" }).where(eq(plannedWorkouts.id, coachId));
      await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `${coachId}-push`));
    } else {
      // The row holds the copy; no live job names it (say, a restore neutralised the history).
      await db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, `${coachId}-push`));
    }
    const { workoutId, buildId } = await sendSlot();
    const job = await jobOf(`push:${buildId}`);
    await db
      .update(corosWriteJobs)
      .set({ payload: { ...(job.payload as object), name: BASE } })
      .where(eq(corosWriteJobs.id, `push:${buildId}`));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(await jobOf(`push:${buildId}`)).toMatchObject({ status: "failed", lastErrorCategory: "error" });
    expect((await rowOf(db, workoutId)).lastVerifiedCorosDate).toBe("");
  });

  it("a program push carrying a stamp a coach job holds (a pre-fix queue): failed, nothing recorded", async () => {
    const add = await approve("p-add", [{ kind: "add", date: DAY, session: run30(PROGRAM_NAME) }]);
    const coachId = add.applied.created[0]!;
    expect((await jobOf(`${coachId}-push`)).status).toBe("verified");
    const { workoutId, buildId } = await sendSlot();
    // What a queue from before the shared chooser holds: the program push on the coach's stamp.
    const job = await jobOf(`push:${buildId}`);
    await db
      .update(corosWriteJobs)
      .set({ payload: { ...(job.payload as object), name: BASE } })
      .where(eq(corosWriteJobs.id, `push:${buildId}`));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(await jobOf(`push:${buildId}`)).toMatchObject({ status: "failed", lastErrorCategory: "error" });
    expect(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`)).payload).observed).toBeUndefined();
    const row = await rowOf(db, workoutId);
    expect([row.sourceWorkoutId, row.lastVerifiedCorosDate]).toEqual([workoutId, ""]);
  });
});
