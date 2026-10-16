/**
 * ORCHESTRATION FOR A WEEK OR THE NEXT N WORKOUTS (Stage 3 Task 7; spec §2, §4, §6; principles §6.9).
 *
 * The real registry, the real opening context and the real loop, driven by ONE scripted model shared by every run of
 * the tree — the main coach, each workout's designer, each designer's reviewer — so the calls come in the order the
 * loop makes them. No key, no network, no billed call.
 *
 *  - plan_set (main only, a set's scope only) checks the briefs, starts one designer sub-run per brief — keyed on the
 *    call and the brief's key, so a replay starts none twice — and pauses the main run (`waiting_set`) until every
 *    designer is over. Designers run one at a time, in brief order, each with its reviewer before the next.
 *  - The set's result comes back as plan_set's: each workout proposed (its op, minutes, balance, review) or left out
 *    with its reason. A designer that fails or stops leaves its slot out; the rest stands.
 *  - The main coach judges the set (read_set), may take a workout out (drop_workout) or redo some once (plan_set
 *    again), then finishes one proposal. A spending limit stops the set gracefully with what was reviewed.
 *
 * Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { cancelRun, createRun, LIVE_STATUSES, ROUTE_OVERHEAD, runStep, STEP_BUDGET, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { DESIGNER_CEILING_MICROS, SET_MAX_WORKOUTS } from "../src/services/design-limits.js";
import { PROMPT_TOOL_NAMES, REVIEW_DIMENSIONS, roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { STOPPED_NOTES } from "../src/services/design-review.js";
import { ACT_TOOLS, allTools, PENDING_TOOL_NAMES } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
let statements = 0;

beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
});

const athlete = () => seedRichAthlete(db);

// The fixture's plan from today on: a programme session every second day (today, +2, +4, +6), an easy run every
// third (+3, +6), a Studio workout today. Free days: +1 and +5; +3 holds a run only.
const THU = day(-1);
const SAT = day(-3);
const MON = day(-5);

// ── One scripted model for the whole tree ───────────────────────────────

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_set${++seq}`, name, input });
const idOf = (b: ContentBlock): string => (b as { id: string }).id;

function turn(uses: ContentBlock[], o: { cost?: number; text?: string } = {}): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: o.text ?? "Working on it." }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: o.cost ?? 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

type Scripted = MessagesResult | (() => MessagesResult | Promise<MessagesResult>);

function scripted(turns: Scripted[]) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return typeof next === "function" ? await next() : next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

const roleOf = (req: MessagesRequest): string => {
  const sys = JSON.stringify(req.system);
  if (sys.includes("# Your role: the independent reviewer")) return "reviewer";
  if (sys.includes("# Your role: a workout's designer")) return "designer";
  return "main";
};

/** Step the main run until it is no longer active (bounded). */
async function drive(userId: string, runId: string, deps: RunDeps, o: { from?: number; max?: number } = {}) {
  const all: Array<{ status: string; nextDue: { runId: string; role: string } | null }> = [];
  const from = o.from ?? 0;
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + (from + i) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result as (typeof all)[number]);
      return out.result.status !== "active";
    },
    { max: o.max ?? 60, what: "drive" },
  );
  return all;
}

function resultsSent(requests: MessagesRequest[]): Map<string, ToolResultBlock> {
  const out = new Map<string, ToolResultBlock>();
  for (const r of requests) {
    for (const m of r.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const b of m.content) if (b.type === "tool_result") out.set(b.tool_use_id, b as ToolResultBlock);
    }
  }
  return out;
}
const textOf = (b: ToolResultBlock | undefined): string => (typeof b?.content === "string" ? b.content : JSON.stringify(b?.content ?? null));
const sentData = (requests: MessagesRequest[], call: ContentBlock): any => JSON.parse(textOf(resultsSent(requests).get(idOf(call)))).data;
const sentError = (requests: MessagesRequest[], call: ContentBlock): { error: string; why: string; fix: string } => {
  const b = resultsSent(requests).get(idOf(call));
  expect(b?.is_error, `${idOf(call)} answered ${textOf(b)}`).toBe(true);
  return JSON.parse(textOf(b));
};
const headerOf = (req: MessagesRequest): string => {
  const m = req.messages[0]!;
  return typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("\n");
};

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[], flags: p.flags as string[] } : undefined;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}
const stateOf = async (id: string) => JSON.parse((await runRow(id)).state!) as Record<string, any>;
async function designersOf(mainId: string) {
  return db
    .select()
    .from(schema.coachRuns)
    .where(and(eq(schema.coachRuns.parentId, mainId), eq(schema.coachRuns.role, "designer")))
    .orderBy(schema.coachRuns.createdAt, schema.coachRuns.id);
}
async function events(runId: string) {
  return db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq);
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
function verdict(score: number, o: { mustFix?: string[] } = {}) {
  return {
    scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
    notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
    mustFix: o.mustFix ?? [],
    improvements: [],
  };
}

interface BriefIn {
  key: string;
  date: string;
  time?: string;
  purpose: string;
  emphasis: string;
  constraints: string;
  why: string;
  sameDayWhy?: string;
  note?: string;
}
const brief = (key: string, date: string, o: Partial<BriefIn> = {}): BriefIn => ({
  key,
  date,
  purpose: `Workout ${key}: hips and trunk, steady.`,
  emphasis: "Control over load.",
  constraints: "About 30 minutes, at home.",
  why: "Spaced away from the runs for recovery.",
  ...o,
});
const planSet = (briefs: BriefIn[]) => use("plan_set", { briefs });
const propose = (title: string, date: string, effort?: string) => {
  const doc = calmDoc({ title });
  return use("propose_workout", { doc: effort ? { ...doc, intent: { ...doc.intent, effort } } : doc, target: { kind: "new", date } });
};
const submit = (v: unknown) => use("submit_review", v);
const finish = (summary: string) => use("finish", { summary });

/** One designer's whole life: a draft, its review, its finish. */
const designed = (title: string, date: string, o: { score?: number; effort?: string; cost?: number } = {}): Scripted[] => [
  turn([propose(title, date, o.effort)], { cost: o.cost }),
  turn([submit(verdict(o.score ?? 4))], { cost: o.cost }),
  turn([finish(`${title}, as briefed.`)], { cost: o.cost }),
];

async function weekRun(userId: string, o: { rehearsal?: boolean; scope?: { kind: "week" } | { kind: "next_n"; n: number } } = {}) {
  return (await createRun(db, userId, { scope: o.scope ?? { kind: "week" }, request: "Plan my week around the runs.", rehearsal: o.rehearsal }, NOW)).run.id;
}

// ── A set, end to end ───────────────────────────────────────────────────

