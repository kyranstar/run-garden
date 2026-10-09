/**
 * WHAT THE IMPORT DOES WITH A SENT SESSION (Phase 3 Task 7; spec §4.5; ruling 3-R9; Review Focus 2 and 5).
 *
 * Each case starts from a push the lane verified against the mock COROS, then reads COROS the way production does:
 * `corosReadNow` (the cron sweep's and Read now's path — `buildSnapshot` strips each workout's `raw`, which is how
 * "Changed in COROS" went dead live while a suite that imported `normalizeCorosSchedule` directly stayed green, audit
 * 3-A life L-8). A few cases import the normalized schedule directly (a full read) where the read path adds nothing.
 *
 *  - The content is never rewritten: the row keeps its build's title, category, sport, stages and summary; it
 *    records the new wire fingerprint, and a change against what the push OBSERVED posts one "Changed in COROS" note.
 *  - A move in COROS is adopted (the existing date adoption); the build stays locked; the note only informs (3-R15).
 *  - Absent for two FULL reads: the address is cleared and one "Removed from your watch" note posted. Never archived.
 *    A short read proves nothing (3-R16).
 *  - A copy the row never learned about (the executor died between write and record) — its stamp's ONLY carrier, on
 *    a full read — is attached to its slot, or unpushed (insert-only) when its slot is gone or holds another build.
 *    Never a new row. A second carrier is the athlete's own workout.
 *  - Only a push that may still hold a copy names a stamp: never a superseded, cancelled or restored one.
 *  - A program row claims a wire workout only by its own stamp: a recycled address is someone else's workout.
 *  - Take off watch: the unpush verified resets the address and supersedes the push; Send queues it afresh.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL, CorosClient, createWorkout } from "@rg/coros";
import { corosProgramFingerprint, localDateToCorosDay, normalizeCorosSchedule, type RawCorosProgram } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { corosReadNow, corosReadSweep } from "../src/services/coros-read.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { exerciseNameMap } from "../src/services/exercise-catalog.js";
import { applyOps } from "../src/services/coach-apply.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { buildSession, loadSession } from "../src/services/session-build.js";
import { activeSyncNotes, postSyncNote } from "../src/services/sync-notes.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { sendToWatch, takeOffWatch, watchStateOf } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import {
  connectMock, DAY, makeEnv, NOON, PROGRAM_NAME, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW,
} from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, providerConnections, sessionBuilds } = schema;

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

async function setup(make: () => MockCorosServer = () => mockCorosServer({ baseMonday: "2026-10-12" })) {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = make();
  await connectMock(db, userId, server);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

/** The lane, as the cron runs it — with the switch on unless the case says otherwise. */
const lane = (env = switchOn()) => executeCloudJobs(db, env, userId, prefs, { fetchImpl: server.fetchImpl });

/** The slot built on `day` (today, in the case's clock) and sent, and — unless `run: false` — its push verified. */
async function send(workoutId: string, day: string, opts: { run?: boolean } = {}): Promise<{ buildId: string; stamp: string }> {
  const at = { today: day, now: `${day}T19:00:00.000Z`, prefs };
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, at);
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, at);
  if (opts.run !== false) {
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  }
  const stamp = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name;
  return { buildId, stamp };
}

/** A slot built today and sent, and — unless `run: false` — its push verified by the lane. */
async function pushed(opts: { run?: boolean; id?: string } = {}): Promise<{ workoutId: string; buildId: string; stamp: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY, opts.id);
  return { workoutId, ...(await send(workoutId, DAY, opts)) };
}

