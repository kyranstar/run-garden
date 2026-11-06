/**
 * What is left of the old Plan Studio's API (plan-studio-design §7, fix rounds F1–F6), after the safety audit
 * (2026-11-06, S6): its generating and pushing routes — generate, edit, push, push/retry, the adoption undo — and the old
 * screens' reads are unmounted (404, nothing written); retire (the Plan modal's) and the operator's exercise-id repair
 * stay. The push and the adoption undo live on as services behind Settings → Sync (routes/sync.ts): their invariants are
 * held here at the service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { createScheduledWorkoutJobSchema, newId, nowInstant, todayInZone, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
import { pushStudioPlan, undoStudioAdoption } from "../src/services/studio-push.js";
import { coachRoutes } from "../src/routes/coach.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { corosExercises, corosWriteJobs, llmUsage, plannedWorkouts, studioPlanPushes, studioPlans, trainingPlans } =
  schema;

const SQUAT = "425898928110747648";
const BENCH = "426109589008859137";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  };
}

function session(over: Partial<{ title: string; weekday: number }> = {}) {
  return {
    title: over.title ?? "Full Body",
    weekday: over.weekday ?? 1,
    exercises: [
      {
        originId: SQUAT,
        name: "Back Squat",
        sets: 3,
        reps: 10,
        weight: { type: "bodyweight" as const },
        restSeconds: 60,
      },
    ],
  };
}

function plan(over: Partial<LiftingPlan> = {}): LiftingPlan {
  const startDate = over.brief?.startDate ?? "2026-09-07"; // a Monday
  // planBriefSchema requires durationWeeks >= 2, so the default is two weeks.
  const weeks = over.weeks ?? [{ sessions: [session()] }, { sessions: [session()] }];
  const brief: PlanBrief = {
    goal: "strength",
    durationWeeks: weeks.length,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 60,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate,
    ...(over.brief ?? {}),
  };
  return { name: "Autumn Strength", ...over, brief, weeks } as LiftingPlan;
}

function validBriefInput(startDate: string): Record<string, unknown> {
  return {
    goal: "strength",
    durationWeeks: 2,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate,
  };
}

let db: Db;
let userId: string;
let timezone: string;
let cookie: string;

async function seedCatalog(): Promise<void> {
  await db.insert(corosExercises).values([
    { id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() },
    { id: BENCH, name: "Bench Press", raw: {}, updatedAt: nowInstant() },
  ]);
}

async function seedPlan(over: Partial<LiftingPlan> = {}, version = 1): Promise<string> {
  const id = newId();
  const p = plan(over);
  await db.insert(studioPlans).values({
    id,
    userId,
    brief: p.brief as unknown as Record<string, unknown>,
    plan: p as unknown as Record<string, unknown>,
    version,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** A push row already `adopted` (spec §2, Task 7) — the fixture shape the
 * undo route (`/adoption/:pushId/undo`) case-detects against. */
async function seedAdoptedPushRow(
  planId: string,
  over: Partial<{
    happenDay: string;
    sessionTitle: string;
    corosIdInPlan: string;
    corosPlanId: string;
    corosHappenDay: string | null;
  }> = {},
): Promise<string> {
  const id = newId();
  await db.insert(studioPlanPushes).values({
    id,
    planId,
    planVersion: 1,
    happenDay: over.happenDay ?? "2026-09-07",
    sessionTitle: over.sessionTitle ?? "Full Body — wk 1",
    corosIdInPlan: over.corosIdInPlan ?? "21",
    corosProgramId: over.corosIdInPlan ?? "21",
    corosPlanId: over.corosPlanId ?? "coros-plan",
    corosHappenDay: over.corosHappenDay ?? null,
    sessionFingerprint: "original-fingerprint",
    status: "adopted",
    error: null,
    updatedAt: nowInstant(),
  });
  return id;
}

/** The `planned_workouts` observation an undo case-detects against — the
 * import snapshot row `detectDrift` (and the undo route) key by
 * `${corosPlanId}:${corosIdInPlan}` → `sourceWorkoutId`. */
