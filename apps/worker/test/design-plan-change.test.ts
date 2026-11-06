/**
 * A PLAN'S PURPOSE, BRIEF, ENDING AND PAUSE, CHANGED BY THE COACH (plans with a purpose, Stage 1, Task 6): change_plan
 * stores one `plan_change` op — only the fields it changes, what they were, the card's words — and writes nothing; the
 * approve route applies it through `applyPlanPatch`, the function `PATCH /api/plans/:id` calls (one write, one version),
 * within 45 statements; a change the athlete overtook by editing the plan refused `stale`, in the words and shape a
 * programme change uses; and every reader of designed proposals tolerates the kind — the conversation's card and block,
 * read_proposals, the manifest, the cover rule, the proposal's title. A Wednesday morning in UTC (Date faked).
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, courseConfigSchema, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { conversationBlock, conversationRows, namedConversationSql, readConversation } from "../src/services/coach-conversation.js";
import { endedLine } from "../src/services/coach-runs.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import { APPROVE_FIXED, type DesignedPlanChangeOp, PLAN_CHANGE_COST, REQUEST_BUDGET } from "../src/services/design-approve.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { proposalFields } from "../src/services/design-review.js";
import { changePlan, planChangeTitle, planSettingLines } from "../src/services/design-tools/change-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { mondayOf, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import { planChangeId, type PlanChangeFields } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { coachProposals, coachMessages, coachRuns, coachPlans, programs, programVersions } = schema;
/** A Wednesday morning in UTC. */
const NOW = new Date("2026-10-14T08:00:00.000Z");
const TODAY = "2026-10-14";

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
let cookie: string;
let statements = 0;
/** Every statement, while a test collects them. */
let seen: string[] | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = 0;
  seen = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (q) => {
      statements += 1;
      seen?.push(q);
    },
  });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A plan's registry row. */
async function plan(o: { kind?: "coach" | "course"; name?: string; owner?: string; purpose?: string | null; brief?: string | null; onEnd?: "ask" | "continue" | "finish"; archived?: boolean } = {}): Promise<string> {
  const id = `plan-${newId()}`;
  const kind = o.kind ?? "coach";
  await db.insert(programs).values({
    id, userId: o.owner ?? userId, kind, name: o.name ?? "Base block", status: "active", disciplines: ["run"], startDate: "2026-10-05", endDate: "2026-12-27",
    raceDate: null, source: null,
    config: kind === "course" ? courseConfigSchema.parse({ course: "intro", weekdays: [0, 2], time: "07:00" }) : {},
    purpose: o.purpose ?? null, brief: o.brief ?? null, onEnd: o.onEnd ?? (kind === "course" ? "continue" : "ask"),
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), archivedAt: o.archived ? NOW.toISOString() : null,
  });
  return id;
}

/** A main run and its tool context. */
async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Make my plan about getting fitter", status: "active",
    state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

async function change(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await changePlan.run(ctx, { why: "It is what you told me you want.", ...input });
  return { res, count: statements };
}

const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const opOf = async (id: string, planId: string) =>
  ((await proposalOf(id)).ops as unknown[]).find((o) => (o as { id?: string }).id === planChangeId(planId)) as DesignedPlanChangeOp;
const rowOf = async (planId: string) => (await db.select().from(programs).where(eq(programs.id, planId)))[0]!;
const versionsOf = async (planId: string) => db.select().from(programVersions).where(eq(programVersions.programId, planId));

/** A change proposed and made pending, as the finish makes it. */
async function proposed(planId: string, input: Record<string, unknown>): Promise<{ id: string; ctx: ToolContext }> {
  const ctx = await mainRun();
  ok((await change(ctx, { planId, ...input })).res);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
  return { id: designProposalId(ctx.run.id), ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements };
}

/** Approve until nothing remains: each request's answer and cost. */
async function approveAll(id: string, opIds?: string[]) {
  const answers: Array<Record<string, any>> = [];
  const costs: number[] = [];
  let remaining: string[] | null = opIds ?? null;
  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    answers.push(res.json);
    costs.push(res.total);
    remaining = res.json.remaining as string[];
    if (remaining.length === 0) break;
  }
  return { answers, costs };
}