/** The executor dies between the write and the record: the copy is on COROS, the push still claimed. */
async function writeWithoutRecording(): Promise<{ workoutId: string; buildId: string; stamp: string }> {
  const sent = await pushed({ run: false });
  const payload = programSessionPushJobSchema.parse((await jobOf(`push:${sent.buildId}`))!.payload);
  await db.update(corosWriteJobs).set({ status: "claimed" }).where(eq(corosWriteJobs.id, `push:${sent.buildId}`));
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
  await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
  const result = await createWorkout(
    client,
    { happenDay: String(localDateToCorosDay(payload.happenDay)), name: payload.name, session: payload.session },
    { catalog: await exerciseNameMap(db), today: DAY },
  );
  expect(result.ok).toBe(true);
  return sent;
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const programOn = (stamp: string): RawCorosProgram | undefined => (server.state.schedule.programs ?? []).find((p) => p.name === stamp);
const programsNamed = (name: string): RawCorosProgram[] => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const entityOf = (program: RawCorosProgram) =>
  server.state.schedule.entities!.find((e) => String(e.idInPlan) === String(program.idInPlan))!;

/**
 * The read's locale bundle. Real COROS stores a catalog move's name as an i18n key ("T1309" — the push writes the
 * catalog's own name, and the catalog's names ARE keys) and the read resolves stage names through this bundle; so a
 * text fingerprint taken over RESOLVED names would differ from the one the push observed on every read.
 */
const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training", T1309: "Scapular slide" };
const readFetch = (): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch;

/**
 * THE PRODUCTION READ (`corosReadNow`, forced as the cron sweep forces it). `full` reads COROS's whole 90-day span,
 * as the read does every six hours; `short` reads today-14 … today+7, as it does in between.
 */
async function readNow(span: "full" | "short" = "full") {
  const [conn] = await db.select().from(providerConnections).where(eq(providerConnections.userId, userId));
  const meta = { ...((conn!.meta ?? {}) as Record<string, unknown>) };
  if (span === "full") delete meta.lastFullScheduleAt;
  else meta.lastFullScheduleAt = new Date().toISOString();
  await db.update(providerConnections).set({ meta }).where(eq(providerConnections.id, conn!.id));
  expect((await corosReadNow(db, switchOn(), userId, prefs, { force: true, fetchImpl: readFetch() })).status).toBe("ok");
}

/** A full COROS read: the mock's whole schedule, normalized and imported directly. */
async function importFromCoros() {
  const n = normalizeCorosSchedule(server.state.schedule);
  return importPlanSnapshot(
    db,
    {
      userId, plan: { sourcePlanId: n.planId, name: "Container" }, workouts: n.workouts, rangeStart: addDays(DAY, -7), rangeEnd: addDays(DAY, 30),
      fullSchedule: true, source: "fixture",
    },
    prefs,
  );
}

const notesOf = async (workoutId: string, kind?: string) =>
  (await activeSyncNotes(db, userId)).filter((n) => n.workoutId === workoutId && (kind === undefined || n.kind === kind));
const contentOf = async (workoutId: string) => {
  const r = await rowOf(db, workoutId);
  const stages = await db.select().from(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, workoutId));
  return { title: r.title, category: r.category, sport: r.sport, stageSummary: r.stageSummary, stages: stages.length };
};
const watchOf = async (workoutId: string) =>
  watchStateOf(db, switchOn(), userId, await rowOf(db, workoutId), await loadSession(db, userId, workoutId, DAY), prefs);
const rowsTitled = async (title: string) =>
  db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.title, title)));

describe("(a) a COROS that re-encodes what it stores (Review Focus 5)", () => {
  beforeEach(() => setup(() => renormalizingCoros({ baseMonday: "2026-10-12" })));

  it("posts no note and rewrites nothing, across three production reads", async () => {
    const { workoutId, stamp } = await pushed();
    const before = await contentOf(workoutId);
    await readNow();
    await readNow("short");
    await readNow();
    expect(await notesOf(workoutId)).toEqual([]);
    expect(await contentOf(workoutId)).toEqual(before);
    expect(await rowsTitled(stamp)).toEqual([]);
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
  });

  it("a step renamed in COROS: exactly one 'Changed in COROS' across three production reads", async () => {
    const { workoutId, stamp } = await pushed();
    await readNow();
    const step = programOn(stamp)!.exercises!.find((e) => e.isGroup !== true && Number(e.exerciseType) !== 0)!;
    step.name = "Renamed in COROS";
    await readNow();
    await readNow("short");
    await readNow();
    expect((await notesOf(workoutId)).map((n) => n.kind)).toEqual(["watch_copy_changed"]);
  });

  it("sets changed in COROS: exactly one note, through the cron sweep", async () => {
    const { workoutId, stamp } = await pushed();
    const step = programOn(stamp)!.exercises!.find((e) => e.isGroup !== true && Number(e.exerciseType) !== 0)!;
    step.sets = Number(step.sets ?? 1) + 2;
    vi.stubGlobal("fetch", readFetch());
    try {
      await corosReadSweep(db, switchOn());
      await corosReadSweep(db, switchOn());
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await notesOf(workoutId)).map((n) => n.kind)).toEqual(["watch_copy_changed"]);
  });
});

