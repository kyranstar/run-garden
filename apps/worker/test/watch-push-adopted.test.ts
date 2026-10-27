/**
 * THE OLD COPY OF AN ADOPTED WORKOUT (workout-editability spec §4, M8). A revise adopts a coach session or a COROS-plan
 * session into a Studio document workout and keeps its watch address: the copy on the watch is now the row's, held
 * under `watch_copy_name`, and the row reads "older on watch" until the new version goes on.
 *
 *  - The Studio's Send on the day replaces it: the old copy's stamp-checked delete (`<id>-unpush-copy`) is queued
 *    before the push of the new build.
 *  - Remove, and a plan archive (Stop this plan, a week re-plan), take it off the same way — an imported session's
 *    copy too, which no stamp proves (the row's wire title names it).
 *  - The delete, verified, clears the name; one refused leaves it (the copy is still there).
 *  - A create the lane had claimed before the adoption counts as being sent, and its verify records the name.
 *  - Writes off: nothing is queued, and the name keeps the copy accounted for.
 *
 * The coach sessions go to the mock COROS through the real lane. Invented ids and titles only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { reviseDocWorkout } from "../src/services/doc-workouts.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { buildSession, recordCheck } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, counting, DAY, NOON, rowOf, seedCatalog, seedTmj, switchOn } from "./watch-push-fixture.js";

const { coachPlans, corosWriteJobs, plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: MockCorosServer;

beforeEach(async () => {
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
afterEach(() => vi.useRealTimers());

/** A minute passes: each request below happens after the one before, as it would (the lane orders stamps by time). */
const tick = () => vi.setSystemTime(new Date(Date.now() + 60_000));
const ctx = (p: UserPreferences = prefs) => ({ today: DAY, now: nowInstant(), prefs: p });
const writesOff = (): UserPreferences => ({ ...prefs, corosWritesEnabled: false });
async function lane(opts: { cap?: number; watchOnly?: boolean } = {}) {
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl, ...opts });
  tick();
}
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const deletesOf = async (workoutId: string) =>
  (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, "coach_delete_workout")))).map(
    (j) => j.id,
  );
/** The row's jobs in the order they were written (SQLite's rowid). */
const jobIdsInOrder = (workoutId: string) =>
  (db as unknown as { $client: { prepare(sql: string): { all(...a: unknown[]): Array<{ id: string }> } } }).$client
    .prepare("select id from coros_write_jobs where workout_id = ? order by rowid")
    .all(workoutId)
    .map((r) => r.id);
const programsNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const nameOf = (job: { payload: unknown } | undefined) => (job!.payload as { name: string }).name;

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
  const create = await jobOf(`${id}-push`);
  expect(create).toMatchObject({ kind: "coach_create_workout", status: "verified" });
  const stamp = nameOf(create);
  expect(programsNamed(stamp)).toHaveLength(1);
  const row = await rowOf(db, id);
  expect(row.sourceWorkoutId).toMatch(/^\d+:\d+$/);
  // An ordinary coach create (a NULL-origin row) names no held copy: the row's own stamp proves it.
  expect(row).toMatchObject({ origin: null, lastVerifiedCorosDate: DAY, watchCopyName: null });
  return { id, stamp };
}

/** The athlete (or the coach) revises it: adopted, a Studio document workout holding the old copy. */
async function adopt(id: string, title = "Hips, mine") {
  const row = await rowOf(db, id);
  return reviseDocWorkout(db, userId, id, { doc: calmDoc({ title }), baseRev: row.workoutDocRev ?? 0 }, ctx());
}

/** Today's build of the adopted workout, the pre-check answered, sent. */
async function buildAndSend(id: string): Promise<string> {
  await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx());
  const built = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, id, buildId, ctx());
  return buildId;
}

/** A COROS-plan session as the import writes it (origin NULL, its wire title, a copy at a plan address). */
async function seedImported(id: string, title: string): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coros-plan-invented", sourceWorkoutId: "5150:3", sourceIdInPlan: "3", sourceProgramId: "990002",
    title, category: "strength", sport: "strength", originalPlanDate: DAY, lastVerifiedCorosDate: DAY, effectiveDate: DAY,
    effectiveTime: "07:00", sourceContentFingerprint: "wire-invented-fp", fallbackEstimatedDurationSeconds: 2400,
    calendarBlockDurationSeconds: 2400, calendarSyncState: "synced", corosSyncState: "synced", completionState: "scheduled",
    origin: null, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

