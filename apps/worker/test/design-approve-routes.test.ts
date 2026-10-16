/**
 * THE DESIGNED PROPOSAL'S ROUTES (Stage 3 Task 8; spec §8): approve all or some, decline, the draft "Edit before
 * approve" opens, and one proposal's read — each within one free-plan invocation.
 *
 *   POST /api/coach/proposals/:id/approve  { opIds?, edit? } → { ok, status, applied, refused, settled, remaining }
 *   POST /api/coach/proposals/:id/decline  { opIds?, reason? } → { ok, status, declined, settled }
 *   GET  /api/coach/proposals/:id/ops/:opId/draft → the op's document in the builder's shape
 *   GET  /api/coach/proposals/:id → its status, and for a designed one its manifest lines
 *
 * Measured the way doc-workout-budget.test.ts measures a Studio save: every D1 statement and every fetch the request
 * costs, its waitUntil work included, on a busy account (two sessions on some days, a month of logged ones), with
 * D1's bind cap on. The routes use the real clock, so every date is relative to the athlete's today. Synthetic data
 * only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, parseStoredWorkoutDoc, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { buildDossier } from "../src/services/coach-context.js";
import { APPROVE_FIXED, CREATE_AT_TIME_COST, DECLINE_COST, opCostOf, REQUEST_BUDGET, REVISE_BASE, type DesignedOp } from "../src/services/design-approve.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { opIdOf } from "../src/services/proposal-kinds.js";
import { activateTmj, calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { coachProposals, coachMessages, plannedWorkouts } = schema;

function makeEnv(designer = true): Env {
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
    ...(designer ? { COACH_DESIGNER: "1" } : {}),
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  await activateTmj(db, userId);
  await busyAccount();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fortnight of planned runs (two a day on every third day) and a month of logged sessions. */
async function busyAccount(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    for (const slot of i % 3 === 0 ? ["07:00", "18:00"] : ["07:00"]) {
      const id = `w-${i}-${slot}`;
      await db.insert(plannedWorkouts).values({
        id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run",
        originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: slot,
        sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
        createdAt: nowInstant(), updatedAt: nowInstant(),
      });
    }
  }
  for (let i = 1; i <= 30; i++) {
    const id = `p-${i}`;
    const date = addDays(today, -i);
    const at = `${date}T17:00:00.000Z`;
    await db.insert(schema.performedSessions).values({
      id, userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: date,
      startedAt: at, endedAt: null, seconds: 1200, plannedSeconds: 1200, minutes: 20, mode: "consistent", theme: null,
      locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
      movesDone: [], note: null, newMove: null, payloadHash: "h", createdAt: at, updatedAt: at,
    });
    await db.insert(schema.performedSets).values({
      id: `${id}-s0`, performedSessionId: id, entryIndex: 0, exerciseId: i % 2 ? "bwSplitSquat" : "snapDown", implement: null,
      format: "straight", perSide: false, setIndex: 0, side: null, reps: 5, seconds: null, loadValue: null, loadUnit: null,
      loadKg: null, done: true, flags: i % 4 ? [] : ["clenched"],
    });
  }
}

const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

/** A week's proposal of `drafts` by propose_workout (one designer each), reviewed and pending. */
async function designed(drafts: Array<{ doc: object; target: DocWorkoutTarget }>, who = userId): Promise<{ id: string; opIds: string[] }> {
  const run = async (role: "main" | "designer", parentId: string | null) => {
    const id = `run-${newId()}`;
    await db.insert(schema.coachRuns).values({
      id, userId: who, parentId, role, scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    return { id, role, scope: { kind: "week" as const }, parentId, rehearsal: false };
  };
  const main = await run("main", null);
  const opIds: string[] = [];
  for (const d of drafts) {
    const designer = await run("designer", main.id);
    const ctx: ToolContext = { db, env: makeEnv(), userId: who, run: designer, now: new Date(), toolUseId: `toolu_${newId()}` };
    const res = await proposeWorkout.run(ctx, d);
    if (isToolErr(res)) throw new Error(`propose refused: ${res.error} — ${res.why}`);
    opIds.push(designer.id);
  }
  const id = designProposalId(main.id);
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  await db.update(coachProposals).set({ status: "pending", ops: (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: REVIEW })) }).where(eq(coachProposals.id, id));
  return { id, opIds };
}