describe("the import and a sent session", () => {
  beforeEach(() => setup());

  it("(b) a step renamed on COROS: content kept, the new wire fingerprint recorded, one 'Changed in COROS' note", async () => {
    const { workoutId, stamp } = await pushed();
    const before = await contentOf(workoutId);
    const program = programOn(stamp)!;
    const step = program.exercises!.find((e) => e.isGroup !== true)!;
    step.name = "Renamed in COROS";
    step.originId = "0";
    await readNow();
    expect(await contentOf(workoutId)).toEqual(before);
    expect((await rowOf(db, workoutId)).sourceContentFingerprint).toBe(corosProgramFingerprint(program));
    expect(await notesOf(workoutId, "watch_copy_changed")).toHaveLength(1);
    // The same read again tells the athlete nothing new.
    await readNow();
    expect(await notesOf(workoutId, "watch_copy_changed")).toHaveLength(1);
    expect(await notesOf(workoutId)).toHaveLength(1);
  });

  it("(b) a target changed on COROS (the wire fingerprint moves): one note, the content kept", async () => {
    const { workoutId, stamp } = await pushed();
    const before = await contentOf(workoutId);
    const program = programOn(stamp)!;
    const step = program.exercises!.find((e) => e.isGroup !== true)!;
    step.targetValue = Number(step.targetValue ?? 0) + 3;
    await readNow();
    expect(await contentOf(workoutId)).toEqual(before);
    expect((await rowOf(db, workoutId)).sourceContentFingerprint).toBe(corosProgramFingerprint(program));
    expect(await notesOf(workoutId, "watch_copy_changed")).toHaveLength(1);
    await readNow();
    expect(await notesOf(workoutId, "watch_copy_changed")).toHaveLength(1);
  });

  it("(c) the wording heal never touches the row", async () => {
    const { workoutId } = await pushed();
    await db.update(plannedWorkouts).set({ stageSummary: "the app's own words" }).where(eq(plannedWorkouts.id, workoutId));
    await importFromCoros();
    expect((await rowOf(db, workoutId)).stageSummary).toBe("the app's own words");
  });

  it("(d) moved on COROS (Review Focus 2): the date follows, the build stays locked, still on the watch — and the note only informs", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const LATER = addDays(DAY, 2);
    entityOf(programOn(stamp)!).happenDay = Number(localDateToCorosDay(LATER));
    await readNow();
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ effectiveDate: LATER, lastVerifiedCorosDate: LATER, archivedAt: null });
    // Ruling 3-R15: "Moved to … on your watch", dismiss-only — an Undo would take the copy off the watch.
    const notes = await notesOf(workoutId);
    expect(notes.map((n) => [n.kind, n.payload])).toEqual([["watch_copy_moved", { previousDate: DAY, newDate: LATER }]]);
    expect((await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId)))[0]!.lockedAt).not.toBeNull();
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
  });

  it("(d) Undo on a sent session's move note answers 422 not_undoable, and nothing comes off the watch (3-R15)", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const LATER = addDays(DAY, 1);
    entityOf(programOn(stamp)!).happenDay = Number(localDateToCorosDay(LATER));
    await readNow();
    const moved = (await notesOf(workoutId, "watch_copy_moved"))[0]!;
    // A note posted before 3-R15 shipped, of the kind that offered Undo: the route is the backstop.
    const legacy = await postSyncNote(db, { userId, workoutId, kind: "adopted_coros_change", payload: { previousDate: DAY, newDate: LATER } });
    const app = mountRoutes(db, "/api/sync", syncRoutes);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    for (const id of [moved.id, legacy]) {
      const res = await app.request(`/api/sync/notes/${id}/undo`, { method: "POST", headers: { Cookie: cookie } }, switchOn());
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "not_undoable" });
    }
    await lane();
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect(programsNamed(stamp)).toHaveLength(1);
    expect(await rowOf(db, workoutId)).toMatchObject({ effectiveDate: LATER, lastVerifiedCorosDate: LATER });
    expect((await notesOf(workoutId)).map((n) => n.id).sort()).toEqual([moved.id, legacy].sort());
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
  });

  it("(e) deleted on COROS (Review Focus 2): after two FULL reads the address is cleared and one note posted — never archived, nothing queued", async () => {
    const { workoutId, stamp } = await pushed();
    const address = (await rowOf(db, workoutId)).sourceWorkoutId;
    const program = programOn(stamp)!;
    server.state.schedule.entities = server.state.schedule.entities!.filter((e) => String(e.idInPlan) !== String(program.idInPlan));
    server.state.schedule.programs = server.state.schedule.programs!.filter((p) => p !== program);
    const jobsBefore = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).map((j) => [j.id, j.status]);
    // Ruling 3-R16: a short read proves no absence, however many of them.
    for (let i = 0; i < 3; i++) await readNow("short");
    expect(await rowOf(db, workoutId)).toMatchObject({ sourceWorkoutId: address, missingReads: 0 });
    expect(await notesOf(workoutId)).toEqual([]);
    await readNow();
    expect((await rowOf(db, workoutId)).archivedAt).toBeNull();
    expect(await notesOf(workoutId)).toEqual([]);
    await readNow();
    await readNow();
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ archivedAt: null, lastVerifiedCorosDate: "", corosSyncState: "calendar_only", sourceWorkoutId: workoutId });
    expect(row.sourceIdInPlan).toBeNull();
    expect(await notesOf(workoutId, "watch_copy_removed")).toHaveLength(1);
    expect(await notesOf(workoutId)).toHaveLength(1);
    expect(await watchOf(workoutId)).toEqual({ state: "off_watch" });
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).map((j) => [j.id, j.status])).toEqual(jobsBefore);
  });

  it("(f) a copy the row never learned about is attached to its slot by its stamp — never a new row", async () => {
    const { workoutId, stamp } = await writeWithoutRecording();
    expect(watchOf).toBeDefined();
    await importFromCoros();
    const program = programOn(stamp)!;
    const entity = entityOf(program);
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({
      sourceWorkoutId: `${server.state.schedule.id}:${entity.idInPlan}`,
      sourceIdInPlan: String(entity.idInPlan),
      sourceProgramId: String(entity.planProgramId ?? entity.idInPlan),
      lastVerifiedCorosDate: DAY,
    });
    expect(await rowsTitled(stamp)).toEqual([]);
    expect(
      await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.sourceWorkoutId, row.sourceWorkoutId))),
    ).toHaveLength(1);
  });

  it("(f) its slot gone: no new row, and unpush:<buildId> takes the stamp from the push and the address from the wire", async () => {
    const { workoutId, buildId, stamp } = await writeWithoutRecording();
    await removeFromPlan(db, userId, workoutId, { now: NOON, source: "remove_from_plan", prefs });
    await importFromCoros();
    const entity = entityOf(programOn(stamp)!);
    expect(await rowsTitled(stamp)).toEqual([]);
    const unpush = await jobOf(`unpush:${buildId}`);
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued", workoutId });
    expect(unpush!.payload).toEqual({
      workoutId,
      happenDay: DAY,
      name: stamp,
      idInPlan: String(entity.idInPlan),
      programId: String(entity.planProgramId ?? entity.idInPlan),
      corosPlanId: String(server.state.schedule.id),
    });
    // The lane takes it off.
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(programOn(stamp)).toBeUndefined();
  });

  it("(f) its slot holding another locked build: no new row, the copy is unpushed", async () => {
    const { workoutId, buildId, stamp } = await writeWithoutRecording();
    await db.update(sessionBuilds).set({ lockedAt: null }).where(eq(sessionBuilds.id, buildId));
    await db.insert(sessionBuilds).values({
      id: "another-build", userId, workoutId, version: 50, engineVersion: "x", inputsHash: "x", payload: {}, lockedAt: NOON, createdAt: NOON,
    });
    await importFromCoros();
    expect(await rowsTitled(stamp)).toEqual([]);
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
  });

  it("(g) the old address recycled for a foreign workout: the program row is not its claimant", async () => {
    const { workoutId, stamp } = await pushed();
    const before = await contentOf(workoutId);
    const program = programOn(stamp)!;
    // COROS deleted our copy and put an athlete's own run in the same slot.
    program.name = "Hill repeats";
    program.sportType = 1;
    program.exercises = [{ id: 1, name: "T3001", exerciseType: 2, targetType: 2, targetValue: 1800, sortNo: 16777216, groupId: "0" }];
    await importFromCoros();
    expect(await contentOf(workoutId)).toEqual(before);
    const foreign = await rowsTitled("Hill repeats");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ sport: "run", origin: null });
    expect(await notesOf(workoutId, "watch_copy_changed")).toEqual([]);
  });
});

