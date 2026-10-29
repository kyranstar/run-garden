/**
 * THE HOOKS (the watch mirrors the plan §3.4, §3.5, §3.6; owner §10.2; builder check A4, M1, M2).
 *
 * Every change to a session keeps its watch copy in step, by the cheap writes alone (M2) — the previous copy's delete
 * (`enqueueUnpushIfOurs`, the address path never taken) and the owed mark (`markMirrorOwed`) — and the drain or the sweep
 * makes the new copy:
 *  - a Studio add, a revise (an adoption's held copy deleted too), a move to another day (the shared `applyMove`): the
 *    old copy's delete and the owed mark; the moved row keeps its document and becomes an outline, as before;
 *  - a skip (the shared `skipWorkout`, the Plan's and the coach's alike): the copy comes off, even ahead of its day; an
 *    un-skip marks it owed again;
 *  - a remove: the unpush it always queued.
 * A session of today whose check is answered goes to the watch as the day's gated build, never as an ungated provisional
 * copy (M1). With the athlete's COROS writes off, nothing is queued: the deletes are owed on the sent build, the marks
 * stay open, and switching writes on catches up. Invented data; the fixture clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { mirrorSweep, queueProvisionalPush } from "../src/services/mirror.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { planRoutes } from "../src/routes/plan.js";
import { applyOps } from "../src/services/coach-apply.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { CREATE_AT_TIME_COST, MOVE_COST, REQUEST_BUDGET, RESTORE_COST, REVISE_BASE, SKIP_COST, SKIP_UNPUSH_COST } from "../src/services/design-approve.js";
import { createDocWorkout, reviseDocWorkout } from "../src/services/doc-workouts.js";
import { applyMove } from "../src/services/jobs.js";
import { removeFromPlan, skipWorkout, unskipWorkout } from "../src/services/plan-mutations.js";
import { buildSession, recordCheck, sentBuildIdOf } from "../src/services/session-build.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, DAY, makeEnv, NOON, rowOf, seedCatalog, seedProgram, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds, syncIntents } = schema;

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
let statements: string[] = [];
let seq = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
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

const ctx = (over: Partial<{ prefs: UserPreferences }> = {}) => ({ today: DAY, now: NOON, prefs, ...over });
const writesOff = (): UserPreferences => ({ ...prefs, corosWritesEnabled: false });
const IN_TWO = addDays(DAY, 2);
const IN_THREE = addDays(DAY, 3);

/** A Studio workout as the Studio stores one: its document at revision 1, an outline until its day. */
async function seedDocRow(date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}, doc: WorkoutDoc = calmDoc()): Promise<string> {
  const id = over.id ?? `studio-${date}-${(seq += 1)}`;
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "studio",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
    createdAt: NOON, updatedAt: NOON, ...over,
  });
  return id;
}

/** The same workout with more reps: a new revision, the title kept. */
function revisedDoc(reps = 15): WorkoutDoc {
  const doc = calmDoc();
  return workoutDocSchema.parse({
    ...doc,
    parts: doc.parts.map((p) => ({ ...p, items: p.items.map((i) => (i.kind === "exercise" ? { ...i, dose: { ...i.dose, reps } } : i)) })),
  });
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const jobsOf = (workoutId: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId)).orderBy(corosWriteJobs.requestedAt);
const queuedOf = async (workoutId: string) => (await jobsOf(workoutId)).filter((j) => j.status === "queued").map((j) => j.id);
const recordsOf = (workoutId: string) =>
  db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, workoutId), lt(sessionBuilds.version, 0))).orderBy(sessionBuilds.version);
const buildOf = async (id: string) => (await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, id)))[0]!;
const intentOf = async (workoutId: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, `mirror-${workoutId}`)))[0];
const owed = async (workoutId: string) => {
  const mark = await intentOf(workoutId);
  return mark !== undefined && mark.resolvedAt === null;
};
const ourPrograms = (title: string) => (server.state.schedule.programs ?? []).filter((p) => String(p.name).startsWith(title));
const lane = () => executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
const sweep = (p: UserPreferences = prefs) => mirrorSweep(db, switchOn(), userId, p, ctx({ prefs: p }), { cap: 1 });

