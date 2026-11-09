/**
 * A GUARDED MOVE LEAVES WHAT AN UNGUARDED ONE LEAVES (re-review 2, M-2). The guarded move (`onlyIf`, one batch: jobs.ts
 * `guardedMove`) writes, as statements, what the unguarded move writes in turn — the supersede, the owe, the unpush's
 * re-queue and the build's unlock exist twice (watch-push.ts `unpushBuildStatements` beside `unpushBuild`). So the same move,
 * from the same rows, once each way on two copies of the database: every table of it compared, row by row, and the answer.
 * Ids the move makes itself are random, and read as NEW. Synthetic data only; the clock pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyMove } from "../src/services/jobs.js";
import { buildSession, startSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { cloneTestDb, connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";
import { DAY, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
});
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const raw = (d: Db) => (d as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).$client;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Every table of the database (the migrations' own bookkeeping left out). */
const tables = (d: Db) => raw(d).prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%migrations%' order by name`).all().map((r) => r.name as string);

/** Each table's rows, sorted; an id the database didn't hold before the move reads as NEW. */
function snapshot(d: Db, known: ReadonlySet<string>): Record<string, string[]> {
  return Object.fromEntries(tables(d).map((t) => [t, raw(d).prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r).replace(UUID, (m) => (known.has(m) ? m : "NEW"))).sort()]));
}
function knownIds(d: Db): Set<string> {
  const ids = new Set<string>();
  for (const t of tables(d)) for (const r of raw(d).prepare(`select * from "${t}"`).all()) for (const m of JSON.stringify(r).match(UUID) ?? []) ids.add(m);
  return ids;
}

async function sentSlot(opts: { verified?: boolean } = {}) {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  if (opts.verified) {
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, workoutId));
  }
  return { workoutId, buildId };
}

async function coachRow(id: string, date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coach-plan", sourceWorkoutId: "123:2", sourceIdInPlan: "2", sourceProgramId: "92", title: "Tempo", category: "quality", qualitySubtype: "tempo", sport: "run",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "0123456789abcdef", calendarBlockDurationSeconds: 2100,
    fallbackEstimatedDurationSeconds: 2100, corosSyncState: "synced", createdAt: NOON, updatedAt: NOON, ...over,
  });
}

const unpushOf = (workoutId: string, buildId: string, status: string) =>
  db.insert(corosWriteJobs).values({ id: `unpush:${buildId}`, userId, workoutId, kind: "coach_delete_workout", expectedContentFingerprint: "", originalDate: DAY, destinationDate: DAY, requestedAt: NOON, status, updatedAt: NOON, payload: { workoutId, happenDay: DAY, name: "x", idInPlan: "91", programId: "91", corosPlanId: "4738" } } as never);

/** The move once unguarded and once guarded (a guard that holds), each on its own copy: what differs, table by table. */
async function bothWays(workoutId: string, toDate: string, toTime: string, writes = true) {
  const known = knownIds(db);
  const plain = cloneTestDb(db, { boundVariableCap: 100 });
  const guarded = cloneTestDb(db, { boundVariableCap: 100 });
  const req = { userId, workoutId, toDate, toTime, source: "app" as const, corosWritesEnabled: writes };
  const answer = (o: { jobId?: string }) => ({ ...o, jobId: o.jobId ? "JOB" : undefined });
  const outPlain = await applyMove(plain, req).then(answer, (e: Error) => ({ threw: e.message }));
  const outGuarded = await applyMove(guarded, { ...req, onlyIf: sql`1 = 1` }).then(answer, (e: Error) => ({ threw: e.message }));
  const a = snapshot(plain, known);
  const b = snapshot(guarded, known);
  const differs: Record<string, { unguarded: string[]; guarded: string[] }> = {};
  for (const t of Object.keys(a)) {
    const onlyA = a[t]!.filter((x) => !b[t]!.includes(x));
    const onlyB = b[t]!.filter((x) => !a[t]!.includes(x));
    if (onlyA.length || onlyB.length || a[t]!.length !== b[t]!.length) differs[t] = { unguarded: onlyA, guarded: onlyB };
  }
  // The move did write something: a parity of two no-ops would show nothing.
  expect(Object.keys(a).some((t) => a[t]!.join() !== snapshot(db, known)[t]!.join())).toBe(true);
  return { outPlain, outGuarded, differs };
}

