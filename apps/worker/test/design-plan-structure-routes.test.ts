/**
 * A WHOLE PLAN, APPROVED (§8 §5, stream W): a designed proposal's `plan_structure` op — propose_plan's — is applied
 * through the approve route after the changes and before the workouts, a chunk a request through the thread coach's own
 * appliers (coach-apply.ts `applyStructuralChunk`, stream P), its progress kept on its claim, answering `remaining` until
 * it is done. Every request within 45 statements and fetches, its waitUntil work included, on a busy account with D1's
 * bind cap on — as design-plan-adjust-routes.test.ts measures. The routes use the real clock. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes, sweepExpiredProposals } from "../src/routes/coach.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { APPLYING_STALE_MS, approveDesignOps, REQUEST_BUDGET, type DesignedStructureOp } from "../src/services/design-approve.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { mondayOf, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { coachProposals, coachMessages, plannedWorkouts, coachPlans, coachPlanWeeks } = schema;

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
    COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements = 0;
let fetches = 0;
/** The first Monday at least a week away: a plan's first week. */
let monday: string;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  monday = mondayOf(addDays(today, 7));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  await busyAccount();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A month of planned runs from the watch's plan, one a day. */
async function busyAccount(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const date = addDays(today, i);
    const id = `w-${i}`;
    await db.insert(plannedWorkouts).values({
      id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00",
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
  }
}

const easy = (minutes: number, title = "Easy run") => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });
const lift = (title: string) => ({ category: "strength", title, durationMinutes: 40, lift: { exercises: [{ name: "Goblet squat", sets: 3, reps: 8 }, { name: "Plank", sets: 3, holdSeconds: 30 }] } });

/** A block of `perWeek` sessions a week over its first `weeks` weeks (1 or 2), then two shape weeks. */
function createPlan(o: { perWeek: number; weeks?: number; discipline?: "run" | "lift" }) {
  const sessions: Array<{ date: string; session: unknown }> = [];
  for (let w = 0; w < (o.weeks ?? 1); w++) {
    for (let n = 0; n < o.perWeek; n++) {
      const date = addDays(monday, 7 * w + (n % 7));
      sessions.push({ date, session: o.discipline === "lift" ? lift(`Strength ${w + 1}.${n + 1}`) : easy(30 + n, `Run ${w + 1}.${n + 1}`) });
    }
  }
  const weeks = o.weeks ?? 1;
  return {
    kind: "createPlan",
    discipline: o.discipline ?? "run",
    name: "Base block",
    startDate: monday,
    endDate: addDays(monday, 7 * (weeks + 2) - 1),
    firmSessions: sessions,
    shapeWeeks: [0, 1].map((k) => ({ weekStart: addDays(monday, 7 * (weeks + k)), volumeTarget: "about 30 km", keySessions: ["long run"] })),
  };
}

/** A main run's plan proposal, made pending as its finish makes it — with these changes to sessions on the plan first
 * (adjust_plan's, in the same proposal). */
