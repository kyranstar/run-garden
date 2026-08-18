import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { FixtureTrainingProvider } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { applyMove, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser, connectTestCoros } from "./helpers.js";

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

const { plannedWorkouts, corosWriteJobs, syncNotes, syncIntents } = schema;

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
  await connectTestCoros(db, userId);
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

/**
 * `stage_summary` is DERIVED text: whatever `summarizeStages` made of the stage
 * rows at import time. So a row imported before the sub-minute fix keeps that
 * fix's absence forever — prod's strides session reads "4 × 0 min / 1 min
 * recovery" while the sheet's own stage list, rebuilt from the same rows, reads
 * "15s / 45s". Same reader, one tap apart, two prescriptions.
 */
describe("stage-summary wording heal", () => {
  /** The prod shape the fixture now carries: 15s on, 45s off, inside a 4× group. */
  const stridesRow = async () =>
    (
      await db
        .select()
        .from(plannedWorkouts)
        .where(eq(plannedWorkouts.title, "Easy Run with 15-Second Strides"))
    )[0]!;

  it("imports short intervals in seconds, so nothing is prescribed as '0 min'", async () => {
    await importFromProvider();
    const w = await stridesRow();
    expect(w.stageSummary).toBe("40 min · 1 min cooldown · 4 × 15s / 45s recovery");
    // Boundary-anchored: "40 min" contains "0 min", so the bare substring
    // check passes for the wrong reason (it did, twice, while writing this).
    expect(w.stageSummary).not.toMatch(/(^|[ ·/])0 min/);
  });

  it("re-derives a summary written by an older formatter, and nothing else", async () => {
    await importFromProvider();
    const before = await stridesRow();
    // Exactly what prod holds for `9ca6bb02`, in this fixture's label voice.
    await db
      .update(plannedWorkouts)
      .set({ stageSummary: "40 min · 1 min cooldown · 4 × 0 min / 1 min recovery" })
      .where(eq(plannedWorkouts.id, before.id));

    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(1);
    // NOT a content change: no plan version, no calendar churn, no date move.
    expect(stats.updatedContent).toBe(0);

    const after = await stridesRow();
    expect(after.stageSummary).toBe("40 min · 1 min cooldown · 4 × 15s / 45s recovery");
    expect(after.sourceContentFingerprint).toBe(before.sourceContentFingerprint);
    expect(after.effectiveDate).toBe(before.effectiveDate);
    expect(after.calendarSyncState).toBe(before.calendarSyncState);
    expect(after.corosSyncState).toBe(before.corosSyncState);
  });

  it("is idempotent — a second read writes nothing", async () => {
    await importFromProvider();
    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(0);
  });

  it("never overwrites a summary a coach edit owns", async () => {
    // audit#3 D1's exact failure mode: re-deriving content from COROS's
    // untouched snapshot silently un-does an approved ease. The wording heal
    // reads from that same snapshot, so it must stand down the same way.
    // An `ease` rewrites the fingerprint too (coach-apply.ts), so this row
    // takes rule 7's claim branch...
    await importFromProvider();
    const w = await stridesRow();
    await db
      .update(plannedWorkouts)
      .set({ stageSummary: "30 min easy", sourceContentFingerprint: "app-fnv-claim" })
      .where(eq(plannedWorkouts.id, w.id));
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: w.id,
      kind: "content",
      source: "coach_ease",
    });

    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(0);
    expect((await stridesRow()).stageSummary).toBe("30 min easy");
  });

  it("stands down for a row whose content intent has RESOLVED — the app still wrote it", async () => {
    // The live regression (2026-08-18). A content rewrite converged the session
    // onto the watch and, correctly, RESOLVED the intent — the disagreement
    // really was settled. The heal read that as "the app has no claim here",
    // re-derived from COROS's echo of our own session, and replaced the coach's
    // wording with COROS's while the stage rows behind the card were unchanged.
    // `resolvedAt` means "the wire matches the app now", never "the app did not
    // write this".
    await importFromProvider();
    const w = await stridesRow();
    await db
      .update(plannedWorkouts)
      .set({ stageSummary: "30 min easy" })
      .where(eq(plannedWorkouts.id, w.id));
    const intentId = await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: w.id,
      kind: "content",
      source: "coach_ease",
    });
    await db
      .update(syncIntents)
      .set({ resolvedAt: nowInstant() })
      .where(eq(syncIntents.id, intentId));

    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(0);
    expect((await stridesRow()).stageSummary).toBe("30 min easy");
  });

  it("stands down for a session the APP created and pushed, which has no content intent", async () => {
    // The live regression (2026-08-18) that survived the first fix. A coach
    // CREATED session carries no content intent at all, so the claimed-row guard
    // never applied: nine sessions pushed to COROS correctly and the next read
    // rewrote their cards from COROS's echo of our own workout — "Wall Sit 3×60s
    // · Reverse Lunge 3×8/side (4s down), 90s rest" became "3 × 1 min Wall Sit ·
    // 3 × open Reverse Lunge / open Reverse Lunge". Restoring them was not
    // enough; the next read undid eight of the nine.
    await importFromProvider();
    const w = await stridesRow();
    await db
      .update(plannedWorkouts)
      .set({ stageSummary: "the coach's own wording" })
      .where(eq(plannedWorkouts.id, w.id));
    // The mark of authorship: a write job this app enqueued for that session.
    await db.insert(corosWriteJobs).values({
      id: `${w.id}-push`,
      userId,
      workoutId: w.id,
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: w.effectiveDate,
      destinationDate: w.effectiveDate,
      status: "verified",
      requestedAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(0);
    expect((await stridesRow()).stageSummary).toBe("the coach's own wording");
  });

  it("stands down for a claimed row even when the fingerprints agree", async () => {
    // ...and the heal must ALSO refuse when they don't diverge, or it becomes
    // a second, quieter way for the snapshot to reclaim content the athlete
    // approved. Today only the branch above can happen; this pins the guard so
    // a future fingerprint change can't open the hole.
    await importFromProvider();
    const w = await stridesRow();
    await db
      .update(plannedWorkouts)
      .set({ stageSummary: "30 min easy" }) // fingerprint deliberately untouched
      .where(eq(plannedWorkouts.id, w.id));
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: w.id,
      kind: "content",
      source: "coach_ease",
    });

    const stats = await importFromProvider();
    expect(stats.rewordedSummaries).toBe(0);
    expect((await stridesRow()).stageSummary).toBe("30 min easy");
  });
});

