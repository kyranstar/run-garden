/**
 * PLAN ADJUSTMENTS THROUGH THE LOOP (Stage 3 Task 8b; ruling I6, Option A).
 *
 * The journeys the agent-design audit found broken, end to end: a flare day (today's programme session skipped, a relief
 * workout in its place — one proposal, one approval), "make the next programme session shorter" (a programme session is
 * never re-timed: it is skipped and a shorter workout proposed beside it), and a week whose main coach moves a session
 * before planning the set. A change is never reviewed: the finish makes the proposal pending once every WORKOUT carries
 * its review; a stop proposes changes only beside a reviewed workout.
 *
 * The real registry, the real opening context and the real loop, driven by one scripted model shared by every run of the
 * tree. No key, no network. Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { approveDesignOps, type DesignedOp } from "../src/services/design-approve.js";
import { designerRunId } from "../src/services/design-orchestrate.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { promoteWithWhatItHas, STOPPED_NOTES } from "../src/services/design-review.js";
import { allTools } from "../src/services/design-tools/index.js";
import { finish as finishTool } from "../src/services/design-tools/finish.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { planAdjustId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;

beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

// The thread coach's applier reads the clock itself (its today, its now): the fixture's day. Only Date is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// ── One scripted model for the whole tree ───────────────────────────────

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_pal${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

function scripted(turns: MessagesResult[]) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

async function drive(userId: string, runId: string, deps: RunDeps) {
  let last = "active";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return last !== "active";
    },
    { max: 80, what: "drive" },
  );
  return last;
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [],
  improvements: [],
});
const submit = () => use("submit_review", verdict(4));
const finish = (summary: string) => use("finish", { summary });
const propose = (title: string, date: string) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date } });
const adjust = (input: unknown) => use("adjust_plan", input);

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as Array<DesignedOp | PlanAdjustOp>, flags: p.flags as string[] } : undefined;
}
const rowOf = async (id: string) => (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, id)))[0]!;
async function nextProgramme(userId: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.plannedWorkouts.id })
    .from(schema.plannedWorkouts)
    .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.effectiveDate, day(-2)), eq(schema.plannedWorkouts.origin, "program")));
  return row!.id;
}
/** Every tool result the model was sent, by the tool's name, from the requests it was handed. */
function resultsOf(requests: MessagesRequest[], name: string): unknown[] {
  const ids = new Map<string, string>();
  const out = new Map<string, unknown>();
  for (const r of requests) {
    for (const m of r.messages) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_use") ids.set(b.id, b.name);
        if (b.type === "tool_result" && ids.get(b.tool_use_id) === name) {
          const text = typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join("");
          out.set(b.tool_use_id, JSON.parse(text));
        }
      }
    }
  }
  return [...out.values()];
}

async function approveAll(userId: string, mainRunId: string) {
  const prefs = await loadPreferences(db, userId);
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return approveDesignOps(db, userId, p! as never, {}, { today: TODAY, now: NOW.toISOString(), prefs }, Number.POSITIVE_INFINITY);
}

// ── The journeys ────────────────────────────────────────────────────────

describe("a flare day: today's programme session skipped and a relief workout proposed — one proposal, one approval", () => {
  it("the change goes unreviewed beside the reviewed workout, the finish makes both the athlete's, and approval applies both", async () => {
    const a = await seedRichAthlete(db);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "My jaw is flaring today." }, NOW)).run.id;
    const { deps } = scripted([
      t(
        adjust({ workoutId: a.outlineToday, change: { kind: "skip", reason: "A flare day." }, why: "Today's reading is high: a short relief session replaces it." }),
        propose("Five-minute relief", TODAY),
      ),
      t(submit()),
      t(finish("Today's strength comes off; a short relief session in its place.")),
    ]);
    expect(await drive(a.userId, runId, deps)).toBe("finished");
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.kind)).toEqual(["plan_adjust", "doc_workout"]);
    const change = p.ops[0] as PlanAdjustOp;
    expect(change).not.toHaveProperty("review");
    // The finish's receipt says what the proposal holds: one workout, one change.
    const notes = await db
      .select()
      .from(schema.coachRunEvents)
      .where(and(eq(schema.coachRunEvents.runId, runId), eq(schema.coachRunEvents.kind, "note")))
      .orderBy(schema.coachRunEvents.seq);
    expect((notes.at(-1)!.payload as { receipt?: unknown }).receipt).toEqual({
      final: true,
      proposal: { id: designProposalId(runId), status: "pending", workouts: 1, changes: 1 },
    });

    const res = await approveAll(a.userId, runId);
    expect(res.status).toBe("approved");
    expect(await rowOf(a.outlineToday)).toMatchObject({ completionState: "skipped", sanctionedBy: "coach" });
    expect(res.applied.map((x) => x.workout.title)).toEqual(["Five-minute relief"]);
  });
});

