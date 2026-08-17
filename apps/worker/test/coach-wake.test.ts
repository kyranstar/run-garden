/**
 * Wake pipeline (Plan A Task A6, spec §§0,3,4): budget gate, skip rule,
 * schema repair, guardrail rejection, supersede, restraint, and the rule
 * that the athlete's words are persisted before anything can fail.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { openWakeIsFresh, wake, WAKE_LOCK_STALE_MINUTES } from "../src/services/coach-wake.js";
import { claimUserLock, touchUserLock } from "../src/services/locks.js";
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

/**
 * THE PHANTOM CALENDAR (live, 2026-08-16 — the ski-prep rejection).
 *
 * `guardrailCtx` was the only read of `planned_workouts` in the coach path
 * without an `archivedAt` filter, so the validator judged proposals against
 * sessions COROS had dropped (`absence_confirmed`) and dedupe copies of live
 * rows (`duplicate_mirror`). Prod, week of Mon 17 Aug: Tuesday held one real
 * 75-minute easy run and three archived phantoms — a 60-minute quality run
 * and two 56-minute lifts — and Wednesday's single 56-minute lift existed
 * three times over.
 *
 * The athlete's plan was rejected twice on that evidence: "hard days back to
 * back on Mon 17 Aug and Tue 18 Aug" against a day that is an easy run, and
 * "313 minutes" of strength (280 phantom + the 33 the coach actually
 * proposed) against a 120-minute cold-start ceiling. Neither was fixable by
 * the model: the dossier filters archived rows, so those sessions have no
 * [wo:id] it could ease, skip, or so much as name.
 */