/** One request, its waitUntil work included: status, JSON and what it cost. */
async function invoke(method: string, path: string, body?: unknown, o: { designer?: boolean; as?: string } = {}) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: o.as ?? cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(o.designer ?? true),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements + fetches };
}

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const designRows = async () =>
  (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((w) => parseStoredWorkoutDoc(w.workoutDoc)?.basedOn?.kind === "proposal");

// ── The switch ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("with the coach designer off", () => {
  it("approve and decline answer 409 not_yet and the draft is not there: nothing a designed proposal holds is applied", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 2) } }]);
    for (const action of ["approve", "decline"]) {
      const res = await invoke("POST", `/api/coach/proposals/${id}/${action}`, {}, { designer: false });
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ error: "not_yet" });
    }
    expect((await invoke("GET", `/api/coach/proposals/${id}/ops/${opIds[0]}/draft`, undefined, { designer: false })).status).toBe(404);
    expect((await invoke("GET", `/api/coach/proposals/${id}`, undefined, { designer: false })).json).toEqual({ id, status: "pending", resolvedAt: null });
    expect((await proposalOf(id)).status).toBe("pending");
    expect(await designRows()).toEqual([]);
  });
});

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/coach/proposals/:id/approve", () => {
  it("a 7-workout set approves in chunks — { applied, remaining } — every request within 45, until nothing remains", async () => {
    // Seven new workouts on seven busy days, none at a time asked for: each is placed by the day's collision pass.
    const { id, opIds } = await designed(Array.from({ length: 7 }, (_, i) => ({ doc: calmDoc({ title: `Day ${i + 1}` }), target: { kind: "new" as const, date: addDays(today, i + 1) } })));
    const costs: number[] = [];
    const chunks: string[][] = [];
    let remaining: string[] | null = null;
    for (let i = 0; remaining === null || remaining.length > 0; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
      const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      costs.push(res.total);
      chunks.push((res.json.applied as Array<{ opId: string }>).map((a) => a.opId));
      remaining = res.json.remaining as string[];
    }
    // Pinned: each placed workout costs its day's sessions (one on most days, two on every third) plus itself, so two
    // fit a request where both days hold one, and one alone where its day holds two.
    expect(chunks).toEqual([opIds.slice(0, 2), opIds.slice(2, 3), opIds.slice(3, 5), opIds.slice(5, 6), opIds.slice(6)]);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    const p = await proposalOf(id);
    expect(p.status).toBe("approved");
    expect(await designRows()).toHaveLength(7);
    // One receipt, when nothing remained.
    const receipts = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")));
    expect(receipts).toHaveLength(1);
  });

  it("the declared costs hold: a request's fixed part and each op's, measured one by one on the busy account", async () => {
    const at = await designed([{ doc: calmDoc({ title: "Timed" }), target: { kind: "new", date: addDays(today, 3), time: "12:00" } }]);
    const timed = await invoke("POST", `/api/coach/proposals/${at.id}/approve`, {});
    expect(timed.json.applied).toHaveLength(1);
    expect(timed.total).toBeLessThanOrEqual(APPROVE_FIXED + CREATE_AT_TIME_COST);

    // Today, with the day's check answered (its pre-check read) and two sessions to place around.
    await db.insert(schema.conditionChecks).values({ id: newId(), userId, profileId: "tmj", kind: "daily", value: 1, feelingOff: false, localDate: today, at: nowInstant() });
    const placed = await designed([{ doc: calmDoc({ title: "Placed" }), target: { kind: "new", date: today } }]);
    const one = await invoke("POST", `/api/coach/proposals/${placed.id}/approve`, {});
    expect(one.json.applied).toHaveLength(1);
    expect(one.total).toBeLessThanOrEqual(APPROVE_FIXED + opCostOf({ target: { kind: "new", date: today } }, 2));

    // A revision that changes the workout's length: its day's collision pass runs.
    const made = await createDocWorkout(db, userId, { date: addDays(today, 3), doc: calmDoc({ title: "Mine" }) }, { today, now: nowInstant(), prefs });
    const longer = landingsDoc({ title: "Mine, longer" });
    const rev = await designed([{ doc: longer, target: { kind: "revise", workoutId: made.workout.id, baseRev: 1 } }]);
    const revised = await invoke("POST", `/api/coach/proposals/${rev.id}/approve`, {});
    expect(revised.json.applied).toHaveLength(1);
    // Its day holds two runs and the workout itself.
    expect(revised.total).toBeLessThanOrEqual(APPROVE_FIXED + REVISE_BASE + 3);
  });

  it("a pathological day — five sessions on each of two days — never puts a request past 45: the planner takes one at a time", async () => {
    // Two days of five scheduled sessions each, close together so a sixth sends the collision pass moving them all.
    const busy = [addDays(today, 15), addDays(today, 16)];
    for (const [d, date] of busy.entries()) {
      for (const [i, slot] of ["06:30", "07:00", "07:30", "12:00", "18:00"].entries()) {
        const id = `busy-${d}-${i}`;
        await db.insert(plannedWorkouts).values({
          id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run",
          originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: slot,
          sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, fallbackEstimatedDurationSeconds: 3600,
          createdAt: nowInstant(), updatedAt: nowInstant(),
        });
      }
    }
    const { id, opIds } = await designed(busy.map((date, i) => ({ doc: calmDoc({ title: `Busy ${i}` }), target: { kind: "new" as const, date } })));
    // Each costs its day's five, itself, and the rest: two together would not fit.
    const each = opCostOf({ target: { kind: "new", date: busy[0]! } }, 5);
    expect(APPROVE_FIXED + 2 * each).toBeGreaterThan(REQUEST_BUDGET);
    expect(APPROVE_FIXED + each).toBeLessThanOrEqual(REQUEST_BUDGET);
    const chunks: string[][] = [];
    let remaining: string[] | null = null;
    for (let i = 0; remaining === null || remaining.length > 0; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
      const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status).toBe(200);
      expect(res.total, `${res.total} statements`).toBeLessThanOrEqual(APPROVE_FIXED + each);
      chunks.push((res.json.applied as Array<{ opId: string }>).map((a) => a.opId));
      remaining = res.json.remaining as string[];
    }
    expect(chunks).toEqual([[opIds[0]], [opIds[1]]]);
  });

  it("answers what applied and what the server refused, with its reason; an unknown op id is 400 and nothing is written", async () => {
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "Soon" }), target: { kind: "new", date: addDays(today, 2) } },
      { doc: calmDoc({ title: "Later" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    const bad = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[0], "nope"] });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "unknown_op", opIds: ["nope"] });
    expect(await designRows()).toEqual([]);
    for (const body of [{ opIds: "all" }, { opIds: [3] }, { edit: { opId: opIds[0] } }, { nonsense: true }, { opIds: [opIds[0]], edit: { opId: opIds[0], doc: calmDoc() } }]) {
      expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, body)).status).toBe(400);
    }
    // A body that isn't JSON is no "approve everything".
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const garbled = await app.request(`/api/coach/proposals/${id}/approve`, { method: "POST", headers: { Cookie: cookie }, body: "approve everything" }, makeEnv());
    expect(garbled.status).toBe(400);
    expect(await designRows()).toEqual([]);
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[1]] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "partially_approved", refused: [], settled: [], remaining: [] });
    expect(res.json.applied).toEqual([expect.objectContaining({ opId: opIds[1], workout: expect.objectContaining({ title: "Later", date: addDays(today, 4) }), warnings: expect.any(Array) })]);
  });

  it("a proposal whose day has passed is expired, as a thread proposal is", async () => {
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 1) } }]);
    await db.update(coachProposals).set({ expiresAt: addDays(today, -1) }).where(eq(coachProposals.id, id));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "not_pending", status: "expired" });
    expect((await proposalOf(id)).status).toBe("expired");
  });

  it("a partly approved proposal is still the athlete's to finish; asked again once approved, it says where each workout is", async () => {
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "A" }), target: { kind: "new", date: addDays(today, 2) } },
      { doc: calmDoc({ title: "B" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[0]] })).json.status).toBe("partially_approved");
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[1]] })).json.status).toBe("approved");
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, status: "approved", applied: [], remaining: [] });
    expect(again.json.settled.map((s: { opId: string; outcome: string }) => [s.opId, s.outcome])).toEqual([
      [opIds[0], "applied"],
      [opIds[1], "applied"],
    ]);
    expect(await designRows()).toHaveLength(2);
    // Superseded, or never shown: not the athlete's.
    await db.update(coachProposals).set({ status: "superseded" }).where(eq(coachProposals.id, id));
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, {})).json).toEqual({ error: "not_pending", status: "superseded" });
  });

  it("another athlete's proposal is not found", async () => {
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 2) } }]);
    const other = await makeTestUser(db);
    const theirs = `${SESSION_COOKIE}=${await createSession(db, other.userId)}`;
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, {}, { as: theirs })).status).toBe(404);
    expect((await invoke("GET", `/api/coach/proposals/${id}/ops/x/draft`, undefined, { as: theirs })).status).toBe(404);
    expect(await designRows()).toEqual([]);
  });
});

