/**
 * Route-level tests for `apps/worker/src/routes/plan.ts` handlers:
 *
 * - `POST /workouts/:id/remove` must resolve any open move intent for the
 *   workout being archived — otherwise it strands a permanent, uncloseable
 *   sync_issue behind a workout that no longer exists in the plan.
 * - `POST /workouts/:id/retry-coros` must supersede a terminally failed job
 *   before calling `applyMove`, clearing `emitPendingWork`'s
 *   attempts-exhausted guard (jobs.ts) so a user-initiated retry actually
 *   re-arms future emission.
 * - `POST /workouts/:id/unskip` (un-skip, 2026-08-03) must reverse
 *   `/workouts/:id/skip`: restore `scheduled`, clear `resolutionDate`, and
 *   record a `restore`-kind `schedule_overrides` row — and must refuse when
 *   the workout isn't currently `skipped`.
 *
 * Mounts `planRoutes` the same way sync-routes.test.ts mounts `syncRoutes`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import type { UserPreferences } from "@rg/domain";
import { planRoutes } from "../src/routes/plan.js";
import { applyJobResult, applyMove, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes, registerTestDevice } from "./helpers.js";

const { corosWriteJobs, plannedWorkouts, scheduleOverrides } = schema;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

function client() {
  const app = mountRoutes(db, "/api/plan", planRoutes);
  return {
    post: (path: string) =>
      app.request(path, { method: "POST", headers: { Cookie: cookie } }, makeEnv()),
  };
}

// Copied from jobs-reconcile.test.ts / sync-status.test.ts's shared literal.
async function insertWorkout(
  overrides: { effectiveDate?: string; lastVerifiedCorosDate?: string } = {},
): Promise<string> {
  const workoutId = newId();
  const date = overrides.effectiveDate ?? "2026-08-08";
  await db.insert(plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: overrides.lastVerifiedCorosDate ?? date,
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  prefs = user.prefs;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

describe("POST /api/plan/workouts/:id/remove", () => {
  it("resolves an open move intent for the workout being removed, instead of stranding it open behind an archived row", async () => {
    await registerTestDevice(db, userId);
    const workoutId = await insertWorkout({ lastVerifiedCorosDate: "2026-08-08" });
    await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(await openIntentFor(db, userId, workoutId, "move")).not.toBeNull();

    const res = await client().post(`/api/plan/workouts/${workoutId}/remove`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await openIntentFor(db, userId, workoutId, "move")).toBeNull();
    const workout = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.archivedAt).not.toBeNull();
  });
});

describe("POST /api/plan/workouts/:id/retry-coros", () => {
  it("supersedes the terminally failed job before re-arming: emitPendingWork enqueues nothing beforehand, a fresh queued job exists after", async () => {
    const deviceId = await registerTestDevice(db, userId);
    const workoutId = await insertWorkout({ lastVerifiedCorosDate: "2026-08-08" });
    const outcome = await applyMove(db, {
      userId,
      workoutId,
      toDate: "2026-08-10",
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    const jobId = outcome.jobId!;

    // Exhaust the retry budget (maxAttempts default 5) so the job lands
    // `failed` at destinationDate "2026-08-10" while the move intent stays
    // open — jobs-reconcile.test.ts's own pattern for driving a job failed.
    for (let attempt = 0; attempt < 5; attempt++) {
      await applyJobResult(
        db,
        userId,
        {
          jobId,
          deviceId,
          outcome: "write_failed",
          errorCategory: "network",
          finishedAt: nowInstant(),
          signature: "s",
        } as never,
        prefs,
      );
    }
    expect(
      (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0]!.status,
    ).toBe("failed");
    expect(await openIntentFor(db, userId, workoutId, "move")).not.toBeNull();

    // Before the user retries: emitPendingWork's attempts-exhausted guard
    // must refuse to re-emit — otherwise a bridge sync would retry an
    // unsupported workout forever with a fresh attempt budget.
    const emitted = await emitPendingWork(db, userId, { corosWritesEnabled: true });
    expect(emitted).toBe(0);
    const beforeRetry = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.workoutId, workoutId));
    expect(beforeRetry.filter((j) => j.status === "queued")).toHaveLength(0);

    const res = await client().post(`/api/plan/workouts/${workoutId}/retry-coros`);
    expect(res.status).toBe(200);

    const oldJob = (
      await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId))
    )[0]!;
    expect(oldJob.status).toBe("superseded");

    const afterRetry = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.workoutId, workoutId));
    const queued = afterRetry.filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.destinationDate).toBe("2026-08-10");
  });
});

describe("POST /api/plan/workouts/:id/unskip", () => {
  it("skip → unskip round-trip: restores scheduled, clears resolutionDate, and writes a restore override", async () => {
    const workoutId = await insertWorkout({ effectiveDate: "2026-08-01" });

    const skipRes = await client().post(`/api/plan/workouts/${workoutId}/skip`);
    expect(skipRes.status).toBe(200);
    const today = todayInZone(prefs.timezone);
    const skipped = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(skipped.completionState).toBe("skipped");
    expect(skipped.resolutionDate).toBe(today);

    const res = await client().post(`/api/plan/workouts/${workoutId}/unskip`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const restored = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(restored.completionState).toBe("scheduled");
    expect(restored.resolutionDate).toBeNull();

    const overrides = await db
      .select()
      .from(scheduleOverrides)
      .where(eq(scheduleOverrides.workoutId, workoutId));
    const restoreOverride = overrides.find((o) => o.kind === "restore");
    expect(restoreOverride).toBeDefined();
    expect(restoreOverride!.source).toBe("app");
    expect(restoreOverride!.fromDate).toBe(today);
  });

  it("4xxs when the workout isn't currently skipped", async () => {
    const workoutId = await insertWorkout();

    const res = await client().post(`/api/plan/workouts/${workoutId}/unskip`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const unchanged = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(unchanged.completionState).toBe("scheduled");
  });

  it("404s for a workout that doesn't exist", async () => {
    const res = await client().post(`/api/plan/workouts/${newId()}/unskip`);
    expect(res.status).toBe(404);
  });
});
