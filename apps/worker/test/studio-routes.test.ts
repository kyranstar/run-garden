/**
 * Plan Studio API routes (plan-studio-design §7, task-5-brief.md, fix rounds
 * for review carry-forwards F1–F6).
 *
 * FIXTURE_MODE=1 stands in for "stubbed studio-llm" for most tests here:
 * studio-llm.ts's own fixture path (buildFixturePlan / editPlan's canned
 * "(edited)" rename) is already deterministic and network-free — proven out
 * by studio-llm.test.ts's own fetchImpl-DI suite (Task 4).
 *
 * F1's fix round needed one exception: proving the route forces the persisted
 * brief back to the STORED plan's brief on a major edit requires scripting a
 * gateway reply whose OWN brief is mutated — fixture mode's editPlan stub
 * ignores `request`/`major` entirely and can't produce that. Rather than
 * duplicate studio-llm.ts's whole fetchImpl-DI test rig at the route layer,
 * `AppContext.Variables.llmFetch` (an additive, test-only seam — see
 * `auth/middleware.ts`) lets `clientWithScriptedFetch` below inject exactly
 * one scripted `Response` through the real route into `editPlan`/`generatePlan`,
 * with `FIXTURE_MODE` off.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, startOfIsoWeek, todayInZone, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { AppContext } from "../src/auth/middleware.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
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

/** A push row that's live on COROS — addressable and `verified` — for F5's
 * regenerate guard tests (`hasLivePush` in studio.ts). */
async function seedVerifiedPushRow(
  planId: string,
  over: Partial<{ happenDay: string; sessionTitle: string }> = {},
): Promise<string> {
  const id = newId();
  await db.insert(studioPlanPushes).values({
    id,
    planId,
    planVersion: 1,
    happenDay: over.happenDay ?? "2026-09-07",
    sessionTitle: over.sessionTitle ?? "Full Body — wk 1",
    corosIdInPlan: "21",
    corosProgramId: "21",
    corosPlanId: "coros-plan",
    status: "verified",
    error: null,
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

/**
 * F1's fix-round test seam: mounts `studioRoutes` behind a middleware that
 * also sets `llmFetch` (see `AppContext.Variables`), so a scripted `Response`
 * reaches `generatePlan`/`editPlan` through the real route instead of
 * fixture mode's canned output. `FIXTURE_MODE` must be off for the scripted
 * fetch to actually be reached (fixture mode short-circuits before it).
 */
function clientWithScriptedFetch(
  fetchImpl: typeof fetch,
  env: Env = makeEnv({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "test-key" }),
) {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("llmFetch", fetchImpl);
    await next();
  });
  app.route("/api/studio", studioRoutes);
  return {
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
  };
}

/** One scripted OpenAI-compatible chat-completion response carrying `content`
 * as its JSON-stringified message body — same wire shape studio-llm.ts's
 * `chatCompletion` parses (mirrors `studio-llm.test.ts`'s own `chatBody`). */
function chatResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db);
  userId = user.userId;
  timezone = user.prefs.timezone;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

// ─────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects every route without a session cookie", async () => {
    const c = client();
    expect((await c.get("/api/studio", {})).status).toBe(401);
    expect((await c.post("/api/studio/generate", { brief: validBriefInput("2026-09-07") }, {})).status).toBe(401);
    expect((await c.post("/api/studio/edit", { request: "x" }, {})).status).toBe(401);
    expect((await c.post("/api/studio/push", undefined, {})).status).toBe(401);
    expect((await c.post("/api/studio/push/retry", { happenDay: "2026-09-07" }, {})).status).toBe(401);
  });
});

