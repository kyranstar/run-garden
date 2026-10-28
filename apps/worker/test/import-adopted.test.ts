/**
 * THE IMPORT AND AN ADOPTED WORKOUT'S OLD COPY (workout-editability spec §4, A1). A revise that took over a coach session
 * or a COROS-plan session kept its watch address and the name the watch holds the old copy under (`watch_copy_name`).
 * No push of the app's put that copy there, so the read's verified-push claim never matched it: the copy read as a new
 * workout — a duplicate session for a coach row, and for a COROS-plan row an insert `planned_workouts_source_unique`
 * refused every read.
 *
 *  - A wire workout at an adopted row's address under that name is the row's: no new row, no collision, and the row's
 *    title, document and content are never rewritten (it records the wire's fingerprint, as a sent copy's row does).
 *  - After Send's push lands first (the sheet's drain), the row holds its new copy's address and the old copy sits at an
 *    address no row holds, its delete queued: it is still the row's, on its way off — no new row.
 *  - A full read that finds no workout at the row's address under the name clears it; a short read proves nothing
 *    (ruling 3-R16), and a delete in flight keeps it (its verify clears it).
 *  - A copy renamed in the COROS app is not claimed: it reads as a new workout (for a COROS-plan row once the row has
 *    let go of the address — never an insert the unique index refuses).
 *  - The lane's verified delete of an adopted COROS-plan row's copy resets the row as a coach row's is reset, addressed
 *    where the row holds the copy now.
 *
 * The copies live on the mock COROS, put there by the real lane (coach sessions) or by a create under a name that is not
 * ours (a COROS-plan session); each read imports the mock's whole schedule. Invented ids and titles only; the clock is
 * the watch fixture's own pinned noon.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachSessionSchema, nowInstant, type UserPreferences } from "@rg/domain";
import { CorosClient, createWorkout } from "@rg/coros";
import { localDateToCorosDay, normalizeCorosSchedule } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { reviseDocWorkout } from "../src/services/doc-workouts.js";
import { exerciseNameMap } from "../src/services/exercise-catalog.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { adoptedCopyUnpush, removeFromPlan } from "../src/services/plan-mutations.js";
import { buildSession, recordCheck } from "../src/services/session-build.js";
import { activeSyncNotes } from "../src/services/sync-notes.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, DAY, NOON, rowOf, seedCatalog, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, plannedWorkoutStages } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
/** Something that happens while a read runs: after it has read the jobs, before it writes (its open intents are read between). */
const midRead = vi.hoisted(() => ({ act: null as null | (() => Promise<void>) }));
vi.mock("../src/services/sync-intents.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/sync-intents.js")>();
  return {
    ...real,
    openMoveIntents: async (...args: Parameters<typeof real.openMoveIntents>) => {
      const act = midRead.act;
      midRead.act = null;
      await act?.();
      return real.openMoveIntents(...args);
    },
  };
});

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: MockCorosServer;

beforeEach(async () => {
  // The lane's COROS client logs each call's result code to stderr; only those lines are dropped, anything else passes.
  const stderr = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[coros-bridge] coros ")) return;
    stderr(...args);
  });
  // The clock held at noon on the fixture's day (the watch suites' own pin): "today" is DAY for the whole test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
});
afterEach(() => {
  midRead.act = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A COROS-plan session's name: COROS's own, no stamp of ours. */
const NATIVE = "STRENGTH B INVENTED";

/** A minute passes: each request below happens after the one before, as it would (the lane orders stamps by time). */
const tick = () => vi.setSystemTime(new Date(Date.now() + 60_000));
const ctx = () => ({ today: DAY, now: nowInstant(), prefs });
async function lane(opts: { cap?: number; watchOnly?: boolean } = {}) {
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl, ...opts });
  tick();
}
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const programsNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const nameOf = (job: { payload: unknown } | undefined) => (job!.payload as { name: string }).name;
const rowsTitled = (title: string) =>
  db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.title, title)));
const stagesOf = async (id: string) =>
  (await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id))).length;