describe("a three-workout set, end to end", () => {
  it("plans, designs each workout with its own reviewer in brief order, judges the set and finishes one pending proposal", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("sat", SAT, { time: "17:30" }), brief("mon", MON)]);
    const look = use("read_set", {});
    const { deps, requests } = scripted([
      t(plan),
      ...designed("Thursday hips", THU),
      ...designed("Saturday trunk", SAT, { score: 5 }),
      ...designed("Monday reset", MON),
      t(look),
      t(finish("Three short sessions, spaced around the runs.")),
    ]);

    // The main coach's context, then plan_set: three designers, and the main run waits for them.
    await runStep(db, env, mainId, a.userId, NOW, deps);
    const planned = await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps);
    expect(planned.kind).toBe("ok");
    expect((await runRow(mainId)).status).toBe("waiting_set");
    expect(LIVE_STATUSES).toContain("waiting_set");
    const designers = await designersOf(mainId);
    expect(designers.map((d) => [d.role, d.parentId, d.status])).toEqual([
      ["designer", mainId, "active"],
      ["designer", mainId, "active"],
      ["designer", mainId, "active"],
    ]);
    // Keyed on the call and the brief's key; in the brief's order.
    for (const [i, key] of ["thu", "sat", "mon"].entries()) {
      expect(designers[i]!.id).toContain(idOf(plan));
      expect(designers[i]!.id.endsWith(key)).toBe(true);
    }
    // The run the next step advances is the first designer; the run shows as working.
    expect(planned.kind === "ok" && planned.result.nextDue).toMatchObject({ runId: designers[0]!.id, role: "designer" });
    expect(planned.kind === "ok" && planned.result.status).toBe("active");

    const steps = await drive(a.userId, mainId, deps, { from: 2 });
    expect(steps.at(-1)!.status).toBe("finished");

    // One model call per step, in the loop's order: each designer's draft, its review, its finish, then the next.
    expect(requests.map(roleOf)).toEqual([
      "main",
      "designer", "reviewer", "designer",
      "designer", "reviewer", "designer",
      "designer", "reviewer", "designer",
      "main", "main",
    ]);

    // Each designer's opening message carries its brief, marked as the main coach's words; not the others'.
    const designerHeaders = requests.filter((r) => roleOf(r) === "designer" && r.messages.length === 1).map(headerOf);
    expect(designerHeaders).toHaveLength(3);
    expect(designerHeaders[0]).toContain('<untrusted from="main coach">');
    expect(designerHeaders[0]).toContain("Workout thu: hips and trunk, steady.");
    expect(designerHeaders[0]).not.toContain("Workout sat");
    expect(designerHeaders[1]).toContain("17:30");

    // plan_set's result, once every designer was over: each workout proposed, with its op, minutes, balance and review.
    const result = sentData(requests, plan);
    const ids = designers.map((d) => d.id);
    expect(result.set).toEqual([
      expect.objectContaining({ key: "thu", date: THU, outcome: "proposed", opId: ids[0], minutes: expect.any(Number), balance: expect.any(Object), reviewMean: 4 }),
      expect.objectContaining({ key: "sat", date: SAT, outcome: "proposed", opId: ids[1], reviewMean: 5 }),
      expect.objectContaining({ key: "mon", date: MON, outcome: "proposed", opId: ids[2], reviewMean: 4 }),
    ]);
    expect(result).toMatchObject({ proposed: 3, leftOut: 0, redoLeft: 1 });
    expect(result.next).toMatch(/read_set/);

    // read_set: the set in date order, each with its review; the combined balance.
    const view = JSON.parse(textOf(resultsSent(requests).get(idOf(look))));
    expect(view.data.workouts.map((w: { key: string; opId: string }) => [w.key, w.opId])).toEqual([
      ["thu", ids[0]],
      ["sat", ids[1]],
      ["mon", ids[2]],
    ]);
    expect(view.data.combined.minutes).toBe(view.data.workouts.reduce((s: number, w: { minutes: number }) => s + w.minutes, 0));

    // One proposal, pending, three ops by the three designers, each with its review.
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => [o.by.runId, o.by.role, o.date, o.review?.rounds])).toEqual([
      [ids[0], "designer", THU, 1],
      [ids[1], "designer", SAT, 1],
      [ids[2], "designer", MON, 1],
    ]);
    expect(p.ops[1]!.time).toBeUndefined(); // the brief's time guides the designer; its target says where it goes
    for (const d of await designersOf(mainId)) expect(d.status).toBe("finished");

    // The trail: the plan, then the set's line once it was in.
    const trail = (await events(mainId)).map((e) => e.summary);
    expect(trail.some((s) => s.startsWith("Planned 3 workouts"))).toBe(true);
    expect(trail).toContain("The set is designed: 3 proposed.");
  });

  it("each designer inherits the main run's window, clock, timezone and rehearsal; its ceiling is a workout's", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId, { rehearsal: true });
    const { deps } = scripted([t(planSet([brief("thu", THU), brief("mon", MON)]))]);
    await runStep(db, env, mainId, a.userId, NOW, deps);
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps);
    const main = await stateOf(mainId);
    const designers = await designersOf(mainId);
    expect(designers).toHaveLength(2);
    for (const d of designers) {
      expect(d).toMatchObject({ request: "Plan my week around the runs.", scope: { kind: "week" } });
      const s = JSON.parse(d.state!) as Record<string, any>;
      expect(s.settings).toMatchObject({
        window: main.settings.window,
        timezone: main.settings.timezone,
        rehearsal: true,
        ceilingMicros: DESIGNER_CEILING_MICROS,
      });
      expect(s.toldAt).toBe(main.toldAt);
      expect(typeof s.brief).toBe("string");
    }
    expect(DESIGNER_CEILING_MICROS).toBe(1_500_000);
  });

  it("the set's cost estimate is stored in the main run's state and shown with the plan: the default before any measured run", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([t(planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)]))]);
    await runStep(db, env, mainId, a.userId, NOW, deps);
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps);
    const estimate = (await stateOf(mainId)).estimate;
    expect(estimate).toMatchObject({ workouts: 3, basis: { designer: "default", main: "default" } });
    expect(estimate.micros).toBe(3 * estimate.perWorkoutMicros + estimate.mainMicros);
    const plannedLine = (await events(mainId)).find((e) => e.summary.startsWith("Planned 3 workouts"))!;
    expect(plannedLine.payload).toMatchObject({ receipt: { estimate: { micros: estimate.micros } } });
  });

  it("the estimate is measured once runs exist: each finished designer with its reviewers, and the set's main runs", async () => {
    const a = await athlete();
    // Three earlier designers ($0.50, $0.70 with a $0.20 reviewer, $0.60) under a finished week's main run ($0.30).
    const at = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const row = (id: string, o: { parentId?: string | null; role: string; cost: number; status?: string; scope?: Record<string, unknown> }) => ({
      id, userId: a.userId, parentId: o.parentId ?? null, role: o.role, scope: o.scope ?? { kind: "week" }, request: null,
      status: o.status ?? "finished", state: null, steps: 1, costUsd: o.cost, createdAt: at, updatedAt: at,
    });
    await db.insert(schema.coachRuns).values([
      row(`old-main-${a.userId}`, { role: "main", cost: 0.3 }),
      row(`old-d1-${a.userId}`, { role: "designer", parentId: `old-main-${a.userId}`, cost: 0.5 }),
      row(`old-d2-${a.userId}`, { role: "designer", parentId: `old-main-${a.userId}`, cost: 0.5 }),
      row(`old-r2-${a.userId}`, { role: "reviewer", parentId: `old-d2-${a.userId}`, cost: 0.2 }),
      row(`old-d3-${a.userId}`, { role: "designer", parentId: `old-main-${a.userId}`, cost: 0.6 }),
      // A failed designer is not a measure of what a workout costs.
      row(`old-d4-${a.userId}`, { role: "designer", parentId: `old-main-${a.userId}`, cost: 3, status: "failed" }),
      // A now run's main is not a set's.
      row(`old-now-${a.userId}`, { role: "main", cost: 2, scope: { kind: "now" } }),
    ]);
    // Runs older than the estimate's window don't count.
    const long = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    await db.insert(schema.coachRuns).values([
      { ...row(`old-d6-${a.userId}`, { role: "designer", parentId: `old-main-${a.userId}`, cost: 5 }), createdAt: long, updatedAt: long },
      { ...row(`old-main2-${a.userId}`, { role: "main", cost: 4 }), createdAt: long, updatedAt: long },
    ]);
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([t(planSet([brief("thu", THU), brief("mon", MON)]))]);
    await runStep(db, env, mainId, a.userId, NOW, deps);
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps);
    expect((await stateOf(mainId)).estimate).toEqual({
      micros: 2 * 600_000 + 300_000,
      workouts: 2,
      perWorkoutMicros: 600_000,
      mainMicros: 300_000,
      basis: { designer: "measured", main: "measured" },
      samples: { designers: 3, mains: 1 },
    });
  });
});