describe("GET /api/studio", () => {
  it("returns an empty-state shape when the user has no plan yet", async () => {
    const res = await client().get("/api/studio");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      plan: null,
      brief: null,
      version: null,
      pushes: [],
      lastPushSummary: null,
      bridge: { online: false, pendingJobs: { queued: 0, oldestQueuedAt: null } },
    });
    expect(body.llm).toMatchObject({ warn: false, cutoff: false });
  });

  it("never returns another user's plan", async () => {
    await seedPlan();
    const other = await makeTestUser(db);
    const otherToken = await createSession(db, other.userId);
    const res = await client().get("/api/studio", { Cookie: `${SESSION_COOKIE}=${otherToken}` });
    const body = (await res.json()) as { plan: unknown };
    expect(body.plan).toBeNull();
  });

  it("history returns every generated plan with the brief that produced it, newest first", async () => {
    await seedPlan();
    const res = await client().get("/api/studio/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plans: Array<{ id: string; name: string; weeks: number | null; brief: { notes?: string } }>;
    };
    expect(body.plans.length).toBeGreaterThanOrEqual(1);
    expect(body.plans[0]!.name.length).toBeGreaterThan(0);
    expect(body.plans[0]!.brief).toBeTruthy(); // the prompt is durably saved
  });

  it("history never leaks another user's plans", async () => {
    await seedPlan();
    const other = await makeTestUser(db);
    const otherToken = await createSession(db, other.userId);
    const res = await client().get("/api/studio/history", {
      Cookie: `${SESSION_COOKIE}=${otherToken}`,
    });
    const body = (await res.json()) as { plans: unknown[] };
    expect(body.plans).toHaveLength(0);
  });

  it("surfaces queued studio jobs and bridge liveness", async () => {
    await seedPlan();
    await db.insert(corosWriteJobs).values({
      id: newId(),
      userId,
      workoutId: "push-1",
      studioPushId: "push-1",
      kind: "create_scheduled_workout",
      expectedContentFingerprint: "",
      originalDate: "2026-09-07",
      destinationDate: "2026-09-07",
      payload: {},
      requestedAt: "2026-09-01T00:00:00.000Z",
      status: "queued",
      updatedAt: nowInstant(),
    });
    const res = await client().get("/api/studio");
    const body = (await res.json()) as { bridge: { pendingJobs: { queued: number; oldestQueuedAt: string } } };
    expect(body.bridge.pendingJobs).toEqual({ queued: 1, oldestQueuedAt: "2026-09-01T00:00:00.000Z" });
  });

  // F2 (fix round 1): a claimed-but-stalled job is a different signal than an
  // unclaimed one — it must show up in `inFlight`, NOT count toward
  // `pendingJobs.queued` (which the device already claimed it out of).
  it("puts a claimed/in-flight job in inFlight, not pendingJobs", async () => {
    await seedPlan();
    await db.insert(corosWriteJobs).values({
      id: newId(),
      userId,
      workoutId: "push-2",
      studioPushId: "push-2",
      kind: "delete_scheduled_workout",
      expectedContentFingerprint: "",
      originalDate: "2026-09-07",
      destinationDate: "2026-09-07",
      payload: {},
      requestedAt: "2026-09-01T00:00:00.000Z",
      status: "claimed",
      claimedByDeviceId: "device-1",
      claimedAt: "2026-09-01T00:05:00.000Z",
      updatedAt: nowInstant(),
    });
    const res = await client().get("/api/studio");
    const body = (await res.json()) as {
      bridge: {
        pendingJobs: { queued: number; oldestQueuedAt: string | null };
        inFlight: { count: number; oldestClaimedAt: string | null };
      };
    };
    expect(body.bridge.pendingJobs).toEqual({ queued: 0, oldestQueuedAt: null });
    expect(body.bridge.inFlight).toEqual({ count: 1, oldestClaimedAt: "2026-09-01T00:05:00.000Z" });
  });

  it("keeps a purely queued (unclaimed) job out of inFlight", async () => {
    await seedPlan();
    await db.insert(corosWriteJobs).values({
      id: newId(),
      userId,
      workoutId: "push-3",
      studioPushId: "push-3",
      kind: "create_scheduled_workout",
      expectedContentFingerprint: "",
      originalDate: "2026-09-07",
      destinationDate: "2026-09-07",
      payload: {},
      requestedAt: "2026-09-01T00:00:00.000Z",
      status: "queued",
      updatedAt: nowInstant(),
    });
    const res = await client().get("/api/studio");
    const body = (await res.json()) as { bridge: { inFlight: { count: number } } };
    expect(body.bridge.inFlight).toEqual({ count: 0, oldestClaimedAt: null });
  });
});

