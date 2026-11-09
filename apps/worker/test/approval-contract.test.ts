/**
 * THE APPROVAL CONTRACT (a request names what it approves; a change's session must still be the one its card drew).
 *
 * A request naming no ops reaches only the two kinds the whole-suggestion card draws, a workout and a change to a session;
 * every other kind is approved by name and is said back in `notNamed`. A `plan_adjust` whose session moved on since its
 * card was drawn is refused `changed_since_suggested`, nothing written, the other ops going on. Synthetic data only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Hold an approve at the applier's door: after its plan read and its claim, before the applier reads or writes a row. */
const gates = vi.hoisted(() => ({ beforeApply: null as null | (() => Promise<void>) }));
vi.mock("../src/services/coach-apply.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/coach-apply.js")>();
  return {
    ...real,
    applyOps: async (...args: Parameters<typeof real.applyOps>) => {
      const hold = gates.beforeApply;
      gates.beforeApply = null;
      if (hold) await hold();
      return real.applyOps(...args);
    },
  };
});
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, newId, nowInstant } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { planRoutes } from "../src/routes/plan.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { CHANGED_SINCE_CARD } from "../src/services/design-approve.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { mondayOf } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { createObjective, getObjective } from "../src/services/objectives.js";
import { placeSlots } from "../src/services/program-slots.js";
import { correctionId, objectiveChangeId, planAdjustId, planChangeId, PLAN_STRUCTURE_ID, programmeChangeId } from "../src/services/proposal-kinds.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";

const { coachPlans, coachProposals, coachRuns, exercisePrefs, importCorrections, plannedWorkouts, programs } = schema;
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
  gates.beforeApply = null;
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