// ── Failure isolation ───────────────────────────────────────────────────

describe("a designer that fails leaves its slot out; the rest of the set stands", () => {
  it("a failed designer: the proposal holds the other two workouts and a note saying why the third is missing", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)]);
    const { deps, requests } = scripted([
      t(plan),
      ...designed("Thursday hips", THU),
      { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult,
      ...designed("Monday reset", MON),
      t(finish("Two sessions; Saturday couldn't be designed.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const designers = await designersOf(mainId);
    expect(designers.map((d) => d.status)).toEqual(["finished", "failed", "finished"]);
    const result = sentData(requests, plan);
    expect(result.set[1]).toMatchObject({ key: "sat", date: SAT, outcome: "left_out", reason: expect.stringContaining("the AI service refused the request") });
    expect(result).toMatchObject({ proposed: 2, leftOut: 1 });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.date)).toEqual([THU, MON]);
    expect(p.flags).toEqual([expect.stringMatching(/^No workout for Saturday 16 May: .*the AI service refused the request/)]);
    expect((await events(mainId)).map((e) => e.summary)).toContain("The set is designed: 2 proposed, 1 left out.");
  });

  it("a designer whose review was dropped and that finished without proposing again: its unreviewed draft is taken out, never shown", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("mon", MON)]);
    const { deps, requests } = scripted([
      t(plan),
      t(propose("Thursday hips", THU)),
      { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult, // its reviewer
      t(finish("I'll leave Thursday as it is.")),
      ...designed("Monday reset", MON),
      t(finish("One session.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const result = sentData(requests, plan);
    expect(result.set[0]).toMatchObject({
      key: "thu",
      outcome: "left_out",
      reason: expect.stringContaining("review"),
      designerSaid: { untrusted: true, text: "I'll leave Thursday as it is." },
    });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.date)).toEqual([MON]);
    expect(p.ops.every((o) => o.review !== null)).toBe(true);
  });

  it("a designer that reaches its own spending limit stops alone: the set goes on, its slot is left out", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("mon", MON)]);
    const { deps, requests } = scripted([
      t(plan),
      // Thursday's draft costs more than a workout's limit: its reviewer is not called.
      turn([propose("Thursday hips", THU)], { cost: DESIGNER_CEILING_MICROS + 100_000 }),
      ...designed("Monday reset", MON),
      t(finish("One session.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(requests.map(roleOf)).toEqual(["main", "designer", "designer", "reviewer", "designer", "main"]);
    const designers = await designersOf(mainId);
    expect(designers.map((d) => [d.status, d.error])).toEqual([
      ["stopped_cap", "run_ceiling"],
      ["finished", null],
    ]);
    expect(sentData(requests, plan).set[0]).toMatchObject({ key: "thu", outcome: "left_out", reason: expect.stringContaining("spending limit ($1.50)") });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.date)).toEqual([MON]);
    const lines = (await events(mainId)).map((e) => e.summary).filter((s) => s.includes("spending limit"));
    expect(lines).toEqual(["This workout's design reached its spending limit ($1.50) — it stopped; the rest of the set goes on."]);
  });

  it("a designer that stops after its draft was reviewed keeps that reviewed version, and says how it stopped", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("mon", MON)]);
    const { deps, requests } = scripted([
      t(plan),
      turn([propose("Thursday hips", THU)], { cost: 1_000_000 }),
      turn([submit(verdict(4, { mustFix: ["Shorter rests."] }))], { cost: 600_000 }),
      // Thursday's designer, resumed with its review, is past its limit: its next call is never made.
      ...designed("Monday reset", MON),
      t(finish("Two sessions.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(requests.map(roleOf)).toEqual(["main", "designer", "reviewer", "designer", "reviewer", "designer", "main"]);
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["stopped_cap", "finished"]);
    expect(sentData(requests, plan).set[0]).toMatchObject({
      key: "thu",
      outcome: "proposed",
      reviewMean: 4,
      mustFix: 1,
      note: "the designer reached its spending limit ($1.50) after a draft was reviewed: the reviewed version stands",
    });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday hips", "Monday reset"]);
  });
});

// ── The main coach's lever over the set ─────────────────────────────────

