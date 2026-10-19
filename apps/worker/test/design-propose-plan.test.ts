/**
 * propose_plan (§8 §5, stream W): the main coach proposes ONE change to the shape of the athlete's plans — the thread
 * coach's own structural op, parsed by its schema, judged by its own guardrails, stored as one `plan_structure` op of the
 * run's designed proposal with what the card shows (title, one line, the manifest's lines). Fatal findings refuse in
 * words; advisories ride along. A second call replaces the first. The first one stored raises an auto run's ceiling.
 * Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { proposalFields } from "../src/services/design-review.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { MAX_FIRM_WEEKS, MAX_PLAN_SESSIONS, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type RunScope, type SetHooks, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { coachOpsOf, isDesignedOp, isDesignedProposal, opIdOf, PLAN_LINES_MAX, type PlanStructureOp } from "../src/services/proposal-kinds.js";
import { addDays } from "@rg/domain";
import { IN_ARRAY_CHUNK } from "../src/services/db.js";
import { GUARDRAIL_MATCH_CHUNKS } from "../src/services/design-tools/propose-plan.js";
import { at, day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const ENV = {} as Env;
let db: Db;
const statements: string[] = [];
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  rich = await seedRichAthlete(db);
});
afterEach(() => vi.useRealTimers());

let seq = 0;
async function mainRun(scope: RunScope = { kind: "auto" }, role: "main" | "designer" = "main", parentId: string | null = null): Promise<ToolContext["run"]> {
  const id = `run-pp-${++seq}-${newId().slice(0, 6)}`;
  await db.insert(schema.coachRuns).values({
    id, userId: rich.userId, parentId, role, scope: { ...scope }, request: "Plan my next four weeks toward a 10K", status: "active", state: null,
    steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role, scope, parentId, rehearsal: false };
}

const raised: string[] = [];
const hooks = (): SetHooks => ({
  rounds: () => [],
  start: async () => [],
  budget: () => ({ ceilingMicros: 0, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }),
  started: () => false,
  keyLine: () => undefined,
  raisePlan: () => void raised.push("plan"),
});

async function propose(run: ToolContext["run"], input: unknown, toolUseId = `toolu_pp${++seq}`) {
  statements.length = 0;
  const res = await proposePlan.run({ db, env: ENV, userId: rich.userId, run, now: NOW, toolUseId, set: hooks() }, input);
  return { res, count: statements.length, writes: statements.filter(isWrite).length };
}
const ok = (res: ToolOk | ToolErr) => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res as ToolOk & { data: Record<string, any> };
};
const refused = (res: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(res)) throw new Error(`not refused: ${JSON.stringify(res.data)}`);
  return res;
};
async function opsOf(runId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as unknown[] } : undefined;
}

const easy = (minutes: number, title = "Easy run") => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });

/** A four-week 10K block from Monday 18 May: its first week of sessions, three shape weeks, race on its last Sunday. */
const createPlan = (o: { sessions?: Array<{ date: string; session: unknown }>; shapeWeeks?: unknown[]; startDate?: string } = {}) => ({
  kind: "createPlan",
  discipline: "run",
  name: "10K build",
  startDate: o.startDate ?? "2026-05-18",
  endDate: "2026-06-14",
  raceDate: "2026-06-14",
  firmSessions: o.sessions ?? [
    { date: "2026-05-18", session: easy(40) },
    { date: "2026-05-20", session: { category: "quality", title: "Tempo 20", durationMinutes: 50, run: { blocks: [{ kind: "duration", value: 15, intensity: "easy" }, { kind: "duration", value: 20, intensity: "threshold" }, { kind: "duration", value: 15, intensity: "easy" }] } } },
    { date: "2026-05-22", session: easy(35) },
    { date: "2026-05-24", session: { category: "long", title: "Long run", durationMinutes: 75, run: { blocks: [{ kind: "duration", value: 75, intensity: "easy" }] } } },
  ],
  shapeWeeks: o.shapeWeeks ?? [
    { weekStart: "2026-05-25", volumeTarget: "about 32 km", keySessions: ["tempo 25 min", "long 13 km"] },
    { weekStart: "2026-06-01", volumeTarget: "about 35 km", keySessions: ["5×1 km at 10K pace", "long 14 km"] },
    { weekStart: "2026-06-08", volumeTarget: "taper, about 22 km", keySessions: ["openers", "race Sunday"] },
  ],
});