/** A read of COROS: the mock's schedule, normalized and imported — its whole span (`full`), or a short read of it. */
async function importFromCoros(span: "full" | "short" = "full") {
  const n = normalizeCorosSchedule(server.state.schedule);
  const stats = await importPlanSnapshot(
    db,
    {
      userId, plan: { sourcePlanId: n.planId, name: "Container" }, workouts: n.workouts, rangeStart: addDays(DAY, -7),
      rangeEnd: addDays(DAY, 30), fullSchedule: span === "full", source: "fixture",
    },
    prefs,
  );
  tick();
  return stats;
}

/** A coach strength session for the day (a catalog move, so the watch can hold it). */
const liftAdd = (title: string) => ({
  kind: "add",
  date: DAY,
  session: {
    category: "strength",
    title,
    durationMinutes: 30,
    lift: { exercises: [{ originId: "4258276155475001301", name: "Goblet Squat", sets: 3, reps: 8, weight: { type: "bodyweight" }, restSeconds: 60 }] },
  },
});

/** The coach adds a session and the lane puts it on the (mock) watch: its stamp, its address on the row. */
async function coachOnWatch(title = "Hips, coached"): Promise<{ id: string; stamp: string }> {
  const id = (await applyOps(db, userId, prefs, "p-coach", [liftAdd(title) as never])).created[0]!;
  await lane();
  const stamp = nameOf(await jobOf(`${id}-push`));
  expect(programsNamed(stamp)).toHaveLength(1);
  expect((await rowOf(db, id)).sourceWorkoutId).toMatch(/^\d+:\d+$/);
  return { id, stamp };
}

/**
 * A COROS-plan session on today: a workout COROS holds under its own name (no job of ours wrote it), and the row the
 * import makes of it — origin NULL, the wire's title, its address.
 */
async function nativeOnWatch(name = NATIVE): Promise<string> {
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
  await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
  const created = await createWorkout(
    client,
    { happenDay: String(localDateToCorosDay(DAY)), name, session: coachSessionSchema.parse(liftAdd("Unused").session) },
    { catalog: await exerciseNameMap(db), today: DAY },
  );
  expect(created.ok).toBe(true);
  expect((await importFromCoros()).created).toBeGreaterThan(0);
  const [row] = await rowsTitled(name);
  expect(row).toMatchObject({ origin: null, sport: "strength", effectiveDate: DAY });
  expect(row!.sourceWorkoutId).toMatch(/^\d+:\d+$/);
  return row!.id;
}

/**
 * The athlete (or the coach) revises it: adopted, a Studio document workout holding the old copy. With the athlete's
 * writes on, the adoption queues the old copy's delete at once (the watch mirrors the plan §3.5); `held` adopts with them
 * off, so no delete is in flight and the import's own rules for the name are what is judged.
 */
async function adopt(id: string, title = "Hips, mine", opts: { held?: boolean } = {}) {
  const row = await rowOf(db, id);
  const writes = opts.held ? { ...prefs, corosWritesEnabled: false } : prefs;
  const revised = await reviseDocWorkout(db, userId, id, { doc: calmDoc({ title }), baseRev: row.workoutDocRev ?? 0 }, { ...ctx(), prefs: writes });
  tick();
  return revised;
}

/** Today's build of the adopted workout, the pre-check answered, sent. */
async function buildAndSend(id: string): Promise<string> {
  await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx());
  const built = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, id, buildId, ctx());
  tick();
  return buildId;
}

/** The athlete deletes the workout in the COROS app. */
function deletedInCoros(name: string) {
  const [program] = programsNamed(name);
  const idInPlan = String(program!.idInPlan);
  server.state.schedule.programs = server.state.schedule.programs!.filter((p) => String(p.idInPlan) !== idInPlan);
  server.state.schedule.entities = server.state.schedule.entities!.filter((e) => String(e.idInPlan) !== idInPlan);
}

/** The athlete moves the workout to another day in the COROS app (in place: same address). */
function movedInCoros(name: string, to: string) {
  const [program] = programsNamed(name);
  const entity = server.state.schedule.entities!.find((e) => String(e.idInPlan) === String(program!.idInPlan))!;
  entity.happenDay = localDateToCorosDay(to);
}