describe("main judges the set and acts on it", () => {
  it("drop_workout takes one workout out of the proposal, with a plain reason for the athlete", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    let drop: ContentBlock | undefined;
    const look = use("read_set", {});
    const { deps, requests } = scripted([
      t(planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)])),
      ...designed("Thursday hips", THU),
      ...designed("Saturday trunk", SAT),
      ...designed("Monday reset", MON),
      async () => {
        drop = use("drop_workout", { opId: (await designersOf(mainId))[1]!.id, reason: "Saturday follows the long run: rest is the better choice." });
        return t(drop, look);
      },
      t(finish("Two sessions around the runs.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(sentData(requests, drop!)).toMatchObject({ dropped: true, key: "sat", workoutsLeft: 2 });
    expect(JSON.parse(textOf(resultsSent(requests).get(idOf(look)))).data.workouts.map((w: { key: string }) => w.key)).toEqual(["thu", "mon"]);
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.date)).toEqual([THU, MON]);
    expect(p.flags).toEqual(["Left out “Saturday trunk” (Saturday 16 May): Saturday follows the long run: rest is the better choice."]);
    expect((await events(mainId)).map((e) => e.summary)).toContain(
      "Took out “Saturday trunk” (Saturday 16 May): Saturday follows the long run: rest is the better choice.",
    );
  });

  it("drop_workout refuses an op that isn't in the set, naming the ones that are; and is the main coach's alone", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const wrong = use("drop_workout", { opId: "no-such-op", reason: "Too much." });
    const { deps, requests } = scripted([t(planSet([brief("thu", THU)])), ...designed("Thursday hips", THU), t(wrong), t(finish("One session."))]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const err = sentError(requests, wrong);
    expect(err.error).toBe("not_found");
    expect(err.fix).toContain((await designersOf(mainId))[0]!.id);
    const roles = Object.fromEntries(ACT_TOOLS.map((x) => [x.name, x.roles]));
    expect(roles).toMatchObject({ plan_set: ["main"], read_set: ["main"], drop_workout: ["main"] });
  });

  it("drop_workout before a set, on a proposal already settled, or racing another write: refused, nothing lost", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const op = (runId: string, date: string, title: string) =>
      ({
        kind: "doc_workout", target: { kind: "new", date }, date, doc: calmDoc({ title }), review: { ...verdict(4), rounds: 1, changes: [] }, issues: [],
        derived: { minutes: 20 }, by: { runId, role: "designer" }, toolUseId: `u-${runId}`, at: NOW.toISOString(),
      }) as unknown as DocWorkoutOp;
    await db.insert(schema.coachProposals).values({
      id: designProposalId(mainId), userId: a.userId, planId: null, title: "2 workouts", evidence: "", rationale: "", flags: [],
      ops: [op("d-thu", THU, "Thursday hips"), op("d-mon", MON, "Monday reset")], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: MON,
    });
    const round = { toolUseId: "p", redo: false, briefs: [], designers: [{ key: "thu", runId: "d-thu" }, { key: "mon", runId: "d-mon" }] };
    const ctxWith = (d: Db, rounds: unknown[]) =>
      ({ db: d, env, userId: a.userId, now: NOW, run: { id: mainId, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }, set: { rounds: () => rounds, start: async () => [] } }) as unknown as ToolContext;
    const drop = allTools().find((x) => x.name === "drop_workout")!;
    const input = { opId: "d-thu", reason: "Too much." };

    expect(((await drop.run(ctxWith(db, []), input)) as ToolErr).error).toBe("no_set");

    // Another write lands on the proposal between drop_workout's read and its write.
    let raced = false;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "all" || typeof value !== "function") return value;
        return async (q: { queryChunks?: Array<{ value?: unknown }> }) => {
          const text = (q.queryChunks ?? []).map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");
          if (!raced && text.includes("UPDATE coach_proposals")) {
            raced = true;
            const now = (await proposalOf(mainId))!.ops.map((o) => ({ ...o, at: "changed meanwhile" }));
            await db.update(schema.coachProposals).set({ ops: now }).where(eq(schema.coachProposals.id, designProposalId(mainId)));
          }
          return (value as (q: unknown) => Promise<unknown>).call(target, q);
        };
      },
    }) as Db;
    expect(((await drop.run(ctxWith(racing, [round]), input)) as ToolErr).error).toBe("proposal_changed");
    expect(raced).toBe(true);
    expect((await proposalOf(mainId))!.ops.map((o) => [o.by.runId, o.at])).toEqual([
      ["d-thu", "changed meanwhile"],
      ["d-mon", "changed meanwhile"],
    ]);

    await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, designProposalId(mainId)));
    expect(((await drop.run(ctxWith(db, [round]), input)) as ToolErr).error).toBe("proposal_closed");
    expect((await proposalOf(mainId))!.ops).toHaveLength(2);
  });

  it("a redo: plan_set once more for one key, with a note; its new design replaces the old once reviewed; a third call is refused", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const first = planSet([brief("thu", THU), brief("sat", SAT)]);
    const redo = planSet([brief("sat", SAT, { note: "Gentler: Saturday follows the long run." })]);
    const third = planSet([brief("thu", THU, { note: "Once more." })]);
    const { deps, requests } = scripted([
      t(first),
      ...designed("Thursday hips", THU),
      ...designed("Saturday trunk", SAT),
      t(redo),
      ...designed("Saturday, gentler", SAT, { score: 5 }),
      t(third),
      t(finish("Two sessions; Saturday eased.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const designers = await designersOf(mainId);
    expect(designers).toHaveLength(3);
    const redone = designers[2]!;
    expect(redone.id).toContain(idOf(redo));
    // The new designer's brief carries the note and names the first version.
    const redoHeader = requests.filter((r) => roleOf(r) === "designer" && r.messages.length === 1).map(headerOf)[2]!;
    expect(redoHeader).toContain("Gentler: Saturday follows the long run.");
    expect(redoHeader).toContain("Saturday trunk");
    expect(sentData(requests, redo)).toMatchObject({ set: [expect.objectContaining({ key: "sat", outcome: "replaced", opId: redone.id, reviewMean: 5 })], redoLeft: 0 });
    const refused = sentError(requests, third);
    expect(refused.error).toBe("set_done");
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => [o.by.runId, o.doc.title])).toEqual([
      [designers[0]!.id, "Thursday hips"],
      [redone.id, "Saturday, gentler"],
    ]);
  });

  it("a redo that couldn't be designed keeps the first version", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const redo = planSet([brief("thu", THU, { note: "Shorter." })]);
    const { deps, requests } = scripted([
      t(planSet([brief("thu", THU)])),
      ...designed("Thursday hips", THU),
      t(redo),
      { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult,
      t(finish("One session.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const designers = await designersOf(mainId);
    expect(sentData(requests, redo).set[0]).toMatchObject({ key: "thu", outcome: "kept_first", opId: designers[0]!.id, reason: expect.stringContaining("refused") });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday hips"]);
  });

  it("a redo of a day left out: designed this time, it joins the set, and the line saying the day had none is taken back", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const redo = planSet([brief("sat", SAT, { note: "Try again, shorter." })]);
    const { deps, requests } = scripted([
      t(planSet([brief("thu", THU), brief("sat", SAT)])),
      ...designed("Thursday hips", THU),
      { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult,
      t(redo),
      ...designed("Saturday, short", SAT),
      t(finish("Two sessions.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(sentData(requests, redo).set[0]).toMatchObject({ key: "sat", outcome: "proposed" });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday hips", "Saturday, short"]);
    expect(p.flags).toEqual([]);
  });

  it("a redo names only keys of the first plan, and carries a note", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const unknown = planSet([brief("fri", day(-2), { note: "New.", sameDayWhy: "Short." })]);
    const noNote = planSet([brief("thu", THU)]);
    const { deps, requests } = scripted([t(planSet([brief("thu", THU)])), ...designed("Thursday hips", THU), t(unknown, noNote), t(finish("One session."))]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(sentError(requests, unknown)).toMatchObject({ error: "invalid_briefs", why: expect.stringContaining('"fri"') });
    expect(sentError(requests, noNote)).toMatchObject({ error: "invalid_briefs", why: expect.stringContaining("note") });
    expect(await designersOf(mainId)).toHaveLength(1);
  });

  it("calls queued after plan_set are answered, not run, until the set is in", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const early = finish("Done already?");
    const plan = planSet([brief("thu", THU)]);
    const { deps, requests } = scripted([t(plan, early), ...designed("Thursday hips", THU), t(finish("One session."))]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(sentError(requests, early)).toMatchObject({ error: "not_run" });
    expect(sentData(requests, plan).set[0]).toMatchObject({ outcome: "proposed" });
    // The turn's results go back as one message, in the model's order: the set's outcome, then the call not run.
    const last = requests.at(-1)!.messages.at(-1)!;
    const ids = (last.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(ids).toEqual([idOf(plan), idOf(early)]);
    expect((await proposalOf(mainId))!.status).toBe("pending");
  });
});

// ── Money ───────────────────────────────────────────────────────────────

describe("the set stops gracefully at the run's ceiling, keeping what is reviewed", () => {
  it("the main run's ceiling, reached during the second designer: the first workout is proposed with the stop's note", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps); // the context
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 50_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const c = { cost: 10_000 };
    const { deps, requests } = scripted([
      turn([planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)])], c),
      ...designed("Thursday hips", THU, c),
      turn([propose("Saturday trunk", SAT)], c),
      // Saturday's reviewer would be the call past the limit.
    ]);
    const steps = await drive(a.userId, mainId, deps, { from: 1 });
    expect(steps.at(-1)!.status).toBe("stopped_cap");
    expect(requests).toHaveLength(5);
    expect((await runRow(mainId))).toMatchObject({ status: "stopped_cap", error: "run_ceiling" });
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["finished", "stopped_cap", "stopped_cap"]);
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday hips"]);
    expect(p.flags[0]).toBe(STOPPED_NOTES.run_ceiling);
    expect(p.flags.slice(1)).toEqual([expect.stringContaining("Saturday trunk")]);
    expect((await events(mainId)).at(-1)!.summary).toBe("Proposed what had been reviewed before the stop.");
  });

  it("a designer's limit and the set's both reached: the set's — the highest — stops the whole set at once", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps);
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 1_000_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const { deps, requests } = scripted([t(planSet([brief("thu", THU), brief("mon", MON)])), turn([propose("Thursday hips", THU)], { cost: DESIGNER_CEILING_MICROS + 100_000 })]);
    expect((await drive(a.userId, mainId, deps, { from: 1 })).at(-1)!.status).toBe("stopped_cap");
    expect(requests).toHaveLength(2);
    expect(await runRow(mainId)).toMatchObject({ status: "stopped_cap", error: "run_ceiling" });
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["stopped_cap", "stopped_cap"]);
    const lines = (await events(mainId)).map((e) => e.summary).filter((x) => x.includes("spending limit"));
    expect(lines).toEqual(["This design reached its spending limit ($1.00) — the coach stopped here."]);
  });

  it("a designer stopped while its revision was under review: the revision is dropped, the reviewed version stands, the set is proposed", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const plan = planSet([brief("thu", THU), brief("mon", MON)]);
    const { deps, requests } = scripted([
      t(plan),
      turn([propose("Thursday hips", THU)], { cost: 100_000 }),
      turn([submit(verdict(3, { mustFix: ["Shorter rests."] }))], { cost: 100_000 }),
      // The revision takes Thursday's designer past its limit: its reviewer's call is never made.
      turn([use("propose_workout", { doc: calmDoc({ title: "Thursday hips, shorter rests" }), target: { kind: "new", date: THU }, changeNote: "Shorter rests." })], { cost: 1_400_000 }),
      ...designed("Monday reset", MON),
      t(finish("Two sessions.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    expect(requests.map(roleOf)).toEqual(["main", "designer", "reviewer", "designer", "designer", "reviewer", "designer", "main"]);
    expect(sentData(requests, plan).set[0]).toMatchObject({ key: "thu", outcome: "proposed", reviewMean: 3 });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    const thu = p.ops[0]!;
    expect(thu.doc.title).toBe("Thursday hips");
    expect(thu.candidate).toBeUndefined();
    expect(thu.review!.changes).toEqual(["Shorter rests — not reviewed: its designer stopped before the review was in."]);
  });

  it("the set's ceiling reached while a revision is under review: the revision is dropped, the reviewed version proposed", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps);
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 1_000_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const { deps } = scripted([
      t(planSet([brief("thu", THU), brief("mon", MON)])),
      turn([propose("Thursday hips", THU)], { cost: 100_000 }),
      turn([submit(verdict(3, { mustFix: ["Shorter rests."] }))], { cost: 100_000 }),
      turn([use("propose_workout", { doc: calmDoc({ title: "Thursday hips, shorter rests" }), target: { kind: "new", date: THU }, changeNote: "Shorter rests." })], { cost: 900_000 }),
    ]);
    expect((await drive(a.userId, mainId, deps, { from: 1 })).at(-1)!.status).toBe("stopped_cap");
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0]!.doc.title).toBe("Thursday hips");
    expect(p.ops[0]!.candidate).toBeUndefined();
    expect(p.ops[0]!.review!.changes).toEqual(["Shorter rests — not reviewed: the coach stopped before its review was in."]);
    expect(p.flags).toEqual([STOPPED_NOTES.run_ceiling]);
  });

  it("a rehearsal set stopped at its ceiling stays a rehearsal: nothing is made pending", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId, { rehearsal: true });
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps);
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 50_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const c = { cost: 10_000 };
    const { deps } = scripted([
      turn([planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)])], c),
      ...designed("Thursday hips", THU, c),
      turn([propose("Saturday trunk", SAT)], c),
    ]);
    expect((await drive(a.userId, mainId, deps, { from: 1 })).at(-1)!.status).toBe("stopped_cap");
    expect((await proposalOf(mainId))!.status).toBe("rehearsal");
  });

  it("stopped before anything was reviewed: nothing is proposed", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps);
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 15_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const c = { cost: 10_000 };
    const { deps } = scripted([turn([planSet([brief("thu", THU), brief("mon", MON)])], c), turn([propose("Thursday hips", THU)], c)]);
    expect((await drive(a.userId, mainId, deps, { from: 1 })).at(-1)!.status).toBe("stopped_cap");
    expect((await proposalOf(mainId))!.status).toBe("unreviewed");
  });
});

