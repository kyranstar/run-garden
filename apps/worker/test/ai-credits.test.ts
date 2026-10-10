/**
 * THE AI ACCOUNT IS OUT OF CREDITS (owner report, 2026-10-09).
 *
 * Live: from 2026-10-08 every coach read failed after five attempts with nothing recorded, and a coach message logged
 * `studio: ai gateway error, status 402 … "A positive credit balance is required…"` while the coach screen said
 * "thinking" for ever. A 402 from the gateway is not a blip: it will say the same thing until someone adds credits. So
 * it is its own failure — never retried, never backed off and burned, recorded where the athlete (and the owner, who
 * pays) can see it, and cleared by the first call that works again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { coachReads, schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import {
  clearOutOfCredits,
  isOutOfCredits,
  loadOutOfCredits,
  noteGatewayOutcome,
  recordOutOfCredits,
} from "../src/services/ai-credits.js";
import { patchAccountState } from "../src/services/account-state.js";
import { chatCompletion, generatePlan } from "../src/services/studio-llm.js";
import { enqueueCoachReads, ensureRead, processCoachReads } from "../src/services/coach-reads.js";
import { openWakeIsFresh, wake, WAKE_FAILURE_BACKOFF_MINUTES } from "../src/services/coach-wake.js";
import { pendingTriggers } from "../src/services/coach-triggers.js";
import { coachRoutes } from "../src/routes/coach.js";
import { settingsRoutes } from "../src/routes/misc.js";
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

/** The gateway's own words when the account is empty (synthetic copy of the live shape). */
function outOfCreditsGateway(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: { message: "A positive credit balance is required to use this model.", type: "insufficient_funds" },
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function statusGateway(status: number): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("nope", { status });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function answeringGateway(content: unknown): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const READ = { glance: "Even splits, easy HR.", body: "A calm, honest aerobic hour.", flags: [] };
const BRIEFING = { briefing: "Back with you — Thursday stays easy.", proposals: [], question: null, memoryOps: [] };

async function seedActivity(db: Db, userId: string, prefs: UserPreferences, daysAgo = 1): Promise<string> {
  const date = addDays(todayInZone(prefs.timezone), -daysAgo);
  const id = newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: `${date}T12:00:00Z`,
    startTimeLocal: `${date}T05:00:00`,
    sport: "run",
    durationSeconds: 3600,
    trainingLoad: 90,
    title: "Morning Run",
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

async function receipts(db: Db, userId: string) {
  return db
    .select()
    .from(schema.coachMessages)
    .where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")));
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("a gateway 402 is its own failure", () => {
  it("chatCompletion asks once and names it — no in-place retry", async () => {
    const gw = outOfCreditsGateway();
    const res = await chatCompletion(makeEnv(), gw.fetchImpl, "m", 10, [{ role: "user", content: "hi" }]);
    expect(res).toEqual({ ok: false, reason: "gateway_402" });
    expect(gw.calls()).toBe(1);
    expect(isOutOfCredits("gateway_402")).toBe(true);
    for (const other of ["gateway_400", "gateway_429", "gateway_500", "llm_error", "gateway_bad_response", undefined]) {
      expect(isOutOfCredits(other), String(other)).toBe(false);
    }
  });

  it("is recorded with the time it was seen, keeps the first sighting, and a working call clears it", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    expect(await loadOutOfCredits(db, userId)).toBeNull();

    await recordOutOfCredits(db, userId, "2026-10-08T09:00:00.000Z");
    await recordOutOfCredits(db, userId, "2026-10-09T07:30:00.000Z");
    expect(await loadOutOfCredits(db, userId)).toEqual({
      since: "2026-10-08T09:00:00.000Z",
      lastSeenAt: "2026-10-09T07:30:00.000Z",
    });

    await clearOutOfCredits(db, userId);
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  });

  it("noteGatewayOutcome: a 402 records, any other failure leaves it alone, a success clears", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await noteGatewayOutcome(db, userId, { ok: false, reason: "gateway_500" });
    expect(await loadOutOfCredits(db, userId)).toBeNull();
    await noteGatewayOutcome(db, userId, { ok: false, reason: "gateway_402" });
    const seen = await loadOutOfCredits(db, userId);
    expect(seen).not.toBeNull();
    await noteGatewayOutcome(db, userId, { ok: false, reason: "llm_error" });
    expect(await loadOutOfCredits(db, userId)).toEqual(seen);
    await noteGatewayOutcome(db, userId, { ok: true });
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  });

  it("writes nothing while a restore is replacing the account", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await patchAccountState(db, userId, { restoreId: "r1", restoreStartedAt: nowInstant() });
    await noteGatewayOutcome(db, userId, { ok: false, reason: "gateway_402" });
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  });
});

