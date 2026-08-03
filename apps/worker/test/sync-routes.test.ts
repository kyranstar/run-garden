/**
 * Task 10: `/api/sync/*` routes — status, notes (list/dismiss/undo), and
 * read-now — plus the per-workout derived state plan.ts now attaches to its
 * DTOs. Route-level tests via `mountRoutes` (studio-routes.test.ts's own
 * pattern); the underlying services (`computeSyncStatus`, `sync-notes.ts`,
 * `sync-intents.ts`, `jobs.ts`) already have their own unit suites — these
 * tests exist to prove the HTTP wiring, not re-derive service behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { activeSyncNotes, postSyncNote } from "../src/services/sync-notes.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { corosWriteJobs, plannedWorkouts, studioPlanPushes, studioPlans, syncRuns, trainingPlans } = schema;

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
let cookie: string;

function client() {
  const app = mountRoutes(db, "/api/sync", syncRoutes);
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
    post: (path: string, body?: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        makeEnv(),
      ),
  };
}

async function insertWorkout(
  over: { effectiveDate?: string; effectiveTime?: string; category?: string } = {},
): Promise<string> {
  const workoutId = newId();
  const date = over.effectiveDate ?? "2026-08-08";
  await db.insert(plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId.slice(0, 4)}`,
    title: "Threshold 5x5",
    category: over.category ?? "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: over.effectiveTime ?? "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return workoutId;
}

const SQUAT = "425898928110747648";

/** A minimal, schema-valid studio plan + an `adopted` push row for it — the
 * shared fixture the `adopted_coros_edit`/`adopted_coros_removal` undo-
 * forwarding tests below build on. Mirrors studio-routes.test.ts's own
 * plan()/session()/seedAdoptedPushRow() fixtures at the minimum shape the
 * undo path needs. */
async function seedAdoptedPush(): Promise<{ planId: string; pushId: string }> {
  await db.insert(schema.corosExercises).values({
    id: SQUAT,
    name: "Back Squat",
    raw: {},
    updatedAt: nowInstant(),
  });

  const brief: PlanBrief = {
    goal: "strength",
    durationWeeks: 2,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate: "2026-09-07", // a Monday
  };
  const liftPlan: LiftingPlan = {
    name: "Autumn Strength",
    brief,
    weeks: [
      {
        sessions: [
          {
            title: "Full Body",
            weekday: 1,
            exercises: [
              {
                originId: SQUAT,
                name: "Back Squat",
                sets: 3,
                reps: 10,
                weight: { type: "bodyweight" },
                restSeconds: 60,
              },
            ],
          },
        ],
      },
      { sessions: [] },
    ],
  };
  const planId = newId();
  await db.insert(studioPlans).values({
    id: planId,
    userId,
    brief: brief as unknown as Record<string, unknown>,
    plan: liftPlan as unknown as Record<string, unknown>,
    version: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });

  const pushId = newId();
  await db.insert(studioPlanPushes).values({
    id: pushId,
    planId,
    planVersion: 1,
    happenDay: "2026-09-07",
    sessionTitle: "Full Body — wk 1",
    corosIdInPlan: "22",
    corosProgramId: "22",
    corosPlanId: "coros-plan",
    sessionFingerprint: "original-fingerprint",
    status: "adopted",
    error: null,
    updatedAt: nowInstant(),
  });
  return { planId, pushId };
}

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db);
  userId = user.userId;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

describe("GET /api/sync/status", () => {
  it("returns the SyncStatus shape", async () => {
    const res = await client().get("/api/sync/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      state: "not_synced",
      pendingCount: 0,
      issueCount: 0,
      lastCorosReadAt: null,
      paused: false,
      writesEnabled: false,
      registered: false,
    });
  });
});

describe("POST /api/sync/read-now", () => {
  it("enqueues a read_now job when nothing recent or in-flight exists", async () => {
    const res = await client().post("/api/sync/read-now");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: boolean; lastCorosReadAt: string | null };
    expect(body.enqueued).toBe(true);
    expect(body.lastCorosReadAt).toBeNull();

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    const readJobs = jobs.filter((j) => j.kind === "read_now");
    expect(readJobs).toHaveLength(1);
    expect(readJobs[0]!.status).toBe("queued");
  });

  it("dedupes: a second call while one is already queued does not insert another", async () => {
    await client().post("/api/sync/read-now");
    const res = await client().post("/api/sync/read-now");
    expect(((await res.json()) as { enqueued: boolean }).enqueued).toBe(false);

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs.filter((j) => j.kind === "read_now")).toHaveLength(1);
  });

  it("dedupes against a claimed read_now job too", async () => {
    await client().post("/api/sync/read-now");
    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    await db
      .update(corosWriteJobs)
      .set({ status: "claimed" })
      .where(eq(corosWriteJobs.id, jobs[0]!.id));

    const res = await client().post("/api/sync/read-now");
    expect(((await res.json()) as { enqueued: boolean }).enqueued).toBe(false);
    const after = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(after.filter((j) => j.kind === "read_now")).toHaveLength(1);
  });

  it("skips enqueue when the latest ok coros_read run finished under 5 minutes ago", async () => {
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    await db.insert(syncRuns).values({
      id: newId(),
      userId,
      kind: "coros_read",
      startedAt: finishedAt,
      finishedAt,
      status: "ok",
    });

    const res = await client().post("/api/sync/read-now");
    const body = (await res.json()) as { enqueued: boolean; lastCorosReadAt: string | null };
    expect(body.enqueued).toBe(false);
    expect(body.lastCorosReadAt).toBe(finishedAt);

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs.filter((j) => j.kind === "read_now")).toHaveLength(0);
  });

  it("enqueues when the latest ok coros_read run is 5+ minutes old", async () => {
    const finishedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    await db.insert(syncRuns).values({
      id: newId(),
      userId,
      kind: "coros_read",
      startedAt: finishedAt,
      finishedAt,
      status: "ok",
    });

    const res = await client().post("/api/sync/read-now");
    expect(((await res.json()) as { enqueued: boolean }).enqueued).toBe(true);
  });
});

