/**
 * A SENT SESSION'S LIFE IN THE APP (Phase 3 Task 6; spec §4.4; rulings 3-R3, 2a-R4 extended).
 *
 *  - Start on a sent build plays the build the watch holds: `started`, the same build, no rebuild.
 *  - Discard returns it to `built`; the build on the watch stays locked.
 *  - A move to another day never re-dates the watch copy: a pushed copy is taken off (the stamp-proven delete), the
 *    build unlocks, and the slot is an outline on its new day. A time-only change writes nothing (Review Focus 3).
 *  - A removal settles the queued push, or unpushes the pushed copy through the program stamp.
 *  - The save accepts the slot's own day for a sent build COROS moved (Task 7 adopts the move).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, type PerformedSessionWireInput, type UserPreferences } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import type { Db } from "../src/services/db.js";
import { applyMove } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { buildSession, loadSession, startSession, unstartSession, type BuildPayload } from "../src/services/session-build.js";
import { InvalidSaveError, savePerformedSession } from "../src/services/session-save.js";
import { sendToWatch, takeOffWatch, unpushBuild } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { DAY, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, scheduleOverrides, sessionBuilds, syncIntents } = schema;

/**
 * Hold a request at `sentBuildIdOf`, which a move of a sent session reads before it writes anything of the watch's: the
 * window between the route's guard and the move's own writes. A test sets it; it clears itself.
 */
const gates = vi.hoisted(() => ({ sent: null as null | (() => Promise<void>) }));
vi.mock("../src/services/session-build.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/session-build.js")>();
  return {
    ...real,
    sentBuildIdOf: async (...args: Parameters<typeof real.sentBuildIdOf>) => {
      const hold = gates.sent;
      gates.sent = null;
      if (hold) await hold();
      return real.sentBuildIdOf(...args);
    },
  };
});

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  gates.sent = null;
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const jobsOf = (workoutId: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
const buildRows = (workoutId: string) => db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId));

/** A slot built today and sent; `verified` also lands it on the watch (the lane's own writes, by hand). */
async function sentSlot(opts: { verified?: boolean; programId?: string } = {}): Promise<{ workoutId: string; buildId: string; build: BuildPayload }> {
  const workoutId = await seedSlot(db, userId, opts.programId ?? programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  if (opts.verified) {
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, workoutId));
  }
  return { workoutId, buildId, build: built.build! };
}

describe("Start and Discard on a sent build", () => {
  it("Start plays the sent build: started, the same build, no new build row", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    const before = (await buildRows(workoutId)).map((b) => b.id);
    const started = await startSession(db, userId, workoutId, buildId, NOON);
    expect(started).toMatchObject({ contentState: "started", locked: true });
    expect(started.build!.buildId).toBe(buildId);
    expect((await buildRows(workoutId)).map((b) => b.id)).toEqual(before);
    expect((await rowOf(db, workoutId)).contentState).toBe("started");
  });

  it("Discard after it: built again, and the build on the watch stays locked", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    await startSession(db, userId, workoutId, buildId, NOON);
    const after = await unstartSession(db, userId, workoutId, { today: DAY, now: NOON });
    expect(after).toMatchObject({ contentState: "built", locked: true });
    const [b] = (await buildRows(workoutId)).filter((x) => x.id === buildId);
    expect(b!.lockedAt).not.toBeNull();
  });

  it("a push still queued keeps its build locked through a Discard too", async () => {
    const { workoutId, buildId } = await sentSlot();
    await startSession(db, userId, workoutId, buildId, NOON);
    await unstartSession(db, userId, workoutId, { today: DAY, now: NOON });
    expect((await buildRows(workoutId)).find((x) => x.id === buildId)!.lockedAt).not.toBeNull();
  });
});

