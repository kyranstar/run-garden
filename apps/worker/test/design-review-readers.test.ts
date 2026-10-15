/**
 * THE THREAD COACH'S READERS AND A DESIGNED WORKOUT'S PROPOSAL (Stage 3 Task 6, from the Task 5 review).
 *
 * With reviews real, a design's proposal becomes `pending` — the status every reader of the thread coach lists — while
 * its ops are `doc_workout`, a kind none of them was written for. Until Task 8 brings its approval, each reader ignores
 * or describes such an op and never throws:
 *  - `GET /api/coach/state` lists only proposals the thread can act on;
 *  - approve and decline answer 409 `not_yet`;
 *  - the wake's supersede step leaves a designed proposal alone;
 *  - the wake's context (coach-context) describes it;
 *  - the race hub's reading of approved proposals passes it by;
 *  - the expiry sweep closes a design's proposal still unreviewed with its day, silently.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes, sweepExpiredProposals } from "../src/routes/coach.js";
import { buildDossier } from "../src/services/coach-context.js";
import { wake } from "../src/services/coach-wake.js";
import { buildRaceHub } from "../src/services/race-hub.js";
import { calmDoc } from "./doc-workout-fixture.js";
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
let today: string;
let tomorrow: string;

const DESIGNED = "dp-designed-run";
const THREAD = "thread-proposal";

/** A design's proposal as Task 5 and 6 store it: one reviewed `doc_workout` op. */
function designedOp(date: string) {
  return {
    kind: "doc_workout",
    target: { kind: "new", date },
    date,
    doc: calmDoc({ title: "Calm hips" }),
    review: { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] },
    issues: [],
    derived: { minutes: 20 },
    by: { runId: "designed-run", role: "main" },
    toolUseId: "toolu_x",
    at: nowInstant(),
  };
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  today = todayInZone(prefs.timezone);
  tomorrow = addDays(today, 1);
  await db.insert(schema.plannedWorkouts).values({
    id: "w1",
    userId,
    planId: "p",
    sourceWorkoutId: "4738:w1",
    title: "Tempo 3×10",
    category: "quality",
    sport: "run",
    originalPlanDate: tomorrow,
    lastVerifiedCorosDate: tomorrow,
    effectiveDate: tomorrow,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.coachProposals).values([
    { id: DESIGNED, userId, title: "Calm hips", evidence: "", rationale: "Wake the hips, then rest.", flags: [], ops: [designedOp(tomorrow)], status: "pending", createdAt: nowInstant(), expiresAt: tomorrow },
    { id: THREAD, userId, title: "Move the tempo", evidence: "e", rationale: "r", flags: [], ops: [{ kind: "move", workoutId: "w1", toDate: addDays(today, 2) }], status: "pending", createdAt: nowInstant(), expiresAt: tomorrow },
  ]);
});

function client() {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
    post: (path: string) => app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" } }, makeEnv()),
  };
}

const statusOf = async (id: string) => (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id)))[0]!.status;

