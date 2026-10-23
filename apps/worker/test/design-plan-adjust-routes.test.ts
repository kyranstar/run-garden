/**
 * PLAN ADJUSTMENTS ON THE ROUTES (Stage 3 Task 8b; ruling I6, Option A) — and the thread coach's readers beside them.
 *
 *   POST /api/coach/proposals/:id/approve  — a designed proposal's changes go first, through the thread coach's own
 *        applier, within one request's budget; the rest come back in `remaining`
 *   POST /api/coach/proposals/:id/decline  — per change too
 *   GET  /api/coach/proposals/:id/ops/:opId/draft — a change has no draft: 404
 *   GET  /api/coach/proposals/:id — the workouts' `lines`, and the changes' own (`changes`)
 *   GET  /api/coach/state — never lists a designed proposal, a proposal of changes alone included
 *
 * With the coach designer off nothing a designed proposal holds is applied: a proposal of changes alone answers 409
 * `not_yet` like any designed one, never the thread's own approve. Measured as design-approve-routes.test.ts measures:
 * every D1 statement and fetch a request costs, its waitUntil work included, on a busy account, D1's bind cap on. The
 * routes use the real clock. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { buildDossier } from "../src/services/coach-context.js";
import { wake } from "../src/services/coach-wake.js";
import { APPLYING_STALE_MS, APPROVE_FIXED, DECLINE_COST, MOVE_COST, PLAN_BATCH_FIXED, REQUEST_BUDGET, SKIP_COST, ADJUST_COST, type DesignedOp } from "../src/services/design-approve.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { planAdjustId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { activateTmj, calmDoc } from "./doc-workout-fixture.js";
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
    AI_GATEWAY_API_KEY: "test-key",
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

/** A fortnight of planned runs (two a day on every third day). */
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
}

const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

/** A week's proposal: these changes by the main coach, then one designer per workout — reviewed and pending. */
async function designed(o: { changes: unknown[]; drafts?: Array<{ title: string; date: string }> }): Promise<{ id: string; opIds: string[] }> {
  const run = async (role: "main" | "designer", parentId: string | null) => {
    const id = `run-${newId()}`;
    await db.insert(schema.coachRuns).values({
      id, userId, parentId, role, scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    return { id, role, scope: { kind: "week" as const }, parentId, rehearsal: false };
  };
  const main = await run("main", null);
  const ctxOf = (r: ToolContext["run"]): ToolContext => ({ db, env: makeEnv(), userId, run: r, now: new Date(), toolUseId: `toolu_${newId()}` });
  for (const c of o.changes) {
    const res = await adjustPlan.run(ctxOf(main), c);
    if (isToolErr(res)) throw new Error(`adjust refused: ${res.error} — ${res.why}`);
  }
  const opIds: string[] = [];
  for (const d of o.drafts ?? []) {
    const designer = await run("designer", main.id);
    const res = await proposeWorkout.run(ctxOf(designer), { doc: calmDoc({ title: d.title }), target: { kind: "new", date: d.date } });
    if (isToolErr(res)) throw new Error(`propose refused: ${res.error} — ${res.why}`);
    opIds.push(designer.id);
  }
  const id = designProposalId(main.id);
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  const ops = (p!.ops as Array<DesignedOp | PlanAdjustOp>).map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x));
  await db.update(coachProposals).set({ status: "pending", ops }).where(eq(coachProposals.id, id));
  return { id, opIds };
}

async function invoke(method: string, path: string, body?: unknown, o: { designer?: boolean } = {}) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(o.designer ?? true),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements + fetches };
}

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const skip = (workoutId: string) => ({ workoutId, change: { kind: "skip", reason: "Rest the legs." }, why: "Heavy legs." });