describe("POST /api/studio/generate", () => {
  it("rejects a malformed brief", async () => {
    const res = await client().post("/api/studio/generate", { brief: { goal: "strength" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  // F3 (fix round 1): malformed JSON gets a structured 400, not an uncaught 500.
  it("rejects a malformed JSON body with a structured 400 (not a 500)", async () => {
    const res = await client().postRaw("/api/studio/generate", "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_json" });
  });

  it("rejects a startDate before today", async () => {
    const res = await client().post("/api/studio/generate", { brief: validBriefInput("2020-01-01") });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "start_date_in_past" });
  });

  it("returns catalog_not_synced when coros_exercises is empty, and persists nothing", async () => {
    const res = await client().post("/api/studio/generate", { brief: validBriefInput("2026-09-07") });
    expect(res.status).toBe(412);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "catalog_not_synced" });
    expect(await db.select().from(studioPlans)).toHaveLength(0);
  });

  it("normalizes startDate to the ISO-week Monday, generates, and persists version 1", async () => {
    await seedCatalog();
    // A Wednesday — startOfIsoWeek should roll it back to the Monday.
    const res = await client().post("/api/studio/generate", { brief: validBriefInput("2026-09-09") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number; brief: PlanBrief; plan: LiftingPlan };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
    expect(body.brief.startDate).toBe(startOfIsoWeek("2026-09-09"));
    expect(body.plan.brief.startDate).toBe(startOfIsoWeek("2026-09-09"));

    const rows = await db.select().from(studioPlans).where(eq(studioPlans.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect((rows[0]!.brief as PlanBrief).startDate).toBe(startOfIsoWeek("2026-09-09"));
  });

  it("accepts a startDate of exactly today", async () => {
    await seedCatalog();
    const today = todayInZone(timezone);
    const res = await client().post("/api/studio/generate", { brief: validBriefInput(today) });
    expect(res.status).toBe(200);
  });

  it("creates a fresh plan row (not an upsert) on a second generate", async () => {
    await seedCatalog();
    await client().post("/api/studio/generate", { brief: validBriefInput("2026-09-07") });
    const res2 = await client().post("/api/studio/generate", { brief: validBriefInput("2026-10-05") });
    expect(res2.status).toBe(200);
    const rows = await db.select().from(studioPlans).where(eq(studioPlans.userId, userId));
    expect(rows).toHaveLength(2);

    const getRes = await client().get("/api/studio");
    const body = (await getRes.json()) as { brief: PlanBrief };
    expect(body.brief.startDate).toBe(startOfIsoWeek("2026-10-05"));
  });
});

// F5 (fix round 1): regenerating over a plan with live COROS sessions must
// not silently orphan them.
describe("POST /api/studio/generate — guarded regenerate (F5)", () => {
  it("409s without replace when the current plan has a verified push row", async () => {
    await seedCatalog();
    const oldPlanId = await seedPlan();
    await seedVerifiedPushRow(oldPlanId);

    const res = await client().post("/api/studio/generate", { brief: validBriefInput("2026-10-05") });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "plan_has_live_pushes" });
    // Nothing was created — the guard fired before generatePlan ever ran.
    expect(await db.select().from(studioPlans)).toHaveLength(1);
  });

  it("with replace:true, retires the old plan's live rows, creates the new plan, and keeps the old plan as history", async () => {
    await seedCatalog();
    const oldPlanId = await seedPlan();
    const oldPushId = await seedVerifiedPushRow(oldPlanId);

    const res = await client().post("/api/studio/generate", {
      brief: validBriefInput("2026-10-05"),
      replace: true,
    });
    expect(res.status).toBe(200);

    // The old plan is retained (history), not deleted — just no longer current.
    const allPlans = await db.select().from(studioPlans).where(eq(studioPlans.userId, userId));
    expect(allPlans).toHaveLength(2);
    expect(allPlans.some((p) => p.id === oldPlanId)).toBe(true);

    // A guarded delete was enqueued for the old plan's verified row — the
    // SAME removal machinery a normal push uses, not a bespoke bulk-delete.
    const deleteJobs = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.userId, userId));
    expect(deleteJobs).toHaveLength(1);
    expect(deleteJobs[0]).toMatchObject({ kind: "delete_scheduled_workout", studioPushId: oldPushId, status: "queued" });

    // The row itself isn't marked deleted yet — that happens asynchronously
    // once the bridge executes and reports back, not at enqueue time.
    const oldRow = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, oldPushId)))[0]!;
    expect(oldRow.status).toBe("verified");

    // GET now surfaces the NEW plan as current, not the old one.
    const getRes = await client().get("/api/studio");
    const body = (await getRes.json()) as { brief: PlanBrief };
    expect(body.brief.startDate).toBe(startOfIsoWeek("2026-10-05"));
  });

  it("replace:true with no live rows behaves like a normal generate (no deletes enqueued)", async () => {
    await seedCatalog();
    await seedPlan(); // never pushed — no live rows
    const res = await client().post("/api/studio/generate", {
      brief: validBriefInput("2026-10-05"),
      replace: true,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });
});