describe("change_plan: one change to a plan's purpose, brief, ending or pause", () => {
  it("writes nothing: it stores one op with only what changes, what it was and the card's words, in two statements", async () => {
    const p = await plan({ purpose: "Get fitter", onEnd: "ask" });
    const ctx = await mainRun();
    const { res, count } = await change(ctx, { planId: p, purpose: "Run a first 10K", onEnd: "continue", pausedUntil: "2026-10-21" });
    const stored = ok(res);
    expect(changePlan.statementCost).toBe(2);
    expect(count).toBeLessThanOrEqual(changePlan.statementCost);
    expect(stored.data).toMatchObject({ stored: true, opId: planChangeId(p), planId: p });
    const op = await opOf(designProposalId(ctx.run.id), p);
    expect(op).toMatchObject({
      kind: "plan_change",
      planId: p,
      change: { purpose: "Run a first 10K", onEnd: "continue", pausedUntil: "2026-10-21" },
      base: { purpose: "Get fitter", onEnd: "ask", pausedUntil: null },
      title: "Base block: new purpose, ending and pause",
      summary: "Ending: Continue · paused until Wed 21 Oct",
      date: TODAY,
      issues: [],
    });
    expect(op.lines).toEqual(["Purpose: Run a first 10K", "When it ends: Ask me → Continue", "Paused until Wed 21 Oct"]);
    // The plan is as it was: no field, no version.
    expect(await rowOf(p)).toMatchObject({ purpose: "Get fitter", onEnd: "ask", pausedUntil: null });
    expect(await versionsOf(p)).toEqual([]);
  });

  it("takes a block's id or a Studio plan's id for its plan, and says which plan it changed", async () => {
    const p = await plan({ name: "Strength" });
    await db.update(programs).set({ source: { studioPlanId: "studio-1" } }).where(eq(programs.id, p));
    const q = await plan({ name: "Run" });
    await db.insert(coachPlans).values({
      id: "block-1", userId, name: "Run", discipline: "run", status: "active", startDate: "2026-10-05", endDate: "2026-12-27", raceDate: null, programId: q,
      stampPrefix: "Run", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const ctx = await mainRun();
    expect(ok((await change(ctx, { planId: "studio-1", brief: "Two lifts a week." })).res).data).toMatchObject({ planId: p });
    expect(ok((await change({ ...ctx, toolUseId: "toolu_b" }, { planId: "block-1", brief: "Build slowly." })).res).data).toMatchObject({ planId: q });
  });

  it("refuses, in words and with a fix: a course that cannot ask, a pause already over, a text too long, objectives that are not the athlete's, easing a plan that is no course — and nothing is stored", async () => {
    const coach = await plan({});
    const course = await plan({ kind: "course", name: "Intro course" });
    const ctx = await mainRun();
    const refusal = async (input: Record<string, unknown>) => {
      const { res } = await change(ctx, input);
      if (!isToolErr(res)) throw new Error("stored");
      return res;
    };
    const ask = await refusal({ planId: course, onEnd: "ask" });
    expect(ask.error).toBe("invalid_input");
    expect(ask.why).toContain(`onEnd: a course cannot end by "ask"`);
    expect(ask.fix).toMatch(/continue|finish/);
    const past = await refusal({ planId: coach, pausedUntil: "2026-10-13" });
    expect(past.error).toBe("invalid_input");
    expect(past.why).toContain("pausedUntil: a pause cannot end before today (2026-10-14)");
    expect((await refusal({ planId: coach, pausedUntil: "next week" })).error).toBe("invalid_input");
    expect((await refusal({ planId: coach, purpose: "x".repeat(201) })).error).toBe("invalid_input");
    const ease = await refusal({ planId: coach, easeNext: true });
    expect(ease.why).toContain("easeNext: only a course can ease its next session");
    const objectives = await refusal({ planId: coach, objectiveIds: ["no-such-objective"] });
    expect(objectives.why).toContain(`objectiveIds: "no-such-objective" is none of the athlete's objectives`);
    expect((await refusal({ planId: coach })).why).toMatch(/^No field to change/);
    // Today is allowed: the last day of a pause.
    ok((await change({ ...ctx, toolUseId: "toolu_ok" }, { planId: coach, pausedUntil: TODAY })).res);
    expect((await proposalOf(designProposalId(ctx.run.id))).ops).toHaveLength(1);
  });

  it("refuses a plan that is not the athlete's, an archived one, one it already is, a designer's call, and a proposal already with the athlete", async () => {
    const mine = await plan({ purpose: "Get fitter" });
    const gone = await plan({ archived: true });
    const theirs = await plan({ owner: (await makeTestUser(db, { timezone: "UTC" })).userId });
    const ctx = await mainRun();
    const code = async (input: Record<string, unknown>, as: ToolContext = ctx) => {
      const { res } = await change(as, input);
      return isToolErr(res) ? `${res.error}: ${res.why}` : "stored";
    };
    expect(await code({ planId: theirs, brief: "x" })).toMatch(/^not_your_plan/);
    expect(await code({ planId: gone, brief: "x" })).toMatch(/^not_your_plan/);
    expect(await code({ planId: "no-such-plan", brief: "x" })).toMatch(/^not_your_plan/);
    expect(await code({ planId: mine, purpose: "Get fitter", onEnd: "ask" })).toBe("no_change: Base block already has that purpose and that ending.");
    const designer: ToolContext = { ...ctx, run: { ...ctx.run, role: "designer", parentId: ctx.run.id } };
    const d = await changePlan.run(designer, { planId: mine, brief: "x", why: "y" });
    expect(isToolErr(d) && d.error).toBe("not_for_role");
    expect(await db.select().from(coachProposals)).toEqual([]);
    // With the athlete already: not changed under them.
    ok((await change(ctx, { planId: mine, brief: "A steady build." })).res);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    const later = await code({ planId: mine, brief: "Another." }, { ...ctx, toolUseId: "toolu_later" });
    expect(later).toMatch(/^proposal_pending/);
  });

  it("a replay of a call answers what it stored and adds nothing; a second call for the plan replaces the first", async () => {
    const p = await plan({});
    const ctx = await mainRun();
    const first = { ...ctx, toolUseId: "toolu_first" };
    const a = ok((await change(first, { planId: p, brief: "A steady build." })).res);
    const before = JSON.stringify((await proposalOf(designProposalId(ctx.run.id))).ops);
    const replay = ok((await change(first, { planId: p, brief: "A steady build." })).res);
    expect(replay.data).toEqual(a.data);
    expect(JSON.stringify((await proposalOf(designProposalId(ctx.run.id))).ops)).toBe(before);
    ok((await change({ ...ctx, toolUseId: "toolu_second" }, { planId: p, brief: "A steady build, then a rest week." })).res);
    const ops = (await proposalOf(designProposalId(ctx.run.id))).ops as DesignedPlanChangeOp[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ change: { brief: "A steady build, then a rest week." }, replaces: ["toolu_first"] });
    expect(ok((await change(first, { planId: p, brief: "A steady build." })).res).data).toMatchObject({ superseded: true });
  });

  it("the words, unit by unit: a line a field, the title by the fields, nothing for what is the same", () => {
    const from: PlanChangeFields = { purpose: "Get fitter", brief: null, onEnd: "ask", pausedUntil: "2026-10-20", objectiveIds: ["a"], easeNext: false };
    expect(planSettingLines(from, { ...from, purpose: null, brief: "Slow build", pausedUntil: null, objectiveIds: ["a", "b"], easeNext: true })).toEqual([
      "Purpose cleared",
      "Brief: Slow build",
      "Pause lifted",
      "Objectives 1 → 2 objectives",
      "Next session eased",
    ]);
    expect(planSettingLines(from, from)).toEqual([]);
    expect(planSettingLines({ ...from, easeNext: true }, { ...from, onEnd: "finish", objectiveIds: [] })).toEqual([
      "When it ends: Ask me → Finish",
      "Objectives 1 → 0 objectives",
      "Next session not eased",
    ]);
    expect(planChangeTitle("Base block", ["brief"])).toBe("Base block: new brief");
    expect(planChangeTitle("Base block", ["brief", "purpose"])).toBe("Base block: new purpose and brief");
    expect(planChangeTitle("Base block", ["onEnd", "pausedUntil", "easeNext"])).toBe("Base block: new ending, pause and easing");
    expect(planChangeTitle("Base block", ["purpose", "brief", "onEnd", "pausedUntil"])).toBe("Base block: new settings");
  });
});

describe("approving a plan change", () => {
  it("writes the fields and one version through the same function as PATCH /api/plans/:id — one request, within the budget, the receipt once", async () => {
    const p = await plan({ purpose: "Get fitter" });
    const { id } = await proposed(p, { purpose: "Run a first 10K", brief: "Easy weeks, then one long run.", onEnd: "finish" });
    expect(await versionsOf(p)).toEqual([]);
    seen = [];
    const { answers, costs } = await approveAll(id);
    expect(answers).toHaveLength(1);
    // The declared cost holds what was measured: from the stale check's read to the version's insert.
    const from = seen.findIndex((q) => /^select "kind", "disciplines", "purpose"/.test(q));
    const to = seen.findIndex((q) => /^insert into "program_versions"/.test(q));
    expect(from).toBeGreaterThan(-1);
    expect(to - from + 1).toBe(PLAN_CHANGE_COST);
    seen = null;
    expect(costs[0]).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(PLAN_CHANGE_COST + APPROVE_FIXED).toBeLessThan(REQUEST_BUDGET);
    expect(answers[0]).toMatchObject({ status: "approved", remaining: [], refused: [] });
    expect(answers[0]!.planned).toEqual([{ opId: planChangeId(p), summary: "Ending: Finish" }]);
    expect(await rowOf(p)).toMatchObject({ purpose: "Run a first 10K", brief: "Easy weeks, then one long run.", onEnd: "finish" });
    const versions = await versionsOf(p);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.summary).toEqual({ changed: ["purpose", "brief", "onEnd"] });
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "applied", changed: ["purpose", "brief", "onEnd"] });
    const receipts = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")));
    // Named once: the op's title is the proposal's, so the line says only what the plan ends by.
    expect(receipts.map((r) => r.body)).toEqual(["✓ approved — Base block: new purpose, brief and ending: Ending: Finish"]);
    // Asked again: settled, nothing more written.
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.json).toMatchObject({ status: "approved", settled: [{ opId: planChangeId(p), outcome: "applied" }], remaining: [] });
    expect(await versionsOf(p)).toHaveLength(1);
  });

  it("the athlete's own edit since it was suggested refuses it stale, in a programme change's words, and writes nothing", async () => {
    const p = await plan({ purpose: "Get fitter" });
    const { id } = await proposed(p, { purpose: "Run a first 10K", onEnd: "continue" });
    // The athlete edited the purpose in the plan's sheet meanwhile.
    expect((await applyPlanPatch(db, userId, p, { purpose: "Stay injury free" }, NOW.toISOString(), TODAY)).ok).toBe(true);
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.refused).toEqual([{ opId: planChangeId(p), error: "stale", why: "Its settings changed since this was suggested: ask the coach again." }]);
    expect(res.json.applied ?? []).toEqual([]);
    // Neither field was written: not the coach's purpose, not its ending.
    expect(await rowOf(p)).toMatchObject({ purpose: "Stay injury free", onEnd: "ask" });
    expect(await versionsOf(p)).toHaveLength(1);
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "refused", error: "stale" });
  });

  it("a field the athlete set to what the coach asked for is not stale (an approve retried after its request died); a plan archived since is refused", async () => {
    const p = await plan({ purpose: "Get fitter" });
    const { id } = await proposed(p, { purpose: "Run a first 10K" });
    await applyPlanPatch(db, userId, p, { purpose: "Run a first 10K" }, NOW.toISOString(), TODAY);
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.json).toMatchObject({ status: "approved", refused: [] });
    expect(await versionsOf(p)).toHaveLength(1);
    const q = await plan({});
    const gone = await proposed(q, { brief: "x" });
    await db.update(programs).set({ archivedAt: NOW.toISOString() }).where(eq(programs.id, q));
    const r2 = await invoke("POST", `/api/coach/proposals/${gone.id}/approve`, {});
    expect(r2.json.refused).toEqual([{ opId: planChangeId(q), error: "stale", why: "That plan isn't there any more." }]);
  });

  it("a pause that has gone by when it is approved is refused by the plan's own rule, nothing written", async () => {
    const p = await plan({});
    const { id } = await proposed(p, { pausedUntil: TODAY });
    vi.setSystemTime(new Date("2026-10-15T08:00:00.000Z"));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.json.refused).toEqual([{ opId: planChangeId(p), error: "plan_refused", why: "a pause cannot end before today" }]);
    expect((await rowOf(p)).pausedUntil).toBeNull();
  });

  it("declining it writes nothing, and the plan is as it was", async () => {
    const p = await plan({ purpose: "Get fitter" });
    const { id } = await proposed(p, { purpose: "Run a first 10K" });
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [planChangeId(p)] });
    expect(res.status).toBe(200);
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "declined" });
    expect(await rowOf(p)).toMatchObject({ purpose: "Get fitter" });
    expect(await versionsOf(p)).toEqual([]);
  });

  it("beside a whole plan in one proposal: one suggestion shows both parts and one approve applies both", async () => {
    const p = await plan({ purpose: "Get fitter", brief: "Base block." });
    const ctx = await mainRun();
    const monday = mondayOf(addDays(TODAY, 7));
    const created = await proposePlan.run(ctx, {
      change: {
        kind: "createPlan", discipline: "run", name: "Build block", startDate: monday, endDate: addDays(monday, 20),
        firmSessions: [{ date: monday, session: { category: "easy", title: "Easy run", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } } }],
        shapeWeeks: [0, 1].map((k) => ({ weekStart: addDays(monday, 7 * (k + 1)), volumeTarget: "about 30 km", keySessions: ["long run"] })),
      },
      why: "The next phase.",
    });
    expect(isToolErr(created) ? created.why : "").toBe("");
    ok((await change(ctx, { planId: p, brief: "Base block, then the build." })).res);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const kinds = ((await proposalOf(id)).ops as Array<{ kind: string }>).map((o) => o.kind);
    expect(kinds).toEqual(["plan_structure", "plan_change"]);
    const read = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(read.json.plans).toHaveLength(1);
    expect(read.json.planChanges).toEqual([
      expect.objectContaining({ opId: planChangeId(p), planId: p, title: "Base block: new brief", lines: ["Brief: Base block, then the build."], outcome: null }),
    ]);
    // In the conversation: ONE card — the plan's, its lines then the change's, naming both ops for its one Approve.
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, ctx.run.id));
    const conv = await readConversation(db, userId, NOW, { endedLine });
    const cards = conv.turns.at(-1)!.cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "plan", opIds: ["plan", planChangeId(p)] });
    expect(cards[0]!.lines!.at(-1)).toBe("Brief: Base block, then the build.");
    expect(cards[0]!.lines!.length).toBeGreaterThan(1);
    const { answers, costs } = await approveAll(id);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(answers.at(-1)).toMatchObject({ status: "approved", remaining: [], refused: [] });
    expect((await rowOf(p)).brief).toBe("Base block, then the build.");
    expect((await db.select().from(coachPlans).where(eq(coachPlans.id, `cp-${id}-0`))).length).toBe(1);
    const last = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(last.json.planChanges[0].outcome).toMatchObject({ status: "applied", changed: ["brief"] });
  });
});

