import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import {
  FixtureTrainingProvider,
  fixtureCorosCompletedThreshold,
  fixtureStravaCompletedThreshold,
  normalizeCorosActivity,
  normalizeStravaActivity,
} from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { applyMove, claimNextJob, applyJobResult } from "../src/services/jobs.js";
import { ingestActivities } from "../src/services/completion.js";
import { advanceGarden, buildDayInput, buildGardenView, loadGarden } from "../src/services/garden-sync.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { makeTestDb, makeTestUser, registerTestDevice } from "./helpers.js";

/**
 * The core vertical loop (product spec, Phase 3):
 * import → calendar-ready workout → move → COROS write job → verify →
 * activity arrives (Strava then COROS) → merge → completion → garden growth.
 */

const { plannedWorkouts, corosWriteJobs, activities, workoutCompletionMatches, trainingPlans, calendarEventSuppressions } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let deviceId: string;
let provider: FixtureTrainingProvider;
let baseMonday: string;

async function importFromProvider() {
  const plan = await provider.getCurrentPlan();
  const range = { start: baseMonday, end: addDays(baseMonday, 13) };
  const workouts = await provider.getPlannedWorkouts(range);
  return importPlanSnapshot(
    db,
    {
      userId,
      plan: plan!,
      workouts,
      rangeStart: range.start,
      rangeEnd: range.end,
      source: "fixture",
    },
    prefs,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  deviceId = await registerTestDevice(db, userId);
  // A plan whose first week starts next Monday-ish relative to "today".
  const today = todayInZone(prefs.timezone);
  baseMonday = addDays(today, 2);
  provider = new FixtureTrainingProvider({ baseMonday });
});