async function block(id: string, status = "active", discipline = "run") {
  await db.insert(schema.coachPlans).values({
    id, userId: rich.userId, discipline, name: "Spring 10K", status, startDate: day(14), endDate: day(-14), raceDate: null,
    stampPrefix: "Spring 10K", createdAt: at(day(14)), updatedAt: at(day(14)),
  });
}

describe("propose_plan: the registry", () => {
  it("is the main coach's act tool, offered right after adjust_plan, its statements declared at their most", () => {
    const names = ACT_TOOLS.map((t) => t.name);
    expect(names.indexOf("propose_plan")).toBe(names.indexOf("adjust_plan") + 1);
    expect(proposePlan.roles).toEqual(["main"]);
    expect(proposePlan.statementCost).toBe(12);
    expect(proposePlan.description.length).toBeLessThanOrEqual(300);
  });
});

describe("propose_plan: its statements", () => {
  it("declared at their most: the athlete's read, the guardrails' (their match reads at the counted bound), the catalog for a lift, the write", async () => {
    // A busy account: the guardrails' window (35 days back, 180 on) holds as many planned rows as GUARDRAIL_MATCH_CHUNKS reads cover.
    const { userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
    const rows = GUARDRAIL_MATCH_CHUNKS * IN_ARRAY_CHUNK;
    for (let n = 0; n < rows; n++) {
      const id = newId();
      const date = addDays(TODAY, -35 + (n % 216));
      await db.insert(schema.plannedWorkouts).values({
        id, userId, planId: "coros-plan", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date,
        effectiveDate: date, effectiveTime: n % 2 ? "07:00" : "18:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: 1800,
        calendarBlockDurationSeconds: 2700, completionState: date < TODAY ? "completed" : "scheduled", createdAt: at(day(40)), updatedAt: at(day(40)),
      });
    }
    const id = `run-pp-busy-${newId().slice(0, 6)}`;
    await db.insert(schema.coachRuns).values({ id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "A strength block", status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    const lift = (date: string) => ({ date, session: { category: "strength", title: "Strength A", durationMinutes: 45, lift: { exercises: [{ name: "Goblet squat", sets: 3, reps: 8 }] } } });
    statements.length = 0;
    const res = await proposePlan.run(
      { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: "toolu_busy", set: hooks() },
      { change: { ...createPlan({ sessions: [lift("2026-05-18"), lift("2026-05-21")] }), discipline: "lift", name: "Strength block" }, why: "Strength twice a week." },
    );
    ok(res);
    expect(statements.length).toBe(proposePlan.statementCost);
    // A run plan on the rich account: no catalog read, one match read.
    const run = await mainRun();
    const small = await propose(run, { change: createPlan(), why: "x" });
    ok(small.res);
    expect(small.count).toBe(1 + 4 + 1 + 1);
    // Refusals before the read cost nothing; after it, the read alone.
    expect((await propose(run, { change: { kind: "skip", workoutId: "x" }, why: "x" })).count).toBe(0);
    expect((await propose(run, { change: { kind: "retirePlan", planId: "coros-plan" }, why: "x" })).count).toBe(1);
  });
});

describe("propose_plan: a new block", () => {
  it("stores ONE plan_structure op — the thread coach's createPlan as its schema parsed it, the why, the card's words and lines — and raises an auto run's ceiling once", async () => {
    const run = await mainRun();
    raised.length = 0;
    const { res, count, writes } = await propose(run, { change: createPlan(), why: "Four weeks that build to your 10K, easy days kept easy." });
    const r = ok(res);
    expect(count).toBeLessThanOrEqual(proposePlan.statementCost);
    expect(writes).toBe(1);
    expect(raised).toEqual(["plan"]);
    const p = (await opsOf(run.id))!;
    expect(p.status).toBe("unreviewed");
    expect(p.ops).toHaveLength(1);
    const op = p.ops[0] as PlanStructureOp;
    expect(op).toMatchObject({
      kind: "plan_structure",
      id: "plan",
      why: "Four weeks that build to your 10K, easy days kept easy.",
      title: "10K build",
      summary: "4 weeks · 4 sessions to start · race Sun 14 Jun",
      planKey: "new:run",
      date: "2026-05-18",
      at: NOW.toISOString(),
    });
    expect(op.op.kind).toBe("createPlan");
    expect((op.op as { firmSessions: unknown[] }).firmSessions).toHaveLength(4);
    // The thread coach's own manifest lines: the plan, its four sessions, three shape weeks — eight, all shown.
    expect(op.lines).toHaveLength(8);
    // Each line's day said once: a line that names its day goes without the prefix.
    expect(op.lines[0]).toBe("New plan: 10K build · Mon 18 May to Sun 14 Jun — race day Sun 14 Jun");
    expect(op.lines[1]).toBe("Mon 18 May · Easy run · 40 min");
    expect(op.lines[5]).toBe("Week of Mon 25 May — about 32 km — sketched: tempo 25 min · long 13 km");
    // The proposal's row: named by the plan, expiring on its first day.
    expect(p.title).toBe("10K build");
    expect(p.expiresAt).toBe("2026-05-16");
    // Read back: a designed proposal, a designed op, never a thread coach's.
    expect(isDesignedProposal(p.ops)).toBe(true);
    expect(isDesignedOp(op)).toBe(true);
    expect(coachOpsOf(p.ops)).toEqual([]);
    expect(opIdOf(op)).toBe("plan");
    // The model's words come back marked.
    expect(r.data.title).toEqual({ untrusted: true, text: "10K build" });
    expect(r.data.why).toEqual({ untrusted: true, text: "Four weeks that build to your 10K, easy days kept easy." });
    expect(r.data.lines[0].untrusted).toBe(true);
    expect(r.summary).toBe("Plan: 10K build");
  });

  it("a new block over a running block of the same discipline: an advisory naming it and its span — never a refusal (review-1, duplicate blocks)", async () => {
    await block("cp-spring");
    // Not the same plan: another discipline, one retired, a loose bucket of one-offs.
    await block("cp-lift", "active", "lift");
    await block("cp-gone", "retired");
    await block(`adhoc-run-${rich.userId.slice(0, 8)}`);
    const run = await mainRun();
    const { res, count } = await propose(run, { change: createPlan(), why: "A build." });
    ok(res);
    expect(count).toBe(1 + 4 + 1 + 1);
    const op = (await opsOf(run.id))!.ops[0] as PlanStructureOp;
    expect(op.issues.filter((i) => i.code === "plan_overlap")).toEqual([{ code: "plan_overlap", message: "Overlaps your Spring 10K (29 Apr – 27 May)" }]);
    // One that ends before the new one starts: no overlap.
    const later = await mainRun();
    ok((await propose(later, { change: { ...createPlan({ startDate: "2026-06-01", sessions: [{ date: "2026-06-01", session: easy(30) }], shapeWeeks: [] }), endDate: "2026-06-21", raceDate: null }, why: "Later." })).res);
    expect(((await opsOf(later.id))!.ops[0] as PlanStructureOp).issues.some((i) => i.code === "plan_overlap")).toBe(false);
  });

  it("more than eight lines: eight, then how many more", async () => {
    const run = await mainRun();
    const sessions = ["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23", "2026-05-24"].map((date) => ({ date, session: easy(30) }));
    ok((await propose(run, { change: createPlan({ sessions }), why: "Daily easy running." })).res);
    const op = (await opsOf(run.id))!.ops[0] as PlanStructureOp;
    // 1 plan line + 7 sessions + 3 shape weeks = 11.
    expect(op.lines).toHaveLength(PLAN_LINES_MAX + 1);
    expect(op.lines.at(-1)).toBe("and 3 more");
  });

  it("keeps the guardrails' advisories on the op, in their own words", async () => {
    const run = await mainRun();
    // Five hard days in a row: a training judgement, never a refusal.
    const hard = (date: string) => ({ date, session: { category: "quality", title: "Intervals", durationMinutes: 60, run: { blocks: [{ kind: "duration", value: 60, intensity: "interval" }] } } });
    ok((await propose(run, { change: createPlan({ sessions: ["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22"].map(hard) }), why: "A hard week." })).res);
    const op = (await opsOf(run.id))!.ops[0] as PlanStructureOp;
    expect(op.issues.length).toBeGreaterThan(0);
    expect(op.issues.some((i) => i.code === "hard_adjacency")).toBe(true);
    for (const i of op.issues) expect(i.message.length).toBeGreaterThan(10);
  });

  it("a second call replaces the first (one plan per proposal); a replay answers what it stored and writes nothing", async () => {
    const run = await mainRun();
    raised.length = 0;
    ok((await propose(run, { change: createPlan(), why: "First." }, "toolu_first")).res);
    const second = await propose(run, { change: { ...createPlan(), name: "10K build, gentler" }, why: "Second." }, "toolu_second");
    expect(ok(second.res).data.replaced).toBe(true);
    const ops = (await opsOf(run.id))!.ops as PlanStructureOp[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ title: "10K build, gentler", toolUseId: "toolu_second", replaces: ["toolu_first"] });
    const replay = await propose(run, { change: createPlan(), why: "Second." }, "toolu_second");
    expect(ok(replay.res).data.title.text).toBe("10K build, gentler");
    expect(replay.writes).toBe(0);
    const older = await propose(run, { change: createPlan(), why: "First." }, "toolu_first");
    expect(ok(older.res).data.superseded).toBe(true);
    expect(older.writes).toBe(0);
  });
});

describe("propose_plan: refused in words, nothing written", () => {
  it("one session's change is adjust_plan's; a role other than main; a change its schema refuses", async () => {
    const run = await mainRun();
    const skip = refused((await propose(run, { change: { kind: "skip", workoutId: rich.todayDocId }, why: "Rest." })).res);
    expect(skip.error).toBe("not_a_plan_change");
    expect(skip.fix).toMatch(/adjust_plan/);
    const parent = await mainRun();
    const designer = await mainRun({ kind: "week" }, "designer", parent.id);
    expect(refused((await propose(designer, { change: createPlan(), why: "x" })).res).error).toBe("not_for_role");
    const bad = refused((await propose(run, { change: { kind: "createPlan", name: "No dates" }, why: "x" })).res);
    expect(bad.error).toBe("invalid_input");
    expect(bad.why).toMatch(/change\./);
    expect(await opsOf(run.id)).toBeUndefined();
  });

  it(`more than ${MAX_PLAN_SESSIONS} sessions, or sessions over more than ${MAX_FIRM_WEEKS} weeks: fill in one or two, sketch the rest`, async () => {
    const run = await mainRun();
    const three = ["2026-05-18", "2026-05-25", "2026-06-01"].map((date) => ({ date, session: easy(30) }));
    const weeks = refused((await propose(run, { change: createPlan({ sessions: three }), why: "x" })).res);
    expect(weeks.error).toBe("too_many_weeks");
    expect(weeks.fix).toMatch(/shape weeks/);
    // One past the cap (24 since the decision guidance's fix round, I1: two weeks of up to twelve).
    const many = Array.from({ length: MAX_PLAN_SESSIONS + 1 }, (_, i) => ({ date: i < MAX_PLAN_SESSIONS / 2 ? "2026-05-18" : "2026-05-25", session: easy(20) }));
    expect(refused((await propose(run, { change: createPlan({ sessions: many }), why: "x" })).res).error).toBe("too_many_sessions");
    expect(await opsOf(run.id)).toBeUndefined();
  });

  it("a week that doesn't start on a Monday, a session outside its week", async () => {
    const run = await mainRun();
    await block("cp-spring");
    const tuesday = refused((await propose(run, { change: { kind: "extendPlan", planId: "cp-spring", shapeWeeks: [{ weekStart: "2026-06-02", volumeTarget: "30 km", keySessions: [] }] }, why: "x" })).res);
    expect(tuesday.error).toBe("bad_dates");
    expect(tuesday.why).toContain("2026-06-01");
    const outside = refused((await propose(run, { change: { kind: "firmUp", planId: "cp-spring", weekStart: "2026-05-18", sessions: [{ date: "2026-05-26", session: easy(30) }] }, why: "x" })).res);
    expect(outside.error).toBe("bad_dates");
  });

  it("the guardrails' fatal finding: a session in the past is refused with their own words", async () => {
    const run = await mainRun();
    const past = refused((await propose(run, { change: createPlan({ startDate: day(3), sessions: [{ date: day(2), session: easy(30) }, { date: day(-1), session: easy(30) }] }), why: "x" })).res);
    expect(past.error).toBe("plan_refused");
    expect(past.why).toMatch(/already been and gone/);
    expect(await opsOf(run.id)).toBeUndefined();
  });

  it("a plan that isn't a running block of the coach's: a watch plan, a loose bucket, one that ended", async () => {
    const run = await mainRun();
    const watch = refused((await propose(run, { change: { kind: "retirePlan", planId: "coros-plan" }, why: "x" })).res);
    expect(watch.error).toBe("not_your_block");
    expect(watch.fix).toMatch(/read_plans/);
    await block(`adhoc-run-${rich.userId.slice(0, 8)}`);
    expect(refused((await propose(run, { change: { kind: "retirePlan", planId: `adhoc-run-${rich.userId.slice(0, 8)}` }, why: "x" })).res).error).toBe("not_your_block");
    await block("cp-old", "retired");
    expect(refused((await propose(run, { change: { kind: "retirePlan", planId: "cp-old" }, why: "x" })).res).error).toBe("not_running");
  });

  it("a proposal already with the athlete", async () => {
    const run = await mainRun();
    ok((await propose(run, { change: createPlan(), why: "x" })).res);
    await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, designProposalId(run.id)));
    expect(refused((await propose(run, { change: createPlan(), why: "y" })).res).error).toBe("proposal_pending");
  });
});