async function planned(change: unknown, changes: unknown[] = []): Promise<string> {
  const id = `run-${newId()}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Plan my next weeks", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const ctx: ToolContext = { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  for (const c of changes) {
    const made = await adjustPlan.run({ ...ctx, toolUseId: `toolu_${newId()}` }, c);
    if (isToolErr(made)) throw new Error(`adjust_plan refused: ${made.error} — ${made.why}`);
  }
  const res = await proposePlan.run(ctx, { change, why: "A steady build." });
  if (isToolErr(res)) throw new Error(`propose_plan refused: ${res.error} — ${res.why}`);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(id)));
  return designProposalId(id);
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements + fetches };
}

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const planOp = async (id: string) => ((await proposalOf(id)).ops as unknown[]).find((o) => (o as { kind?: string }).kind === "plan_structure") as DesignedStructureOp;
const sessionsOf = async (planId: string) =>
  db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.planId, planId)));

/** Approve until nothing remains: each request's answer and cost. */
async function approveAll(id: string) {
  const answers: Array<Record<string, any>> = [];
  const costs: number[] = [];
  let remaining: string[] | null = null;
  for (let i = 0; remaining === null || remaining.length > 0; i++) {
    if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    answers.push(res.json);
    costs.push(res.total);
    remaining = res.json.remaining as string[];
  }
  return { answers, costs };
}

describe("approving a whole plan", () => {
  it("a new block of 7 sessions: a chunk a request, each within 45, `remaining` until done — the plan, its sessions, its weeks, the receipt once", async () => {
    const id = await planned(createPlan({ perWeek: 7 }));
    const { answers, costs } = await approveAll(id);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    console.log(`[plan approve] 7 run sessions: ${costs.length} requests, statements ${costs.join(", ")}`);
    expect(answers.length).toBeGreaterThanOrEqual(2);
    // Every answer but the last says the plan remains; the last says what was added.
    for (const a of answers.slice(0, -1)) expect(a.remaining).toEqual(["plan"]);
    const last = answers.at(-1)!;
    expect(last.status).toBe("approved");
    expect(last.planned).toEqual([{ opId: "plan", summary: expect.any(String) }]);
    const planId = `cp-${id}-0`;
    const [plan] = await db.select().from(coachPlans).where(eq(coachPlans.id, planId));
    expect(plan).toMatchObject({ userId, name: "Base block", status: "active", startDate: monday });
    const rows = await sessionsOf(planId);
    expect(rows.filter((r) => !r.archivedAt).map((r) => r.title).sort()).toEqual(Array.from({ length: 7 }, (_, n) => `Run 1.${n + 1}`).sort());
    const weeks = await db.select().from(coachPlanWeeks).where(eq(coachPlanWeeks.planId, planId));
    expect(weeks.filter((w) => w.state === "shape").map((w) => w.weekStart).sort()).toEqual([addDays(monday, 7), addDays(monday, 14)]);
    expect((await planOp(id)).outcome).toMatchObject({ status: "applied", summary: last.planned[0].summary });
    const receipts = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")));
    expect(receipts.map((r) => r.body)).toEqual([`✓ approved — Base block: ${last.planned[0].summary}`]);
    expect(last.planned[0].summary).toMatch(/7 sessions/);
    // Asked again: settled, nothing more written.
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.json).toMatchObject({ status: "approved", settled: [{ opId: "plan", outcome: "applied" }], remaining: [] });
    expect((await sessionsOf(planId)).length).toBe(7);
  });

  it("forty sessions over two weeks of lifts: every request within 45, until all forty are on the plan", async () => {
    const id = await planned(createPlan({ perWeek: 20, weeks: 2, discipline: "lift" }));
    const { answers, costs } = await approveAll(id);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    console.log(`[plan approve] 40 lift sessions: ${costs.length} requests, statements ${costs.join(", ")}`);
    expect(answers.at(-1)!.status).toBe("approved");
    expect((await sessionsOf(`cp-${id}-0`)).filter((r) => !r.archivedAt)).toHaveLength(40);
    // Between requests the plan read sensibly: the claim released at once (the next request took it straight over).
    expect(answers.filter((a) => (a.inFlight ?? []).length > 0)).toEqual([]);
  });

  it("an extension: one request, the block's end moved, its weeks added", async () => {
    const first = await planned(createPlan({ perWeek: 3 }));
    await approveAll(first);
    const planId = `cp-${first}-0`;
    const id = await planned({ kind: "extendPlan", planId, shapeWeeks: [addDays(monday, 21), addDays(monday, 28)].map((weekStart) => ({ weekStart, volumeTarget: "about 32 km", keySessions: [] })) });
    const { answers, costs } = await approveAll(id);
    expect(answers).toHaveLength(1);
    expect(costs[0]).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect((await db.select().from(coachPlans).where(eq(coachPlans.id, planId)))[0]!.endDate).toBe(addDays(monday, 34));
  });

  it("a claim another approve holds is in flight (409 when nothing else was named); stale, the next approve takes it over where it got to", async () => {
    const id = await planned(createPlan({ perWeek: 7 }));
    const first = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(first.json.remaining).toEqual(["plan"]);
    const progress = (await planOp(id)).outcome;
    expect(progress).toMatchObject({ status: "applying", progress: expect.objectContaining({ step: expect.any(String) }) });
    // Released at once: its `at` is already stale.
    expect(Date.now() - Date.parse((progress as { at: string }).at)).toBeGreaterThanOrEqual(APPLYING_STALE_MS);
    // A request that claimed it and is still at work: fresh.
    const ops = ((await proposalOf(id)).ops as DesignedStructureOp[]).map((o) => ({ ...o, outcome: { ...o.outcome!, at: nowInstant() } }));
    await db.update(coachProposals).set({ ops }).where(eq(coachProposals.id, id));
    const held = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect([held.status, held.json.error, held.json.opIds]).toEqual([409, "in_flight", ["plan"]]);
    // Its request died: stale, taken over and finished.
    const stale = ops.map((o) => ({ ...o, outcome: { ...o.outcome!, at: new Date(Date.now() - APPLYING_STALE_MS - 1000).toISOString() } }));
    await db.update(coachProposals).set({ ops: stale }).where(eq(coachProposals.id, id));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)!.status).toBe("approved");
    expect((await sessionsOf(`cp-${id}-0`)).filter((r) => !r.archivedAt)).toHaveLength(7);
  });

  it("a plan not started declines as any change does; one started is never declined half-made (in flight) and never expired under the athlete", async () => {
    const declined = await planned(createPlan({ perWeek: 3 }));
    const no = await invoke("POST", `/api/coach/proposals/${declined}/decline`, { reason: "Not now" });
    expect(no.json).toMatchObject({ status: "declined", declined: ["plan"] });
    expect(await sessionsOf(`cp-${declined}-0`)).toEqual([]);

    const started = await planned(createPlan({ perWeek: 7 }));
    expect((await invoke("POST", `/api/coach/proposals/${started}/approve`, {})).json.remaining).toEqual(["plan"]);
    const decline = await invoke("POST", `/api/coach/proposals/${started}/decline`, {});
    expect([decline.status, decline.json.error, decline.json.opIds]).toEqual([409, "in_flight", ["plan"]]);
    // Its expiry passes: the sweep leaves it, the approve finishes it.
    await db.update(coachProposals).set({ expiresAt: addDays(today, -1) }).where(eq(coachProposals.id, started));
    expect(await sweepExpiredProposals(db, userId, today)).toBe(0);
    expect((await proposalOf(started)).status).toBe("pending");
    expect((await approveAll(started)).answers.at(-1)!.status).toBe("approved");
    // One not started whose expiry passed is expired, as any suggestion is.
    const late = await planned(createPlan({ perWeek: 3 }));
    await db.update(coachProposals).set({ expiresAt: addDays(today, -1) }).where(eq(coachProposals.id, late));
    const expired = await invoke("POST", `/api/coach/proposals/${late}/approve`, {});
    expect([expired.status, expired.json]).toEqual([409, { error: "not_pending", status: "expired" }]);
  });

  it("a plan its applier refuses — its block retired by hand since — is refused in the applier's words, nothing applied", async () => {
    const first = await planned(createPlan({ perWeek: 3 }));
    await approveAll(first);
    const planId = `cp-${first}-0`;
    const id = await planned({ kind: "extendPlan", planId, shapeWeeks: [{ weekStart: addDays(monday, 21), volumeTarget: "x", keySessions: [] }] });
    await db.delete(coachPlans).where(eq(coachPlans.id, planId));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.json.refused).toEqual([{ opId: "plan", error: "plan_refused", why: expect.stringMatching(/isn't there any more/) }]);
    expect((await planOp(id)).outcome).toMatchObject({ status: "refused", error: "plan_refused" });
  });

  it("with watch writes on, the sessions' creates wait for the client to drain them", async () => {
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: true });
    const id = await planned(createPlan({ perWeek: 3 }));
    const { answers } = await approveAll(id);
    expect(answers.some((a) => a.coachDrain === true)).toBe(true);
  });

  it("beside changes to the plan: the changes first, the plan only when the request has room for a chunk — every request within 45", async () => {
    const id = await planned(createPlan({ perWeek: 7 }), [{ workoutId: "w-2", change: { kind: "move", toDate: addDays(today, 3), toTime: "12:00" }, why: "A freer day." }]);
    // The move takes most of the first request: the plan waits for the next, untouched (no claim, no chunk).
    const first = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(first.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(first.json.changed.map((c: { opId: string }) => c.opId)).toEqual(["adj-w-2"]);
    expect(first.json.remaining).toEqual(["plan"]);
    expect(first.json.planned).toBeUndefined();
    expect((await planOp(id)).outcome).toBeUndefined();
    const { answers, costs } = await approveAll(id);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(answers.at(-1)!.status).toBe("approved");
    // Its ids are the applier's, by the op's place in the proposal: the change first, the plan second.
    expect((await sessionsOf(`cp-${id}-1`)).filter((r) => !r.archivedAt)).toHaveLength(7);
  });

  it("a plan not started whose first day has gone is refused (its sessions would start in the past), nothing applied", async () => {
    const id = await planned(createPlan({ perWeek: 3 }));
    const p = await proposalOf(id);
    const later = addDays(monday, 1);
    const answer = await approveDesignOps(db, userId, { id: p.id, title: p.title, status: p.status, ops: p.ops, resolvedAt: p.resolvedAt }, {}, { today: later, now: nowInstant(), prefs });
    expect(answer.refused).toEqual([{ opId: "plan", error: "past_date", why: expect.stringMatching(/has passed/) }]);
    expect(await db.select().from(coachPlans).where(eq(coachPlans.id, `cp-${id}-0`))).toEqual([]);
  });

  it("the manifest gives the plan's own lines and how it stands", async () => {
    const id = await planned(createPlan({ perWeek: 3 }));
    const before = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(before.json.plans).toEqual([
      expect.objectContaining({ opId: "plan", kind: "createPlan", title: "Base block", why: "A steady build.", outcome: null, lines: expect.arrayContaining([expect.stringMatching(/^.* · Run 1\.1 · 30 min$/)]) }),
    ]);
    await approveAll(id);
    const after = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(after.json.plans[0].outcome).toMatchObject({ status: "applied" });
  });

  it("a newer plan for the same block supersedes the older one still open; one being applied is never superseded", async () => {
    const older = await planned(createPlan({ perWeek: 3 }));
    const newer = await planned({ ...createPlan({ perWeek: 7 }), name: "Base block, every day" });
    await supersedeOlderPlans(db, userId, newer, nowInstant());
    expect((await proposalOf(older)).status).toBe("superseded");
    expect((await planOp(older)).outcome).toMatchObject({ status: "superseded", by: newer });
    // A different discipline is another plan: not covered.
    const strength = await planned(createPlan({ perWeek: 2, discipline: "lift" }));
    const newest = await planned({ ...createPlan({ perWeek: 2 }), name: "Base block again" });
    expect((await invoke("POST", `/api/coach/proposals/${newer}/approve`, {})).json.remaining).toEqual(["plan"]);
    await supersedeOlderPlans(db, userId, newest, nowInstant());
    expect((await proposalOf(newer)).status).toBe("pending");
    expect((await planOp(newer)).outcome?.status).toBe("applying");
    expect((await proposalOf(strength)).status).toBe("pending");
    // Nothing of the superseded one was ever written.
    expect(await db.select().from(coachPlans).where(like(coachPlans.id, `cp-${older}%`))).toEqual([]);
  });
});