describe("plan import", () => {
  it("imports the active plan with native durations and correct states", async () => {
    const stats = await importFromProvider();
    expect(stats.created).toBe(11);
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    const threshold = rows.find((w) => w.title === "Threshold 5x5")!;
    expect(threshold.sourceEstimatedDurationSeconds).toBe(3240); // COROS-native
    expect(threshold.category).toBe("quality");
    expect(threshold.calendarBlockDurationSeconds).toBe(3240 + 25 * 60);
    expect(threshold.corosSyncState).toBe("synced");
    expect(threshold.completionState).toBe("scheduled");
    expect(threshold.calendarSyncState).toBe("pending");
    const rest = rows.find((w) => w.category === "rest")!;
    expect(rest.calendarSyncState).toBe("not_created"); // no events for rest days

    // Re-import is idempotent.
    const again = await importFromProvider();
    expect(again.created).toBe(0);
    expect(again.unchanged).toBeGreaterThan(0);
  });

  it("heals stale calendar_only/needs_attention rows when a read proves the dates agree", async () => {
    await importFromProvider();
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    // Simulate rows stamped before agreement-based sync states existed.
    await db
      .update(plannedWorkouts)
      .set({ corosSyncState: "calendar_only" })
      .where(eq(plannedWorkouts.id, rows[0]!.id));
    await db
      .update(plannedWorkouts)
      .set({ corosSyncState: "needs_attention" })
      .where(eq(plannedWorkouts.id, rows[1]!.id));

    await importFromProvider();
    const healed = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    expect(healed.every((w) => w.corosSyncState === "synced")).toBe(true);
  });

  it("imports a merged multi-plan snapshot into separate plan rows without cross-plan archival", async () => {
    await importFromProvider();
    const before = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));

    // Same snapshot again, now carrying a second plan's lifting sessions —
    // exactly what schedule/query returns after a studio push (research §3).
    const plan = await provider.getCurrentPlan();
    const range = { start: baseMonday, end: addDays(baseMonday, 13) };
    const workouts = await provider.getPlannedWorkouts(range);
    const lifting = [0, 1].map((i) => ({
      sourcePlanId: "999",
      sourceWorkoutId: `999:${i + 1}`,
      sourceIdInPlan: String(i + 1),
      sourceProgramId: `p99${i}`,
      title: `W1 Lift ${i + 1} — wk 1`,
      sport: "strength",
      date: addDays(baseMonday, i + 1),
      estimatedDurationSeconds: 2700,
      stages: [],
      contentFingerprint: `lift-fp-${i}`,
      isRestDay: false,
    }));
    const stats = await importPlanSnapshot(
      db,
      {
        userId,
        plan: plan!,
        workouts: [...workouts, ...lifting] as never,
        rangeStart: range.start,
        rangeEnd: range.end,
        source: "fixture",
      },
      prefs,
    );

    expect(stats.created).toBe(2); // the two lifting sessions, nothing else
    expect(stats.archivedMissing).toBe(0); // the run plan was NOT mass-archived

    const plans = await db.select().from(trainingPlans).where(eq(trainingPlans.userId, userId));
    expect(plans).toHaveLength(2);
    const liftPlan = plans.find((p) => p.sourcePlanId === "999")!;
    expect(liftPlan.name).toBe("Lifting plan");
    expect(liftPlan.status).toBe("active");

    const after = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    const strengthRows = after.filter((w) => w.sport === "strength");
    expect(strengthRows).toHaveLength(2);
    expect(strengthRows.every((w) => w.planId === liftPlan.id)).toBe(true);
    // Run workouts untouched: same rows, same dates.
    for (const b of before) {
      const a = after.find((w) => w.id === b.id)!;
      expect(a.effectiveDate).toBe(b.effectiveDate);
      expect(a.archivedAt).toBeNull();
    }
  });

  it("rewrites a row in place when COROS recycles its idInPlan slot for a different sport", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;

    // Upstream, the run entity was deleted and its slot reused by a lifting
    // session — same wire id, different workout entirely.
    const plan = await provider.getCurrentPlan();
    const range = { start: baseMonday, end: addDays(baseMonday, 13) };
    const others = (await provider.getPlannedWorkouts(range)).filter(
      (x) => x.sourceWorkoutId !== w.sourceWorkoutId,
    );
    const recycled = {
      sourcePlanId: w.sourceWorkoutId.split(":")[0]!,
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      sourceProgramId: "recycled-prog",
      title: "W1 Wed - Posterior Chain — wk 1",
      sport: "strength",
      date: w.effectiveDate,
      estimatedDurationSeconds: 2700,
      stages: [],
      contentFingerprint: "recycled-fp",
      isRestDay: false,
    };
    const stats = await importPlanSnapshot(
      db,
      { userId, plan: plan!, workouts: [...others, recycled] as never, rangeStart: range.start, rangeEnd: range.end, source: "fixture" },
      prefs,
    );

    expect(stats.replacedRecycled).toBe(1);
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.sport).toBe("strength");
    expect(after.title).toBe("W1 Wed - Posterior Chain — wk 1");
    expect(after.completionState).toBe("scheduled");
    expect(after.archivedAt).toBeNull();
  });

  it("dedupes COROS's plan-definition/instance mirror so each session shows once", async () => {
    await importFromProvider();
    const plan = await provider.getCurrentPlan();
    const range = { start: baseMonday, end: addDays(baseMonday, 13) };
    const workouts = await provider.getPlannedWorkouts(range);
    // The mirror: identical dates+titles under a different plan id.
    const mirror = workouts.map((w, i) => ({
      ...w,
      sourcePlanId: "888",
      sourceWorkoutId: `888:${i + 1}`,
      sourceIdInPlan: String(i + 1),
    }));
    const stats = await importPlanSnapshot(
      db,
      { userId, plan: plan!, workouts: [...workouts, ...mirror] as never, rangeStart: range.start, rangeEnd: range.end, source: "fixture" },
      prefs,
    );

    expect(stats.dedupedMirrors).toBeGreaterThan(0);
    const active = await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt)));
    const keys = active.map((w) => `${w.effectiveDate}|${w.title}`);
    expect(new Set(keys).size).toBe(keys.length); // no visible duplicates
  });

  it("skips COROS template/sample plans entirely (no stamp, no mirror overlap)", async () => {
    await importFromProvider();
    const plan = await provider.getCurrentPlan();
    const range = { start: baseMonday, end: addDays(baseMonday, 13) };
    const workouts = await provider.getPlannedWorkouts(range);
    const template = [0, 1, 2].map((i) => ({
      sourcePlanId: "777",
      sourceWorkoutId: `777:${i + 1}`,
      sourceIdInPlan: String(i + 1),
      title: `Easy Run - Sample Workout ${i + 1}`,
      sport: "run",
      date: addDays(baseMonday, i),
      stages: [],
      contentFingerprint: `sample-${i}`,
      isRestDay: false,
    }));
    const stats = await importPlanSnapshot(
      db,
      { userId, plan: plan!, workouts: [...workouts, ...template] as never, rangeStart: range.start, rangeEnd: range.end, source: "fixture" },
      prefs,
    );

    expect(stats.skippedForeignWorkouts).toBe(3);
    expect(stats.created).toBe(0);
    const plans = await db.select().from(trainingPlans).where(eq(trainingPlans.userId, userId));
    expect(plans.find((p) => p.sourcePlanId === "777")).toBeUndefined();
  });

  it("presence resurrects a wrongly archived scheduled workout (and drops its suppression)", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const now = nowInstant();
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: now })
      .where(eq(plannedWorkouts.id, w.id));
    await db.insert(calendarEventSuppressions).values({
      id: newId(),
      workoutId: w.id,
      eventId: null,
      reason: "workout_removed",
      createdAt: now,
    });

    const stats = await importFromProvider();
    expect(stats.unarchived).toBe(1);
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.archivedAt).toBeNull();
    expect(after.calendarSyncState).toBe("pending"); // event gets recreated
    const suppressions = await db
      .select()
      .from(calendarEventSuppressions)
      .where(eq(calendarEventSuppressions.workoutId, w.id));
    expect(suppressions).toHaveLength(0);
  });

  it("a user-removed workout stays removed even though COROS still schedules it", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const now = nowInstant();
    await db.update(plannedWorkouts).set({ archivedAt: now }).where(eq(plannedWorkouts.id, w.id));
    await db.insert(calendarEventSuppressions).values({
      id: newId(),
      workoutId: w.id,
      eventId: null,
      reason: "user_removed",
      createdAt: now,
    });

    const stats = await importFromProvider();
    expect(stats.unarchived).toBe(0);
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.archivedAt).not.toBeNull();
  });

  it("does NOT heal a genuinely divergent workout (local move COROS never got)", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    // Local move with writes disabled: effectiveDate diverges from COROS.
    await applyMove(db, {
      userId,
      workoutId: w.id,
      toDate: addDays(w.effectiveDate, 1),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: false,
    });
    await importFromProvider();
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.corosSyncState).toBe("calendar_only");
    expect(after.effectiveDate).toBe(addDays(w.effectiveDate, 1));
  });
});