// ── plan_set's checks ───────────────────────────────────────────────────

describe("plan_set's checks", () => {
  /** A main run's ToolContext with the loop's set hooks stubbed: no set planned yet, and nothing may start. */
  async function ctxFor(userId: string, scope: ToolContext["run"]["scope"]): Promise<{ ctx: ToolContext; started: unknown[] }> {
    const id = (await createRun(db, userId, { scope, request: null }, NOW)).run.id;
    const started: unknown[] = [];
    const ctx = {
      db,
      env,
      userId,
      now: NOW,
      toolUseId: `toolu_check${++seq}`,
      run: { id, role: "main", scope, parentId: null, rehearsal: false },
      set: {
        rounds: () => [],
        start: async (designers: unknown[]) => {
          started.push(...designers);
          return [];
        },
      },
    } as unknown as ToolContext;
    return { ctx, started };
  }
  const tool = (name: string) => allTools().find((x) => x.name === name)!;
  const refusal = (r: ToolOk | ToolErr): ToolErr => {
    expect(isToolErr(r), JSON.stringify(r)).toBe(true);
    return r as ToolErr;
  };

  it("is refused for now and later today, teachably", async () => {
    for (const kind of ["now", "later_today"] as const) {
      const a = await athlete();
      const { ctx, started } = await ctxFor(a.userId, { kind });
      const err = refusal(await tool("plan_set").run(ctx, { briefs: [brief("thu", THU)] }));
      expect(err.error).toBe("not_for_scope");
      expect(err.fix).toMatch(/propose_workout/);
      expect(started).toHaveLength(0);
    }
  });

  it("refuses a past date, a date past the scope's horizon, too many briefs, a doubled date or a programme day without a reason — every problem at once", async () => {
    const a = await athlete();
    const { ctx, started } = await ctxFor(a.userId, { kind: "week" });
    const err = refusal(
      await tool("plan_set").run(ctx, {
        briefs: [
          brief("past", day(1)),
          brief("far", day(-7)),
          brief("one", THU),
          brief("two", THU),
          brief("prog", day(-2)),
        ],
      }),
    );
    expect(err.error).toBe("invalid_briefs");
    expect(err.why).toContain(`"past": ${day(1)} is before today (${TODAY})`);
    expect(err.why).toContain(`"far": ${day(-7)} is after this week's last day (${day(-6)})`);
    expect(err.why).toMatch(/"two": .*another brief/);
    expect(err.why).toMatch(/"prog": .*programme session/);
    expect(started).toHaveLength(0);

    const many = refusal(await tool("plan_set").run(ctx, { briefs: Array.from({ length: SET_MAX_WORKOUTS + 1 }, (_, i) => brief(`k${i}`, addDays(TODAY, i % 7), { sameDayWhy: "A short second session." })) }));
    expect(many.error).toBe("invalid_input");
    expect(SET_MAX_WORKOUTS).toBe(7);

    const b = await athlete();
    const next = await ctxFor(b.userId, { kind: "next_n", n: 2 });
    const tooMany = refusal(await tool("plan_set").run(next.ctx, { briefs: [brief("a", THU), brief("b", SAT), brief("c", MON)] }));
    expect(tooMany.why).toContain("at most 2");
  });

  it("a doubled date, or a programme day, is accepted with its reason — and every brief needs its key once", async () => {
    const a = await athlete();
    const { ctx, started } = await ctxFor(a.userId, { kind: "week" });
    const ok = await tool("plan_set").run(ctx, {
      briefs: [brief("am", THU), brief("pm", THU, { sameDayWhy: "Ten minutes of mobility after work." }), brief("prog", day(-2), { sameDayWhy: "Care work only, after the programme." })],
    });
    expect(isToolErr(ok), JSON.stringify(ok)).toBe(false);
    expect((ok as ToolOk).control).toBe("set");
    expect(started).toHaveLength(3);
    // The reason travels with the brief: its designer is told why a second session that day.
    expect((started[1] as { brief: string }).brief).toContain("A second session that day, because: Ten minutes of mobility after work.");
    expect((started[0] as { brief: string }).brief).not.toContain("A second session that day");
    const dup = refusal(await tool("plan_set").run((await ctxFor(a.userId, { kind: "next_n", n: 3 })).ctx, { briefs: [brief("a", THU), brief("a", MON)] }));
    expect(dup.why).toContain('"a"');
  });

  it("the next N's last day is its plan's horizon; a day with a session already over needs its reason; outside the loop it can't start anything", async () => {
    const a = await athlete();
    const next = await ctxFor(a.userId, { kind: "next_n", n: 3 });
    const far = refusal(await tool("plan_set").run(next.ctx, { briefs: [brief("a", day(-14))] }));
    expect(far.why).toContain(`"a": ${day(-14)} is after the set's last day (${day(-13)})`);
    expect(isToolErr(await tool("plan_set").run(next.ctx, { briefs: [brief("a", day(-13))] }))).toBe(false);

    const b = await athlete();
    await db.insert(schema.plannedWorkouts).values({
      id: `skipped-${b.userId}`, userId: b.userId, planId: "coros-plan", sourceWorkoutId: `skipped-${b.userId}`, title: "Easy run", category: "easy", sport: "run",
      originalPlanDate: MON, lastVerifiedCorosDate: MON, effectiveDate: MON, effectiveTime: "07:00", sourceContentFingerprint: "fp",
      sourceEstimatedDurationSeconds: 2400, calendarBlockDurationSeconds: 3300, completionState: "skipped", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const week = await ctxFor(b.userId, { kind: "week" });
    const over = refusal(await tool("plan_set").run(week.ctx, { briefs: [brief("mon", MON)] }));
    expect(over.why).toContain(`"mon": ${MON} holds a session already done, skipped or missed`);
    expect(isToolErr(await tool("plan_set").run(week.ctx, { briefs: [brief("mon", MON, { sameDayWhy: "Mobility in place of the run." })] }))).toBe(false);

    const { set: _hooks, ...outside } = week.ctx;
    expect(refusal(await tool("plan_set").run(outside as ToolContext, { briefs: [brief("thu", THU)] })).error).toBe("unavailable");
  });

  it("a redo onto a day another workout of the set holds needs its reason too", async () => {
    const a = await athlete();
    const { ctx, started } = await ctxFor(a.userId, { kind: "week" });
    const first = { toolUseId: "first", redo: false, briefs: [brief("thu", THU), brief("sat", SAT)], designers: [{ key: "thu", runId: "d-thu" }, { key: "sat", runId: "d-sat" }] };
    const withFirst = { ...ctx, set: { ...ctx.set!, rounds: () => [first] } } as ToolContext;
    const moved = refusal(await tool("plan_set").run(withFirst, { briefs: [brief("sat", THU, { note: "Earlier in the week." })] }));
    expect(moved.why).toContain(`"sat": ${THU} already has another brief ("thu")`);
    const ok = (await tool("plan_set").run(withFirst, { briefs: [brief("sat", THU, { note: "Earlier.", sameDayWhy: "A short evening session." })] })) as ToolOk;
    expect(isToolErr(ok)).toBe(false);
    expect((ok.data as { round: { redo: boolean; replaces: Record<string, string> } }).round).toMatchObject({ redo: true, replaces: { sat: "d-sat" } });
    expect(started).toHaveLength(1);
  });

  it("a designer can't plan a set", async () => {
    const a = await athlete();
    const { ctx } = await ctxFor(a.userId, { kind: "week" });
    const mainId = ctx.run.id;
    const plan = planSet([brief("thu", THU)]);
    const { deps, requests } = scripted([t(plan), t(use("plan_set", { briefs: [brief("x", MON)] })), t(finish("Done.")), t(finish("Set."))]);
    // The main coach plans; its one designer tries to plan a set of its own.
    const steps = await drive(a.userId, mainId, deps);
    expect(steps.at(-1)!.status).toBe("finished");
    const tried = requests.find((r) => roleOf(r) === "designer" && r.messages.length > 1);
    expect(tried).toBeDefined();
    const errs = [...resultsSent(requests).values()].filter((b) => b.is_error).map((b) => JSON.parse(textOf(b)).error);
    expect(errs).toContain("not_for_role");
    expect(await designersOf(mainId)).toHaveLength(1);
    // Its designer finished without proposing: the slot is left out, saying so, with the designer's own words.
    expect(sentData(requests, plan).set[0]).toMatchObject({ outcome: "left_out", reason: "the designer finished without proposing a workout", designerSaid: { untrusted: true, text: "Done." } });
  });

  it("a set whose only workout is left out keeps its proposal's title and day, holds no workout, and is never made pending", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([
      t(planSet([brief("thu", THU)])),
      t(propose("Thursday hips", THU)),
      { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult, // its reviewer
      t(finish("Leaving it.")),
      t(finish("Nothing this week.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const p = (await proposalOf(mainId))!;
    expect(p.ops).toEqual([]);
    expect(p).toMatchObject({ status: "unreviewed", title: "Thursday hips", expiresAt: THU });
    expect(p.flags).toEqual([expect.stringMatching(/^No workout for Thursday 14 May: its review couldn't be done/)]);
  });
});

// ── Replays ─────────────────────────────────────────────────────────────

describe("a replay never starts a designer twice", () => {
  it("plan_set run again with the same call id (a step that died after its insert) starts none, and resets none", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    // Eight reads fill the step's calls; plan_set waits for the next step, alone.
    const reads = Array.from({ length: 8 }, () => use("read_day", {}));
    const plan = planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)]);
    const { deps } = scripted([t(...reads, plan)]);
    await runStep(db, env, mainId, a.userId, NOW, deps); // context
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps); // the reads; plan_set queued
    const before = await runRow(mainId);
    expect(JSON.parse(before.state!).pending.map((c: { name: string }) => c.name)).toEqual(["plan_set"]);
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 2000), deps); // plan_set: three designers
    const first = await designersOf(mainId);
    expect(first).toHaveLength(3);
    // The step died after the insert: its run write never happened. The designers ran meanwhile (here: they failed).
    await db.update(schema.coachRuns).set({ status: "failed", error: "internal" }).where(and(eq(schema.coachRuns.parentId, mainId), eq(schema.coachRuns.role, "designer")));
    await db.update(schema.coachRuns).set({ status: before.status, state: before.state, updatedAt: before.updatedAt }).where(eq(schema.coachRuns.id, mainId));
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 3000), deps); // plan_set again: the same id
    const again = await designersOf(mainId);
    expect(again.map((d) => [d.id, d.status])).toEqual(first.map((d) => [d.id, "failed"]));
    expect((await runRow(mainId)).status).toBe("waiting_set");
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 4000), deps); // the set's result
    expect((await runRow(mainId)).status).toBe("active");
    expect(JSON.parse((await runRow(mainId)).state!).set.rounds).toHaveLength(1);
  });
});

