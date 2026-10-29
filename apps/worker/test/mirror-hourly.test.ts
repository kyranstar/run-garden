/**
 * ONE WATCH JOB AN INVOCATION (the watch mirrors the plan §3.7; builder check A5).
 *
 * A push drain measures ≈31–34 of the 45 an invocation may spend, an unpush 29, the mirror sweep with a record ≤15: two
 * of them never fit one invocation. So the hourly runs the sweep OR one watch drain — the sweep (heavy step `mirror`)
 * when an owed mark or a window session whose copy is not current is found (`mirrorNeedsRun`, one read) and no other
 * heavy step ran; else the drain, as before. A sweep that finds nothing to make (a push waiting out its backoff, a
 * session remembered too long) is no heavy step: the drain still runs, so no such session ever holds it up.
 * Invented data; the fixture clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
// The mirror before the rest (the watch-push mock below: session-build ↔ mirror ↔ watch-push is a cycle).
import { markMirrorOwed, MIRROR_RETRY_BACKOFF_MS, MIRROR_WINDOW_DAYS, mirrorNeedsRun, mirrorSweep, queueProvisionalPush } from "../src/services/mirror.js";
import { hourly } from "../src/index.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { connectMock, counting, DAY, NOON, rowOf, seedCatalog, seedProgram, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds, syncRuns } = schema;

vi.setConfig({ testTimeout: 60_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
/** A session whose copy's push throws as it is written (as a failed D1 write would): the sweep's write phase propagates. */
const broken = vi.hoisted(() => ({ write: null as string | null }));
vi.mock("../src/services/watch-push.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/watch-push.js")>();
  const queuePushJob: typeof real.queuePushJob = async (...args) => {
    if (broken.write !== null && args[2].id === broken.write) throw new Error("D1_ERROR: the write failed");
    return real.queuePushJob(...args);
  };
  return { ...real, queuePushJob };
});

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let wire: ReturnType<typeof counting>;
let statements: string[] = [];
let seq = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  broken.write = null;
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  wire = counting(server);
  vi.stubGlobal("fetch", wire.fetchImpl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

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

/** Far more work steps than the watch holds: the mirror remembers it too long for its revision and day. */
function longDoc(): WorkoutDoc {
  const ids = ["bridge", "deadBug"];
  return workoutDocSchema.parse({
    ...calmDoc(),
    title: "Very long",
    parts: [{ purpose: "main", format: "straight", items: Array.from({ length: 11 }, (_, i) => ({ kind: "exercise", libraryId: ids[i % 2], dose: { sets: 20, reps: 5, restSec: 10 } })) }],
  });
}

/** The row's provisional copy queued, as a drain or an earlier sweep leaves it. */
const queued = async (id: string) => expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), ctx())).toBe("queued");
const recordsOf = (id: string) => db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, id), lt(sessionBuilds.version, 0)));
const pushesOf = async (id: string) =>
  (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).filter((j) => j.kind === "program_session_push");
const statusesOf = async (id: string) => (await pushesOf(id)).map((j) => j.status);

const reconcileRuns = () => db.select().from(syncRuns).where(and(eq(syncRuns.userId, userId), eq(syncRuns.kind, "reconcile")));

/** One hourly invocation (the clock is pinned, so its run row is told apart by id): its run row's status and heavy step. */
async function hourlyRun(env = switchOn()): Promise<{ status: string; heavyStep: string | null; mirrorError: string | null }> {
  const seen = new Set((await reconcileRuns()).map((r) => r.id));
  await hourly(db, env);
  const run = (await reconcileRuns()).find((r) => !seen.has(r.id))!;
  const stats = run.stats as { heavyStep?: string | null; mirrorError?: string } | null;
  return { status: run.status, heavyStep: stats?.heavyStep ?? null, mirrorError: stats?.mirrorError ?? null };
}

/** One hourly invocation: its heavy step, the records it made, the COROS writes it sent. */
async function hour(): Promise<{ heavyStep: string | null; records: number; writes: number }> {
  const recordsBefore = (await db.select().from(sessionBuilds).where(lt(sessionBuilds.version, 0))).length;
  const writesBefore = wire.writes();
  const run = await hourlyRun();
  expect(run.status).toBe("ok");
  const records = (await db.select().from(sessionBuilds).where(lt(sessionBuilds.version, 0))).length - recordsBefore;
  return { heavyStep: run.heavyStep, records, writes: wire.writes() - writesBefore };
}