describe("the coach's chat on a 402", () => {
  it("a message: one call, no 'couldn't think', the words kept and still owed a reply", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const gw = outOfCreditsGateway();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "how is my week?" }, gw.fetchImpl);
    expect(res.status).toBe("out_of_credits");
    expect(gw.calls(), "a 402 is not retried, at the transport or by the wake").toBe(1);
    expect(await receipts(db, userId)).toEqual([]);
    const msgs = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));
    expect(msgs.map((m) => [m.role, m.body])).toEqual([["user", "how is my week?"]]);
    const triggers = await pendingTriggers(db, userId);
    expect(triggers.map((t) => t.kind)).toEqual(["unanswered_message"]);
    expect(await loadOutOfCredits(db, userId)).not.toBeNull();
  });

  it("Check in: the same — one call, out_of_credits", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const gw = outOfCreditsGateway();
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, gw.fetchImpl);
    expect(res.status).toBe("out_of_credits");
    expect(gw.calls()).toBe(1);
    expect(await receipts(db, userId)).toEqual([]);
  });

  it("an automatic wake backs off while the 402 is fresh, then asks once more and answers when credits are back", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const first = outOfCreditsGateway();
    await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "still there?" }, first.fetchImpl);
    expect(await openWakeIsFresh(db, userId, await pendingTriggers(db, userId))).toBe(true);
    const quiet = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, first.fetchImpl);
    expect(quiet.status).toBe("skipped");
    expect(first.calls()).toBe(1);

    // Past the same window a failed wake backs off for, a visit asks again — and credits are back.
    const since = (await loadOutOfCredits(db, userId))!.since;
    await recordOutOfCredits(db, userId, minutesAgo(WAKE_FAILURE_BACKOFF_MINUTES + 1));
    expect((await loadOutOfCredits(db, userId))!.since).toBe(since);
    expect(await openWakeIsFresh(db, userId, await pendingTriggers(db, userId))).toBe(false);
    const back = answeringGateway(BRIEFING);
    const answered = await wake(db, makeEnv(), userId, prefs, { kind: "open" }, back.fetchImpl);
    expect(answered.status).toBe("ok");
    expect(back.calls()).toBe(1);
    expect(await loadOutOfCredits(db, userId)).toBeNull();
    expect(await pendingTriggers(db, userId)).toEqual([]);
  });

  it("other gateway failures keep their handling: retried once, 'couldn't think', nothing about credits", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const gw = statusGateway(400);
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "manual" }, gw.fetchImpl);
    expect(res.status).toBe("error");
    expect(gw.calls()).toBe(2);
    expect((await receipts(db, userId)).map((r) => r.body)).toEqual([
      "The coach couldn't think just now — try again in a moment.",
    ]);
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  }, 20_000);
});

describe("the coach's reads on a 402", () => {
  it("the drain asks once, stops, and keeps every read queued with its attempts intact", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedActivity(db, userId, prefs, 1);
    await seedActivity(db, userId, prefs, 2);
    await enqueueCoachReads(db, userId, todayInZone(prefs.timezone));
    const gw = outOfCreditsGateway();
    const res = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl: gw.fetchImpl });
    expect(gw.calls()).toBe(1);
    expect(res.processed).toBe(0);
    const rows = await db.select().from(coachReads).where(eq(coachReads.userId, userId));
    expect(rows.map((r) => [r.status, r.attempt])).toEqual([
      ["queued", 0],
      ["queued", 0],
    ]);
    expect(rows.every((r) => r.nextAttemptAt <= nowInstant())).toBe(true);
    expect(await loadOutOfCredits(db, userId)).not.toBeNull();
  });

  it("while it stands, the drain does not ask at all — and resumes once a call works again", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const actId = await seedActivity(db, userId, prefs, 1);
    await enqueueCoachReads(db, userId, todayInZone(prefs.timezone));
    await recordOutOfCredits(db, userId);
    const gw = answeringGateway(READ);
    const skipped = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl: gw.fetchImpl });
    expect(skipped).toEqual({ processed: 0, attempted: 0, skipped: "out_of_credits" });
    expect(gw.calls()).toBe(0);

    // The athlete taps a read: that one call is how the app learns the credits are back.
    const tapped = await ensureRead(db, makeEnv(), userId, prefs, actId, { fetchImpl: gw.fetchImpl });
    expect(tapped.status).toBe("done");
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  });

  it("a tapped read says out_of_credits after one call and leaves the read to come back to", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const actId = await seedActivity(db, userId, prefs, 1);
    const gw = outOfCreditsGateway();
    const res = await ensureRead(db, makeEnv(), userId, prefs, actId, { fetchImpl: gw.fetchImpl });
    expect(res.status).toBe("out_of_credits");
    expect(gw.calls()).toBe(1);
    const [row] = await db.select().from(coachReads).where(eq(coachReads.activityId, actId));
    expect([row!.status, row!.attempt]).toEqual(["queued", 0]);
  });
});