describe("Send on the day replaces the old copy", () => {
  it("queues the old copy's delete before the push; the lane takes the old copy off and puts the new build on", async () => {
    const { id, stamp } = await coachOnWatch();
    const before = await rowOf(db, id);
    const adopted = await adopt(id);
    expect(adopted.watchHasOlder).toBe(true);
    expect(await rowOf(db, id)).toMatchObject({ origin: "studio", watchCopyName: stamp, sourceWorkoutId: before.sourceWorkoutId });

    const buildId = await buildAndSend(id);
    expect(jobIdsInOrder(id)).toEqual([`${id}-push`, `${id}-unpush-copy`, `push:${buildId}`]);
    const copy = await jobOf(`${id}-unpush-copy`);
    const push = await jobOf(`push:${buildId}`);
    expect(copy).toMatchObject({ kind: "coach_delete_workout", status: "queued", originalDate: DAY, destinationDate: DAY, expectedContentFingerprint: "" });
    expect(copy!.payload).toEqual({
      workoutId: id,
      happenDay: DAY,
      name: stamp,
      idInPlan: before.sourceIdInPlan,
      programId: before.sourceProgramId,
      corosPlanId: before.sourceWorkoutId.split(":")[0],
    });
    expect(push).toMatchObject({ kind: "program_session_push", status: "queued" });
    expect(copy!.requestedAt <= push!.requestedAt).toBe(true);

    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(programsNamed(stamp)).toHaveLength(0);
    const sent = nameOf(await jobOf(`push:${buildId}`));
    expect(programsNamed(sent)).toHaveLength(1);
    const after = await rowOf(db, id);
    expect(after).toMatchObject({ origin: "studio", watchCopyName: null, lastVerifiedCorosDate: DAY, corosSyncState: "synced" });
    expect(after.sourceWorkoutId).toMatch(/^\d+:\d+$/);
    expect(after.sourceWorkoutId).not.toBe(before.sourceWorkoutId);
  });

  it("the sheet's targeted drain puts the new build on first; the old copy comes off on the lane's next pass, the row keeping the new copy's address", async () => {
    const { id, stamp } = await coachOnWatch();
    const before = await rowOf(db, id);
    await adopt(id);
    const buildId = await buildAndSend(id);

    await lane({ cap: 1, watchOnly: true });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("queued");
    const sent = nameOf(await jobOf(`push:${buildId}`));
    const pushed = await rowOf(db, id);
    expect(pushed.sourceWorkoutId).not.toBe(before.sourceWorkoutId);
    // Both on the watch for now, and the row still says the older one is there.
    expect(programsNamed(stamp)).toHaveLength(1);
    expect(pushed.watchCopyName).toBe(stamp);

    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect(programsNamed(stamp)).toHaveLength(0);
    expect(programsNamed(sent)).toHaveLength(1);
    // The delete was addressed by its own payload: the new copy's address on the row is untouched.
    expect(await rowOf(db, id)).toMatchObject({
      watchCopyName: null,
      sourceWorkoutId: pushed.sourceWorkoutId,
      sourceIdInPlan: pushed.sourceIdInPlan,
      sourceProgramId: pushed.sourceProgramId,
      lastVerifiedCorosDate: DAY,
    });
  });
});

describe("Remove and a plan archive take the old copy off", () => {
  it("Remove queues the old copy's delete — one delete, never the coach stamp's own as well", async () => {
    const { id, stamp } = await coachOnWatch();
    const before = await rowOf(db, id);
    await adopt(id);
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    expect(await deletesOf(id)).toEqual([`${id}-unpush-copy`]);
    expect((await jobOf(`${id}-unpush-copy`))!.payload).toMatchObject({
      name: stamp,
      happenDay: DAY,
      idInPlan: before.sourceIdInPlan,
      programId: before.sourceProgramId,
    });
  });

  it("Remove of an adopted COROS-plan session queues its copy's delete under the wire's own name", async () => {
    await seedImported("imp-test-1", "STRENGTH B INVENTED");
    await adopt("imp-test-1", "Strength B, mine");
    expect((await rowOf(db, "imp-test-1")).watchCopyName).toBe("STRENGTH B INVENTED");
    await removeFromPlan(db, userId, "imp-test-1", { now: nowInstant(), source: "remove_from_plan", prefs });
    expect(await deletesOf("imp-test-1")).toEqual(["imp-test-1-unpush-copy"]);
    expect((await jobOf("imp-test-1-unpush-copy"))!.payload).toEqual({
      workoutId: "imp-test-1",
      happenDay: DAY,
      name: "STRENGTH B INVENTED",
      idInPlan: "3",
      programId: "990002",
      corosPlanId: "5150",
    });
  });

  it("a plan archive (Stop this plan) queues it", async () => {
    const { id, stamp } = await coachOnWatch();
    await db.insert(coachPlans).values({
      id: "cp-invented", userId, discipline: "lift", name: "Invented block", status: "active", startDate: DAY,
      endDate: "2026-11-06", stampPrefix: "Invented block", createdAt: NOON, updatedAt: NOON,
    });
    await db.update(plannedWorkouts).set({ planId: "cp-invented" }).where(eq(plannedWorkouts.id, id));
    await adopt(id);
    await applyOps(db, userId, prefs, "p-retire", [{ kind: "retirePlan", planId: "cp-invented" } as never]);
    expect((await rowOf(db, id)).archivedAt).not.toBeNull();
    expect(await deletesOf(id)).toEqual([`${id}-unpush-copy`]);
    expect(nameOf(await jobOf(`${id}-unpush-copy`))).toBe(stamp);
  });
});