describe("(h) Take off watch, then Send again", () => {
  beforeEach(() => setup());

  it("the verified unpush resets the address and supersedes the push; Send queues it afresh and it creates anew", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    await takeOffWatch(db, userId, workoutId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(programOn(stamp)).toBeUndefined();
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ sourceWorkoutId: workoutId, sourceIdInPlan: null, sourceProgramId: null, lastVerifiedCorosDate: "" });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(await watchOf(workoutId)).toEqual({ state: "ready" });

    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    const writes = server.counts.scheduleWrites;
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(server.counts.scheduleWrites).toBe(writes + 1);
    expect(programOn(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name)).toBeDefined();
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
  });

  it("an unpush that fails leaves the push verified, and the next import still recognises the stamp", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    server.deleteRejectResult = "1031";
    await takeOffWatch(db, userId, workoutId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(programOn(stamp)).toBeDefined();
    await importFromCoros();
    expect(await rowsTitled(stamp)).toEqual([]);
    expect((await rowOf(db, workoutId)).sourceIdInPlan).not.toBeNull();
    expect(await notesOf(workoutId)).toEqual([]);
  });
});

/**
 * WHICH STAMPS ARE STILL OURS (audit 3-A life L-1(a), V1b, L-7). Only a push that may still hold a copy names one —
 * queued, claimed, in progress, verifying, verified, failed or needing attention; never one superseded (its copy was
 * proven gone), cancelled, or neutralised by a restore. A row of the athlete's or the coach's keeps a workout its own
 * verified create stamped. And the read never revives an unpush: what it queues, it only ever inserts.
 */