describe("a wire workout at an adopted row's address is the row's old copy", () => {
  it("an adopted watch-plan row claims its wire workout: no new row, no unique collision, stats.unchanged +1, title/content not rewritten", async () => {
    const id = await nativeOnWatch();
    const imported = await rowOf(db, id);
    const baseline = await importFromCoros();
    expect(baseline).toMatchObject({ created: 0, failedWrites: 0 });

    await adopt(id, "Strength B, mine");
    const adopted = await rowOf(db, id);
    expect(adopted).toMatchObject({ origin: "studio", watchCopyName: NATIVE, sourceWorkoutId: imported.sourceWorkoutId, sourceContentFingerprint: "studio" });
    expect(await stagesOf(id)).toBe(0);

    const first = await importFromCoros();
    expect(first).toMatchObject({ created: 0, failedWrites: 0, contestedAddresses: 0, updatedContent: 0, replacedRecycled: 0 });
    // Nothing new under the wire's name, and the row is what the revise wrote — it records only what COROS holds.
    expect(await rowsTitled(NATIVE)).toEqual([]);
    expect(await rowOf(db, id)).toEqual({ ...adopted, sourceContentFingerprint: imported.sourceContentFingerprint, updatedAt: expect.any(String) });
    expect(await stagesOf(id)).toBe(0);

    // From then on it is unchanged: the read counts it so — one more than a read that does not claim it.
    const second = await importFromCoros();
    expect(second).toMatchObject({ created: 0, failedWrites: 0, unchanged: baseline.unchanged });
    expect(await rowOf(db, id)).toMatchObject({ title: "Strength B, mine", watchCopyName: NATIVE, missingReads: 0, workoutDocRev: adopted.workoutDocRev });
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("an adopted coach row claims its copy: no duplicate", async () => {
    const { id, stamp } = await coachOnWatch();
    const before = await rowOf(db, id);
    await importFromCoros();
    await adopt(id);

    const stats = await importFromCoros();
    expect(stats).toMatchObject({ created: 0, failedWrites: 0 });
    expect(await rowsTitled("Hips, coached")).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({
      origin: "studio", title: "Hips, mine", watchCopyName: stamp, sourceWorkoutId: before.sourceWorkoutId, lastVerifiedCorosDate: DAY,
    });
    expect(await stagesOf(id)).toBe(0);
  });
});

describe("after the push lands and the old copy is still on the wire", () => {
  it("a coach row: still the row's, no duplicate — and nothing to recognise once its delete has run", async () => {
    const { id, stamp } = await coachOnWatch();
    const before = await rowOf(db, id);
    await importFromCoros();
    await adopt(id);
    const buildId = await buildAndSend(id);
    // The sheet's targeted drain: the new build goes on first, the old copy's delete waits for the lane.
    await lane({ cap: 1, watchOnly: true });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("queued");
    expect(programsNamed(stamp)).toHaveLength(1);
    const pushed = await rowOf(db, id);
    expect(pushed.sourceWorkoutId).not.toBe(before.sourceWorkoutId);

    const stats = await importFromCoros();
    expect(stats).toMatchObject({ created: 0, failedWrites: 0 });
    expect(await rowsTitled("Hips, coached")).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: stamp, sourceWorkoutId: pushed.sourceWorkoutId, lastVerifiedCorosDate: DAY });

    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect(programsNamed(stamp)).toHaveLength(0);
    expect((await importFromCoros()).created).toBe(0);
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: null, sourceWorkoutId: pushed.sourceWorkoutId });
  });

  it("a watch-plan row: still the row's, no duplicate", async () => {
    const id = await nativeOnWatch();
    const before = await rowOf(db, id);
    await adopt(id, "Strength B, mine");
    const buildId = await buildAndSend(id);
    await lane({ cap: 1, watchOnly: true });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("queued");
    const pushed = await rowOf(db, id);
    expect(pushed.sourceWorkoutId).not.toBe(before.sourceWorkoutId);

    const stats = await importFromCoros();
    expect(stats).toMatchObject({ created: 0, failedWrites: 0 });
    expect(await rowsTitled(NATIVE)).toEqual([]);
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: NATIVE, sourceWorkoutId: pushed.sourceWorkoutId });

    await lane();
    expect(programsNamed(NATIVE)).toHaveLength(0);
    expect((await importFromCoros()).created).toBe(0);
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: null, sourceWorkoutId: pushed.sourceWorkoutId });
  });
});