// ── read_set ────────────────────────────────────────────────────────────

describe("read_set", () => {
  it("returns the set in date order with reviews, the combined balance and hard days in a row — one statement, within the result budget", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const long = "x".repeat(240);
    const dates = [MON, TODAY, THU, day(-2), SAT, day(-4), day(-6)];
    const ops: DocWorkoutOp[] = dates.map((date, i) => {
      const doc = calmDoc({ title: `Workout ${i} ${"t".repeat(60)}` });
      const runId = `ds-${mainId}-x-${String(i + 1).padStart(2, "0")}-k${i}`;
      const effort = date === MON ? "peak" : date === TODAY || date === THU || date === day(-4) ? "develop" : "maintain";
      const unread = { scores: {}, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [], note: "The review could not be read; the validator's view stands." };
      return {
        kind: "doc_workout",
        target: { kind: "new", date },
        date,
        doc: { ...doc, intent: { ...doc.intent, summary: "s".repeat(200), effort } },
        review:
          date === SAT
            ? unread
            : { ...verdict(2, { mustFix: Array.from({ length: 8 }, () => long) }), notes: Object.fromEntries(DIMS.map((d) => [d, long])), rounds: 3, changes: [long, long] },
        issues: [],
        derived: { minutes: 30, discipline: "strength", category: "strength", mode: "consistent", balance: { isometricSec: 120, isotonicReps: 40 }, regions: { glutes: 4, core: 2 }, equipment: { all: [], oneOf: [] }, watchSteps: 4 },
        by: { runId, role: "designer" },
        toolUseId: `u${i}`,
        at: NOW.toISOString(),
      } as DocWorkoutOp;
    });
    await db.insert(schema.coachProposals).values({
      id: designProposalId(mainId), userId: a.userId, planId: null, title: "7 workouts", evidence: "", rationale: "", flags: ["Left out “Friday” (Friday 15 May): too much."],
      ops, status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: day(-6),
    });
    const rounds = [{ toolUseId: "x", redo: false, briefs: [], designers: ops.map((o, i) => ({ key: `k${i}`, runId: o.by.runId })) }];
    const ctx = { db, env, userId: a.userId, now: NOW, run: { id: mainId, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }, set: { rounds: () => rounds, start: async () => [] } } as unknown as ToolContext;
    statements = 0;
    const r = (await allTools().find((x) => x.name === "read_set")!.run(ctx, {})) as ToolOk;
    expect(statements).toBeLessThanOrEqual(1);
    expect(allTools().find((x) => x.name === "read_set")!.statementCost).toBe(1);
    expect(isToolErr(r)).toBe(false);
    const { summary: _s, receipt: _r, control: _c, ...forModel } = r;
    expect(new TextEncoder().encode(JSON.stringify(forModel)).length).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    const data = r.data as any;
    expect(data.workouts.map((w: { date: string }) => w.date)).toEqual([...dates].sort());
    expect(data.workouts[0]).toMatchObject({
      opId: ops[1]!.by.runId,
      key: "k1",
      date: TODAY,
      title: { untrusted: true, text: expect.stringContaining("Workout 1") },
      effort: "develop",
      minutes: 30,
      review: { mean: 2, rounds: 3, mustFix: expect.any(Array) },
    });
    expect(data.workouts[0].review.mustFixCount).toBe(8);
    expect(data.workouts[0].balance).toEqual({ isometricMin: 2, isotonicReps: 40 });
    // A review that couldn't be read has no mean: its note says so.
    expect(data.workouts[3].review).toMatchObject({ mean: null, note: "The review could not be read; the validator's view stands." });
    // Hard (develop or peak) today, Thursday, the following Sunday and Monday: two pairs in a row.
    expect(data.hardDaysInARow).toMatchObject({ count: 2, pairs: [[TODAY, THU], [day(-4), MON]] });
    expect(data.combined.minutes).toBe(7 * 30);
    expect(data.combined.balance).toEqual(expect.objectContaining({ isotonicReps: expect.any(Number) }));
    // What the set doesn't train is left out, never written as 0.
    expect(Object.values(data.combined.balance).every((v) => (v as number) > 0)).toBe(true);
    expect(data.notes).toEqual(["Left out “Friday” (Friday 15 May): too much."]);
  });

  it("a small set is shown whole: each workout's intent and its must-fix items in words", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const doc = calmDoc({ title: "Thursday hips" });
    const op = {
      kind: "doc_workout", target: { kind: "new", date: THU }, date: THU, doc, review: { ...verdict(3, { mustFix: ["Shorter rests."] }), rounds: 1, changes: [] }, issues: [],
      derived: { minutes: 20, regions: { glutes: 4, core: 2, hips: 1, back: 1 } }, by: { runId: "d-thu", role: "designer" }, toolUseId: "u", at: NOW.toISOString(),
    } as unknown as DocWorkoutOp;
    await db.insert(schema.coachProposals).values({
      id: designProposalId(mainId), userId: a.userId, planId: null, title: "Thursday hips", evidence: "", rationale: "", flags: [], ops: [op], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: THU,
    });
    const rounds = [{ toolUseId: "p", redo: false, briefs: [], designers: [{ key: "thu", runId: "d-thu" }] }];
    const ctx = { db, env, userId: a.userId, now: NOW, run: { id: mainId, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }, set: { rounds: () => rounds, start: async () => [] } } as unknown as ToolContext;
    const w = ((await allTools().find((x) => x.name === "read_set")!.run(ctx, {})) as ToolOk).data as any;
    expect(w.workouts[0]).toMatchObject({
      key: "thu",
      intent: { untrusted: true, text: doc.intent.summary },
      regions: { glutes: 4, core: 2, hips: 1 },
      review: { mean: 3, low: Object.fromEntries(DIMS.slice(0, 3).map((d) => [d, 3])), mustFix: [{ untrusted: true, text: "Shorter rests." }], mustFixCount: 1, rounds: 1 },
    });
    expect(w.hardDaysInARow).toMatchObject({ count: 0, pairs: [] });
  });

  it("before any set: says so", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const ctx = { db, env, userId: a.userId, now: NOW, run: { id: mainId, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }, set: { rounds: () => [], start: async () => [] } } as unknown as ToolContext;
    const r = (await allTools().find((x) => x.name === "read_set")!.run(ctx, {})) as ToolOk;
    expect(isToolErr(r)).toBe(false);
    expect(r.missing).toEqual(["no set planned yet: call plan_set first"]);
    expect((r.data as any).workouts).toEqual([]);
  });
});

