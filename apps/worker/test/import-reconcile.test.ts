import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import { FixtureTrainingProvider } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser, registerTestDevice } from "./helpers.js";

/**
 * Task 6: importPlanSnapshot's date-decision block now delegates to the pure
 * `reconcileWorkout` (Task 4) instead of its own inline rule 4/5/6 logic.
 * These cases pin the observable behavior at the import boundary: rule 4
 * (verify_job) and healing are unchanged; rule 5 (adopt_coros) now also posts
 * an `adopted_coros_change` note; rule 6 (app_wins) no longer produces
 * `needs_attention` — it supersedes the pending job, keeps the app's date,
 * and posts a `kept_local_change` note, leaving `emitPendingWork` (called by
 * the bridge/sync route right after import) to re-derive the write.
 */

const { plannedWorkouts, corosWriteJobs, syncNotes } = schema;

// Fixture's raw COROS plan id — not validated by the fixture provider's write
// path (only sourceIdInPlan is), but mirrors vertical-loop.test.ts's usage.
const EXTERNAL_PLAN_ID = "800000000000001234";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let provider: FixtureTrainingProvider;
let baseMonday: string;

async function importFromProvider() {
  const plan = await provider.getCurrentPlan();
  const range = { start: baseMonday, end: addDays(baseMonday, 13) };
  const workouts = await provider.getPlannedWorkouts(range);
  return importPlanSnapshot(
    db,
    { userId, plan: plan!, workouts, rangeStart: range.start, rangeEnd: range.end, source: "fixture" },
    prefs,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  await registerTestDevice(db, userId);
  const today = todayInZone(prefs.timezone);
  baseMonday = addDays(today, 2);
  provider = new FixtureTrainingProvider({ baseMonday });
});

describe("importPlanSnapshot through the reconciler", () => {
  it("rule 5 replacement: upstream move with no open intent adopts COROS and posts an adopted_coros_change note", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const previousDate = w.lastVerifiedCorosDate;
    const newDate = addDays(w.effectiveDate, 2);

    await provider.updateScheduledWorkout({
      sourcePlanId: EXTERNAL_PLAN_ID,
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate: newDate,
      operationId: "external",
    });

    const stats = await importFromProvider();
    expect(stats.updatedDates).toBe(1);

    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.effectiveDate).toBe(newDate);
    expect(after.lastVerifiedCorosDate).toBe(newDate);
    expect(after.corosSyncState).toBe("synced");

    const notes = await db.select().from(syncNotes).where(eq(syncNotes.workoutId, w.id));
    const note = notes.find((n) => n.kind === "adopted_coros_change");
    expect(note).toBeTruthy();
    expect(note!.payload).toEqual({ previousDate, newDate });
  });

  it("first import of a brand-new workout posts no sync note (nothing displaced)", async () => {
    const stats = await importFromProvider();
    expect(stats.created).toBeGreaterThan(0);

    const notes = await db.select().from(syncNotes).where(eq(syncNotes.userId, userId));
    expect(notes).toHaveLength(0);
  });

  it("rule 6 replacement: upstream change during a pending move keeps the app's date, supersedes the job, notes the conflict, and lets emitPendingWork re-derive it", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const appToDate = addDays(w.effectiveDate, 1);
    const outcome = await applyMove(db, {
      userId,
      workoutId: w.id,
      toDate: appToDate,
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const originalJobId = outcome.jobId!;

    // Upstream, someone moved it somewhere else entirely — not the app's
    // requested destination.
    const corosToDate = addDays(w.effectiveDate, 3);
    await provider.updateScheduledWorkout({
      sourcePlanId: EXTERNAL_PLAN_ID,
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate: corosToDate,
      operationId: "external",
    });

    await importFromProvider();

    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.effectiveDate).toBe(appToDate); // app's placement kept
    expect(after.lastVerifiedCorosDate).toBe(corosToDate);
    expect(after.corosSyncState).toBe("calendar_only"); // NOT needs_attention
    expect(after.corosSyncState).not.toBe("needs_attention");

    const supersededJob = (
      await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, originalJobId))
    )[0]!;
    expect(supersededJob.status).toBe("superseded");

    const notes = await db.select().from(syncNotes).where(eq(syncNotes.workoutId, w.id));
    const note = notes.find((n) => n.kind === "kept_local_change");
    expect(note).toBeTruthy();
    expect(note!.payload).toEqual({ displacedDate: corosToDate, keptDate: appToDate });

    // The bridge/sync route calls emitPendingWork right after import; the
    // still-open intent (never resolved by app_wins) gets a fresh job.
    const emitted = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(emitted).toBe(1);
    const jobsAfter = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.workoutId, w.id));
    const newJob = jobsAfter.find((j) => j.id !== originalJobId);
    expect(newJob).toBeTruthy();
    expect(newJob!.status).toBe("queued");
    expect(newJob!.destinationDate).toBe(appToDate);
  });

  it("rule 4 unchanged: COROS reporting our pending destination verifies the job, resolves the intent, and syncs", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const toDate = addDays(w.effectiveDate, 1);
    const outcome = await applyMove(db, {
      userId,
      workoutId: w.id,
      toDate,
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });

    await provider.updateScheduledWorkout({
      sourcePlanId: EXTERNAL_PLAN_ID,
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate,
      operationId: "external-confirms-move",
    });

    const stats = await importFromProvider();
    expect(stats.verifiedJobs).toBe(1);

    const job = (
      await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, outcome.jobId!))
    )[0]!;
    expect(job.status).toBe("verified");

    const intent = await openIntentFor(db, userId, w.id, "move");
    expect(intent).toBeNull();

    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.corosSyncState).toBe("synced");
    expect(after.lastVerifiedCorosDate).toBe(toDate);
  });

  it("healing unchanged: a calendar_only row whose dates agree with a fresh read becomes synced", async () => {
    await importFromProvider();
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    await db
      .update(plannedWorkouts)
      .set({ corosSyncState: "calendar_only" })
      .where(eq(plannedWorkouts.id, rows[0]!.id));

    await importFromProvider();
    const after = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, rows[0]!.id))
    )[0]!;
    expect(after.corosSyncState).toBe("synced");
  });
});
