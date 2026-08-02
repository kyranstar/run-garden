/**
 * Plan Studio API routes (plan-studio-design §7, task-5-brief.md).
 *
 * FIXTURE_MODE=1 stands in for "stubbed studio-llm" here: studio-llm.ts's own
 * fixture path (buildFixturePlan / editPlan's canned "(edited)" rename) is
 * already deterministic and network-free — proven out by studio-llm.test.ts's
 * own fetchImpl-DI suite (Task 4). Re-stubbing fetchImpl a second time at the
 * route layer would need new route-only plumbing no real caller would ever
 * use (studio-llm.ts's own doc comment: "every real caller omits it"); the
 * repo already ships a designed-for-this-purpose seam (spec §8: "so the full
 * Studio UI works in fixture mode, is screenshot-testable"), so route tests
 * ride that instead of inventing a second one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, startOfIsoWeek, todayInZone, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { corosExercises, corosWriteJobs, llmUsage, studioPlanPushes, studioPlans } = schema;

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
  };
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
});

describe("POST /api/studio/generate", () => {
  it("rejects a malformed brief", async () => {
    const res = await client().post("/api/studio/generate", { brief: { goal: "strength" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
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
      costMicros: 9_000_000, // over LLM_BUDGET.cutoffMicros ($8)
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