describe("Plan Studio's calls keep the same record", () => {
  const brief = {
    goal: "strength",
    durationWeeks: 1,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 30,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate: "2026-10-12",
  } as never;

  it("a 402 there records it (no retry), a working call there clears it", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const gw = outOfCreditsGateway();
    const res = await generatePlan(makeEnv(), db, userId, brief, [], gw.fetchImpl);
    expect(res).toEqual({ plan: null, reason: "gateway_402" });
    expect(gw.calls()).toBe(1);
    expect(await loadOutOfCredits(db, userId)).not.toBeNull();

    await generatePlan(makeEnv(), db, userId, brief, [], answeringGateway({ not: "a plan" }).fetchImpl);
    expect(await loadOutOfCredits(db, userId)).toBeNull();
  });
});

describe("what the screens are told", () => {
  let db: Db;
  let userId: string;
  let prefs: UserPreferences;
  let cookie: string;

  beforeEach(async () => {
    db = makeTestDb();
    ({ userId, prefs } = await makeTestUser(db));
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  });
  afterEach(() => vi.unstubAllGlobals());

  const request = (routes: typeof coachRoutes, base: string, path: string, body?: unknown) =>
    mountRoutes(db, base, routes).request(
      path,
      body === undefined
        ? { headers: { Cookie: cookie } }
        : {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
      makeEnv(),
    );

  it("a message answers out_of_credits, and the state stops saying 'thinking' and says why", async () => {
    vi.stubGlobal("fetch", outOfCreditsGateway().fetchImpl);
    const sent = await request(coachRoutes, "/api/coach", "/api/coach/message", { body: "plan my week" });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { status: string }).status).toBe("out_of_credits");

    const state = (await (await request(coachRoutes, "/api/coach", "/api/coach/state")).json()) as {
      coachThinking: boolean;
      outOfCredits: { since: string } | null;
      messages: Array<{ role: string; body: string }>;
    };
    expect(state.coachThinking, "a reply is owed, but nothing is thinking about it").toBe(false);
    expect(state.outOfCredits?.since).toEqual(expect.any(String));
    expect(state.messages.map((m) => m.body)).toEqual(["plan my week"]);

    // Credits are back: the next working call clears it.
    vi.stubGlobal("fetch", answeringGateway(BRIEFING).fetchImpl);
    await request(coachRoutes, "/api/coach", "/api/coach/wake", { force: true });
    const after = (await (await request(coachRoutes, "/api/coach", "/api/coach/state")).json()) as {
      outOfCredits: unknown;
    };
    expect(after.outOfCredits).toBeNull();
  });

  it("a wake actually running still reads as thinking — it is the call that finds the credits are back", async () => {
    await recordOutOfCredits(db, userId);
    let thinkingMidWake: boolean | undefined;
    const answering = answeringGateway(BRIEFING).fetchImpl;
    vi.stubGlobal("fetch", (async (...args: Parameters<typeof fetch>) => {
      const state = (await (await request(coachRoutes, "/api/coach", "/api/coach/state")).json()) as {
        coachThinking: boolean;
      };
      thinkingMidWake = state.coachThinking;
      return answering(...args);
    }) as typeof fetch);
    await request(coachRoutes, "/api/coach", "/api/coach/message", { body: "back yet?" });
    expect(thinkingMidWake).toBe(true);
  });

  it("the read card's route answers 402 out_of_credits", async () => {
    const actId = await seedActivity(db, userId, prefs, 1);
    vi.stubGlobal("fetch", outOfCreditsGateway().fetchImpl);
    const res = await request(coachRoutes, "/api/coach", `/api/coach/analyze/${actId}`, {});
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "out_of_credits" });
  });

  it("Settings → AI hears the same", async () => {
    const base = (await (await request(settingsRoutes as never, "/api/settings", "/api/settings")).json()) as {
      llm: { outOfCreditsSince: string | null };
    };
    expect(base.llm.outOfCreditsSince).toBeNull();
    await recordOutOfCredits(db, userId, "2026-10-08T09:00:00.000Z");
    const after = (await (await request(settingsRoutes as never, "/api/settings", "/api/settings")).json()) as {
      llm: { outOfCreditsSince: string | null };
    };
    expect(after.llm.outOfCreditsSince).toBe("2026-10-08T09:00:00.000Z");
  });
});