// ── Edit before approve ─────────────────────────────────────────────────────────────────────────────────────────────

describe("edit before approve", () => {
  it("GET …/ops/:opId/draft answers the op's document as the builder loads one, with where it goes", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc({ title: "Friday hips" }), target: { kind: "new", date: addDays(today, 2), time: "17:30" } }]);
    const res = await invoke("GET", `/api/coach/proposals/${id}/ops/${opIds[0]}/draft`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      proposalId: id,
      opId: opIds[0],
      status: "pending",
      rev: null,
      date: addDays(today, 2),
      time: "17:30",
      target: { kind: "new", date: addDays(today, 2), time: "17:30" },
      outcome: null,
      doc: { title: "Friday hips", source: { kind: "coach" } },
      derived: { estimatedMinutes: expect.any(Number) },
    });
    expect(res.total).toBeLessThanOrEqual(4);
    expect((await invoke("GET", `/api/coach/proposals/${id}/ops/nope/draft`)).status).toBe(404);
  });

  it("an edited draft the server refuses is answered as a Studio save is: the builder says why, and nothing is recorded", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc({ title: "Soon" }), target: { kind: "new", date: addDays(today, 2) } }]);
    const draft = (await invoke("GET", `/api/coach/proposals/${id}/ops/${opIds[0]}/draft`)).json.doc;
    const past = await invoke("POST", `/api/coach/proposals/${id}/approve`, { edit: { opId: opIds[0], doc: draft, date: addDays(today, -1) } });
    expect(past.status).toBe(422);
    expect(past.json).toEqual({ error: "past_date" });
    const unknown = await invoke("POST", `/api/coach/proposals/${id}/approve`, { edit: { opId: opIds[0], doc: { ...draft, parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "notAMove", dose: { sets: 1, reps: 5 } }] }] } } });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error).toBe("invalid_doc");
    expect(unknown.json.issues.some((i: { code: string }) => i.code === "unknown_exercise")).toBe(true);
    expect((await proposalOf(id)).status).toBe("pending");
    const saved = await invoke("POST", `/api/coach/proposals/${id}/approve`, { edit: { opId: opIds[0], doc: { ...draft, title: "Soon, mine" } } });
    expect(saved.status).toBe(200);
    expect(saved.json.applied[0]).toMatchObject({ opId: opIds[0], edited: true, workout: { title: "Soon, mine" } });
  });

  it("a revision's draft whose workout changed elsewhere is 409 stale_revision with the revision there now", async () => {
    const made = await createDocWorkout(db, userId, { date: addDays(today, 3), doc: calmDoc({ title: "Mine" }) }, { today, now: nowInstant(), prefs });
    const { id, opIds } = await designed([{ doc: calmDoc({ title: "Coach's" }), target: { kind: "revise", workoutId: made.workout.id, baseRev: 1 } }]);
    await db.update(plannedWorkouts).set({ workoutDocRev: 2 }).where(eq(plannedWorkouts.id, made.workout.id));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, { edit: { opId: opIds[0], doc: calmDoc({ title: "Coach's, mine" }) } });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "stale_revision", rev: 2 });
  });
});