describe("mirrorNeedsRun — is there work for the sweep? (one read)", () => {
  it("an open owed mark, or a window session with no current copy: true; every copy current, or nothing ahead: false — in one statement", async () => {
    statements = [];
    expect(await mirrorNeedsRun(db, userId, DAY)).toBe(false);
    expect(statements).toHaveLength(1);

    const ahead = await seedDocRow(addDays(DAY, 2));
    expect(await mirrorNeedsRun(db, userId, DAY), "a window session never pushed").toBe(true);
    await queued(ahead);
    expect(await mirrorNeedsRun(db, userId, DAY), "its push on its way: current").toBe(false);
    await markMirrorOwed(db, userId, ahead, NOON);
    statements = [];
    expect(await mirrorNeedsRun(db, userId, DAY), "owed again").toBe(true);
    expect(statements).toHaveLength(1);
  });

  it("false for what the sweep never pushes: kept off, beyond the window, a day gone, done, skipped, a run, a rest day, an engine slot", async () => {
    await seedDocRow(addDays(DAY, 2), { watchOff: true });
    await seedDocRow(addDays(DAY, MIRROR_WINDOW_DAYS + 1));
    await seedDocRow(addDays(DAY, -1));
    await seedDocRow(DAY, { contentState: "done" });
    await seedDocRow(addDays(DAY, 1), { completionState: "skipped" });
    await seedDocRow(addDays(DAY, 1), { sport: "run", category: "easy" });
    await seedDocRow(addDays(DAY, 1), { category: "rest" });
    await seedDocRow(addDays(DAY, 1), { origin: "program", workoutDoc: null, workoutDocRev: null });
    expect(await mirrorNeedsRun(db, userId, DAY)).toBe(false);
  });

  it("a session remembered too long for its revision and day: false once judged (it never holds the drain up)", async () => {
    await seedDocRow(addDays(DAY, 1), {}, longDoc());
    expect(await mirrorNeedsRun(db, userId, DAY)).toBe(true);
    expect(await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).toMatchObject({ queued: 0, attempted: 1, skipped: { too_long: 1 } });
    expect(await mirrorNeedsRun(db, userId, DAY)).toBe(false);
  });

  it("an error past its backoff ladder (given up for its revision and day): false — before then, true", async () => {
    const id = await seedDocRow(addDays(DAY, 1));
    const memory = (count: number) => ({ refused: "error", rev: 1, day: addDays(DAY, 1), message: "Error: x", at: NOON, count });
    await db.insert(schema.syncIntents).values({
      id: `mirror-${id}`, userId, targetKind: "workout", targetId: id, kind: "mirror", payload: memory(MIRROR_RETRY_BACKOFF_MS.length),
      source: "mirror", createdAt: NOON, resolvedAt: NOON,
    });
    expect(await mirrorNeedsRun(db, userId, DAY), "still on the ladder: the sweep tries it again after its backoff").toBe(true);
    await db.update(schema.syncIntents).set({ payload: memory(MIRROR_RETRY_BACKOFF_MS.length + 1) }).where(eq(schema.syncIntents.id, `mirror-${id}`));
    expect(await mirrorNeedsRun(db, userId, DAY), "given up").toBe(false);
    expect(await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).toMatchObject({ attempted: 0, skipped: { gave_up: 1 } });
  });

  it("a verified copy whose row lost its address (the copy went missing on the watch): true", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await queued(id);
    const [push] = await pushesOf(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, push!.id));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "900:41", sourceIdInPlan: "41", sourceProgramId: "77", lastVerifiedCorosDate: addDays(DAY, 2) })
      .where(eq(plannedWorkouts.id, id));
    expect(await mirrorNeedsRun(db, userId, DAY), "verified, holding its address").toBe(false);
    await db.update(plannedWorkouts).set({ sourceWorkoutId: id, sourceIdInPlan: null, sourceProgramId: null, lastVerifiedCorosDate: "" }).where(eq(plannedWorkouts.id, id));
    expect(await mirrorNeedsRun(db, userId, DAY), "the address cleared").toBe(true);
  });

  it("a verified copy the import saw changed in the COROS app (`noticed` on its push): true — the sweep replaces it", async () => {
    const id = await seedDocRow(addDays(DAY, 2));
    await queued(id);
    const [push] = await pushesOf(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, push!.id));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "900:41", sourceIdInPlan: "41", sourceProgramId: "77", lastVerifiedCorosDate: addDays(DAY, 2) })
      .where(eq(plannedWorkouts.id, id));
    expect(await mirrorNeedsRun(db, userId, DAY), "verified, as pushed").toBe(false);
    const payload = { ...(push!.payload as Record<string, unknown>), noticed: { wire: "w2", text: "t2" } };
    await db.update(corosWriteJobs).set({ payload }).where(eq(corosWriteJobs.id, push!.id));
    expect(await mirrorNeedsRun(db, userId, DAY), "changed in COROS").toBe(true);
    expect(await mirrorSweep(db, switchOn(), userId, prefs, ctx(), { cap: 1 })).toMatchObject({ queued: 1 });
  });
});