// ── The switch ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("with the coach designer off", () => {
  it("a proposal of changes alone is a designed one: approve and decline answer not_yet, the draft and the lines are not there — nothing applied", async () => {
    const { id } = await designed({ changes: [skip("w-1-07:00")] });
    for (const action of ["approve", "decline"]) {
      const res = await invoke("POST", `/api/coach/proposals/${id}/${action}`, {}, { designer: false });
      expect([res.status, res.json]).toEqual([409, { error: "not_yet" }]);
    }
    expect((await invoke("GET", `/api/coach/proposals/${id}/ops/${planAdjustId("w-1-07:00")}/draft`, undefined, { designer: false })).status).toBe(404);
    expect((await invoke("GET", `/api/coach/proposals/${id}`, undefined, { designer: false })).json).toEqual({ id, status: "pending", resolvedAt: null });
    expect((await rowOf("w-1-07:00")).completionState).toBe("scheduled");
    expect((await proposalOf(id)).status).toBe("pending");
  });
});

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/coach/proposals/:id/approve with changes", () => {
  it("a 7-workout set and 3 changes approve in chunks — the changes first — every request within 45, until nothing remains", async () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1));
    const { id, opIds } = await designed({
      changes: [
        skip("w-1-07:00"),
        { workoutId: "w-2-07:00", change: { kind: "adjust", durationMinutes: 20 }, why: "Keep it short." },
        { workoutId: "w-4-07:00", change: { kind: "move", toDate: addDays(today, 5), toTime: "12:00" }, why: "A freer day." },
      ],
      drafts: days.map((date, i) => ({ title: `Day ${i + 1}`, date })),
    });
    const changes = [planAdjustId("w-1-07:00"), planAdjustId("w-2-07:00"), planAdjustId("w-4-07:00")];
    const costs: number[] = [];
    const chunks: string[][] = [];
    let remaining: string[] | null = null;
    for (let i = 0; remaining === null || remaining.length > 0; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
      const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status).toBe(200);
      costs.push(res.total);
      chunks.push([...(res.json.changed as Array<{ opId: string }>).map((c) => c.opId), ...(res.json.applied as Array<{ opId: string }>).map((a) => a.opId)]);
      remaining = res.json.remaining as string[];
    }
    // Pinned (measured 24, 28, 30, 20, 19, 19): the three changes, then the workouts two a request while their days' sessions
    // let them fit, one alone where its day now holds two (day 5 holds the session moved onto it).
    expect(chunks).toEqual([changes, opIds.slice(0, 2), opIds.slice(2, 4), opIds.slice(4, 5), opIds.slice(5, 6), opIds.slice(6)]);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    // The changes go first, together: their declared costs fit one request with the approve's own.
    expect(chunks[0]).toEqual(changes);
    expect(costs[0]).toBeLessThanOrEqual(APPROVE_FIXED + PLAN_BATCH_FIXED + SKIP_COST + (ADJUST_COST + 1) + (MOVE_COST + 1 + 1));
    expect(chunks.flat()).toEqual([...changes, ...opIds]);
    expect((await proposalOf(id)).status).toBe("approved");
    expect(await rowOf("w-1-07:00")).toMatchObject({ completionState: "skipped", sanctionedBy: "coach" });
    expect((await rowOf("w-2-07:00")).fallbackEstimatedDurationSeconds).toBe(1200);
    expect((await rowOf("w-4-07:00")).effectiveDate).toBe(addDays(today, 5));
    // One receipt, when nothing remained.
    expect(await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")))).toHaveLength(1);
  });

  it("a move of a session COROS holds queues the watch's move as the thread coach's does, and says the client may drain", async () => {
    await db.insert(schema.providerConnections).values({ id: newId(), userId, provider: "coros", status: "connected", createdAt: nowInstant(), updatedAt: nowInstant() } as never);
    await db.update(plannedWorkouts).set({ lastVerifiedCorosDate: addDays(today, 2), sourceWorkoutId: "123:9", sourceIdInPlan: "9", sourceProgramId: "p-1" }).where(eq(plannedWorkouts.id, "w-2-07:00"));
    await db.insert(schema.userPreferences).values({ userId, prefs: { ...prefs, corosWritesEnabled: true }, updatedAt: nowInstant() } as never).onConflictDoUpdate({ target: schema.userPreferences.userId, set: { prefs: { ...prefs, corosWritesEnabled: true } } });
    const { id } = await designed({ changes: [{ workoutId: "w-2-07:00", change: { kind: "move", toDate: addDays(today, 4) }, why: "A freer day." }] });
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.json).toMatchObject({ ok: true, status: "approved", coachDrain: true });
    const jobs = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, "w-2-07:00"));
    expect(jobs.map((j) => [j.kind, j.destinationDate])).toEqual([["move_scheduled_workout", addDays(today, 4)]]);
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + PLAN_BATCH_FIXED + MOVE_COST + 1 + 1);
  });

  it("a length proposed before the athlete kept the watch's version is refused at the approve in plain words — the session untouched, nothing for the watch; the rest applied within a plain request's cost (review L1)", async () => {
    await db.insert(schema.providerConnections).values({ id: newId(), userId, provider: "coros", status: "connected", createdAt: nowInstant(), updatedAt: nowInstant() } as never);
    await db.insert(schema.userPreferences).values({ userId, prefs: { ...prefs, corosWritesEnabled: true }, updatedAt: nowInstant() } as never).onConflictDoUpdate({ target: schema.userPreferences.userId, set: { prefs: { ...prefs, corosWritesEnabled: true } } });
    // A COROS session on the watch, its own steps.
    await db
      .update(plannedWorkouts)
      .set({ lastVerifiedCorosDate: addDays(today, 2), sourceWorkoutId: "123:9", sourceIdInPlan: "9", sourceProgramId: "p-1", sourceContentFingerprint: "0123456789abcdef" })
      .where(eq(plannedWorkouts.id, "w-2-07:00"));
    await db.insert(schema.plannedWorkoutStages).values({ id: "w-2-07:00:s0", workoutId: "w-2-07:00", ord: 0, kind: "work", durationType: "time", durationSeconds: 1800, label: "easy" } as never);
    const { id } = await designed({
      changes: [
        skip("w-1-07:00"),
        { workoutId: "w-2-07:00", change: { kind: "adjust", durationMinutes: 20 }, why: "Keep it short." },
        { workoutId: "w-4-07:00", change: { kind: "move", toDate: addDays(today, 5), toTime: "12:00" }, why: "A freer day." },
      ],
    });
    // Then the athlete keeps the watch's version (watch-copy-marker.ts): the next read takes the watch's copy whole, its
    // length with it — the plan's length would be undone without a word.
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: "take-watch-copy:0123456789abcdef" }).where(eq(plannedWorkouts.id, "w-2-07:00"));
    const before = await rowOf("w-2-07:00");
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect((res.json.changed as Array<{ opId: string }>).map((c) => c.opId)).toEqual([planAdjustId("w-1-07:00"), planAdjustId("w-4-07:00")]);
    expect(res.json.refused).toEqual([
      { opId: planAdjustId("w-2-07:00"), error: "not_editable", cause: "unknown", why: "This session follows the watch's version until the next sync — change it after that." },
    ]);
    expect(res.json.remaining).toEqual([]);
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + PLAN_BATCH_FIXED + SKIP_COST + (ADJUST_COST + 1) + (MOVE_COST + 1 + 1));
    // Nothing written: its length and its mark (the read still takes the watch's copy), and no write queued.
    expect(await rowOf("w-2-07:00")).toEqual(before);
    expect(await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, "w-2-07:00"))).toEqual([]);
  });
});