async function seedObservation(over: {
  sourceWorkoutId: string;
  title?: string;
  lastVerifiedCorosDate?: string;
  archivedAt?: string | null;
  archiveReason?: string | null;
}): Promise<void> {
  const [sourcePlanId, sourceIdInPlan] = over.sourceWorkoutId.split(":");
  const trainingPlanId = newId();
  await db.insert(trainingPlans).values({
    id: trainingPlanId,
    userId,
    provider: "coros",
    sourcePlanId: sourcePlanId!,
    name: "My Plan",
    status: "active",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  const date = over.lastVerifiedCorosDate ?? "2026-09-07";
  await db.insert(plannedWorkouts).values({
    id: newId(),
    userId,
    planId: trainingPlanId,
    sourceWorkoutId: over.sourceWorkoutId,
    sourceIdInPlan,
    title: over.title ?? "Full Body — wk 1",
    category: "strength",
    sport: "strength",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    archivedAt: over.archivedAt ?? null,
    archiveReason: over.archiveReason ?? null,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

function client(env: Env = makeEnv()) {
  const app = mountRoutes(db, "/api/studio", studioRoutes);
  return {
    get: (path: string, headers: Record<string, string> = { Cookie: cookie }) =>
      app.request(path, { headers }, env),
    post: (path: string, body?: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        env,
      ),
    // F3 (fix round 1): sends `rawBody` verbatim (no JSON.stringify), so a
    // genuinely malformed-JSON test can exercise `parseJsonBody`'s own catch.
    postRaw: (path: string, rawBody: string, headers: Record<string, string> = { Cookie: cookie }) =>
      app.request(
        path,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: rawBody },
        env,
      ),
  };
}

// The fixtures hardcode plan weeks from 2026-09-07 on, and generate rejects a
// start date before today — pin "today" ahead of them, or the suite rots the
// day the real clock passes the fixtures. Only Date is faked; timers stay real.
const PINNED_NOW = new Date("2026-09-02T12:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  db = makeTestDb();
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  timezone = user.prefs.timezone;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

// ─────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects every route without a session cookie", async () => {
    const c = client();
    expect((await c.post("/api/studio/plans/sp1/retire", undefined, {})).status).toBe(401);
    expect((await c.post("/api/studio/plans/sp1/repair-exercise-ids", { dryRun: true, mapping: [] }, {})).status).toBe(401);
    // The unmounted ones too: the session check stands in front of every path.
    expect((await c.post("/api/studio/push", undefined, {})).status).toBe(401);
  });
});

// ── The old generator, unmounted (the safety audit, 2026-11-06, S6) ─────────
//
// Its routes outlived its screens: generate and edit still wrote an AI lifting plan, and push, push/retry and the
// adoption undo put it on the watch with COROS ids and no condition gate (principles §11, the decision of 2026-10-10).
// No client called them; each now answers 404, signed in or not past the session check, and writes nothing.

describe("the old generator's routes are gone (the safety audit, S6)", () => {
  it("generate, edit, push, push/retry, the adoption undo and the old screens' reads answer 404 — and write nothing", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const failed = newId();
    await db.insert(studioPlanPushes).values({ id: failed, planId, planVersion: 1, happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", status: "failed", error: "network", updatedAt: nowInstant() });
    const adopted = await seedAdoptedPushRow(planId, { corosIdInPlan: "23" });
    const c = client();
    for (const [method, path, body] of [
      ["GET", "/api/studio", undefined],
      ["GET", "/api/studio/history", undefined],
      ["POST", "/api/studio/generate", { brief: { goal: "strength", durationWeeks: 2, sessionsPerWeek: 1, preferredDays: [1], sessionMinutes: 45, equipment: "full gym", constraints: "", notes: "", startDate: "2026-09-07" } }],
      ["POST", "/api/studio/edit", { request: "add a day" }],
      ["POST", "/api/studio/push", undefined],
      ["POST", "/api/studio/push/retry", { happenDay: "2026-09-14" }],
      ["POST", `/api/studio/adoption/${adopted}/undo`, undefined],
    ] as const) {
      const res = method === "GET" ? await c.get(path) : await c.post(path, body);
      expect(res.status, path).toBe(404);
    }
    expect(await db.select().from(studioPlans)).toHaveLength(1);
    expect((await db.select().from(studioPlans))[0]!.version).toBe(1);
    expect(await db.select().from(corosWriteJobs)).toEqual([]);
    expect((await db.select().from(studioPlanPushes)).map((r) => [r.id, r.status]).sort()).toEqual([[adopted, "adopted"], [failed, "failed"]].sort());
    expect(await db.select().from(llmUsage)).toEqual([]);
  });
});

// An adopted session's undo lives on as Settings → Sync's (routes/sync.ts, the same service): its cases, there.
describe("undoStudioAdoption (the service Settings → Sync's undo calls)", () => {
  const today = () => todayInZone(timezone);

  it("MOVED: re-verifies the row and plans a delete at the observed day, chained to a recreate", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedAdoptedPushRow(planId, { corosHappenDay: "2026-09-10" });
    await seedObservation({ sourceWorkoutId: "coros-plan:21", title: "Full Body — wk 1", lastVerifiedCorosDate: "2026-09-10" });
    expect(await undoStudioAdoption(db, userId, pushId, today())).toMatchObject({ ok: true });
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("pending");
    const deleteJob = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).find((j) => j.kind === "delete_scheduled_workout");
    const payload = deleteJob!.payload as { happenDay: string; followUpCreate?: { happenDay: string; name: string } };
    expect(payload.happenDay).toBe("2026-09-10");
    expect(payload.followUpCreate).toMatchObject({ happenDay: "2026-09-07", name: "Full Body — wk 1" });
  });

  it("RENAMED is refused and the row stays adopted; another account's push is not found", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedAdoptedPushRow(planId, { corosIdInPlan: "23" });
    await seedObservation({ sourceWorkoutId: "coros-plan:23", title: "Renamed By User" });
    expect(await undoStudioAdoption(db, userId, pushId, today())).toMatchObject({ ok: false, error: "undo_unsupported_rename" });
    expect((await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!.status).toBe("adopted");
    const other = await makeTestUser(db, { corosWritesEnabled: true });
    expect(await undoStudioAdoption(db, other.userId, pushId, today())).toMatchObject({ ok: false, error: "not_found" });
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });
});

