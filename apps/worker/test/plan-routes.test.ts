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
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import type { UserPreferences } from "@rg/domain";
import { planRoutes } from "../src/routes/plan.js";
import { applyJobResult, applyMove, emitPendingWork } from "../src/services/jobs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes, connectTestCoros } from "./helpers.js";

const { activities, corosWriteJobs, plannedWorkouts, scheduleOverrides, workoutCompletionMatches } = schema;

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
    postJson: (path: string, body: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        makeEnv(),
      ),
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
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
    await connectTestCoros(db, userId);
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

/**
 * REMOVE PARITY WITH THE COACH, ON THE WATCH TOO (audit 1, coach finding 3;
 * Ruling A1 option b). A session the APP pushed — a verified create stamp plus
 * a COROS address — comes off the watch when the athlete removes it, exactly as
 * it does when the coach removes it; an imported COROS session never does. The
 * DTO says which, so the dialog can tell the athlete before they confirm.
 */
describe("POST /api/plan/workouts/:id/remove — the watch", () => {
  async function insertAddressed(id: string, opts: { appPushed: boolean }): Promise<string> {
    const date = addDays(todayInZone(prefs.timezone), 3);
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `473846232060707016:${opts.appPushed ? 42 : 43}`,
      sourceIdInPlan: opts.appPushed ? "42" : "43",
      sourceProgramId: "9001",
      title: "Easy 30",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "0123456789abcdef",
      calendarBlockDurationSeconds: 1800,
      corosSyncState: "synced",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    if (opts.appPushed) {
      await db.insert(corosWriteJobs).values({
        id: `${id}-push`,
        userId,
        workoutId: id,
        kind: "coach_create_workout",
        expectedContentFingerprint: "fp",
        originalDate: date,
        destinationDate: date,
        payload: { workoutId: id, happenDay: date, name: `Easy 30 — ${date}` },
        requestedAt: nowInstant(),
        status: "verified",
        verifiedAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    }
    return date;
  }

  it("a session the app pushed comes off the watch: an unpush is queued, and the DTO said so", async () => {
    const date = await insertAddressed("pushed", { appPushed: true });
    const dto = (await (await client().get("/api/plan/workouts/pushed")).json()) as {
      workout: { appPushed?: boolean };
    };
    expect(dto.workout.appPushed).toBe(true);

    const res = await client().post("/api/plan/workouts/pushed/remove");
    expect(res.status).toBe(200);

    const [unpush] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, "pushed-unpush"));
    expect(unpush?.kind).toBe("coach_delete_workout");
    expect(unpush?.status).toBe("queued");
    expect(unpush?.payload).toMatchObject({
      workoutId: "pushed",
      happenDay: date,
      name: `Easy 30 — ${date}`,
      idInPlan: "42",
      programId: "9001",
      corosPlanId: "473846232060707016",
    });
  });

  it("an imported session stays on the watch: nothing is queued, and the DTO does not claim otherwise", async () => {
    await insertAddressed("imported", { appPushed: false });
    const dto = (await (await client().get("/api/plan/workouts/imported")).json()) as {
      workout: { appPushed?: boolean; hasWatchAddress?: boolean };
    };
    expect(dto.workout.appPushed).toBeUndefined();
    expect(dto.workout.hasWatchAddress).toBe(true);

    const res = await client().post("/api/plan/workouts/imported/remove");
    expect(res.status).toBe(200);
    const [w] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "imported"));
    expect(w!.archivedAt).not.toBeNull();
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, "imported"))).toEqual([]);
  });
});