describe("decline, the draft and the proposal's read", () => {
  it("declines one change with a reason; the draft of a change is 404; the read answers the changes' lines — within 5", async () => {
    const { id, opIds } = await designed({ changes: [skip("w-1-07:00")], drafts: [{ title: "Hips", date: addDays(today, 2) }] });
    const d = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [planAdjustId("w-1-07:00")], reason: "Not this one." });
    expect(d.json).toMatchObject({ ok: true, status: "pending", declined: [planAdjustId("w-1-07:00")] });
    expect(d.total).toBeLessThanOrEqual(DECLINE_COST);
    expect((await invoke("GET", `/api/coach/proposals/${id}/ops/${planAdjustId("w-1-07:00")}/draft`)).status).toBe(404);
    const read = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(read.total).toBeLessThanOrEqual(5);
    expect(read.json.lines.map((l: { opId: string }) => l.opId)).toEqual(opIds);
    expect(read.json.changes).toEqual([
      {
        opId: planAdjustId("w-1-07:00"),
        kind: "skip",
        workoutId: "w-1-07:00",
        date: addDays(today, 1),
        time: null,
        summary: "Easy run — skipped",
        was: null,
        effect: "comes off the plan — Rest the legs.",
        why: "Heavy legs.",
        // Its advisory notes (Task 9's card shows them; design-manifest-review.test.ts pins them).
        issues: expect.any(Array),
        outcome: { status: "declined", at: expect.any(String), reason: "Not this one." },
      },
    ]);
  });
});