describe("move → COROS write job → verification", () => {
  it("runs the full happy path with a verified direct update", async () => {
    await importFromProvider();
    const threshold = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const toDate = addDays(threshold.effectiveDate, 1);

    const outcome = await applyMove(db, {
      userId,
      workoutId: threshold.id,
      toDate,
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(outcome.jobId).toBeTruthy();
    expect(["syncing", "waiting_for_device"]).toContain(outcome.corosSyncState);

    // Effective date moved immediately; lastVerified stays until verification.
    let w = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, threshold.id)))[0]!;
    expect(w.effectiveDate).toBe(toDate);
    expect(w.lastVerifiedCorosDate).toBe(threshold.effectiveDate);

    // Bridge claims the job and executes against the (fixture) COROS API.
    const job = await claimNextJob(db, userId, deviceId);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(outcome.jobId);

    const writeResult = await provider.updateScheduledWorkout({
      sourcePlanId: job!.workout!.planId,
      sourceWorkoutId: job!.workout!.sourceWorkoutId,
      sourceIdInPlan: job!.workout!.sourceIdInPlan ?? undefined,
      fromDate: job!.originalDate,
      toDate: job!.destinationDate,
      operationId: job!.id,
    });
    expect(writeResult.outcome).toBe("verified");

    const applied = await applyJobResult(
      db,
      userId,
      {
        jobId: job!.id,
        deviceId,
        outcome: "verified",
        pathUsed: "direct_update",
        observedDate: writeResult.observedDate,
        finishedAt: new Date().toISOString(),
        signature: "test",
      },
      prefs,
    );
    expect(applied.jobStatus).toBe("verified");

    w = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, threshold.id)))[0]!;
    expect(w.corosSyncState).toBe("synced");
    expect(w.lastVerifiedCorosDate).toBe(toDate);
  });

  it("is idempotent: a duplicate write reports already_in_desired_state", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const toDate = addDays(w.effectiveDate, 1);
    await applyMove(db, { userId, workoutId: w.id, toDate, toTime: "07:00", source: "app", corosWritesEnabled: true });
    const job = (await claimNextJob(db, userId, deviceId))!;

    await provider.updateScheduledWorkout({
      sourcePlanId: job.workout!.planId,
      sourceWorkoutId: job.workout!.sourceWorkoutId,
      sourceIdInPlan: job.workout!.sourceIdInPlan ?? undefined,
      fromDate: job.originalDate,
      toDate: job.destinationDate,
      operationId: job.id,
    });
    // Retry after ambiguous network failure: re-read reveals desired state.
    const retry = await provider.updateScheduledWorkout({
      sourcePlanId: job.workout!.planId,
      sourceWorkoutId: job.workout!.sourceWorkoutId,
      sourceIdInPlan: job.workout!.sourceIdInPlan ?? undefined,
      fromDate: job.originalDate,
      toDate: job.destinationDate,
      operationId: job.id,
    });
    expect(retry.outcome).toBe("already_in_desired_state");
    expect(provider.writeCount).toBe(1);
  });

  it("supersedes an older queued job when the user moves again", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const first = await applyMove(db, { userId, workoutId: w.id, toDate: addDays(w.effectiveDate, 1), toTime: "07:00", source: "app", corosWritesEnabled: true });
    const second = await applyMove(db, { userId, workoutId: w.id, toDate: addDays(w.effectiveDate, 2), toTime: "07:00", source: "app", corosWritesEnabled: true });
    const firstJob = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, first.jobId!)))[0]!;
    expect(firstJob.status).toBe("superseded");
    const claimed = await claimNextJob(db, userId, deviceId);
    expect(claimed!.id).toBe(second.jobId);
  });

  it("degrades to sync_issue after repeated write failures", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const move = await applyMove(db, { userId, workoutId: w.id, toDate: addDays(w.effectiveDate, 1), toTime: "07:00", source: "app", corosWritesEnabled: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      const job = await claimNextJob(db, userId, deviceId);
      expect(job).not.toBeNull();
      await applyJobResult(
        db,
        userId,
        { jobId: job!.id, deviceId, outcome: "write_failed", errorCategory: "network", finishedAt: new Date().toISOString(), signature: "t" },
        prefs,
      );
    }
    const job = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, move.jobId!)))[0]!;
    expect(job.status).toBe("failed");
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.corosSyncState).toBe("sync_issue");
    // The Run Garden placement is kept.
    expect(after.effectiveDate).toBe(addDays(w.effectiveDate, 1));
  });

  it("flags conflicts when upstream changed while a move was pending (rule 6)", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    await applyMove(db, { userId, workoutId: w.id, toDate: addDays(w.effectiveDate, 1), toTime: "07:00", source: "app", corosWritesEnabled: true });

    // Upstream, someone moved it somewhere else entirely.
    await provider.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate: addDays(w.effectiveDate, 3),
      operationId: "external",
    });
    await importFromProvider();

    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.corosSyncState).toBe("needs_attention");
    // Both dates preserved for the user to decide.
    expect(after.effectiveDate).toBe(addDays(w.effectiveDate, 1));
    expect(after.lastVerifiedCorosDate).toBe(addDays(w.effectiveDate, 3));
  });

  it("accepts upstream moves cleanly when nothing is pending (rule 5)", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    await provider.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate: addDays(w.effectiveDate, 2),
      operationId: "external",
    });
    const stats = await importFromProvider();
    expect(stats.updatedDates).toBe(1);
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.effectiveDate).toBe(addDays(w.effectiveDate, 2));
    expect(after.lastVerifiedCorosDate).toBe(addDays(w.effectiveDate, 2));
    expect(after.corosSyncState).toBe("synced");
  });

  it("an upstream reschedule resets an unresolved workout to scheduled (rule 5)", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    // Its date passed unanswered → the app was about to ask "did this happen?".
    await db
      .update(plannedWorkouts)
      .set({ completionState: "unresolved" })
      .where(eq(plannedWorkouts.id, w.id));
    // COROS then reschedules it (e.g. the plan shifted) to a future date.
    await provider.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: w.sourceWorkoutId,
      sourceIdInPlan: w.sourceIdInPlan ?? undefined,
      fromDate: w.effectiveDate,
      toDate: addDays(w.effectiveDate, 9),
      operationId: "external",
    });
    await importFromProvider();
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    // The question no longer applies to a date that hasn't happened yet.
    expect(after.completionState).toBe("scheduled");
    expect(after.effectiveDate).toBe(addDays(w.effectiveDate, 9));
  });

  it("moving an unresolved workout resets it to scheduled", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    await db
      .update(plannedWorkouts)
      .set({ completionState: "unresolved" })
      .where(eq(plannedWorkouts.id, w.id));
    await applyMove(db, {
      userId,
      workoutId: w.id,
      toDate: addDays(w.effectiveDate, 4),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: false,
    });
    const after = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(after.completionState).toBe("scheduled");
  });
});