async function insertActivity(): Promise<string> {
  const id = newId();
  await db.insert(activities).values({
    id,
    userId,
    startTime: "2026-08-08T14:00:00Z",
    startTimeLocal: "2026-08-08T07:00:00",
    sport: "run",
    durationSeconds: 3600,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

describe("POST /api/plan/workouts/:id/match", () => {
  it("refuses a second manual match on a workout that already holds one, leaving the second activity unmatched", async () => {
    const workoutId = await insertWorkout();
    const first = await insertActivity();
    const second = await insertActivity();

    const ok = await client().postJson(`/api/plan/workouts/${workoutId}/match`, { activityId: first });
    expect(ok.status).toBe(200);

    const res = await client().postJson(`/api/plan/workouts/${workoutId}/match`, { activityId: second });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "workout_already_matched" });

    const b = (await db.select().from(activities).where(eq(activities.id, second)))[0]!;
    expect(b.completionMatchId).toBeNull();
    const rows = await db
      .select()
      .from(workoutCompletionMatches)
      .where(eq(workoutCompletionMatches.workoutId, workoutId));
    expect(rows).toHaveLength(1);
  });
});

describe("POST /api/plan/workouts/:id/unmatch", () => {
  it("cannot undo another account's match (audit 1, ingest MINOR #10)", async () => {
    // The match lookup and the activity update were not scoped by user —
    // only the planned-workout update was — so anyone signed in who knew a
    // workout id could undo another account's completion.
    const { userId: other } = await makeTestUser(db);
    const workoutId = newId();
    await db.insert(plannedWorkouts).values({
      id: workoutId,
      userId: other,
      planId: "p",
      sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
      title: "Their run",
      category: "easy",
      sport: "run",
      originalPlanDate: "2026-08-08",
      lastVerifiedCorosDate: "2026-08-08",
      effectiveDate: "2026-08-08",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      completionState: "completed",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(activities).values({
      id: "their-act",
      userId: other,
      startTime: "2026-08-08T14:00:00Z",
      sport: "run",
      durationSeconds: 3600,
      completionMatchId: "their-match",
      sourceMergeConfidence: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(workoutCompletionMatches).values({
      id: "their-match",
      workoutId,
      activityId: "their-act",
      confidence: 1,
      method: "manual",
      matchedAt: nowInstant(),
    });

    const res = await client().post(`/api/plan/workouts/${workoutId}/unmatch`);

    expect(res.status).toBe(404);
    const [m] = await db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.id, "their-match"));
    expect(m!.undoneAt).toBeNull();
    const [a] = await db.select().from(activities).where(eq(activities.id, "their-act"));
    expect(a!.completionMatchId).toBe("their-match");
  });

  it("still undoes the athlete's own match", async () => {
    const workoutId = await insertWorkout();
    const activityId = await insertActivity();
    expect((await client().postJson(`/api/plan/workouts/${workoutId}/match`, { activityId })).status).toBe(200);

    const res = await client().post(`/api/plan/workouts/${workoutId}/unmatch`);

    expect(res.status).toBe(200);
    const [a] = await db.select().from(activities).where(eq(activities.id, activityId));
    expect(a!.completionMatchId).toBeNull();
    const [w] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(w!.completionState).toBe("unresolved");
  });
});

describe("POST /api/plan/workouts/:id/retry-coros", () => {
  it("supersedes the terminally failed job before re-arming: emitPendingWork enqueues nothing beforehand, a fresh queued job exists after", async () => {
    const deviceId = "test-executor";
    await connectTestCoros(db, userId);
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

/**
 * The garden dock reads its headline from here (readiness-first dock,
 * 2026-08-14): a computed verdict alongside the readiness fields that were
 * already sent, plus the coach's own weekly line under the SAME staleness
 * rule /week uses — never a second one.
 */
describe("GET /today — readiness verdict + coach line", () => {
  async function seedHealth(
    days: number,
    latest: { hrv?: number; restingHeartRate?: number; recoveryScore?: number } = {},
  ): Promise<void> {
    const today = todayInZone(prefs.timezone);
    for (let i = 0; i < days; i++) {
      const date = addDays(today, -i);
      await db.insert(schema.dailyHealth).values({
        id: `${userId}:${date}`,
        userId,
        date,
        // A flat history makes the median obvious: HRV 62, RHR 46.
        hrv: i === 0 ? (latest.hrv ?? 62) : 62,
        restingHeartRate: i === 0 ? (latest.restingHeartRate ?? 46) : 46,
        recoveryScore: i === 0 ? (latest.recoveryScore ?? null) : null,
        contentFingerprint: "fp",
        updatedAt: nowInstant(),
      });
    }
  }

  it("adds the verdict beside the fields it already sent — and names the evidence", async () => {
    await seedHealth(14, { hrv: 64, restingHeartRate: 47, recoveryScore: 100 });
    const body = (await (await client().get("/api/plan/today")).json()) as {
      readiness: {
        latest: unknown;
        baseline: { hrv: number; restingHeartRate: number } | null;
        sampleDays: number;
        verdict: { level: string; reasons: string[] } | null;
      };
    };
    // Existing fields are untouched — other surfaces read them.
    expect(body.readiness.latest).not.toBeNull();
    expect(body.readiness.baseline).toEqual({ hrv: 62, restingHeartRate: 46 });
    expect(body.readiness.sampleDays).toBe(14);
    expect(body.readiness.verdict).toEqual({
      level: "good",
      reasons: ["HRV 64 (base 62)", "RHR 47 (base 46)", "recovery 100%"],
    });
  });

  it("an elevated RHR reaches the dock as 'poor', and leads the evidence over a normal HRV", async () => {
    // RHR 54 against a 46 median (+8) is the poor signal; HRV 60 against 62
    // is inside the noise band and follows it as context.
    await seedHealth(14, { hrv: 60, restingHeartRate: 54 });
    const body = (await (await client().get("/api/plan/today")).json()) as {
      readiness: { verdict: { level: string; reasons: string[] } };
    };
    expect(body.readiness.verdict.level).toBe("poor");
    expect(body.readiness.verdict.reasons).toEqual([
      "RHR 8 bpm above your baseline",
      "HRV 60 (base 62)",
    ]);
  });

  it("withholds the verdict on thin data rather than guessing", async () => {
    await seedHealth(2);
    const body = (await (await client().get("/api/plan/today")).json()) as {
      readiness: { sampleDays: number; baseline: unknown; verdict: unknown };
    };
    expect(body.readiness.sampleDays).toBe(2);
    expect(body.readiness.baseline).toBeNull();
    expect(body.readiness.verdict).toBeNull();
  });

  it("no wellness data at all is a null verdict, not an error", async () => {
    const body = (await (await client().get("/api/plan/today")).json()) as {
      readiness: { latest: unknown; verdict: unknown };
    };
    expect(body.readiness.latest).toBeNull();
    expect(body.readiness.verdict).toBeNull();
  });

  it("surfaces the coach's own line while fresh, and drops it at the same 72h line /week uses", async () => {
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "briefing",
      refs: { focus: "Saturday's long run is the anchor." },
      at: nowInstant(),
    });
    const fresh = (await (await client().get("/api/plan/today")).json()) as {
      focus: { text: string; at: string } | null;
    };
    expect(fresh.focus?.text).toContain("Saturday");

    // A newer briefing that carries no focus retires the old line (the same
    // latest-only rule /week has), and an old one expires outright.
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "later briefing",
      refs: {},
      at: nowInstant(),
    });
    expect(
      ((await (await client().get("/api/plan/today")).json()) as { focus: unknown }).focus,
    ).toBeNull();
  });

  it("drops a focus older than the staleness window", async () => {
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "old briefing",
      refs: { focus: "Ancient advice." },
      at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    });
    expect(
      ((await (await client().get("/api/plan/today")).json()) as { focus: unknown }).focus,
    ).toBeNull();
  });
});

describe("GET /week — brief facts (2026-08-11 rework §4)", () => {
  const get = (path: string) => {
    const app = mountRoutes(db, "/api/plan", planRoutes);
    return app.request(path, { headers: { Cookie: cookie } }, makeEnv());
  };

  function mondayOf(offsetWeeks: number): string {
    const today = todayInZone(prefs.timezone);
    return addDays(startOfIsoWeek(today), offsetWeeks * 7);
  }

  async function seedWeekWorkout(date: string, opts: { state?: string; seconds?: number; category?: string; title?: string } = {}): Promise<string> {
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${id.slice(0, 6)}`,
      title: opts.title ?? "Session",
      category: (opts.category ?? "easy") as never,
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      sourceEstimatedDurationSeconds: opts.seconds ?? 3000,
      calendarBlockDurationSeconds: opts.seconds ?? 3000,
      completionState: opts.state ?? "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    return id;
  }

  it("assembles the week: days, totals, plan week index, focus", async () => {
    const monday = mondayOf(0);
    // Active coach plan whose W1 started 4 weeks ago → this is week 5 of 12.
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half Block",
      status: "active",
      startDate: mondayOf(-4),
      endDate: addDays(mondayOf(-4), 12 * 7 - 1),
      raceDate: null,
      stampPrefix: "FH",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await seedWeekWorkout(monday, { state: "completed", seconds: 2400 });
    await seedWeekWorkout(addDays(monday, 2), { seconds: 3600, category: "quality" });
    await seedWeekWorkout(addDays(monday, 5), { seconds: 5400, category: "long" });
    await seedWeekWorkout(addDays(monday, 6), { category: "rest" });
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "briefing",
      refs: { focus: "Saturday's long run anchors the week." },
      at: nowInstant(),
    });

    const res = await get("/api/plan/week");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.weekStart).toBe(monday);
    expect((body.days as unknown[]).length).toBe(7);
    expect(body.sessionCount).toBe(3); // rest excluded
    expect(body.doneCount).toBe(1);
    expect(body.plannedSeconds).toBe(2400 + 3600 + 5400);
    expect(body.weekIndex).toBe(5);
    expect(body.weekTotal).toBe(12);
    expect((body.focus as { text: string }).text).toContain("Saturday");
    expect(body.adventureDays).toBe(0);
  });

  it("counts the weeks of the BLOCK, not of a bucket of one-offs that overlaps it", async () => {
    // Production, 2026-08-17: approving one coach proposal minted a
    // single-day "Coach one-offs" plan row, and an unordered `.find()` let it
    // answer for the week — the brief read "Week 1 of 1" while a real
    // four-week block was running underneath it.
    const monday = mondayOf(0);
    await db.insert(schema.coachPlans).values([
      {
        id: "blk",
        userId,
        discipline: "run",
        name: "Post-10K block",
        status: "active",
        startDate: mondayOf(-2),
        endDate: addDays(mondayOf(-2), 4 * 7 - 1),
        raceDate: null,
        stampPrefix: "P10K",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      },
      {
        id: "adhoc-lift-deadbeef",
        userId,
        discipline: "lift",
        name: "Coach one-offs",
        status: "active",
        startDate: addDays(monday, 1),
        endDate: addDays(monday, 1),
        raceDate: null,
        stampPrefix: "Coach one-offs",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      },
    ]);
    const body = (await (await get("/api/plan/week")).json()) as Record<string, unknown>;
    expect(body.weekIndex).toBe(3);
    expect(body.weekTotal).toBe(4);
  });

  it("picks the longest covering block when two overlap, rather than whatever row came first", async () => {
    const monday = mondayOf(0);
    await db.insert(schema.coachPlans).values([
      {
        id: "short",
        userId,
        discipline: "lift",
        name: "Two-week top-up",
        status: "active",
        startDate: mondayOf(0),
        endDate: addDays(mondayOf(0), 2 * 7 - 1),
        raceDate: null,
        stampPrefix: "TU",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      },
      {
        id: "long",
        userId,
        discipline: "run",
        name: "Twelve-week build",
        status: "active",
        startDate: mondayOf(-4),
        endDate: addDays(mondayOf(-4), 12 * 7 - 1),
        raceDate: null,
        stampPrefix: "TW",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      },
    ]);
    const body = (await (await get("/api/plan/week")).json()) as Record<string, unknown>;
    expect(body.weekIndex).toBe(5);
    expect(body.weekTotal).toBe(12);
  });

  it("has no week counter at all when only a bucket of one-offs covers the week", async () => {
    const monday = mondayOf(0);
    await db.insert(schema.coachPlans).values({
      id: "adhoc-mobility-deadbeef",
      userId,
      discipline: "mobility",
      name: "Coach one-offs",
      status: "active",
      startDate: monday,
      endDate: monday,
      raceDate: null,
      stampPrefix: "Coach one-offs",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const body = (await (await get("/api/plan/week")).json()) as Record<string, unknown>;
    // "This week — …", not "Week 1 of 1 — …".
    expect(body.weekIndex).toBeNull();
    expect(body.weekTotal).toBeNull();
  });

  it("omits a stale focus and handles no-plan weeks", async () => {
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "old briefing",
      refs: { focus: "Ancient advice." },
      at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    });
    const res = await get("/api/plan/week");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.focus).toBeNull();
    expect(body.weekIndex).toBeNull();
    expect(body.weekTotal).toBeNull();
  });

  it("humanizes COROS code-titles at the DTO boundary, raw name in corosName", async () => {
    const monday = mondayOf(0);
    await seedWeekWorkout(monday, { title: "T1004", category: "easy" });
    const res = await get("/api/plan/week");
    const body = (await res.json()) as {
      days: Array<{ workouts: Array<{ title: string; corosName?: string }> }>;
    };
    const w = body.days.flatMap((d) => d.workouts)[0]!;
    expect(w.title).toBe("Easy run");
    expect(w.corosName).toBe("T1004");
  });

  it("validates the start param (must be a Monday)", async () => {
    expect((await get("/api/plan/week?start=2026-08-11")).status).toBe(400); // a Tuesday
    expect((await get("/api/plan/week?start=garbage")).status).toBe(400);
    const monday = mondayOf(-1);
    const res = await get(`/api/plan/week?start=${monday}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { weekStart: string }).weekStart).toBe(monday);
  });

  it("deriveHeadline covers the state table", async () => {
    const { deriveHeadline } = await import("../src/routes/plan.js");
    expect(deriveHeadline({ adherencePct: 90, loadRatio: 1.0, raceInDays: 3, deloadWeek: false })).toBe("race_week");
    expect(deriveHeadline({ adherencePct: 90, loadRatio: 1.0, raceInDays: null, deloadWeek: true })).toBe("resting");
    expect(deriveHeadline({ adherencePct: null, loadRatio: null, raceInDays: null, deloadWeek: false })).toBe("rebuilding");
    expect(deriveHeadline({ adherencePct: 97, loadRatio: 1.1, raceInDays: null, deloadWeek: false })).toBe("ahead");
    expect(deriveHeadline({ adherencePct: 85, loadRatio: 0.9, raceInDays: null, deloadWeek: false })).toBe("on_track");
    expect(deriveHeadline({ adherencePct: 70, loadRatio: 0.9, raceInDays: null, deloadWeek: false })).toBe("behind");
    expect(deriveHeadline({ adherencePct: 40, loadRatio: 0.9, raceInDays: null, deloadWeek: false })).toBe("rebuilding");
  });
});