describe("every reader of designed proposals tolerates the kind", () => {
  it("the conversation's card and block, read_proposals, the proposal's title and expiry, and the cover rule", async () => {
    const p = await plan({ name: "Base block", purpose: "Get fitter" });
    const older = await proposed(p, { purpose: "Run a first 10K" });
    const fields = proposalFields((await proposalOf(older.id)).ops as unknown[]);
    expect(fields).toMatchObject({ title: "Base block: new purpose", rationale: "It is what you told me you want.", expiresAt: "2026-10-17" });
    const read = ok(await readProposals.run(older.ctx, {}));
    expect(JSON.stringify(read.data)).toContain('"kind":"plan_change"');
    expect(JSON.stringify(read.data)).toContain("Base block: new purpose");
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, older.ctx.run.id));
    const conv = await readConversation(db, userId, NOW, { endedLine });
    expect(conv.turns.at(-1)!.cards).toEqual([
      expect.objectContaining({ kind: "plan_change", title: "Base block: new purpose", lines: ["Purpose: Run a first 10K"], opId: planChangeId(p) }),
    ]);
    const block = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, older.ctx.run.id), { limit: 6 }), NOW)!;
    expect(block).toContain(`Suggested a plan change (id ${older.id}): ${markUntrusted("main coach", "Base block: new purpose")}`);
    // Another plan's change, older still: never covered. A newer change for this plan covers the older.
    const q = await plan({ name: "Strength" });
    const others = await proposed(q, { brief: "x" });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const newer = await proposed(p, { purpose: "Stay injury free" });
    await supersedeOlderPlans(db, userId, newer.id, NOW.toISOString());
    expect((await proposalOf(older.id)).status).toBe("superseded");
    expect((await opOf(older.id, p)).outcome?.status).toBe("superseded");
    expect((await proposalOf(others.id)).status).toBe("pending");
  });
});