/** The provisional copy queued (the drain's) and driven to the watch by the lane: its record's id. */
async function provisionalCopy(id: string): Promise<string> {
  expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
  const [record] = await recordsOf(id);
  await lane();
  expect((await jobOf(`push:${record!.id}`))!.status).toBe("verified");
  expect((await rowOf(db, id)).lastVerifiedCorosDate).toBe((await rowOf(db, id)).effectiveDate);
  return record!.id;
}

/** A coach session (origin NULL) the app pushed: its address and the create that stamped it (invented numbers). */
async function seedCoachSession(id: string, date: string, stamp: string): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coach-plan-invented", sourceWorkoutId: "4242:7", sourceIdInPlan: "7", sourceProgramId: "880001",
    title: "Legs, invented", category: "strength", sport: "strength", originalPlanDate: date, lastVerifiedCorosDate: date,
    effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "coach-invented-fp", calendarBlockDurationSeconds: 2400,
    fallbackEstimatedDurationSeconds: 2400, corosSyncState: "synced", completionState: "scheduled", origin: null,
    workoutDoc: JSON.stringify(calmDoc({ title: "Legs, invented" })), workoutDocRev: 1, createdAt: NOON, updatedAt: NOON,
  });
  await db.insert(corosWriteJobs).values({
    id: `${id}-push`, userId, workoutId: id, kind: "coach_create_workout", expectedContentFingerprint: "coach-invented-fp",
    originalDate: date, destinationDate: date,
    payload: { workoutId: id, happenDay: date, name: stamp, session: { category: "strength", title: "Legs, invented", durationMinutes: 40 } },
    requestedAt: NOON, status: "verified", verifiedAt: NOON, updatedAt: NOON,
  });
}

describe("a Studio add", () => {
  it("for a day ahead: marked owed, nothing queued by the request; the drain queues the provisional push", async () => {
    const made = await createDocWorkout(db, userId, { date: IN_THREE, doc: calmDoc() }, ctx());
    const id = made.workout.id;
    expect(await owed(id)).toBe(true);
    expect(await jobsOf(id)).toEqual([]);
    expect(await recordsOf(id)).toEqual([]);

    expect((await sweep()).queued).toBe(1);
    const [record] = await recordsOf(id);
    expect(await jobOf(`push:${record!.id}`)).toMatchObject({ status: "queued", originalDate: IN_THREE, destinationDate: IN_THREE });
    expect((await jobOf(`push:${record!.id}`))!.payload).toMatchObject({ provisional: true, happenDay: IN_THREE, fromDocRev: 1 });
    expect(await owed(id)).toBe(false);
  });

  it("a Start now is never marked (M5): it is played on the phone, not mirrored", async () => {
    const made = await createDocWorkout(db, userId, { date: DAY, doc: calmDoc(), startNow: true }, ctx());
    expect(await intentOf(made.workout.id)).toBeUndefined();
  });
});

describe("a revise", () => {
  it("the old copy's delete is queued and the session marked owed; the drain pushes the new revision with no second delete", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);

    const res = await reviseDocWorkout(db, userId, id, { doc: revisedDoc(), baseRev: 1 }, ctx());
    expect(res.rev).toBe(2);
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
    // The record is no longer the copy on the watch: its marker cleared, never locked.
    expect(await sentBuildIdOf(db, id)).toBeNull();
    expect(await owed(id)).toBe(true);

    expect((await sweep()).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect(second!.id).not.toBe(first);
    expect(await queuedOf(id)).toEqual([`unpush:${first}`, `push:${second!.id}`]);
    expect((await jobOf(`push:${second!.id}`))!.payload).toMatchObject({ provisional: true, fromDocRev: 2, happenDay: IN_TWO });
    // The lane: the old copy off, the new one on — one copy on the watch.
    await lane();
    expect(ourPrograms("Hips and back")).toHaveLength(1);
  });

  it("the same document again changes nothing on the watch: no delete, no mark", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);
    const res = await reviseDocWorkout(db, userId, id, { doc: calmDoc(), baseRev: 1 }, ctx());
    expect(res.rev).toBe(1);
    expect(await queuedOf(id)).toEqual([]);
    expect(await sentBuildIdOf(db, id)).toBe(first);
    expect(await intentOf(id)).toBeUndefined();
  });

  it("an adoption: the held copy's delete (<id>-unpush-copy) is queued and the session marked owed; the drain pushes it", async () => {
    const id = "cw-invented-1-0";
    const stamp = `Legs, invented — ${IN_TWO}`;
    await seedCoachSession(id, IN_TWO, stamp);

    await reviseDocWorkout(db, userId, id, { doc: calmDoc({ title: "Legs, mine" }), baseRev: 1 }, ctx());
    expect(await rowOf(db, id)).toMatchObject({ origin: "studio", watchCopyName: stamp });
    expect(await queuedOf(id)).toEqual([`${id}-unpush-copy`]);
    expect(await jobOf(`${id}-unpush-copy`)).toMatchObject({ kind: "coach_delete_workout" });
    expect((await jobOf(`${id}-unpush-copy`))!.payload).toMatchObject({ name: stamp, happenDay: IN_TWO, idInPlan: "7", programId: "880001" });
    expect(await owed(id)).toBe(true);

    expect((await sweep()).queued).toBe(1);
    const [record] = await recordsOf(id);
    expect(await queuedOf(id)).toEqual([`${id}-unpush-copy`, `push:${record!.id}`]);
  });
});

