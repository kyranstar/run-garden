/**
 * A TURN THAT CALLS NO TOOL (Stage 3 fix wave 3A, A3 — the agent-design audit's C1) AND THE CUT-OFF ADVICE (A4).
 *
 * A main run or a designer whose turn calls no tool gets ONE repair nudge — as the reviewer does — saying the turn
 * called no tool, that a turn without one ends the run with nothing reaching the athlete, and to call ask_athlete for a
 * question or finish when the work is done. A second text-only turn in a row (or one on the run's last call, which no
 * nudge could follow) ends the run through the finish's own promotion — the main run's proposal made pending when every
 * workout carries its review and none is under way, the older plans' days superseded; otherwise what was reviewed is
 * proposed, as a stop does (A2) — and a designer finishes as its finish tool does. A tool call after a nudge goes on as
 * usual. The last-turn note says to call finish; an answer cut off never suggests a smaller document.
 *
 * The real registry, the real opening context and the real loop, one scripted model for the tree. No key, no network.
 * Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, CUT_OFF_NOTE, LAST_TURN_NOTE, NO_TOOL_NUDGE, ROUTE_OVERHEAD, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { STOPPED_NOTES } from "../src/services/design-review.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessageParam, MessagesOk, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
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

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_nt${++seq}`, name, input });

function turn(uses: ContentBlock[], o: { text?: string; stopReason?: MessagesOk["stopReason"] } = {}): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: o.text ?? "Working on it." }, ...uses],
    stopReason: o.stopReason ?? (uses.length > 0 ? "tool_use" : "end_turn"),
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);
const prose = (text: string) => turn([], { text });

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

async function drive(userId: string, runId: string, deps: RunDeps, o: { from?: number; max?: number } = {}) {
  const all: Array<{ status: string }> = [];
  const from = o.from ?? 0;
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + (from + i) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: o.max ?? 60, what: "drive" },
  );
  return all;
}

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[], flags: p.flags as string[] } : undefined;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}
async function lines(runId: string) {
  return (await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq)).map((e) => ({
    kind: e.kind,
    summary: e.summary,
    payload: e.payload,
  }));
}
const newest = (req: MessagesRequest): string => {
  const m: MessageParam = req.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("\n");
};

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
  mustFix: [],
  improvements: [],
});
const propose = (title: string, date = TODAY) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date } });
const submit = (v: unknown) => use("submit_review", v);
const finish = (summary: string) => use("finish", { summary });
const nowRun = async (userId: string) => (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;

describe("the main run: a turn with no tool", () => {
  it("a prose reply after a clean review is nudged once; a second prose reply finishes it, and the reviewed draft is pending", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([
      t(propose("Calm hips")),
      t(submit(verdict(4))),
      prose("Here is your session: a calm half hour for the hips."),
      prose("A calm half hour for the hips, ready when you are."),
    ]);
    const steps = await drive(a.userId, runId, deps);
    expect(steps.at(-1)!.status).toBe("finished");
    // The nudge went to the model as the newest message of the call after the first prose reply.
    expect(newest(requests.at(-1)!)).toContain(NO_TOOL_NUDGE);
    // What the loop does, said as it is (round 2, A-M5 and B-M1) — the shared prompt's own line.
    expect(NO_TOOL_NUDGE).toBe(
      "A turn without a tool call does nothing for the athlete. If your next turn calls no tool either, your run ends there, and only what was already reviewed is proposed. To ask, call ask_athlete. To end, call finish (a reviewer ends with submit_review).",
    );
    expect(SHARED_PROMPT).toContain(NO_TOOL_NUDGE);
    // Pending through the finish's own promotion, the run's proposal set, no stop note.
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.flags).toEqual([]);
    expect(await runRow(runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    // The trail: the first reply as the coach said it, then the second as the run's last line, with the proposal.
    const trail = await lines(runId);
    expect(trail.at(-2)!.summary).toBe("Here is your session: a calm half hour for the hips.");
    expect(trail.at(-1)).toMatchObject({ kind: "note", summary: "A calm half hour for the hips, ready when you are.", payload: { proposalId: designProposalId(runId) } });
  });

  it("the finish in words is counted: the model step, the proposal made pending and the older plans superseded", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), prose("Here it is."), prose("Done: a calm half hour.")]);
    await untilDone(
      async (i) => {
        await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
        return requests.length === 3 && (await runRow(runId)).status === "active";
      },
      { max: 20, what: "to the nudge" },
    );
    statements = 0;
    const calls = requests.length;
    const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 60_000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    // The route; the model step's own nine and the call; the proposal made pending; the older plans superseded.
    expect(ROUTE_OVERHEAD + statements + (requests.length - calls)).toBe(2 + 9 + 1 + 1 + 1);
  });

  it("a nudge, then a tool call: the run goes on as usual — and the next prose reply is nudged again, not finished", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([
      t(propose("Calm hips")),
      t(submit(verdict(4))),
      prose("Let me think about the order."),
      t(use("read_day", {})),
      prose("Here it is."),
      t(finish("A calm half hour for the hips.")),
    ]);
    const steps = await drive(a.userId, runId, deps);
    expect(steps.at(-1)!.status).toBe("finished");
    const nudged = requests.filter((r) => newest(r).includes(NO_TOOL_NUDGE));
    expect(nudged).toHaveLength(2);
    expect((await proposalOf(runId))!.status).toBe("pending");
    expect((await lines(runId)).at(-1)!.summary).toBe("A calm half hour for the hips.");
  });

  it("prose on the last call ends the run as a finish: no nudge could be followed", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), prose("A calm half hour for the hips.")]);
    await runStep(db, env, runId, a.userId, NOW, deps); // context
    const state = JSON.parse((await runRow(runId)).state!) as { settings: Record<string, unknown> };
    state.settings.maxCalls = 2;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, runId));
    expect((await drive(a.userId, runId, deps, { from: 1 })).at(-1)!.status).toBe("finished");
    expect(newest(requests.at(-1)!)).toContain(LAST_TURN_NOTE);
    expect((await proposalOf(runId))!.status).toBe("pending");
  });

  it("a review still under way when it ends in words: what was reviewed is proposed, with a note saying so", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), prose("Here it is."), prose("Done.")]);
    for (let i = 0; i < 5; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps); // to the resume
    const p0 = (await proposalOf(runId))!;
    const op = p0.ops[0]!;
    const dangling = { ...op, reviewLog: [...op.reviewLog!, { round: 2, toolUseId: "toolu_lost", reviewRunId: "rv-lost", status: "reviewing" as const }] };
    await db.update(schema.coachProposals).set({ ops: [dangling] }).where(eq(schema.coachProposals.id, designProposalId(runId)));
    expect((await drive(a.userId, runId, deps, { from: 5 })).at(-1)!.status).toBe("finished");
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.flags).toEqual([STOPPED_NOTES.unfinished]);
    expect(p.ops[0]!.reviewLog!.map((r) => r.status)).toEqual(["reviewed", "dropped"]);
    // It ended — it didn't stop: the line says what was proposed, never "before the stop" (round 2, A-M7).
    const last = (await lines(runId)).at(-1)!.summary;
    expect(last).toBe("Suggested what had been reviewed.");
    expect(last).not.toMatch(/stop/);
  });

  it("the last-turn note says to call finish, with one plain line — never to say what is missing instead", () => {
    expect(LAST_TURN_NOTE).toBe("This is your last turn in this run. Call finish now, with one plain line for the athlete.");
    expect(LAST_TURN_NOTE).not.toMatch(/missing/);
  });
});

describe("a set's designer: a turn with no tool", () => {
  it("two prose turns finish it as its finish tool would: its words are its last line, and its reviewed workout is in the set", async () => {
    const a = await athlete();
    const mainId = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week." }, NOW)).run.id;
    const thu = day(-1);
    const plan = use("plan_set", {
      briefs: [{ key: "thu", date: thu, purpose: "Hips, steady.", emphasis: "Control.", constraints: "30 minutes, at home.", why: "Away from the runs." }],
    });
    const { deps, requests } = scripted([
      t(plan),
      t(propose("Thursday hips", thu)),
      t(submit(verdict(4))),
      prose("Thursday is set."),
      prose("Thursday: hips, steady, as briefed."),
      t(finish("One session on Thursday.")),
    ]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const [designer] = await db
      .select()
      .from(schema.coachRuns)
      .where(and(eq(schema.coachRuns.parentId, mainId), eq(schema.coachRuns.role, "designer")));
    expect(designer).toMatchObject({ status: "finished", error: null });
    expect(JSON.parse(designer!.state!).final).toBe("Thursday: hips, steady, as briefed.");
    // The set's result: the workout proposed.
    const results = new Map<string, ToolResultBlock>();
    for (const r of requests) for (const m of r.messages) if (m.role === "user" && typeof m.content !== "string") for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b as ToolResultBlock);
    const set = JSON.parse(results.get((plan as { id: string }).id)!.content as string).data.set;
    expect(set[0]).toMatchObject({ key: "thu", outcome: "proposed" });
    expect((await proposalOf(mainId))!.status).toBe("pending");
  });
});

describe("an answer cut off at the output limit (A4)", () => {
  it("the cut call's result and the cut prose's note both say the thinking used the room — never to make the document smaller", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const cutCall = use("validate_workout", { doc: calmDoc(), date: TODAY });
    const { deps, requests } = scripted([turn([cutCall], { stopReason: "max_tokens" }), turn([], { stopReason: "max_tokens", text: "Here is" }), t(finish("Stopped."))]);
    await drive(a.userId, runId, deps);
    expect(CUT_OFF_NOTE).toBe("Your answer was cut off before it finished. Your thinking used most of the room: think less before you write, and keep the document whole.");
    const sent = JSON.stringify(requests.map((r) => r.messages));
    expect(sent).not.toMatch(/smaller input/);
    expect(sent).not.toMatch(/more briefly/);
    const result = requests[1]!.messages.at(-1)!;
    const block = (result.content as ToolResultBlock[]).find((b) => b.type === "tool_result" && b.tool_use_id === (cutCall as { id: string }).id)!;
    const err = JSON.parse(block.content as string) as { error: string; why: string; fix: string };
    expect(err.error).toBe("cut_off");
    expect(`${err.why} ${err.fix}`).toBe(CUT_OFF_NOTE);
    expect(newest(requests[2]!)).toContain(CUT_OFF_NOTE);
  });
});