// F5-REGRESSION (fix round 2): fix round 1's `replace: true` ran the retire
// (real DELETE jobs against the user's live COROS calendar) BEFORE the
// catalog check and the LLM call. Any routine failure after that point left
// the old plan's deletes already enqueued with no new plan ever created —
// data loss behind what the UI would show as a clean, retryable error. These
// pin that retiring now happens ONLY once the new plan is fully validated
// and about to be persisted — never on a path that ends in one of these
// routine failures.
describe("POST /api/studio/generate — replace ordering (F5-regression)", () => {
  it("replace:true + catalog_not_synced: 412, zero delete jobs enqueued, old plan/row untouched", async () => {
    // No seedCatalog() — the catalog is empty, so /generate must fail at the
    // catalog check, strictly BEFORE the retire step runs.
    const oldPlanId = await seedPlan();
    const oldPushId = await seedVerifiedPushRow(oldPlanId);

    const res = await client().post("/api/studio/generate", {
      brief: validBriefInput("2026-10-05"),
      replace: true,
    });
    expect(res.status).toBe(412);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "catalog_not_synced" });

    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
    expect(await db.select().from(studioPlans).where(eq(studioPlans.userId, userId))).toHaveLength(1);
    const oldRow = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, oldPushId)))[0]!;
    expect(oldRow.status).toBe("verified");
  });

  it("replace:true + budget_cutoff: 402, zero delete jobs enqueued, old plan/row untouched", async () => {
    await seedCatalog();
    const oldPlanId = await seedPlan();
    const oldPushId = await seedVerifiedPushRow(oldPlanId);
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "test-model",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 21_000_000, // over LLM_BUDGET.cutoffMicros ($20, coach era)
      cacheHit: false,
      requestFingerprint: "over-budget-replace",
      createdAt: nowInstant(),
    });

    const res = await client(makeEnv({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "test-key" })).post(
      "/api/studio/generate",
      { brief: validBriefInput("2026-10-05"), replace: true },
    );
    expect(res.status).toBe(402);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "budget_cutoff" });

    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
    expect(await db.select().from(studioPlans).where(eq(studioPlans.userId, userId))).toHaveLength(1);
    const oldRow = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, oldPushId)))[0]!;
    expect(oldRow.status).toBe("verified");
  });

  it("a retire failure (invalid_plan) surfaces a structured error and does not create the new plan", async () => {
    await seedCatalog();
    // A plan row whose stored `plan` JSON fails liftingPlanSchema — the
    // retire step's own `pushStudioPlan` call re-validates it and refuses.
    const oldPlanId = newId();
    await db.insert(studioPlans).values({
      id: oldPlanId,
      userId,
      brief: plan().brief as unknown as Record<string, unknown>,
      plan: { garbage: true } as unknown as Record<string, unknown>,
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const oldPushId = await seedVerifiedPushRow(oldPlanId);

    const res = await client().post("/api/studio/generate", {
      brief: validBriefInput("2026-10-05"),
      replace: true,
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_plan" });

    // No new plan was created; the old row is untouched.
    expect(await db.select().from(studioPlans).where(eq(studioPlans.userId, userId))).toHaveLength(1);
    const oldRow = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, oldPushId)))[0]!;
    expect(oldRow.status).toBe("verified");
  });
});