describe("a move", () => {
  it("to another day: the old copy's delete and the owed mark; the document kept, an outline; the drain pushes for the new day", async () => {
    const id = await seedDocRow(TOMORROW);
    const first = await provisionalCopy(id);
    const before = await rowOf(db, id);

    const outcome = await applyMove(db, { userId, workoutId: id, toDate: IN_THREE, toTime: "07:30", source: "app", corosWritesEnabled: true });
    expect(outcome).toMatchObject({ corosSyncState: "calendar_only", jobId: undefined });
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
    expect(await owed(id)).toBe(true);
    const moved = await rowOf(db, id);
    expect(moved).toMatchObject({ effectiveDate: IN_THREE, effectiveTime: "07:30", contentState: "outline", title: before.title, workoutDoc: before.workoutDoc, workoutDocRev: 1 });

    expect((await sweep()).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect((await jobOf(`push:${second!.id}`))!.payload).toMatchObject({ provisional: true, happenDay: IN_THREE });
    await lane();
    expect(ourPrograms("Hips and back").map((p) => p.name)).toEqual([`Hips and back — ${IN_THREE}`]);
  });

  it("a built session of today moved ahead becomes an outline, its document kept", async () => {
    const id = await seedDocRow(DAY);
    await buildSession(db, userId, id, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
    expect((await rowOf(db, id)).contentState).toBe("built");
    await applyMove(db, { userId, workoutId: id, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect(await rowOf(db, id)).toMatchObject({ effectiveDate: TOMORROW, contentState: "outline", title: "Hips and back" });
    expect(JSON.parse((await rowOf(db, id)).workoutDoc!)).toEqual(calmDoc());
    expect(await owed(id)).toBe(true);
  });

  it("an adopted row's held copy is deleted by the move (A4: the old copy never moved before)", async () => {
    const id = "cw-invented-2-0";
    await seedCoachSession(id, TOMORROW, `Legs, invented — ${TOMORROW}`);
    // Adopted with the athlete's writes off: the held copy is not deleted then (nothing owed for it).
    await reviseDocWorkout(db, userId, id, { doc: calmDoc({ title: "Legs, mine" }), baseRev: 1 }, ctx({ prefs: writesOff() }));
    expect(await jobsOf(id)).toHaveLength(1);
    await applyMove(db, { userId, workoutId: id, toDate: IN_THREE, toTime: "07:00", source: "calendar_edit", corosWritesEnabled: true });
    expect(await queuedOf(id)).toEqual([`${id}-unpush-copy`]);
    expect(await owed(id)).toBe(true);
  });

  it("a time-only change writes nothing for the watch", async () => {
    const id = await seedDocRow(TOMORROW);
    const first = await provisionalCopy(id);
    await applyMove(db, { userId, workoutId: id, toDate: TOMORROW, toTime: "06:00", source: "app", corosWritesEnabled: true });
    expect(await queuedOf(id)).toEqual([]);
    expect(await sentBuildIdOf(db, id)).toBe(first);
    expect(await intentOf(id)).toBeUndefined();
  });

  it("moved onto today with the check answered: no provisional copy — the day's build is pushed on its build (M1)", async () => {
    const id = await seedDocRow(TOMORROW);
    const first = await provisionalCopy(id);
    await recordCheck(db, userId, { profileId: "tmj", value: 2, feelingOff: false }, { today: DAY, now: NOON });

    await applyMove(db, { userId, workoutId: id, toDate: DAY, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("skipped:today_checked");
    expect(await recordsOf(id)).toHaveLength(1);
    expect(await owed(id)).toBe(false);

    // The sheet opens: the day's build, checked, is the copy (no provisional copy to hand over: it is pushed).
    const day = (await buildSession(db, userId, id, {}, { ...ctx(), env: switchOn() })).build!;
    expect(day.version).toBeGreaterThan(0);
    expect((await buildOf(day.buildId)).lockedAt).toBe(NOON);
    expect(await queuedOf(id)).toEqual([`unpush:${first}`, `push:${day.buildId}`]);
    await lane();
    expect(ourPrograms("Hips and back").map((p) => p.name)).toEqual([`Hips and back — ${DAY}`]);
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
  });

  it("moved onto today with the check unanswered: the sweep pushes the provisional copy for today, within 15 statements", async () => {
    const id = await seedDocRow(TOMORROW);
    await provisionalCopy(id);
    await applyMove(db, { userId, workoutId: id, toDate: DAY, toTime: "18:00", source: "app", corosWritesEnabled: true });
    statements = [];
    expect((await sweep()).queued).toBe(1);
    console.info(`[budget] mirrorSweep, a session of today (its pre-check read): ${statements.length} D1`);
    expect(statements.length).toBeLessThanOrEqual(15);
    const [second] = await recordsOf(id);
    expect((await jobOf(`push:${second!.id}`))!.payload).toMatchObject({ provisional: true, happenDay: DAY });
  });

  it("an account with no condition profile has no check to answer: a session of today is sent its provisional copy", async () => {
    await db.delete(schema.userConditions).where(eq(schema.userConditions.userId, userId));
    const id = await seedDocRow(DAY);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    const [record] = await recordsOf(id);
    expect((await jobOf(`push:${record!.id}`))!.payload).toMatchObject({ provisional: true, happenDay: DAY });
  });

  it("a session of today whose check is answered never holds the sweep up: judged once, the next run pushes another", async () => {
    await recordCheck(db, userId, { profileId: "tmj", value: 2, feelingOff: false }, { today: DAY, now: NOON });
    const today = await seedDocRow(DAY);
    const later = await seedDocRow(IN_TWO);
    expect(await sweep()).toMatchObject({ queued: 0, skipped: { today_checked: 1 } });
    expect(await sweep()).toMatchObject({ queued: 1, skipped: { today_checked: 1 } });
    expect(await recordsOf(later)).toHaveLength(1);
    expect(await recordsOf(today)).toHaveLength(0);
  });
});

describe("a skip and an un-skip (owner §10.2: 'if I skip it it should remove it')", () => {
  it("a skip ahead of the day takes the copy off; the un-skip marks it owed and the drain puts it back", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);

    expect(await skipWorkout(db, userId, id, { now: NOON, today: DAY, source: "app", prefs })).toEqual({ skipped: true });
    expect(await rowOf(db, id)).toMatchObject({ completionState: "skipped", resolutionDate: DAY });
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
    await lane();
    expect(ourPrograms("Hips and back")).toEqual([]);

    expect((await unskipWorkout(db, userId, id, { now: NOON, today: DAY, source: "app" })).restored).toBe(true);
    expect(await owed(id)).toBe(true);
    expect((await sweep()).queued).toBe(1);
    await lane();
    expect(ourPrograms("Hips and back").map((p) => p.name)).toEqual([`Hips and back — ${IN_TWO}`]);
  });

  it("the Plan's skip goes through skipWorkout: the copy comes off; an unresolved session is still skipped", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const post = (path: string) => app.request(path, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
    expect((await post(`/api/plan/workouts/${id}/skip`)).status).toBe(200);
    expect((await rowOf(db, id)).completionState).toBe("skipped");
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);

    // "Did this happen?" → Skip it (the Plan offers it on an unresolved session).
    const unresolved = await seedDocRow(addDays(DAY, -1), { completionState: "unresolved" });
    expect((await post(`/api/plan/workouts/${unresolved}/skip`)).status).toBe(200);
    expect(await rowOf(db, unresolved)).toMatchObject({ completionState: "skipped", resolutionDate: DAY });
    // Done is done: a completed session is never made skipped.
    const done = await seedDocRow(addDays(DAY, -2), { completionState: "completed" });
    expect(await skipWorkout(db, userId, done, { now: NOON, today: DAY, source: "app", prefs })).toEqual({ skipped: false });
    expect((await rowOf(db, done)).completionState).toBe("completed");
  });

  it("a skip of a day gone leaves its copy (the watch's history, as a missed session's)", async () => {
    const id = await seedDocRow(TOMORROW);
    const first = await provisionalCopy(id);
    // Two days on, "did this happen?" — Skip it.
    expect(await skipWorkout(db, userId, id, { now: NOON, today: IN_THREE, source: "app", prefs })).toEqual({ skipped: true });
    expect(await queuedOf(id)).toEqual([]);
    expect(await sentBuildIdOf(db, id)).toBe(first);
  });

  it("an un-skip of a day gone, or of an engine slot, marks nothing", async () => {
    const gone = await seedDocRow(addDays(DAY, -1), { completionState: "skipped", resolutionDate: addDays(DAY, -1) });
    await unskipWorkout(db, userId, gone, { now: NOON, today: DAY, source: "app" });
    expect(await intentOf(gone)).toBeUndefined();
    const slot = await seedDocRow(IN_TWO, { origin: "program", workoutDoc: null, workoutDocRev: null, completionState: "skipped" });
    await unskipWorkout(db, userId, slot, { now: NOON, today: DAY, source: "app" });
    expect(await intentOf(slot)).toBeUndefined();
  });

  it("the coach's skip (coach-apply) goes through skipWorkout: sanctioned, and the copy comes off", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);
    const out = await applyOps(db, userId, prefs, "prop-invented", [{ kind: "skip", workoutId: id, reason: "Rest." }]);
    expect(out.updated).toEqual([id]);
    expect(await rowOf(db, id)).toMatchObject({ completionState: "skipped", sanctionedBy: "coach", resolutionDate: DAY });
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
  });
});

describe("a remove", () => {
  it("unpushes the copy, as it always did", async () => {
    const id = await seedDocRow(IN_TWO);
    const first = await provisionalCopy(id);
    expect((await removeFromPlan(db, userId, id, { now: NOON, source: "remove_from_plan", prefs })).removed).toBe(true);
    expect(await queuedOf(id)).toEqual([`unpush:${first}`]);
    // The sweep never pushes a removed session: its owed mark (none here) or the window would refuse it.
    expect((await sweep()).queued).toBe(0);
  });
});

describe("the athlete's COROS writes off", () => {
  it("every hook queues nothing but records what is owed; switched on, the owed deletes run and the sweep queues the copies", async () => {
    const revised = await seedDocRow(IN_TWO);
    const moved = await seedDocRow(TOMORROW);
    const skipped = await seedDocRow(IN_THREE);
    const copies = { revised: await provisionalCopy(revised), moved: await provisionalCopy(moved), skipped: await provisionalCopy(skipped) };
    const off = writesOff();
    await savePreferences(db, userId, off);

    const made = (await createDocWorkout(db, userId, { date: addDays(DAY, 4), doc: calmDoc({ title: "Fresh" }) }, ctx({ prefs: off }))).workout.id;
    await reviseDocWorkout(db, userId, revised, { doc: revisedDoc(), baseRev: 1 }, ctx({ prefs: off }));
    await applyMove(db, { userId, workoutId: moved, toDate: addDays(DAY, 5), toTime: "18:00", source: "app", corosWritesEnabled: false });
    await skipWorkout(db, userId, skipped, { now: NOON, today: DAY, source: "app", prefs: off });
    await unskipWorkout(db, userId, skipped, { now: NOON, today: DAY, source: "app" });

    for (const id of [made, revised, moved, skipped]) expect(await queuedOf(id), id).toEqual([]);
    for (const id of [made, revised, moved, skipped]) expect(await owed(id), id).toBe(true);
    // The copies' deletes owed on their records, which stay the copies on the watch until they run.
    for (const [id, record] of [[revised, copies.revised], [moved, copies.moved], [skipped, copies.skipped]] as const) {
      expect((await buildOf(record)).payload, id).toHaveProperty("unpushOwedAt", NOON);
      expect(await sentBuildIdOf(db, id)).toBe(record);
    }
    // The sweep: nothing read, nothing queued, the marks kept.
    expect(await sweep(off)).toEqual({ queued: 0, attempted: 0, skipped: { writes_off: 1 } });
    for (const id of [made, revised, moved, skipped]) expect(await owed(id), id).toBe(true);

    // Switched on in Settings: the owed deletes are queued at once (`emitPendingWork`), the copies by the sweep.
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const res = await mountRoutes(db, "/api/settings", settingsRoutes).request(
      "/api/settings",
      { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ corosWritesEnabled: true }) },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await queuedOf(revised)).toEqual([`unpush:${copies.revised}`]);
    expect(await queuedOf(moved)).toEqual([`unpush:${copies.moved}`]);
    // The skip was undone before its delete ran: its copy is the one it had, and stays (current, nothing queued).
    expect(await queuedOf(skipped)).toEqual([`unpush:${copies.skipped}`]);
    let queued = 0;
    for (let i = 0; i < 4; i++) queued += (await sweep()).queued;
    expect(queued).toBe(3);
    for (const id of [made, revised, moved]) expect(await recordsOf(id), id).not.toHaveLength(0);
    for (const id of [made, revised, moved, skipped]) expect(await owed(id), id).toBe(false);
  });
});