describe("make the next programme session shorter: skipped, and a shorter workout in its place", () => {
  it("the re-time is refused with the way to do it; the skip and the shorter workout go to the athlete together", async () => {
    const a = await seedRichAthlete(db);
    const prog = await nextProgramme(a.userId);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Make Friday's strength shorter." }, NOW)).run.id;
    const { deps, requests } = scripted([
      t(adjust({ workoutId: prog, change: { kind: "adjust", durationMinutes: 20 }, why: "Asked for shorter." })),
      t(adjust({ workoutId: prog, change: { kind: "skip", reason: "Replaced by a shorter session." }, why: "Asked for shorter." }), propose("Short strength", day(-2))),
      t(submit()),
      t(finish("Friday's strength is swapped for a shorter one.")),
    ]);
    expect(await drive(a.userId, runId, deps)).toBe("finished");
    const [refusal] = resultsOf(requests, "adjust_plan") as Array<{ error?: string; fix?: string }>;
    expect(refusal).toMatchObject({
      error: "programme_session",
      fix: "Skip it with adjust_plan and propose the shorter workout with propose_workout; both go to the athlete together.",
    });
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => (o.kind === "plan_adjust" ? `${o.op.kind} ${o.op.workoutId}` : o.doc.title))).toEqual([`skip ${prog}`, "Short strength"]);
    const res = await approveAll(a.userId, runId);
    expect(res.status).toBe("approved");
    expect((await rowOf(prog)).completionState).toBe("skipped");
    expect(res.applied[0]!.workout).toMatchObject({ title: "Short strength", date: day(-2) });
  });
});

describe("a proposal of changes alone", () => {
  it("is made pending at the finish: nothing in it needs a review", async () => {
    const a = await seedRichAthlete(db);
    const prog = await nextProgramme(a.userId);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Move Friday's strength to Saturday morning." }, NOW)).run.id;
    const { deps } = scripted([
      t(adjust({ workoutId: prog, change: { kind: "move", toDate: day(-3), toTime: "08:00" }, why: "Asked for Saturday." })),
      t(finish("Friday's strength moves to Saturday morning.")),
    ]);
    expect(await drive(a.userId, runId, deps)).toBe("finished");
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.title).toBe("Strength — moved to Sat 16 May");
  });

  it("the finish tool says so in its receipt: pending, no workouts, one change — and a workout unreviewed still keeps it back", async () => {
    const a = await seedRichAthlete(db);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Skip today." }, NOW)).run.id;
    const run = { id: runId, role: "main" as const, scope: { kind: "now" as const }, parentId: null, rehearsal: false };
    const ctx = { db, env, userId: a.userId, run, now: NOW, toolUseId: "toolu_finish_pa" };
    const adjustTool = allTools().find((x) => x.name === "adjust_plan")!;
    await adjustTool.run({ ...ctx, toolUseId: "toolu_adj_pa" }, { workoutId: a.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "Rest today." });
    const done = await finishTool.run(ctx, { summary: "Today comes off." });
    expect(done).toMatchObject({ receipt: { final: true, proposal: { status: "pending", workouts: 0, changes: 1 } } });
    expect((done as { data: Record<string, unknown> }).data).not.toHaveProperty("unreviewed");
    // A workout without its review keeps the proposal back, the change beside it or not.
    const proposeTool = allTools().find((x) => x.name === "propose_workout")!;
    await proposeTool.run({ ...ctx, toolUseId: "toolu_prop_pa" }, { doc: calmDoc({ title: "Relief" }), target: { kind: "new", date: TODAY } });
    const kept = await finishTool.run(ctx, { summary: "Today comes off." });
    expect(kept).toMatchObject({ data: { unreviewed: true }, receipt: { proposal: { status: "unreviewed", workouts: 1, changes: 1 } } });
  });
});

describe("a stop proposes changes only beside a reviewed workout", () => {
  it("a reviewed draft and a change, then the state cap: both are proposed", async () => {
    const a = await seedRichAthlete(db);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Something calm." }, NOW)).run.id;
    const { deps } = scripted([
      t(adjust({ workoutId: a.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "Calm instead." }), propose("Calm hips", TODAY)),
      t(submit()),
      turn([], "x".repeat(70_000)),
    ]);
    expect(await drive(a.userId, runId, deps)).toBe("stopped_cap");
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.kind)).toEqual(["plan_adjust", "doc_workout"]);
  });

  it("a change alone, then a stop: nothing is proposed — a design interrupted never shows a lone change", async () => {
    const a = await seedRichAthlete(db);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Something calm." }, NOW)).run.id;
    const { deps } = scripted([
      t(adjust({ workoutId: a.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "Calm instead." })),
      { ok: false, kind: "no_key", reason: "no_key" },
    ]);
    await drive(a.userId, runId, deps);
    expect((await proposalOf(runId))!.status).toBe("unreviewed");
  });

  it("an expiry leaves out a change whose session's day has passed, and says so", async () => {
    const a = await seedRichAthlete(db);
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Something calm." }, NOW)).run.id;
    const { deps } = scripted([
      t(adjust({ workoutId: a.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "Calm instead." }), propose("Calm hips", day(-1))),
      t(submit()),
    ]);
    await untilDone(
      async (i) => {
        const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
        if (out.kind !== "ok") throw new Error(out.kind);
        const p = await proposalOf(runId);
        return !!p && p.ops.some((o) => o.kind === "doc_workout" && o.review);
      },
      { max: 20, what: "to the review" },
    );
    expect(await promoteWithWhatItHas(db, a.userId, designProposalId(runId), STOPPED_NOTES.expired!, { today: day(-1) })).toBe(true);
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.kind)).toEqual(["doc_workout"]);
    expect(p.flags).toEqual([STOPPED_NOTES.expired, "Its day passed before it could be suggested, so left out: “Strength — skipped” (Wed 13 May)."]);
  });
});