describe("the stamps the read may act on", () => {
  beforeEach(() => setup());

  const liftAdd = (title: string, date: string) => ({
    kind: "add",
    date,
    session: {
      category: "strength",
      title,
      durationMinutes: 30,
      lift: { exercises: [{ originId: "4258276155475001301", name: "Goblet Squat", sets: 3, reps: 8, weight: { type: "bodyweight" }, restSeconds: 60 }] },
    },
  });
  /**
   * The coach adds a session titled like the program on its day, its create stamped exactly like the sent copy. The
   * stamp chooser (3-R12) keeps a coach stamp off a push that may still hold a copy; the name is pinned here so the
   * import's own rule is what the case proves.
   */
  async function coachAddsSameStamp(stamp: string): Promise<string> {
    const coachId = (await applyOps(db, userId, prefs, "prop-coach", [liftAdd(PROGRAM_NAME, DAY) as never])).created[0]!;
    const [job] = await db
      .select()
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.workoutId, coachId), eq(corosWriteJobs.kind, "coach_create_workout")));
    await db
      .update(corosWriteJobs)
      .set({ payload: { ...(job!.payload as Record<string, unknown>), name: stamp } })
      .where(eq(corosWriteJobs.id, job!.id));
    return coachId;
  }

  it("taken off, then the coach adds the program's title that day: the read leaves the coach's workout alone (switch off)", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    await takeOffWatch(db, userId, workoutId, ctx());
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    const coachId = await coachAddsSameStamp(stamp);
    const OFF = makeEnv(); // WATCH_PUSH_ENABLED absent, as in production today
    await lane(OFF);
    const coachAddress = (await rowOf(db, coachId)).sourceWorkoutId;
    expect(coachAddress).not.toBe(coachId);
    expect(programsNamed(stamp)).toHaveLength(1);

    await readNow();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    await lane(OFF);
    await readNow();
    await readNow();
    expect(programsNamed(stamp)).toHaveLength(1);
    expect(await rowOf(db, coachId)).toMatchObject({ sourceWorkoutId: coachAddress, archivedAt: null });
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
  });

  it("a spent stamp: after Take off, a COROS workout carrying it is the athlete's — imported, never unpushed", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const program = structuredClone(programOn(stamp)!);
    const entity = structuredClone(entityOf(programOn(stamp)!));
    await takeOffWatch(db, userId, workoutId, ctx());
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    // The athlete makes the same workout again in COROS, under the very name.
    server.state.schedule.programs!.push({ ...program, idInPlan: "99", id: "9999" });
    server.state.schedule.entities!.push({ ...entity, idInPlan: "99", planProgramId: "99" });
    const writes = server.counts.scheduleWrites;
    await readNow();
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(server.counts.scheduleWrites).toBe(writes);
    const theirs = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) =>
      r.sourceWorkoutId.endsWith(":99"),
    );
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ origin: null, effectiveDate: DAY, archivedAt: null });
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
  });

  it("a failed push never claims a coach workout carrying its stamp", async () => {
    server.addSilentlyFails = true; // COROS answers 0000 and keeps nothing: not_visible, three times
    const { workoutId, buildId, stamp } = await pushed({ run: false });
    for (let i = 0; i < 4 && (await jobOf(`push:${buildId}`))!.status !== "failed"; i++) await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("failed");
    server.addSilentlyFails = false;
    const coachId = await coachAddsSameStamp(stamp);
    await lane();
    const coachAddress = (await rowOf(db, coachId)).sourceWorkoutId;
    expect(coachAddress).not.toBe(coachId);

    await readNow();
    await readNow();
    await readNow();
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
    expect(await rowOf(db, coachId)).toMatchObject({ sourceWorkoutId: coachAddress, archivedAt: null });
    expect(programsNamed(stamp)).toHaveLength(1);
  });

  it("a push the restore neutralised names nothing: the read neither attaches nor unpushes its copy", async () => {
    const { workoutId, buildId, stamp } = await writeWithoutRecording();
    await db.update(corosWriteJobs).set({ status: "restored" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const writes = server.counts.scheduleWrites;
    await readNow();
    await lane();
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
    expect(server.counts.scheduleWrites).toBe(writes);
    expect(programsNamed(stamp)).toHaveLength(1);
  });

  it("a stale copy still comes off: moved while COROS writes were off, the slot sent again the next day (V10b)", async () => {
    const { workoutId, stamp } = await pushed();
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: false });
    // Writes back on (Send needs them): the Settings toggle's catch-up pass queues the unpush owed meanwhile (L-10).
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    vi.setSystemTime(new Date(`${TOMORROW}T19:00:00.000Z`));
    const resent = await send(workoutId, TOMORROW);
    for (let i = 0; i < 2; i++) {
      await readNow();
      await lane();
    }
    expect(programsNamed(stamp)).toEqual([]);
    expect(programsNamed(resent.stamp)).toHaveLength(1);
  });

  it("an unpush that failed for good is never revived by a read: no COROS write across three reads (L-7)", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    server.deleteRejectResult = "1031";
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    for (let i = 0; i < 4 && (await jobOf(`unpush:${buildId}`))!.status !== "failed"; i++) await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
    // Tomorrow: the slot is built and sent on its new day; the old copy is still on COROS under its own stamp.
    vi.setSystemTime(new Date(`${TOMORROW}T19:00:00.000Z`));
    const resent = await send(workoutId, TOMORROW);
    expect(resent.stamp).not.toBe(stamp);
    expect(programsNamed(stamp)).toHaveLength(1);

    const writes = server.counts.scheduleWrites;
    for (let i = 0; i < 3; i++) {
      await readNow();
      expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
      await lane();
    }
    expect(server.counts.scheduleWrites).toBe(writes);
    expect(programsNamed(stamp)).toHaveLength(1);
  });
});

