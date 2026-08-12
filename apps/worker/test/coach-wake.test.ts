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
import { openWakeIsFresh, wake } from "../src/services/coach-wake.js";
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

/** A gateway that always 400s — non-retryable, so chatCompletion returns
 * `{ok:false}` immediately with no in-place retry delay. */
function failingFetch(): { fetchImpl: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    calls.push(calls.length);
    return new Response("bad request", { status: 400 });
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

  it("manual check-in bypasses the skip rule (fresh briefing + no triggers still wakes)", async () => {
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
    const { fetchImpl, calls } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
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

  it("audit C4/C14: repeated failed 'Check in' taps dedupe into one receipt, not a stack", { timeout: 20_000 }, async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { fetchImpl } = failingFetch();

    const first = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(first.status).toBe("error");
    const second = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(second.status).toBe("error"); // manual bypasses the skip rule — still attempts
    const third = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(third.status).toBe("error");

    const receipts = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
    expect(receipts).toHaveLength(1); // three identical failures, one row
    expect(receipts[0]!.body).toBe("The coach couldn't think just now — try again in a moment.");
  });

  it("audit C4/C14: an 'open' wake backs off after a recent failure instead of re-calling the LLM every visit", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { fetchImpl, calls } = failingFetch();

    const first = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(first.status).toBe("error");
    // The transport retry (2026-08-12) makes one failed wake two calls.
    expect(calls).toHaveLength(2);

    // A second "open" (auto-wake on the next Plan visit) is redundant: the
    // failure is still fresh, so it's skipped without touching the LLM or
    // appending another receipt.
    const second = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(second.status).toBe("skipped");
    expect(calls).toHaveLength(2);

    const receipts = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
    expect(receipts).toHaveLength(1);
  });

  it("audit C14 residual: a recent wake failure suppresses an 'open' wake even with a pending trigger", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // A pending trigger that never got consumed — consumeTriggers only runs
    // on a SUCCESSFUL wake, so it stays pending through every failure.
    // Before this fix its mere presence forced every "open" wake to attempt
    // the LLM regardless of the failure backoff — the exact audited harm
    // (a missed-workout trigger during an outage burning a call on every
    // single Plan visit).
    await db.insert(schema.coachTriggers).values({
      id: "t1",
      userId,
      kind: "missed_workout",
      evidence: {},
      firedAt: nowInstant(),
    });
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body: "The coach couldn't think just now — try again in a moment.",
      refs: { wakeFailure: true },
      at: nowInstant(),
    });
    const { fetchImpl, calls } = failingFetch();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(res.status).toBe("skipped");
    expect(calls).toHaveLength(0); // no LLM call at all
    // The trigger itself is untouched — still pending for the next real
    // (successful, or backoff-expired) attempt.
    const [t] = await db.select().from(schema.coachTriggers).where(eq(schema.coachTriggers.id, "t1"));
    expect(t!.consumedAt).toBeNull();
  });

  it("audit C14 residual: manual 'Check in' still bypasses the backoff even with a pending trigger", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.coachTriggers).values({
      id: "t1",
      userId,
      kind: "missed_workout",
      evidence: {},
      firedAt: nowInstant(),
    });
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body: "The coach couldn't think just now — try again in a moment.",
      refs: { wakeFailure: true },
      at: nowInstant(),
    });
    const { fetchImpl, calls } = failingFetch();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("error"); // attempted (and failed again) — not skipped
    expect(calls).toHaveLength(2); // incl. the transport retry
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

describe("prompt carries the garden-loop guidance (fairness spec §3)", () => {
  it("includes garden voice and skip-treatment rules", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    expect(WAKE_SYSTEM_PROMPT).toContain("GARDEN VOICE");
    expect(WAKE_SYSTEM_PROMPT).toContain("one loss voice at a time");
    expect(WAKE_SYSTEM_PROMPT).toContain("SKIP TREATMENT");
  });
});

