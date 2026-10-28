/**
 * THE MIRROR (the watch mirrors the plan §3.2, §3.7; builder check A5, A6, A7, M2, M3).
 *
 * A document workout ahead of its day goes to the watch as a provisional copy: a record (a negative version, never
 * locked) and its `program_session_push` with `provisional: true`, always after the previous copy's delete. The sweep
 * finds the sessions whose copy is not current (`currentCopy`, A7) and queues ONE a run, soonest first, inside the
 * window; a push that failed for good is re-queued on a backoff, three times at most (M3). Writes off: nothing.
 *
 * The executor's claim does not yet take a provisional push AHEAD of its day (Task 4 lifts that): every test that drives
 * the lane to a verified copy dates its session TODAY (the fixture's `DAY`), or moves the clock to the session's day
 * before the lane runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, programSessionPushJobSchema, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { emitPendingWork } from "../src/services/jobs.js";
import { enqueueUnpushIfOurs } from "../src/services/plan-mutations.js";
import { buildSession, isProvisionalBuild, sentBuildIdOf } from "../src/services/session-build.js";
import {
  currentCopy,
  markMirrorOwed,
  MIRROR_RETRY_BACKOFF_MS,
  MIRROR_WINDOW_DAYS,
  mirrorSweep,
  queueProvisionalPush,
  queueReplacement,
  type PushRow,
} from "../src/services/mirror.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, counting, DAY, makeEnv, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds, syncIntents } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
/**
 * Sessions whose copy goes wrong: `prepare` — `pushPayloadFor` throws while the copy is prepared (as a failed read would);
 * `write` — `queuePushJob` throws while it is written (as a failed D1 write would); `raced` — `queuePushJob` finds the
 * build's push taken by another request between the mirror's read and its write (answers false).
 */
const broken = vi.hoisted(() => ({ prepare: null as string | null, write: null as string | null, raced: null as string | null }));
vi.mock("../src/services/watch-push.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/watch-push.js")>();
  const pushPayloadFor: typeof real.pushPayloadFor = async (...args) => {
    if (broken.prepare !== null && args[2].id === broken.prepare) throw new Error(`the catalog read failed ${"x".repeat(200)}`);
    return real.pushPayloadFor(...args);
  };
  const queuePushJob: typeof real.queuePushJob = async (...args) => {
    if (broken.write !== null && args[2].id === broken.write) throw new Error("D1_ERROR: the write failed");
    if (broken.raced !== null && args[2].id === broken.raced) return false;
    return real.queuePushJob(...args);
  };
  return { ...real, pushPayloadFor, queuePushJob };
});

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let statements: string[] = [];
let seq = 0;

async function setup(): Promise<void> {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  Object.assign(broken, { prepare: null, write: null, raced: null });
  await setup();
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = (over: Partial<{ today: string; now: string; prefs: UserPreferences }> = {}) => ({ today: DAY, now: NOON, prefs, ...over });
const writesOff = (): UserPreferences => ({ ...prefs, corosWritesEnabled: false });
/** An instant `ms` after NOON. */
const after = (ms: number): string => new Date(Date.parse(NOON) + ms).toISOString();

/** A Studio workout as the Studio stores one: its document at revision `rev`, an outline until its day. */
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

/** The athlete's revision as it lands on the row (the hooks that mark it owed are Task 6's: marked here by hand). */
async function revise(workoutId: string, doc: WorkoutDoc = revisedDoc()): Promise<void> {
  const row = await rowOf(db, workoutId);
  await db
    .update(plannedWorkouts)
    .set({ workoutDoc: JSON.stringify(doc), workoutDocRev: (row.workoutDocRev ?? 0) + 1 })
    .where(eq(plannedWorkouts.id, workoutId));
  await markMirrorOwed(db, userId, workoutId, NOON);
}

/** Far more work steps than the watch holds (220 > WATCH_MAX_STEPS), well inside what the app builds. */
function longDoc(): WorkoutDoc {
  const ids = ["bridge", "deadBug"];
  return workoutDocSchema.parse({
    ...calmDoc(),
    title: "Very long",
    parts: [{ purpose: "main", format: "straight", items: Array.from({ length: 11 }, (_, i) => ({ kind: "exercise", libraryId: ids[i % 2], dose: { sets: 20, reps: 5, restSec: 10 } })) }],
  });
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const jobsOf = (workoutId: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId)).orderBy(corosWriteJobs.requestedAt);
const recordsOf = (workoutId: string) =>
  db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, workoutId), lt(sessionBuilds.version, 0))).orderBy(sessionBuilds.version);
const intentOf = async (workoutId: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, `mirror-${workoutId}`)))[0];
const pushPayload = async (buildId: string) => programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
const storedProgram = (name: string) => (server.state.schedule.programs ?? []).find((p) => p.name === name);
const ourPrograms = (title: string) => (server.state.schedule.programs ?? []).filter((p) => String(p.name).startsWith(title));

/** The provisional copy's push verified, the row holding its address — as the lane leaves them. */
async function verifyByHand(workoutId: string, buildId: string, day: string, idInPlan = "41"): Promise<void> {
  await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
  await db
    .update(plannedWorkouts)
    .set({ sourceWorkoutId: `900:${idInPlan}`, sourceIdInPlan: idInPlan, sourceProgramId: "77", lastVerifiedCorosDate: day, corosSyncState: "synced" })
    .where(eq(plannedWorkouts.id, workoutId));
}