/**
 * TWO COROS WORKOUTS CARRYING ONE STAMP (audit 3-A life L-3). The athlete copies the sent session in the COROS app and
 * the copy keeps its name. The slot keeps its recorded copy while that address still carries its stamp; the other is
 * the athlete's own workout — imported as an ordinary COROS session, never attached to the slot, never taken off. A
 * workout is only ever an orphan of ours when it is the ONLY one in the read carrying the stamp.
 */
describe("two COROS workouts carrying one stamp", () => {
  beforeEach(() => setup());

  const LATER = addDays(DAY, 3);
  const rowsAt = async (address: string) =>
    (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.sourceWorkoutId === address);
  /** The athlete copies the sent session to `day` in the COROS app: a new workout (its own program id), same name. */
  function athleteCopies(stamp: string, day = LATER): string {
    const original = programOn(stamp)!;
    server.state.schedule.programs!.push({ ...structuredClone(original), idInPlan: "99", id: "9999" });
    server.state.schedule.entities!.push({
      ...structuredClone(entityOf(original)), idInPlan: "99", planProgramId: "99", happenDay: Number(localDateToCorosDay(day)),
    });
    return `${server.state.schedule.id}:99`;
  }

  // The copy on the SAME day (re-review A-3): the unpush deletes only the copy at the address the slot recorded.
  it("a same-day copy survives Take off: only the slot's recorded copy comes off", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const theirs = athleteCopies(stamp, DAY);
    await readNow();
    await takeOffWatch(db, userId, workoutId, ctx());
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(programsNamed(stamp).map((p) => String(p.idInPlan))).toEqual(["99"]);
    for (let i = 0; i < 2; i++) await readNow();
    expect(await rowsAt(theirs)).toEqual([expect.objectContaining({ origin: null, effectiveDate: DAY, archivedAt: null })]);
  });

  it("a same-day copy survives an app move of the slot", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    athleteCopies(stamp, DAY);
    await readNow();
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(programsNamed(stamp).map((p) => String(p.idInPlan))).toEqual(["99"]);
  });

  it("the slot keeps its recorded copy, the second is the athlete's, and it survives an app move", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const recorded = (await rowOf(db, workoutId)).sourceWorkoutId;
    const theirs = athleteCopies(stamp);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await readNow();
      const r = await rowOf(db, workoutId);
      seen.push(`${r.sourceWorkoutId}@${r.lastVerifiedCorosDate}`);
    }
    expect(seen).toEqual(Array(4).fill(`${recorded}@${DAY}`));
    expect(await rowsAt(theirs)).toEqual([expect.objectContaining({ origin: null, effectiveDate: LATER, archivedAt: null })]);
    expect((await rowsAt(theirs))[0]!.title).not.toBe(stamp); // the stamp is plumbing, never a session's name
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();

    // The athlete moves the session in the app: only the recorded copy comes off the watch.
    await applyMove(db, { userId, workoutId, toDate: TOMORROW, toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.payload).toMatchObject({ idInPlan: recorded.split(":")[1], happenDay: DAY });
    await lane();
    expect(programsNamed(stamp).map((p) => String(p.idInPlan))).toEqual(["99"]);
    for (let i = 0; i < 2; i++) {
      await readNow();
      await lane();
    }
    expect(programsNamed(stamp).map((p) => String(p.idInPlan))).toEqual(["99"]);
    expect(await rowsAt(theirs)).toEqual([expect.objectContaining({ origin: null, effectiveDate: LATER, archivedAt: null })]);
  });

  it("the athlete then deletes the original: the copy stays theirs — never attached, never taken off", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const theirs = athleteCopies(stamp);
    await readNow();
    expect(await rowsAt(theirs)).toHaveLength(1);
    const original = programOn(stamp)!;
    server.state.schedule.entities = server.state.schedule.entities!.filter((e) => String(e.idInPlan) !== String(original.idInPlan));
    server.state.schedule.programs = server.state.schedule.programs!.filter((p) => p !== original);
    for (let i = 0; i < 3; i++) {
      await readNow();
      await lane();
    }
    expect(programsNamed(stamp).map((p) => String(p.idInPlan))).toEqual(["99"]);
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
    expect(await rowsAt(theirs)).toEqual([expect.objectContaining({ origin: null, effectiveDate: LATER, archivedAt: null })]);
    expect(await notesOf(workoutId, "watch_copy_removed")).toHaveLength(1);
  });
});