describe("the delete, as the lane runs it", () => {
  it("a verified delete clears watch_copy_name and takes the copy off the watch", async () => {
    const { id, stamp } = await coachOnWatch();
    await adopt(id);
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    await lane();
    expect((await jobOf(`${id}-unpush-copy`))!.status).toBe("verified");
    expect(programsNamed(stamp)).toHaveLength(0);
    expect((await rowOf(db, id)).watchCopyName).toBeNull();
  });

  it("a delete refused for good leaves the name: the copy is still there", async () => {
    const { id, stamp } = await coachOnWatch();
    await adopt(id);
    // The athlete renamed the copy in the COROS app: the stamp no longer proves it.
    programsNamed(stamp)[0]!.name = "Renamed by the athlete";
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await lane();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("coach unpush FAILED"));
    logged.mockRestore();
    expect(await jobOf(`${id}-unpush-copy`)).toMatchObject({ status: "failed", lastErrorCategory: "stamp_mismatch" });
    expect(programsNamed("Renamed by the athlete")).toHaveLength(1);
    expect((await rowOf(db, id)).watchCopyName).toBe(stamp);
  });
});

describe("a create the lane claimed before the adoption (M8)", () => {
  it("counts as being sent, and its verify records the copy's name — the document untouched", async () => {
    const id = (await applyOps(db, userId, prefs, "p-claimed", [liftAdd("Hips, coached") as never])).created[0]!;
    const stamp = nameOf(await jobOf(`${id}-push`));
    const doc = calmDoc({ title: "Hips, mine" });
    let adopted: Awaited<ReturnType<typeof reviseDocWorkout>> | null = null;
    // The create's write has landed on the watch and the lane has not verified it yet: the revise lands now.
    const { fetchImpl } = counting(server, async (url) => {
      if (adopted || url.pathname !== "/training/schedule/update") return;
      expect((await jobOf(`${id}-push`))!.status).toBe("claimed");
      adopted = await adopt(id, "Hips, mine");
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl });

    expect(adopted).not.toBeNull();
    expect(adopted!.watchHasOlder).toBe(true);
    expect((await jobOf(`${id}-push`))!.status).toBe("verified");
    expect(programsNamed(stamp)).toHaveLength(1);
    const row = await rowOf(db, id);
    expect(row).toMatchObject({ origin: "studio", watchCopyName: stamp, lastVerifiedCorosDate: DAY, workoutDocRev: adopted!.rev, title: "Hips, mine" });
    expect(row.sourceWorkoutId).toMatch(/^\d+:\d+$/);
    expect(JSON.parse(row.workoutDoc!)).toEqual(doc);

    // And the copy it landed is the one Remove now takes off.
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    expect(await deletesOf(id)).toEqual([`${id}-unpush-copy`]);
    expect(nameOf(await jobOf(`${id}-unpush-copy`))).toBe(stamp);
  });
});

describe("COROS writes off", () => {
  it("Remove queues no delete, and the name keeps the copy accounted for", async () => {
    const { id, stamp } = await coachOnWatch();
    await adopt(id);
    await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs: writesOff() });
    expect((await rowOf(db, id)).archivedAt).not.toBeNull();
    expect(await deletesOf(id)).toEqual([]);
    expect((await rowOf(db, id)).watchCopyName).toBe(stamp);
    expect(programsNamed(stamp)).toHaveLength(1);
  });

  it("a plan archive queues none either", async () => {
    const { id, stamp } = await coachOnWatch();
    await db.insert(coachPlans).values({
      id: "cp-invented-2", userId, discipline: "lift", name: "Invented block", status: "active", startDate: DAY,
      endDate: "2026-11-06", stampPrefix: "Invented block", createdAt: NOON, updatedAt: NOON,
    });
    await db.update(plannedWorkouts).set({ planId: "cp-invented-2" }).where(eq(plannedWorkouts.id, id));
    await adopt(id);
    await applyOps(db, userId, writesOff(), "p-retire-off", [{ kind: "retirePlan", planId: "cp-invented-2" } as never]);
    expect((await rowOf(db, id)).archivedAt).not.toBeNull();
    expect(await deletesOf(id)).toEqual([]);
    expect((await rowOf(db, id)).watchCopyName).toBe(stamp);
  });
});
