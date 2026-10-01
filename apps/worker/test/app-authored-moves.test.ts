/**
 * Ruling 2a-R4: a session the APP authored (an adaptive program's slot, an on-demand session) that COROS holds at
 * no address has nothing on the watch to move. Moving it — by hand, by a calendar drag, by the coach, or through
 * the reconciler's catch-up pass — never enqueues a COROS job: before this, `applyMove` compared the new date with
 * `lastVerifiedCorosDate = ''`, saw a change, and queued a move the executor could only mark unsupported, which then
 * read as a sync issue no Retry could clear.
 *
 * The same rows WITH a watch address (a later phase sends sessions to the watch) keep the normal write lane.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { applyOps } from "../src/services/coach-apply.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { computeSyncStatus } from "../src/services/sync-status.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, corosWriteJobs } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  // A write-capable COROS connection: every condition for a COROS write holds except the row's own address.
  await connectTestCoros(db, userId);
  today = todayInZone(prefs.timezone);
});

/** A slot as placement writes it (calendar_only, no watch address), or another app-authored row. */
async function seedAppRow(id: string, date: string, origin: "program" | "on_demand" = "program"): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "prog-1",
    sourceWorkoutId: id,
    title: "Mobility",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin,
    contentState: "outline",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function jobsFor(workoutId: string) {
  return db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
}

async function rowOf(id: string) {
  const [r] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
  return r!;
}

describe("moving an app-authored session with no watch address", () => {
  it.each(["program", "on_demand"] as const)("origin %s: the move is the calendar's only — no job, no open intent", async (origin) => {
    const from = addDays(today, 2);
    const to = addDays(today, 3);
    await seedAppRow("slot-a", from, origin);

    const outcome = await applyMove(db, {
      userId,
      workoutId: "slot-a",
      toDate: to,
      toTime: "18:00",
      source: "app",
      corosWritesEnabled: true,
    });

    expect(outcome).toEqual({ workoutId: "slot-a", corosSyncState: "calendar_only", jobId: undefined });
    expect(await jobsFor("slot-a")).toEqual([]);
    // Nothing is owed to COROS, so nothing is left open for the catch-up pass to turn into a job later.
    expect(await openIntentFor(db, userId, "slot-a", "move")).toBeNull();
    expect(await rowOf("slot-a")).toMatchObject({
      effectiveDate: to,
      effectiveTime: "18:00",
      corosSyncState: "calendar_only",
      lastVerifiedCorosDate: "",
      calendarSyncState: "pending",
    });
    expect(await emitPendingWork(db, userId, { corosWritesEnabled: true })).toBe(0);
    const status = await computeSyncStatus(db, userId, prefs);
    expect(status).toMatchObject({ issueCount: 0, pendingCount: 0 });
  });

  it("a calendar drag and a retry take the same calendar-only lane", async () => {
    await seedAppRow("slot-b", addDays(today, 1));
    await applyMove(db, {
      userId,
      workoutId: "slot-b",
      toDate: addDays(today, 4),
      toTime: "07:00",
      source: "calendar_edit",
      corosWritesEnabled: true,
    });
    // `POST /workouts/:id/retry-coros` re-applies the row's own date.
    await applyMove(db, {
      userId,
      workoutId: "slot-b",
      toDate: addDays(today, 4),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(await jobsFor("slot-b")).toEqual([]);
    expect(await openIntentFor(db, userId, "slot-b", "move")).toBeNull();
  });

  it("the coach's move and swap queue nothing for a slot", async () => {
    const a = addDays(today, 2);
    const b = addDays(today, 5);
    await seedAppRow("slot-c", a);
    await seedAppRow("slot-d", addDays(today, 3), "on_demand");
    await applyOps(db, userId, prefs, "prop-move", [{ kind: "move", workoutId: "slot-c", toDate: b }]);
    expect((await rowOf("slot-c")).effectiveDate).toBe(b);
    await applyOps(db, userId, prefs, "prop-swap", [{ kind: "swap", dayA: b, dayB: addDays(today, 3) }]);
    expect((await rowOf("slot-c")).effectiveDate).toBe(addDays(today, 3));
    expect((await rowOf("slot-d")).effectiveDate).toBe(b);
    expect(await jobsFor("slot-c")).toEqual([]);
    expect(await jobsFor("slot-d")).toEqual([]);
    expect(await emitPendingWork(db, userId, { corosWritesEnabled: true })).toBe(0);
  });

  it("an open move intent left on a slot by an older path is closed by the catch-up pass, never turned into a job", async () => {
    await seedAppRow("slot-e", addDays(today, 2));
    // What `healLegacySyncState` step 3 writes for a calendar_only row whose dates differ ('' vs the slot's day).
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: "slot-e",
      kind: "move",
      payload: { toDate: addDays(today, 2), toTime: "07:00", fromDate: "" },
      source: "auto_resolve",
    });
    expect(await emitPendingWork(db, userId, { corosWritesEnabled: true })).toBe(0);
    expect(await jobsFor("slot-e")).toEqual([]);
    expect(await openIntentFor(db, userId, "slot-e", "move")).toBeNull();
  });

  it("an app-authored row that DOES hold a watch address keeps the COROS write lane", async () => {
    const from = addDays(today, 2);
    await seedAppRow("slot-f", from);
    await db
      .update(plannedWorkouts)
      .set({
        sourceWorkoutId: "4738:91",
        sourceIdInPlan: "91",
        sourceProgramId: "555",
        lastVerifiedCorosDate: from,
        corosSyncState: "synced",
      })
      .where(eq(plannedWorkouts.id, "slot-f"));
    const outcome = await applyMove(db, {
      userId,
      workoutId: "slot-f",
      toDate: addDays(today, 3),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(outcome.jobId).toBeTruthy();
    expect(await jobsFor("slot-f")).toHaveLength(1);
    expect(await openIntentFor(db, userId, "slot-f", "move")).not.toBeNull();
  });
});