describe("GET /api/coach/state", () => {
  it("answers, listing only the proposals the thread can act on — a designed workout's waits for its own surface", async () => {
    // A receipt naming the designed proposal: the settled list leaves it out too.
    await db.insert(schema.coachMessages).values({ id: "m1", userId, role: "receipt", body: "Expired — the moment passed: Calm hips", refs: { proposalId: DESIGNED }, at: nowInstant() });
    const res = await client().get("/api/coach/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendingProposals: Array<{ id: string }>; settledProposals: Array<{ id: string }> };
    expect(body.pendingProposals.map((p) => p.id)).toEqual([THREAD]);
    expect(body.settledProposals.map((p) => p.id)).toEqual([]);
  });
});

describe("approve and decline", () => {
  it("answer 409 not_yet for a designed workout's proposal, and leave it pending (Task 8 brings its approval)", async () => {
    for (const action of ["approve", "decline"]) {
      const res = await client().post(`/api/coach/proposals/${DESIGNED}/${action}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "not_yet" });
    }
    expect(await statusOf(DESIGNED)).toBe("pending");
    expect(await db.select().from(schema.coachMessages).where(and(eq(schema.coachMessages.userId, userId), eq(schema.coachMessages.role, "receipt")))).toEqual([]);
    // The thread's own proposal is unchanged: decline still works.
    expect((await client().post(`/api/coach/proposals/${THREAD}/decline`)).status).toBe(200);
  });
});

describe("the wake", () => {
  function chatBody(content: unknown): unknown {
    return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 400 } };
  }

  it("its supersede step leaves a designed proposal alone and never throws on its op; the thread's own is superseded as before", async () => {
    const output = {
      briefing: "Ease tomorrow.",
      proposals: [
        {
          title: "Ease tomorrow",
          evidence: "e2",
          rationale: "r2",
          expiresAt: tomorrow,
          flags: [],
          ops: [{ kind: "ease", workoutId: "w1", session: { category: "easy", title: "Steady 40", durationMinutes: 40, run: { blocks: [{ kind: "duration", value: 40 }] } } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    let prompt = "";
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      prompt = String(init?.body ?? "");
      return new Response(JSON.stringify(chatBody(output)), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease it instead" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect(await statusOf(DESIGNED)).toBe("pending");
    expect(await statusOf(THREAD)).toBe("superseded");
    // The wake's context named the designed workout, plainly.
    expect(prompt).toContain(`pending proposal [${DESIGNED}]: Calm hips`);
  });

  it("its context describes a pending designed workout — its day, and that it waits for approval in the Studio", async () => {
    const d = await buildDossier(db, userId, prefs, today);
    const line = d.text.split("\n").find((l) => l.includes(`pending proposal [${DESIGNED}]`));
    expect(line).toBe(`pending proposal [${DESIGNED}]: Calm hips (a designed workout for ${tomorrow}, waiting for the athlete in the Studio)`);
    expect(d.text).toContain(`pending proposal [${THREAD}]: Move the tempo (e)`);
  });
});

describe("the expiry sweep", () => {
  it("expires a design's unreviewed proposal with its day, silently (the athlete never saw it); a pending one with the usual receipt", async () => {
    const other = await makeTestUser(db);
    const at = nowInstant();
    const yesterday = addDays(today, -1);
    for (const [id, status] of [["dp-old-unreviewed", "unreviewed"], ["dp-old-pending", "pending"], ["dp-old-rehearsal", "rehearsal"]] as const) {
      await db.insert(schema.coachProposals).values({ id, userId: other.userId, title: id, evidence: "", rationale: "", flags: [], ops: [designedOp(yesterday)], status, createdAt: at, expiresAt: yesterday });
    }
    expect(await sweepExpiredProposals(db, other.userId, today)).toBe(2);
    const rows = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.userId, other.userId));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      "dp-old-unreviewed": "expired",
      "dp-old-pending": "expired",
      // Never shown, never swept: a rehearsal is the live suite's own.
      "dp-old-rehearsal": "rehearsal",
    });
    const receipts = await db.select().from(schema.coachMessages).where(and(eq(schema.coachMessages.userId, other.userId), eq(schema.coachMessages.role, "receipt")));
    expect(receipts.map((m) => m.body)).toEqual(["Expired — the moment passed: dp-old-pending"]);
  });
});

describe("the race hub", () => {
  it("passes a designed workout's proposal by, approved or pending", async () => {
    const raceDate = addDays(today, 10);
    await db.insert(schema.coachProposals).values({
      id: "dp-approved",
      userId,
      title: "Calm hips",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [designedOp(addDays(raceDate, -2))],
      status: "approved",
      createdAt: nowInstant(),
      expiresAt: tomorrow,
    });
    const hub = await buildRaceHub(db, userId, { ...prefs, raceDate }, today);
    expect(hub!.checklist.find((i) => i.id === "coach-restructure")!.done).toBe(false);
  });
});
