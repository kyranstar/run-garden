/**
 * Coach HTTP surface (Plan A Tasks A7+A9): state read with inline expiry
 * sweep, one-tap approve/decline with 409s on anything stale, memory CRUD
 * honored by the next dossier, question answers becoming memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
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

describe("GET /plans — studio union (user-nits fix)", () => {
  it("lists only the newest studio plan, with push-derived status", async () => {
    // Two studio plans: the older one is superseded and must not appear; the
    // newest has no verified push yet, so it reads as a draft.
    await db.insert(schema.studioPlans).values([
      {
        id: "sp-old",
        userId,
        brief: {},
        plan: { name: "Old Lift Block" },
        version: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "sp-new",
        userId,
        brief: {},
        plan: { name: "Full Body Strength" },
        version: 2,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);

    let res = (await (await client().get("/api/coach/plans")).json()) as {
      plans: Array<{ id: string; name: string; status: string; source?: string }>;
    };
    const studioRows = res.plans.filter((p) => p.source === "studio");
    expect(studioRows).toHaveLength(1);
    expect(studioRows[0]).toMatchObject({
      id: "sp-new",
      name: "Full Body Strength",
      status: "draft",
    });

    // A verified push flips it to active ("written to COROS").
    await db.insert(schema.studioPlanPushes).values({
      id: newId(),
      planId: "sp-new",
      planVersion: 2,
      happenDay: "2026-08-12",
      sessionTitle: "W1 Mon — Lift",
      status: "verified",
      updatedAt: nowInstant(),
    });
    res = (await (await client().get("/api/coach/plans")).json()) as typeof res;
    expect(res.plans.filter((p) => p.source === "studio")[0]).toMatchObject({
      id: "sp-new",
      status: "active",
    });
  });

  it("studio dates come from the BRIEF, not createdAt (audit finding 6: 'wk 1/1 ends Aug 3')", async () => {
    await db.insert(schema.studioPlans).values({
      id: "sp-brief",
      userId,
      brief: { startDate: "2026-08-17", durationWeeks: 16 },
      plan: { name: "16-Week Posterior Chain" },
      version: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const res = (await (await client().get("/api/coach/plans")).json()) as {
      plans: Array<{ id: string; startDate: string; endDate: string; source?: string }>;
    };
    const row = res.plans.find((p) => p.id === "sp-brief")!;
    expect(row.startDate).toBe("2026-08-17");
    expect(row.endDate).toBe("2026-12-06"); // Mon 08-17 + 16*7 - 1
  });

  it("an active COROS training plan with live workouts surfaces as a read-only run card (audit finding 6)", async () => {
    const today = todayInZone("America/Los_Angeles");
    await db.insert(schema.trainingPlans).values({
      id: "tp-10k",
      userId,
      provider: "coros",
      sourcePlanId: "4738",
      name: "10K Training Plan",
      startDate: addDays(today, -21),
      endDate: addDays(today, 42),
      status: "active",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-live",
      userId,
      planId: "tp-10k",
      sourceWorkoutId: "4738:1",
      title: "Long Run",
      category: "long",
      sport: "run",
      originalPlanDate: addDays(today, 3),
      lastVerifiedCorosDate: addDays(today, 3),
      effectiveDate: addDays(today, 3),
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const res = (await (await client().get("/api/coach/plans")).json()) as {
      plans: Array<{ id: string; discipline: string; source?: string; name: string }>;
    };
    const coros = res.plans.find((p) => p.source === "coros")!;
    expect(coros).toMatchObject({ id: "tp-10k", discipline: "run", name: "10K Training Plan" });

    // Archived-only plans stay off the shelf.
    await db
      .update(schema.plannedWorkouts)
      .set({ archivedAt: nowInstant() })
      .where(eq(schema.plannedWorkouts.id, "wo-live"));
    const after = (await (await client().get("/api/coach/plans")).json()) as typeof res;
    expect(after.plans.find((p) => p.source === "coros")).toBeUndefined();
  });
});

describe("analyze — read-through on the ledger (2026-08-11 rework §2)", () => {
  const GOOD_READ = JSON.stringify({
    glance: "Steady 9:40s; HR drifted late — fueling.",
    body: "Nice steady effort with honest pacing.",
    flags: ["hr_drift"],
  });

  function stubLlm(delayMs = 0): { calls: () => number } {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls += 1;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: GOOD_READ }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    return { calls: () => calls };
  }

  async function seedAct(): Promise<string> {
    const id = newId();
    await db.insert(schema.activities).values({
      id,
      userId,
      startTime: `${todayInZone(prefs.timezone)}T12:00:00Z`,
      startTimeLocal: `${todayInZone(prefs.timezone)}T05:00:00`,
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

  it("first call generates; second serves the ledger (cached, no new call)", async () => {
    const llm = stubLlm();
    const actId = await seedAct();
    const first = await client().post(`/api/coach/analyze/${actId}`, {});
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { read: { glance: string; body: string; flags: string[] }; cached: boolean };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.read.glance).toContain("HR drifted");
    expect(llm.calls()).toBe(1);

    const second = await client().post(`/api/coach/analyze/${actId}`, {});
    expect(second.status).toBe(200);
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);
    expect(llm.calls()).toBe(1);
  });

  it("EXACTLY-ONCE: concurrent analyze calls share one LLM call", async () => {
    const llm = stubLlm(40);
    const actId = await seedAct();
    const [a, b] = await Promise.all([
      client().post(`/api/coach/analyze/${actId}`, {}),
      client().post(`/api/coach/analyze/${actId}`, {}),
    ]);
    expect(llm.calls()).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 202]).toContain(statuses[1]);
  });

  it("honors the aiEnabled kill switch the old path skipped", async () => {
    stubLlm();
    const actId = await seedAct();
    await db
      .update(schema.userPreferences)
      .set({ prefs: { ...prefs, aiEnabled: false } })
      .where(eq(schema.userPreferences.userId, userId));
    const res = await client().post(`/api/coach/analyze/${actId}`, {});
    expect(res.status).toBe(503);
  });

  it("404s an unknown activity", async () => {
    stubLlm();
    const res = await client().post(`/api/coach/analyze/nope`, {});
    expect(res.status).toBe(404);
  });
});

describe("GET /plans/:id/detail (2026-08-11 rework §4)", () => {
  it("404s an unknown plan", async () => {
    expect((await client().get("/api/coach/plans/nope/detail")).status).toBe(404);
  });

  it("studio lift plan: prescribed progressions, weeks list, sessions", async () => {
    const monday = startOfIsoWeek(todayInZone(prefs.timezone));
    // The live data shape (round 5): the synced catalog's own name is the
    // i18n KEY — only COROS's locale table (embedded) knows "Push-ups".
    await db.insert(schema.corosExercises).values({
      id: "469646463400591360",
      name: "T1004",
      raw: { id: "469646463400591360", name: "T1004" },
      updatedAt: nowInstant(),
    });
    const mkWeek = (bench: number, squat: number) => ({
      sessions: [
        {
          title: "Full Body",
          weekday: 1,
          exercises: [
            { originId: "469646463400591360", name: "T1004", sets: 3, reps: 8, weight: { type: "kg", value: bench }, restSeconds: 120 },
            { originId: "S2", name: "Back Squat", sets: 4, reps: 6, weight: { type: "kg", value: squat }, restSeconds: 150 },
          ],
        },
      ],
    });
    const liftPlan = {
      name: "Strength Block B",
      brief: {
        goal: "strength",
        durationWeeks: 3,
        sessionsPerWeek: 1,
        preferredDays: [1],
        sessionMinutes: 60,
        equipment: "full gym",
        constraints: "",
        notes: "",
        startDate: monday,
      },
      weeks: [mkWeek(52, 75), mkWeek(56, 80), mkWeek(60, 85)],
    };
    await db.insert(schema.studioPlans).values({
      id: "sp1",
      userId,
      brief: liftPlan.brief,
      plan: liftPlan,
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const res = await client().get("/api/coach/plans/sp1/detail");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { discipline: string; source: string };
      weeks: Array<{ index: number; state: string; summary: string; current: boolean }>;
      progressions: Array<{ key: string; label: string; from: number; to: number; series: Array<{ week: number; value: number }> }>;
      sessions: { planned: number; done: number };
    };
    expect(body.plan.discipline).toBe("lift");
    expect(body.weeks).toHaveLength(3);
    expect(body.weeks[0]!.summary).toContain("sets");
    expect(body.weeks[0]!.current).toBe(true);
    // "T1004" resolved through the catalog — the actual name, everywhere.
    const bench = body.progressions.find((p) => p.label === "Push-ups")!;
    expect(body.progressions.map((pr) => pr.label).join()).not.toContain("T1004");
    expect(body.weeks[0]!.summary).toContain("push-ups");
    expect(bench.from).toBe(52);
    expect(bench.to).toBe(60);
    expect(bench.series.map((s) => s.value)).toEqual([52, 56, 60]);
    expect(body.sessions.planned).toBe(3);
  });

  it("coach run plan: firm/shape weeks, long-run progression, shape weeks excluded from series", async () => {
    const monday = startOfIsoWeek(todayInZone(prefs.timezone));
    const w1 = addDays(monday, -7);
    await db.insert(schema.coachPlans).values({
      id: "cp9",
      userId,
      discipline: "run",
      name: "Fall Half Block",
      status: "active",
      startDate: w1,
      endDate: addDays(w1, 4 * 7 - 1),
      raceDate: null,
      stampPrefix: "FH",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.coachPlanWeeks).values([
      { id: newId(), planId: "cp9", weekStart: w1, state: "firm", shape: null },
      { id: newId(), planId: "cp9", weekStart: monday, state: "firm", shape: null },
      { id: newId(), planId: "cp9", weekStart: addDays(monday, 7), state: "shape", shape: { volumeTarget: "~4h easy focus", keySessions: ["long 11 mi"] } },
      { id: newId(), planId: "cp9", weekStart: addDays(monday, 14), state: "shape", shape: { volumeTarget: "peak week", keySessions: [] } },
    ]);
    const mkRun = async (date: string, meters: number | null, seconds: number, state = "scheduled") => {
      await db.insert(schema.plannedWorkouts).values({
        id: newId(),
        userId,
        planId: "cp9",
        sourceWorkoutId: `cw-${newId().slice(0, 8)}`,
        // A COROS code-name on purpose: the weeks list must humanize it.
        title: meters ? "T1004" : "Easy run",
        category: meters ? "long" : "easy",
        sport: "run",
        originalPlanDate: date,
        lastVerifiedCorosDate: date,
        effectiveDate: date,
        effectiveTime: "07:00",
        sourceContentFingerprint: "fp",
        sourceEstimatedDurationSeconds: seconds,
        calendarBlockDurationSeconds: seconds,
        expectedDistanceMeters: meters,
        completionState: state,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    };
    await mkRun(addDays(w1, 5), 14484, 5400, "completed"); // 9 mi, done last week
    await mkRun(addDays(w1, 2), null, 2700, "completed");
    await mkRun(addDays(monday, 5), 16093, 6000); // 10 mi this week

    const res = await client().get("/api/coach/plans/cp9/detail");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weeks: Array<{ index: number; state: string; volumeTarget: string | null; current: boolean; done: boolean }>;
      progressions: Array<{ key: string; series: Array<{ week: number; value: number }> }>;
      adherencePct: number | null;
    };
    expect(body.weeks).toHaveLength(4);
    expect(body.weeks[0]!.done).toBe(true);
    expect(body.weeks[1]!.current).toBe(true);
    expect(body.weeks[2]!.state).toBe("shape");
    expect(body.weeks[2]!.volumeTarget).toBe("~4h easy focus");
    // "T1004" never reaches the reader — category words do.
    const summaries = (body.weeks as unknown as Array<{ summary: string }>).map((w) => w.summary).join(" | ");
    expect(summaries).not.toContain("T1004");
    expect(summaries).toContain("Long run");
    const long = body.progressions.find((p) => p.key === "run:long-run")!;
    // Shape weeks have no planned workouts — series carries only W1 and W2.
    expect(long.series.map((s) => s.week)).toEqual([1, 2]);
    expect(long.series.map((s) => s.value)).toEqual([9, 10]);
  });
});