// `llmFailureResponse`'s status-code mapping (studio.ts). `no_api_key` and
// `budget_cutoff` both return from generatePlan/editPlan BEFORE any gateway
// fetch (studio-llm.ts checks the key, then the budget, ahead of the actual
// call), so — unlike `invalid_output`/`gateway_*`, which need a scripted
// response and are left to studio-llm.ts's own fetchImpl-DI suite — these two
// are reachable with FIXTURE_MODE off and zero network stubbing.
describe("POST /api/studio/generate — LLM failure status mapping", () => {
  it("maps no_api_key to 503", async () => {
    await seedCatalog();
    const res = await client(makeEnv({ FIXTURE_MODE: "0" })).post("/api/studio/generate", {
      brief: validBriefInput("2026-09-07"),
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_api_key" });
  });

  it("maps budget_cutoff to 402", async () => {
    await seedCatalog();
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "test-model",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 21_000_000, // over LLM_BUDGET.cutoffMicros ($20, coach era)
      cacheHit: false,
      requestFingerprint: "over-budget",
      createdAt: nowInstant(),
    });
    const res = await client(makeEnv({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "test-key" })).post(
      "/api/studio/generate",
      { brief: validBriefInput("2026-09-07") },
    );
    expect(res.status).toBe(402);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "budget_cutoff" });
  });
});