/**
 * ABSENCE IS ONLY PROVABLE ON A FULL READ (audit 3-A life L-6; ruling 3-R16). Between its six-hourly full reads the
 * read covers today-14 … today+7 only, so a sent copy the athlete moved further out in COROS is simply outside the
 * window: it counts as missing only on a full read, and the orphan path — which decides a copy is its stamp's only
 * carrier — acts only on one too. A copy that comes back after a "Removed from your watch" is re-attached: the slot
 * moves to the copy's day and the false note is dismissed.
 */
describe("absence and the read's window", () => {
  beforeEach(() => setup());

  it("moved in COROS beyond the short read: no 'Removed from your watch'; the next full read follows it", async () => {
    const { workoutId, stamp } = await pushed();
    await readNow();
    const address = (await rowOf(db, workoutId)).sourceWorkoutId;
    const FAR = addDays(DAY, 10);
    entityOf(programOn(stamp)!).happenDay = Number(localDateToCorosDay(FAR));
    for (let i = 0; i < 3; i++) await readNow("short");
    expect(await notesOf(workoutId)).toEqual([]);
    expect(await rowOf(db, workoutId)).toMatchObject({ sourceWorkoutId: address, effectiveDate: DAY });
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });

    await readNow();
    expect(await rowOf(db, workoutId)).toMatchObject({ sourceWorkoutId: address, effectiveDate: FAR, lastVerifiedCorosDate: FAR });
    expect((await notesOf(workoutId)).map((n) => [n.kind, n.payload])).toEqual([["watch_copy_moved", { previousDate: DAY, newDate: FAR }]]);
  });

  it("a copy back after 'Removed from your watch' is re-attached: the slot moves to its day, the false note goes", async () => {
    const { workoutId, stamp } = await pushed();
    const address = (await rowOf(db, workoutId)).sourceWorkoutId;
    const program = programOn(stamp)!;
    const entity = entityOf(program);
    // Two full reads that miss it (a read the size of COROS's whole schedule can still come back short).
    server.state.schedule.entities = server.state.schedule.entities!.filter((e) => e !== entity);
    server.state.schedule.programs = server.state.schedule.programs!.filter((p) => p !== program);
    await readNow();
    await readNow();
    expect((await rowOf(db, workoutId)).sourceWorkoutId).toBe(workoutId);
    expect(await notesOf(workoutId, "watch_copy_removed")).toHaveLength(1);

    const LATER = addDays(DAY, 2);
    server.state.schedule.programs!.push(program);
    server.state.schedule.entities!.push({ ...entity, happenDay: Number(localDateToCorosDay(LATER)) });
    await readNow();
    expect(await rowOf(db, workoutId)).toMatchObject({ sourceWorkoutId: address, effectiveDate: LATER, lastVerifiedCorosDate: LATER });
    expect((await notesOf(workoutId)).map((n) => [n.kind, n.payload])).toEqual([["watch_copy_moved", { previousDate: DAY, newDate: LATER }]]);
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
    await readNow();
    expect(await notesOf(workoutId)).toHaveLength(1);
  });

  it("a short read neither attaches nor takes off a copy the slot never learned about; a full read does", async () => {
    const { workoutId, buildId } = await writeWithoutRecording();
    await removeFromPlan(db, userId, workoutId, { now: NOON, source: "remove_from_plan", prefs });
    await readNow("short");
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.origin === null && r.effectiveDate === DAY)).toEqual([]);
    await readNow();
    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
  });
});