describe("rule 8 provenance guard (audit#2 finding 1)", () => {
  it("coach-authored rows are NEVER archived by the absence sweep; COROS-verified absentees still are", async () => {
    await importFromProvider();
    // A coach-approved session: self-referential source id, never verified.
    const coachDate = addDays(baseMonday, 3);
    await db.insert(plannedWorkouts).values({
      id: "cw-audit-1",
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: "cw-audit-1",
      title: "Race-week shakeout",
      category: "easy",
      sport: "run",
      originalPlanDate: coachDate,
      lastVerifiedCorosDate: "",
      effectiveDate: coachDate,
      effectiveTime: "09:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1500,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // Two consecutive imports whose snapshots (naturally) never contain the
    // coach row — before the guard, the second one archived it.
    await importFromProvider();
    await importFromProvider();

    const [coachRow] = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, "cw-audit-1"));
    expect(coachRow!.archivedAt).toBeNull();
    expect(coachRow!.missingReads).toBe(0);
  });
});

describe("content claims against the snapshot (audit#3 D1/D2)", () => {
  it("an approved coach ease survives every subsequent snapshot", async () => {
    await importFromProvider();
    const imported = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.userId, userId));
    const eased = imported[0]!;
    const control = imported[1]!;
    const originalControlTitle = control.title;

    // Simulate the approved ease: local content + the permanent claim.
    await db
      .update(plannedWorkouts)
      .set({
        title: "Recovery 30 (eased)",
        category: "recovery",
        sourceContentFingerprint: "app-fnv-claim",
        corosSyncState: "calendar_only",
        updatedAt: nowInstant(),
      })
      .where(eq(plannedWorkouts.id, eased.id));
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: eased.id,
      kind: "content",
      source: "coach_ease",
    });
    // The control diverges identically but holds no claim — rule 7 restores it.
    await db
      .update(plannedWorkouts)
      .set({ title: "Drifted title", sourceContentFingerprint: "drift", updatedAt: nowInstant() })
      .where(eq(plannedWorkouts.id, control.id));

    await importFromProvider();

    const [keptRow] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, eased.id));
    expect(keptRow!.title).toBe("Recovery 30 (eased)");
    expect(keptRow!.category).toBe("recovery");
    const [restored] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, control.id));
    expect(restored!.title).toBe(originalControlTitle);
  });

  it("a content claim also blocks the recycled-slot rewrite on a sport flip", async () => {
    await importFromProvider();
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    await db
      .update(plannedWorkouts)
      .set({
        title: "Mobility (eased from run)",
        sport: "strength",
        category: "strength",
        sourceContentFingerprint: "app-fnv-claim",
        updatedAt: nowInstant(),
      })
      .where(eq(plannedWorkouts.id, row!.id));
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: row!.id,
      kind: "content",
      source: "coach_ease",
    });

    await importFromProvider();

    const [kept] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, row!.id));
    expect(kept!.sport).toBe("strength");
    expect(kept!.title).toBe("Mobility (eased from run)");
  });

  it("archiveReason user_removed blocks presence-healing even without a suppression row", async () => {
    await importFromProvider();
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: nowInstant(), archiveReason: "user_removed", updatedAt: nowInstant() })
      .where(eq(plannedWorkouts.id, row!.id));

    await importFromProvider();

    const [still] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, row!.id));
    expect(still!.archivedAt).not.toBeNull();
  });
});