describe("the guardrail calendar is the athlete's calendar", () => {
  const seedRow = async (
    db: Db,
    userId: string,
    row: {
      id: string;
      date: string;
      category: string;
      sport: string;
      minutes: number;
      archiveReason?: string;
    },
  ) => {
    await db.insert(schema.plannedWorkouts).values({
      id: row.id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${row.id}`,
      title: row.category,
      category: row.category,
      sport: row.sport,
      originalPlanDate: row.date,
      lastVerifiedCorosDate: row.date,
      effectiveDate: row.date,
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: `fp-${row.id}`,
      calendarBlockDurationSeconds: row.minutes * 60,
      archivedAt: row.archiveReason ? nowInstant() : null,
      archiveReason: row.archiveReason ?? null,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
  };

  it("excludes archived rows — the sessions the coach cannot see cannot reject it", async () => {
    const { guardrailCtx } = await import("../src/services/coach-wake.js");
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const tue = addDays(today, 2);
    const wed = addDays(today, 3);
    // Tuesday as prod holds it: one live easy run, three phantoms.
    await seedRow(db, userId, { id: "tue-live", date: tue, category: "easy", sport: "run", minutes: 75 });
    await seedRow(db, userId, { id: "tue-gone", date: tue, category: "quality", sport: "run", minutes: 60, archiveReason: "absence_confirmed" });
    await seedRow(db, userId, { id: "tue-gone2", date: tue, category: "easy", sport: "run", minutes: 75, archiveReason: "absence_confirmed" });
    await seedRow(db, userId, { id: "tue-lift-gone", date: tue, category: "strength", sport: "strength", minutes: 56, archiveReason: "absence_confirmed" });
    await seedRow(db, userId, { id: "tue-lift-mirror", date: tue, category: "strength", sport: "strength", minutes: 56, archiveReason: "duplicate_mirror" });
    // Wednesday's one real lift, and its two dead copies.
    await seedRow(db, userId, { id: "wed-live", date: wed, category: "strength", sport: "strength", minutes: 56 });
    await seedRow(db, userId, { id: "wed-mirror", date: wed, category: "strength", sport: "strength", minutes: 56, archiveReason: "duplicate_mirror" });

    const ctx = await guardrailCtx(db, userId, prefs);
    expect(ctx.workouts.map((w) => w.id).sort()).toEqual(["tue-live", "wed-live"]);
    // Tuesday is an easy run and nothing else — not a hard day.
    expect(ctx.workouts.filter((w) => w.date === tue)).toHaveLength(1);
    // …and Wednesday's lift weighs 56 minutes, not 112.
    expect(
      ctx.workouts.filter((w) => w.date === wed).reduce((n, w) => n + w.durationMinutes, 0),
    ).toBe(56);
  });

  it("a proposal is not rejected for a conflict that exists only among archived rows", async () => {
    const { guardrailCtx } = await import("../src/services/coach-wake.js");
    const { validateOps } = await import("@rg/domain");
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const mon = addDays(today, 1);
    const tue = addDays(today, 2);
    await seedRow(db, userId, { id: "mon-600s", date: mon, category: "quality", sport: "run", minutes: 100 });
    await seedRow(db, userId, { id: "tue-live", date: tue, category: "easy", sport: "run", minutes: 75 });
    await seedRow(db, userId, { id: "tue-gone", date: tue, category: "quality", sport: "run", minutes: 60, archiveReason: "absence_confirmed" });

    // The live shape: ease Monday's intervals, put the ski-prep bout on that
    // same Monday. Tuesday is an easy run, so nothing is back to back.
    const ops = [
      {
        kind: "ease" as const,
        workoutId: "mon-600s",
        session: {
          category: "easy" as const,
          title: "Easy 35",
          durationMinutes: 35,
          run: { blocks: [{ kind: "duration" as const, value: 35, intensity: "easy" as const }] },
        },
      },
      {
        kind: "add" as const,
        date: mon,
        session: {
          category: "strength" as const,
          title: "Ski legs",
          durationMinutes: 33,
          lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45, restSeconds: 60, perSide: false, weight: { type: "bodyweight" as const } }] },
        },
      },
    ];
    const out = validateOps(ops, await guardrailCtx(db, userId, prefs));
    expect(out.hard, "the phantom Tuesday quality run must not reject this").toEqual([]);
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

  /**
   * The coach was being judged against numbers it could not see. The FLAGS
   * line named the KINDS of hard limit — "a first block in a discipline with
   * no recent history" — without a single figure, and the live ski-prep wake
   * proposed 313 minutes of strength against a 120-minute ceiling. The
   * receipt was the first mention of either number.
   *
   * The fix is derivation, not prose: the prompt's HARD LIMITS block IS the
   * validator's constants, interpolated. This test fails if anyone reverts to
   * typing a number into the prompt by hand.
   */
  it("states every enforced limit, in the validator's own numbers", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    const { HARD_LIMITS_PROMPT, GUARDRAIL_LIMITS } = await import("@rg/domain");
    // Not "contains these words" — contains the generated block verbatim.
    expect(WAKE_SYSTEM_PROMPT).toContain(HARD_LIMITS_PROMPT);
    for (const n of [
      GUARDRAIL_LIMITS.coldStartWeekMinutes,
      GUARDRAIL_LIMITS.hardLiftMinutes,
      GUARDRAIL_LIMITS.trivialLiftMinutes,
      GUARDRAIL_LIMITS.detrainedWeekMinutes,
      GUARDRAIL_LIMITS.eventTaperDays,
      GUARDRAIL_LIMITS.raceWindowDays,
    ]) {
      expect(WAKE_SYSTEM_PROMPT, `the model must be shown ${n}`).toContain(String(n));
    }
    expect(WAKE_SYSTEM_PROMPT).toContain(`${Math.round(GUARDRAIL_LIMITS.rampCap * 100)}%`);
    // Every rule `validateOps` can reject with is named up there — a limit
    // enforced but unstated is the whole bug.
    for (const phrase of ["HARD DAYS NEVER TOUCH", "RAMP", "COLD START", "REST DAY", "EVENT TAPER", "RACE WEEK", "THE PAST IS FIXED"]) {
      expect(WAKE_SYSTEM_PROMPT).toContain(phrase);
    }
    // And it points at where the remaining budget lives, which is the half
    // that cannot be written into a static prompt.
    expect(WAKE_SYSTEM_PROMPT).toContain("LIMITS section");
  });
});

/**
 * THE NEVER-LOSE-EVERYTHING INVARIANT (live failure, 2026-08-17).
 *
 * What happened in prod: one wake, two Opus calls (2m35s, then 3m27s),
 * 27,864 output tokens, $0.92 — and afterwards `coach_messages` held nothing
 * from that wake at all. No briefing, no proposal, and no receipt, because
 * the "couldn't think" receipt matched one written FOUR DAYS earlier and the
 * dedupe suppressed it. The athlete got a spinner and then silence, from a
 * request that had spent six minutes and a dollar thinking about them.
 *
 * Every test here fails on the code as it shipped. The rule they encode:
 * whatever the model does — a huge valid answer, a huge broken one, or a
 * second call that simply never comes back — the thread is never silent
 * afterwards, and a briefing that was already parsed is never thrown away
 * because a later step was slow or died.
 *
 * They are also the class of test that was missing entirely: 1,755 tests
 * passed against recorded model responses that were all small and all
 * well-formed, which is why none of them saw this.
 */
describe("resilience: a wake never loses everything (2026-08-17)", () => {
  /** ~15k tokens of prose — the size the live model actually wrote. */
  const HUGE = "The demand here is eccentric quad tolerance and single-leg control, dosed in bouts. ".repeat(720);

  async function coachMessages(db: Db, userId: string) {
    return db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
  }
  async function receipts(db: Db, userId: string) {
    return db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
  }

  /** Schema-valid JSON, but enormous — the good case that must not be slow
   * to land or expensive to confirm. */
  function hugeValidOutput(date: string) {
    return {
      briefing: "Two real leg sessions this week, and the daily piece is ten minutes of ankles and hips.",
      proposals: [
        {
          title: "Ski-prep legs",
          evidence: "trip in 10 days · 1 strength session in 90d",
          rationale: HUGE,
          expiresAt: date,
          flags: [],
          ops: [
            {
              kind: "ease",
              workoutId: "w1",
              session: {
                category: "easy",
                title: "Easy 30",
                durationMinutes: 30,
                run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
              },
            },
          ],
        },
      ],
      question: null,
      memoryOps: [],
      focus: "Two leg sessions, easy runs around them.",
    };
  }

  it("15k tokens of VALID JSON lands as a briefing and a proposal, in ONE call", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seedWorkout(db, userId, date, "w1");
    const { fetchImpl, calls } = scriptedFetch([chatBody(hugeValidOutput(date))]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "replan my week" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(calls.length).toBe(1); // size alone must never trigger a second call
    const msgs = await coachMessages(db, userId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("Two real leg sessions");
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props).toHaveLength(1);
  });

  it("15k tokens of MALFORMED JSON still lands the briefing, and says what it lost", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Parseable JSON, unparseable OPS: `date` is prose, so the add is
    // rejected and the whole proposal with it. This is the live shape — the
    // words were always fine, the structure never was.
    const broken = {
      briefing: "Two real leg sessions this week — Tuesday and Friday.",
      proposals: [
        {
          title: "Ski-prep legs",
          evidence: "trip in 10 days",
          rationale: HUGE,
          expiresAt: "2026-08-18",
          flags: [],
          ops: [{ kind: "add", date: "next Tuesday", session: { category: "strength", title: "Legs", durationMinutes: 40 } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    const { fetchImpl } = scriptedFetch([chatBody(broken), chatBody(broken)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "replan my week" }, fetchImpl);
    expect(res.status).toBe("ok");
    const msgs = await coachMessages(db, userId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("Two real leg sessions");
    // …and the loss is named, by title and by op kind, never silent.
    const rs = await receipts(db, userId);
    expect(rs.some((r) => r.body.includes("Ski-prep legs") && r.body.includes("1 add"))).toBe(true);
  });

  it("the briefing is on disk BEFORE the second call goes out — a call that never returns loses nothing", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const broken = {
      briefing: "Tuesday and Friday are the two real leg sessions.",
      proposals: [
        {
          title: "Ski-prep legs",
          evidence: "trip in 10 days",
          rationale: "Bouts, not days.",
          expiresAt: "2026-08-18",
          flags: [],
          ops: [{ kind: "add", date: "whenever", session: { category: "strength", title: "Legs", durationMinutes: 40 } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    let secondCallStarted = false;
    let messagesWhenSecondCallStarted = -1;
    const fetchImpl = (async () => {
      if (!secondCallStarted && messagesWhenSecondCallStarted < 0) {
        // First call: the model answers with prose the app can use and ops
        // it cannot.
        messagesWhenSecondCallStarted = 0;
        return new Response(JSON.stringify(chatBody(broken)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Second call — the repair. It NEVER comes back, exactly like a worker
      // killed mid-flight or a gateway that swallows the request.
      secondCallStarted = true;
      messagesWhenSecondCallStarted = (await coachMessages(db, userId)).length;
      return new Promise<Response>(() => {
        /* never resolves, and holds no timer, so the test process still exits */
      });
    }) as typeof fetch;

    // Deliberately NOT awaited: this wake never finishes, which is the point.
    void wake(db, makeEnv(), userId, prefs, { kind: "message", body: "replan my week" }, fetchImpl);
    await vi.waitFor(() => expect(secondCallStarted).toBe(true));

    // The invariant, twice over: the briefing existed before the doomed call
    // was made, and it is still there while that call hangs.
    expect(messagesWhenSecondCallStarted).toBe(1);
    const msgs = await coachMessages(db, userId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("two real leg sessions");
  });

  it("a failure receipt from four days ago does not swallow today's — the exact live silence", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const body = "The coach couldn't think just now — try again in a moment.";
    // The 2026-08-12 row that suppressed the 2026-08-17 one in prod.
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body,
      refs: { wakeFailure: true },
      at: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(),
    });
    const { fetchImpl } = failingFetch();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "replan my week" }, fetchImpl);
    expect(res.status).toBe("error");
    const rs = (await receipts(db, userId)).filter((r) => r.body === body);
    expect(rs, "a four-day-old identical receipt is history, not a duplicate").toHaveLength(2);
  });

  it("…while the same failure inside the backoff window is still deduped", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const body = "The coach couldn't think just now — try again in a moment.";
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body,
      refs: { wakeFailure: true },
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    const { fetchImpl } = failingFetch();
    await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    const rs = (await receipts(db, userId)).filter((r) => r.body === body);
    expect(rs).toHaveLength(1);
  });

  it("a crash after the briefing landed reports the plan changes as lost, not the coach as broken", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seedWorkout(db, userId, date, "w1");
    const out = hugeValidOutput(date);
    const { fetchImpl } = scriptedFetch([chatBody(out)]);
    // Break the op pipeline underneath a perfectly good briefing: an op that
    // parses but whose plan row cannot be written.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === schema.coachProposals) throw new Error("D1_ERROR: simulated");
            return (Reflect.get(target, prop, receiver) as (t: unknown) => unknown).call(target, table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    const res = await wake(brokenDb, makeEnv(), userId, prefs, { kind: "message", body: "replan" }, fetchImpl);
    expect(res.status).toBe("ok");
    const msgs = await coachMessages(db, userId);
    expect(msgs).toHaveLength(1);
    const rs = await receipts(db, userId);
    expect(rs.some((r) => r.body.includes("didn't make it"))).toBe(true);
    expect(rs.some((r) => r.body.includes("couldn't think"))).toBe(false);
  });
});

/**
 * The repair round-trip is a LUXURY, not a step (2026-08-17). Live, it is
 * what turned a slow wake into a dead one: the re-ask of an 11,577-token
 * answer came back at 16,287 tokens and 3m27s, and nothing survived it.
 */
describe("the second call has to earn itself", () => {
  it("a runaway first answer is salvaged, not re-asked", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const broken = {
      briefing: "Two real leg sessions this week — Tuesday and Friday.",
      proposals: [
        {
          title: "Ski-prep legs",
          evidence: "trip in 10 days",
          // ~30k chars of visible answer: past the point where re-asking has
          // ever produced a smaller one.
          rationale: "Bouts, not days, and here is why at length. ".repeat(700),
          expiresAt: "2026-08-18",
          flags: [],
          ops: [{ kind: "add", date: "sometime next week", session: { category: "strength", title: "Legs", durationMinutes: 40 } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    const { fetchImpl, calls } = scriptedFetch([chatBody(broken)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "replan my week" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(calls.length, "no repair on a runaway — the words are already safe").toBe(1);
    const msgs = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("Two real leg sessions");
  });

  it("a normal-sized broken answer still gets its one repair", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seedWorkout(db, userId, date, "w1");
    const broken = {
      briefing: "Easing tomorrow.",
      proposals: [
        {
          title: "Ease it",
          evidence: "slept 5h",
          rationale: "Short.",
          expiresAt: date,
          flags: [],
          ops: [{ kind: "ease", workoutId: "w1", session: { category: "easy", title: "Easy", durationMinutes: "thirty" } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    const fixed = {
      ...broken,
      proposals: [
        {
          ...broken.proposals[0],
          ops: [
            {
              kind: "ease",
              workoutId: "w1",
              session: {
                category: "easy",
                title: "Easy 30",
                durationMinutes: 30,
                run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
              },
            },
          ],
        },
      ],
    };
    const { fetchImpl, calls } = scriptedFetch([chatBody(broken), chatBody(fixed)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease tomorrow" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(calls.length).toBe(2);
    // One message, upgraded in place — never a salvage row plus a real one.
    const msgs = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
    expect(msgs).toHaveLength(1);
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props).toHaveLength(1);
  });
});

/**
 * THE WAKE LOCK: a dead holder is cheap, a live one is untouchable
 * (2026-08-17).
 *
 * Live, a cancelled wake left a `coach_locks` row nobody had released. It
 * self-heals — but the window was ten minutes, chosen back when nothing
 * bounded a wake, and for those ten minutes the athlete's next attempt would
 * have been told "busy" while `/coach/state` went on insisting the coach was
 * thinking about a wake that no longer existed.
 *
 * The window is `WAKE_LOCK_STALE_MINUTES` now, and the holder heartbeats, so
 * shortening it cannot cost a genuinely slow wake its claim.
 */
describe("the wake lock's staleness window", () => {
  async function seedLock(db: Db, userId: string, ageMinutes: number): Promise<void> {
    await db.insert(schema.coachLocks).values({
      userId,
      kind: "wake",
      token: "someone-elses",
      claimedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    });
  }

  it("a lock stranded past the window is taken over — the next wake answers", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedLock(db, userId, WAKE_LOCK_STALE_MINUTES + 1);
    const { fetchImpl } = scriptedFetch([chatBody({ ...RESTRAINT, briefing: "Here's where you stand." })]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("ok");
    const msgs = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "coach")));
    expect(msgs.map((m) => m.body)).toEqual(["Here's where you stand."]);
  });

  it("a lock inside the window still holds single-flight shut", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedLock(db, userId, 1);
    const { fetchImpl, calls } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("skipped");
    expect(calls).toHaveLength(0); // never even asked the model
  });

  it("a heartbeat re-arms the window, so a slow wake cannot be robbed mid-thought", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const mine = await claimUserLock(db, userId, "wake", WAKE_LOCK_STALE_MINUTES);
    expect(mine).not.toBeNull();

    // Still thinking, longer than the entire window — the shape the shorter
    // window would otherwise punish (the stranded-lock test above is the
    // same age, and IS taken over, because nothing beat there).
    const ancient = new Date(Date.now() - (WAKE_LOCK_STALE_MINUTES + 1) * 60_000).toISOString();
    await db
      .update(schema.coachLocks)
      .set({ claimedAt: ancient })
      .where(and(eq(schema.coachLocks.userId, userId), eq(schema.coachLocks.kind, "wake")));

    // …but saying so, which is all it takes to keep the claim.
    await touchUserLock(db, userId, "wake", mine!);
    expect(await claimUserLock(db, userId, "wake", WAKE_LOCK_STALE_MINUTES)).toBeNull();

    // A beat from a token that no longer holds the lock changes nothing.
    const before = (await db.select().from(schema.coachLocks).where(eq(schema.coachLocks.userId, userId)))[0]!;
    await touchUserLock(db, userId, "wake", "a-token-from-a-dead-isolate");
    const after = (await db.select().from(schema.coachLocks).where(eq(schema.coachLocks.userId, userId)))[0]!;
    expect(after.claimedAt).toBe(before.claimedAt);
  });
});