describe("completion: Strava webhook first, COROS merge second", () => {
  it("provisionally completes from Strava, then upgrades on COROS arrival", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const startIso = `${w.effectiveDate}T14:02:05Z`;

    // 1. Strava webhook delivers the fast copy.
    const strava = normalizeStravaActivity(fixtureStravaCompletedThreshold(startIso));
    const s1 = await ingestActivities(db, { userId, sources: [strava] });
    expect(s1.provisionalCompletions).toBe(1);

    let updated = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(updated.completionState).toBe("provisionally_completed");

    // 2. The richer COROS record arrives and merges (no duplicate).
    const { item, detail } = fixtureCorosCompletedThreshold(startIso);
    const coros = normalizeCorosActivity(item, detail);
    const s2 = await ingestActivities(db, { userId, sources: [coros] });
    expect(s2.mergedPairs).toBe(1);
    expect(s2.newActivities).toBe(0);

    const acts = await db.select().from(activities).where(eq(activities.userId, userId));
    expect(acts).toHaveLength(1); // one physical run, one record
    expect(acts[0]!.corosActivityId).toBeTruthy();
    expect(acts[0]!.stravaActivityId).toBeTruthy();
    expect(acts[0]!.trainingLoad).toBe(82); // COROS authoritative
    expect(acts[0]!.title).toBe("Morning Threshold"); // Strava enrichment

    updated = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(updated.completionState).toBe("completed");

    const matches = await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, w.id), isNull(workoutCompletionMatches.undoneAt)));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.provisional).toBe(false);
  });

  it("self-heals legacy year-7625 COROS rows: rescale, merge, promote", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const startIso = `${w.effectiveDate}T14:02:05Z`;

    // 1. Strava fast copy → provisional completion.
    const strava = normalizeStravaActivity(fixtureStravaCompletedThreshold(startIso));
    await ingestActivities(db, { userId, sources: [strava] });

    // 2. A COROS copy as the pre-fix normalizer stored it: epoch ×100 (year
    //    ~7625), so the ±1h merge window can never find the Strava row.
    const { item, detail } = fixtureCorosCompletedThreshold(startIso);
    const coros = normalizeCorosActivity(item, detail);
    const startUnix = Math.floor(Date.parse(startIso) / 1000);
    const offsetMin = -28 * 15; // PDT, in the fixture
    const bogus = {
      ...coros,
      startTime: new Date(startUnix * 100 * 1000).toISOString().replace(".000Z", "Z"),
      startTimeLocal: new Date((startUnix * 100 + offsetMin * 60) * 1000)
        .toISOString()
        .replace(".000Z", "")
        .replace("Z", ""),
    };
    const s2 = await ingestActivities(db, { userId, sources: [bogus] });
    expect(s2.newActivities).toBe(1); // duplicate row — merge impossible
    expect((await db.select().from(activities).where(eq(activities.userId, userId))).length).toBe(2);
    let updated = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(updated.completionState).toBe("provisionally_completed"); // stuck

    // 3. Any later sync self-heals: timestamps rescaled, rows merged, match
    //    promoted — without any new sources arriving.
    await ingestActivities(db, { userId, sources: [] });
    const acts = await db.select().from(activities).where(eq(activities.userId, userId));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.corosActivityId).toBeTruthy();
    expect(acts[0]!.stravaActivityId).toBeTruthy();
    expect(acts[0]!.startTime).toBe(startIso);
    expect(acts[0]!.startTimeLocal?.slice(0, 10)).toBe(w.effectiveDate);
    expect(acts[0]!.trainingLoad).toBe(82); // COROS metrics carried over

    updated = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(updated.completionState).toBe("completed");
    const matches = await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, w.id), isNull(workoutCompletionMatches.undoneAt)));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.provisional).toBe(false);
  });

  it("re-delivered webhooks are idempotent", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const strava = normalizeStravaActivity(fixtureStravaCompletedThreshold(`${w.effectiveDate}T14:02:05Z`));
    await ingestActivities(db, { userId, sources: [strava] });
    await ingestActivities(db, { userId, sources: [strava] });
    const acts = await db.select().from(activities).where(eq(activities.userId, userId));
    expect(acts).toHaveLength(1);
  });
});