// ── Decline ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/coach/proposals/:id/decline", () => {
  it("with a reason: declined, the reason kept for the coach; some ops: those alone", async () => {
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "A" }), target: { kind: "new", date: addDays(today, 2) } },
      { doc: calmDoc({ title: "B" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    const some = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [opIds[0]], reason: "Not on a Tuesday." });
    expect(some.status).toBe(200);
    expect(some.json).toEqual({ ok: true, status: "pending", declined: [opIds[0]], settled: [] });
    const rest = await invoke("POST", `/api/coach/proposals/${id}/decline`, {});
    expect(rest.json).toEqual({ ok: true, status: "declined", declined: [opIds[1]], settled: [{ opId: opIds[0], outcome: "declined" }] });
    const ops = (await proposalOf(id)).ops as DesignedOp[];
    expect(ops.map((o) => o.outcome)).toEqual([
      { status: "declined", at: expect.any(String), reason: "Not on a Tuesday." },
      { status: "declined", at: expect.any(String) },
    ]);
    for (const body of [{ reason: 5 }, { opIds: ["nope"] }, { reasons: "x" }]) expect((await invoke("POST", `/api/coach/proposals/${id}/decline`, body)).status).toBe(400);
  });

  it("costs at most DECLINE_COST — the session, its restore check, the proposal, the plan read, the write, the receipt", async () => {
    const { id } = await designed([
      { doc: calmDoc({ title: "A" }), target: { kind: "new", date: addDays(today, 2) } },
      { doc: calmDoc({ title: "B" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, { reason: "Not this week." });
    expect(res.json.status).toBe("declined");
    expect(res.total).toBeLessThanOrEqual(DECLINE_COST);
  });

  it("an empty body declines the whole proposal, as the thread's decline does", async () => {
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 2) } }]);
    const res = await fetchNoBody(`/api/coach/proposals/${id}/decline`);
    expect(res.status).toBe(200);
    expect((await proposalOf(id)).status).toBe("declined");
  });
});

