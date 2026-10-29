/**
 * WHAT THE LANE RE-CHECKS WHEN IT CLAIMS A PUSH (Audit 3-A lane L-2 / L-5, lifecycle L-10).
 *
 * Send's preconditions held when the athlete tapped it; the lane may claim the push much later — after midnight (the
 * hourly lane held the lock at 23:50), after the session was done or skipped, after COROS writes were turned off. So
 * at claim, a push whose day is not the athlete's today, whose slot is resolved, or whose athlete's writes are off is
 * superseded with no wire call, and its build unlocked unless the slot is started or done (Start owns that lock). A
 * started slot of today still pushes.
 *
 * A provisional copy (the watch mirrors the plan §3.2, builder check A2) goes ahead of its day: its push is superseded
 * only once its day is gone. A day ahead has no reading to judge it by, so it is never re-gated; a copy of TODAY is
 * re-gated by the day's reading as Retry re-gates it (final review Minor 3): a reading that closed one of its moves
 * since it was queued supersedes it, and the day's own build goes instead. A session kept off
 * the watch (`watch_off`, §3.6) supersedes any push at claim — a provisional record's marker cleared, a day's build
 * unlocked.
 *
 * An unpush owed while writes are off (a sent copy's slot moved, or taken off) is recorded on the sent build, which
 * stays locked; it is queued when writes come back on (the Settings toggle's catch-up pass), so no copy is stranded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { buildSession, isProvisionalBuild, loadSession, recordCheck, sentBuildIdOf } from "../src/services/session-build.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { gatedAtClaim, sendToWatch, takeOffWatch, watchStateOf } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { buildToday, connectMock, DAY, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

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
let statements: string[] = [];

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

/**
 * A document workout on `day` and its provisional copy's push, queued by the mirror (`queueProvisionalPush`: a record of
 * a negative version, never locked, and its `program_session_push` with `provisional: true`).
 */
async function mirrored(day: string): Promise<{ workoutId: string; buildId: string }> {
  const { workout } = await createDocWorkout(db, userId, { date: day, time: "18:00", doc: calmDoc() }, ctx());
  expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, workout.id), ctx())).toBe("queued");
  const [record] = await db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, workout.id), lt(sessionBuilds.version, 0)));
  expect(programSessionPushJobSchema.parse((await jobOf(`push:${record!.id}`))!.payload)).toMatchObject({ provisional: true, happenDay: day });
  return { workoutId: workout.id, buildId: record!.id };
}

/** The lane claimed the push and wrote nothing: superseded, no COROS write. */
async function supersededUnwritten(buildId: string, run: () => Promise<unknown>) {
  const writes = server.counts.scheduleWrites;
  await run();
  expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
  expect(server.counts.scheduleWrites - writes).toBe(0);
}

describe("a day gone, or not provisional (L-2; the mirror A2)", () => {
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

  it("a non-provisional push for tomorrow is still superseded: a day's build goes on its day only", async () => {
    const { workoutId, buildId } = await sent();
    // The slot and its push a day ahead (no route queues this: Send answers not_today — the claim holds the rule too).
    await db.update(plannedWorkouts).set({ effectiveDate: TOMORROW }).where(eq(plannedWorkouts.id, workoutId));
    const payload = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
    expect(payload.provisional).toBeUndefined();
    await db.update(corosWriteJobs).set({ payload: { ...payload, happenDay: TOMORROW } }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).toBeNull();
  });

  it("a provisional push for tomorrow is claimed and verifies; the row gets the address", async () => {
    const { workoutId, buildId } = await mirrored(TOMORROW);
    await lane();
    const push = await jobOf(`push:${buildId}`);
    expect(push!.status).toBe("verified");
    const stamp = programSessionPushJobSchema.parse(push!.payload).name;
    expect(stamp).toBe(`Hips and back — ${TOMORROW}`);
    expect(copiesNamed(stamp)).toBe(1);
    const row = await rowOf(db, workoutId);
    expect(row).toMatchObject({ effectiveDate: TOMORROW, lastVerifiedCorosDate: TOMORROW, corosSyncState: "synced" });
    expect(row.sourceIdInPlan).not.toBeNull();
    expect(row.sourceWorkoutId).toMatch(new RegExp(`^\\d+:${row.sourceIdInPlan}$`));
    // The record is still the copy on the watch: never locked, its marker kept, nothing queued to take it off.
    const record = await buildOf(buildId);
    expect(record.lockedAt).toBeNull();
    expect(isProvisionalBuild(record)).toBe(true);
    expect(await sentBuildIdOf(db, workoutId)).toBe(buildId);
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
  });

  it("a provisional push for yesterday is superseded: nothing written, the record's marker cleared", async () => {
    const { workoutId, buildId } = await mirrored(DAY);
    vi.setSystemTime(new Date(`${TOMORROW}T07:15:00.000Z`)); // 00:15 the next day, Los Angeles
    await supersededUnwritten(buildId, () => lane());
    const record = await buildOf(buildId);
    expect(record.lockedAt).toBeNull();
    expect(isProvisionalBuild(record)).toBe(false);
    expect(await sentBuildIdOf(db, workoutId)).toBeNull();
  });

  it("a provisional push of TODAY is re-gated at claim, as Retry is: queued before the check, claimed after a reading that closes a move — superseded, nothing written, the record's marker cleared", async () => {
    // Today's session, its copy queued before the check: the record's snapshot holds a jump with nothing to stand in for
    // it, and the jaw flares before the lane runs. Judged as Retry judges it (`gatedAtClaim`), the jump is closed: the
    // copy waits for the day's build (the sweep remembers today's check). (A flare, not a check left unanswered: since
    // 2026-10-23 an unanswered check closes no jump, so a copy queued and claimed before the check still goes.)
    const { workoutId, buildId } = await mirrored(DAY);
    await db.update(sessionBuilds).set({ workoutDoc: JSON.stringify(landingsDoc({ alternates: false })) }).where(eq(sessionBuilds.id, buildId));
    expect(await gatedAtClaim(db, userId, await rowOf(db, workoutId), buildId, DAY)).toBe(false);
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: "2026-10-09T19:05:00.000Z" });
    expect(await gatedAtClaim(db, userId, await rowOf(db, workoutId), buildId, DAY)).toBe(true);
    await supersededUnwritten(buildId, () => lane());
    const record = await buildOf(buildId);
    expect(record.lockedAt).toBeNull();
    expect(isProvisionalBuild(record)).toBe(false);
    expect(await sentBuildIdOf(db, workoutId)).toBeNull();
  });

  it("…and still calm at claim: today's provisional copy is written, as any push", async () => {
    const { workoutId, buildId } = await mirrored(DAY);
    await db.update(sessionBuilds).set({ workoutDoc: JSON.stringify(landingsDoc({ alternates: false })) }).where(eq(sessionBuilds.id, buildId));
    await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, { today: DAY, now: "2026-10-09T19:05:00.000Z" });
    expect(await gatedAtClaim(db, userId, await rowOf(db, workoutId), buildId, DAY)).toBe(false);
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  });

  it("a provisional push for a day ahead is never re-gated: no reading is read at claim (no extra statement), whatever today's says", async () => {
    // A day ahead has no reading of its own (A2): today's flare says nothing about it, and the claim reads no check.
    // Today's copy, queued a moment later (before the check), is claimed second.
    const ahead = await mirrored(TOMORROW);
    vi.setSystemTime(new Date("2026-10-09T19:01:00.000Z"));
    const today = await mirrored(DAY);
    for (const { buildId } of [ahead, today]) {
      await db.update(sessionBuilds).set({ workoutDoc: JSON.stringify(landingsDoc({ alternates: false })) }).where(eq(sessionBuilds.id, buildId));
    }
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: "2026-10-09T19:05:00.000Z" });
    const gateReads = (sql: string) => /from "(user_conditions|condition_checks)"/.test(sql);
    const one = () => executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl, cap: 1 });
    statements = [];
    await one();
    expect((await jobOf(`push:${ahead.buildId}`))!.status).toBe("verified");
    expect(statements.filter(gateReads)).toEqual([]);
    // Today's, by contrast, reads the day's profiles and checks at claim (the gate) — and the flare closes it.
    statements = [];
    await one();
    expect((await jobOf(`push:${today.buildId}`))!.status).toBe("superseded");
    expect(statements.filter(gateReads).length).toBeGreaterThan(0);
  });
});