describe("fix round: decline while a change is applying, and ten changes at once", () => {
  /** A proposal whose skip an approve claimed (`at`: now, within the window — the approve is applying it still). */
  async function withSkipApplying(at = nowInstant()): Promise<{ id: string; opIds: string[] }> {
    const made = await designed({ changes: [skip("w-1-07:00")], drafts: [{ title: "Hips", date: addDays(today, 2) }] });
    await claimedAt(made.id, at);
    return made;
  }
  /** The proposal's claims made at `at`. */
  async function claimedAt(id: string, at: string): Promise<void> {
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const ops = (p!.ops as Array<DesignedOp | PlanAdjustOp>).map((o) =>
      o.kind === "plan_adjust" ? { ...o, outcome: { status: "applying", at, before: { date: addDays(today, 1), time: "07:00", title: "Easy run", minutes: 30 } } } : o,
    );
    await db.update(coachProposals).set({ ops }).where(eq(coachProposals.id, id));
  }
  /** A claim the window has passed: its request died. */
  const stale = () => new Date(Date.now() - APPLYING_STALE_MS).toISOString();

  it("a decline meeting a change an approve is applying declines the others — 200, the change named in flight, the status as its ops say", async () => {
    const { id, opIds } = await withSkipApplying();
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, { reason: "Not now." });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: "pending", declined: opIds, settled: [], inFlight: [planAdjustId("w-1-07:00")] });
    expect(res.total).toBeLessThanOrEqual(DECLINE_COST);
    // Within the window, an approve of it alone leaves it to the approve applying it: 409 in_flight.
    const meanwhile = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [planAdjustId("w-1-07:00")] });
    expect(meanwhile.status).toBe(409);
    expect(meanwhile.json).toEqual({ error: "in_flight", opIds: [planAdjustId("w-1-07:00")], status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [] });
    expect((await rowOf("w-1-07:00")).completionState).toBe("scheduled");
    // Named with the workout the decline settled: 200, that op settled as it was, the change in flight.
    const both = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(both.status).toBe(200);
    expect(both.json).toMatchObject({ ok: true, inFlight: [planAdjustId("w-1-07:00")], settled: [{ opId: opIds[0], outcome: "declined" }] });
    // Past the window its request died: the approve takes it over, and records it applied.
    await claimedAt(id, stale());
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId("w-1-07:00")]);
    expect((await rowOf("w-1-07:00")).completionState).toBe("skipped");
  });

  it("an approve meeting a change another approve is applying: 200 for the rest with it named in flight — the applier never run for it", async () => {
    const { id, opIds } = await withSkipApplying();
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "partially_approved", inFlight: [planAdjustId("w-1-07:00")], changed: [], refused: [], remaining: [] });
    expect(res.json.applied.map((a: { opId: string }) => a.opId)).toEqual(opIds);
    expect((await rowOf("w-1-07:00")).completionState).toBe("scheduled");
    expect(((await proposalOf(id)).ops as Array<{ kind: string; outcome?: unknown }>).find((o) => o.kind === "plan_adjust")!.outcome).toMatchObject({ status: "applying" });
  });

  it("an approve applying one change while another approve holds the other: 200, the one changed, the other in flight", async () => {
    const { id } = await designed({ changes: [skip("w-1-07:00"), skip("w-2-07:00")] });
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const ops = (p!.ops as PlanAdjustOp[]).map((o) =>
      o.op.workoutId === "w-1-07:00" ? { ...o, outcome: { status: "applying", at: nowInstant(), before: { date: addDays(today, 1), time: "07:00", title: "Easy run", minutes: 30 } } } : o,
    );
    await db.update(coachProposals).set({ ops }).where(eq(coachProposals.id, id));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, inFlight: [planAdjustId("w-1-07:00")], applied: [], refused: [], settled: [], remaining: [] });
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId("w-2-07:00")]);
    expect((await rowOf("w-1-07:00")).completionState).toBe("scheduled");
  });

  it("a decline re-judging a claim past the window costs at most DECLINE_COST: not made, declined — made, recorded applied with its day's replay", async () => {
    const notMade = await withSkipApplying(stale());
    const res = await invoke("POST", `/api/coach/proposals/${notMade.id}/decline`, { reason: "Not now." });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: "declined", declined: [planAdjustId("w-1-07:00"), ...notMade.opIds], settled: [] });
    expect(res.total).toBeLessThanOrEqual(DECLINE_COST);

    const made = await withSkipApplying(stale());
    await db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: today }).where(eq(plannedWorkouts.id, "w-1-07:00"));
    const again = await invoke("POST", `/api/coach/proposals/${made.id}/decline`, { reason: "Not now." });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, status: "partially_approved", declined: made.opIds, settled: [{ opId: planAdjustId("w-1-07:00"), outcome: "applied", workoutId: "w-1-07:00" }] });
    expect(again.total).toBeLessThanOrEqual(DECLINE_COST);
    const [account] = await db.select().from(schema.accountState).where(eq(schema.accountState.userId, userId));
    expect(account?.gardenChangedFrom).toBe(today);
  });

  it("a decline of nothing but changes in flight answers 409 in_flight: nothing was declined, nothing changed", async () => {
    const { id } = await withSkipApplying();
    const before = (await proposalOf(id)).ops;
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [planAdjustId("w-1-07:00")], reason: "Not now." });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "in_flight", opIds: [planAdjustId("w-1-07:00")], status: "pending", declined: [], settled: [] });
    expect((await proposalOf(id)).ops).toEqual(before);
    expect(await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")))).toEqual([]);
  });

  it("a decline naming a change in flight and an op decided before answers 200: not every op named was in flight", async () => {
    const { id, opIds } = await withSkipApplying();
    // The workout was approved earlier: its op is settled.
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds })).json.applied).toHaveLength(1);
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [...opIds, planAdjustId("w-1-07:00")] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, declined: [], inFlight: [planAdjustId("w-1-07:00")], settled: [{ opId: opIds[0], outcome: "applied" }] });
  });

  it("a proposal of ten changes (the most one holds) approves whole, every request within 45 and its opIds within the route's cap", async () => {
    const changes = Array.from({ length: 10 }, (_, i) => skip(`w-${i + 1}-07:00`));
    const { id } = await designed({ changes });
    const costs: number[] = [];
    let remaining: string[] | null = null;
    for (let i = 0; remaining === null || remaining.length > 0; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
      expect((remaining ?? []).length).toBeLessThanOrEqual(20);
      const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status).toBe(200);
      costs.push(res.total);
      remaining = res.json.remaining as string[];
    }
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect((await proposalOf(id)).status).toBe("approved");
    for (let i = 1; i <= 10; i++) expect((await rowOf(`w-${i}-07:00`)).completionState).toBe("skipped");
  });
});