/**
 * A SENT COPY RENAMED IN THE COROS APP (audit 3-A life L-5). It no longer carries the stamp, so it read as an ordinary
 * COROS workout — a second row of the session that day — while the slot, its stamp gone, posted "Removed from your
 * watch". When no workout of the read carries the slot's stamp but one sits at the slot's RECORDED address, on its
 * recorded day, with its recorded program id (and no sport of another kind), that is the copy, renamed: it stays the
 * slot's — no new row, no "Removed" — its new name is recorded on the push, and Take off still takes it off.
 */
describe("a sent copy renamed in the COROS app (audit 3-A life L-5)", () => {
  beforeEach(() => setup());
  const RENAMED = "Leg day at home";

  it("stays the slot's across short and full reads: no second row, no 'Removed from your watch', the new name recorded", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const before = await rowOf(db, workoutId);
    programOn(stamp)!.name = RENAMED;
    await readNow("short");
    await readNow();
    await readNow("short");
    await readNow();
    await readNow();
    expect(await rowsTitled(RENAMED)).toEqual([]);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.effectiveDate === DAY)).toHaveLength(1);
    expect(await rowOf(db, workoutId)).toMatchObject({
      archivedAt: null,
      sourceWorkoutId: before.sourceWorkoutId,
      sourceIdInPlan: before.sourceIdInPlan,
      lastVerifiedCorosDate: DAY,
      title: before.title,
    });
    expect(await notesOf(workoutId, "watch_copy_removed")).toEqual([]);
    expect((await notesOf(workoutId)).filter((n) => n.kind !== "watch_copy_changed")).toEqual([]);
    expect((await notesOf(workoutId, "watch_copy_changed")).length).toBeLessThanOrEqual(1);
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
    const payload = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
    expect(payload).toMatchObject({ name: stamp, renamed: RENAMED });
  });

  it("Take off after the rename: the unpush addresses the copy by its new name; it comes off, the slot is ready", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    programOn(stamp)!.name = RENAMED;
    await readNow();
    await takeOffWatch(db, userId, workoutId, ctx());
    expect((await jobOf(`unpush:${buildId}`))!.payload).toMatchObject({ name: RENAMED });
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(programsNamed(RENAMED)).toEqual([]);
    expect(await rowOf(db, workoutId)).toMatchObject({ sourceWorkoutId: workoutId, sourceIdInPlan: null, lastVerifiedCorosDate: "" });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(await watchOf(workoutId)).toEqual({ state: "ready" });
  });

  it("not the copy: another program id at the address (a recycled slot) — never claimed, and the slot's copy is gone", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const program = programOn(stamp)!;
    program.name = RENAMED;
    entityOf(program).planProgramId = "99991";
    // Two full reads of COROS's whole schedule, imported as the read imports them.
    await importFromCoros();
    await importFromCoros();
    expect(await rowsTitled(RENAMED)).toHaveLength(1);
    expect((await rowsTitled(RENAMED))[0]).toMatchObject({ origin: null });
    expect(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).renamed).toBeUndefined();
    expect(await notesOf(workoutId, "watch_copy_removed")).toHaveLength(1);
    expect(await watchOf(workoutId)).toEqual({ state: "off_watch" });
  });

  it("not the copy while the stamp is still carried: a same-day copy made in the app keeps the stamp, the renamed one is the athlete's", async () => {
    const { workoutId, stamp } = await pushed();
    const program = programOn(stamp)!;
    const entity = entityOf(program);
    // The athlete duplicated the session in the COROS app (the duplicate keeps the stamp), then renamed the original.
    const twinId = String(Number(program.idInPlan) + 50);
    server.state.schedule.programs!.push({ ...JSON.parse(JSON.stringify(program)), idInPlan: twinId, name: stamp });
    server.state.schedule.entities!.push({ ...entity, idInPlan: twinId, planProgramId: twinId });
    program.name = RENAMED;
    await readNow();
    expect(await rowsTitled(RENAMED)).toHaveLength(1);
    expect(await notesOf(workoutId, "watch_copy_removed")).toEqual([]);
  });
});