describe("single-flight + focus (2026-08-11 rework §R2/§3)", () => {
  const EMPTY_WAKE = { briefing: "Quiet week — steady as she goes.", proposals: [], question: null, memoryOps: [] };

  function delayedFetch(body: unknown, delayMs: number): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("two concurrent manual wakes make exactly one LLM call", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { fetchImpl, calls } = delayedFetch(chatBody(EMPTY_WAKE), 40);
    const [a, b] = await Promise.all([
      wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl),
      wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl),
    ]);
    expect(calls()).toBe(1);
    expect([a.status, b.status].sort()).toEqual(["ok", "skipped"]);
    // The lock is released after the wake completes.
    const locks = await db.select().from(schema.coachLocks).where(eq(schema.coachLocks.userId, userId));
    expect(locks).toHaveLength(0);
  });

  it("a stale lock (crashed wake) is taken over", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await db.insert(schema.coachLocks).values({ userId, kind: "wake", token: "dead", claimedAt: staleAt });
    const { fetchImpl, calls } = delayedFetch(chatBody(EMPTY_WAKE), 5);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(calls()).toBe(1);
  });

  it("persists the focus line on the briefing message refs", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { fetchImpl } = delayedFetch(
      chatBody({ ...EMPTY_WAKE, focus: "Saturday's long run anchors the week." }),
      5,
    );
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("ok");
    const [msg] = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
    expect((msg!.refs as { focus?: string }).focus).toBe("Saturday's long run anchors the week.");
  });

  it("an analysis-kind coach message does not count as a fresh briefing", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "legacy per-effort analysis",
      refs: { kind: "analysis", activityId: "a1" },
      at: nowInstant(),
    });
    // No triggers pending, only the analysis row exists → an open wake is NOT
    // redundant (the athlete has never been briefed).
    expect(await openWakeIsFresh(db, userId, 0)).toBe(false);
  });
});

describe("question lifecycle (audit finding 9)", () => {
  it("a message-cause wake closes the open question — free-text answers count", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.coachQuestions).values({
      id: "q1",
      userId,
      body: "Roughly how far out is race day?",
      chips: ["Within 4 weeks", "6-8 weeks"],
      askedAt: nowInstant(),
    });
    const { fetchImpl } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "around oct 23" }, fetchImpl);
    expect(res.status).toBe("ok");
    const [q] = await db.select().from(schema.coachQuestions).where(eq(schema.coachQuestions.id, "q1"));
    expect(q!.answeredAt).not.toBeNull();
  });
});

describe("wake resilience (user requirement 2026-08-12: never error, survive navigation)", () => {
  it("double schema failure SALVAGES the briefing prose instead of erroring", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Both attempts return JSON whose briefing is fine but whose proposals
    // are malformed — the live plan-extension failure shape.
    const bad = { briefing: "Here's how I'd extend the block toward Oct 23…", proposals: [{ nope: true }] };
    const { fetchImpl } = scriptedFetch([chatBody(bad), chatBody(bad)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "extend my plan" }, fetchImpl);
    expect(res.status).toBe("ok");
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "coach" && m.body.startsWith("Here's how I'd extend"))).toBe(true);
    expect(msgs.some((m) => m.role === "receipt" && m.body.includes("couldn't be formatted"))).toBe(true);
  });

  it("a message wake that dies leaves an unanswered_message marker; the next open wake answers and consumes it", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // The gateway hard-fails (and the transport retry too) — simulating a
    // request killed mid-flight as far as durability is concerned.
    const dead = failingFetch();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "extend my plan" }, dead.fetchImpl);
    expect(res.status).toBe("error");
    let pending = await db
      .select()
      .from(schema.coachTriggers)
      .where(eq(schema.coachTriggers.kind, "unanswered_message"));
    expect(pending.filter((t) => t.consumedAt === null)).toHaveLength(1);

    // Clear the failure-backoff receipt so the recovery open isn't skipped
    // (a request that died silently writes no receipt at all).
    await db.delete(schema.coachMessages).where(eq(schema.coachMessages.role, "receipt"));

    const good = scriptedFetch([chatBody({ ...RESTRAINT, briefing: "About extending your plan — here's my take." })]);
    const recovery = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, good.fetchImpl);
    expect(recovery.status).toBe("ok");
    pending = await db
      .select()
      .from(schema.coachTriggers)
      .where(eq(schema.coachTriggers.kind, "unanswered_message"));
    expect(pending.filter((t) => t.consumedAt === null)).toHaveLength(0);
  });

  it("a successful message wake consumes its own marker — no ghost signals", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { fetchImpl } = scriptedFetch([chatBody({ ...RESTRAINT, briefing: "Sure." })]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "hi" }, fetchImpl);
    expect(res.status).toBe("ok");
    const pending = await db
      .select()
      .from(schema.coachTriggers)
      .where(eq(schema.coachTriggers.kind, "unanswered_message"));
    expect(pending.filter((t) => t.consumedAt === null)).toHaveLength(0);
  });
});

describe("capability plumbing (user requirement 2026-08-12: the coach can fulfil plan requests)", () => {
  it("the prompt's example output parses against the real wake schema — prompt and schema cannot drift", async () => {
    const { WAKE_EXAMPLE_OUTPUT, WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    expect(WAKE_SYSTEM_PROMPT).toContain(WAKE_EXAMPLE_OUTPUT);
    const parsed = wakeOutputSchema.safeParse(JSON.parse(WAKE_EXAMPLE_OUTPUT));
    expect(parsed.success).toBe(true);
    // The contract never claims read-only plans.
    expect(WAKE_SYSTEM_PROMPT).not.toContain("off-limits");
  });
});
