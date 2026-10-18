/**
 * THE THREAD COACH STEPS BACK (§8 §6, stream T): its engine is switched off, not deleted. `THREAD_COACH` — on only when
 * it is "1", absent in production — gates every path that could start a wake or mark a trigger:
 *
 *   GET  /state       wakeAdvised false, no trigger evaluated, never "thinking" over an old unanswered mark
 *   POST /wake        { status: "skipped" }, nothing read, nothing spent
 *   POST /message     the athlete's words kept, with a receipt ("Your coach is now behind the Coach button."), and no
 *                     unanswered mark: a cached old client that sends shows no "thinking"
 *   POST /questions/:id/answer   the answer kept as a fact, no wake
 *   hourly cron       no trigger evaluated
 *
 * Old proposals stay approvable and declinable until they expire. With the switch on, everything is as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { threadCoachEnabled, type Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { hourly } from "../src/index.js";
import { recordOutOfCredits } from "../src/services/ai-credits.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

/** The receipt `/message` answers with while the thread coach is off. */
const STEPPED_BACK = "Your coach is now behind the Coach button.";

function makeEnv(threadCoach?: string): Env {
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
    ...(threadCoach !== undefined ? { THREAD_COACH: threadCoach } : {}),
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

function client(threadCoach?: string) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv(threadCoach)),
    post: (path: string, body?: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        makeEnv(threadCoach),
      ),
  };
}

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  // Nothing the switch turns off may reach a model: any fetch is a failure here, and recorded.
  fetchSpy = vi.fn(async () => new Response("no model in this test", { status: 500 }));
  vi.stubGlobal("fetch", fetchSpy);
  statements.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A session the athlete missed yesterday: the old `missed_workout` trigger's condition. */