describe("POST /api/studio/edit", () => {
  it("404s (structured) when there is no plan yet", async () => {
    const res = await client().post("/api/studio/edit", { request: "add a day" });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_plan" });
  });

  it("rejects a missing request body field", async () => {
    await seedPlan();
    const res = await client().post("/api/studio/edit", {});
    expect(res.status).toBe(400);
  });

  // F3 (fix round 1): malformed JSON gets a structured 400, not an uncaught 500.
  it("rejects a malformed JSON body with a structured 400 (not a 500)", async () => {
    await seedPlan();
    const res = await client().postRaw("/api/studio/edit", "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_json" });
  });

  it("returns catalog_not_synced when the catalog has since gone empty", async () => {
    await seedPlan();
    const res = await client().post("/api/studio/edit", { request: "add a day" });
    expect(res.status).toBe(412);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "catalog_not_synced" });
  });

  it("applies the edit and bumps the version", async () => {
    await seedCatalog();
    await seedPlan();
    const res = await client().post("/api/studio/edit", { request: "rename it" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number; plan: LiftingPlan };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(2);
    // FIXTURE_MODE's editPlan stub renames the plan deterministically.
    expect(body.plan.name).toBe("Autumn Strength (edited)");

    const rows = await db.select().from(studioPlans).where(eq(studioPlans.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(2);
  });

  // F1 (fix round 1), SELECTIVE (fix round 2): a major:true edit regenerates
  // the WHOLE plan via the strong model, so nothing but the route itself
  // stops the model from echoing back a mutated brief. Scripts a gateway
  // reply whose free-text/schedule-anchor fields (constraints AND startDate)
  // disagree with the stored plan's, and asserts the persisted/returned plan
  // keeps exactly THOSE fields verbatim from the stored brief regardless —
  // this is the "injection-sensitive fields locked" direction; the paired
  // "structural fields editable" direction is the resize test below.
  it("major:true reverts constraints/startDate to the stored brief, even when the model's reply mutates them", async () => {
    await seedCatalog();
    const storedPlan = plan();
    const planId = await seedPlan(storedPlan);

    const mutatedPlan: LiftingPlan = {
      ...storedPlan,
      name: "Model Renamed It",
      brief: {
        ...storedPlan.brief,
        constraints: "MODEL-INJECTED: skip all leg work",
        startDate: "2026-10-05",
      },
    };
    const fetchImpl = (async () => chatResponse(mutatedPlan)) as typeof fetch;

    const res = await clientWithScriptedFetch(fetchImpl).post("/api/studio/edit", {
      request: "make it harder",
      major: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; plan: LiftingPlan; brief: PlanBrief };
    expect(body.ok).toBe(true);
    // The rest of the model's output DID apply (proves this isn't just
    // silently rejecting the whole reply)...
    expect(body.plan.name).toBe("Model Renamed It");
    // ...but the brief is exactly what was stored before the edit, not what
    // the model emitted — every field is unchanged here (the mutation only
    // touched the two locked ones), so whole-object equality still holds.
    expect(body.brief).toEqual(storedPlan.brief);
    expect(body.plan.brief).toEqual(storedPlan.brief);
    expect(body.brief.constraints).not.toBe("MODEL-INJECTED: skip all leg work");
    expect(body.brief.startDate).toBe(storedPlan.brief.startDate);

    const row = (await db.select().from(studioPlans).where(eq(studioPlans.id, planId)))[0]!;
    expect(row.brief).toEqual(storedPlan.brief);
    expect((row.plan as unknown as LiftingPlan).brief).toEqual(storedPlan.brief);
  });

  // F1-REGRESSION (fix round 2): fix round 1's blanket brief lock forced the
  // ENTIRE stored brief back onto every major-edit reply — including
  // `durationWeeks`, which major-edit's own prompt explicitly permits
  // changing on a resize request. That broke every resize with a spurious
  // `invalid_output` the moment the model's (correct) new `durationWeeks`
  // disagreed with the locked-back stale one. This is the paired "structural
  // fields editable" direction of the F1 test above: a self-consistent
  // resize (2 weeks → 3, `weeks.length` matching the new `durationWeeks`)
  // must succeed and actually take effect.
  it("major:true allows a legitimate resize (durationWeeks/weeks) the model returns", async () => {
    await seedCatalog();
    const storedPlan = plan(); // 2 weeks, 1 session/week (from the shared `plan()` helper)
    const planId = await seedPlan(storedPlan);

    const resizedPlan: LiftingPlan = {
      ...storedPlan,
      name: "Autumn Strength (extended)",
      weeks: [...storedPlan.weeks, { sessions: [session()] }], // now 3 weeks
      brief: { ...storedPlan.brief, durationWeeks: 3 },
    };
    const fetchImpl = (async () => chatResponse(resizedPlan)) as typeof fetch;

    const res = await clientWithScriptedFetch(fetchImpl).post("/api/studio/edit", {
      request: "add a third week",
      major: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; plan: LiftingPlan; brief: PlanBrief };
    expect(body.ok).toBe(true);
    expect(body.brief.durationWeeks).toBe(3);
    expect(body.plan.weeks).toHaveLength(3);
    // The locked (injection-sensitive) fields are still exactly the stored
    // ones — the resize didn't touch them, but the merge shouldn't either.
    expect(body.brief.constraints).toBe(storedPlan.brief.constraints);
    expect(body.brief.startDate).toBe(storedPlan.brief.startDate);

    const row = (await db.select().from(studioPlans).where(eq(studioPlans.id, planId)))[0]!;
    expect((row.brief as PlanBrief).durationWeeks).toBe(3);
    expect((row.plan as unknown as LiftingPlan).weeks).toHaveLength(3);
  });
});

describe("POST /api/studio/push", () => {
  it("404s (structured) when there is no plan yet", async () => {
    const res = await client().post("/api/studio/push");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_plan" });
  });

  it("triggers push orchestration and returns the row-level push state", async () => {
    await seedCatalog();
    await seedPlan();
    const res = await client().post("/api/studio/push");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: { creates: number; blocked: number };
      pushes: Array<{ id: string; happenDay: string; sessionTitle: string; status: string; error: string | null }>;
    };
    expect(body.ok).toBe(true);
    // Two weeks (the schema's minimum), one session each.
    expect(body.summary.creates).toBe(2);
    expect(body.summary.blocked).toBe(0);
    expect(body.pushes).toHaveLength(2);
    expect(body.pushes.map((p) => p.sessionTitle).sort()).toEqual(["Full Body — wk 1", "Full Body — wk 2"]);
    expect(body.pushes[0]).toMatchObject({ status: "pending", error: null });
    // Internal COROS addressing fields are not part of the DTO.
    expect(body.pushes[0]).not.toHaveProperty("corosIdInPlan");

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs).toHaveLength(2);
  });

  it("feeds the last push summary back through GET, including blocked", async () => {
    await seedCatalog();
    await seedPlan();
    await client().post("/api/studio/push");
    const res = await client().get("/api/studio");
    const body = (await res.json()) as { lastPushSummary: { creates: number; blocked: number } | null };
    expect(body.lastPushSummary).toMatchObject({ creates: 2, deletes: 0, blocked: 0 });
  });
});

describe("POST /api/studio/push/retry", () => {
  it("rejects a malformed happenDay", async () => {
    await seedPlan();
    const res = await client().post("/api/studio/push/retry", { happenDay: "not-a-date" });
    expect(res.status).toBe(400);
  });

  // F3 (fix round 1): malformed JSON gets a structured 400, not an uncaught 500.
  it("rejects a malformed JSON body with a structured 400 (not a 500)", async () => {
    await seedPlan();
    const res = await client().postRaw("/api/studio/push/retry", "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_json" });
  });

  it("404s when there is no failed row for that day", async () => {
    await seedCatalog();
    await seedPlan();
    const res = await client().post("/api/studio/push/retry", { happenDay: "2026-09-07" });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_failed_row_for_day" });
  });

  it("re-invokes the whole-plan push for a failed session (idempotent, not row-scoped)", async () => {
    await seedCatalog();
    // Deep in the past relative to "today", so the session fails as day_in_past
    // deterministically regardless of when the suite runs.
    const planId = await seedPlan({ brief: { startDate: "2020-01-06" } as PlanBrief });
    const first = await client().post("/api/studio/push");
    const firstBody = (await first.json()) as { summary: { failures: number } };
    // Both weeks land in the past, so both sessions fail.
    expect(firstBody.summary.failures).toBe(2);
    const failedRows = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, planId));
    expect(failedRows).toHaveLength(2);
    expect(failedRows.every((r) => r.status === "failed" && r.error === "day_in_past")).toBe(true);

    const res = await client().post("/api/studio/push/retry", { happenDay: failedRows[0]!.happenDay });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { failures: number } };
    expect(body.ok).toBe(true);
    // Same deterministic refusal on the re-run — proves it re-ran the whole
    // diff rather than force-completing a single row.
    expect(body.summary.failures).toBe(2);
  });
});