describe("garden integration", () => {
  it("waters the garden when a completed run's day is simulated", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    const startIso = `${w.effectiveDate}T14:02:05Z`;
    const { item, detail } = fixtureCorosCompletedThreshold(startIso);
    await ingestActivities(db, {
      userId,
      sources: [normalizeCorosActivity(item, detail)],
    });

    // Simulate past the workout day.
    const after = new Date(`${addDays(w.effectiveDate, 3)}T12:00:00Z`);
    const result = await advanceGarden(db, userId, prefs, after);
    expect(result.simulatedDays).toBeGreaterThan(0);

    const garden = await loadGarden(db, userId);
    expect(garden).not.toBeNull();
    // The quality run planted something new beyond the starter meadow.
    const planted = garden!.plants.filter((p) => p.sourceWorkoutId === w.id);
    expect(planted.length).toBeGreaterThanOrEqual(1);
    const events = await db.select().from(schema.gardenEvents).where(eq(schema.gardenEvents.userId, userId));
    expect(events.some((e) => e.kind === "run_completed" && e.workoutId === w.id)).toBe(true);
  });

  it("previews today's rain immediately after a run, without persisting", async () => {
    await importFromProvider();
    const today = todayInZone(prefs.timezone);
    // Put the threshold workout on TODAY and complete it (rain follows planned
    // runs; unplanned ones only water lightly).
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    await db
      .update(plannedWorkouts)
      .set({ effectiveDate: today })
      .where(eq(plannedWorkouts.id, w.id));
    const strava = normalizeStravaActivity(
      fixtureStravaCompletedThreshold(`${today}T13:00:00Z`, 14_200_000_777),
    );
    const stats = await ingestActivities(db, { userId, sources: [strava] });
    expect(stats.provisionalCompletions).toBe(1);

    const view = await buildGardenView(db, userId, prefs);
    // Feedback is same-day: the returned garden is already rained on…
    expect(["fresh_rain", "recovery_rain"]).toContain(view.snapshot.state.weatherState);
    expect(view.previewEvents.some((e) => e.kind === "run_completed")).toBe(true);
    // …but durable history is untouched (today persists tomorrow).
    const persisted = await loadGarden(db, userId);
    expect(persisted!.state.lastSimulatedDate < today).toBe(true);
  });

  it("collection is never empty: genesis species seed the unlocks table, codex + nudges ship", async () => {
    const view = await buildGardenView(db, userId, prefs);
    // Starter meadow species count from day one (the "0 species" bug).
    expect(view.species.length).toBeGreaterThanOrEqual(2); // clover + meadow grass
    const rows = await db
      .select()
      .from(schema.gardenUnlocks)
      .where(eq(schema.gardenUnlocks.userId, userId));
    expect(rows.length).toBe(view.species.length);
    // The codex covers the full catalog with hints on locked entries…
    expect(view.codex.length).toBeGreaterThan(20);
    const locked = view.codex.filter((c) => !c.unlocked);
    expect(locked.length).toBeGreaterThan(0);
    for (const c of locked) expect(c.hint.length).toBeGreaterThan(0);
    // …and the nudges point at reachable locked species.
    expect(view.nextUnlocks.length).toBe(3);
    expect(view.wildlife.length).toBeGreaterThanOrEqual(9);
  });

  it("does not punish unresolved workouts before the grace period", async () => {
    await importFromProvider();
    const w = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5"))
    )[0]!;
    // The day after the workout: still inside sync grace — day not simulated.
    const dayAfter = new Date(`${addDays(w.effectiveDate, 1)}T12:00:00Z`);
    await reconcileCompletionStates(db, userId, prefs, dayAfter);
    const state = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(state.completionState).toBe("scheduled");

    // Two days later without a match → unresolved (asks the user), not missed.
    const later = new Date(`${addDays(w.effectiveDate, 2)}T12:00:00Z`);
    await reconcileCompletionStates(db, userId, prefs, later);
    const state2 = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, w.id)))[0]!;
    expect(state2.completionState).toBe("unresolved");
  });
});