/** The six kinds only their name approves: each by the coach's own tool, and how to see it was applied. */
async function coachPlan(): Promise<string> {
  const id = `plan-${newId()}`;
  await db.insert(programs).values({ id, userId, kind: "coach", name: "Base block", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, purpose: "Get fitter", brief: "Base block.", onEnd: "ask", createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
  return id;
}
const savedLift = async () => {
  const seeded = await seedSavedBatch(db, userId, { savedAt: "2026-10-04T17:00:00.000Z", posts: [{ moves: [{ draft: savedMoveDraft("Zorbex hip lift") }] }] });
  return { batchId: seeded.batchId, lift: seeded.moveIds[0]![0]! };
};
const easyRun = (minutes: number, title: string) => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });
const NOT_BY_NAME: Record<string, (ctx: ToolContext) => Promise<{ opId: string; made: () => Promise<boolean> }>> = {
  plan_structure: async (ctx) => {
    const monday = mondayOf(day(7));
    await act(ctx, "propose_plan", {
      change: {
        kind: "createPlan", discipline: "run", name: "Build block", newPlan: { name: "Synthetic plan", purpose: "A synthetic purpose" }, startDate: monday, endDate: addDays(monday, 20),
        firmSessions: [0, 2].map((k) => ({ date: addDays(monday, k), session: easyRun(30 + k, `Run ${k}`) })),
        shapeWeeks: [1, 2].map((k) => ({ weekStart: addDays(monday, 7 * k), volumeTarget: "about 30 km", keySessions: ["long run"] })),
      },
      why: "The next phase.",
    });
    return { opId: PLAN_STRUCTURE_ID, made: async () => (await db.select().from(coachPlans).where(eq(coachPlans.userId, userId))).length === 1 };
  },
  programme_change: async (ctx) => {
    const p = newId();
    await db.insert(programs).values({ id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
    await placeSlots(db, userId, p, day(0), await loadPreferences(db, userId), NOW);
    await act(ctx, "change_programme", { programmeId: p, days: ["thursday", "Tue"], why: "Your Mondays are full now." });
    return { opId: programmeChangeId(p), made: async () => ((await db.select().from(programs).where(eq(programs.id, p)))[0]!.config as { preferredDays: number[] }).preferredDays.includes(3) };
  },
  plan_change: async (ctx) => {
    const p = await coachPlan();
    await act(ctx, "change_plan", { planId: p, why: "You asked.", brief: "The coach's brief." });
    return { opId: planChangeId(p), made: async () => (await db.select().from(programs).where(eq(programs.id, p)))[0]!.brief === "The coach's brief." };
  },
  move_pins: async (ctx) => {
    const { batchId, lift } = await savedLift();
    await readSavesInRun(db, ctx, { batchId });
    await act(ctx, "pin_moves", { batchId, pin: [lift], title: "A move in rotation", why: "It serves the hips.", lines: [{ moveId: lift, text: "in rotation: it opens the hips." }] });
    return { opId: `pins-${ctx.run.id}`, made: async () => (await db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, userId), eq(exercisePrefs.exerciseId, lift))))[0]?.pinned === true };
  },
  import_correction: async (ctx) => {
    const { batchId, lift } = await savedLift();
    await readSavesInRun(db, ctx, { batchId });
    await act(ctx, "correct_import", { target: "move", targetId: lift, field: "summary", after: "Slow.", why: "The transcript says so.", basis: "evidence", cites: ["history"] });
    return { opId: correctionId("move", lift, "summary"), made: async () => (await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).length === 1 };
  },
  objective_change: async (ctx) => {
    const o = await createObjective(db, userId, { title: "Strong legs", keyResults: [{ label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" }] }, NOW);
    const krId = o.keyResults[0]!.id;
    await act(ctx, "propose_objective", { change: "retarget", keyResultId: krId, target: 90, why: "Your wall sit is at 45 s of 120 s with half the time gone: 90 s is the honest target.", basis: "stand" });
    return { opId: objectiveChangeId("retarget", krId), made: async () => (await getObjective(db, userId, o.id)).keyResults[0]!.target === 90 };
  },
};

describe("the kinds only their name approves", () => {
  it.each(Object.keys(NOT_BY_NAME))("%s: `{}` and no body leave it open and say so; a decline naming nothing leaves it open; its name applies it", async (kind) => {
    const ctx = await mainRun();
    const { opId, made } = await NOT_BY_NAME[kind]!(ctx);
    const id = await shown(ctx);
    writes.length = 0;
    for (const body of [{}, undefined]) {
      const res = await approve(id, body);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [], notNamed: [opId] });
    }
    expect(writes).toEqual([]);
    expect(await made()).toBe(false);
    const declined = await post(`/api/coach/proposals/${id}/decline`, {});
    expect(declined.status).toBe(200);
    expect(declined.json).toMatchObject({ status: "pending", declined: [] });
    expect(await made()).toBe(false);
    let body: unknown = { opIds: [opId] };
    let res = await approve(id, body);
    for (let i = 0; i < MAX_LOOP_ITERATIONS && res.json.remaining?.length; i++) {
      body = { opIds: res.json.remaining };
      res = await approve(id, body);
    }
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("approved");
    expect(res.json.notNamed).toBeUndefined();
    expect(await made()).toBe(true);
  });

  it("all six beside a workout and a change: `{}` until done reaches those two, names the six; the six then apply by name alone", async () => {
    const w = await session("w-1", day(1));
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", adjust(w, { kind: "skip", reason: "Rest." }));
    const six: Record<string, { opId: string; made: () => Promise<boolean> }> = {};
    for (const [k, make] of Object.entries(NOT_BY_NAME)) six[k] = await make(ctx);
    const id = await shown(ctx);
    const first = await approve(id, {});
    expect(first.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(w)]);
    expect([...first.json.notNamed].sort()).toEqual(Object.values(six).map((x) => x.opId).sort());
    for (const x of Object.values(six)) expect(await x.made()).toBe(false);
    let res = await approve(id, { opIds: Object.values(six).map((x) => x.opId) });
    for (let i = 0; i < MAX_LOOP_ITERATIONS && res.json.remaining?.length; i++) res = await approve(id, { opIds: res.json.remaining });
    expect(res.json.status).toBe("approved");
    for (const x of Object.values(six)) expect(await x.made()).toBe(true);
  });
});

