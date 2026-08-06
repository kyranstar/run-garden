/**
 * Wake pipeline (Plan A Task A6, spec §§0,3,4): budget gate, skip rule,
 * schema repair, guardrail rejection, supersede, restraint, and the rule
 * that the athlete's words are persisted before anything can fail.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { wake } from "../src/services/coach-wake.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import type { Env } from "../src/env.js";

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

function chatBody(content: unknown): unknown {
  return {
    choices: [
      {
        message: { content: typeof content === "string" ? content : JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 400 },
  };
}

function scriptedFetch(bodies: unknown[]): { fetchImpl: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const fetchImpl = (async () => {
    calls.push(i);
    const body = bodies[i++];
    if (body === undefined) throw new Error("no more scripted responses");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const RESTRAINT = { briefing: null, proposals: [], question: null, memoryOps: [] };

async function seedWorkout(db: Db, userId: string, date: string, id = "w1") {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Tempo 3×10",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("wake", () => {
  it("message wake: persists the user message, coach briefing, proposal, and memory", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const tomorrow = addDays(today, 1);
    await seedWorkout(db, userId, tomorrow);

    const output = {
      briefing: "Rough sleep — I'd ease tomorrow.",
      proposals: [
        {
          title: "Ease tomorrow",
          evidence: "slept 5h avg",
          rationale: "Three short nights before quality work.",
          expiresAt: tomorrow,
          flags: [],
          ops: [
            {
              kind: "ease",
              workoutId: "w1",
              session: {
                category: "easy",
                title: "Steady 40 Z2",
                durationMinutes: 40,
                run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
              },
            },
          ],
        },
      ],
      question: null,
      memoryOps: [{ op: "add", kind: "note", text: "calves tight", expiresAt: addDays(today, 10) }],
    };
    const { fetchImpl } = scriptedFetch([chatBody(output)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "calves are tight" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.proposalIds).toHaveLength(1);

    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "user" && m.body === "calves are tight")).toBe(true);
    expect(msgs.some((m) => m.role === "coach")).toBe(true);
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props).toHaveLength(1);
    expect(props[0]!.status).toBe("pending");
    const mem = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.userId, userId));
    expect(mem.some((m) => m.body === "calves tight" && m.kind === "note")).toBe(true);
  });

  it("open wake with no triggers and a fresh briefing skips the LLM entirely", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "fresh briefing",
      refs: {},
      at: nowInstant(),
    });
    const { fetchImpl, calls } = scriptedFetch([]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(res.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("budget cutoff rests honestly and still keeps the user's message", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 25_000_000,
      cacheHit: false,
      requestFingerprint: "f",
      createdAt: nowInstant(),
    });
    const { fetchImpl, calls } = scriptedFetch([]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "hello?" }, fetchImpl);
    expect(res.status).toBe("resting");
    expect(calls).toHaveLength(0);
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "user" && m.body === "hello?")).toBe(true);
    expect(msgs.some((m) => m.role === "receipt" && m.body.includes("resting"))).toBe(true);
  });

  it("restraint: an all-empty output only consumes triggers", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.coachTriggers).values({
      id: "t1",
      userId,
      kind: "missed_workout",
      evidence: {},
      firedAt: nowInstant(),
    });
    const { fetchImpl } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.proposalIds).toHaveLength(0);
    const [t] = await db.select().from(schema.coachTriggers).where(eq(schema.coachTriggers.id, "t1"));
    expect(t!.consumedAt).not.toBeNull();
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.filter((m) => m.role === "coach")).toHaveLength(0);
  });

  it("hard violations: repair keeps trying, unrepaired proposals are dropped", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // A completed workout — easing it violates touch_resolved.
    await seedWorkout(db, userId, addDays(today, 1), "w-done");
    await db
      .update(schema.plannedWorkouts)
      .set({ completionState: "completed" })
      .where(eq(schema.plannedWorkouts.id, "w-done"));

    const bad = {
      briefing: "Trying something illegal.",
      proposals: [
        {
          title: "Rewrite the past",
          evidence: "none",
          rationale: "should be rejected",
          expiresAt: addDays(today, 1),
          flags: [],
          ops: [
            {
              kind: "ease",
              workoutId: "w-done",
              session: { category: "easy", title: "x", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30 }] } },
            },
          ],
        },
      ],
      question: null,
      memoryOps: [],
    };
    // Model returns the same bad output on the repair attempt too.
    const { fetchImpl } = scriptedFetch([chatBody(bad), chatBody(bad)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "do it" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.proposalIds).toHaveLength(0);
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props).toHaveLength(0);
  });

  it("supersede: a new proposal touching the same day retires the old one", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const tomorrow = addDays(today, 1);
    await seedWorkout(db, userId, tomorrow);
    await db.insert(schema.coachProposals).values({
      id: "old1",
      userId,
      title: "Old idea",
      evidence: "e",
      rationale: "r",
      flags: [],
      ops: [{ kind: "move", workoutId: "w1", toDate: addDays(today, 2) }],
      status: "pending",
      createdAt: nowInstant(),
      expiresAt: addDays(today, 2),
    });
    const output = {
      briefing: "Better idea.",
      proposals: [
        {
          title: "New idea",
          evidence: "e2",
          rationale: "r2",
          expiresAt: tomorrow,
          flags: [],
          ops: [
            {
              kind: "ease",
              workoutId: "w1",
              session: { category: "easy", title: "Steady 40", durationMinutes: 40, run: { blocks: [{ kind: "duration", value: 40 }] } },
            },
          ],
        },
      ],
      question: null,
      memoryOps: [],
    };
    const { fetchImpl } = scriptedFetch([chatBody(output)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease it instead" }, fetchImpl);
    expect(res.status).toBe("ok");
    const [old] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, "old1"));
    expect(old!.status).toBe("superseded");
    expect(old!.supersededBy).toBe(res.proposalIds![0]);
    const pending = await db
      .select()
      .from(schema.coachProposals)
      .where(and(eq(schema.coachProposals.userId, userId), eq(schema.coachProposals.status, "pending")));
    expect(pending).toHaveLength(1);
  });
});