// Task 7 fix round: the undo route case-detects from the last observation of
// the source workout rather than a single generic "flip it back" transition.
describe("POST /api/studio/adoption/:pushId/undo", () => {
  it("MOVED: re-verifies the row and plans a delete at the observed day, chained to a recreate", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedAdoptedPushRow(planId, { corosHappenDay: "2026-09-10" });
    // Same title (not a rename), a different date than happenDay (a move).
    await seedObservation({
      sourceWorkoutId: "coros-plan:21",
      title: "Full Body — wk 1",
      lastVerifiedCorosDate: "2026-09-10",
    });

    const res = await client().post(`/api/studio/adoption/${pushId}/undo`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    // The row leaves "adopted" — re-verified and mid-flight on the corrective
    // delete+create the re-push planned for it.
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("pending");

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    const deleteJob = jobs.find((j) => j.kind === "delete_scheduled_workout");
    expect(deleteJob).toBeTruthy();
    const payload = deleteJob!.payload as {
      happenDay: string;
      followUpCreate?: { happenDay: string; name: string };
    };
    // Targets where the workout ACTUALLY is, not the day the plan originally
    // asked for — addressing the wrong day would come back stamp_mismatch.
    expect(payload.happenDay).toBe("2026-09-10");
    expect(payload.followUpCreate).toBeTruthy();
    expect(payload.followUpCreate!.happenDay).toBe("2026-09-07");
    expect(payload.followUpCreate!.name).toBe("Full Body — wk 1");
  });

  it("MISSING: enqueues a create only — no delete job for a workout COROS already removed", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedAdoptedPushRow(planId, { corosIdInPlan: "22" });
    await seedObservation({
      sourceWorkoutId: "coros-plan:22",
      archivedAt: nowInstant(),
      archiveReason: "absence_confirmed",
    });

    const res = await client().post(`/api/studio/adoption/${pushId}/undo`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs.some((j) => j.kind === "delete_scheduled_workout")).toBe(false);
    const createJob = jobs.find((j) => j.kind === "create_scheduled_workout" && j.studioPushId === pushId);
    expect(createJob).toBeTruthy();

    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("pending");
    expect(row.corosIdInPlan).toBeNull();
  });

  it("RENAMED: refuses with 409 undo_unsupported_rename and leaves the row adopted", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedAdoptedPushRow(planId, { corosIdInPlan: "23" });
    await seedObservation({ sourceWorkoutId: "coros-plan:23", title: "Renamed By User" });

    const res = await client().post(`/api/studio/adoption/${pushId}/undo`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "undo_unsupported_rename" });

    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("adopted");
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });

  it("404s (not_found) for a pushId belonging to another user's plan — same shape as unknown/non-adopted", async () => {
    await seedCatalog();
    const other = await makeTestUser(db);
    const otherPlanId = newId();
    await db.insert(studioPlans).values({
      id: otherPlanId,
      userId: other.userId,
      brief: plan().brief as unknown as Record<string, unknown>,
      plan: plan() as unknown as Record<string, unknown>,
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const foreignPushId = await seedAdoptedPushRow(otherPlanId);

    const res = await client().post(`/api/studio/adoption/${foreignPushId}/undo`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_found" });
  });
});

// F6 (fix round 1, test hygiene): the WRITE routes (edit/push/retry) must be
// exactly as user-scoped as GET already was — a second user with no plan of
// their own gets the structured `no_plan` refusal and has zero effect on the
// first user's rows, not e.g. an ambiguous 500 or (worse) a write that lands
// on the wrong account's plan.
describe("cross-user write isolation (F6)", () => {
  it("edit/push/retry from a plan-less second user affect nothing of the first user's plan", async () => {
    await seedCatalog();
    const planId = await seedPlan();
    const pushId = await seedVerifiedPushRow(planId);

    const userB = await makeTestUser(db);
    const tokenB = await createSession(db, userB.userId);
    const asB = { Cookie: `${SESSION_COOKIE}=${tokenB}` };

    const editRes = await client().post("/api/studio/edit", { request: "hack it" }, asB);
    expect(editRes.status).toBe(404);
    expect((await editRes.json()) as { error: string }).toMatchObject({ error: "no_plan" });

    const pushRes = await client().post("/api/studio/push", undefined, asB);
    expect(pushRes.status).toBe(404);
    expect((await pushRes.json()) as { error: string }).toMatchObject({ error: "no_plan" });

    const retryRes = await client().post("/api/studio/push/retry", { happenDay: "2026-09-07" }, asB);
    expect(retryRes.status).toBe(404);
    expect((await retryRes.json()) as { error: string }).toMatchObject({ error: "no_plan" });

    // User A's plan and push row are untouched: same version, same status,
    // and no second plan or push row was created for anyone.
    const planRow = (await db.select().from(studioPlans).where(eq(studioPlans.id, planId)))[0]!;
    expect(planRow.version).toBe(1);
    const pushRow = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(pushRow.status).toBe("verified");
    expect(await db.select().from(studioPlans)).toHaveLength(1);
    expect(await db.select().from(studioPlanPushes)).toHaveLength(1);
  });
});