describe("moving a sent session in the app (Review Focus 3, second half)", () => {
  it("to tomorrow: unpush:<buildId> queued, no move job, the slot an outline, the sent build unlocked", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    const outcome = await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect(outcome.jobId).toBeUndefined();
    const jobs = await jobsOf(workoutId);
    expect(jobs.filter((j) => j.kind === "move_scheduled_workout")).toEqual([]);
    expect(jobs.find((j) => j.id === `unpush:${buildId}`)).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ effectiveDate: TOMORROW, contentState: "outline", corosSyncState: "calendar_only" });
    // The copy is still where COROS holds it until the unpush verifies: the address stays for the delete to use.
    expect(row.lastVerifiedCorosDate).toBe(DAY);
    expect((await buildRows(workoutId)).filter((b) => b.lockedAt !== null)).toEqual([]);
  });

  it("before the push ran: the push is superseded and nothing is queued", async () => {
    const { workoutId, buildId } = await sentSlot();
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect((await jobsOf(workoutId)).map((j) => [j.id, j.status])).toEqual([[`push:${buildId}`, "superseded"]]);
  });

  it("a time-only change on the same day: no job, no unlock, the watch copy still right", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    const before = await jobsOf(workoutId);
    await applyMove(db, { userId, workoutId, toDate: DAY, toTime: "07:30", source: "app", corosWritesEnabled: true });
    expect(await jobsOf(workoutId)).toEqual(before);
    expect((await buildRows(workoutId)).find((b) => b.id === buildId)!.lockedAt).not.toBeNull();
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: DAY, effectiveTime: "07:30", contentState: "built", corosSyncState: "synced" });
  });
});

describe("removing a sent session", () => {
  it("a queued push is superseded", async () => {
    const { workoutId, buildId } = await sentSlot();
    await removeFromPlan(db, userId, workoutId, { now: NOON, source: "remove_from_plan", prefs });
    expect((await jobsOf(workoutId)).map((j) => [j.id, j.status])).toEqual([[`push:${buildId}`, "superseded"]]);
  });

  it("a pushed copy is unpushed through the program stamp", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await removeFromPlan(db, userId, workoutId, { now: NOON, source: "remove_from_plan", prefs });
    const unpush = (await jobsOf(workoutId)).find((j) => j.kind === "coach_delete_workout");
    expect(unpush).toMatchObject({ status: "queued" });
    expect(unpush!.payload).toMatchObject({ name: (push!.payload as { name: string }).name, idInPlan: "91", happenDay: DAY });
  });
});

describe("a done session's copy stays on the watch (audit 3-A life U-1)", () => {
  // The copy is the session the athlete did (or the record a watch review pairs with): nothing takes it off.
  const unpushes = async (workoutId: string) => (await jobsOf(workoutId)).filter((j) => j.kind === "coach_delete_workout");

  it("Take off of a done slot queues nothing", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    await db.update(plannedWorkouts).set({ contentState: "done", completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
    await takeOffWatch(db, userId, workoutId, ctx());
    expect(await unpushes(workoutId)).toEqual([]);
    expect((await jobsOf(workoutId)).find((j) => j.id === `push:${buildId}`)!.status).toBe("verified");
  });

  it("a completed slot moved to another day queues nothing", async () => {
    const { workoutId } = await sentSlot({ verified: true });
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect(await unpushes(workoutId)).toEqual([]);
  });

  it("a done slot moved while writes are off owes nothing either", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    await db.update(plannedWorkouts).set({ contentState: "done", completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: false });
    const build = (await buildRows(workoutId)).find((b) => b.id === buildId)!;
    expect((build.payload as { unpushOwedAt?: string }).unpushOwedAt).toBeUndefined();
    await unpushBuild(db, userId, await rowOf(db, workoutId), buildId, NOON, { corosWritesEnabled: true });
    expect(await unpushes(workoutId)).toEqual([]);
  });
});