/** A POST with no body at all, as the thread panel sends its decline. */
async function fetchNoBody(path: string) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return app.request(path, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
}

// ── Reading it ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /api/coach/proposals/:id", () => {
  it("answers a designed proposal's manifest lines with each op's outcome", async () => {
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "A" }), target: { kind: "new", date: addDays(today, 2), time: "07:30" } },
      { doc: calmDoc({ title: "B" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[0]] });
    const res = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id, status: "partially_approved" });
    expect(res.json.lines.map((l: { opId: string; title: string; time: string | null; place: string; outcome: { status: string } | null }) => [l.opId, l.title, l.time, l.place, l.outcome?.status ?? null])).toEqual([
      [opIds[0], "A", "07:30", "Home", "applied"],
      // Untimed: the time its approve will use (B-I1) — the athlete's window, or after what the day already holds.
      [opIds[1], "B", expect.stringMatching(/^\d{2}:\d{2}$/), "Home", null],
    ]);
    expect(res.total).toBeLessThanOrEqual(5);
    const said = (res.json.lines as Array<{ time: string }>)[1]!.time;
    const approved = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [opIds[1]] });
    expect(approved.json.applied[0].workout.time).toBe(said);
  });
});

describe("the thread coach after a designed proposal is approved", () => {
  it("its state route lists it nowhere and shows the plain receipt; its context reads the receipt", async () => {
    const { id } = await designed([{ doc: calmDoc({ title: "Friday hips" }), target: { kind: "new", date: addDays(today, 2) } }]);
    await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    const state = await invoke("GET", "/api/coach/state");
    expect(state.status).toBe(200);
    expect(state.json.pendingProposals).toEqual([]);
    expect(state.json.settledProposals).toEqual([]);
    const receipt = (state.json.messages as Array<{ role: string; body: string; refs: { proposalId?: string } }>).find((m) => m.role === "receipt")!;
    // The workout named once (fix wave 3B, B-M8): the proposal is it.
    expect(receipt.body).toMatch(/^✓ approved — Friday hips: \w{3} \d{1,2} \w{3} · \d+ min$/);
    expect(receipt.refs).toEqual({ proposalId: id });
    const dossier = await buildDossier(db, userId, prefs, today);
    expect(dossier.text).toContain(receipt.body);
    expect(dossier.text).toContain("no pending proposals");
  });

  it("after a partial decline, its context names only the workouts still open", async () => {
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "A" }), target: { kind: "new", date: addDays(today, 2) } },
      { doc: calmDoc({ title: "B" }), target: { kind: "new", date: addDays(today, 4) } },
    ]);
    await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [opIds[0]] });
    const line = (await buildDossier(db, userId, prefs, today)).text.split("\n").find((l) => l.includes(`pending proposal [${id}]`));
    expect(line).toContain(`a designed workout for ${addDays(today, 4)},`);
    expect(line).not.toContain(addDays(today, 2));
  });
});

// The op id is the run's (Task 7's lever over the set names ops the same way).
it("ops are named by their runs in every answer", async () => {
  const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 2) } }]);
  const ops = (await proposalOf(id)).ops as DesignedOp[];
  expect(ops.map(opIdOf)).toEqual(opIds);
});
