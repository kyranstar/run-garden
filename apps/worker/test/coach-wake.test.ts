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
import {
  AMBIENT_TRIGGER_QUIET_MINUTES,
  openWakeIsFresh,
  wake,
  WAKE_LOCK_STALE_MINUTES,
} from "../src/services/coach-wake.js";
import { pendingTriggers } from "../src/services/coach-triggers.js";
import { claimUserLock, touchUserLock } from "../src/services/locks.js";
import { D1_BIND_LIMIT, makeTestDb, makeTestUser } from "./helpers.js";
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

  it("fatal violations: the repair is tried, and what survives it is KEPT as a rejected draft", async () => {
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
    const { fetchImpl, calls } = scriptedFetch([chatBody(bad), chatBody(bad)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "do it" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.proposalIds).toHaveLength(0);
    // An answer that repeats itself ends the loop at once — convergence is
    // monotone, so a repair that fixes nothing is not paid for twice.
    expect(calls.length).toBe(2);
    // The draft is not on the floor. It is a `rejected` row: inert, never
    // approvable, and the panel renders it as a settled card whose manifest
    // shows exactly what the coach tried to do.
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props.map((p) => p.status)).toEqual(["rejected"]);
    expect(props[0]!.ops).toHaveLength(1);
    expect(res.rejectedProposalIds).toEqual([props[0]!.id]);
    // …and the receipt points at it, so the card and the sentence are one
    // thing rather than two accounts of the same loss.
    const rs = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
    const rejection = rs.find((r) => r.body.startsWith("Not applied"))!;
    expect(rejection, "a rejected proposal must leave a receipt naming it").toBeTruthy();
    expect(rejection.refs.proposalId).toBe(props[0]!.id);
    expect(rejection.body).toContain("Rewrite the past");
    expect(rejection.body).toContain("already completed");
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
    expect(await openWakeIsFresh(db, userId, [])).toBe(false);
  });
});

/**
 * The $0.33-per-page-visit leak (live, 2026-08-17). Briefing at 04:13:26,
 * athlete marks a stale session skipped at 04:22:36, `missed_workout` fires
 * at 04:24:35, opening the plan page bills a second Opus call at 04:27:54
 * that re-derives the same proposal. The triggers were fine — the judgement
 * wasn't.
 */