describe("the name holds only while a read can find the copy", () => {
  it("the copy gone from the wire: watch_copy_name cleared — by a full read, never a short one", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine", { held: true });
    const adopted = await rowOf(db, id);
    deletedInCoros(NATIVE);

    await importFromCoros("short");
    expect((await rowOf(db, id)).watchCopyName).toBe(NATIVE);

    await importFromCoros();
    // Only the name: the address is rule 8's to let go of, after its second full read.
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: null, sourceWorkoutId: adopted.sourceWorkoutId, title: "Strength B, mine" });
  });

  it("a delete in flight: the name stays — its verify clears it", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine");
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("queued");
    deletedInCoros(NATIVE);

    await importFromCoros();
    expect((await rowOf(db, id)).watchCopyName).toBe(NATIVE);

    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect((await rowOf(db, id)).watchCopyName).toBeNull();
  });

  it("a delete queued while the read runs: the name stays — the statement judges the jobs as they stand at the write", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine", { held: true });
    deletedInCoros(NATIVE);
    midRead.act = async () => {
      await adoptedCopyUnpush(db, userId, await rowOf(db, id), nowInstant(), prefs)!.insert;
    };

    await importFromCoros();
    expect(midRead.act).toBeNull();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("queued");
    expect((await rowOf(db, id)).watchCopyName).toBe(NATIVE);
  });
});

describe("a copy renamed in the COROS app is not claimed (the limit: it reads as a new workout)", () => {
  it("a coach row's: a new workout under its new name, and the row's name cleared", async () => {
    const { id, stamp } = await coachOnWatch();
    await importFromCoros();
    await adopt(id, undefined, { held: true });
    programsNamed(stamp)[0]!.name = "Renamed by the athlete";

    const stats = await importFromCoros();
    expect(stats).toMatchObject({ created: 1, failedWrites: 0 });
    expect(await rowsTitled("Renamed by the athlete")).toHaveLength(1);
    expect((await rowOf(db, id)).watchCopyName).toBeNull();
  });

  it("a watch-plan row's: never an insert the unique index refuses — a new workout once the row lets go of the address", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine", { held: true });
    const adopted = await rowOf(db, id);
    programsNamed(NATIVE)[0]!.name = "Renamed by the athlete";
    const warned = vi.spyOn(console, "warn");
    try {
      const first = await importFromCoros();
      expect(first).toMatchObject({ created: 0, failedWrites: 0 });
      expect(warned).not.toHaveBeenCalled();
      expect(await rowOf(db, id)).toMatchObject({ watchCopyName: null, sourceWorkoutId: adopted.sourceWorkoutId });

      // Rule 8: the second full read without its copy lets go of the address (and says so once)…
      expect((await importFromCoros()).failedWrites).toBe(0);
      expect(await rowOf(db, id)).toMatchObject({ sourceWorkoutId: id, lastVerifiedCorosDate: "", title: "Strength B, mine" });
      expect((await activeSyncNotes(db, userId)).filter((n) => n.workoutId === id).map((n) => n.kind)).toEqual(["watch_copy_removed"]);

      // …and the renamed copy is a COROS workout like any other.
      expect(await importFromCoros()).toMatchObject({ created: 1, failedWrites: 0 });
      expect(await rowsTitled("Renamed by the athlete")).toHaveLength(1);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("the lane's delete of an adopted watch-plan row's copy", () => {
  it("a verified delete of an adopted watch-plan row's copy resets the row like a coach row's", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine");
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect(programsNamed(NATIVE)).toHaveLength(0);
    expect(await rowOf(db, id)).toMatchObject({
      watchCopyName: null, sourceWorkoutId: id, sourceIdInPlan: null, sourceProgramId: null, lastVerifiedCorosDate: "", corosSyncState: "calendar_only",
    });
  });

  it("is addressed where the row holds the copy now — a move in COROS the read saw — not where it stood at the queue", async () => {
    const id = await nativeOnWatch();
    await adopt(id, "Strength B, mine");
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    expect((await jobOf(`${id}-unpush-copy`))!.payload).toMatchObject({ happenDay: DAY });
    movedInCoros(NATIVE, TOMORROW);
    await importFromCoros();
    expect(await rowOf(db, id)).toMatchObject({ lastVerifiedCorosDate: TOMORROW, watchCopyName: NATIVE });

    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect(programsNamed(NATIVE)).toHaveLength(0);
    expect(await rowOf(db, id)).toMatchObject({ watchCopyName: null, sourceWorkoutId: id, lastVerifiedCorosDate: "" });
  });
});