const queue = async (workoutId: string, over: Parameters<typeof ctx>[0] = {}, env = switchOn()) =>
  queueProvisionalPush(db, env, userId, await rowOf(db, workoutId), ctx(over));

describe("markMirrorOwed", () => {
  it("one open intent per workout, however often it is marked; marked again after it was resolved, it is open again", async () => {
    const id = await seedDocRow(addDays(DAY, 3));
    statements = [];
    await markMirrorOwed(db, userId, id, NOON);
    expect(statements).toHaveLength(1);
    await markMirrorOwed(db, userId, id, NOON);
    const rows = await db.select().from(syncIntents).where(eq(syncIntents.targetId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `mirror-${id}`, userId, kind: "mirror", targetKind: "workout", source: "mirror", resolvedAt: null });
    expect(await queue(id)).toBe("queued");
    expect((await intentOf(id))!.resolvedAt).toBe(NOON);
    await markMirrorOwed(db, userId, id, after(1000));
    expect(await intentOf(id)).toMatchObject({ resolvedAt: null, createdAt: after(1000) });
  });
});

describe("queueProvisionalPush", () => {
  it("makes a −1 record and queues its push — provisional, the revision, the title — day stamp — within 12 statements", async () => {
    const day = addDays(DAY, 3);
    const id = await seedDocRow(day);
    await markMirrorOwed(db, userId, id, NOON);
    const row = await rowOf(db, id);
    statements = [];
    expect(await queueProvisionalPush(db, switchOn(), userId, row, ctx())).toBe("queued");
    console.info(`[budget] queueProvisionalPush, a first copy: ${statements.length} D1 (${statements.filter(isWrite).length} writes)`);
    expect(statements.length).toBeLessThanOrEqual(12);

    const [record] = await recordsOf(id);
    expect(record).toMatchObject({ version: -1, lockedAt: null });
    expect(isProvisionalBuild(record!)).toBe(true);
    const job = await jobOf(`push:${record!.id}`);
    expect(job).toMatchObject({ kind: "program_session_push", status: "queued", workoutId: id, originalDate: day, destinationDate: day });
    expect(job!.expectedContentFingerprint).toBe(record!.inputsHash);
    const payload = await pushPayload(record!.id);
    expect(payload).toMatchObject({ workoutId: id, buildId: record!.id, happenDay: day, name: `Hips and back — ${day}`, provisional: true, fromDocRev: 1 });
    expect(payload.session.steps.length).toBeGreaterThan(0);
    // The copy on its way is the session's sent copy; the intent is resolved; the row itself is untouched.
    expect(await sentBuildIdOf(db, id)).toBe(record!.id);
    expect((await intentOf(id))!.resolvedAt).toBe(NOON);
    expect(await rowOf(db, id)).toEqual(row);
    // Asked again: the copy is current.
    expect(await queue(id)).toBe("skipped:current");
    expect(await recordsOf(id)).toHaveLength(1);
  });

  it("an adopted session's held copy: its delete is queued first, then the push", async () => {
    const day = addDays(DAY, 2);
    const id = await seedDocRow(day, {
      sourceWorkoutId: "900:12", sourceIdInPlan: "12", sourceProgramId: "55", lastVerifiedCorosDate: day, watchCopyName: "Bridge day",
    });
    expect(await queue(id)).toBe("queued");
    const [record] = await recordsOf(id);
    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
    // Insertion order is the lane's order for jobs requested in one instant.
    expect(jobs.map((j) => j.id)).toEqual([`${id}-unpush-copy`, `push:${record!.id}`]);
    expect(jobs[0]).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    expect(jobs[0]!.payload).toMatchObject({ workoutId: id, happenDay: day, name: "Bridge day", idInPlan: "12", programId: "55", corosPlanId: "900" });
  });

  it("a second revision makes −2, and the −1 copy's delete is queued before its push", async () => {
    const day = addDays(DAY, 4);
    const id = await seedDocRow(day);
    await queue(id);
    const [first] = await recordsOf(id);
    const firstName = (await pushPayload(first!.id)).name;
    await verifyByHand(id, first!.id, day);

    await revise(id);
    const row = await rowOf(db, id);
    statements = [];
    expect(await queueProvisionalPush(db, switchOn(), userId, row, ctx())).toBe("queued");
    console.info(`[budget] queueProvisionalPush, replacing a verified copy: ${statements.length} D1`);
    expect(statements.length).toBeLessThanOrEqual(14);
    const records = await recordsOf(id);
    expect(records.map((r) => r.version)).toEqual([-2, -1]);
    const second = records[0]!;
    // −1 is no longer the copy on the watch (its marker cleared, never locked); −2 is.
    expect(isProvisionalBuild(records[1]!)).toBe(false);
    expect(records[1]!.lockedAt).toBeNull();
    expect(await sentBuildIdOf(db, id)).toBe(second.id);
    const unpush = await jobOf(`unpush:${first!.id}`);
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    expect(unpush!.payload).toMatchObject({ workoutId: id, happenDay: day, name: firstName, idInPlan: "41", programId: "77", corosPlanId: "900" });
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${second.id}`]);
    // The old copy still holds its stamp until its delete verifies: the new one takes the day's next.
    expect(await pushPayload(second.id)).toMatchObject({ provisional: true, fromDocRev: 2, name: `Hips and back — ${day} (2)` });
    expect((await jobOf(`push:${first!.id}`))!.status).toBe("verified");
  });

  it("a revision while the −1 push is still queued: that push is superseded (it never ran), no delete", async () => {
    const id = await seedDocRow(addDays(DAY, 4));
    await queue(id);
    const [first] = await recordsOf(id);
    await revise(id);
    expect(await queue(id)).toBe("queued");
    expect((await jobOf(`push:${first!.id}`))!.status).toBe("superseded");
    expect(await jobOf(`unpush:${first!.id}`)).toBeUndefined();
    // The stamp is chosen before the old push is superseded — never one a push on its way might still write — so the new
    // copy takes the day's next; the superseded push has given its own up for the revision after.
    const [second] = await recordsOf(id);
    expect((await pushPayload(second!.id)).name).toBe(`Hips and back — ${addDays(DAY, 4)} (2)`);
  });

  it("writes off, or the switch off: nothing queued, no record, the owed mark kept for when they come back on", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, id, NOON);
    const row = await rowOf(db, id);
    statements = [];
    expect(await queueProvisionalPush(db, switchOn(), userId, row, ctx({ prefs: writesOff() }))).toBe("skipped:writes_off");
    expect(await queueProvisionalPush(db, makeEnv(), userId, row, ctx())).toBe("skipped:switch_off");
    expect(statements).toHaveLength(0);
    expect(await recordsOf(id)).toHaveLength(0);
    expect(await jobsOf(id)).toHaveLength(0);
    expect((await intentOf(id))!.resolvedAt).toBeNull();
  });

  it("kept off: skipped:kept_off, nothing written but the mark resolved", async () => {
    const id = await seedDocRow(addDays(DAY, 2), { watchOff: true });
    await markMirrorOwed(db, userId, id, NOON);
    expect(await queue(id)).toBe("skipped:kept_off");
    expect(await recordsOf(id)).toHaveLength(0);
    expect(await jobsOf(id)).toHaveLength(0);
    expect((await intentOf(id))!.resolvedAt).toBe(NOON);
  });

  it("the other refusals, each with nothing written", async () => {
    const engine = await seedSlot(db, userId, programId, addDays(DAY, 2));
    const run = await seedDocRow(addDays(DAY, 2), { sport: "run", category: "easy" });
    const skipped = await seedDocRow(addDays(DAY, 2), { completionState: "skipped" });
    const done = await seedDocRow(DAY, { contentState: "done" });
    const past = await seedDocRow(addDays(DAY, -1));
    const far = await seedDocRow(addDays(DAY, MIRROR_WINDOW_DAYS + 1));
    const edge = await seedDocRow(addDays(DAY, MIRROR_WINDOW_DAYS));
    const long = await seedDocRow(addDays(DAY, 3), {}, longDoc());
    expect(await queue(engine)).toBe("skipped:not_document");
    expect(await queue(run)).toBe("skipped:not_document");
    expect(await queue(skipped)).toBe("skipped:resolved");
    expect(await queue(done)).toBe("skipped:resolved");
    expect(await queue(past)).toBe("skipped:past");
    expect(await queue(far)).toBe("skipped:beyond_window");
    expect(await queue(long)).toBe("skipped:too_long");
    for (const id of [engine, run, skipped, done, past, far, long]) {
      expect(await recordsOf(id)).toHaveLength(0);
      expect(await jobsOf(id)).toHaveLength(0);
    }
    // The window's last day is inside it.
    expect(await queue(edge)).toBe("queued");
  });

  it("a restore running: nothing written, the mark kept", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, id, NOON);
    await db.insert(schema.accountState).values({ userId, restoreId: "restore-1", restoreStartedAt: NOON, updatedAt: NOON } as typeof schema.accountState.$inferInsert);
    expect(await queue(id)).toBe("skipped:restoring");
    expect(await recordsOf(id)).toHaveLength(0);
    expect(await jobsOf(id)).toHaveLength(0);
    expect((await intentOf(id))!.resolvedAt).toBeNull();
  });
});

describe("currentCopy (A7)", () => {
  const ADDRESS = { sourceWorkoutId: "900:41", sourceIdInPlan: "41", sourceProgramId: "77" };
  const day = addDays(DAY, 3);
  const row = (over: Partial<Parameters<typeof currentCopy>[0]> = {}) =>
    ({ effectiveDate: day, workoutDocRev: 2, ...ADDRESS, lastVerifiedCorosDate: day, ...over }) as Parameters<typeof currentCopy>[0];
  const push = (over: Partial<PushRow> = {}): PushRow => ({
    id: "push:b", status: "verified", happenDay: day, provisional: true, fromDocRev: 2, verifiedAt: NOON, updatedAt: NOON, retries: 0, ...over,
  });

  it("verified for this revision and day, the row holding its address → current", () => {
    expect(currentCopy(row(), [push()], DAY)).toBe(true);
  });

  it("in flight for this revision and day → current, whatever the address", () => {
    for (const status of ["queued", "claimed", "in_progress", "verifying"]) {
      expect(currentCopy(row({ lastVerifiedCorosDate: "" }), [push({ status, verifiedAt: null })], DAY)).toBe(true);
    }
  });

  it("another revision → not current; settled, failed or none → not current", () => {
    expect(currentCopy(row(), [push({ fromDocRev: 1 })], DAY)).toBe(false);
    for (const status of ["superseded", "cancelled", "restored", "failed", "needs_attention"]) {
      expect(currentCopy(row(), [push({ status })], DAY)).toBe(false);
    }
    expect(currentCopy(row(), [], DAY)).toBe(false);
  });

  it("the same revision on another day → not current (a move): in flight for the old day, or verified there", () => {
    const moved = addDays(day, 2);
    expect(currentCopy(row({ effectiveDate: moved }), [push({ status: "queued" })], DAY)).toBe(false);
    // The copy is still at the old day (the address says so): the row's new day has none.
    expect(currentCopy(row({ effectiveDate: moved }), [push()], DAY)).toBe(false);
  });

  it("verified, but the address cleared (the copy went missing) → not current", () => {
    expect(currentCopy(row({ lastVerifiedCorosDate: "" }), [push()], DAY)).toBe(false);
    expect(currentCopy(row({ sourceWorkoutId: "studio-1", sourceIdInPlan: null }), [push()], DAY)).toBe(false);
  });

  it("the copy moved in the COROS app and the row followed it (its stamp keeps the old date) → current", () => {
    const followed = addDays(day, 1);
    expect(currentCopy(row({ effectiveDate: followed, lastVerifiedCorosDate: followed }), [push()], DAY)).toBe(true);
  });

  it("a day's build sent before the mirror (no revision on its push) counts by its day; a day gone owes nothing", () => {
    expect(currentCopy(row({ effectiveDate: DAY, lastVerifiedCorosDate: DAY }), [push({ happenDay: DAY, provisional: false, fromDocRev: null })], DAY)).toBe(true);
    expect(currentCopy(row({ effectiveDate: addDays(DAY, -1) }), [], DAY)).toBe(true);
  });
});

describe("mirrorSweep", () => {
  it("queues exactly one a run, soonest first, inside the window — never beyond +28, nor a resolved, rest, race, engine or kept-off session", async () => {
    const later = await seedDocRow(addDays(DAY, 5));
    const soonest = await seedDocRow(addDays(DAY, 1));
    const middle = await seedDocRow(addDays(DAY, 3));
    const far = await seedDocRow(addDays(DAY, MIRROR_WINDOW_DAYS + 1));
    const kept = await seedDocRow(DAY, { watchOff: true });
    const resolved = await seedDocRow(DAY, { completionState: "completed" });
    const missed = await seedDocRow(DAY, { completionState: "missed" });
    const rest = await seedDocRow(DAY, { category: "rest" });
    const race = await seedDocRow(DAY, { category: "race" });
    const engine = await seedSlot(db, userId, programId, DAY);
    // Marked owed, the ones it will never push are settled as it passes them.
    for (const id of [far, kept, engine]) await markMirrorOwed(db, userId, id, NOON);

    statements = [];
    const first = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    console.info(`[budget] mirrorSweep, one record: ${statements.length} D1 (${statements.filter(isWrite).length} writes)`);
    expect(statements.length).toBeLessThanOrEqual(15);
    expect(first.queued).toBe(1);
    // Only the owed ones are judged among those it never pushes: the window's are not even read.
    expect(first.skipped).toMatchObject({ beyond_window: 1, kept_off: 1, not_document: 1 });
    expect(await recordsOf(soonest)).toHaveLength(1);
    for (const id of [later, middle]) expect(await recordsOf(id)).toHaveLength(0);
    for (const id of [far, kept, engine]) expect((await intentOf(id))!.resolvedAt).toBe(NOON);

    const second = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    expect(second.queued).toBe(1);
    expect(second.skipped.current).toBe(1);
    expect(await recordsOf(middle)).toHaveLength(1);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    expect(await recordsOf(later)).toHaveLength(1);
    // Every copy current: nothing more, however often it runs.
    const idle = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    expect(idle).toEqual({ queued: 0, skipped: { current: 3 } });
    for (const id of [far, kept, resolved, missed, rest, race, engine]) {
      expect(await recordsOf(id)).toHaveLength(0);
      expect(await jobsOf(id)).toHaveLength(0);
    }
  });

  it("an owed session goes before the window's sooner ones", async () => {
    const soon = await seedDocRow(addDays(DAY, 1));
    const owed = await seedDocRow(addDays(DAY, 6));
    await markMirrorOwed(db, userId, owed, NOON);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    expect(await recordsOf(owed)).toHaveLength(1);
    expect(await recordsOf(soon)).toHaveLength(0);
    expect((await intentOf(owed))!.resolvedAt).toBe(NOON);
  });

  it("a session too long for the watch is judged once per revision: it never holds the window up", async () => {
    const long = await seedDocRow(addDays(DAY, 1), {}, longDoc());
    const next = await seedDocRow(addDays(DAY, 2));
    const first = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    expect(first).toMatchObject({ queued: 0, skipped: { too_long: 1 } });
    statements = [];
    const second = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    expect(second.queued).toBe(1);
    expect(second.skipped.too_long).toBe(1);
    expect(await recordsOf(next)).toHaveLength(1);
    expect(await recordsOf(long)).toHaveLength(0);
    // A new revision is judged afresh.
    await revise(long, calmDoc({ title: "Very long" }));
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    expect(await recordsOf(long)).toHaveLength(1);
  });

  it("writes off: queues nothing and reads nothing", async () => {
    await seedDocRow(addDays(DAY, 1));
    statements = [];
    expect(await mirrorSweep(db, switchOn(), userId, writesOff(), ctx({ prefs: writesOff() }), { cap: 1 })).toEqual({ queued: 0, skipped: { writes_off: 1 } });
    expect(await mirrorSweep(db, makeEnv(), userId, prefs, ctx(), { cap: 1 })).toEqual({ queued: 0, skipped: { switch_off: 1 } });
    expect(statements).toHaveLength(0);
  });

  it("a moved session (same revision, another day) is pushed for its new day; its old copy's delete first", async () => {
    const day = addDays(DAY, 2);
    const id = await seedDocRow(day);
    await queue(id);
    const [first] = await recordsOf(id);
    await verifyByHand(id, first!.id, day);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(0);
    await db.update(plannedWorkouts).set({ effectiveDate: addDays(DAY, 5) }).where(eq(plannedWorkouts.id, id));
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect(second!.id).not.toBe(first!.id);
    expect(await jobOf(`unpush:${first!.id}`)).toMatchObject({ status: "queued" });
    expect(await pushPayload(second!.id)).toMatchObject({ happenDay: addDays(DAY, 5), fromDocRev: 1 });
  });

  it("the old copy's delete queued when the change was made, then the sweep: one delete and one push — never a second delete by the address", async () => {
    const day = addDays(DAY, 3);
    const id = await seedDocRow(day);
    await queue(id);
    const [first] = await recordsOf(id);
    await verifyByHand(id, first!.id, day);
    // The change's own cheap writes (M2; the hooks are Task 6's): the revision, its old copy's delete, the owed mark.
    await revise(id);
    await enqueueUnpushIfOurs(db, userId, await rowOf(db, id), NOON, prefs);
    expect(await jobOf(`unpush:${first!.id}`)).toMatchObject({ status: "queued" });
    expect(await sentBuildIdOf(db, id)).toBeNull();
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${second!.id}`]);
    expect(await jobOf(`${id}-unpush`)).toBeUndefined();
  });

  it("replacing a verified copy, with owed marks to settle: within 15 statements", async () => {
    const day = addDays(DAY, 3);
    const id = await seedDocRow(day);
    await queue(id);
    const [first] = await recordsOf(id);
    await verifyByHand(id, first!.id, day);
    await revise(id);
    const kept = await seedDocRow(addDays(DAY, 1), { watchOff: true });
    await markMirrorOwed(db, userId, kept, NOON);
    statements = [];
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    console.info(`[budget] mirrorSweep, replacing a verified copy (two owed marks settled): ${statements.length} D1 (${statements.filter(isWrite).length} writes)`);
    expect(statements.length).toBeLessThanOrEqual(15);
    const [second] = await recordsOf(id);
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${second!.id}`]);
    for (const w of [id, kept]) expect((await intentOf(w))!.resolvedAt).toBe(NOON);
  });

  it("a restore running: the sweep writes nothing, the marks kept", async () => {
    const id = await seedDocRow(addDays(DAY, 1));
    await markMirrorOwed(db, userId, id, NOON);
    await db.insert(schema.accountState).values({ userId, restoreId: "restore-1", restoreStartedAt: NOON, updatedAt: NOON } as typeof schema.accountState.$inferInsert);
    statements = [];
    expect(await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).toEqual({ queued: 0, skipped: { restoring: 1 } });
    expect(statements.filter(isWrite)).toHaveLength(0);
    expect(await recordsOf(id)).toHaveLength(0);
    expect((await intentOf(id))!.resolvedAt).toBeNull();
  });

  it("an error while the copy is prepared is remembered — nothing written — and tried again after its backoff, not before: a transient one heals", async () => {
    const bad = await seedDocRow(addDays(DAY, 1));
    const next = await seedDocRow(addDays(DAY, 2));
    broken.prepare = bad;
    expect(await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).toEqual({ queued: 0, skipped: { error: 1 } });
    const mark = await intentOf(bad);
    expect(mark).toMatchObject({ resolvedAt: NOON });
    const memory = mark!.payload as { refused: string; rev: number; day: string; message: string; at: string; count: number };
    expect(memory).toMatchObject({ refused: "error", rev: 1, day: addDays(DAY, 1), at: NOON, count: 1 });
    expect(memory.message.startsWith("Error: the catalog read failed")).toBe(true);
    expect(memory.message).toHaveLength(120);
    expect(await recordsOf(bad)).toHaveLength(0);
    expect(await jobsOf(bad)).toHaveLength(0);
    // It never holds the window up: the next run pushes the next session.
    const second = await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 });
    expect(second.queued).toBe(1);
    expect(second.skipped.error).toBe(1);
    expect(await recordsOf(next)).toHaveLength(1);
    // Not before its first backoff; then tried again — the failure was transient, and the copy is made.
    broken.prepare = null;
    const sweepAt = (now: string) => mirrorSweep(db, switchOn(), userId, prefs, ctx({ now }), { cap: 1 });
    expect(await sweepAt(after(MIRROR_RETRY_BACKOFF_MS[0] - 1000))).toEqual({ queued: 0, skipped: { error: 1, current: 1 } });
    expect(await recordsOf(bad)).toHaveLength(0);
    expect((await sweepAt(after(MIRROR_RETRY_BACKOFF_MS[0]))).queued).toBe(1);
    expect(await recordsOf(bad)).toHaveLength(1);
    expect((await jobsOf(bad)).map((j) => j.kind)).toEqual(["program_session_push"]);
  });

  it("a persistent error: tried after 1 h, 6 h and 24 h, then left (gave_up) — until a revision, which is tried afresh", async () => {
    const bad = await seedDocRow(addDays(DAY, 3));
    broken.prepare = bad;
    let at = NOON;
    const sweepAt = (now: string) => mirrorSweep(db, switchOn(), userId, prefs, ctx({ now }), { cap: 1 });
    expect(await sweepAt(at)).toEqual({ queued: 0, skipped: { error: 1 } });
    for (const [n, wait] of MIRROR_RETRY_BACKOFF_MS.entries()) {
      const due = new Date(Date.parse(at) + wait).toISOString();
      expect(await sweepAt(new Date(Date.parse(due) - 1000).toISOString())).toEqual({ queued: 0, skipped: { error: 1 } });
      expect(await sweepAt(due)).toEqual({ queued: 0, skipped: { error: 1 } });
      expect((await intentOf(bad))!.payload).toMatchObject({ refused: "error", at: due, count: n + 2 });
      at = due;
    }
    expect(await sweepAt(new Date(Date.parse(at) + 30 * 86_400_000).toISOString())).toEqual({ queued: 0, skipped: { gave_up: 1 } });
    expect(await recordsOf(bad)).toHaveLength(0);
    expect(await jobsOf(bad)).toHaveLength(0);
    broken.prepare = null;
    await revise(bad);
    expect((await sweepAt(at)).queued).toBe(1);
    expect(await recordsOf(bad)).toHaveLength(1);
  });

  it("a throw while the copy is written propagates — nothing remembered, the mark kept — and the next run makes it again: one delete, one push", async () => {
    const day = addDays(DAY, 3);
    const id = await seedDocRow(day);
    await queue(id);
    const [first] = await recordsOf(id);
    await verifyByHand(id, first!.id, day);
    await revise(id);
    broken.write = id;
    await expect(mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).rejects.toThrow("D1_ERROR");
    // The delete was queued before the push failed; the mark is still open and holds no memory.
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`]);
    expect(await intentOf(id)).toMatchObject({ resolvedAt: null, payload: {} });
    broken.write = null;
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [newest] = await recordsOf(id);
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${newest!.id}`]);
    expect(await jobOf(`${id}-unpush`)).toBeUndefined();
    expect(await sentBuildIdOf(db, id)).toBe(newest!.id);
    expect((await intentOf(id))!.resolvedAt).toBe(NOON);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(0);
  });
});

describe("a push that failed for good (M3)", () => {
  it("is re-queued after the first backoff, not before — the same push and stamp — and stops after three", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await queue(id);
    const [record] = await recordsOf(id);
    const pushId = `push:${record!.id}`;
    const name = (await pushPayload(record!.id)).name;
    /** The lane's last failure, as the executor leaves it: failed, its own retry count spent, `updatedAt` = when. */
    const failAt = async (at: string) => {
      const payload = programSessionPushJobSchema.parse((await jobOf(pushId))!.payload);
      await db
        .update(corosWriteJobs)
        .set({ status: "failed", lastErrorCategory: "error", updatedAt: at, payload: { ...payload, attempts: 2 } })
        .where(eq(corosWriteJobs.id, pushId));
    };
    const sweepAt = (now: string) => mirrorSweep(db, switchOn(), userId, prefs, ctx({ now }), { cap: 1 });

    let failedAt = NOON;
    await failAt(failedAt);
    for (let n = 0; n < MIRROR_RETRY_BACKOFF_MS.length; n++) {
      const wait = MIRROR_RETRY_BACKOFF_MS[n]!;
      // Not before its backoff.
      const early = await sweepAt(new Date(Date.parse(failedAt) + wait - 1000).toISOString());
      expect(early).toMatchObject({ queued: 0, skipped: { backoff: 1 } });
      expect((await jobOf(pushId))!.status).toBe("failed");
      // Then once: the same push, its stamp kept, its executor retries reset, the re-queue counted.
      const due = new Date(Date.parse(failedAt) + wait).toISOString();
      expect((await sweepAt(due)).queued).toBe(1);
      const job = await jobOf(pushId);
      expect(job).toMatchObject({ status: "queued", lastErrorCategory: null, requestedAt: due });
      const payload = programSessionPushJobSchema.parse(job!.payload);
      expect(payload).toMatchObject({ name, provisional: true, fromDocRev: 1, mirrorRetries: n + 1 });
      expect(payload.attempts).toBeUndefined();
      expect(await recordsOf(id)).toHaveLength(1);
      failedAt = new Date(Date.parse(due) + 60_000).toISOString();
      await failAt(failedAt);
    }
    // A fourth failure stops it: no re-queue, however long it waits.
    const never = await sweepAt(new Date(Date.parse(failedAt) + 30 * 86_400_000).toISOString());
    expect(never).toMatchObject({ queued: 0, skipped: { gave_up: 1 } });
    expect((await jobOf(pushId))!.status).toBe("failed");
    expect(await recordsOf(id)).toHaveLength(1);
  });
});

describe("a push a restore neutralised", () => {
  it("is re-queued as a failed one is — the same push and stamp, after the backoff — never a new copy under a new stamp", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await queue(id);
    const [record] = await recordsOf(id);
    const pushId = `push:${record!.id}`;
    const name = (await pushPayload(record!.id)).name;
    await db.update(corosWriteJobs).set({ status: "restored", updatedAt: NOON }).where(eq(corosWriteJobs.id, pushId));
    const sweepAt = (now: string) => mirrorSweep(db, switchOn(), userId, prefs, ctx({ now }), { cap: 1 });
    expect(await sweepAt(after(MIRROR_RETRY_BACKOFF_MS[0] - 1000))).toMatchObject({ queued: 0, skipped: { backoff: 1 } });
    expect((await sweepAt(after(MIRROR_RETRY_BACKOFF_MS[0]))).queued).toBe(1);
    expect(await jobOf(pushId)).toMatchObject({ status: "queued" });
    expect(await pushPayload(record!.id)).toMatchObject({ name, mirrorRetries: 1 });
    expect(await recordsOf(id)).toHaveLength(1);
  });
});

describe("queueReplacement", () => {
  it("the day's build replaces the provisional copy: the copy's delete, the day build locked, its push", async () => {
    const id = await seedDocRow(DAY);
    await queue(id);
    const [record] = await recordsOf(id);
    await verifyByHand(id, record!.id, DAY);
    const day = (await buildSession(db, userId, id, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx())).build!;
    expect(day.version).toBeGreaterThan(0);
    expect(await queueReplacement(db, switchOn(), userId, await rowOf(db, id), day.buildId, ctx())).toBe("queued");
    expect(await jobOf(`unpush:${record!.id}`)).toMatchObject({ status: "queued" });
    const [locked] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, day.buildId));
    expect(locked!.lockedAt).toBe(NOON);
    expect(await pushPayload(day.buildId)).toMatchObject({ buildId: day.buildId, happenDay: DAY, fromDocRev: 1 });
    expect((await pushPayload(day.buildId)).provisional).toBeUndefined();
    expect(await sentBuildIdOf(db, id)).toBe(day.buildId);
    // Asked again: it is the copy already.
    expect(await queueReplacement(db, switchOn(), userId, await rowOf(db, id), day.buildId, ctx())).toBe("skipped:current");
  });

  /** A document row of today with its day's build made, nothing sent. */
  async function builtToday(over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<{ id: string; buildId: string }> {
    const id = await seedDocRow(DAY);
    const day = (await buildSession(db, userId, id, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx())).build!;
    if (Object.keys(over).length > 0) await db.update(plannedWorkouts).set(over).where(eq(plannedWorkouts.id, id));
    return { id, buildId: day.buildId };
  }

  it("refuses what the row refuses — resolved, under way, a day gone, not a document — writing nothing, locking nothing", async () => {
    const cases: Array<[Partial<typeof plannedWorkouts.$inferInsert>, string, Partial<{ today: string }>]> = [
      [{ completionState: "skipped" }, "skipped:resolved", {}],
      [{ contentState: "started" }, "skipped:resolved", {}],
      [{ archivedAt: NOON }, "skipped:resolved", {}],
      [{}, "skipped:past", { today: TOMORROW }],
      [{ origin: "program" }, "skipped:not_document", {}],
      [{ watchOff: true }, "skipped:kept_off", {}],
    ];
    for (const [over, answer, when] of cases) {
      const { id, buildId } = await builtToday(over);
      expect(await queueReplacement(db, switchOn(), userId, await rowOf(db, id), buildId, ctx(when))).toBe(answer);
      expect(await jobsOf(id)).toHaveLength(0);
      const [b] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId));
      expect(b!.lockedAt).toBeNull();
    }
  });

  it("the build's own push on its way or verified already: already_pushed — no delete, no lock", async () => {
    for (const [n, status] of ["verified", "claimed"].entries()) {
      const { id, buildId } = await builtToday();
      await queue(id);
      const [record] = await recordsOf(id);
      await verifyByHand(id, record!.id, DAY, `5${n}`);
      // The day build's push exists (taken off since, or another request queued it), its build not the sent one.
      await db.insert(corosWriteJobs).values({
        id: `push:${buildId}`, userId, workoutId: id, kind: "program_session_push", expectedContentFingerprint: "h",
        originalDate: DAY, destinationDate: DAY, payload: {}, requestedAt: NOON, status, updatedAt: NOON,
      });
      expect(await queueReplacement(db, switchOn(), userId, await rowOf(db, id), buildId, ctx())).toBe("skipped:already_pushed");
      expect(await jobOf(`unpush:${record!.id}`)).toBeUndefined();
      const [b] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId));
      expect(b!.lockedAt).toBeNull();
      expect(await sentBuildIdOf(db, id)).toBe(record!.id);
    }
  });

  it("the build's push taken by another request between the read and the write: already_pushed, and the lock stays — that push is the build's", async () => {
    const { id, buildId } = await builtToday();
    broken.raced = id;
    expect(await queueReplacement(db, switchOn(), userId, await rowOf(db, id), buildId, ctx())).toBe("skipped:already_pushed");
    const [b] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId));
    expect(b!.lockedAt).toBe(NOON);
  });
});

describe("driven through the lane (the mock COROS)", () => {
  it("a revision during a claimed push (Review Focus 1): the old push verifies, the sweep replaces it — one copy at the end", async () => {
    // Today: the claim does not take a provisional push ahead of its day until Task 4.
    const id = await seedDocRow(DAY);
    expect(await queue(id)).toBe("queued");
    const [first] = await recordsOf(id);
    const firstName = (await pushPayload(first!.id)).name;
    const fetches = counting(server, async (url, init) => {
      if (url.pathname !== "/training/schedule/update") return;
      const body = JSON.parse(String(init?.body)) as { versionObjects?: Array<{ status?: number }> };
      if (body.versionObjects?.[0]?.status !== 1) return;
      // The athlete revises the workout while its create is on the wire.
      await revise(id);
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl, cap: 1 });
    expect((await jobOf(`push:${first!.id}`))!.status).toBe("verified");
    expect(storedProgram(firstName)).toBeDefined();
    expect(currentCopy(await rowOf(db, id), [], DAY)).toBe(false);

    // The sweep sees the copy is the old revision's: its delete, then the new push.
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect(second!.version).toBe(-2);
    expect(await jobOf(`unpush:${first!.id}`)).toMatchObject({ status: "queued" });
    vi.setSystemTime(new Date(after(60_000)));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`unpush:${first!.id}`))!.status).toBe("verified");
    expect((await jobOf(`push:${second!.id}`))!.status).toBe("verified");
    const secondName = (await pushPayload(second!.id)).name;
    expect(storedProgram(firstName)).toBeUndefined();
    expect(storedProgram(secondName)).toBeDefined();
    expect(ourPrograms("Hips and back")).toHaveLength(1);
    // And it stays one: the copy is current now.
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(0);
    expect(ourPrograms("Hips and back")).toHaveLength(1);
  });

  it("a revision queued while the old push is on the wire: the lane queues the old copy's delete as it verifies — one copy at the end", async () => {
    const id = await seedDocRow(DAY);
    await queue(id);
    const [first] = await recordsOf(id);
    const fetches = counting(server, async (url, init) => {
      if (url.pathname !== "/training/schedule/update") return;
      const body = JSON.parse(String(init?.body)) as { versionObjects?: Array<{ status?: number }> };
      if (body.versionObjects?.[0]?.status !== 1) return;
      await revise(id);
      expect(await queue(id)).toBe("queued");
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl, cap: 1 });
    expect((await jobOf(`push:${first!.id}`))!.status).toBe("verified");
    expect(await jobOf(`unpush:${first!.id}`)).toMatchObject({ status: "queued" });
    // A minute later (a frozen clock would verify both pushes in one instant, and the row's recorded stamp would tie).
    vi.setSystemTime(new Date(after(60_000)));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(ourPrograms("Hips and back")).toHaveLength(1);
    const [second] = await recordsOf(id);
    expect(storedProgram((await pushPayload(second!.id)).name)).toBeDefined();
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(0);
  });

  it("switch off then on (Review Focus 3): nothing pushed while off, the owed delete recorded; back on, the sweep catches up one a run, soonest first, no duplicates", async () => {
    const today = await seedDocRow(DAY);
    // On: today's copy goes to the watch.
    await queue(today);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [first] = await recordsOf(today);
    expect((await jobOf(`push:${first!.id}`))!.status).toBe("verified");

    // Off. Today's workout is revised (its change records the old copy's delete as owed: M2's cheap write), and a new
    // one is added for tomorrow.
    const off = writesOff();
    await revise(today);
    await enqueueUnpushIfOurs(db, userId, await rowOf(db, today), NOON, off);
    const tomorrow = await seedDocRow(TOMORROW);
    await markMirrorOwed(db, userId, tomorrow, NOON);
    expect(await mirrorSweep(db, switchOn(), userId, off, ctx({ prefs: off }), { cap: 1 })).toMatchObject({ queued: 0 });
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, tomorrow), ctx({ prefs: off }))).toBe("skipped:writes_off");
    await executeCloudJobs(db, switchOn(), userId, off, { fetchImpl: server.fetchImpl });
    expect(await recordsOf(tomorrow)).toHaveLength(0);
    expect(await jobOf(`unpush:${first!.id}`)).toBeUndefined();
    const [owedOn] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, first!.id));
    expect((owedOn!.payload as { unpushOwedAt?: string }).unpushOwedAt).toBe(NOON);
    expect(ourPrograms("Hips and back")).toHaveLength(1);
    for (const id of [today, tomorrow]) expect((await intentOf(id))!.resolvedAt).toBeNull();

    // On again: the owed delete is queued; the sweep takes the soonest first, one a run — and that copy's delete is the
    // owed one, never a second.
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(await jobOf(`unpush:${first!.id}`)).toMatchObject({ status: "queued" });
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [secondToday] = await recordsOf(today);
    expect(await recordsOf(today)).toHaveLength(2);
    expect((await jobsOf(today)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${secondToday!.id}`]);
    expect(await jobsOf(tomorrow)).toHaveLength(0);
    expect(await recordsOf(tomorrow)).toHaveLength(0);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(ourPrograms("Hips and back")).toHaveLength(1);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(1);
    const [tomorrowRecord] = await recordsOf(tomorrow);
    expect((await jobOf(`push:${tomorrowRecord!.id}`))!.status).toBe("queued");
    expect((await jobsOf(tomorrow)).map((j) => j.id)).toEqual([`push:${tomorrowRecord!.id}`]);
    expect((await jobsOf(today)).map((j) => j.id)).toEqual([`push:${first!.id}`, `unpush:${first!.id}`, `push:${secondToday!.id}`]);
    // Nothing more to do — and nothing twice.
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).queued).toBe(0);
    for (const id of [today, tomorrow]) expect((await intentOf(id))!.resolvedAt).toBe(NOON);
    // Tomorrow, its push runs on its day (the claim takes a provisional push ahead of its day only from Task 4).
    vi.setSystemTime(new Date(`${TOMORROW}T19:00:00.000Z`));
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`push:${tomorrowRecord!.id}`))!.status).toBe("verified");
    expect(ourPrograms("Hips and back")).toHaveLength(2);
    expect((await mirrorSweep(db, switchOn(), userId, prefs, ctx({ today: TOMORROW, now: `${TOMORROW}T19:00:00.000Z` }), { cap: 1 })).queued).toBe(0);
  });
});
