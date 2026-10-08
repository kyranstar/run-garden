/**
 * WHAT THE IMPORT DOES WITH A SENT SESSION (Phase 3 Task 7; spec §4.5; ruling 3-R9; Review Focus 2 and 5).
 *
 * Each case starts from a push the lane verified against the mock COROS, then reads COROS the way production does:
 * `corosReadNow` (the cron sweep's and Read now's path — `buildSnapshot` strips each workout's `raw`, which is how
 * "Changed in COROS" went dead live while a suite that imported `normalizeCorosSchedule` directly stayed green, audit
 * 3-A life L-8). A few cases still import the normalized schedule directly, where the read's window is the point.
 *
 *  - The content is never rewritten: the row keeps its build's title, category, sport, stages and summary; it
 *    records the new wire fingerprint, and a change against what the push OBSERVED posts one "Changed in COROS" note.
 *  - A move in COROS is adopted (the existing date adoption); the build stays locked.
 *  - Absent for two reads: the address is cleared and one "Removed from your watch" note posted. Never archived.
 *  - A copy the row never learned about (the executor died between write and record) is attached to its slot by its
 *    stamp, or unpushed when its slot is gone or holds another build. Never a new row.
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
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { buildSession, loadSession } from "../src/services/session-build.js";
import { activeSyncNotes } from "../src/services/sync-notes.js";
import { sendToWatch, takeOffWatch, watchStateOf } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { connectMock, DAY, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

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

/** A slot built today and sent, and — unless `run: false` — its push verified by the lane. */
async function pushed(opts: { run?: boolean; id?: string } = {}): Promise<{ workoutId: string; buildId: string; stamp: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY, opts.id);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  if (opts.run !== false) {
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  }
  const stamp = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name;
  return { workoutId, buildId, stamp };
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const programOn = (stamp: string): RawCorosProgram | undefined => (server.state.schedule.programs ?? []).find((p) => p.name === stamp);
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

/** A COROS read: the mock's schedule, normalized and imported directly, over a window the case chooses. */
async function importFromCoros() {
  const n = normalizeCorosSchedule(server.state.schedule);
  return importPlanSnapshot(
    db,
    { userId, plan: { sourcePlanId: n.planId, name: "Container" }, workouts: n.workouts, rangeStart: addDays(DAY, -7), rangeEnd: addDays(DAY, 30), source: "fixture" },
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

  it("(d) moved on COROS (Review Focus 2): the date follows, the build stays locked, still on the watch", async () => {
    const { workoutId, buildId, stamp } = await pushed();
    const LATER = addDays(DAY, 2);
    entityOf(programOn(stamp)!).happenDay = Number(localDateToCorosDay(LATER));
    await importFromCoros();
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ effectiveDate: LATER, lastVerifiedCorosDate: LATER, archivedAt: null });
    expect(await notesOf(workoutId, "adopted_coros_change")).toHaveLength(1);
    expect((await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId)))[0]!.lockedAt).not.toBeNull();
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
  });

  it("(e) deleted on COROS (Review Focus 2): after two reads the address is cleared and one note posted — never archived, nothing queued", async () => {
    const { workoutId, stamp } = await pushed();
    const program = programOn(stamp)!;
    server.state.schedule.entities = server.state.schedule.entities!.filter((e) => String(e.idInPlan) !== String(program.idInPlan));
    server.state.schedule.programs = server.state.schedule.programs!.filter((p) => p !== program);
    const jobsBefore = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).map((j) => [j.id, j.status]);
    await importFromCoros();
    expect((await rowOf(db, workoutId)).archivedAt).toBeNull();
    expect(await notesOf(workoutId)).toEqual([]);
    await importFromCoros();
    await importFromCoros();
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ archivedAt: null, lastVerifiedCorosDate: "", corosSyncState: "calendar_only", sourceWorkoutId: workoutId });
    expect(row.sourceIdInPlan).toBeNull();
    expect(await notesOf(workoutId, "watch_copy_removed")).toHaveLength(1);
    expect(await notesOf(workoutId)).toHaveLength(1);
    expect(await watchOf(workoutId)).toEqual({ state: "off_watch" });
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).map((j) => [j.id, j.status])).toEqual(jobsBefore);
  });

  async function writeWithoutRecording(): Promise<{ workoutId: string; buildId: string; stamp: string }> {
    // The executor dies between the write and the record: the copy is on COROS, the push still claimed.
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