// ── Retiring the old generator's plan (Stage 2 Task 9, fix round 1) ──────────
//
// Its screens are retired; its plans must not be stuck. Retire takes everything ahead off the watch through the push
// path and keeps what is behind, nothing in the database deleted, and the plan leaves the list.

describe("POST /api/studio/plans/:id/retire", () => {
  /** A two-week plan pushed to COROS, the day between its weeks: week 1 (Sep 7) behind, week 2 (Sep 14) ahead. */
  async function pushedPlan(): Promise<{ planId: string; behind: string; ahead: string }> {
    vi.setSystemTime(new Date("2026-09-10T19:00:00Z"));
    await seedCatalog();
    const planId = await seedPlan();
    const row = async (happenDay: string, sessionTitle: string, idInPlan: string) => {
      const id = newId();
      await db.insert(studioPlanPushes).values({
        id,
        planId,
        planVersion: 1,
        happenDay,
        sessionTitle,
        corosIdInPlan: idInPlan,
        corosProgramId: idInPlan,
        corosPlanId: "coros-plan",
        sessionFingerprint: "fp",
        status: "verified",
        error: null,
        updatedAt: nowInstant(),
      });
      return id;
    };
    return { planId, behind: await row("2026-09-07", "Full Body — wk 1", "21"), ahead: await row("2026-09-14", "Full Body — wk 2", "22") };
  }

  const coachList = async () => {
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const res = await app.request("/api/coach/plans", { headers: { Cookie: cookie } }, makeEnv());
    return ((await res.json()) as { plans: Array<{ id: string; source?: string }> }).plans.filter((p) => p.source === "studio");
  };
  const jobs = () => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
  const statusOf = async (id: string) => (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, id)))[0]!.status;

  it("takes what is ahead off the watch through the push path, keeps what is behind, and the plan leaves the list", async () => {
    const { planId, behind, ahead } = await pushedPlan();
    expect((await coachList()).map((p) => p.id)).toEqual([planId]);

    const res = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, summary: { deletes: 1, creates: 0 } });

    // The push path's own removal: a guarded delete for the session ahead, nothing for the one behind.
    const queued = await jobs();
    expect(queued.map((j) => [j.kind, j.studioPushId])).toEqual([["delete_scheduled_workout", ahead]]);
    expect(await statusOf(behind)).toBe("verified");
    // Nothing deleted from the database: the plan and its rows are all still there.
    expect(await db.select().from(studioPlans).where(eq(studioPlans.id, planId))).toHaveLength(1);
    expect(await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, planId))).toHaveLength(2);
    expect(await coachList()).toEqual([]);

    // Retired once: a second Retire is refused plainly, and queues nothing more.
    const again = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_retired" });
    expect(await jobs()).toHaveLength(1);
  });

  it("a session already done today stays; one still to do today goes", async () => {
    const { planId, ahead } = await pushedPlan();
    vi.setSystemTime(new Date("2026-09-14T19:00:00Z"));
    await seedObservation({ sourceWorkoutId: "coros-plan:22", title: "Full Body — wk 2", lastVerifiedCorosDate: "2026-09-14" });
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.sourceWorkoutId, "coros-plan:22"));

    const res = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(res.status).toBe(200);
    expect(await jobs()).toEqual([]);
    expect(await statusOf(ahead)).toBe("verified");
  });

  it("refuses plainly: another account's or no plan (404), an older plan (409 not_current), one over (409 plan_completed)", async () => {
    const { planId } = await pushedPlan();
    expect((await client().post("/api/studio/plans/nope/retire")).status).toBe(404);

    // Another account's plan reads as no plan at all.
    const other = await makeTestUser(db, { corosWritesEnabled: true });
    const otherCookie = `${SESSION_COOKIE}=${await createSession(db, other.userId)}`;
    const theirs = await client().post(`/api/studio/plans/${planId}/retire`, undefined, { Cookie: otherCookie });
    expect(theirs.status).toBe(404);

    // A newer plan makes this one history: the generate that replaced it already retired what it had.
    const newer = newId();
    await db.insert(studioPlans).values({
      id: newer,
      userId,
      brief: plan().brief as unknown as Record<string, unknown>,
      plan: plan() as unknown as Record<string, unknown>,
      version: 1,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: nowInstant(),
    });
    const stale = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "not_current" });

    // Past its last day (Sun Sep 20): over, nothing to retire.
    vi.setSystemTime(new Date("2026-09-22T19:00:00Z"));
    const over = await client().post(`/api/studio/plans/${newer}/retire`);
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "plan_completed" });
    expect(await jobs()).toEqual([]);
  });

  it("with COROS writes switched off it says so (412) and changes nothing", async () => {
    const { planId, ahead } = await pushedPlan();
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), corosWritesEnabled: false });
    const res = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: "writes_disabled" });
    expect(await jobs()).toEqual([]);
    expect(await statusOf(ahead)).toBe("verified");
    expect((await coachList()).map((p) => p.id)).toEqual([planId]);
  });

  it("a retired plan's adopted session is not put back on the watch by an undo: it answers that the plan is retired", async () => {
    const { planId } = await pushedPlan();
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    const adopted = await seedAdoptedPushRow(planId, { happenDay: "2026-09-15", sessionTitle: "Full Body — wk 2b", corosIdInPlan: "23" });
    const before = (await jobs()).length;
    // Settings → Sync's undo (the studio route is unmounted, S6): the same service.
    expect(await undoStudioAdoption(db, userId, adopted, todayInZone(timezone))).toMatchObject({ ok: false, error: "plan_retired" });
    expect(await jobs()).toHaveLength(before);
  });
});