describe("the save's day check for a sent build COROS moved", () => {
  const wireOf = (workoutId: string, build: BuildPayload, localDate: string): PerformedSessionWireInput => ({
    id: newId(), source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate,
    startedAt: `${localDate}T19:05:00.000Z`, endedAt: `${localDate}T19:35:00.000Z`, seconds: 1800, plannedSeconds: build.plannedSeconds,
    minutes: build.minutes, mode: build.mode, theme: build.theme, locationId: build.locationId, blockRef: build.blockRef,
    blockNumber: 1, completed: true, stepsTotal: 10, stepsDone: 10, movesDone: [], note: null, newMove: null, entries: [], checks: [],
    review: {},
  });
  const LATER = addDays(DAY, 2);

  it("accepts a save dated the slot's new day while the slot holds a sent build", async () => {
    const { workoutId, build } = await sentSlot({ verified: true });
    // COROS moved the copy two days on, and the import adopted the move (Task 7): the build stays locked.
    await db.update(plannedWorkouts).set({ effectiveDate: LATER, lastVerifiedCorosDate: LATER }).where(eq(plannedWorkouts.id, workoutId));
    vi.setSystemTime(new Date(`${LATER}T20:00:00.000Z`));
    const wire = wireOf(workoutId, build, LATER);
    expect(await savePerformedSession(db, userId, wire.id, wire, { now: `${LATER}T20:00:00.000Z`, prefs })).toMatchObject({ status: "saved" });
  });

  it("without a sent build the same save is refused (422)", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
    await startSession(db, userId, workoutId, built.build!.buildId, NOON);
    await db.update(plannedWorkouts).set({ effectiveDate: LATER }).where(eq(plannedWorkouts.id, workoutId));
    vi.setSystemTime(new Date(`${LATER}T20:00:00.000Z`));
    const wire = wireOf(workoutId, built.build!, LATER);
    await expect(savePerformedSession(db, userId, wire.id, wire, { now: `${LATER}T20:00:00.000Z`, prefs })).rejects.toBeInstanceOf(InvalidSaveError);
    expect((await loadSession(db, userId, workoutId, LATER)).contentState).toBe("started");
  });

  /** The athlete's own route, as a stale tab or a direct call reaches it. */
  const planRoute = async (workoutId: string, action: "move" | "skip", body?: unknown) => {
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const res = await app.request(
      `/api/plan/workouts/${workoutId}/${action}`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      switchOn(),
      { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("started on a copy COROS moved ahead: under way through the slot's new day and the next, though its build's day is long gone (R3 F6); then the API opens", async () => {
    const FAR = addDays(DAY, 5);
    const { workoutId, buildId, build } = await sentSlot({ verified: true });
    await db.update(plannedWorkouts).set({ effectiveDate: FAR, lastVerifiedCorosDate: FAR }).where(eq(plannedWorkouts.id, workoutId));
    vi.setSystemTime(new Date(`${FAR}T19:00:00.000Z`));
    await startSession(db, userId, workoutId, buildId, `${FAR}T19:00:00.000Z`);
    for (const day of [FAR, addDays(FAR, 1)]) {
      vi.setSystemTime(new Date(`${day}T19:00:00.000Z`));
      for (const [action, body] of [["move", { toDate: addDays(FAR, 3), toTime: "18:00" }], ["skip", undefined]] as const) {
        const answer = await planRoute(workoutId, action, body);
        expect([answer.status, answer.json.error]).toEqual([409, "session_under_way"]);
      }
    }
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: FAR, contentState: "started", completionState: "scheduled" });
    // Its save lands on the slot's new day, the guard having held it there.
    vi.setSystemTime(new Date(`${FAR}T20:00:00.000Z`));
    const wire = wireOf(workoutId, build, FAR);
    expect(await savePerformedSession(db, userId, wire.id, wire, { now: `${FAR}T20:00:00.000Z`, prefs })).toMatchObject({ status: "saved" });
  });

  it("started on a copy COROS moved, past those days: no longer refused", async () => {
    const FAR = addDays(DAY, 5);
    const { workoutId, buildId } = await sentSlot({ verified: true });
    await db.update(plannedWorkouts).set({ effectiveDate: FAR, lastVerifiedCorosDate: FAR }).where(eq(plannedWorkouts.id, workoutId));
    vi.setSystemTime(new Date(`${FAR}T19:00:00.000Z`));
    await startSession(db, userId, workoutId, buildId, `${FAR}T19:00:00.000Z`);
    vi.setSystemTime(new Date(`${addDays(FAR, 2)}T19:00:00.000Z`));
    expect((await planRoute(workoutId, "skip")).status).toBe(200);
  });

  /** What a move can leave of the watch's and the plan's: the row's jobs, the build's lock, its overrides and intents. */
  const trail = async (workoutId: string, buildId: string) => ({
    jobs: (await jobsOf(workoutId)).map((j) => [j.id, j.kind, j.status]).sort(),
    locked: (await buildRows(workoutId)).find((b) => b.id === buildId)!.lockedAt !== null,
    unsent: ((await buildRows(workoutId)).find((b) => b.id === buildId)!.payload as { unsentAt?: string }).unsentAt ?? null,
    overrides: (await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, workoutId))).length,
    intents: (await db.select().from(syncIntents).where(eq(syncIntents.targetId, workoutId))).length,
  });

  it("a Start, then the save, landing inside a /move of a session sent to the watch: 409 `session_completed`, and the move wrote nothing — no unpush, the build still locked, no override, no intent", async () => {
    const { workoutId, buildId, build } = await sentSlot({ verified: true });
    // What Start and the save leave on their own, with no move beside them: the control.
    const control = await sentSlot({ verified: true, programId: await seedProgram(db, userId, "Second program") }).then(async (c) => {
      await startSession(db, userId, c.workoutId, c.buildId, NOON);
      const w = wireOf(c.workoutId, c.build, DAY);
      expect(await savePerformedSession(db, userId, w.id, w, { now: NOON, prefs })).toMatchObject({ status: "saved" });
      return trail(c.workoutId, c.buildId);
    });
    gates.sent = async () => {
      await startSession(db, userId, workoutId, buildId, NOON);
      const w = wireOf(workoutId, build, DAY);
      expect(await savePerformedSession(db, userId, w.id, w, { now: NOON, prefs })).toMatchObject({ status: "saved" });
    };
    const answer = await planRoute(workoutId, "move", { toDate: TOMORROW, toTime: "18:00" });
    expect([answer.status, answer.json.error]).toEqual([409, "session_completed"]);
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: DAY, completionState: "completed", contentState: "done" });
    const after = await trail(workoutId, buildId);
    expect(after.jobs.filter((j) => j[1] === "coach_delete_workout")).toEqual([]);
    expect({ ...after, jobs: after.jobs.length }).toEqual({ ...control, jobs: control.jobs.length });
    expect(after).toMatchObject({ locked: true, unsent: null, overrides: 0, intents: 0 });
  });

  it("a Start alone landing inside a /move of a sent session: 409 `session_under_way`, nothing of the move written", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    gates.sent = async () => {
      await startSession(db, userId, workoutId, buildId, NOON);
    };
    const answer = await planRoute(workoutId, "move", { toDate: TOMORROW, toTime: "18:00" });
    expect([answer.status, answer.json.error]).toEqual([409, "session_under_way"]);
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: DAY, contentState: "started" });
    expect(await trail(workoutId, buildId)).toMatchObject({ locked: true, unsent: null, overrides: 0, intents: 0 });
    expect((await jobsOf(workoutId)).map((j) => j.kind)).toEqual(["program_session_push"]);
  });

  it("the same move with nothing landing: moved, its copy's unpush queued and the build unlocked, as before", async () => {
    const { workoutId, buildId } = await sentSlot({ verified: true });
    const answer = await planRoute(workoutId, "move", { toDate: TOMORROW, toTime: "18:00" });
    expect(answer.status).toBe(200);
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: TOMORROW, contentState: "outline" });
    const after = await trail(workoutId, buildId);
    expect(after.jobs).toContainEqual([`unpush:${buildId}`, "coach_delete_workout", "queued"]);
    expect(after).toMatchObject({ locked: false, overrides: 1, intents: 1 });
  });

  it("HAZARD, as it stands (JOINT §3.2; the guard neither causes nor stops it): Discard on a sent build, then a move: the move unsends it and the phone's save answers 422 for good", async () => {
    const { workoutId, buildId, build } = await sentSlot({ verified: true });
    await startSession(db, userId, workoutId, buildId, NOON);
    await unstartSession(db, userId, workoutId, { today: DAY, now: NOON });
    // Built again, so the gate is open: the Discard is what said nobody is playing it.
    expect((await planRoute(workoutId, "move", { toDate: TOMORROW, toTime: "18:00" })).status).toBe(200);
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: TOMORROW, contentState: "outline" });
    const wire = wireOf(workoutId, build, DAY);
    await expect(savePerformedSession(db, userId, wire.id, wire, { now: `${DAY}T20:00:00.000Z`, prefs })).rejects.toBeInstanceOf(InvalidSaveError);
  });
});
