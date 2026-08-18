/**
 * A CAPABILITY THAT SHIPPED AFTER THE SESSIONS THAT NEEDED IT.
 *
 * `watchPushable` admitted runs only until 2026-08-17 15:39 PDT. The athlete's
 * lift and mobility sessions were approved at 01:19 PDT the same morning, took
 * the `false` branch, queued nothing, and were never reconsidered — nine
 * sessions sitting in the app reading "Not synced to COROS" with no job, no
 * error, and no way to ask again. "My exercises for today also do not show up
 * in coros."
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, todayInZone, type CoachSession } from "@rg/domain";
import {
  countAbsentPushable,
  pushAbsentSessions,
  restoreAuthoredSessions,
} from "../src/services/push-absent.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, corosWriteJobs, trainingPlans } = schema;

const SQUAT = "425898928110747648";

const lift = (originIds: Array<string | undefined>): CoachSession => ({
  title: "Ski legs — bout one",
  category: "strength",
  durationMinutes: 30,
  lift: {
    exercises: originIds.map((originId, i) => ({
      name: `Movement ${i}`,
      sets: 3,
      reps: 8,
      restSeconds: 60,
      weight: { type: "bodyweight" as const },
      ...(originId ? { originId } : {}),
    })),
  },
});

async function seed(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  userId: string,
  session: CoachSession,
  date: string,
  over: Partial<typeof plannedWorkouts.$inferInsert> = {},
): Promise<string> {
  const planId = newId();
  const now = nowInstant();
  await db.insert(trainingPlans).values({
    id: planId,
    userId,
    provider: "coach",
    sourcePlanId: planId,
    name: "lift",
    createdAt: now,
    updatedAt: now,
  });
  const id = `cw-${newId()}-0-0`;
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId,
    // An app-authored row: its own id, never a `${corosPlanId}:${idInPlan}`
    // address, which is precisely what makes it absent from the watch.
    sourceWorkoutId: id,
    title: session.title,
    sport: "strength",
    category: "strength",
    effectiveDate: date,
    effectiveTime: "07:00",
    calendarBlockDurationSeconds: 1800,
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    sourceContentFingerprint: "seed",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    structuredJson: { exercises: session.lift!.exercises as unknown[] },
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  return id;
}

describe("pushing sessions that never reached the watch", () => {
  it("queues a create for a pushable lift the app never sent", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const date = todayInZone(prefs.timezone);
    const id = await seed(db, userId, lift([SQUAT, SQUAT]), date);

    const census = await countAbsentPushable(db, userId);
    expect(census.pushes).toBe(1);
    expect(census.unpushable).toBe(0);

    // The dry run queues nothing — the contract every repair beside this shares.
    await pushAbsentSessions(db, userId, { dryRun: true });
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).toHaveLength(0);

    const report = await pushAbsentSessions(db, userId, { dryRun: false });
    expect(report.totals.pushes).toBe(1);
    expect(report.backup?.kind).toBe("absent_sessions_pushed");
    const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
    expect(job!.kind).toBe("coach_create_workout");
    expect(job!.status).toBe("queued");
  });

  it("is idempotent — a second run does not queue a duplicate create", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const id = await seed(db, userId, lift([SQUAT]), todayInZone(prefs.timezone));
    await pushAbsentSessions(db, userId, { dryRun: false });
    await pushAbsentSessions(db, userId, { dryRun: false });
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).toHaveLength(1);
  });

  it("an operator re-run RETRIES a create that failed, and clears its attempt count", async () => {
    // Live (2026-08-18): two mobility sessions burned all three attempts on a
    // Cloudflare subrequest ceiling and went terminal. Re-running the backfill
    // reported them queued while `onConflictDoNothing` dropped the write — the
    // same silent no-op the content lane had.
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const id = await seed(db, userId, lift([SQUAT]), todayInZone(prefs.timezone));
    await pushAbsentSessions(db, userId, { dryRun: false });
    await db
      .update(corosWriteJobs)
      .set({
        status: "failed",
        lastErrorCategory: "error",
        payload: { attempts: 3 },
        completedAt: nowInstant(),
      })
      .where(eq(corosWriteJobs.workoutId, id));

    await pushAbsentSessions(db, userId, { dryRun: false });
    const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
    expect(job!.status).toBe("queued");
    expect(job!.lastErrorCategory).toBeNull();
    // The counter lives in the payload; leaving it at 3 would fail the job again
    // on its first tick and make the re-run look like it did nothing.
    expect((job!.payload as { attempts?: number }).attempts).toBeUndefined();
  });

  it("calls an off-catalog session unpushable and SAYS what the athlete can do", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await seed(db, userId, lift([SQUAT, undefined]), todayInZone(prefs.timezone));
    const report = await pushAbsentSessions(db, userId, { dryRun: false });
    expect(report.totals.pushes).toBe(0);
    expect(report.rows[0]!.action).toBe("unpushable");
    // Actionable, not a code: COROS cannot be sent a movement it has no id for.
    expect(report.rows[0]!.reason).toMatch(/exercise library/);
  });

  it("leaves a COMPLETED session alone — its watch copy would be a plan for a run already done", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await seed(db, userId, lift([SQUAT]), todayInZone(prefs.timezone), {
      completionState: "completed",
    });
    expect((await countAbsentPushable(db, userId)).candidates).toBe(0);
  });

  it("leaves YESTERDAY alone — a backfill must not put history on the watch", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await seed(db, userId, lift([SQUAT]), yesterday.toISOString().slice(0, 10));
    expect((await countAbsentPushable(db, userId)).candidates).toBe(0);
  });

  it("queues nothing when the athlete has COROS writes switched off", async () => {
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: false });
    const id = await seed(db, userId, lift([SQUAT]), todayInZone(prefs.timezone));
    const report = await pushAbsentSessions(db, userId, { dryRun: false });
    expect(report.totals.pushes).toBe(0);
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).toHaveLength(0);
  });
});

describe("restoring a session COROS's echo overwrote", () => {
  it("re-renders the card from the app's own copy, and leaves a correct row alone", async () => {
    // Live: pushing a lift to COROS and reading it back turned the card into
    // "3 × open Reverse Lunge / open Reverse Lunge" — reps gone, movements
    // duplicated — because the create stamped the fingerprint of what was SENT
    // and COROS re-encodes on save, so the next import saw drift and took the
    // wire's version. `structured_json` survived underneath, which is the only
    // reason this is repairable.
    const db = await makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const id = await seed(db, userId, lift([SQUAT, SQUAT]), todayInZone(prefs.timezone), {
      stageSummary: "3 × open Reverse Lunge / open Reverse Lunge",
    });

    const dry = await restoreAuthoredSessions(db, userId, { dryRun: true });
    expect(dry.totals.restored).toBe(0);
    expect(dry.rows).toHaveLength(1);
    expect(dry.rows[0]!.was).toBe("3 × open Reverse Lunge / open Reverse Lunge");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!.stageSummary)
      .toBe("3 × open Reverse Lunge / open Reverse Lunge");

    const live = await restoreAuthoredSessions(db, userId, { dryRun: false });
    expect(live.totals.restored).toBe(1);
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
    expect(row!.stageSummary).not.toContain("open Reverse Lunge / open Reverse Lunge");
    expect(row!.stageSummary).toContain("Movement 0");

    // Idempotent: a row already rendering correctly is not rewritten.
    const again = await restoreAuthoredSessions(db, userId, { dryRun: false });
    expect(again.totals.restored).toBe(0);
  });
});