describe("GET /today — todaySessions, origin and content state", () => {
  const today = () => todayInZone(prefs.timezone);

  async function slot(opts: { id: string; time: string; origin?: "program" | "on_demand"; state?: string; date?: string; archived?: boolean }) {
    const date = opts.date ?? today();
    await db.insert(plannedWorkouts).values({
      id: opts.id,
      userId,
      planId: "prog-1",
      sourceWorkoutId: opts.id,
      title: "Garden program",
      category: "yoga",
      sport: "yoga",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: opts.time,
      sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800,
      corosSyncState: "calendar_only",
      origin: opts.origin ?? "program",
      contentState: opts.state ?? "outline",
      archivedAt: opts.archived ? nowInstant() : null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
  }
  async function build(workoutId: string, version: number, date: string, mode: string, minutes: number, theme: string | null) {
    await db.insert(schema.sessionBuilds).values({
      id: `${workoutId}-b${version}`,
      userId,
      workoutId,
      version,
      engineVersion: "e",
      inputsHash: `h${version}`,
      payload: {
        build: { date, mode, minutes },
        view: { mode, minutes, theme: theme ? { id: theme.toLowerCase(), name: theme } : null },
      },
      lockedAt: null,
      createdAt: nowInstant(),
    });
  }
  type Today = {
    nextWorkout: { id: string } | null;
    todaySessions: Array<{
      workout: { id: string; origin: string | null; contentState: string | null; programId: string | null };
      build: { mode: string; theme: string | null; minutes: number } | null;
    }>;
  };

  it("lists a run and a built program slot by time, each with origin and content state, the slot with its build", async () => {
    const run = await insertWorkout({ effectiveDate: today() }); // 07:00
    await slot({ id: "slot-prog-1-a", time: "18:00", state: "built" });
    await build("slot-prog-1-a", 1, today(), "consistent", 35, "Hinge");
    const body = (await (await client().get("/api/plan/today")).json()) as Today;
    expect(body.todaySessions.map((s) => s.workout.id)).toEqual([run, "slot-prog-1-a"]);
    expect(body.todaySessions[0]!.build).toBeNull();
    expect(body.todaySessions[1]!.workout).toMatchObject({ origin: "program", contentState: "built", programId: "prog-1" });
    expect(body.todaySessions[1]!.build).toEqual({ mode: "consistent", theme: "Hinge", minutes: 35 });
    expect(body.nextWorkout?.id).toBe(run);
  });

  it("an outline slot has no build; an archived row and tomorrow's row are left out; the latest build wins", async () => {
    await slot({ id: "s-outline", time: "08:00" });
    await slot({ id: "s-gone", time: "09:00", archived: true });
    await slot({ id: "s-tomorrow", time: "10:00", date: addDays(today(), 1) });
    await slot({ id: "s-od", time: "11:00", origin: "on_demand", state: "built" });
    await build("s-od", 1, today(), "build", 20, null);
    await build("s-od", 2, today(), "recovery", 25, "Rest");
    const body = (await (await client().get("/api/plan/today")).json()) as Today;
    expect(body.todaySessions.map((s) => s.workout.id)).toEqual(["s-outline", "s-od"]);
    expect(body.todaySessions[0]!.build).toBeNull();
    expect(body.todaySessions[1]!.build).toEqual({ mode: "recovery", theme: "Rest", minutes: 25 });
  });

  it("an account with no program gets only its own rows, with no program id", async () => {
    const run = await insertWorkout({ effectiveDate: today() });
    const body = (await (await client().get("/api/plan/today")).json()) as Today;
    expect(body.todaySessions.map((s) => s.workout.id)).toEqual([run]);
    expect(body.todaySessions[0]!.workout.programId).toBeNull();
    expect(body.nextWorkout?.id).toBe(run);
  });
});

describe("moving an app session (ruling 2a-R7)", () => {
  async function appRow(id: string, state: string, origin: "program" | "on_demand" = "program") {
    const date = todayInZone(prefs.timezone);
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "prog-1",
      sourceWorkoutId: id,
      title: "Garden program",
      category: "yoga",
      sport: "yoga",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: "18:00",
      sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800,
      corosSyncState: "calendar_only",
      calendarSyncState: "synced",
      origin,
      contentState: state,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.sessionBuilds).values({
      id: `${id}-b1`, userId, workoutId: id, version: 1, engineVersion: "e", inputsHash: "h",
      payload: { build: { date }, view: {} }, lockedAt: null, createdAt: nowInstant(),
    });
  }
  const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
  const tomorrow = () => addDays(todayInZone(prefs.timezone), 1);

  it("a built slot moved to another day goes back to an outline, keeps its old build, and the calendar is told", async () => {
    await appRow("s1", "built");
    const res = await client().postJson("/api/plan/workouts/s1/move", { toDate: tomorrow(), toTime: "18:00" });
    expect(res.status).toBe(200);
    expect(await row("s1")).toMatchObject({ contentState: "outline", effectiveDate: tomorrow() });
    expect((await row("s1")).calendarSyncState).not.toBe("synced");
    expect(await db.select().from(schema.sessionBuilds).where(eq(schema.sessionBuilds.workoutId, "s1"))).toHaveLength(1);
  });

  it("an on-demand built slot reverts too", async () => {
    await appRow("s2", "built", "on_demand");
    await client().postJson("/api/plan/workouts/s2/move", { toDate: tomorrow(), toTime: "18:00" });
    expect((await row("s2")).contentState).toBe("outline");
  });

  it("a started slot keeps its state, and so does a built one that only changes time", async () => {
    await appRow("s3", "started");
    await client().postJson("/api/plan/workouts/s3/move", { toDate: tomorrow(), toTime: "18:00" });
    expect((await row("s3")).contentState).toBe("started");
    await appRow("s4", "built");
    await client().postJson("/api/plan/workouts/s4/move", { toDate: todayInZone(prefs.timezone), toTime: "19:00" });
    expect(await row("s4")).toMatchObject({ contentState: "built", effectiveTime: "19:00" });
  });
});
