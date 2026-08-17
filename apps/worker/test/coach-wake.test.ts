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
    const bad = {
      briefing: "Here's how I'd extend the block toward Oct 23…",
      proposals: [{ title: "Four more weeks", ops: [{ kind: "add" }, { kind: "add" }], nope: true }],
    };
    const { fetchImpl } = scriptedFetch([chatBody(bad), chatBody(bad)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "extend my plan" }, fetchImpl);
    expect(res.status).toBe("ok");
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.some((m) => m.role === "coach" && m.body.startsWith("Here's how I'd extend"))).toBe(true);
    // The receipt must NAME what was lost (2026-08-16). "Couldn't be
    // formatted" left the athlete believing the prose was a plan.
    const receipt = msgs.find((m) => m.role === "receipt")!;
    expect(receipt.body).toContain("Four more weeks");
    expect(receipt.body).toContain("2 adds");
    expect(receipt.body).toContain("Nothing was applied");
  });

  it("a proposal dropped by the guardrails says so too — same mechanism as salvage", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Rewriting an imported plan's structure is a hard guardrail violation
    // (H7); the repair round-trip returns the same thing, so the proposal is
    // filtered out entirely and — before this — vanished without a word.
    const bad = {
      briefing: "Rebuilding next week from scratch.",
      proposals: [
        {
          title: "Rebuild next week",
          evidence: "e",
          rationale: "r",
          expiresAt: "2026-01-02",
          flags: [],
          ops: [{ kind: "reshapeWeek", planId: "an-imported-plan", weekStart: "2026-01-05", sessions: [] }],
        },
      ],
      question: null,
      memoryOps: [],
      focus: null,
    };
    const { fetchImpl } = scriptedFetch([chatBody(bad), chatBody(bad)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "rebuild next week" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.proposalIds ?? []).toHaveLength(0);
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    const receipt = msgs.find((m) => m.role === "receipt" && m.body.includes("Rebuild next week"));
    expect(receipt, "a dropped proposal must leave a receipt naming it").toBeTruthy();
    expect(receipt!.body).toContain("Nothing was applied");
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

describe("model-natural JSON parses (live createPlan failures 2026-08-12/13)", () => {
  it("null optionals, prose-length volumeTarget, and null intensity all parse", async () => {
    const { wakeOutputSchema } = await import("@rg/domain");
    const modelOutput = {
      briefing: "Here it is as a real proposal this time.",
      proposals: [
        {
          title: "4-week post-race block",
          evidence: "race 2026-10-23",
          rationale: "Recovery first, then rebuild.",
          expiresAt: "2026-10-25",
          flags: [],
          ops: [
            {
              kind: "createPlan",
              discipline: "run",
              name: "Post-race recovery",
              startDate: "2026-10-24",
              endDate: "2026-11-20",
              raceDate: null, // models emit null for optionals — must parse
              firmSessions: [
                {
                  date: "2026-10-26",
                  session: {
                    category: "recovery",
                    title: "Legs-back jog",
                    durationMinutes: 25,
                    run: { blocks: [{ kind: "duration", value: 25, intensity: null }] },
                    lift: null,
                  },
                },
              ],
              shapeWeeks: [
                {
                  weekStart: "2026-11-02",
                  // 53 chars — the reject that killed three drafts
                  volumeTarget: "one quality session returns, keep it conversational",
                  keySessions: ["one relaxed long run building back toward ninety minutes total"],
                },
              ],
            },
          ],
        },
      ],
      question: null,
      memoryOps: [],
      focus: null,
    };
    const parsed = wakeOutputSchema.safeParse(modelOutput);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
    const op = parsed.data!.proposals[0]!.ops[0]! as { shapeWeeks: Array<{ volumeTarget: string }> };
    expect(op.shapeWeeks[0]!.volumeTarget.length).toBeLessThanOrEqual(40); // truncated, not rejected
  });

  it("the createPlan prompt example parses too (drift guard)", async () => {
    const { WAKE_EXAMPLE_CREATE_PLAN, WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    expect(WAKE_SYSTEM_PROMPT).toContain(WAKE_EXAMPLE_CREATE_PLAN);
    expect(wakeOutputSchema.safeParse(JSON.parse(WAKE_EXAMPLE_CREATE_PLAN)).success).toBe(true);
  });

  it("the LIFT prompt example parses too — the op kind that had no example (2026-08-16)", async () => {
    const { WAKE_EXAMPLE_LIFT, WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    expect(WAKE_SYSTEM_PROMPT).toContain(WAKE_EXAMPLE_LIFT);
    const parsed = wakeOutputSchema.safeParse(JSON.parse(WAKE_EXAMPLE_LIFT));
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
    // The example must actually exercise the two prescriptions the old
    // vocabulary could not express, or it guards nothing.
    const ops = parsed.data!.proposals[0]!.ops as Array<{ session: { lift?: { rounds?: number; exercises: Array<Record<string, unknown>> } } }>;
    const all = ops.flatMap((o) => o.session.lift?.exercises ?? []);
    expect(all.some((e) => typeof e.holdSeconds === "number")).toBe(true);
    expect(all.some((e) => typeof e.eccentricSeconds === "number")).toBe(true);
    expect(all.some((e) => e.perSide === true)).toBe(true);
    expect(ops.some((o) => typeof o.session.lift?.rounds === "number")).toBe(true);
  });

  /**
   * The live 2026-08-16 reject, byte for byte from `coach_messages.refs
   * .schemaIssues`: three exercises rejected for missing originId, weight
   * and restSeconds — on a WALL SIT, where none of the three is knowable.
   */
  it("the exact live ski-prep session that was dropped now parses", async () => {
    const { wakeOutputSchema } = await import("@rg/domain");
    const modelOutput = {
      briefing: "Three real leg sessions plus a 12-minute filler on run days.",
      proposals: [
        {
          title: "Ski-prep block",
          evidence: "ski trip 2026-08-26",
          rationale: "Quads, single-leg control and eccentric strength.",
          expiresAt: "2026-08-18",
          flags: [],
          ops: [
            {
              kind: "add",
              date: "2026-08-18",
              session: {
                category: "strength",
                title: "Ski legs",
                durationMinutes: 45,
                lift: {
                  exercises: [
                    { name: "Wall sit", sets: 3, holdSeconds: 45 },
                    { name: "Goblet squat", sets: 4, reps: 10, weight: 20, eccentricSeconds: 4 },
                    { name: "Bulgarian split squat", sets: 3, reps: 8, perSide: true },
                  ],
                },
              },
            },
          ],
        },
      ],
      question: null,
      memoryOps: [],
      focus: null,
    };
    const parsed = wakeOutputSchema.safeParse(modelOutput);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
    const ex = (parsed.data!.proposals[0]!.ops[0]! as { session: { lift: { exercises: Array<Record<string, unknown>> } } }).session.lift.exercises;
    // A hold is a hold — never faked as reps.
    expect(ex[0]).toMatchObject({ name: "Wall sit", sets: 3, holdSeconds: 45 });
    expect(ex[0]!.reps).toBeUndefined();
    // Defaults fill what a coach doesn't know: bodyweight, 60s rest.
    expect(ex[0]!.weight).toEqual({ type: "bodyweight" });
    expect(ex[0]!.restSeconds).toBe(60);
    // A bare number means kilos.
    expect(ex[1]!.weight).toEqual({ type: "kg", value: 20 });
    expect(ex[2]).toMatchObject({ perSide: true, reps: 8 });
    // originId is never the model's job.
    expect(ex.every((e) => e.originId === undefined)).toBe(true);
  });

  it("a session with no work at all is still rejected — the vocabulary is loose, not absent", async () => {
    const { coachExerciseSchema } = await import("@rg/domain");
    expect(coachExerciseSchema.safeParse({ name: "Wall sit", sets: 3 }).success).toBe(false);
    expect(coachExerciseSchema.safeParse({ name: "Wall sit", sets: 3, holdSeconds: 45 }).success).toBe(true);
  });

  it("model-natural value forms: string numbers, prose weights, and a mobility body", async () => {
    const { coachExerciseSchema, coachSessionSchema, sessionSport } = await import("@rg/domain");
    const a = coachExerciseSchema.parse({ name: "Plank", sets: "3", holdSeconds: "45s", weight: "bodyweight" });
    expect(a).toMatchObject({ sets: 3, holdSeconds: 45, weight: { type: "bodyweight" } });
    const b = coachExerciseSchema.parse({ name: "Goblet squat", sets: 4, reps: 10, weight: "45 lb" });
    expect(b.weight).toEqual({ type: "kg", value: 20.4 });
    // The third discipline body: a mobility session must NOT be a run.
    const yoga = coachSessionSchema.parse({
      category: "yoga",
      title: "Hip and ankle mobility",
      durationMinutes: 20,
      mobility: { exercises: [{ name: "Couch stretch", sets: 2, holdSeconds: 60, perSide: true }] },
    });
    expect(sessionSport(yoga)).toBe("yoga");
    expect(sessionSport(coachSessionSchema.parse({ category: "easy", title: "Jog", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30 }] } }))).toBe("run");
  });
});

/**
 * The prompt is code. Its content is the thing that decides what the coach
 * says, and until 2026-08-16 nothing in this repo asserted a single word of
 * it — which is how fourteen bullets of format and permissions, with one
 * line of physiology between them, survived to answer "get me ready to ski".
 */
describe("the wake prompt (2026-08-16 rewrite)", () => {
  it("leads with the honesty rule: prose may only describe ops that exist", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    const honesty = WAKE_SYSTEM_PROMPT.indexOf("HONESTY");
    expect(honesty).toBeGreaterThan(-1);
    // Before the contract, the voice rules, everything.
    expect(honesty).toBeLessThan(WAKE_SYSTEM_PROMPT.indexOf("Your contract:"));
    expect(WAKE_SYSTEM_PROMPT).toContain("ONLY changes that exist in THIS reply's ops");
    expect(WAKE_SYSTEM_PROMPT).toContain("offer to draft");
  });

  it("carries the programming vocabulary the coach had none of", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    // The audit's own grep: `isometric` 0 hits in source, `eccentric` 1 (a
    // test), `detrain` 0 — while the STUDIO prompt got a certified-strength-
    // coach persona. The thing the athlete talks to got none of it.
    for (const word of [
      "eccentric",
      "isometric",
      "concentric",
      "elastic",
      "tissue",
      "detrain",
      "taper",
      "rest day",
      "BOUTS, NOT DAYS",
    ]) {
      expect(WAKE_SYSTEM_PROMPT.toLowerCase(), `prompt must mention "${word}"`).toContain(word.toLowerCase());
    }
  });

  it("a request to plan clears the brevity bar, and the detail belongs in the rationale", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    expect(WAKE_SYSTEM_PROMPT).toContain("A request to plan IS a request for detail");
    expect(WAKE_SYSTEM_PROMPT).toContain("give it in the proposal's rationale");
    // RESTRAINT must no longer read as "answer a planning request with a summary".
    expect(WAKE_SYSTEM_PROMPT).toContain("RESTRAINT IS A COMPLETE ANSWER — until they ask");
  });

  it("every op kind the prompt advertises has a drift-tested example", async () => {
    const {
      WAKE_EXAMPLE_OUTPUT,
      WAKE_EXAMPLE_CREATE_PLAN,
      WAKE_EXAMPLE_LIFT,
      WAKE_EXAMPLE_OPS,
      WAKE_SYSTEM_PROMPT,
    } = await import("../src/services/coach-wake.js");
    const { coachOpSchema } = await import("@rg/domain");
    expect(WAKE_SYSTEM_PROMPT).toContain(WAKE_EXAMPLE_OPS);

    const refOps = JSON.parse(WAKE_EXAMPLE_OPS) as Array<{ kind: string }>;
    for (const op of refOps) {
      const parsed = coachOpSchema.safeParse(op);
      if (!parsed.success) console.error(op.kind, parsed.error.issues);
      expect(parsed.success, `reference op "${op.kind}" must parse`).toBe(true);
    }

    const shown = new Set(refOps.map((o) => o.kind));
    for (const ex of [WAKE_EXAMPLE_OUTPUT, WAKE_EXAMPLE_CREATE_PLAN, WAKE_EXAMPLE_LIFT]) {
      for (const p of JSON.parse(ex).proposals as Array<{ ops: Array<{ kind: string }> }>) {
        for (const o of p.ops) shown.add(o.kind);
      }
    }
    const advertised = (
      coachOpSchema.options as Array<{ shape: { kind: { value: string } } }>
    ).map((o) => o.shape.kind.value);
    expect(advertised.filter((k) => !shown.has(k)), "op kinds with no example to copy").toEqual([]);
  });

  it("the lift example's briefing describes exactly the sessions its ops contain", async () => {
    const { WAKE_EXAMPLE_LIFT } = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    const out = wakeOutputSchema.parse(JSON.parse(WAKE_EXAMPLE_LIFT));
    const ops = out.proposals[0]!.ops;
    // The example the model copies its voice from must itself obey the
    // honesty rule — the previous one narrated "two ski-prep leg sessions"
    // over a single leg session, which is the failure in miniature.
    const legSessions = ops.filter(
      (o) => o.kind === "add" && o.session.category === "strength" && o.session.durationMinutes >= 30,
    );
    expect(legSessions).toHaveLength(2);
    expect(out.briefing).toContain("two real leg sessions");
    // …and the compensatory work it mentions is a scheduled session, not advice.
    expect(ops.some((o) => o.kind === "add" && o.session.mobility)).toBe(true);
    // …and the budget it spends is paid for by an op that takes something out.
    expect(ops.some((o) => o.kind === "ease")).toBe(true);
    // …and the dated event it plans around is written to memory with an ISO date.
    expect(out.memoryOps.some((m) => m.op === "add" && /\d{4}-\d{2}-\d{2}/.test(m.text))).toBe(true);
  });
});