describe("tri-discipline ingestion", () => {
  async function insertActivity(sport: string, date: string) {
    const now = nowInstant();
    await db.insert(activities).values({
      id: newId(),
      userId,
      startTime: `${date}T15:00:00Z`,
      startTimeLocal: `${date}T08:00:00`,
      sport,
      durationSeconds: 1800,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("admits unplanned strength and yoga activities, tagged by discipline, excluding other sports", async () => {
    const today = todayInZone(prefs.timezone);
    await insertActivity("strength", today);
    await insertActivity("yoga", today);
    await insertActivity("bike", today);

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.completedRuns).toHaveLength(2);
    expect(input.completedRuns.every((r) => r.unplanned)).toBe(true);
    const disciplines = input.completedRuns.map((r) => r.discipline).sort();
    expect(disciplines).toEqual(["strength", "yoga"]);
  });

  it("tags discipline strength for a matched strength workout completion", async () => {
    const today = todayInZone(prefs.timezone);
    const now = nowInstant();
    await db.insert(plannedWorkouts).values({
      id: newId(),
      userId,
      planId: "test-plan",
      sourceWorkoutId: "src-strength-1",
      title: "Full Body Strength",
      category: "strength",
      sport: "strength",
      originalPlanDate: today,
      lastVerifiedCorosDate: today,
      effectiveDate: today,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 2700,
      calendarSyncState: "not_created",
      corosSyncState: "synced",
      completionState: "completed",
      createdAt: now,
      updatedAt: now,
    });

    const input = await buildDayInput(db, userId, today, prefs);
    expect(input.completedRuns).toHaveLength(1);
    expect(input.completedRuns[0]!.discipline).toBe("strength");
  });

  it("garden view reports balance, and a lift-only day still previews today", async () => {
    const today = todayInZone(prefs.timezone);
    await insertActivity("strength", today);

    const view = await buildGardenView(db, userId, prefs);
    expect(typeof view.balance.overall).toBe("number");
    expect(view.balance.overall).toBeGreaterThanOrEqual(0);
    expect(view.balance.overall).toBeLessThanOrEqual(1);
    // Consistent with run days: any completed session today previews same-day
    // feedback (including daily decay) without persisting it.
    expect(view.previewEvents.some((e) => e.kind === "run_completed")).toBe(true);
    const persisted = await loadGarden(db, userId);
    expect(persisted!.state.lastSimulatedDate < today).toBe(true);
  });
});