describe("a request naming every op a card can draw", () => {
  /** The most a card draws: MAX_CHANGES changes beside SET_MAX_WORKOUTS workouts. */
  async function fullCard() {
    const ctx = await mainRun();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const w = await session(`w-${i}`, day(i + 1));
      await act(ctx, "adjust_plan", adjust(w, { kind: "skip", reason: "Rest." }));
      ids.push(planAdjustId(w));
    }
    for (let i = 0; i < 12; i++) {
      const dId = `run-${newId()}`;
      await db.insert(coachRuns).values({ id: dId, userId, parentId: ctx.run.id, role: "designer", scope: { kind: "auto" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW });
      const r = await proposeWorkout.run({ ...ctx, run: { id: dId, role: "designer", scope: { kind: "auto" }, parentId: ctx.run.id, rehearsal: false }, toolUseId: `t_${newId()}` }, { doc: calmDoc({ title: `Calm ${i}` }), target: { kind: "new", date: day(20 + i), time: "12:30" } });
      if (isToolErr(r)) throw new Error(r.why);
      ids.push(dId);
    }
    const id = designProposalId(ctx.run.id);
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    await db.update(coachProposals).set({ status: "pending", ops: (p!.ops as Array<Record<string, unknown>>).map((o) => (o.kind === "doc_workout" ? { ...o, review: { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] } } : o)) }).where(eq(coachProposals.id, id));
    return { id, ids };
  }

  it("the whole card by name, 22 ops: approved in one go of requests, as `{}` was before the card named them (owner P6: the cap raised, not chunked)", async () => {
    const { id, ids } = await fullCard();
    expect(ids).toHaveLength(22);
    let res = await approve(id, { opIds: ids });
    expect(res.status).toBe(200);
    for (let i = 0; i < MAX_LOOP_ITERATIONS && res.json.remaining?.length; i++) res = await approve(id, { opIds: res.json.remaining });
    expect(res.json.status).toBe("approved");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.title.startsWith("Calm"))).toHaveLength(12);
  });

  it("declined whole by name, 22 ops: all declined, nothing applied", async () => {
    const { id, ids } = await fullCard();
    const res = await post(`/api/coach/proposals/${id}/decline`, { opIds: ids });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("declined");
    expect((await rowOf("w-0")).completionState).toBe("scheduled");
  });

  it("past the cap: 400 `bad_request`, nothing written", async () => {
    writes.length = 0;
    const ctx = await mainRun();
    const w = await session("w-1", day(1));
    await act(ctx, "adjust_plan", adjust(w, { kind: "skip", reason: "Rest." }));
    const id = await shown(ctx);
    writes.length = 0;
    const res = await approve(id, { opIds: Array.from({ length: 51 }, (_, i) => `x${i}`) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("bad_request");
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

  it("a claim taken over is compared like any other: a session renamed since is refused, its claim's length never written (owner P7, proposed: refuse)", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "adjust", durationMinutes: 25 }));
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const stale = new Date(Date.parse(NOW) - 3 * 60_000).toISOString();
    await db.update(coachProposals).set({ ops: (p!.ops as object[]).map((o) => ({ ...o, outcome: { status: "applying", at: stale, before: { date: day(1), time: "07:00", title: "Tempo", minutes: 40 } } })) }).where(eq(coachProposals.id, id));
    await db.update(plannedWorkouts).set({ title: "Long tempo" }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect((await rowOf(w)).fallbackEstimatedDurationSeconds).toBe(2400);
  });

  it("the applier throws once, the athlete then moves the session by hand, and taps Approve again: refused, the athlete's move stands", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "move", toDate: day(3), toTime: "12:00" }));
    gates.beforeApply = async () => {
      throw new Error("D1_ERROR: synthetic transient");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await approve(id, {}).catch((e: Error) => ({ status: 500, json: { error: e.message } }));
    spy.mockRestore();
    expect(first.status).toBe(500);
    expect((await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!.ops).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ status: "applying" }) })]);
    expect((await post(`/api/plan/workouts/${w}/move`, { toDate: day(4), toTime: "17:30" })).status).toBe(200);
    const again = await approve(id, {});
    expect(again.json.changed).toEqual([]);
    expect(again.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect(await rowOf(w)).toMatchObject({ effectiveDate: day(4), effectiveTime: "17:30" });
  });

  it("a claim whose dead applier made its change is recorded applied, though the session differs from the card by that change", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "adjust", durationMinutes: 25 }));
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const stale = new Date(Date.parse(NOW) - 3 * 60_000).toISOString();
    await db.update(coachProposals).set({ ops: (p!.ops as object[]).map((o) => ({ ...o, outcome: { status: "applying", at: stale, before: { date: day(1), time: "07:00", title: "Tempo", minutes: 40 } } })) }).where(eq(coachProposals.id, id));
    // What the applier wrote before it died: the length.
    await db.update(plannedWorkouts).set({ fallbackEstimatedDurationSeconds: 1500, calendarBlockDurationSeconds: 1500 }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect(res.json.changed).toEqual([expect.objectContaining({ opId: planAdjustId(w), before: { date: day(1), time: "07:00", title: "Tempo", minutes: 40 } })]);
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

describe("a change whose session moved on between approve's read and the applier's write (forced)", () => {
  const overridesOf = async (w: string) => (await db.select().from(schema.scheduleOverrides).where(eq(schema.scheduleOverrides.workoutId, w))).map((o) => [o.kind, o.fromDate, o.toDate, o.toTime].join(" "));

  it.each([
    ["move", { kind: "move", toDate: day(3), toTime: "12:00" }],
    ["skip", { kind: "skip", reason: "Rest." }],
    ["adjust", { kind: "adjust", durationMinutes: 25 }],
    ["ease", { kind: "ease", durationMinutes: 25 }],
    ["remove", { kind: "remove" }],
  ])("%s: the athlete's own move lands at the applier's door: refused `changed_since_suggested`, the row where the athlete put it, nothing of the coach's written; the other op goes on", async (_name, c) => {
    const w = await session("w-1", day(1));
    const other = await session("w-2", day(2));
    const id = await changes(adjust(w, c), adjust(other, { kind: "skip", reason: "Rest." }));
    gates.beforeApply = async () => {
      expect((await post(`/api/plan/workouts/${w}/move`, { toDate: day(4), toTime: "17:30" })).status).toBe(200);
    };
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.refused).toEqual([expect.objectContaining({ opId: planAdjustId(w), error: "changed_since_suggested" })]);
    expect(res.json.changed.map((x: { opId: string }) => x.opId)).toEqual([planAdjustId(other)]);
    expect(await rowOf(w)).toMatchObject({ effectiveDate: day(4), effectiveTime: "17:30", completionState: "scheduled", archivedAt: null, fallbackEstimatedDurationSeconds: 2400, title: "Tempo" });
    expect(await overridesOf(w)).toEqual([`user_move ${day(1)} ${day(4)} 17:30`]);
    expect((await rowOf(other)).completionState).toBe("skipped");
    // It stays open, and the card's compare refuses it again from here.
    const again = await approve(id, { opIds: [planAdjustId(w)] });
    expect(again.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
  });

  it("an ease whose row holds a document: lost at the door, it records no revision of the coach's (none of a document it never wrote)", async () => {
    const w = await session("w-1", day(1));
    await db.update(plannedWorkouts).set({ workoutDoc: JSON.stringify({ version: 1, title: "Tempo", parts: [] }), workoutDocRev: 1 }).where(eq(plannedWorkouts.id, w));
    const id = await changes(adjust(w, { kind: "ease", durationMinutes: 25 }));
    gates.beforeApply = async () => {
      expect((await post(`/api/plan/workouts/${w}/move`, { toDate: day(4), toTime: "17:30" })).status).toBe(200);
    };
    const res = await approve(id, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect(await db.select().from(schema.workoutDocRevisions).where(eq(schema.workoutDocRevisions.workoutId, w))).toEqual([]);
    expect(await rowOf(w)).toMatchObject({ workoutDocRev: 1, title: "Tempo" });
  });

  it("nothing lands at the door: each applies as before", async () => {
    const w = await session("w-1", day(1));
    const id = await changes(adjust(w, { kind: "move", toDate: day(3), toTime: "12:00" }));
    const res = await approve(id, {});
    expect(res.json.changed.map((x: { opId: string }) => x.opId)).toEqual([planAdjustId(w)]);
    expect(await rowOf(w)).toMatchObject({ effectiveDate: day(3), effectiveTime: "12:00" });
  });
});