describe("propose_plan: changes to a block of the coach's", () => {
  it("extend, firm up, wind down, retire — each named by the block, its lines the thread coach's", async () => {
    await block("cp-spring");
    const cases: Array<[unknown, string, string]> = [
      [{ kind: "extendPlan", planId: "cp-spring", shapeWeeks: [{ weekStart: "2026-06-01", volumeTarget: "30 km", keySessions: ["long 12 km"] }, { weekStart: "2026-06-08", volumeTarget: "32 km", keySessions: [] }] }, "Extend Spring 10K", "2 more weeks · to Sun 14 Jun"],
      [{ kind: "firmUp", planId: "cp-spring", weekStart: "2026-05-18", sessions: [{ date: "2026-05-18", session: easy(30) }, { date: "2026-05-20", session: easy(40) }] }, "Spring 10K: week of Mon 18 May", "2 sessions"],
      [{ kind: "windDown", planId: "cp-spring", sessions: [{ date: "2026-05-18", session: easy(25) }] }, "Wind down Spring 10K", "1 easier session · from Mon 18 May"],
      [{ kind: "retirePlan", planId: "cp-spring" }, "Retire Spring 10K", "Its sessions still to come come off"],
    ];
    for (const [change, title, summary] of cases) {
      const run = await mainRun();
      ok((await propose(run, { change, why: "Because." })).res);
      const op = (await opsOf(run.id))!.ops[0] as PlanStructureOp;
      expect(op, title).toMatchObject({ title, summary, planKey: "plan:cp-spring" });
      expect(op.lines.length, title).toBeGreaterThan(0);
    }
  });
});

describe("the proposal's fields with a plan change", () => {
  it("named by the workouts and changes first, then the plan; expiring on its first day, or three days on, whichever is first", () => {
    const plan = { kind: "plan_structure", id: "plan", title: "10K build", why: "Build.", date: "2026-05-30", at: NOW.toISOString(), op: { kind: "createPlan" } };
    expect(proposalFields([plan])).toMatchObject({ title: "10K build", expiresAt: "2026-05-16", rationale: "Build." });
    expect(proposalFields([{ ...plan, date: TODAY }]).expiresAt).toBe(TODAY);
  });
});