describe("kept off the watch (§3.6: watch_off honoured at claim)", () => {
  it.each([
    ["today", DAY],
    ["tomorrow", TOMORROW],
  ])("a provisional push for %s: superseded, nothing written, the record's marker cleared", async (_, day) => {
    const { workoutId, buildId } = await mirrored(day);
    await db.update(plannedWorkouts).set({ watchOff: true }).where(eq(plannedWorkouts.id, workoutId));
    await supersededUnwritten(buildId, () => lane());
    const record = await buildOf(buildId);
    expect(record.lockedAt).toBeNull();
    expect(isProvisionalBuild(record)).toBe(false);
    expect(await sentBuildIdOf(db, workoutId)).toBeNull();
  });

  it("a day's build sent: superseded, nothing written, the build unlocked", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ watchOff: true }).where(eq(plannedWorkouts.id, workoutId));
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).toBeNull();
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

describe("a document workout the day now keeps a move of (Stage 2 batch end: the lane re-gates as Send did)", () => {
  /** A document workout sent at a calm reading: its jump open, its push queued. */
  async function docSent(doc = landingsDoc({ alternates: false })): Promise<{ workoutId: string; buildId: string }> {
    await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx());
    const { workout } = await createDocWorkout(db, userId, { date: DAY, time: "18:00", doc }, ctx());
    const built = await buildSession(db, userId, workout.id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
    const buildId = built.build!.buildId;
    await sendToWatch(db, switchOn(), userId, workout.id, buildId, ctx());
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    return { workoutId: workout.id, buildId };
  }
  /** The jaw rises after Send, before the lane runs: the day's latest reading. */
  // A high reading and feeling off: since 2026-10-23 that is what closes a jump on a Maintain or Develop day.
  const flare = () => recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: "2026-10-09T19:05:00.000Z" });

  it("the reading rose after Send: superseded, nothing written, the build unlocked — the sheet no longer says it is on its way", async () => {
    const { workoutId, buildId } = await docSent();
    await flare();
    await supersededUnwritten(buildId, () => lane());
    expect((await buildOf(buildId)).lockedAt).toBeNull();
    const session = await loadSession(db, userId, workoutId, DAY);
    const state = await watchStateOf(db, switchOn(), userId, await rowOf(db, workoutId), session, prefs);
    expect(state.state).not.toBe("sending");
  });

  it("still calm: it is written, as any push", async () => {
    const { buildId } = await docSent();
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  });

  it("a calm document is written whatever the reading", async () => {
    const { buildId } = await docSent(calmDoc());
    await flare();
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
  });

  it("an engine build is never re-gated: a locked one plays as built, whatever the reading or its stored snapshot says", async () => {
    const { buildId } = await sent();
    // The build's snapshot holds a jump with nothing to stand in for it, and the jaw has risen since Send.
    await db.update(sessionBuilds).set({ workoutDoc: JSON.stringify(landingsDoc({ alternates: false })) }).where(eq(sessionBuilds.id, buildId));
    await flare();
    await lane();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
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