describe("a proposal of changes alone, read", () => {
  it("answers its changes and no workouts' lines, with no place read", async () => {
    const { id } = await designed({ changes: [skip("w-1-07:00")] });
    const read = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(read.json.lines).toEqual([]);
    expect(read.json.changes.map((c: { opId: string; summary: string }) => [c.opId, c.summary])).toEqual([[planAdjustId("w-1-07:00"), "Easy run — skipped"]]);
    // The session, the proposal: no place to name.
    expect(read.total).toBeLessThanOrEqual(4);
  });
});

// ── The thread coach ────────────────────────────────────────────────────────────────────────────────────────────────

describe("the thread coach's readers tolerate changes in a designed proposal", () => {
  it("GET /api/coach/state lists neither a designed proposal with changes nor one of changes alone", async () => {
    const mixed = await designed({ changes: [skip("w-1-07:00")], drafts: [{ title: "Hips", date: addDays(today, 2) }] });
    const alone = await designed({ changes: [skip("w-2-07:00")] });
    await db.insert(coachMessages).values({ id: "m1", userId, role: "receipt", body: "✓ approved — x", refs: { proposalId: alone.id }, at: nowInstant() });
    const res = await invoke("GET", "/api/coach/state");
    expect(res.status).toBe(200);
    const ids = [...res.json.pendingProposals, ...res.json.settledProposals].map((p: { id: string }) => p.id);
    expect(ids).not.toContain(mixed.id);
    expect(ids).not.toContain(alone.id);
  });

  it("the wake's context names them, and its supersede step leaves them alone", async () => {
    const alone = await designed({ changes: [skip("w-1-07:00")] });
    const mixed = await designed({ changes: [skip("w-2-07:00")], drafts: [{ title: "Hips", date: addDays(today, 3) }] });
    const d = await buildDossier(db, userId, prefs, today);
    const lines = d.text.split("\n");
    expect(lines.find((l) => l.includes(`pending proposal [${alone.id}]`))).toBe(
      `pending proposal [${alone.id}]: Easy run — skipped (a designed proposal: 1 change to a session already planned, waiting for the athlete in the Studio)`,
    );
    expect(lines.find((l) => l.includes(`pending proposal [${mixed.id}]`))).toBe(
      `pending proposal [${mixed.id}]: Hips · 1 plan change (a designed workout for ${addDays(today, 3)} and 1 change to a session already planned, waiting for the athlete in the Studio)`,
    );

    const output = {
      briefing: "Ease tomorrow.",
      proposals: [
        {
          title: "Ease tomorrow",
          evidence: "e",
          rationale: "r",
          expiresAt: addDays(today, 1),
          flags: [],
          ops: [{ kind: "ease", workoutId: "w-1-07:00", session: { category: "easy", title: "Steady 20", durationMinutes: 20, run: { blocks: [{ kind: "duration", value: 20 }] } } }],
        },
      ],
      question: null,
      memoryOps: [],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 400 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await wake(db, makeEnv(), userId, prefs, { kind: "message", body: "ease tomorrow" }, fetchImpl);
    expect(res.status).toBe("ok");
    expect((await proposalOf(alone.id)).status).toBe("pending");
    expect((await proposalOf(mixed.id)).status).toBe("pending");
  });
});