describe("the hourly runs the sweep OR the drain — never two watch jobs in one invocation", () => {
  it("an owed session's record is the run's heavy step (no job runs with it); then one job a run until the copies are on the watch", async () => {
    // B's copy is queued already; A is owed (a Studio add): a record to make AND a job to run.
    const b = await seedDocRow(addDays(DAY, 3));
    await queued(b);
    const a = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, a, NOON);

    const first = await hour();
    expect(first).toEqual({ heavyStep: "mirror", records: 1, writes: 0 });
    expect(await recordsOf(a)).toHaveLength(1);
    expect(await statusesOf(a)).toEqual(["queued"]);
    expect(await statusesOf(b)).toEqual(["queued"]);

    const second = await hour();
    expect(second).toMatchObject({ heavyStep: "coros_write", records: 0 });
    expect([...(await statusesOf(a)), ...(await statusesOf(b))].sort()).toEqual(["queued", "verified"]);

    const third = await hour();
    expect(third).toMatchObject({ heavyStep: "coros_write", records: 0 });
    expect([...(await statusesOf(a)), ...(await statusesOf(b))]).toEqual(["verified", "verified"]);

    // Both copies on the watch (their rows hold the addresses): nothing for the sweep, nothing to drain.
    expect(await mirrorNeedsRun(db, userId, DAY)).toBe(false);
    const fourth = await hour();
    expect(fourth.records).toBe(0);
    expect(fourth.writes).toBe(0);
    expect(["mirror", "coros_write"]).not.toContain(fourth.heavyStep);
  });

  it("the sweep runs only when no other heavy step ran: the garden's walk of more than a day takes the run, and the sweep waits", async () => {
    // A garden grown as of a few days ago (an account back after a few days away): the next run walks them.
    await ensureGarden(db, userId, prefs, addDays(DAY, -30));
    await advanceGarden(db, userId, prefs, new Date(Date.parse(NOON) - 2 * 86_400_000));
    const a = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, a, NOON);

    // Each run that walks is the garden's: no record made, nothing written — the owed session waits.
    let walked = 0;
    let run = await hour();
    for (; run.heavyStep === "garden" && walked < 5; walked += 1) {
      expect(run).toEqual({ heavyStep: "garden", records: 0, writes: 0 });
      expect(await recordsOf(a)).toHaveLength(0);
      run = await hour();
    }
    expect(walked).toBeGreaterThan(0);
    // The garden caught up: the next run is the mirror's.
    expect(run).toEqual({ heavyStep: "mirror", records: 1, writes: 0 });
  });

  it("a sweep with nothing to make is no heavy step: a push waiting out its backoff, or a session remembered too long, never holds the drain up", async () => {
    // C's push failed a moment ago (its backoff not over); L is too long for the watch; B's copy is queued.
    const c = await seedDocRow(addDays(DAY, 1));
    await queued(c);
    const [failed] = await pushesOf(c);
    await db.update(corosWriteJobs).set({ status: "failed", updatedAt: NOON }).where(eq(corosWriteJobs.id, failed!.id));
    const long = await seedDocRow(addDays(DAY, 2), {}, longDoc());
    const b = await seedDocRow(addDays(DAY, 3));
    await queued(b);

    // L is judged first (its too-long refusal is the sweep's attempt: the run's heavy step), C waits out its backoff.
    expect(await hour()).toEqual({ heavyStep: "mirror", records: 0, writes: 0 });
    expect(await statusesOf(b)).toEqual(["queued"]);
    // Nothing left for the sweep to make: the drain runs B's push.
    expect(await mirrorNeedsRun(db, userId, DAY), "C's failed push still reads as not current").toBe(true);
    const drained = await hour();
    expect(drained).toMatchObject({ heavyStep: "coros_write", records: 0 });
    expect(await statusesOf(b)).toEqual(["verified"]);
    expect(await statusesOf(c)).toEqual(["failed"]);
    expect(await recordsOf(long)).toHaveLength(0);
  });

  it("a sweep that throws while writing: the hourly still drains one job, and records the error on the run row", async () => {
    const b = await seedDocRow(addDays(DAY, 3));
    await queued(b);
    const a = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, a, NOON);
    broken.write = a;

    const run = await hourlyRun();
    expect(run).toEqual({ status: "ok", heavyStep: "coros_write", mirrorError: "Error: D1_ERROR: the write failed" });
    expect(await statusesOf(b)).toEqual(["verified"]);
    expect(await statusesOf(a)).toEqual([]);

    // Healed: the next run makes A's copy (its mark still open — a write-phase throw remembers nothing).
    broken.write = null;
    expect(await hour()).toEqual({ heavyStep: "mirror", records: 1, writes: 0 });
    expect(await statusesOf(a)).toEqual(["queued"]);
  });

  it("the switch off, or writes off: no mirror turn — the drain runs as before", async () => {
    const a = await seedDocRow(addDays(DAY, 2));
    await markMirrorOwed(db, userId, a, NOON);
    expect((await hourlyRun(switchOn({ WATCH_PUSH_ENABLED: undefined }))).heavyStep).not.toBe("mirror");
    expect(await recordsOf(a)).toHaveLength(0);
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: false });
    expect((await hourlyRun()).heavyStep).not.toBe("mirror");
    expect(await recordsOf(a)).toHaveLength(0);
  });
});