describe("a week: the main coach moves a session, then plans the set", () => {
  it("the change rides in the set's proposal, never counted as one of its workouts; read_set shows it apart", async () => {
    const a = await seedRichAthlete(db);
    const prog = await nextProgramme(a.userId);
    const runId = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week; Friday is busy." }, NOW)).run.id;
    const brief = (key: string, date: string) => ({
      key, date, purpose: `Workout ${key}: hips and trunk.`, emphasis: "Control.", constraints: "About 30 minutes, at home.", why: "Spaced from the runs.", sameDayWhy: "Short, beside what the day holds.",
    });
    const designed = (title: string, date: string) => [t(propose(title, date)), t(submit()), t(finish(`${title}, as briefed.`))];
    const { deps, requests } = scripted([
      t(adjust({ workoutId: prog, change: { kind: "move", toDate: day(-4) }, why: "Friday is busy." }), use("plan_set", { briefs: [brief("a", day(-1)), brief("b", day(-3))] })),
      ...designed("Thursday hips", day(-1)),
      ...designed("Saturday trunk", day(-3)),
      t(use("read_set", {})),
      t(finish("Two sessions around the runs; Friday's strength moves to Sunday.")),
    ]);
    expect(await drive(a.userId, runId, deps)).toBe("finished");
    const [set] = resultsOf(requests, "plan_set") as Array<{ data: { workoutsInProposal: number; proposed: number } }>;
    expect(set!.data).toMatchObject({ workoutsInProposal: 2, proposed: 2 });
    const [read] = resultsOf(requests, "read_set") as Array<{ data: { workouts: unknown[]; planChanges: unknown[] } }>;
    expect(read!.data.workouts).toHaveLength(2);
    expect(read!.data.planChanges).toEqual([
      {
        opId: planAdjustId(prog),
        change: "move",
        workoutId: prog,
        date: day(-2),
        title: { untrusted: true, text: "Strength" },
        to: day(-4),
        why: { untrusted: true, text: "Friday is busy." },
      },
    ]);
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.kind)).toEqual(["plan_adjust", "doc_workout", "doc_workout"]);
    expect(p.title).toBe("2 workouts · 1 plan change");
  });

  it("a workout taken out of the set keeps the change, and so does a stop of the set", async () => {
    const a = await seedRichAthlete(db);
    const prog = await nextProgramme(a.userId);
    const brief = (key: string, date: string) => ({
      key, date, purpose: `Workout ${key}: hips and trunk.`, emphasis: "Control.", constraints: "About 30 minutes, at home.", why: "Spaced from the runs.", sameDayWhy: "Short, beside what the day holds.",
    });
    const designed = (title: string, date: string) => [t(propose(title, date)), t(submit()), t(finish(`${title}, as briefed.`))];
    const move = adjust({ workoutId: prog, change: { kind: "move", toDate: day(-4) }, why: "Friday is busy." });

    // drop_workout writes the set's ops: the change stays.
    const dropRun = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week." }, NOW)).run.id;
    const plan = use("plan_set", { briefs: [brief("a", day(-1)), brief("b", day(-3))] });
    const dropped = scripted([
      t(move, plan),
      ...designed("Thursday hips", day(-1)),
      ...designed("Saturday trunk", day(-3)),
      t(use("drop_workout", { opId: designerRunId(dropRun, plan.type === "tool_use" ? plan.id : "", 0, "a"), reason: "Two strength days in a row." })),
      t(finish("One session around the runs; Friday's strength moves to Sunday.")),
    ]);
    expect(await drive(a.userId, dropRun, dropped.deps)).toBe("finished");
    const [drop] = resultsOf(dropped.requests, "drop_workout");
    expect(drop).toMatchObject({ data: { dropped: true } });
    expect((await proposalOf(dropRun))!.ops.map((o) => (o.kind === "plan_adjust" ? o.kind : o.doc.title))).toEqual(["plan_adjust", "Saturday trunk"]);

    // A set that stops after its designers: what was reviewed is proposed, the change beside it.
    const stopRun = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week." }, NOW)).run.id;
    const stopped = scripted([
      t(move, use("plan_set", { briefs: [brief("a", day(-1)), brief("b", day(-3))] })),
      ...designed("Thursday hips", day(-1)),
      ...designed("Saturday trunk", day(-3)),
      { ok: false, kind: "no_key", reason: "no_key" },
    ]);
    await drive(a.userId, stopRun, stopped.deps);
    const p = (await proposalOf(stopRun))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => (o.kind === "plan_adjust" ? o.kind : o.doc.title))).toEqual(["plan_adjust", "Thursday hips", "Saturday trunk"]);
  });
});
