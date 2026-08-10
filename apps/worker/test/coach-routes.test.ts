/**
 * Coach HTTP surface (Plan A Tasks A7+A9): state read with inline expiry
 * sweep, one-tap approve/decline with 409s on anything stale, memory CRUD
 * honored by the next dossier, question answers becoming memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { buildDossier } from "../src/services/coach-context.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

function client() {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
    post: (path: string, body?: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        makeEnv(),
      ),
    del: (path: string) =>
      app.request(path, { method: "DELETE", headers: { Cookie: cookie } }, makeEnv()),
  };
}

const RESTRAINT = JSON.stringify({ briefing: null, proposals: [], question: null, memoryOps: [] });

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedProposal(id: string, expiresAt: string, status = "pending") {
  await db.insert(schema.coachProposals).values({
    id,
    userId,
    title: "Ease tomorrow",
    evidence: "slept 5h",
    rationale: "r",
    flags: [],
    ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
    status,
    createdAt: nowInstant(),
    expiresAt,
  });
}

describe("coach routes", () => {
  it("state returns thread, tray, question, memory count — and sweeps expired proposals inline", async () => {
    const today = todayInZone(prefs.timezone);
    await seedProposal("p-live", addDays(today, 1));
    await seedProposal("p-stale", addDays(today, -1));
    const res = await client().get("/api/coach/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pendingProposals: Array<{ id: string }>;
      wakeAdvised: boolean;
      messages: Array<{ role: string; body: string }>;
    };
    expect(body.pendingProposals.map((p) => p.id)).toEqual(["p-live"]);
    expect(body.wakeAdvised).toBe(true); // no coach message yet → stale briefing
    expect(body.messages.some((m) => m.role === "receipt" && m.body.includes("Expired"))).toBe(true);
    const [stale] = await db
      .select()
      .from(schema.coachProposals)
      .where(eq(schema.coachProposals.id, "p-stale"));
    expect(stale!.status).toBe("expired");
  });

  it("audit C4/C14: a recent wake failure backs wakeAdvised off (not true forever)", async () => {
    // A recent failure receipt (as coach-wake.ts writes on a gateway error)
    // means "already tried" — with no open trigger, wakeAdvised should be
    // false, not true on every single visit while the LLM is down.
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body: "The coach couldn't think just now — try again in a moment.",
      refs: { wakeFailure: true },
      at: nowInstant(),
    });
    const body = (await (await client().get("/api/coach/state")).json()) as { wakeAdvised: boolean };
    expect(body.wakeAdvised).toBe(false);
  });

  it("audit C4/C14: wakeAdvised clears back to true once a failure ages past the backoff window", async () => {
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body: "The coach couldn't think just now — try again in a moment.",
      refs: { wakeFailure: true },
      at: new Date(Date.now() - 40 * 60_000).toISOString(), // > 30-min backoff
    });
    const body = (await (await client().get("/api/coach/state")).json()) as { wakeAdvised: boolean };
    expect(body.wakeAdvised).toBe(true);
  });

  it("approve applies ops, writes the receipt, and 409s a second tap", async () => {
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.plannedWorkouts).values({
      id: "w1",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:w1",
      title: "Tempo",
      category: "quality",
      sport: "run",
      originalPlanDate: addDays(today, 1),
      lastVerifiedCorosDate: addDays(today, 1),
      effectiveDate: addDays(today, 1),
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await seedProposal("p1", addDays(today, 1));
    const first = await client().post("/api/coach/proposals/p1/approve");
    expect(first.status).toBe(200);
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.completionState).toBe("skipped");
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "receipt" && m.body.startsWith("✓ approved"))).toBe(true);

    const second = await client().post("/api/coach/proposals/p1/approve");
    expect(second.status).toBe(409);
  });

  it("decline retires the proposal without touching the plan", async () => {
    const today = todayInZone(prefs.timezone);
    await seedProposal("p1", addDays(today, 1));
    const res = await client().post("/api/coach/proposals/p1/decline");
    expect(res.status).toBe(200);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, "p1"));
    expect(p!.status).toBe("declined");
  });

  it("memory CRUD: deletion is honored by the next dossier", async () => {
    await db.insert(schema.coachMemory).values({
      id: "m1",
      userId,
      kind: "fact",
      body: "Prefers mornings",
      provenance: { source: "message", at: nowInstant() },
      learnedAt: nowInstant(),
      active: true,
    });
    const list = await client().get("/api/coach/memory");
    expect(((await list.json()) as { memory: unknown[] }).memory).toHaveLength(1);

    const del = await client().del("/api/coach/memory/m1");
    expect(del.status).toBe(200);
    const after = await client().get("/api/coach/memory");
    expect(((await after.json()) as { memory: unknown[] }).memory).toHaveLength(0);
    const dossier = await buildDossier(db, userId, prefs);
    expect(dossier.text).not.toContain("Prefers mornings");
  });

  it("answering a question writes memory, closes it, and wakes the coach", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: RESTRAINT }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );
    await db.insert(schema.coachQuestions).values({
      id: "q1",
      userId,
      body: "Finish strong or chase a time?",
      chips: ["Finish strong", "Sub 1:45"],
      askedAt: nowInstant(),
    });
    const res = await client().post("/api/coach/questions/q1/answer", { answer: "Sub 1:45" });
    expect(res.status).toBe(200);
    const [q] = await db.select().from(schema.coachQuestions).where(eq(schema.coachQuestions.id, "q1"));
    expect(q!.answeredAt).not.toBeNull();
    const mem = await db
      .select()
      .from(schema.coachMemory)
      .where(and(eq(schema.coachMemory.userId, userId), eq(schema.coachMemory.active, true)));
    expect(mem.some((m) => m.body.includes("Sub 1:45"))).toBe(true);
    // The user's answer rode a wake as a message.
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "user" && m.body === "Sub 1:45")).toBe(true);
  });

  it("message rejects junk and plans list/rename/retire round-trip", async () => {
    expect((await client().post("/api/coach/message", {})).status).toBe(400);

    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: "2026-08-01",
      endDate: "2026-10-11",
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const rename = await client().post("/api/coach/plans/cp1/rename", { name: "Autumn Half" });
    expect(rename.status).toBe(200);
    const retire = await client().post("/api/coach/plans/cp1/retire");
    expect(retire.status).toBe(200);
    const plans = (await (await client().get("/api/coach/plans")).json()) as {
      plans: Array<{ name: string; status: string }>;
    };
    expect(plans.plans[0]).toMatchObject({ name: "Autumn Half", status: "retired" });
  });
});