describe("open-wake gate: an ambient trigger does not outrank a fresh briefing", () => {
  const briefing = async (db: Db, userId: string, agoMs: number) => {
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "Ski legs before the 26th.",
      refs: {},
      at: new Date(Date.now() - agoMs).toISOString(),
    });
  };
  const trigger = async (db: Db, userId: string, kind: string, agoMs = 0) => {
    await db.insert(schema.coachTriggers).values({
      id: newId(),
      userId,
      kind,
      evidence: {},
      firedAt: new Date(Date.now() - agoMs).toISOString(),
    });
  };

  it("REGRESSION: missed_workout 11 minutes after a briefing does NOT advise a wake", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await briefing(db, userId, 11 * 60_000);
    await trigger(db, userId, "missed_workout");
    const pending = await pendingTriggers(db, userId);
    // Pre-fix this returned false (= "advise a wake") purely because
    // triggers.length > 0, before the briefing was ever consulted.
    expect(await openWakeIsFresh(db, userId, pending)).toBe(true);
  });

  it("the same trigger DOES advise a wake once the briefing ages past the quiet window", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await briefing(db, userId, (AMBIENT_TRIGGER_QUIET_MINUTES + 5) * 60_000);
    await trigger(db, userId, "missed_workout");
    const pending = await pendingTriggers(db, userId);
    expect(await openWakeIsFresh(db, userId, pending)).toBe(false);
  });

  it("an unanswered message always advises a wake, however fresh the briefing", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await briefing(db, userId, 60_000); // one minute ago
    await trigger(db, userId, "unanswered_message");
    const pending = await pendingTriggers(db, userId);
    expect(await openWakeIsFresh(db, userId, pending)).toBe(false);
  });

  it("an unanswered message alongside an ambient signal still advises a wake", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await briefing(db, userId, 60_000);
    await trigger(db, userId, "missed_workout");
    await trigger(db, userId, "unanswered_message");
    const pending = await pendingTriggers(db, userId);
    expect(await openWakeIsFresh(db, userId, pending)).toBe(false);
  });

  it("no trigger at all still uses the far longer stale-briefing window", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    // Older than the ambient quiet window, far younger than 20h.
    await briefing(db, userId, 3 * 3600_000);
    expect(await openWakeIsFresh(db, userId, [])).toBe(true);
  });

  it("a recent wake failure still outranks everything, including an unanswered message", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "receipt",
      body: "The coach couldn't think just now — try again in a moment.",
      refs: { wakeFailure: true },
      at: nowInstant(),
    });
    await trigger(db, userId, "unanswered_message");
    const pending = await pendingTriggers(db, userId);
    expect(await openWakeIsFresh(db, userId, pending)).toBe(true);
  });

  it("the wake itself refuses an open cause the gate calls redundant — no model call", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await briefing(db, userId, 11 * 60_000);
    await trigger(db, userId, "missed_workout");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("the gate should have refused before any gateway call");
    }) as unknown as typeof fetch;
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, fetchImpl);
    expect(res.status).toBe("skipped");
    expect(calls).toBe(0);
  });

  it('"Check in" (manual) is never gated — it bypasses the quiet window entirely', async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await briefing(db, userId, 60_000);
    await trigger(db, userId, "missed_workout");
    const { fetchImpl } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, fetchImpl);
    expect(res.status).toBe("ok");
  });

  it("a genuinely new athlete message is never gated either", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await briefing(db, userId, 60_000);
    const { fetchImpl } = scriptedFetch([chatBody(RESTRAINT)]);
    const res = await wake(
      db,
      makeEnv(),
      userId,
      prefs,
      { kind: "message", body: "how should I ski-prep?" },
      fetchImpl,
    );
    expect(res.status).toBe("ok");
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

  it("a proposal the guardrails cannot pass says so too — and keeps the draft", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Rewriting an imported plan's structure is a FATAL guardrail violation:
    // `archiveWeek` no-ops on the authorship guard while `firmUp` would write
    // rows into a plan with no coach_plans row, so half the op silently lands.
    // The repair round-trip returns the same thing, so the proposal is filtered
    // out of the pending set and — before this — vanished without a word.
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
    expect(receipt, "a rejected proposal must leave a receipt naming it").toBeTruthy();
    expect(receipt!.body).toContain("came from your watch");
    expect(receipt!.body).toContain("still here to look at");
    // The receipt is the card: `refs.proposalId` is what `buildThread` keys on.
    const [kept] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(kept!.status).toBe("rejected");
    expect(receipt!.refs.proposalId).toBe(kept!.id);
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
    expect(out.fatal, "the phantom Tuesday quality run must not reject this").toEqual([]);
    // …and must not even show up as a cost the athlete is asked to weigh.
    expect(out.advisory, "a session that does not exist has no trade-off to name").toEqual([]);
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

  /**
   * The division of labour (2026-08-17): the app computes the manifest
   * (`describeOps`), the model writes the reasoning. The old rule — describe
   * only ops that exist — still left the model counting its own ops in prose,
   * which is a thing that drifts and which nothing in the product could
   * check. The prompt must forbid the whole category, not warn about it, and
   * it must not ask for a count anywhere else.
   */
  it("forbids the model from stating anything the ops already encode", async () => {
    const { WAKE_SYSTEM_PROMPT } = await import("../src/services/coach-wake.js");
    expect(WAKE_SYSTEM_PROMPT).toContain("NEVER STATE WHAT THE OPS ALREADY SAY");
    // The reason, in the prompt itself: the manifest is rendered beside it.
    expect(WAKE_SYSTEM_PROMPT).toMatch(/app prints the manifest/);
    expect(WAKE_SYSTEM_PROMPT).toContain("Nothing countable or enumerable");
    // …and the counterpart: what the model is FOR.
    expect(WAKE_SYSTEM_PROMPT).toContain("the app says what changes");
    // No surviving invitation to count in prose. "Count the days and say the
    // count" was the last one, and it lived under DOSE AGAINST THE HORIZON.
    expect(WAKE_SYSTEM_PROMPT).not.toContain("say the count");
    expect(WAKE_SYSTEM_PROMPT).not.toContain("explain the split");
  });

  /**
   * A rule the examples break is a rule the model breaks: voice is copied
   * from demonstrations far more reliably than from instructions.
   */
  it("no example's prose states a fact the manifest already carries", async () => {
    const wake = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    const countedThings = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(sessions?|workouts?|lifts?|runs?|bouts?|adds?)\b/i;
    const countedDays = /\bon\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+days?\b/i;
    const weekdays = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)('s)?\b/i;
    const credit = /\bI'?ve\s+(added|moved|written|left|dropped|swapped)\b/i;
    for (const name of ["WAKE_EXAMPLE_OUTPUT", "WAKE_EXAMPLE_CREATE_PLAN", "WAKE_EXAMPLE_LIFT"] as const) {
      const out = wakeOutputSchema.parse(JSON.parse(wake[name]));
      // Prose only: `evidence` cites the dossier by design, and titles are
      // the manifest rather than a claim about it.
      const prose = [out.briefing, out.focus, out.raceLine, ...out.proposals.map((p) => p.rationale)]
        .filter((s): s is string => typeof s === "string");
      for (const s of prose) {
        for (const [what, re] of [
          ["counts sessions", countedThings],
          ["counts days", countedDays],
          ["names weekdays", weekdays],
          ["takes credit", credit],
        ] as const) {
          expect(re.test(s), `${name} ${what}: "${s}"`).toBe(false);
        }
      }
    }
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

  it("the lift example proposes what its briefing reasons about", async () => {
    const { WAKE_EXAMPLE_LIFT } = await import("../src/services/coach-wake.js");
    const { wakeOutputSchema } = await import("@rg/domain");
    const out = wakeOutputSchema.parse(JSON.parse(WAKE_EXAMPLE_LIFT));
    const ops = out.proposals[0]!.ops;
    // The example the model copies its voice from must obey the honesty rule
    // in both directions: the bouts it reasons about exist as ops…
    const legSessions = ops.filter(
      (o) => o.kind === "add" && o.session.category === "strength" && o.session.durationMinutes >= 30,
    );
    expect(legSessions).toHaveLength(2);
    // …and it does NOT count them in prose (2026-08-17) — the app prints the
    // manifest, and an example that enumerates teaches enumeration.
    expect(out.briefing).toContain("in bouts");
    expect(out.briefing).not.toContain("two real leg sessions");
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

/* ══════════════════════════════════════════════════════════════════════ *
 * TONIGHT'S FIVE, REPLAYED — every one of them must now reach the athlete
 *
 * Five separate failures in one evening, five different causes, one
 * architecture: a single objection discarded the whole proposal, there was no
 * negotiation, and the athlete was never consulted. Verbatim, from prod:
 *
 *   Athlete: "I would like this to be a bit more intense and front loaded.
 *   I asked for ski prep lifting every day and you just gave me one real
 *   session. Perhaps we can do 3 real sessions as a compromise."
 *
 *   Receipt: "One plan change didn't make it … hard days back to back on
 *   Sat 15 Aug and Sun 16 Aug — one of the two needs to be easy. Nothing
 *   was applied."
 *
 * Seven ops and $0.397, binned, over a Saturday long run that had ALREADY
 * HAPPENED. Each test below drives the whole pipeline — recorded model reply →
 * zod → guardrails → the rows the panel reads — and asserts the proposal is
 * PENDING and carries the right trade-off, because "reaches the athlete" means
 * a card with an approve button on it, not a validator returning an array.
 * ══════════════════════════════════════════════════════════════════════ */
describe("tonight's five failures reach the athlete as choices", () => {
  /** One planned row, with the fields "hard" actually depends on. */
  async function seedRow(
    db: Db,
    userId: string,
    row: {
      id: string;
      date: string;
      category: string;
      sport?: string;
      minutes?: number;
      state?: string;
      archiveReason?: string;
    },
  ): Promise<void> {
    const at = nowInstant();
    await db.insert(schema.plannedWorkouts).values({
      id: row.id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${row.id}`,
      title: row.category,
      category: row.category,
      sport: row.sport ?? "run",
      originalPlanDate: row.date,
      lastVerifiedCorosDate: row.date,
      effectiveDate: row.date,
      effectiveTime: "07:00",
      completionState: row.state ?? "scheduled",
      sourceContentFingerprint: `fp-${row.id}`,
      calendarBlockDurationSeconds: (row.minutes ?? 60) * 60,
      archivedAt: row.archiveReason ? at : null,
      archiveReason: row.archiveReason ?? null,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** A model reply carrying one proposal made of `ops`. */
  const reply = (title: string, ops: unknown[], briefing = "Here's the week.") => ({
    briefing,
    proposals: [{ title, evidence: "e", rationale: "r", expiresAt: "2026-12-31", flags: [], ops }],
    question: null,
    memoryOps: [],
    focus: null,
  });

  const lift = (minutes: number, title = "Ski legs") => ({
    category: "strength",
    title,
    durationMinutes: minutes,
    lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45 }] },
  });
  const easyRun = (minutes: number) => ({
    category: "easy",
    title: `Easy ${minutes}`,
    durationMinutes: minutes,
    run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
  });

  async function pendingOf(db: Db, userId: string) {
    return db
      .select()
      .from(schema.coachProposals)
      .where(and(eq(schema.coachProposals.userId, userId), eq(schema.coachProposals.status, "pending")));
  }
  async function receiptsOf(db: Db, userId: string) {
    return db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
  }

  /**
   * #1 — THE OVER-STRICT EXERCISE SCHEMA. "Wall sits and anything else that
   * will get me prepared" produced three exercises the schema could not
   * accept, and the whole proposal went with them. A hold, a slow eccentric
   * and per-side work are the entire vocabulary of ski prep.
   */
  it("#1 a lift written in holds, eccentrics and per-side work survives, in ONE call", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const day = addDays(todayInZone(prefs.timezone), 3);
    await seedRow(db, userId, { id: "later", date: addDays(day, 7), category: "easy" });
    const ops = [
      {
        kind: "add",
        date: day,
        session: {
          category: "strength",
          title: "Ski legs — holds and eccentrics",
          durationMinutes: 40,
          lift: {
            exercises: [
              { name: "Wall sit", sets: 3, holdSeconds: 45, restSeconds: 60 },
              { name: "Bulgarian split squat", sets: 3, reps: 8, perSide: true, eccentricSeconds: 4, weight: { type: "kg", value: 12 } },
              { name: "Copenhagen plank", sets: 2, holdSeconds: 20, perSide: true, note: "knee-bent is fine" },
            ],
          },
        },
      },
    ];
    const { fetchImpl, calls } = scriptedFetch([chatBody(reply("Ski-prep legs", ops))]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "wall sits and whatever else" }, fetchImpl);

    expect(res.status).toBe("ok");
    expect(calls.length, "a well-shaped answer costs one call").toBe(1);
    const pending = await pendingOf(db, userId);
    expect(pending, "the proposal must reach the athlete").toHaveLength(1);
    // The exercises survive intact — the sheet and the manifest read these.
    const kept = (pending[0]!.ops as Array<{ session: { lift: { exercises: unknown[] } } }>)[0]!;
    expect(kept.session.lift.exercises).toHaveLength(3);
    expect(await receiptsOf(db, userId)).toHaveLength(0);
  });

  /**
   * #2 — THE PHANTOM CALENDAR. `guardrailCtx` was the one read of
   * `planned_workouts` in the coach path with no `archivedAt` filter, so the
   * validator judged a Tuesday holding one real easy run and three sessions
   * COROS had dropped. The coach could not even NAME them: the dossier filters
   * archived rows, so they carry no [wo:id].
   */
  it("#2 archived phantoms cannot object on the athlete's behalf", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const mon = addDays(today, 1);
    const tue = addDays(today, 2);
    await seedRow(db, userId, { id: "mon-600s", date: mon, category: "quality", minutes: 100 });
    await seedRow(db, userId, { id: "tue-live", date: tue, category: "easy", minutes: 75 });
    await seedRow(db, userId, { id: "tue-gone", date: tue, category: "quality", minutes: 60, archiveReason: "absence_confirmed" });
    await seedRow(db, userId, { id: "tue-lift-gone", date: tue, category: "strength", sport: "strength", minutes: 56, archiveReason: "duplicate_mirror" });

    const { fetchImpl } = scriptedFetch([
      chatBody(
        reply("Ski legs — first bout", [
          { kind: "ease", workoutId: "mon-600s", session: easyRun(35) },
          { kind: "add", date: mon, session: lift(33) },
        ]),
      ),
    ]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "get me ready to ski" }, fetchImpl);

    expect(res.status).toBe("ok");
    const pending = await pendingOf(db, userId);
    expect(pending).toHaveLength(1);
    // Tuesday is an easy run. Nothing may mention it as a hard day.
    expect(pending[0]!.flags.join(" ")).not.toContain(tue);
    expect(pending[0]!.flags).toEqual([]);
  });

  /**
   * #3 — UNCHUNKED D1 BINDS. A live wake spent 125 seconds and an LLM call,
   * persisted its briefing, then died on a 134-id `inArray`. `makeTestDb`'s
   * bound-variable cap makes that failure reproduce in milliseconds; without
   * it the whole class is invisible locally, because better-sqlite3 binds
   * thousands quite happily.
   */
  it("#3 a 130-workout calendar still gets a proposal, at D1's real bind ceiling", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    for (let i = 0; i < 130; i++) {
      await seedRow(db, userId, { id: `w${i}`, date: addDays(today, 1 + (i % 50)), category: "easy", minutes: 40 });
    }
    const { fetchImpl } = scriptedFetch([
      chatBody(reply("Ease tomorrow", [{ kind: "ease", workoutId: "w0", session: easyRun(30) }])),
    ]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease tomorrow" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(await pendingOf(db, userId)).toHaveLength(1);
  });

  /**
   * #4 — THE NUMBERS THE MODEL COULD NOT SEE. The live wake proposed 313
   * minutes of strength against a 120-minute cold-start ceiling nobody had
   * shown it. Both halves are fixed: the ceiling is in the prompt and the
   * remaining budget is in the dossier — AND, when the coach spends it anyway,
   * that is the athlete's call to make and not a reason to bin the plan.
   */
  it("#4 a cold-start block far over the ceiling arrives as a trade-off, not a refusal", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // A Monday at least a week out, computed rather than offset: the three
    // bouts must land in ONE week whatever weekday the suite runs on, or the
    // cold-start total splits and the test measures the calendar instead of
    // the rule. (A test that reads the real clock is a time bomb — this repo
    // has had one go off on a Saturday.)
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
    const mon = addDays(today, 7 + ((8 - dow) % 7));
    expect(new Date(`${mon}T12:00:00Z`).getUTCDay(), "the anchor must be a Monday").toBe(1);
    await seedRow(db, userId, { id: "anchor", date: addDays(mon, 20), category: "easy" });
    // No strength history at all: the cold-start ceiling is what applies.
    const ops = [0, 2, 4].map((n) => ({ kind: "add", date: addDays(mon, n), session: lift(105, `Bout ${n}`) }));
    const { fetchImpl, calls } = scriptedFetch([chatBody(reply("Ski legs — three bouts", ops))]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "3 real sessions as a compromise" }, fetchImpl);

    expect(res.status).toBe("ok");
    expect(calls.length, "an advisory is not a reason to re-ask the model").toBe(1);
    const pending = await pendingOf(db, userId);
    expect(pending, "315 minutes of strength is a choice, not an error").toHaveLength(1);
    const flags = pending[0]!.flags.join(" | ");
    expect(flags).toContain("no strength work in the last four weeks");
    expect(flags).toContain("315 minutes");
    // …and it earns the judgement rather than nagging: the cost, once.
    expect(flags).toContain("the soreness turns up a day or two after each session");
    expect(flags).not.toMatch(/too much|must|should|needs to/);
    expect(await receiptsOf(db, userId)).toHaveLength(0);
  });

  /**
   * #5 — HARD ADJACENCY, ON A SATURDAY THAT HAD ALREADY HAPPENED. The exact
   * proposal from the transcript: the athlete asked for three real sessions,
   * the coach wrote them and reasoned about the cost, and a rule refused on
   * the athlete's behalf over a long run they had already run.
   *
   * The finding is unchanged and still true. What changed is who decides.
   */
  it("#5 the front-loaded ski block the athlete asked for is approvable, and says what it costs", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const tomorrow = addDays(today, 1);
    // The long run is TODAY and already done — nothing the coach proposes can
    // change it, which is why refusing over it was indefensible.
    await seedRow(db, userId, { id: "sat-long", date: today, category: "long", minutes: 116, state: "completed" });
    await seedRow(db, userId, { id: "mon-q", date: addDays(today, 2), category: "quality", minutes: 80 });

    const { fetchImpl, calls } = scriptedFetch([
      chatBody(
        reply(
          "Ski legs — front-loaded bouts before the 26th",
          [{ kind: "add", date: tomorrow, session: lift(45, "Ski legs — first bout") }],
          "Three real bouts, and the runs give up length to pay for them.",
        ),
      ),
    ]);
    const res = await wake(
      db,
      makeEnv(),
      userId,
      prefs,
      { kind: "message", body: "more intense and front loaded — 3 real sessions as a compromise" },
      fetchImpl,
    );

    expect(res.status).toBe("ok");
    expect(calls.length).toBe(1);
    const pending = await pendingOf(db, userId);
    expect(pending, "the athlete asked for this — it must reach them").toHaveLength(1);
    const flags = pending[0]!.flags.join(" | ");
    // The cost is named honestly, INCLUDING that the earlier day is done: the
    // old wording told the athlete to go and make yesterday easy.
    expect(flags).toContain("which you've already trained hard");
    expect(flags).toContain("they stack whether the plan says so or not");
    expect(flags).not.toContain("needs to be easy");
    // Nothing was lost, so nothing apologises for losing it.
    expect(await receiptsOf(db, userId)).toHaveLength(0);
    // And the trade-off is on the card the athlete taps, which is the whole
    // architecture: the panel renders `flags` directly above approve/decline.
    expect(pending[0]!.status).toBe("pending");
  });

  /**
   * …and the coach can still SEE the stack before it plans. The advisory
   * would be a nasty surprise if the dossier's LIMITS section still began at
   * today, which is exactly what it did: the coach met this finding for the
   * first time in a rejection, about a day it could not change.
   */
  it("the dossier lists yesterday's hard day, so the coach is not ambushed by it", async () => {
    const { buildDossier } = await import("../src/services/coach-context.js");
    const { guardrailCtx } = await import("../src/services/coach-wake.js");
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const yesterday = addDays(today, -1);
    await seedRow(db, userId, { id: "yday-long", date: yesterday, category: "long", minutes: 116, state: "completed" });
    const guard = await guardrailCtx(db, userId, prefs);
    const d = await buildDossier(db, userId, prefs, guard);
    expect(d.text).toContain(yesterday);
    expect(d.text).toContain("the first is yesterday — already done");
  });
});

/* ══════════════════════════════════════════════════════════════════════ *
 * CONVERGENCE — the coach gets a bounded chance to fix what is genuinely
 * broken, instead of losing the work.
 *
 * The schema repair loop is the precedent and this reuses its shape and its
 * budget discipline. Two things are proved here that the earlier one-shot
 * repair could not claim: the retry is told what is ALLOWED (an earlier
 * attempt fed back only the violation, and the model just broke the same rule
 * differently), and it cannot loop — bounded by a hard count AND by the wake
 * deadline, whichever bites first.
 * ══════════════════════════════════════════════════════════════════════ */
describe("convergence: a fatal violation is a retry, not a loss", () => {
  const easySession = (minutes: number) => ({
    category: "easy",
    title: `Easy ${minutes}`,
    durationMinutes: minutes,
    run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
  });
  const wrap = (ops: unknown[]) => ({
    briefing: "Easing what needs easing.",
    proposals: [{ title: "Ease it", evidence: "e", rationale: "r", expiresAt: "2026-12-31", flags: [], ops }],
    question: null,
    memoryOps: [],
    focus: null,
  });

  it("a ghost workout id is fixed on the retry, and the athlete gets the proposal", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seedWorkout(db, userId, date, "w-real");

    // First answer names an id nobody has — the quietest failure the pipeline
    // has, because `applyOps` would UPDATE nothing and report success.
    const ghost = wrap([{ kind: "ease", workoutId: "wo-hallucinated", session: easySession(30) }]);
    const fixed = wrap([{ kind: "ease", workoutId: "w-real", session: easySession(30) }]);
    const { fetchImpl, calls } = scriptedFetch([chatBody(ghost), chatBody(fixed)]);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease that one" }, fetchImpl);

    expect(res.status).toBe("ok");
    expect(calls.length).toBe(2);
    expect(res.proposalIds).toHaveLength(1);
    expect(res.rejectedProposalIds).toBeUndefined();
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props.map((p) => p.status)).toEqual(["pending"]);
    // Nothing was lost, so nothing says anything was.
    const rs = await db
      .select()
      .from(schema.coachMessages)
      .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
    expect(rs).toHaveLength(0);
  });

  it("the retry is told what is ALLOWED, not only what was wrong", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 2);
    await seedWorkout(db, userId, date, "w-real");

    const bodies: string[] = [];
    const ghost = wrap([{ kind: "ease", workoutId: "wo-hallucinated", session: easySession(30) }]);
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(chatBody(ghost)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease that one" }, fetchImpl);

    expect(bodies.length).toBe(2);
    const repairPrompt = bodies[1]!;
    // The violation…
    expect(repairPrompt).toContain("unknown_workout");
    // …and the budget, which is the half that was missing. Without the ids it
    // may actually name, the model can only guess at another one.
    expect(repairPrompt).toContain("[wo:w-real]");
    expect(repairPrompt).toContain(`today is ${today}`);
    expect(repairPrompt).toContain("WHAT YOU MAY WORK WITH");
  });

  it("it cannot loop: an unfixable answer costs a bounded number of calls", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Two independently-broken proposals, so "fewer than before" has room to
    // be true and the loop is not ended by the monotone guard on round one.
    const stubborn = {
      briefing: "Both of these are impossible.",
      proposals: ["a", "b"].map((k) => ({
        title: `Impossible ${k}`,
        evidence: "e",
        rationale: "r",
        expiresAt: "2026-12-31",
        flags: [],
        ops: [{ kind: "retirePlan", planId: `not-a-coach-plan-${k}` }],
      })),
      question: null,
      memoryOps: [],
      focus: null,
    };
    // Nine scripted answers available; the bound is what stops it, not supply.
    const { fetchImpl, calls } = scriptedFetch(Array.from({ length: 9 }, () => chatBody(stubborn)));
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "retire it" }, fetchImpl);

    expect(res.status).toBe("ok");
    // One first call, and at most MAX_GUARDRAIL_REPAIRS after it — and in fact
    // exactly one, because an answer that repeats itself ends the loop.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.length).toBe(2);
    // Both drafts survive as rejected rows, each with its own receipt.
    const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(props.map((p) => p.status)).toEqual(["rejected", "rejected"]);
    expect(res.rejectedProposalIds).toHaveLength(2);
  });

  it("it respects the deadline: no retry when there is not enough time left", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedWorkout(db, userId, addDays(todayInZone(prefs.timezone), 2), "w-real");
    const ghost = wrap([{ kind: "ease", workoutId: "wo-hallucinated", session: easySession(30) }]);

    // A model call that "takes" 150 seconds of wall clock. The wake budget is
    // 240s with a 120s floor for another call, so after the first there are
    // 90s left and the retry must not be attempted — this is the live failure
    // that turned a slow wake into a dead one, and the reason a repair is a
    // luxury bought out of time left over rather than a step.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const { fetchImpl, calls } = scriptedFetch([chatBody(ghost), chatBody(ghost)]);
      const slow = (async (...args: Parameters<typeof fetch>) => {
        skew += 150_000;
        return fetchImpl(...args);
      }) as typeof fetch;
      const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease that one" }, slow);
      expect(res.status).toBe("ok");
      expect(calls.length, "no second call once the budget is gone").toBe(1);
      // …and the draft is still kept rather than thrown away.
      const props = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
      expect(props.map((p) => p.status)).toEqual(["rejected"]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