async function seedMissed(): Promise<void> {
  const today = todayInZone(prefs.timezone);
  await db.insert(schema.plannedWorkouts).values({
    id: "w-missed",
    userId,
    planId: "p",
    sourceWorkoutId: "4738:1",
    title: "Tempo",
    category: "quality",
    sport: "run",
    originalPlanDate: addDays(today, -1),
    lastVerifiedCorosDate: addDays(today, -1),
    effectiveDate: addDays(today, -1),
    effectiveTime: "07:00",
    completionState: "missed",
    resolutionDate: addDays(today, -1),
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function seedProposal(id: string, expiresAt: string): Promise<void> {
  await db.insert(schema.coachProposals).values({
    id,
    userId,
    title: "Ease tomorrow",
    evidence: "slept 5h",
    rationale: "r",
    flags: [],
    ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
    status: "pending",
    createdAt: nowInstant(),
    expiresAt,
  });
}

async function seedQuestion(id: string): Promise<void> {
  await db.insert(schema.coachQuestions).values({
    id,
    userId,
    body: "Is the race on the 24th still happening?",
    chips: ["Yes", "No"],
    askedAt: nowInstant(),
  });
}

const triggerRows = () => db.select().from(schema.coachTriggers).where(eq(schema.coachTriggers.userId, userId));
const messages = () => db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId));

describe("THREAD_COACH: on only when it is \"1\"", () => {
  it("reads \"1\" as on and anything else — absent, \"0\", \"true\", no env at all — as off", () => {
    expect(threadCoachEnabled(makeEnv("1"))).toBe(true);
    expect(threadCoachEnabled(makeEnv())).toBe(false);
    expect(threadCoachEnabled(makeEnv("0"))).toBe(false);
    expect(threadCoachEnabled(makeEnv("true"))).toBe(false);
    expect(threadCoachEnabled(undefined)).toBe(false);
  });
});

describe("the thread coach off (production)", () => {
  type State = { wakeAdvised: boolean; coachThinking: boolean; outOfCredits: unknown; pendingProposals: Array<{ id: string }>; messages: Array<{ role: string; body: string }> };

  it("GET /state advises no wake, marks no trigger, and still sweeps and lists what is pending", async () => {
    await seedMissed();
    const today = todayInZone(prefs.timezone);
    await seedProposal("p-live", addDays(today, 1));
    await seedProposal("p-stale", addDays(today, -1));
    const res = await client().get("/api/coach/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as State;
    expect(body.wakeAdvised).toBe(false);
    expect(body.coachThinking).toBe(false);
    expect(await triggerRows()).toEqual([]);
    expect(body.pendingProposals.map((p) => p.id)).toEqual(["p-live"]);
    expect(body.messages.some((m) => m.role === "receipt" && m.body.includes("Expired"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GET /state is never \"thinking\" over an unanswered mark left from before the switch, nor out of credits with no wake to retry", async () => {
    // An old client's message, sent a minute before the deploy: its mark is fresh, and no wake will ever answer it.
    await db.insert(schema.coachTriggers).values({ id: newId(), userId, kind: "unanswered_message", evidence: { body: "hi" }, firedAt: nowInstant() });
    // …and the AI account out of credits on record: the Plan's line would offer a Retry that wakes nothing.
    await recordOutOfCredits(db, userId);
    const body = (await (await client().get("/api/coach/state")).json()) as State;
    expect(body.coachThinking).toBe(false);
    expect(body.wakeAdvised).toBe(false);
    expect(body.outOfCredits).toBeNull();
  });

  it("GET /state still reads a wake in flight across the switch as thinking — until its lock goes stale", async () => {
    await db.insert(schema.coachLocks).values({ userId, kind: "wake", token: "t", claimedAt: nowInstant() });
    expect(((await (await client().get("/api/coach/state")).json()) as State).coachThinking).toBe(true);
    await db.update(schema.coachLocks).set({ claimedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    expect(((await (await client().get("/api/coach/state")).json()) as State).coachThinking).toBe(false);
  });

  it("GET /state costs 11 statements with the sign-in, and writes nothing on a quiet account", async () => {
    await client().get("/api/coach/state");
    expect(statements.filter(isWrite)).toEqual([]);
    // The sign-in, the preferences, the restore check, the two sweeps, the messages, the pending proposals, the open
    // question, the memory count, the last coach message, the wake lock: no trigger read, no credits read.
    expect(statements.length).toBe(11);
  });

  it("POST /wake answers skipped, spends nothing and writes nothing — forced or not", async () => {
    for (const force of [false, true]) {
      statements.length = 0;
      const res = await client().post("/api/coach/wake", { force });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped" });
      expect(statements.filter(isWrite)).toEqual([]);
      // The sign-in's only (its session, and a write's restore check).
      expect(statements.length).toBe(2);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await messages()).toEqual([]);
  });

  it("POST /message keeps the words with a receipt and leaves no unanswered mark — the cached client that sent it sees no thinking", async () => {
    const res = await client().post("/api/coach/message", { body: "Extend \"Fall Half\" — draft the next weeks in the same shape." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped" });
    expect(statements.filter(isWrite)).toHaveLength(1); // one insert, both rows
    expect(statements.length).toBe(3); // with the sign-in's two
    const thread = (await messages()).sort((a, b) => (a.role < b.role ? 1 : -1));
    expect(thread.map((m) => [m.role, m.body])).toEqual([
      ["user", "Extend \"Fall Half\" — draft the next weeks in the same shape."],
      ["receipt", STEPPED_BACK],
    ]);
    // The receipt strictly after the words, so every read of the thread (newest first, oldest first) orders them so.
    expect(thread[1]!.at > thread[0]!.at).toBe(true);
    expect(await triggerRows()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const state = (await (await client().get("/api/coach/state")).json()) as State;
    expect(state.coachThinking).toBe(false);
    expect(state.wakeAdvised).toBe(false);
    // The receipt is the thread's newest word, after the athlete's.
    expect(state.messages.at(-1)).toMatchObject({ role: "receipt", body: STEPPED_BACK });
  });

  it("POST /message still refuses an empty or oversized body", async () => {
    expect((await client().post("/api/coach/message", { body: "" })).status).toBe(400);
    expect((await client().post("/api/coach/message", { body: "x".repeat(4001) })).status).toBe(400);
    expect(await messages()).toEqual([]);
  });

  it("an answer to an open question is kept as a fact, with no wake and no unanswered mark", async () => {
    await seedQuestion("q1");
    statements.length = 0;
    const res = await client().post("/api/coach/questions/q1/answer", { answer: "Yes" });
    // The sign-in's two, the question, the fact, the question answered: nothing more.
    expect(statements.length).toBe(5);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; memoryId: string; wake: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.wake).toEqual({ status: "skipped" });
    const [fact] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, body.memoryId));
    expect(fact).toMatchObject({ kind: "fact", body: "Is the race on the 24th still happening? → Yes", active: true });
    const [q] = await db.select().from(schema.coachQuestions).where(eq(schema.coachQuestions.id, "q1"));
    expect(q!.answeredAt).not.toBeNull();
    expect(q!.memoryId).toBe(body.memoryId);
    expect(await triggerRows()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const state = (await (await client().get("/api/coach/state")).json()) as State;
    expect(state.coachThinking).toBe(false);
  });

  it("an old proposal is still approved and declined until it expires", async () => {
    const today = todayInZone(prefs.timezone);
    await seedProposal("p-a", addDays(today, 1));
    await seedProposal("p-d", addDays(today, 1));
    const approved = await client().post("/api/coach/proposals/p-a/approve");
    expect(approved.status).toBe(200);
    const declined = await client().post("/api/coach/proposals/p-d/decline");
    expect(declined.status).toBe(200);
    const rows = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, userId));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ "p-a": "approved", "p-d": "declined" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the hourly cron evaluates no trigger", { timeout: 30_000 }, async () => {
    await seedMissed();
    await hourly(db, makeEnv());
    expect(await triggerRows()).toEqual([]);
  });
});

describe("the thread coach on (the escape hatch: THREAD_COACH = \"1\")", () => {
  it("GET /state marks the trigger and advises a wake, as before", async () => {
    await seedMissed();
    const body = (await (await client("1").get("/api/coach/state")).json()) as { wakeAdvised: boolean };
    expect(body.wakeAdvised).toBe(true);
    expect((await triggerRows()).map((t) => t.kind)).toEqual(["missed_workout"]);
  });

  it("POST /message records the unanswered mark and wakes the coach", async () => {
    // The model holds its tongue (a restraint), so the wake ends at once.
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ briefing: null, proposals: [], question: null, memoryOps: [] }) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await client("1").post("/api/coach/message", { body: "Wind down my plan" });
    expect(fetchSpy).toHaveBeenCalled();
    expect((await messages()).some((m) => m.role === "user" && m.body === "Wind down my plan")).toBe(true);
    expect((await messages()).some((m) => m.body === STEPPED_BACK)).toBe(false);
  });

  it("the hourly cron marks the trigger, as before", { timeout: 30_000 }, async () => {
    await seedMissed();
    await hourly(db, makeEnv("1"));
    expect((await triggerRows()).map((t) => t.kind)).toEqual(["missed_workout"]);
  });
});