// ── Live statuses ───────────────────────────────────────────────────────

describe("waiting_set is live everywhere a live status counts", () => {
  async function waitingSet() {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([t(planSet([brief("thu", THU), brief("mon", MON)]))]);
    await runStep(db, env, mainId, a.userId, NOW, deps);
    await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + 1000), deps);
    expect((await runRow(mainId)).status).toBe("waiting_set");
    return { userId: a.userId, mainId };
  }

  it("a second run is not started while one waits for its set", async () => {
    const { userId, mainId } = await waitingSet();
    const again = await createRun(db, userId, { scope: { kind: "now" }, request: "Something now." }, new Date(NOW.getTime() + 2000));
    expect(again.existing).toBe(true);
    expect(again.run.id).toBe(mainId);
  });

  it("a cancel ends the main run and its designers", async () => {
    const { userId, mainId } = await waitingSet();
    await cancelRun(db, userId, mainId, new Date(NOW.getTime() + 2000));
    expect((await runRow(mainId)).status).toBe("cancelled");
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("past its window the tree expires", async () => {
    const { userId, mainId } = await waitingSet();
    const out = await runStep(db, env, mainId, userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps);
    expect(out.kind === "ok" && out.result.status).toBe("expired");
    expect((await runRow(mainId)).status).toBe("expired");
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["expired", "expired"]);
  });
});

