/**
 * A REVIVED OUTLINE HOLDS NO COPY. A course's session written and on the watch, taken off the same day it comes back: a pause
 * lifted, or a stop and a restart. What comes back is an outline, as fresh as one never written, so the plan never reads a copy
 * under a name at an address on it. The copy itself is the delete's, already on its way with its own address, which is why
 * clearing the row strands nothing, whichever lands first: the delete goes on the payload's address, and with the writes off the
 * address goes with the delete that's owed.
 *
 * Every case runs the real lane against the mock COROS, on a made-up course (`course-fixture.ts`). Fixed dates under a faked
 * `Date`. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, adaptiveConfigSchema, programSessionPushJobSchema, type SourceActivity, type UserPreferences } from "@rg/domain";
import { localDateToCorosDay, normalizeCorosSchedule, type RawCorosProgram } from "@rg/providers";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { ingestActivities } from "../src/services/completion.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { startCourse, stopCourse } from "../src/services/course-plans.js";
import { writeCourseSession } from "../src/services/course-sessions.js";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { emitPendingWork } from "../src/services/jobs.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { mirrorIntentId } from "../src/services/mirror-owed.js";
import { courseSessionsDone, placeSlots, slotId } from "../src/services/program-slots.js";
import { activeSyncNotes } from "../src/services/sync-notes.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { INTRO_COURSE, INTRO_FIRST_SECONDS } from "./course-fixture.js";
import { connectMock, rowOf, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";

const { corosWriteJobs, plannedWorkouts, programs, sessionBuilds, syncIntents } = schema;

vi.setConfig({ testTimeout: 30_000 });

/** A Monday, and noon on it in the test user's zone. */
const MON = "2026-10-05";
const NOW = `${MON}T19:00:00.000Z`;
const BODY = { course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30" };

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: MockCorosServer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedCatalog(db);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
});

afterEach(() => {
  vi.useRealTimers();
});

const ctx = (at: UserPreferences = prefs) => ({ today: MON, now: NOW, prefs: at });
const writesOff = (): UserPreferences => ({ ...prefs, corosWritesEnabled: false });
const lane = () => executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const planRow = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const setPause = (id: string, until: string | null) => db.update(programs).set({ pausedUntil: until }).where(eq(programs.id, id));
const programOn = (name: string): RawCorosProgram | undefined => (server.state.schedule.programs ?? []).find((p) => p.name === name);
const entityAt = (idInPlan: string) => (server.state.schedule.entities ?? []).find((e) => String(e.idInPlan) === idInPlan);
/** The programs on the watch that are this course's sessions. */
const courseCopies = () => (server.state.schedule.programs ?? []).filter((p) => (p.name ?? "").startsWith("Intro "));

/** What an outline holds of the watch: none of it, as `freshRow` writes it. */
const noCopy = (id: string) => ({ sourceWorkoutId: id, sourceIdInPlan: null, sourceProgramId: null, watchCopyName: null, corosSyncState: "calendar_only", lastVerifiedCorosDate: "" });

