/**
 * WHAT THE LANE RE-CHECKS WHEN IT CLAIMS A PUSH (Audit 3-A lane L-2 / L-5, lifecycle L-10).
 *
 * Send's preconditions held when the athlete tapped it; the lane may claim the push much later — after midnight (the
 * hourly lane held the lock at 23:50), after the session was done or skipped, after COROS writes were turned off. So
 * at claim, a push whose day is not the athlete's today, whose slot is resolved, or whose athlete's writes are off is
 * superseded with no wire call, and its build unlocked unless the slot is started or done (Start owns that lock). A
 * started slot of today still pushes.
 *
 * An unpush owed while writes are off (a sent copy's slot moved, or taken off) is recorded on the sent build, which
 * stays locked; it is queued when writes come back on (the Settings toggle's catch-up pass), so no copy is stranded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { loadSession } from "../src/services/session-build.js";
import { sendToWatch, takeOffWatch, watchStateOf } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { buildToday, connectMock, DAY, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds } = schema;

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
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const writesOff = (): UserPreferences => ({ ...prefs, corosWritesEnabled: false });
const lane = (p: UserPreferences = prefs) => executeCloudJobs(db, switchOn(), userId, p, { fetchImpl: server.fetchImpl });
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const buildOf = async (id: string) => (await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, id)))[0]!;
const copiesNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name).length;

async function sent(): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const buildId = (await buildToday(db, userId, prefs, workoutId)).build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
  return { workoutId, buildId };
}

/** The lane claimed the push and wrote nothing: superseded, no COROS write. */
async function supersededUnwritten(buildId: string, run: () => Promise<unknown>) {
  const writes = server.counts.scheduleWrites;
  await run();
  expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
  expect(server.counts.scheduleWrites - writes).toBe(0);
}

describe("not the athlete's today (L-2)", () => {
  it("sent at 23:50, claimed at 00:15: superseded, nothing written, the build unlocked", async () => {
    const { workoutId, buildId } = await sent();
    vi.setSystemTime(new Date(`${addDays(DAY, 1)}T07:15:00.000Z`)); // 00:15 the next day, Los Angeles
    await supersededUnwritten(buildId, () => lane());
    const build = await buildOf(buildId);
    expect(build.lockedAt).toBeNull();
    expect((build.payload as { unsentAt?: string }).unsentAt).toBeDefined();
    expect((await rowOf(db, workoutId)).contentState).toBe("built");
  });

  it("a started slot's push on a later day: superseded, and the build stays locked (Start owns it)", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, workoutId));
    vi.setSystemTime(new Date(`${addDays(DAY, 1)}T07:15:00.000Z`));
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();
  });
});

describe("a resolved slot", () => {
  it("done in the app: superseded, nothing written, the build stays locked", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ contentState: "done", completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();
  });

  it.each(["completed", "skipped"])("%s while still built: superseded, nothing written, the build unlocked", async (completionState) => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ completionState }).where(eq(plannedWorkouts.id, workoutId));
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).toBeNull();
  });

  it("a STARTED slot of today still pushes", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, workoutId));
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name)).toBe(1);
  });
});

describe("COROS writes off (L-5)", () => {
  it("turned off after Send, before the lane ran: superseded, nothing written, the build unlocked", async () => {
    const { buildId } = await sent();
    await supersededUnwritten(buildId, () => lane(writesOff()));
    expect((await buildOf(buildId)).lockedAt).toBeNull();
  });
});

describe("an unpush owed while writes are off (L-10)", () => {
  async function onWatch() {
    const s = await sent();
    await lane();
    const push = await jobOf(`push:${s.buildId}`);
    expect(push!.status).toBe("verified");
    const stamp = programSessionPushJobSchema.parse(push!.payload).name;
    expect(copiesNamed(stamp)).toBe(1);
    return { ...s, stamp };
  }

  it("moved to tomorrow with writes off: nothing queued, the build stays locked; writes back on → the copy comes off", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    await applyMove(db, { userId, workoutId, toDate: addDays(DAY, 1), toTime: "18:00", source: "app", corosWritesEnabled: false });
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();

    // Writes back on: the Settings toggle's catch-up pass.
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    const unpush = await jobOf(`unpush:${buildId}`);
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    expect((unpush!.payload as { name: string; happenDay: string })).toMatchObject({ name: stamp, happenDay: DAY });
    expect((await buildOf(buildId)).lockedAt).toBeNull();
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(stamp)).toBe(0);
    // Owed once: a second catch-up pass queues nothing again.
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
  });

  it("taken off with writes off: owed, the build locked and still on the watch; writes back on → queued", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    await takeOffWatch(db, userId, workoutId, { ...ctx(), prefs: writesOff() });
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();
    const state = await watchStateOf(db, switchOn(), userId, await rowOf(db, workoutId), await loadSession(db, userId, workoutId, DAY), writesOff());
    expect(state).toEqual({ state: "on_watch" });
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    await lane();
    expect(copiesNamed(stamp)).toBe(0);
  });

  it("a started slot taken off with writes off: owed once — its build stays locked, and a later pass queues nothing again", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, workoutId));
    await takeOffWatch(db, userId, workoutId, { ...ctx(), prefs: writesOff() });
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(stamp)).toBe(0);
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
  });

  it("owed once: an owed unpush that then failed for good is not revived by the next writes-on pass", async () => {
    const { workoutId, buildId } = await onWatch();
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, workoutId));
    await takeOffWatch(db, userId, workoutId, { ...ctx(), prefs: writesOff() });
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    // The lane's verdict: refused (the athlete edited it in COROS) — the copy's removal is the athlete's now.
    await db.update(corosWriteJobs).set({ status: "failed", lastErrorCategory: "stamp_mismatch" }).where(eq(corosWriteJobs.id, `unpush:${buildId}`));
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
  });

  // Re-review C-3a: the removal path (the athlete's remove, the coach's `remove`, archiveWeek) recorded nothing.
  it("removed from the plan with writes off: owed; writes back on → the copy comes off, once", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    await removeFromPlan(db, userId, workoutId, { now: NOON, source: "remove_from_plan", prefs: writesOff() });
    expect((await rowOf(db, workoutId)).archivedAt).not.toBeNull();
    expect((await db.select().from(corosWriteJobs)).filter((j) => j.kind === "coach_delete_workout")).toEqual([]);
    expect(copiesNamed(stamp)).toBe(1);
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    await lane();
    const deletes = (await db.select().from(corosWriteJobs)).filter((j) => j.kind === "coach_delete_workout");
    expect(deletes.map((d) => [d.id, d.status])).toEqual([[`unpush:${buildId}`, "verified"]]);
    expect(copiesNamed(stamp)).toBe(0);
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await db.select().from(corosWriteJobs)).filter((j) => j.kind === "coach_delete_workout")).toHaveLength(1);
  });

  it("nothing owed: the catch-up pass queues no unpush", async () => {
    const { buildId } = await onWatch();
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await buildOf(buildId)).lockedAt).not.toBeNull();
  });
});