describe("a guarded move (one batch) leaves what the unguarded move leaves, every table, row by row", () => {
  it.each([
    ["a sent slot on the watch, writes on, to tomorrow", async () => ({ id: (await sentSlot({ verified: true })).workoutId, to: TOMORROW, time: "18:00", writes: true })],
    ["a sent slot on the watch, writes off (its unpush owed)", async () => ({ id: (await sentSlot({ verified: true })).workoutId, to: TOMORROW, time: "18:00", writes: false })],
    ["a sent slot whose push is still queued (superseded)", async () => ({ id: (await sentSlot()).workoutId, to: TOMORROW, time: "18:00", writes: true })],
    [
      "a built slot never sent",
      async () => {
        const id = await seedSlot(db, userId, programId, DAY);
        await buildSession(db, userId, id, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
        return { id, to: TOMORROW, time: "18:00", writes: true };
      },
    ],
    [
      "a started sent slot (its build left locked)",
      async () => {
        const { workoutId, buildId } = await sentSlot({ verified: true });
        await startSession(db, userId, workoutId, buildId, NOON);
        return { id: workoutId, to: TOMORROW, time: "18:00", writes: true };
      },
    ],
    [
      "a document workout holding an adopted copy (its copy taken off, its mirror owed)",
      async () => {
        await coachRow("doc-1", DAY, { origin: "studio", contentState: "outline", watchCopyName: "Tempo ~ old", planId: "studio-plan", sourceWorkoutId: "4738:5" });
        return { id: "doc-1", to: TOMORROW, time: "18:00", writes: true };
      },
    ],
    [
      "a coach row on the watch, writes on, to a new date (its move job, the old one superseded, the audit naming it)",
      async () => {
        await coachRow("cw-1", DAY);
        await db.insert(corosWriteJobs).values({ id: "old-move", userId, workoutId: "cw-1", kind: "move_scheduled_workout", expectedContentFingerprint: "x", originalDate: DAY, destinationDate: "2026-10-12", requestedAt: NOON, status: "queued", updatedAt: NOON } as never);
        return { id: "cw-1", to: TOMORROW, time: "12:00", writes: true };
      },
    ],
    [
      "a coach row moved back to its verified date (an in-flight move superseded)",
      async () => {
        await coachRow("cw-2", DAY, { effectiveDate: TOMORROW });
        await db.insert(corosWriteJobs).values({ id: "inflight", userId, workoutId: "cw-2", kind: "move_scheduled_workout", expectedContentFingerprint: "x", originalDate: DAY, destinationDate: TOMORROW, requestedAt: NOON, status: "claimed", updatedAt: NOON } as never);
        return { id: "cw-2", to: DAY, time: "12:00", writes: true };
      },
    ],
    [
      "a coach row, writes off",
      async () => {
        await coachRow("cw-3", DAY);
        return { id: "cw-3", to: TOMORROW, time: "12:00", writes: false };
      },
    ],
    ["a sent slot, its time alone", async () => ({ id: (await sentSlot({ verified: true })).workoutId, to: DAY, time: "07:30", writes: true })],
    [
      "a sent slot whose unpush was done before (re-queued)",
      async () => {
        const { workoutId, buildId } = await sentSlot({ verified: true });
        await unpushOf(workoutId, buildId, "verified");
        return { id: workoutId, to: TOMORROW, time: "18:00", writes: true };
      },
    ],
    [
      "a sent slot whose unpush is live (in progress: left as it is)",
      async () => {
        const { workoutId, buildId } = await sentSlot({ verified: true });
        await unpushOf(workoutId, buildId, "in_progress");
        return { id: workoutId, to: TOMORROW, time: "18:00", writes: true };
      },
    ],
  ] as const)("%s", async (_name, shape) => {
    const s = await shape();
    const r = await bothWays(s.id, s.to, s.time, s.writes);
    expect(r.differs).toEqual({});
    expect(r.outGuarded).toEqual(r.outPlain);
  });
});