/** The plan's words on the row: "Older on watch" is `content_stale`. */
async function viewOf(id: string): Promise<string | undefined> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}`, { headers: { Cookie: cookie } }, switchOn());
  expect(res.status).toBe(200);
  return ((await res.json()) as { workout: { corosSyncView?: string } }).workout.corosSyncView;
}

/** A full COROS read: the mock's whole schedule, normalized and imported. */
async function fullRead() {
  const n = normalizeCorosSchedule(server.state.schedule);
  return importPlanSnapshot(
    db,
    { userId, plan: { sourcePlanId: n.planId, name: "Container" }, workouts: n.workouts, rangeStart: addDays(MON, -7), rangeEnd: addDays(MON, 30), fullSchedule: true, source: "fixture" },
    prefs,
  );
}

const notesOf = async (id: string) => (await activeSyncNotes(db, userId)).filter((n) => n.workoutId === id);

const activity = (id: string, program: string): SourceActivity => ({
  provider: "coros",
  providerActivityId: id,
  startTime: "2026-10-06T02:30:00Z",
  startTimeLocal: `${MON}T19:30:00`,
  sport: "strength",
  durationSeconds: INTRO_FIRST_SECONDS,
  contentFingerprint: `fp-${id}`,
  sourcePlannedWorkoutId: program,
});

/** A course running, today's session written, and its copy on the watch: the real push, verified by the real lane. */
async function copyOnWatch() {
  const started = await startCourse(db, userId, BODY, ctx(), Number.POSITIVE_INFINITY);
  if (!started.ok) throw new Error(started.error);
  const p = started.planId;
  const id = slotId(p, MON);
  expect((await writeCourseSession(db, userId, await rowOf(db, id), ctx())).written).toBe(true);
  expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
  await lane();
  const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
  const buildId = record!.id;
  const push = await jobOf(`push:${buildId}`);
  expect(push!.status).toBe("verified");
  const stamp = programSessionPushJobSchema.parse(push!.payload).name;
  const was = await rowOf(db, id);
  expect(was.corosSyncState).toBe("synced");
  expect(was.sourceProgramId).not.toBeNull();
  expect(programOn(stamp)).toBeDefined();
  return { p, id, buildId, stamp, idInPlan: was.sourceIdInPlan!, programId: was.sourceProgramId!, address: was.sourceWorkoutId };
}

/** How a session comes off and comes back the same day. */
const PATHS: Array<[string, { off: (p: string, at?: UserPreferences) => Promise<void>; back: (p: string, at?: UserPreferences) => Promise<void> }]> = [
  [
    "a pause lifted the same day",
    {
      off: async (p, at = prefs) => {
        await setPause(p, MON);
        await placeSlots(db, userId, p, MON, at, NOW);
      },
      back: async (p, at = prefs) => {
        await setPause(p, null);
        await placeSlots(db, userId, p, MON, at, NOW);
      },
    },
  ],
  [
    "a stop and a restart the same day",
    {
      off: async (p, at = prefs) => {
        expect((await stopCourse(db, userId, await planRow(p), ctx(at), Number.POSITIVE_INFINITY)).more).toBe(false);
      },
      back: async (_p, at = prefs) => {
        const res = await startCourse(db, userId, BODY, ctx(at), Number.POSITIVE_INFINITY);
        if (!res.ok) throw new Error(res.error);
        expect(res.more).toBe(false);
      },
    },
  ],
];

describe.each(PATHS)("%s", (_name, path) => {
  it("comes back as an outline holding none of the copy, whatever a fresh outline wouldn't hold", async () => {
    const { p, id } = await copyOnWatch();
    await path.off(p);
    expect((await rowOf(db, id)).archivedAt).toBe(NOW);
    await path.back(p);
    expect(await rowOf(db, id)).toMatchObject({ ...noCopy(id), archivedAt: null, origin: "program", contentState: "outline", courseSession: null, workoutDoc: null, sourceContentFingerprint: "program" });
    // A slot never written, later in the week, holds exactly this.
    const friday = await rowOf(db, slotId(p, addDays(MON, 4)));
    expect(friday).toMatchObject({ ...noCopy(friday.id), origin: "program", contentState: "outline", sourceContentFingerprint: "program" });
  });

  it.each([
    ["before it comes back", true],
    ["after it comes back", false],
  ] as const)("the copy's delete, run %s, takes the copy off at its own address", async (_when, deleteFirst) => {
    const { p, id, buildId, stamp, idInPlan } = await copyOnWatch();
    await path.off(p);
    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ status: "queued", kind: "coach_delete_workout" });
    if (deleteFirst) await lane();
    await path.back(p);
    if (!deleteFirst) {
      // The row knows nothing of it now: the job has only what it was queued with.
      expect(await rowOf(db, id)).toMatchObject(noCopy(id));
      await lane();
    }
    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ status: "verified", lastErrorDetail: expect.stringMatching(/^deleted/) });
    expect(programOn(stamp)).toBeUndefined();
    expect(entityAt(idInPlan)).toBeUndefined();
    expect(courseCopies()).toEqual([]);
    // Settled, so its stamp is free, and the row is still as it came back.
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(await rowOf(db, id)).toMatchObject({ ...noCopy(id), archivedAt: null, origin: "program" });
  });

  it.each([
    ["before it comes back", true],
    ["after it comes back", false],
  ] as const)("the delete run %s, the session written again goes on once, under its own address: no older copy, no note", async (_when, deleteFirst) => {
    const { p, id, buildId, idInPlan } = await copyOnWatch();
    await path.off(p);
    if (deleteFirst) await lane();
    await path.back(p);
    if (!deleteFirst) await lane();
    expect(courseCopies()).toEqual([]);

    expect((await writeCourseSession(db, userId, await rowOf(db, id), ctx())).written).toBe(true);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    const writes = server.counts.scheduleWrites;
    await lane();
    expect(server.counts.scheduleWrites).toBe(writes + 1);

    const [copy, ...more] = courseCopies();
    expect(more).toEqual([]);
    const row = await rowOf(db, id);
    expect(row).toMatchObject({ corosSyncState: "synced", lastVerifiedCorosDate: MON, watchCopyName: null, origin: "studio", courseSession: 1, workoutDocRev: 2 });
    expect(row.sourceIdInPlan).toBe(String(copy!.idInPlan));
    expect(row.sourceWorkoutId).toBe(`${server.state.schedule.id}:${copy!.idInPlan}`);
    expect(entityAt(idInPlan) === undefined || String(copy!.idInPlan) === idInPlan).toBe(true);
    const pushes = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).filter((j) => j.kind === "program_session_push");
    expect(pushes.map((j) => j.status).sort()).toEqual(["superseded", "verified"]);
    expect(pushes.find((j) => j.status === "superseded")!.id).toBe(`push:${buildId}`);

    expect(await viewOf(id)).not.toBe("content_stale");
    await fullRead();
    await fullRead();
    expect(await notesOf(id)).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({ sourceIdInPlan: String(copy!.idInPlan), corosSyncState: "synced", missingReads: 0 });
  });

  it("the delete landing last, after the session's next copy, leaves that copy and the row's address alone", async () => {
    const { p, id, buildId, stamp } = await copyOnWatch();
    await path.off(p);
    await path.back(p);
    expect((await writeCourseSession(db, userId, await rowOf(db, id), ctx())).written).toBe(true);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    // The watch's drain takes pushes first: the next copy lands with the old one still there, later than the old one did.
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl, watchOnly: true, cap: 1 });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(courseCopies()).toHaveLength(2);
    const landed = await rowOf(db, id);
    const name = courseCopies().find((c) => c.name !== stamp)!.name!;
    expect(landed.sourceIdInPlan).toBe(String(programOn(name)!.idInPlan));

    await lane();

    expect(programOn(stamp)).toBeUndefined();
    expect(programOn(name)).toBeDefined();
    expect(await rowOf(db, id)).toMatchObject({ sourceWorkoutId: landed.sourceWorkoutId, sourceIdInPlan: landed.sourceIdInPlan, sourceProgramId: landed.sourceProgramId, corosSyncState: "synced", lastVerifiedCorosDate: MON });
  });

  it("a full read while the delete waits makes nothing of the old copy: no new row, no address back, no note", async () => {
    const { p, id, buildId, stamp } = await copyOnWatch();
    await path.off(p);
    await path.back(p);
    await fullRead();
    await fullRead();
    // The mock's own sessions came in with the read; of this session, still the one row.
    const named = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.title.startsWith("Intro ") || r.title === stamp);
    expect(named).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject(noCopy(id));
    expect(await notesOf(id)).toEqual([]);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
  });

  it("once the copy has gone, two full reads find nothing missing: no 'Removed from your watch', and no copy owed for an outline", async () => {
    const { p, id } = await copyOnWatch();
    const owed = async () => (await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id))))[0]?.resolvedAt;
    await path.off(p);
    await path.back(p);
    await lane();
    expect(courseCopies()).toEqual([]);
    const markBefore = await owed();
    await fullRead();
    await fullRead();
    expect(await notesOf(id)).toEqual([]);
    expect(await owed()).toEqual(markBefore);
    expect(await rowOf(db, id)).toMatchObject({ ...noCopy(id), missingReads: 0 });
  });

  it("the copy deleted in the COROS app while its delete waits: two full reads say nothing of an outline that holds no copy", async () => {
    const { p, id, buildId, stamp, idInPlan } = await copyOnWatch();
    await path.off(p);
    await path.back(p);
    server.state.schedule.programs = (server.state.schedule.programs ?? []).filter((c) => c.name !== stamp);
    server.state.schedule.entities = (server.state.schedule.entities ?? []).filter((e) => String(e.idInPlan) !== idInPlan);
    await fullRead();
    await fullRead();
    expect((await notesOf(id)).map((n) => n.kind)).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({ ...noCopy(id), missingReads: 0 });
    // And the delete that was on its way finds it gone, and settles.
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
  });

  it("a watch activity carrying the old copy's program doesn't link to the outline or number it; one carrying the next copy's does", async () => {
    const { p, id, programId } = await copyOnWatch();
    await path.off(p);
    await path.back(p);
    const stats = await ingestActivities(db, { userId, sources: [activity("old-copy", programId)] });
    expect(stats.completions).toBe(0);
    expect(await rowOf(db, id)).toMatchObject({ completionState: "scheduled", courseSession: null });
    expect(await courseSessionsDone(db, userId, p)).toBe(0);

    // Written again and pushed, the old delete still waiting: the old copy's program links to nothing, the next copy's does.
    expect((await writeCourseSession(db, userId, await rowOf(db, id), ctx())).written).toBe(true);
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl, watchOnly: true, cap: 1 });
    const next = (await rowOf(db, id)).sourceProgramId!;
    expect(next).not.toBe(programId);
    expect((await ingestActivities(db, { userId, sources: [activity("old-copy-again", programId)] })).completions).toBe(0);
    expect((await ingestActivities(db, { userId, sources: [activity("next-copy", next)] })).completions).toBe(1);
    expect(await rowOf(db, id)).toMatchObject({ completionState: "completed", courseSession: 1 });
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });

  it("with the writes off the delete is owed, and when they're back it goes to the copy's own address, the row having none", async () => {
    const { p, id, buildId, stamp, idInPlan, programId, address } = await copyOnWatch();
    await path.off(p, writesOff());
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    await path.back(p, writesOff());
    expect(await rowOf(db, id)).toMatchObject(noCopy(id));
    expect(programOn(stamp)).toBeDefined();

    await emitPendingWork(db, userId, { corosWritesEnabled: true });

    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ status: "queued", kind: "coach_delete_workout" });
    expect((await jobOf(`unpush:${buildId}`))!.payload).toMatchObject({ name: stamp, happenDay: MON, idInPlan, programId, corosPlanId: address.split(":")[0] });
    await lane();
    expect(programOn(stamp)).toBeUndefined();
    expect(entityAt(idInPlan)).toBeUndefined();
    expect(courseCopies()).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({ ...noCopy(id), archivedAt: null });
  });

  it("with the writes off a full read finds the copy still there and the row follows it, as a moved one does; the delete owed still takes it off", async () => {
    const { p, id, buildId, stamp, idInPlan, address } = await copyOnWatch();
    await path.off(p, writesOff());
    await path.back(p, writesOff());
    await fullRead();
    // The build is still the sent one while its delete is owed, so the copy is this row's.
    expect(await rowOf(db, id)).toMatchObject({ sourceWorkoutId: address, sourceIdInPlan: idInPlan, corosSyncState: "synced" });
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    await lane();
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(programOn(stamp)).toBeUndefined();
    expect(await rowOf(db, id)).toMatchObject(noCopy(id));
  });

  it("with the writes off, a copy since moved in the COROS app is deleted where the row followed it, not where the delete was owed", async () => {
    const { p, id, buildId, stamp, idInPlan } = await copyOnWatch();
    await path.off(p, writesOff());
    await path.back(p, writesOff());
    const tuesday = addDays(MON, 1);
    entityAt(idInPlan)!.happenDay = localDateToCorosDay(tuesday);
    await fullRead();
    expect((await rowOf(db, id)).lastVerifiedCorosDate).toBe(tuesday);
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect((await jobOf(`unpush:${buildId}`))!.payload).toMatchObject({ happenDay: tuesday, idInPlan });
    await lane();
    expect(programOn(stamp)).toBeUndefined();
  });

  it("with the writes off, the mirror reaching the session first still queues the owed delete: one copy at the end", async () => {
    const { p, id, buildId, stamp } = await copyOnWatch();
    await path.off(p, writesOff());
    await path.back(p, writesOff());
    expect((await writeCourseSession(db, userId, await rowOf(db, id), ctx())).written).toBe(true);

    // Writes back on: a request's mirror takes it, before any hourly pass ran what was owed.
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
    expect(await jobOf(`unpush:${buildId}`)).toMatchObject({ status: "queued" });
    for (let i = 0; i < 3 && (await jobOf(`unpush:${buildId}`))!.status !== "verified"; i++) await lane();
    expect(programOn(stamp)).toBeUndefined();
    expect(courseCopies()).toHaveLength(1);

    // And what the hourly pass then finds owed is nothing: that copy's delete has gone.
    const writes = server.counts.scheduleWrites;
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    await lane();
    expect(server.counts.scheduleWrites).toBe(writes);
    expect(courseCopies()).toHaveLength(1);
  });

  it("a name it held goes too: 'Older on watch' isn't said of an outline, and that copy's own delete still lands", async () => {
    const { p, id, stamp } = await copyOnWatch();
    // What an adoption or a coach create's verify leaves: the program name the watch holds a copy under.
    await db.update(plannedWorkouts).set({ watchCopyName: stamp }).where(eq(plannedWorkouts.id, id));
    await path.off(p);
    await path.back(p);
    expect(await rowOf(db, id)).toMatchObject(noCopy(id));
    expect(await viewOf(id)).not.toBe("content_stale");
    await lane();
    await lane();
    expect(programOn(stamp)).toBeUndefined();
    expect(courseCopies()).toEqual([]);
    const deletes = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).filter((j) => j.kind === "coach_delete_workout");
    expect(deletes.length).toBeGreaterThan(0);
    expect(new Set(deletes.map((j) => j.status))).toEqual(new Set(["verified"]));
  });
});

describe("what a slot never written keeps", () => {
  it("an adaptive programme's revive writes none of the watch's columns: it never held any of them to reset", async () => {
    const id = "adaptive-1";
    await db.insert(programs).values({
      id, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 3, preferredDays: [0, 2, 4], placementWeeksAhead: 1, defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, id, MON, prefs, NOW);
    const slot = slotId(id, addDays(MON, 2));
    expect((await rowOf(db, slot)).origin).toBe("program");
    await setPause(id, addDays(MON, 3));
    expect((await placeSlots(db, userId, id, MON, prefs, NOW)).archived).toContain(slot);
    // Marks no real slot holds, set to see them left: a revive of a slot touches nothing of the watch's.
    const marks = { corosSyncState: "synced", lastVerifiedCorosDate: MON, sourceIdInPlan: "7", sourceProgramId: "70", watchCopyName: "Marked" };
    await db.update(plannedWorkouts).set(marks).where(eq(plannedWorkouts.id, slot));
    await setPause(id, null);
    expect((await placeSlots(db, userId, id, MON, prefs, NOW)).placed).toContain(slot);
    expect(await rowOf(db, slot)).toMatchObject({ ...marks, archivedAt: null, origin: "program", contentState: "outline", sourceWorkoutId: slot });
  });
});