// ── Fix round 2: what is behind stays, nothing on the watch retires locally, the old routes leave a retired plan be ──

describe("retire, fix round 2", () => {
  vi.setConfig({ testTimeout: 20_000 });
  const push = async (planId: string, over: Partial<typeof studioPlanPushes.$inferInsert> & { happenDay: string; sessionTitle: string }) => {
    const id = newId();
    await db.insert(studioPlanPushes).values({ id, planId, planVersion: 1, status: "verified", error: null, updatedAt: nowInstant(), ...over });
    return id;
  };
  const addressed = (slot: string) => ({ corosIdInPlan: slot, corosProgramId: slot, corosPlanId: "coros-plan", sessionFingerprint: "fp" });
  const jobs = () => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
  const rowOf = async (id: string) => (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, id)))[0]!;
  const coachList = async () => {
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const res = await app.request("/api/coach/plans", { headers: { Cookie: cookie } }, makeEnv());
    return ((await res.json()) as { plans: Array<{ id: string; source?: string }> }).plans.filter((p) => p.source === "studio");
  };
  async function planBetweenWeeks(): Promise<string> {
    vi.setSystemTime(new Date("2026-09-10T19:00:00Z"));
    await seedCatalog();
    return seedPlan();
  }

  it("a failed session behind the day that still has a COROS address stays on the watch", async () => {
    const planId = await planBetweenWeeks();
    // COROS filed it a day off (`wrong_date`): its ids were saved, so it is there.
    const stray = await push(planId, { happenDay: "2026-09-07", sessionTitle: "Full Body — wk 1", ...addressed("21"), corosHappenDay: "2026-09-08", status: "failed", error: "wrong_date" });
    const ahead = await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", ...addressed("22") });
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    expect((await jobs()).map((j) => j.studioPushId)).toEqual([ahead]);
    expect(await rowOf(stray)).toMatchObject({ status: "failed", error: "wrong_date" });
  });

  it("writes off and nothing ahead on the watch: retired here; what was never there is cleared", async () => {
    const planId = await planBetweenWeeks();
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), corosWritesEnabled: false });
    const behind = await push(planId, { happenDay: "2026-09-07", sessionTitle: "Full Body — wk 1", ...addressed("21") });
    const neverMade = await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", status: "failed", error: "day_in_past" });
    const unheard = await push(planId, { happenDay: "2026-09-15", sessionTitle: "Full Body — wk 2b", status: "pending" });
    const res = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(res.status).toBe(200);
    expect(await jobs()).toEqual([]);
    expect(await rowOf(behind)).toMatchObject({ status: "verified" });
    expect(await rowOf(neverMade)).toMatchObject({ status: "deleted" });
    // A create that never reported may have landed, with no address to remove it by: said, as a push says it.
    expect(await rowOf(unheard)).toMatchObject({ status: "failed", error: "unaddressable" });
    expect(await coachList()).toEqual([]);
  });

  it("a refused Retire marks nothing: with writes off and something ahead on the watch, the plan stays listed", async () => {
    const planId = await planBetweenWeeks();
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), corosWritesEnabled: false });
    await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", ...addressed("22") });
    const res = await client().post(`/api/studio/plans/${planId}/retire`);
    expect(res.status).toBe(412);
    expect((await coachList()).map((p) => p.id)).toEqual([planId]);
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(412);
  });

  it("dismisses the plan's open notes of sessions edited or removed on COROS — and only that plan's", async () => {
    const planId = await planBetweenWeeks();
    await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", ...addressed("22") });
    const note = (studioPlanId: string) => ({
      id: newId(),
      userId,
      workoutId: null,
      kind: "adopted_coros_edit",
      payload: { pushId: "p", studioPlanId, sessionTitle: "Full Body — wk 1", happenDay: "2026-09-07" },
      createdAt: nowInstant(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const mine = note(planId);
    const other = note("another-plan");
    await db.insert(schema.syncNotes).values([mine, other]);
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    const open = (await db.select().from(schema.syncNotes)).filter((n) => n.dismissedAt === null).map((n) => n.id);
    expect(open).toEqual([other.id]);
  });

  // REBASED 2026-11-06 (audit fixes, safety, S6): the routes are unmounted — 404 now, and a retired plan is still left be.
  it("the old generator's routes leave a retired plan be: /push, /push/retry, /edit and /generate are gone (404)", async () => {
    const planId = await planBetweenWeeks();
    const ahead = await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", ...addressed("22") });
    await push(planId, { happenDay: "2026-09-21", sessionTitle: "Full Body — wk 3", status: "failed", error: "network" });
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    const queued = (await jobs()).length;
    for (const [path, body] of [
      ["/api/studio/push", undefined],
      ["/api/studio/push/retry", { happenDay: "2026-09-21" }],
      ["/api/studio/edit", { request: "add a day" }],
      ["/api/studio/generate", { brief: validBriefInput("2026-10-05") }],
    ] as const) {
      const res = await client().post(path, body);
      expect(res.status, path).toBe(404);
    }
    expect(await jobs()).toHaveLength(queued);
    expect(await rowOf(ahead)).toMatchObject({ status: "verified" });
    expect(await db.select().from(studioPlans).where(eq(studioPlans.userId, userId))).toHaveLength(1);
  });

  it("a session ahead edited on COROS is never deleted by a retire, and nothing is posted about it", async () => {
    const planId = await planBetweenWeeks();
    const renamed = await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", ...addressed("22") });
    await seedObservation({ sourceWorkoutId: "coros-plan:22", title: "My own Monday", lastVerifiedCorosDate: "2026-09-14" });
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    expect(await jobs()).toEqual([]);
    expect((await rowOf(renamed)).status).not.toBe("deleted");
    expect(await db.select().from(schema.syncNotes)).toEqual([]);
  });

  // Fix round 3: with writes on, the push path even when nothing ahead has an address — its heal finds a create that
  // landed on COROS but never reported, by its stamp on its day, and removes it.
  it("writes on: a create that landed but never reported is found by its stamp and taken off the watch", async () => {
    const planId = await planBetweenWeeks();
    const unheard = await push(planId, { happenDay: "2026-09-14", sessionTitle: "Full Body — wk 2", status: "pending" });
    await seedObservation({ sourceWorkoutId: "coros-plan:31", title: "Full Body — wk 2", lastVerifiedCorosDate: "2026-09-14" });
    expect((await client().post(`/api/studio/plans/${planId}/retire`)).status).toBe(200);
    const queued = await jobs();
    expect(queued.map((j) => [j.kind, j.studioPushId])).toEqual([["delete_scheduled_workout", unheard]]);
    expect((queued[0]!.payload as { idInPlan: string; corosPlanId: string })).toMatchObject({ idInPlan: "31", corosPlanId: "coros-plan" });
    expect(await coachList()).toEqual([]);
  });
});

// Fix round 2: a push's jobs are built and checked before any row is written — a job the bridge would refuse leaves
// the plan's rows as they were, with nothing queued.
// The push itself lives on behind Settings → Sync's Retry of an old plan's failed rows (routes/sync.ts): the service.
describe("pushStudioPlan — nothing half-done", () => {
  it("a create whose job would be refused: no row written, no job queued", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const gone = newId();
    await db.insert(studioPlanPushes).values({ id: gone, planId, planVersion: 1, happenDay: "2026-09-21", sessionTitle: "Gone", status: "failed", error: "network", updatedAt: nowInstant() });
    const refuse = vi.spyOn(createScheduledWorkoutJobSchema, "safeParse").mockReturnValue({ success: false } as never);
    try {
      // The refused job throws before anything is written (the route answered it a 500).
      await expect(pushStudioPlan(db, { userId, studioPlanId: planId, today: todayInZone(timezone) })).rejects.toThrow("invalid_create_scheduled_workout_payload");
    } finally {
      refuse.mockRestore();
    }
    expect(await db.select().from(corosWriteJobs)).toEqual([]);
    const rows = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, planId));
    expect(rows.map((r) => [r.id, r.status])).toEqual([[gone, "failed"]]);
  });
});