describe("GET /api/sync/notes + dismiss", () => {
  it("lists active notes and dismisses one", async () => {
    const id = await postSyncNote(db, {
      userId,
      workoutId: "w1",
      kind: "adopted_coros_change",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });

    const listRes = await client().get("/api/sync/notes");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      notes: Array<{ id: string; kind: string; workoutId: string | null; payload: unknown }>;
    };
    expect(listBody.notes).toHaveLength(1);
    expect(listBody.notes[0]).toMatchObject({
      id,
      kind: "adopted_coros_change",
      workoutId: "w1",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });

    const dismissRes = await client().post(`/api/sync/notes/${id}/dismiss`);
    expect(dismissRes.status).toBe(200);
    expect(await dismissRes.json()).toEqual({ ok: true });

    const after = (await (await client().get("/api/sync/notes")).json()) as { notes: unknown[] };
    expect(after.notes).toHaveLength(0);
  });
});

describe("POST /api/sync/notes/:id/undo", () => {
  it("404s not_found for an unknown note id", async () => {
    const res = await client().post(`/api/sync/notes/${newId()}/undo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("kept_local_change: records a move intent to the displaced date and dismisses the note", async () => {
    const workoutId = await insertWorkout();
    // The open intent applyMove would have left behind, targeting keptDate.
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: workoutId,
      kind: "move",
      payload: { toDate: "2026-08-10" },
      source: "user_move",
    });
    const noteId = await postSyncNote(db, {
      userId,
      workoutId,
      kind: "kept_local_change",
      payload: { displacedDate: "2026-08-09", keptDate: "2026-08-10" },
    });

    const res = await client().post(`/api/sync/notes/${noteId}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const open = await openIntentFor(db, userId, workoutId, "move");
    expect(open?.payload?.["toDate"]).toBe("2026-08-09");
    expect(open?.source).toBe("undo");

    expect(await activeSyncNotes(db, userId)).toHaveLength(0);
  });

  it("adopted_coros_change: moves the workout back to previousDate and dismisses the note", async () => {
    const workoutId = await insertWorkout({ effectiveDate: "2026-08-09" });
    const noteId = await postSyncNote(db, {
      userId,
      workoutId,
      kind: "adopted_coros_change",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });

    const res = await client().post(`/api/sync/notes/${noteId}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const workout = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))
    )[0]!;
    expect(workout.effectiveDate).toBe("2026-08-08");

    expect(await activeSyncNotes(db, userId)).toHaveLength(0);
  });

  it("adopted_coros_removal: forwards to the studio undo, re-plans the row, and dismisses the note", async () => {
    const { planId, pushId } = await seedAdoptedPush();
    // MISSING case: no observation row at all for the source workout.
    const noteId = await postSyncNote(db, {
      userId,
      kind: "adopted_coros_removal",
      payload: { pushId, studioPlanId: planId, sessionTitle: "Full Body — wk 1", happenDay: "2026-09-07" },
    });

    const res = await client().post(`/api/sync/notes/${noteId}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = (
      await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId))
    )[0]!;
    expect(row.status).not.toBe("adopted");
    const jobs = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.studioPushId, pushId));
    expect(jobs.some((j) => j.kind === "create_scheduled_workout")).toBe(true);

    expect(await activeSyncNotes(db, userId)).toHaveLength(0);
  });

  it("adopted_coros_edit RENAMED: 409s undo_unsupported_rename and does NOT dismiss the note", async () => {
    const { pushId } = await seedAdoptedPush();
    // A rename: the source workout's last snapshot carries a different title.
    const trainingPlanId = newId();
    await db.insert(trainingPlans).values({
      id: trainingPlanId,
      userId,
      provider: "coros",
      sourcePlanId: "coros-plan",
      name: "My Plan",
      status: "active",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(plannedWorkouts).values({
      id: newId(),
      userId,
      planId: trainingPlanId,
      sourceWorkoutId: "coros-plan:22",
      title: "Renamed By User",
      category: "strength",
      sport: "strength",
      originalPlanDate: "2026-09-07",
      lastVerifiedCorosDate: "2026-09-07",
      effectiveDate: "2026-09-07",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const noteId = await postSyncNote(db, {
      userId,
      kind: "adopted_coros_edit",
      payload: { pushId, sessionTitle: "Full Body — wk 1", happenDay: "2026-09-07" },
    });

    const res = await client().post(`/api/sync/notes/${noteId}/undo`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "undo_unsupported_rename" });

    const notes = await activeSyncNotes(db, userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(noteId);

    const row = (
      await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId))
    )[0]!;
    expect(row.status).toBe("adopted");
  });
});