describe("mirror twins resolved both ways (audit#3 D3)", () => {
  const seedTwin = async (id: string, date: string, completionState: string) => {
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: `mirror-plan-${id}`,
      // sourceWorkoutId === id exempts the row from absence-archiving so the
      // dedupe path is the only thing under test.
      sourceWorkoutId: id,
      title: "Easy Run with Strides",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState,
      resolutionDate: completionState === "scheduled" ? null : date,
      sourceContentFingerprint: `fp-${id}`,
      calendarBlockDurationSeconds: 1800,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
  };

  it("archives a skipped twin when the completed keeper holds the match", async () => {
    const date = addDays(baseMonday, -3);
    await seedTwin("twin-completed", date, "completed");
    await seedTwin("twin-skipped", date, "skipped");
    await db.insert(schema.workoutCompletionMatches).values({
      id: "m1",
      workoutId: "twin-completed",
      activityId: "act-1",
      confidence: 0.95,
      method: "scored_auto",
      matchedAt: nowInstant(),
    });

    await importFromProvider();

    const [skipped] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "twin-skipped"));
    expect(skipped!.archivedAt).not.toBeNull();
    expect(skipped!.archiveReason).toBe("duplicate_mirror");
    const [kept] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "twin-completed"));
    expect(kept!.archivedAt).toBeNull();
  });

  it("leaves both-resolved twins alone when the keeper holds no match", async () => {
    const date = addDays(baseMonday, -3);
    await seedTwin("nt-completed", date, "completed");
    await seedTwin("nt-skipped", date, "skipped");

    await importFromProvider();

    const [skipped] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "nt-skipped"));
    expect(skipped!.archivedAt).toBeNull();
  });

  it("never archives a second completed twin", async () => {
    const date = addDays(baseMonday, -3);
    await seedTwin("cc-a", date, "completed");
    await seedTwin("cc-b", date, "completed");
    await db.insert(schema.workoutCompletionMatches).values({
      id: "m2",
      workoutId: "cc-a",
      activityId: "act-2",
      confidence: 0.95,
      method: "scored_auto",
      matchedAt: nowInstant(),
    });

    await importFromProvider();

    const rows = await db
      .select()
      .from(plannedWorkouts)
      .where(inArray(plannedWorkouts.id, ["cc-a", "cc-b"]));
    expect(rows.every((r) => r.archivedAt === null)).toBe(true);
  });
});
