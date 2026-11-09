/**
 * THE APPROVAL CONTRACT (a request names what it approves; a change's session must still be the one its card drew).
 *
 * A request naming no ops reaches only the two kinds the whole-suggestion card draws, a workout and a change to a session;
 * every other kind is approved by name and is said back in `notNamed`. A `plan_adjust` whose session moved on since its
 * card was drawn is refused `changed_since_suggested`, nothing written, the other ops going on. Synthetic data only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { planRoutes } from "../src/routes/plan.js";
import { CHANGED_SINCE_CARD } from "../src/services/design-approve.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { createObjective } from "../src/services/objectives.js";
import { objectiveChangeId, planAdjustId, planChangeId } from "../src/services/proposal-kinds.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachProposals, coachRuns, plannedWorkouts, programs } = schema;
const NOW = "2026-10-05T19:00:00.000Z";
const day = (n: number) => addDays("2026-10-05", n);
const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", COACH_DESIGNER: "1" } as Env;

let migrated: Db;
let db: Db;
let userId: string;
let cookie: string;
let writes: string[];

beforeAll(() => {
  migrated = makeTestDb();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  writes = [];
  db = cloneTestDb(migrated, { boundVariableCap: 100, onStatement: (s) => void (isWrite(s) && writes.push(s)) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function post(path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  app.route("/api/plan", planRoutes);
  const pending: Promise<unknown>[] = [];
  const res = await app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} } as never);
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const approve = (id: string, body: unknown) => post(`/api/coach/proposals/${id}/approve`, body);

async function session(id: string, date: string) {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Tempo", category: "quality", qualitySubtype: "tempo", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00",
    sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 2400, fallbackEstimatedDurationSeconds: 2400, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  return id;
}
async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({ id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "x", status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW });
  return { db, env, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `t_${newId()}` };
}
async function act(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const r = await ACT_TOOLS.find((t) => t.name === name)!.run({ ...ctx, toolUseId: `t_${newId()}` }, input);
  if (isToolErr(r)) throw new Error(`${name}: ${r.error} ${r.why}`);
}
const shown = async (ctx: ToolContext) => {
  const id = designProposalId(ctx.run.id);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
  return id;
};
const adjust = (workoutId: string, c: Record<string, unknown>) => ({ workoutId, change: c, why: "It fits the week." });
async function changes(...inputs: Array<ReturnType<typeof adjust>>) {
  const ctx = await mainRun();
  for (const c of inputs) await act(ctx, "adjust_plan", c);
  return shown(ctx);
}
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

describe("a request naming nothing", () => {
  async function aPlanChangeAndAnObjectiveBeside() {
    const w = await session("w-1", day(1));
    const planId = `plan-${newId()}`;
    await db.insert(programs).values({ id: planId, userId, kind: "coach", name: "Base block", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, purpose: "Get fitter", brief: "Base block.", onEnd: "ask", createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
    const o = await createObjective(db, userId, { title: "Strong legs", keyResults: [{ label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" }] }, NOW);
    const krId = o.keyResults[0]!.id;
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", adjust(w, { kind: "skip", reason: "Rest." }));
    await act(ctx, "change_plan", { planId, why: "You asked.", brief: "The coach's brief." });
    await act(ctx, "propose_objective", { change: "retarget", keyResultId: krId, target: 90, why: "Your wall sit is at 45 s of 120 s with half the time gone: 90 s is honest.", basis: "stand" });
    return { id: await shown(ctx), w, planId, named: [planChangeId(planId), objectiveChangeId("retarget", krId)] };
  }

  it("reaches the change, leaves each kind with its own card open, and says which", async () => {
    const { id, w, planId, named } = await aPlanChangeAndAnObjectiveBeside();
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "partially_approved", notNamed: named });
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(w)]);
    expect((await db.select().from(programs).where(eq(programs.id, planId)))[0]!.brief).toBe("Base block.");
    const byName = await approve(id, { opIds: named });
    expect(byName.json.status).toBe("approved");
    expect(byName.json.notNamed).toBeUndefined();
    expect((await db.select().from(programs).where(eq(programs.id, planId)))[0]!.brief).toBe("The coach's brief.");
  });

  it("a proposal of nothing but such kinds: 200, nothing written, `notNamed` says why", async () => {
    const planId = `plan-${newId()}`;
    await db.insert(programs).values({ id: planId, userId, kind: "coach", name: "Base block", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, purpose: "Get fitter", brief: "Base block.", onEnd: "ask", createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
    const ctx = await mainRun();
    await act(ctx, "change_plan", { planId, why: "You asked.", brief: "The coach's brief." });
    const id = await shown(ctx);
    writes.length = 0;
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [], notNamed: [planChangeId(planId)] });
    expect(writes).toEqual([]);
  });
});

describe("a change whose session moved on since its card", () => {
  const move = { toDate: day(4), toTime: "17:30" };

  it.each([
    ["another day", async (w: string) => void (await post(`/api/plan/workouts/${w}/move`, move))],
    ["a time asked for", async (w: string) => void (await post(`/api/plan/workouts/${w}/move`, { toDate: day(1), toTime: "17:30" }))],
    ["another length", async (w: string) => void (await db.update(plannedWorkouts).set({ fallbackEstimatedDurationSeconds: 3000 }).where(eq(plannedWorkouts.id, w)))],
    ["another name", async (w: string) => void (await db.update(plannedWorkouts).set({ title: "Long tempo" }).where(eq(plannedWorkouts.id, w)))],
    ["another kind", async (w: string) => void (await db.update(plannedWorkouts).set({ category: "long", qualitySubtype: null, title: "Tempo" }).where(eq(plannedWorkouts.id, w)))],
  ])("%s: each kind of change refused, nothing written to it; the other op goes on; refused again until it is as it was", async (_what, moveOn) => {
    for (const [i, c] of ([{ kind: "skip", reason: "Rest." }, { kind: "move", toDate: day(3), toTime: "12:00" }, { kind: "adjust", durationMinutes: 25 }, { kind: "ease", durationMinutes: 25 }, { kind: "remove" }] as Array<Record<string, unknown>>).entries()) {
      const w = await session(`w-${i}`, day(1));
      const other = await session(`other-${i}`, day(2));
      const id = await changes(adjust(w, c), adjust(other, { kind: "skip", reason: "Rest." }));
      await moveOn(w);
      const before = await rowOf(w);
      const res = await approve(id, {});
      expect(res.status).toBe(200);
      expect(res.json.refused).toEqual([{ opId: planAdjustId(w), error: "changed_since_suggested", why: CHANGED_SINCE_CARD }]);
      expect(res.json.changed.map((x: { opId: string }) => x.opId)).toEqual([planAdjustId(other)]);
      expect(await rowOf(w)).toEqual(before);
      expect((await rowOf(other)).completionState).toBe("skipped");
      await db.update(plannedWorkouts).set({ archivedAt: NOW }).where(eq(plannedWorkouts.id, w));
    }
  });

  it("the athlete's own skip of it is its effect: recorded applied, nothing written, as before", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "skip", reason: "Rest." }));
    await post(`/api/plan/workouts/${w}/skip`);
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(w)]);
  });

  it("put back as the card drew it, it applies: the refusal stayed open", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "adjust", durationMinutes: 25 }));
    await db.update(plannedWorkouts).set({ title: "Long tempo" }).where(eq(plannedWorkouts.id, w));
    expect((await approve(id, {})).json.refused).toHaveLength(1);
    await db.update(plannedWorkouts).set({ title: "Tempo" }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect((await rowOf(w)).fallbackEstimatedDurationSeconds).toBe(1500);
  });

  it("a time nobody asked for moved by a collision pass is no change: applied", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "skip", reason: "Rest." }));
    // As `separateDayCollisions` leaves it: another time, no `time_change` override.
    await db.update(plannedWorkouts).set({ effectiveTime: "08:10" }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect((await rowOf(w)).completionState).toBe("skipped");
  });

  it("a claim taken over isn't compared again: its own applier may have moved the row", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "adjust", durationMinutes: 25 }));
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const stale = new Date(Date.parse(NOW) - 3 * 60_000).toISOString();
    await db.update(coachProposals).set({ ops: (p!.ops as object[]).map((o) => ({ ...o, outcome: { status: "applying", at: stale, before: { date: day(1), time: "07:00", title: "Tempo", minutes: 40 } } })) }).where(eq(coachProposals.id, id));
    await db.update(plannedWorkouts).set({ title: "Long tempo" }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect((await rowOf(w)).fallbackEstimatedDurationSeconds).toBe(1500);
  });

  it("a workout beside a change in a later request isn't refused by what the earlier request's collision pass did", async () => {
    const a = await session("w-1", day(1));
    const b = await session("w-2", day(1));
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", adjust(a, { kind: "adjust", durationMinutes: 90 }));
    await act(ctx, "adjust_plan", adjust(b, { kind: "skip", reason: "Rest." }));
    const dId = `run-${newId()}`;
    await db.insert(coachRuns).values({ id: dId, userId, parentId: ctx.run.id, role: "designer", scope: { kind: "auto" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW });
    const r = await proposeWorkout.run({ ...ctx, run: { id: dId, role: "designer", scope: { kind: "auto" }, parentId: ctx.run.id, rehearsal: false }, toolUseId: `t_${newId()}` }, { doc: calmDoc({ title: "Calm" }), target: { kind: "new", date: day(1), time: "20:00" } });
    if (isToolErr(r)) throw new Error(r.why);
    const id = designProposalId(ctx.run.id);
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    await db.update(coachProposals).set({ status: "pending", ops: (p!.ops as Array<Record<string, unknown>>).map((o) => (o.kind === "doc_workout" ? { ...o, review: { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] } } : o)) }).where(eq(coachProposals.id, id));
    let body: unknown = {};
    const refused: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await approve(id, body);
      refused.push(...res.json.refused);
      if (res.json.remaining.length === 0) break;
      body = { opIds: res.json.remaining };
    }
    expect(refused).toEqual([]);
  });
});