// ── Budgets ─────────────────────────────────────────────────────────────

describe("every new step shape stays inside the Workers Free budget (counted)", () => {
  async function counted(userId: string, runId: string, deps: RunDeps, now: Date, calls: { n: number }) {
    statements = 0;
    const before = calls.n;
    const out = await runStep(db, env, runId, userId, now, deps);
    if (out.kind !== "ok") throw new Error(out.kind);
    return { cost: ROUTE_OVERHEAD + statements + (calls.n - before), status: out.result.status };
  }

  it("seven designers started in one step; a designer's context; the set's result; read_set; drop_workout; a redo; finish", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const why = "A short care session only.";
    const seven = [0, 1, 2, 3, 4, 5, 6].map((i) => brief(`d${i}`, addDays(TODAY, i), [0, 2, 4, 6].includes(i) ? { sameDayWhy: why } : {}));
    const scriptTurns: Scripted[] = [t(planSet(seven))];
    for (let i = 0; i < 7; i++) scriptTurns.push(...designed(`Day ${i}`, addDays(TODAY, i)));
    // Read outside the counted steps: the seventh designer's id is its workout's op id.
    let seventh = "";
    scriptTurns.push(
      t(use("read_set", {})),
      () => t(use("drop_workout", { opId: seventh, reason: "Too much at the week's end." })),
      t(planSet([brief("d1", addDays(TODAY, 1), { note: "Shorter." })])),
      ...designed("Day 1, shorter", addDays(TODAY, 1)),
      t(finish("Six sessions.")),
    );
    const calls = { n: 0 };
    const base = scripted(scriptTurns);
    const deps: RunDeps = { ...base.deps, callModel: async (e, r) => ((calls.n += 1), base.deps.callModel(e, r)) };
    let i = 0;
    const next = () => new Date(NOW.getTime() + ++i * 1000);
    const shapes: Record<string, number> = {};
    const step = async (name: string) => {
      const c = await counted(a.userId, mainId, deps, next(), calls);
      shapes[name] = Math.max(shapes[name] ?? 0, c.cost);
      expect(c.cost, name).toBeLessThanOrEqual(STEP_BUDGET);
      return c;
    };
    await step("main context");
    await step("plan_set: seven designers started");
    expect(await designersOf(mainId)).toHaveLength(7);
    seventh = (await designersOf(mainId))[6]!.id;
    for (let d = 0; d < 7; d++) {
      await step("designer context");
      await step("designer: draft + its reviewer started");
      await step("reviewer context");
      await step("reviewer: review stored");
      await step("designer resumed with its review");
      await step("designer: finish");
    }
    await step("the set's result: main resumed");
    await step("read_set");
    await step("drop_workout");
    await step("plan_set again: one redo designer");
    await step("designer context");
    await step("designer: draft + its reviewer started");
    await step("reviewer context");
    await step("reviewer: review stored");
    await step("designer resumed with its review");
    await step("designer: finish");
    await step("the redo's result: main resumed");
    expect((await step("finish")).status).toBe("finished");
    const MODEL = 10 + 1;
    expect(shapes).toMatchObject({
      "main context": 2 + 4 + 11,
      // The athlete with the plan on the briefs' dates and the proposal; the estimate's read; the designers' one insert.
      "plan_set: seven designers started": 2 + MODEL + 3,
      "designer context": 2 + 4 + 11,
      // The tree, the claim, the proposal read, the run's write, the events: every workout proposed, nothing to write.
      "the set's result: main resumed": 2 + 4 + 1,
      "read_set": 2 + MODEL + 1,
      "drop_workout": 2 + MODEL + 2,
      // A redo reads no estimate.
      "plan_set again: one redo designer": 2 + MODEL + 2,
      // …and the ops written: the first version taken out, the redo's in its place.
      "the redo's result: main resumed": 2 + 4 + 2,
      finish: 2 + MODEL + 1 + 1,
    });
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops).toHaveLength(6);
  });

  it("the set stopped at its ceiling, proposing what was reviewed, stays small", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    await runStep(db, env, mainId, a.userId, NOW, scripted([]).deps);
    const s = await stateOf(mainId);
    s.settings.ceilingMicros = 50_000;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(s) }).where(eq(schema.coachRuns.id, mainId));
    const c = { cost: 10_000 };
    const calls = { n: 0 };
    const base = scripted([turn([planSet([brief("thu", THU), brief("sat", SAT), brief("mon", MON)])], c), ...designed("Thursday hips", THU, c), turn([propose("Saturday trunk", SAT)], c)]);
    const deps: RunDeps = { ...base.deps, callModel: async (e, r) => ((calls.n += 1), base.deps.callModel(e, r)) };
    for (let i = 1; i <= 10; i++) await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    // Saturday's reviewer context ran; its call is the one past the limit.
    const stopped = await counted(a.userId, mainId, deps, new Date(NOW.getTime() + 11_000), calls);
    expect(stopped.status).toBe("stopped_cap");
    // The tree, the claim, the run's write, the rest of the tree stopped, the proposal read, the proposal made pending,
    // the events.
    expect(stopped.cost).toBe(2 + 7);
  });

  it("every new tool fits a model step's room, and the registry holds the prompt's names with none left pending", () => {
    const tool = (name: string) => ACT_TOOLS.find((x) => x.name === name)!;
    expect(tool("plan_set").statementCost).toBe(3);
    expect(tool("drop_workout").statementCost).toBe(2);
    expect(tool("read_set").statementCost).toBe(1);
    expect([...PENDING_TOOL_NAMES]).toEqual([]);
    expect(allTools().map((x) => x.name).sort()).toEqual([...PROMPT_TOOL_NAMES].sort());
  });
});

// ── The prompt ──────────────────────────────────────────────────────────

describe("the prompt says how a set works", () => {
  it("names drop_workout and read_set, tells the main coach how to judge and act on the set, and stays within its size", () => {
    expect(PROMPT_TOOL_NAMES).toContain("drop_workout");
    expect(PROMPT_TOOL_NAMES).toContain("read_set");
    for (const name of ["plan_set", "read_set", "drop_workout"]) {
      expect(SHARED_PROMPT, name).toContain(`- ${name}:`);
      expect(roleBlock("main"), name).toContain(name);
    }
    expect(roleBlock("main")).toMatch(/once more/);
    expect(SHARED_PROMPT.length / 4).toBeLessThanOrEqual(6000);
    expect(roleBlock("main").length / 4).toBeLessThanOrEqual(1500);
  });
});