describe("budgets (≤ 45 a request; the declared costs hold what the hooks add)", () => {
  it("a revise replacing a copy on the watch: within REVISE_BASE with the delete and the owed mark", async () => {
    const id = await seedDocRow(IN_TWO);
    await provisionalCopy(id);
    statements = [];
    await reviseDocWorkout(db, userId, id, { doc: revisedDoc(), baseRev: 1 }, ctx());
    console.info(`[budget] reviseDocWorkout, replacing a copy on the watch: ${statements.length} D1`);
    expect(REVISE_BASE).toBeLessThanOrEqual(REQUEST_BUDGET);
    // The approve reads the account's library with its plan read (`readPlan`); called alone, the revise reads it itself.
    const dayRows = 1;
    expect(statements.length).toBeLessThanOrEqual(REVISE_BASE + dayRows + 1);
  });

  it("an add at a time, a move, a skip and an un-skip: within their declared costs", async () => {
    statements = [];
    const made = (await createDocWorkout(db, userId, { date: IN_THREE, time: "07:00", doc: calmDoc() }, ctx())).workout.id;
    console.info(`[budget] createDocWorkout at a time: ${statements.length} D1`);
    expect(statements.length).toBeLessThanOrEqual(CREATE_AT_TIME_COST);
    expect(await owed(made)).toBe(true);

    const moving = await seedDocRow(TOMORROW);
    await provisionalCopy(moving);
    statements = [];
    await applyMove(db, { userId, workoutId: moving, toDate: IN_TWO, toTime: "18:00", source: "app", corosWritesEnabled: true });
    console.info(`[budget] applyMove of a document workout on the watch: ${statements.length} D1`);
    // MOVE_COST counts the applier's read beside applyMove's own.
    expect(statements.length).toBeLessThanOrEqual(MOVE_COST - 1);

    const skipping = await seedDocRow(IN_THREE);
    await provisionalCopy(skipping);
    statements = [];
    await skipWorkout(db, userId, skipping, { now: NOON, today: DAY, source: "coach", sanctionedBy: "coach", prefs });
    console.info(`[budget] skipWorkout of an app-built session on the watch: ${statements.length} D1`);
    // SKIP_COST counts the applier's read beside the write.
    expect(statements.length).toBeLessThanOrEqual(SKIP_COST - 1 + SKIP_UNPUSH_COST);

    statements = [];
    await unskipWorkout(db, userId, skipping, { now: NOON, today: DAY, source: "coach" });
    console.info(`[budget] unskipWorkout of a document workout ahead: ${statements.length} D1`);
    expect(statements.length).toBeLessThanOrEqual(RESTORE_COST - 1);
  });
});
